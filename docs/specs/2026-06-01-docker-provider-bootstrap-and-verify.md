# bevox-hetzner-mcp — Docker provider: pull, start, verify + provision user_data

- **Data:** 2026-06-01
- **Status:** Aceita (2026-06-01)
- **Autor:** Bernard (bug report do deploy real) + Claude Code
- **Tipo:** Bug-fix de correção (Bugs 5, 6) + additives (Bug 4 image pull, Bug 3 `user_data`). Não altera contrato de wire v1/v2, error codes, nem invariantes.
- **Motivação concreta:** Após os fixes de SSH (`2026-06-01-ssh-argv-quoting-and-key-unescape`), o `apply_manifest` de um service mínimo (`nginx:alpine`) contra um host fresh expôs 4 bugs no `DockerProvider` / provision. Dois são bugs reais **mascarados pelos fakes** (a suíte ficou verde enquanto o real falhava); dois são features ausentes.
- **Invariantes preservadas:** fail-safe nunca fail-deleting (pull/start não deletam; pull falho aborta a action SEM remover nada); idempotência (re-apply converge a no-op); secrets resolvidos só em apply (inalterado); StateEvent actor inalterado.

## 0. Escopo

| # | Sintoma real | Tipo | Causa-raiz | Fake mascarou? |
|---|---|---|---|---|
| 5 | container fica `Created`, nunca roda; verify "did not converge" | **bug** | `listManaged` (`docker.ts:290`) não passa `all=true`; o Engine real lista só containers **running** por default ⇒ pós-create (`Created`) `replicasOf` vem vazio ⇒ loop de start pula | sim — fake retorna containers de qualquer estado |
| 6 | verify false mesmo com container running | **bug** | `isConverged` (`docker.ts:457`) exige `havePorts.size === wantPorts.size`; a IMAGEM expõe portas (nginx → 80/tcp) que aparecem no inspect mesmo sem o manifesto declarar | sim — fake só ecoa ExposedPorts do create |
| 4 | `No such image` (ContainerCreate 404) | feature | provider nunca faz `POST /images/create` (docker pull) | sim — testes pré-semeiam imagens |
| 3 | host fresh não tem Docker | feature | provision não injeta cloud-init | — |

**Out-of-scope:** auto-install de Docker via SSH bootstrap-stage (escolhido o caminho cloud-init `user_data`, mais limpo); o Bloco E completo (k3s/runtime artifacts) — Bug 3 é um carve-out mínimo de `user_data`, não o catálogo de perfis. Registry auth para pull privado (assume registries públicos/anon em v1; refs com auth = follow-up).

## Tema transversal — fakes infiéis

Bugs 5 e 6 passaram pelo CI porque o `core/test/fakes/docker-http.ts` não modela duas realidades do Engine:
1. `GET /containers/json` retorna **só running** salvo `?all=true`.
2. `Config.ExposedPorts` no inspect inclui as portas **default da imagem**, não só as do create.

Cada fix PAREIA a correção do provider com tornar o fake fiel a essas realidades — senão o teste continua mascarando. Isto é a aplicação direta de `.claude/skills/fakes-author` (o fake é a especificação executável do real).

## 1. Bug 5 — `listManaged` precisa de `all=true`

`docker.ts:290`: `GET /containers/json?filters={"label":["bevox.managed=true"]}` → adicionar `all=true`:

```ts
`/containers/json?all=true&filters=${encodeURIComponent(filters)}`
```

Assim `replicasOf` enxerga o container recém-criado (`Created`) e o loop de start o inicia. observe() também passa a reportar containers parados/saídos (entidade gerenciada que precisa reconciliar) — comportamento mais correto, não menos.

**Fake fiel:** `GET /containers/json` sem `?all=true` retorna SÓ `State==="running"`; com `all=true` retorna todos. (Hoje retorna todos sempre.)

## 2. Bug 6 — `isConverged` portas: subset, não igualdade exata

`docker.ts:456-458`: remover a igualdade de tamanho; manter o subset (toda porta declarada presente):

```ts
const havePorts = new Set(Object.keys(insp.Config.ExposedPorts ?? {}));
// REMOVER: if (havePorts.size !== wantPorts.size) return false;
for (const p of wantPorts) if (!havePorts.has(p)) return false; // declaradas ⊆ expostas
```

Alinha com o princípio documentado de `isConverged` ("compara só os campos que o create setou"): portas default da imagem não são drift do provider. Omitir portas no manifesto ⇒ não comparar tamanho.

**Fake fiel:** permitir semear/embutir portas default de imagem no inspect (ex.: um seam `fake.setImageExposedPorts(image, ["80/tcp"])` ou o create herda portas da "imagem") para um teste provar que verify tolera portas extras da imagem.

## 3. Bug 4 — `docker pull` antes do create

Antes do loop de create, garantir a imagem por service (uma vez):

