# bevox-hetzner-mcp — Docker private registry auth + skip-pull-if-present

- **Data:** 2026-06-01
- **Status:** Aceita (2026-06-01) — §9 confirmado pelo operador: #1 A+B; #2 cred JSON `{username,password}` num único ref per-host; #3 Docker Hub = `docker.io`; #4 skip-if-exists ALWAYS; #5 header sensível via `curl --config -` stdin + guard body+header; #6 pull-error segue `transient`. Operador confirmou que o ref `ghcr-pat` no store será armazenado como o JSON `{"username","password"}` antes do apply.
- **Autor:** Bernard (bug report do deploy real) + Claude Code
- **Tipo:** Bug-fix (Bug 11 — registries privados sem auth) + additive (skip-if-exists no pull). Aditivo; **NÃO altera contrato de wire v1/v2, error codes, nem invariantes FROZEN** (`2026-05-17` design, `2026-05-20` v2 contract).
- **Motivação concreta:** O deploy real do `service:bevox-backend` (image `ghcr.io/example-org/bevox-backend@sha256:…`, registry **privado**) falha o pull com `error from registry: unauthorized` (HTTP 500 do Engine). `redis:7-alpine` e `postgres:16-alpine` (públicos) pullam normalmente. Causa-raiz: `core/src/providers/docker.ts:392` `ensureImage` emite `POST /images/create?fromImage=…&tag=…` **sem header `X-Registry-Auth`**. O Docker Engine API **ignora** o `~/.docker/config.json` do host — `docker login`/`docker pull` manual no host não ajuda; a credencial precisa viajar no header da chamada do Engine.
- **Invariantes preservadas:** secrets resolvidos só em apply atrás do `ApplyContext` (#4 — a credencial do registry, o password resolvido E o valor base64 do header NUNCA aparecem em plan/dry_run/log/StateEvent/observed/erro/argv); fail-safe nunca fail-deleting (#3 — pull/auth falho aborta a action SEM remover nada; fail-closed em cred malformada); idempotência (#2 — skip-if-exists + pull não setam `changed`); StateEvent actor inalterado (#5); specs-first (#1 — esta spec, sem mudança de write-site de StateEvent).

## 0. Escopo

Bug 11 tem **duas peças combinadas** (operador escolheu **A + B**):

| Peça | O quê | Por quê |
|---|---|---|
| **A** | `X-Registry-Auth` header no `POST /images/create` (o fix real) | sem ele o Engine não autentica em registry privado; `~/.docker/config.json` do host é ignorado |
| **B** | skip-if-exists: `GET /images/<ref>/json` 200 ⇒ não pula | re-apply não re-pulla (idempotência); desbloqueia operador que pré-pulla; image pinada por `@sha256:` é imutável ⇒ skip é correto |

**Out-of-scope (YAGNI):**

- Reusar o `~/.docker/config.json` do host / docker credential helpers (o Engine os ignora pra chamadas via API; a credencial é nossa, resolvida via `secretResolver`).
- OAuth token-refresh / registry token-exchange dance — o auth-config estático base64 é exatamente o que `/images/create` aceita.
- Nuances de auth de manifest-list multi-arch.
- Credenciais **per-image** (escolha: per-**host**; um registry-host → uma cred).

## Tema transversal — fakes infiéis (continuação do `2026-06-01-docker-provider-bootstrap-and-verify`)

O `core/test/fakes/docker-http.ts` precisa modelar duas realidades novas do Engine, ou o teste mascara o real (mesma disciplina `.claude/skills/fakes-author` daquela spec):

1. `GET /images/<ref>/json` retorna **200** se a imagem está presente localmente, **404** se ausente (hoje o fake não modela esse endpoint).
2. `POST /images/create` **captura** o header `X-Registry-Auth` quando enviado (pra o teste assertar o base64url esperado).

## 1. Peça A — `X-Registry-Auth` header (o fix real)

### 1.1 Config — `REGISTRY_AUTH_REFS`

`core/src/config.ts:ConfigSchema` ganha **1 key OPCIONAL**:

```ts
// OPTIONAL — JSON map { "<registry-host>": "<secret-ref>" }. Absent/empty ⇒
// NO auth wired ⇒ current behaviour preserved (public pulls keep working).
REGISTRY_AUTH_REFS: z.string().optional(),
```

- O **parse + validate** do JSON acontece **no boot** (em `entrypoint-wiring.ts`, §1.5), não dentro do `config.ts` (mantém `config.ts` puro string-parse, coerente com o resto do schema). JSON malformado ⇒ **fatal boot error** (daemon não sobe — `ReconcileError("fatal", "REGISTRY_AUTH_REFS is not valid JSON")`, value-free; nunca ecoa o conteúdo, que poderia conter um ref).
- Ausente / `""` / `{}` ⇒ mapa vazio ⇒ nenhum auth wired ⇒ comportamento atual byte-idêntico (pulls públicos seguem funcionando).
- O **valor** do mapa é um `secret:<ref>` bare-name (ex.: `ghcr-pat`), NÃO a credencial. A credencial resolve só em apply (§1.3).

`core/.env.example` ganha:

```bash
# OPTIONAL — autentica pulls de registries privados. JSON map host→secret-ref.
# O ref resolve (via SECRETS_FILE/sops) pra um JSON {"username":"…","password":"…"}.
# Ausente ⇒ só registries públicos. Exemplo p/ ghcr.io:
REGISTRY_AUTH_REFS={"ghcr.io":"ghcr-pat"}
```

### 1.2 Wiring — host→ref map no `createDockerProvider`

`core/src/entrypoint-wiring.ts` (composition root): faz `JSON.parse` de `config.REGISTRY_AUTH_REFS` (fail-closed em malformado, §1.5), valida o shape via Zod (`z.record(z.string(), z.string())`), e passa o mapa resolvido `host → secret-ref` como **opt aditiva opcional** em `DockerProviderOptions`:

```ts
/** OPTIONAL host→secret-ref map (e.g. {"ghcr.io":"ghcr-pat"}). Absent ⇒ no
 *  registry auth wired ⇒ ensureImage never sends X-Registry-Auth (current
 *  behaviour). The ref resolves AT APPLY via the existing secretResolver. */
readonly registryAuthRefs?: Readonly<Record<string, string>>;
```

Ausente em testes-em-isolamento ⇒ comportamento AS-IS (back-compat, mesmo padrão de `secretResolver`/`applyContext` em `docker.ts:113/132`).

### 1.3 Resolução da credencial (apply-only, atrás do `ApplyContext`)

O `secretResolver` **já está wired** no DockerProvider (Bug 10 — `docker.ts:261`/`resolveSecretEnv` em `:607`). O `<ref>` (ex.: `ghcr-pat`) resolve, **AT APPLY behind the unforgeable `ApplyContext` token**, pra uma credencial JSON:

```json
{ "username": "<user>", "password": "<pat-ou-senha>" }
```

- O valor resolvido é validado por um Zod schema `z.object({ username: z.string().min(1), password: z.string().min(1) })`. **Fail-closed:** valor resolvido que não casa esse shape ⇒ `ReconcileError("fatal", "registry auth for <host> is not a {username,password} JSON")` — o `<host>` é non-sensitive; o valor resolvido NUNCA entra na mensagem.
- O operador deve armazenar o ref `ghcr.io` (i.e. `ghcr-pat`) como **esse JSON** (documentado no runbook §5).
- A resolução é **apply-only**: `ensureImage` ganha um parâmetro `applyContext` e só é chamada no create-path dentro de `apply()` (`docker.ts:726`, já gated por `needsCreate`). plan/dry_run/observe/verify NUNCA resolvem (nenhum token wired ali — mesma garantia de `resolveSecretEnv`).

### 1.4 `ensureImage` — passos novos (antes do pull)

`ensureImage(image, entity)` ganha o parâmetro `applyContext: ApplyContext | undefined` e, ANTES do `POST /images/create`:

1. **(Peça B) skip-if-exists** — §2.
2. **Deriva o registry host** via helper `_registryHostOf(image)`:
   - `ghcr.io/example-org/bevox-backend@sha256:…` → `ghcr.io`.
   - nome unqualified (`redis:7-alpine`, `postgres:16-alpine`) → **Docker Hub default `docker.io`** (convenção: o host canônico declarado pelo operador é `docker.io`; o Engine usa `registry-1.docker.io` internamente, mas o **serveraddress do auth-config** e a CHAVE do mapa são `docker.io` — uma só convenção, documentada).
   - regra: o host é o primeiro segmento ANTES do primeiro `/` **sse** contém `.` ou `:` (ou é `localhost`); senão é Docker Hub default.
3. **Se** `registryAuthRefs[host]` existe **E** `applyContext` presente:
   - resolve o ref via `secretResolver.resolve(secret:<ref>, applyContext)` (gate unforgeable);
   - parse + valida `{username,password}` (Zod, fail-closed §1.3);
   - constrói o header value:
     ```
     X-Registry-Auth = base64url( JSON.stringify({ username, password, serveraddress: host }) )
     ```
     conforme o auth-config spec do Docker Engine API.
   - passa o header pro transport (§1.6).
4. **Senão** (host sem ref configurado, ou sem applyContext) ⇒ **nenhum header** ⇒ path inalterado (pulls públicos).

A mensagem de erro do pull falho permanece **byte-idêntica** à atual (`docker.ts:402-407`): nomeia só `"${image}"`, NUNCA ecoa o stream do registry. (Note: o throw atual é `"transient"` — preservado; um auth-error de registry é tipicamente recuperável por re-config, e fail-safe garante que nada é criado/removido.)

### 1.5 Boot validation (`entrypoint-wiring.ts`)

Helper (não-exportado, mesma file que `buildBootDeps`): se `config.REGISTRY_AUTH_REFS` presente:

1. `JSON.parse` — falha ⇒ `ReconcileError("fatal", "REGISTRY_AUTH_REFS is not valid JSON")` (value-free).
2. `z.record(z.string(), z.string()).parse(parsed)` — shape inválido ⇒ `ReconcileError("fatal", "REGISTRY_AUTH_REFS must be a {host: ref} string map")`.
3. resultado → `registryAuthRefs` opt do DockerProvider.

NÃO valida que cada `<ref>` existe no `SECRETS_FILE` no boot (sem boot-scan — coerente com `2026-05-28-secret-resolver-real-v1` §10 "Boot-scan de manifests pra validar refs"). O primeiro apply que precisar do registry resolve (e fail-closed se o ref/cred estiver errado).

### 1.6 Transport — header sensível via stdin (NUNCA argv)

`core/src/providers/docker-transport.ts`: `DockerTransport.request` ganha um **4º param opcional**:

```ts
request(
  method: string,
  path: string,
  body?: unknown,
  /** SENSITIVE headers (e.g. X-Registry-Auth). Implementations MUST route
   *  these so the value NEVER lands on an argv token / ps-visible command
   *  line — see the SSH impl's curl --config - (stdin) requirement. */
  headers?: Readonly<Record<string, string>>,
): Promise<DockerResponse>;
```

O contrato secret-boundary do header (estende o header já presente em `docker-transport.ts:47-54`): implementações **MUST NOT** colocar o valor do header em argv, error message, rejection, retry/debug log. Surface só method+path+status.

**SSH impl (`core/src/providers/ssh-transports.ts:makeDocker`):** os headers sensíveis viajam via `curl --config -` lendo de **stdin** — uma linha `header = "X-Registry-Auth: <value>"`. NUNCA como token argv `-H` (argv é visível em `ps aux` no host remoto — o mesmo risco que `RESTIC_PASSWORD` evita via SendEnv, `ssh-transports.ts:362`).

Isso é seguro porque **`POST /images/create` não tem body** — a stdin está livre. O path body-via-stdin existente (`--data-binary @-`, `:165-172`) só roda em chamadas COM body; o `-H Content-Type` argv idem. Logo:

- **chamada com body** (ex.: `/containers/create`): path atual inalterado (`-H Content-Type` argv + `--data-binary @-` stdin).
- **chamada com sensitive headers, sem body** (ex.: `/images/create` com auth): argv ganha `--config -`; a linha `header = "X-Registry-Auth: …"` viaja na stdin.
- **chamada com body E sensitive headers ao mesmo tempo:** **OUT-OF-SCOPE v1** — nenhuma chamada assim existe (`/images/create` é header-only, `/containers/create` é body-only). A SSH impl pode **assert/guard** contra esse caso (`ReconcileError("precondition")`) pra impedir que um futuro caller misture os dois e force o segredo pra argv.

> Decisão deliberada: o `--config -` lê TODA a config-line da stdin, mas só passamos a(s) linha(s) `header = …`. Nada de `url`/`data` na config (esses seguem em argv como hoje — são non-secret).

## 2. Peça B — skip pull se a image já existe local

`ensureImage`, ANTES do `POST /images/create`:

- `GET /images/<encodeURIComponent(ref)>/json` — HTTP **200** ⇒ **return imediato** (sem pull, sem hit no registry, sem `changed`, sem resolver credencial).
- Senão (404) ⇒ pull (com auth da Peça A).

**Decisão (operador): skip-if-exists ALWAYS.** O manifesto bevox pina images por `@sha256:` (digest imutável) ⇒ skip é correto. Pra uma tag mutável, o skip espelha o no-op de pull-by-digest do Docker e não re-pulla até a image sumir local — **aceito** (re-apply vira no-op; desbloqueia operador que pré-pulla; sem re-hit gratuito no registry).

Idempotência: skip-if-exists + pull NUNCA setam `changed` (esse segue dirigido por create/start, `docker.ts:735`). Re-apply ⇒ no-op (e na 2ª passada nem chega ao pull — a image já está presente).

## 3. Invariantes — leak prevention explícita

| # | Invariante | Garantido por |
|---|---|---|
| L1 | Cred do registry resolve SÓ em apply atrás do `ApplyContext` | `ensureImage` recebe `applyContext`; chamada só no create-path em `apply()` (`docker.ts:726`); plan/dry_run/observe/verify não têm token |
| L2 | password resolvido NUNCA em plan/dry_run/log/StateEvent/observed/error | nunca passado a `logger.*`; nunca em `StateEvent.payload`; erro de cred-malformada cita só `<host>` |
| L3 | valor base64 `X-Registry-Auth` NUNCA em log/argv/error (base64 ≠ encryption) | header sensível viaja via `--config -` stdin (`ssh-transports.ts`); transport contract proíbe header em diagnóstico; nunca argv |
| L4 | pull-error path nomeia só a image, nunca o stream do registry | `docker.ts:402-407` preservado byte-idêntico |
| L5 | fail-closed em cred malformada | Zod `{username,password}` no valor resolvido ⇒ `ReconcileError("fatal")` antes de qualquer pull |
| L6 | `secret-apply.test.ts` golden permanece byte-idêntico | esta spec não toca o env-injection path (§"files NÃO tocados") |
| L7 | fail-safe inalterado | pull/auth falho throw (`transient`/`fatal`) ⇒ NENHUM container criado, NADA deletado |

## 4. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| Fake fidelity (image present) | `core/test/fakes/docker-http.ts` (+ sibling) | `GET /images/<ref>/json` → 200 se semeada, 404 senão; seam pra semear presença |
| Fake fidelity (auth capture) | `docker-http.ts` | `POST /images/create` captura o header `X-Registry-Auth` quando enviado |
| Peça A — auth | `docker.test.ts` | com `registryAuthRefs={"ghcr.io":"ghcr-pat"}` + resolver retornando `{username,password}` ⇒ o pull carrega `X-Registry-Auth` = base64url(`{username,password,serveraddress:"ghcr.io"}`); image pública (host sem ref) ⇒ **nenhum** header |
| Peça A — host derivation | `docker.test.ts` | `_registryHostOf`: `ghcr.io/…@sha256:…`→`ghcr.io`; `redis:7-alpine`→`docker.io`; `r:5000/img`→`r:5000`; `localhost/img`→`localhost` |
| Peça A — fail-closed | `docker.test.ts` | resolver retorna não-`{username,password}` ⇒ `ReconcileError("fatal")`, NENHUM pull, NENHUM container |
| Peça B — skip | `docker.test.ts` | image presente (`GET …/json`→200) ⇒ NENHUM `POST /images/create` emitido; image ausente ⇒ pull emitido |
| Transport — sensitive header | `ssh-transports.test.ts` | `request` com header sensível ⇒ argv contém `--config -`, o header viaja na **stdin**; o valor está **AUSENTE do argv**; body+sensitive-header juntos ⇒ `ReconcileError("precondition")` (guard) |
| Boot — Zod | `entrypoint-wiring.test.ts` | `REGISTRY_AUTH_REFS` JSON malformado ⇒ boot `fatal` (value-free); shape não-`{host:ref}` ⇒ `fatal`; ausente ⇒ ok, mapa vazio |
| Secret hygiene | `docker.test.ts` + sentinel | password resolvido + valor base64 do header NUNCA em nenhum log/plan/event/argv capturado |
| Idempotency property | `idempotency.property.test.ts` (extend/keep) | manifesto com service privado (skip+pull) converge; ciclo 2 = no-op, zero mutations, sem re-pull |
| Secret golden | `secret-apply.test.ts` | **byte-idêntico** (nenhum fix toca o env-injection path) |

## 5. Operator workflow (resumido — detalhe vai pro runbook)

1. Armazena a credencial do registry no sops file como JSON (§1.3):
   ```bash
   SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
     sops --set '["ghcr-pat"] "{\"username\":\"bevox-bot\",\"password\":\"ghp_…\"}"' \
          ~/.config/bevox/secrets.enc.yaml
   ```
2. Declara o mapa host→ref em `core/.env`:
   ```bash
   echo 'REGISTRY_AUTH_REFS={"ghcr.io":"ghcr-pat"}' >> core/.env
   ```
3. `npm --prefix core run build && sudo systemctl restart bevox-daemon`.
4. `apply_manifest` com `service:bevox-backend` (image `ghcr.io/…@sha256:…`) ⇒ o pull autentica; container sobe.

## 6. Files in scope (impl checklist)

- `core/src/config.ts` — adiciona `REGISTRY_AUTH_REFS: z.string().optional()`.
- `core/src/config.test.ts` — caso optional (presente / ausente).
- `core/.env.example` — doc da key + formato JSON da cred.
- `core/src/providers/docker.ts` — `ensureImage` ganha `applyContext` + skip-if-exists (`GET …/json`) + `_registryHostOf` + resolve/validate cred + monta `X-Registry-Auth`; passa o header pro `tx.request`; chamada em `:726` passa `action.applyContext`.
- `core/src/providers/docker-transport.ts` — 4º param `headers?` no `request` + contrato secret-boundary do header.
- `core/src/providers/ssh-transports.ts` — `makeDocker.request` roteia sensitive headers via `curl --config -` (stdin); guard contra body+sensitive-header simultâneos.
- `core/src/entrypoint-wiring.ts` — parse+valida `REGISTRY_AUTH_REFS` (fail-closed) → passa `registryAuthRefs` em `createDockerProvider` opts.
- `core/test/fakes/docker-http.ts` — `GET /images/<ref>/json` (200/404) + captura `X-Registry-Auth` no create.
- `CHANGELOG.md` — `[Unreleased]`.

Arquivos **EXPLICITAMENTE NÃO TOCADOS:**

- `core/src/reconciler/**` — nenhum write-site de StateEvent muda; `applyContext` já é threaded por `applyPlan` (`docker.ts:124`).
- `core/src/store/secrets.ts` — `SecretResolver` interface FROZEN; reusada as-is.
- `core/src/reconciler/secret-apply.test.ts` — golden PRESERVADO byte-idêntico.
- `core/src/agent/**` — zero mudança na agent surface.

## 7. Riscos

| Risco | Mitigação |
|---|---|
| **base64 ≠ encryption (alto):** o valor `X-Registry-Auth` é só base64url do `{username,password}` — quem o vê, vê a cred | viaja via stdin (`--config -`), NUNCA argv (`ps aux`); transport contract proíbe em log/error; sentinel test |
| Convenção Docker Hub host (`docker.io` vs `registry-1.docker.io`) | `_registryHostOf` retorna `docker.io` como a CHAVE do mapa E o `serveraddress`; documentado; teste explícito de unqualified→`docker.io` |
| skip-if-exists em tag mutável não re-pulla | aceito (operador escolheu ALWAYS); image bevox é pinada por `@sha256:` (imutável); espelha pull-by-digest no-op do Docker |
| cred malformada no sops ⇒ apply falha tarde (não no boot) | fail-closed em apply (`ReconcileError fatal`, cita só `<host>`); sem boot-scan (coerente com `2026-05-28` §10) |
| body+sensitive-header simultâneos num futuro caller | guard `precondition` na SSH impl; nenhum caller assim existe em v1 (`/images/create` header-only) |
| pull-error throw é `transient` (não `fatal`) | preservado do estado atual; fail-safe garante nada criado/removido; re-config + re-apply converge |

## 8. Acceptance criteria

- [ ] `npm --prefix core run typecheck` sem novos erros; `npm --prefix core test` verde.
- [ ] Fakes tornados fiéis (`GET /images/<ref>/json` 200/404; captura `X-Registry-Auth`) — com testes que FALHAM antes do fix.
- [ ] Peça A: pull de image privada carrega `X-Registry-Auth` = base64url esperado; image pública ⇒ nenhum header; `_registryHostOf` cobre qualified/unqualified/port/localhost.
- [ ] Peça A: fail-closed em cred não-`{username,password}` ⇒ `fatal`, nada criado.
- [ ] Peça B: image presente ⇒ NENHUM `POST /images/create`; ausente ⇒ pull.
- [ ] Transport: sensitive header via `--config -` stdin; valor ABSENTE do argv; body+header guard.
- [ ] Boot: `REGISTRY_AUTH_REFS` malformado/shape-errado ⇒ boot `fatal` value-free; ausente ⇒ ok.
- [ ] Secret hygiene: password + base64 header AUSENTES de todo log/plan/event/argv capturado.
- [ ] Idempotency property cobre skip+pull (ciclo 2 no-op, sem re-pull); `secret-apply.test.ts` byte-idêntico.
- [ ] `CHANGELOG.md` `[Unreleased]`.

## 9. Decisões a confirmar no review

1. **Peça A + B combinadas** (travado) — auth header + skip-if-exists juntos. OK?
2. **Cred = JSON `{username,password}` num único ref por host** (per-host, não per-image) — vs ref separado pra user e pass. Proposto: JSON único (1 resolve, fail-closed por shape). OK?
3. **Convenção Docker Hub = `docker.io`** como chave do mapa E `serveraddress` (não `registry-1.docker.io`). OK?
4. **skip-if-exists ALWAYS** (não só pra digest-pinned) — re-apply nunca re-pulla até a image sumir local. OK pro go-live?
5. **`--config -` stdin pra header sensível** — vs um seam dedicado. Proposto: reusa a stdin já livre (sem body em `/images/create`); guard contra body+header. OK?
6. **pull-error segue `transient`** (estado atual), não promovido a `fatal`. OK? (Um `unauthorized` é recuperável por re-config + re-apply; fail-safe cobre.)