- `POST /images/create?fromImage=<repo>&tag=<tag>` (tag form) ou `?fromImage=<repo>@sha256:<digest>` (digest form — sem `tag`).
- Drenar a resposta **NDJSON** do Engine; se algum objeto tem `{"error":...}` ⇒ **fail-closed**: `ReconcileError` (não cria container). 404/registry-auth ⇒ erro classificado.
- Helper `parseImageRef(image)`: `"nginx:alpine"`→`{fromImage:"nginx",tag:"alpine"}`; `"nginx"`→`{fromImage:"nginx",tag:"latest"}`; `"r/repo:tag"`→`{fromImage:"r/repo",tag:"tag"}`; `"repo@sha256:xxx"`→`{fromImage:"repo@sha256:xxx"}` (sem tag).
- **Idempotência:** o Engine trata imagem já-presente como no-op ("up to date"); o pull NÃO altera `changed` (esse continua dirigido por create/start). Re-apply ⇒ no-op preservado.

**Fake fiel:** suportar `POST /images/create` (registra a imagem como presente; retorna NDJSON de sucesso); `ContainerCreate` retorna **404** se a imagem não foi "pulled"/registrada (hoje aceita qualquer Image). Um seam `fake.setRegistryImage(ref)` / `fake.failPull(ref)` para cobrir sucesso, not-found e digest.

## 4. Bug 3 — `user_data` (cloud-init) no provision

Carve-out mínimo: passthrough de cloud-init para o `POST /servers` da Hetzner (campo `user_data`).

- `ManifestServerSchema` (`desired-state.ts`) **+** `entities.ServerSchema` (`entities.ts`): `user_data: z.string().optional()` (em AMBOS — o apply re-valida via `ServerSchema.safeParse`, `hetzner-cloud.ts:149`, que strippa unknowns).
- `serverBody` (`hetzner-cloud.ts:336`): destructure `user_data` e adicionar ao body **só quando presente** (omitido ⇒ body byte-idêntico).
- **Fake fiel:** o `hetzner-http` fake aceita/ecoa `user_data` no create de server (para o teste assertar o passthrough).
- **Docs:** `.env.example`/runbook + manifesto de exemplo com o cloud-config canônico (`packages: [docker.io, curl, jq]; runcmd: [systemctl enable --now docker]`). O operador declara `servers[].user_data` uma vez.

Não há default opinativo de install no daemon (o operador controla o cloud-init); o mecanismo é o passthrough.

## 5. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| Fake fidelity (run-state) | `core/test/fakes/docker-http.ts` (+ sibling test) | list sem `all` → só running; com `all=true` → todos |
| Bug 5 | `docker.test.ts` | create → container `Created` → apply o **inicia** (start chamado via `all=true`); verify converge; re-apply no-op |
| Fake fidelity (image ports) | `docker-http.ts` | inspect inclui portas default da imagem semeada |
| Bug 6 | `docker.test.ts` | service sem `ports` declaradas + imagem que expõe 80/tcp → `isConverged` true; porta declarada ausente do container → false |
| Bug 4 | `docker.test.ts` + fake | pull chamado antes do create; tag e `@sha256:` forms; pull falho (404) → action falha, **nenhum container criado**; idempotência (re-apply não duplica) |
| Bug 3 | `desired-state.test.ts`, `entities.test.ts`, `hetzner-cloud.test.ts` | `user_data` parseado e retido em ambos schemas; presente no body do `POST /servers` sse declarado; omitido ⇒ body byte-idêntico |
| Idempotency property | `idempotency.property.test.ts` | manifesto com service (pull+start) converge; ciclo 2 = no-op, zero mutations |
| Secret golden | `secret-apply.test.ts` | byte-idêntico (nenhum fix toca o secret path) |

## 6. Acceptance criteria

- [ ] `npm --prefix core run typecheck` sem novos erros; `npm --prefix core test` verde.
- [ ] Fakes tornados fiéis (run-state default, image-default ports, /images/create + 404-on-absent) — com testes que FALHAM antes do fix.
- [ ] Bug 5: container recém-criado é iniciado; verify converge; observe inclui parados.
- [ ] Bug 6: portas default da imagem toleradas; portas declaradas ainda exigidas (subset).
- [ ] Bug 4: pull antes do create (tag+digest); fail-closed; idempotente.
- [ ] Bug 3: `user_data` passthrough em ambos schemas + body; docs + exemplo.
- [ ] Idempotency property cobre o novo fluxo; secret golden byte-idêntico.
- [ ] `CHANGELOG.md` `[Unreleased]`.

## 7. Decisões registradas

| Decisão | Escolha | Razão |
|---|---|---|
| Bug 5 | `all=true` em listManaged | Engine lista só running por default; precisa ver `Created` pra iniciar |
| Bug 6 | subset de portas (não igualdade) | portas default da imagem não são drift; alinha com "compara só o que o create setou" |
| Bug 4 falha de pull | fail-closed (ReconcileError, nada criado) | fail-safe; convergência honesta |
| Bug 4 idempotência | pull não altera `changed` | re-apply = no-op |
| Bug 3 | `user_data` passthrough (manifest+entities+serverBody) | carve-out mínimo; operador controla cloud-init; não puxa Bloco E |
| Fakes | tornar fiéis ao Engine real (run-state, image ports, pull) | bugs 5/6 passaram por fakes infiéis; o fake é a spec executável |

## 8. Non-goals

Bootstrap-stage via SSH; Bloco E completo (perfis/runtime artifacts); registry auth para pull privado; default opinativo de docker-install no daemon (mecanismo via `user_data`, política do operador).
