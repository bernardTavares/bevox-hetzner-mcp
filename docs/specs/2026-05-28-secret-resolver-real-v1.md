# bevox-hetzner-mcp — Real secret resolver v1 (sops+age, on-demand subprocess)

- **Data:** 2026-05-28
- **Status:** Aceita (2026-05-28)
- **Autor:** Bernard (brainstorm desta sessão Claude Code)
- **Tipo:** Spec-filha — substitui o stub inerte `createStubSecretResolver` por um resolver real, mantendo `SecretResolver` interface FROZEN
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN; esta spec realiza o seam pré-cabeçado em §4.2 / §"secrets resolved at apply only")
- **Motivação concreta:** [bevox-harness — go-live spec §6.1](../../../code/bevox-harness/docs/superpowers/specs/2026-05-28-go-live-via-hetzner-mcp.md) — bloqueio direto pro primeiro deploy do bevox-harness (manifests com `secret:<ref>` em env de service ficam unusable enquanto o resolver retornar `deferred`).
- **Invariante v1 preservada:** "Secrets resolved at apply only. plan / dry_run / logs MUST NEVER contain a resolved secret value" — CONTRIBUTING §"Ground rules" #4.

## 0. Escopo

Substitui o body do default-DI em `core/src/server.ts:454` (`createStubSecretResolver()`) por uma factory nova `createSopsAgeSecretResolver()` que:

1. **Spawn** o binário canônico `sops` via `node:child_process` (sem npm dep nova).
2. **Decrypta on-demand** (sem cache, plaintext só vive em memória durante o subprocess call).
3. **Lê** um único arquivo sops-encrypted YAML configurado via env `SECRETS_FILE`.
4. **Usa** uma age key file configurada via env `SOPS_AGE_KEY_FILE`.
5. **Fail-fast no boot** se qualquer pré-condição (file ausente, perm > 0600, sops fora do PATH, dry-decrypt falha) violada.
6. **Preserva** `createStubSecretResolver` exportado **apenas como test seam** (testes que não querem subir sops continuam usando). O boot path produção NUNCA seleciona o stub — sem fallback automático (§6).

Out-of-scope (§10): rotation tool MCP, per-secret capability granularity, audit per-resolve, hot reload, cloud KMS, multi-tenant.

## 1. Design

### 1.1 Arquitetura

```
┌────────────── reconciler/apply path (UNCHANGED) ──────────────┐
│  PlanItem with secret:<ref> in env                             │
│           │                                                     │
│           ▼                                                     │
│   provider.apply(desired, applyCtx, deps)                       │
│           │                                                     │
│           ▼ deps.secretResolver.resolve(ref, ctx)              │
└────────────┬────────────────────────────────────────────────────┘
             ▼
┌── SopsAgeSecretResolver (NEW) ──────────────────────────────────┐
│  resolve(ref, ctx):                                              │
│   ├─ gate: isApplyContext(ctx)? else ReconcileError("fatal")    │
│   ├─ requireRef(ref) → bare name (validated, non-sensitive)     │
│   ├─ spawn("sops",                                              │
│   │     ["-d","--extract",`["${name}"]`,"--output-type","binary",│
│   │      secretsFile],                                          │
│   │     {shell:false, env:{PATH, HOME, SOPS_AGE_KEY_FILE}})     │
│   ├─ stdout → Buffer (cap 64 KB; reject if exceeded) → utf8     │
│   │           string AS-IS (NO trailing-newline strip — PEMs)   │
│   ├─ stderr → DISCARDED (never logged, never thrown)            │
│   ├─ exit 0 → { status:"ok", name, value }                      │
│   ├─ exit ≠0 → ReconcileError("fatal", "secret resolve failed: " + name) │
│   ├─ child.on('error') → wrapped (payload may include path)     │
│   └─ timeout (default 5s) → SIGTERM, 200ms grace, then SIGKILL  │
│                              + ReconcileError                    │
│                                                                  │
│  describe(ref):                                                  │
│   ├─ requireRef(ref) → bare name                                │
│   └─ { name, keys: [], used_by: [] }   (NO decrypt; same shape  │
│                                          as stub for v1)         │
└──────────────────────────────────────────────────────────────────┘
             ▲
             │ deps.secretResolver
┌── buildBootDeps (entrypoint-wiring.ts) — NEW switch ────────────┐
│  secretResolver: createSopsAgeSecretResolver({                  │
│    secretsFile: config.SECRETS_FILE,                            │
│    ageKeyFile:  config.SOPS_AGE_KEY_FILE,                       │
│    timeoutMs:   config.SECRETS_TIMEOUT_MS,                      │
│  })                                                              │
└──────────────────────────────────────────────────────────────────┘
```

**Mudança no `server.ts`: zero.** A DI já recebe `secretResolver` via `deps` em `createServer(config, deps)`. A factory que muda é `buildBootDeps`, em `entrypoint-wiring.ts`.

### 1.2 Public surface (export novo em `core/src/store/secrets.ts`)

```ts
export interface SopsAgeResolverConfig {
  /** Absolute path to the sops-encrypted YAML file. */
  readonly secretsFile: string;
  /** Absolute path to the age private key file (mode 0600 enforced at boot). */
  readonly ageKeyFile: string;
  /** Per-resolve subprocess timeout in ms. Range [1000, 60000]. Default 5000. */
  readonly timeoutMs?: number;
  /** OPTIONAL — sops binary path; defaults to "sops" (PATH lookup). */
  readonly sopsBinary?: string;
  /** OPTIONAL — spawn injection seam (tests pass a fake; prod uses real). */
  readonly spawn?: SpawnFn;
}

/**
 * Spawn-shaped seam — NOT `node:child_process.spawn` raw. Production passes a
 * thin wrapper around `child_process.spawn` that collects stdout/stderr into
 * Buffers (instead of exposing streams) and resolves exit code as a Promise.
 * Tests pass a fake with the same shape. The wrapper is ~30 lines, lives in
 * the same file as `createSopsAgeSecretResolver`, never logs, never writes
 * to disk.
 *
 * NOT EXPORTED publicly — type is module-internal. Both the resolver and the
 * boot-validation helper take an OPTIONAL `spawn` param of this shape; tests
 * inject a fake, production omits → real wrapper used.
 *
 * NO stdin: the subprocess is always invoked argv-only (no piping into
 * the child). If a future use case needs stdin, this seam must be extended
 * deliberately — silent passthrough is a misuse vector.
 *
 * exitCode coercion: `node:child_process.spawn` resolves `code: number | null`
 * (null on signal kill). The wrapper coerces `null → -1` deliberately so
 * downstream callers can branch on `code !== 0` without null-checks.
 */
type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { readonly shell: false; readonly env: Readonly<Record<string, string>> },
) => {
  /** Promise resolving to the full stdout buffer once the child closes. */
  stdout: Promise<Buffer>;
  /** Promise resolving to the full stderr buffer once the child closes. */
  stderr: Promise<Buffer>;
  /** Promise resolving to the exit code (or -1 on signal kill / abnormal). */
  exitCode: Promise<number>;
  /** Force-terminate the subprocess (used on timeout: SIGTERM → SIGKILL). */
  kill: (signal?: NodeJS.Signals) => void;
};

export function createSopsAgeSecretResolver(
  config: SopsAgeResolverConfig,
): SecretResolver;
```

`createStubSecretResolver` permanece exportada — usada **apenas como test seam** (tests que não querem subir sops). Boot path produção NUNCA seleciona o stub.

### 1.3 Config

`core/src/config.ts:ConfigSchema` ganha 2 keys REQUIRED + 1 OPCIONAL:

```ts
// REQUIRED secrets / connection strings (NO DEFAULTS) — section existente.
// Paths DEVEM ser absolutos — `requiredSecret` valida non-empty, mas não
// expande `~`. A validation §1.4 fail-fast no boot se path não-existe.
SECRETS_FILE: requiredSecret("SECRETS_FILE"),
SOPS_AGE_KEY_FILE: requiredSecret("SOPS_AGE_KEY_FILE"),

// non-secret operational knob — section existente.
// NOTE: `intKnob(default, min)` em config.ts:66 só enforce MIN. Pra bound
// superior [1000, 60000] precisa estender o helper (ex.: `intKnob(5000,
// 1000, 60000)` ou Zod schema explícito `.int().min(1000).max(60000)`).
SECRETS_TIMEOUT_MS: intKnob(5000, 1000, 60000),  // bound: 1000..60000
```

Justificativa de `requiredSecret` (não `optional()`): a Abordagem A (Strict v1) escolhida no brainstorm trata ausência como erro de configuração — daemon não sobe em estado intermediário. Coerência com `AGENT_CREDENTIALS`/`HCLOUD_TOKEN`/`DATABASE_URL`.

`core/.env.example` ganha:

```bash
# REQUIRED — sops-encrypted YAML with all bevox secrets (top-level keys = names).
# Operator workflow: `age-keygen -o $SOPS_AGE_KEY_FILE && sops --age <pub> -e file`
SECRETS_FILE=~/.config/bevox/secrets.enc.yaml

# REQUIRED — age private key file (mode 0600 enforced at boot).
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key

# OPTIONAL — per-resolve subprocess timeout, range [1000, 60000]. Default 5000.
SECRETS_TIMEOUT_MS=5000
```

### 1.4 Boot validation

Helper **não-exportado** em `core/src/entrypoint-wiring.ts` (mesma file que `buildBootDeps` — um único caller, não vale arquivo próprio):

```ts
function validateSopsAgeConfig(
  config: { SECRETS_FILE: string; SOPS_AGE_KEY_FILE: string },
  deps?: { fs?: typeof import("node:fs"); spawn?: SpawnFn },
): void;  // throws ReconcileError("fatal", ...) on any precondition fail
```

Etapas sequenciais (first failure short-circuits) — **4 etapas, sem dry-decrypt**:

1. `fs.lstatSync(SECRETS_FILE).isFile()` — rejeita symlink/dir/missing por `lstat` (NÃO `stat`, que segue symlinks e mascara perms do target). Else `ReconcileError("fatal", "secrets file not found")`.
2. `fs.lstatSync(SOPS_AGE_KEY_FILE).isFile()` — idem. Else `ReconcileError("fatal", "age key file not found")`.
3. `(stat.mode & 0o077) === 0 && stat.uid === process.getuid()` — rejeita group/world readable **AND** rejeita key file owned por outro user (mesmo com 0600). Else `ReconcileError("fatal", "age key file has insecure permissions or ownership")`.
4. `spawn("sops", ["--version"], {shell:false, env:{PATH, HOME}})` exit 0 — else `ReconcileError("fatal", "sops binary not found")`.

> **Step 5 (dry-decrypt) CORTADO deliberadamente.** A versão original validava o age key fazendo `sops -d` no boot e descartando stdout. Trade-off rejeitado: o full plaintext ficava brevemente num Buffer no boot trocando posture por marginal early-failure signal. O **primeiro `resolve()` real** descobre o mesmo mismatch com o mesmo `ReconcileError("fatal")` e **zero plaintext-no-boot**. Steps 1-4 acima cobrem a maioria dos erros operacionais (paths errados, perms erradas, binary ausente). Defense-in-depth restante (Buffer-de-resolve, ~30ms por apply) coberta via systemd hardening na runbook §5.

`validateSopsAgeConfig` é chamado em `entrypoint-wiring.ts:buildBootDeps` ANTES de qualquer outro recurso (pg pool, http clients) ser aberto. Se falha, daemon exits 1 value-free — pattern existente.

### 1.5 Data flow completo (um secret end-to-end)

1. **Manifest** carrega `services[].env.OPENAI_API_KEY = "secret:openai-api-key"` (já validado por `desired-state.ts` via `SecretRef` brand).
2. **plan()** monta `PlanItem` preservando o ref verbatim. `PlanItem.change` carrega `secret:openai-api-key`, nunca o value.
3. **applyPlan()** minta uma `ApplyContext` via `createApplyContext()` — token unforgeable módulo-private brand.
4. **DockerProvider.apply(desired, ctx, deps)** em `core/src/providers/docker.ts:420-427`:
   ```ts
   for (const [k, v] of envEntries) {
     if (!isSecretRef(v)) { out.set(k, v); continue; }
     const r = await deps.secretResolver.resolve(v, ctx);
     if (r.status === "ok") out.set(k, r.value);
     // else "deferred" — caller policy (today: keep ref string)
   }
   ```
5. **SopsAgeSecretResolver.resolve**:
   - Gate `isApplyContext(ctx)` — sem token unforgeable, `ReconcileError("fatal")` IMEDIATO.
   - `spawn` subprocess sops com args via argv (`shell:false`):
     ```ts
     const args = ["-d", "--extract", `["${name}"]`, "--output-type", "binary", secretsFile];
     // NOTE: NÃO usar JSON.stringify(`["${name}"]`) — adiciona aspas externas
     // que sops parser rejeita. Template literal verbatim é a forma correta.
     // O regex SECRET_REF_RE em requireRef() já garante que name não tem
     // chars que precisem escape no JSON path (só [a-z0-9_-]).
     const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
                   SOPS_AGE_KEY_FILE: config.ageKeyFile };
     // HOME é necessário pro sops descobrir age-plugin-* binários em setups
     // que tenham age plugins em ~/bin ou similar.
     ```
   - stdout → `Buffer` com **cap de 64 KB**. Se exceeded, kill subprocess + `ReconcileError("fatal", "secret resolve oversized: " + name)`. Defesa contra arquivo sops tampered/oversized OOM.
   - `--output-type binary` faz sops retornar os bytes raw do value (sem wrap YAML/JSON). Stdout é **passado AS-IS** — `return { status:"ok", name, value: stdout.toString("utf8") }`. **NÃO strippar trailing newline** — PEM keys e secrets binário-like têm `\n` significativo.
   - stderr → DISCARDED. Mesmo se sops emite warnings em stderr durante um sucesso (exit 0), a decisão é exit-code-only.
   - Exit ≠ 0: stderr DESCARTADO; `throw new ReconcileError("fatal", "secret resolve failed: " + name)`.
   - `child.on('error')` payload (que pode conter o path do binary) é **wrappeado** em `ReconcileError("fatal", "secret resolve failed: " + name)` — nunca rethrown raw.
   - Timeout (default 5s): **SIGTERM → 200ms grace → SIGKILL** + `ReconcileError("fatal", "secret resolve timeout: " + name)`. SIGTERM primeiro dá chance ao sops scrubar memória própria; SIGKILL é fallback.
6. **Provider** injeta `r.value` em `Engine.Env` do container (POST /containers/create via Docker daemon SSH). Value cruza a wire HTTP para o Docker daemon — esse é o destino legítimo, não leak.
7. **Após o apply**: `Buffer` sem referência, GC reclama. Value só vive no container running (out-of-process do bevox-hetzner-mcp). Nada toca disk, log, StateEvent, response.

## 2. Error handling — taxonomia completa

### 2.1 Boot-time (value-free, daemon falha all-or-nothing)

| Cenário | Erro |
|---|---|
| `SECRETS_FILE` env ausente | `ConfigSchema` rejeita via `requiredSecret` (pattern existente em `config.ts`) |
| `SOPS_AGE_KEY_FILE` env ausente | idem |
| `SECRETS_FILE` path não existe / não é file | `ReconcileError("fatal", "secrets file not found")` |
| `SOPS_AGE_KEY_FILE` path não existe | `ReconcileError("fatal", "age key file not found")` |
| `SOPS_AGE_KEY_FILE` perm > 0600 | `ReconcileError("fatal", "age key file has insecure permissions")` |
| `sops` binary fora do PATH | `ReconcileError("fatal", "sops binary not found")` |
| Dry-decrypt no boot falha | `ReconcileError("fatal", "secrets file undecryptable with configured age key")` |

### 2.2 Resolve-time

| Cenário | Erro |
|---|---|
| Ref malformado | `ReconcileError("precondition", "secret ref invalid: …")` — herdado de `requireRef` existente |
| `ctx` ausente / forjado | `ReconcileError("fatal", "secret resolve refused: …")` — herdado |
| Subprocess spawn fail (binary sumiu) | `ReconcileError("fatal", "secret resolve failed: <name>")` |
| Subprocess exit ≠ 0 (name ausente no file, key errada, etc.) | idem |
| Subprocess timeout | `ReconcileError("fatal", "secret resolve timeout: <name>")` + SIGTERM → 200ms → SIGKILL |
| Subprocess crash (`child.on('error')`) | `ReconcileError("fatal", "secret resolve failed: <name>")` — payload do child.on('error') (que pode incluir filesystem path do binary) é **WRAPPED**, nunca rethrown raw |
| Subprocess stdout > 64KB (Buffer cap §1.5) | `ReconcileError("fatal", "secret resolve oversized: <name>")` + child kill |

**Princípio**: mensagens citam só `<name>` (já é o REF, non-sensitive). NUNCA citam stdout/stderr do subprocess. NUNCA citam errno raw nem path do binary. NUNCA repassam o `Error.cause` do upstream sem wrap.

## 3. Leak prevention — invariantes explícitas

| # | Invariante | Garantido por | Teste |
|---|---|---|---|
| L1 | NO value em plan / dry_run / observe | Type system (`SecretResolveResult` discriminated union) + module-private brand do `ApplyContext` | `secret-apply.test.ts` §"1.9 regression guard" |
| L2 | NO value em log | Resolver não chama `logger.*` com value; stderr do subprocess DESCARTADO antes de qualquer throw | leak-sentinel-auditor + grep sentinel |
| L3 | NO value em StateEvent.payload | Resolver não emite event (decisão Abordagem A); apply event carrega só refs em `change` | `secret-apply.test.ts` §"NO VALUE EVER OUTSIDE GATED APPLY" |
| L4 | NO value em HTTP response / MCP result | `WriteEnvelope` schema não tem field pra value; `Plan` só carrega refs | envelope schema test + golden test |
| L5 | NO value em error message | Mensagens fixed-format `"secret resolve failed: <name>"`; stderr descartado; upstream errors WRAPPED | sentinel test `S3CR3T-fake-leak-XYZ` em stderr → assert NOT em catch |
| L6 | NO value alcança disk fora do container | stdout → Buffer em memória, NUNCA temp file; daemon NUNCA escreve value em arquivo | impl review + property test possível |
| L7 | Key file não é world/group-readable, não é owned por outro user, não é symlink | Boot check `(stat.mode & 0o077) === 0 && stat.uid === process.getuid()` + `fs.lstatSync` (rejeita symlinks) | `entrypoint-wiring.test.ts` casos §4.4 itens 3-5 |
| L8 | sops args via argv, nunca shell | `spawn(..., {shell:false})` por construção (type-system enforced via `SpawnFn`); name no `--extract` é template literal verbatim (forma correta), não `JSON.stringify` | impl review + spawn-fake assertion §4.3 caso 10 |
| L9 | Daemon não OOMa via tampered sops file (oversized value) | Buffer cap 64KB no stdout do subprocess; reject + kill se exceeded | §4.3 caso 11 |

### 3.1 Defensive — subprocess env hygiene

O subprocess sops é spawned com env **MÍNIMO**, não herdando `process.env`:

```ts
const child = spawn(sopsBinary, args, {
  shell: false,
  env: {
    PATH: process.env.PATH ?? "",            // pra sops resolver suas libs
    HOME: process.env.HOME ?? "",            // pra age-plugin-* discovery
    SOPS_AGE_KEY_FILE: config.ageKeyFile,
    // NADA mais. Sem AGENT_CREDENTIALS, sem HCLOUD_TOKEN,
    // sem HCLOUD_DNS_TOKEN, sem DATABASE_URL, sem RESTIC_*.
  },
});
```

Isolation por construção: sops NÃO RECEBE NENHUM env secret-laden do daemon. Mesmo um sops compromisado não exfiltra outros secrets do daemon via env. `HOME` é incluído porque sops chama bins `age-plugin-*` via PATH-lookup, e alguns setups operacionais (notadamente o nosso, com fnm + per-user installs) têm os plugins em `~/bin` ou `~/.local/share/`. Sem `HOME` o sops em produção fail silently com erro opaco em setup divergente do dev.

## 4. Testing

### 4.1 Preservar (sem mudança)

| Arquivo | Razão |
|---|---|
| `core/src/reconciler/secret-apply.test.ts` | Golden test das 4 invariantes (1.9 regression, no-leak, gate-guarded, idempotency). Bar máxima. Injeta resolver via deps — não toca sops binary, continua determinístico em CI. |
| `core/src/store/secrets.test.ts` | Testes do stub + interface. Stub continua existindo (export inalterado). |
| `core/src/reconciler/idempotency-property.test.ts` (extend) | Property test ganha caso: aplicar 2x service com `secret:<ref>` em env → cycle 2 plan.ops == []. Garantia de que value resolution não introduz drift. **A harness do property test DEVE injetar `createSopsAgeSecretResolver({spawn: fakeSpawn})`** (via deps no `createServer`); SEM spawn real, mantém o "fakes only" rule. |

### 4.2 Novos arquivos

| Arquivo | Conteúdo |
|---|---|
| `core/test/fakes/sops-cli.ts` | Spawn-shaped fake: `Map<name, value>` + exit codes + stderr buffers configuráveis; usado pelos testes abaixo. Zero npm dep. |
| `core/src/store/secrets-sops-age.test.ts` | Unit tests da factory — 9 casos abaixo. |
| `core/src/entrypoint-wiring.test.ts` (EXTEND) | Boot validation — 7 casos abaixo (sem arquivo separado, pq `validateSopsAgeConfig` é helper não-exportado neste mesmo módulo §1.4). |

### 4.3 Casos novos em `secrets-sops-age.test.ts`

1. Forged ctx (`{}`, `"apply"`, `null`, missing brand) → `ReconcileError("fatal")` IMEDIATO, spawn NUNCA chamado.
2. Real ctx + ref malformado → `ReconcileError("precondition")`, spawn NUNCA chamado.
3. Real ctx + valid ref + fake spawn returns stdout `"abc"`, exit 0 → `{status:"ok", name, value:"abc"}`.
4. Real ctx + valid ref + fake spawn stdout `"abc"` + stderr **non-empty** (sops warning) + exit 0 → `{status:"ok", value:"abc"}` (decisão é exit-code-only; stderr nunca observado em catch).
5. Real ctx + valid ref + value contém `\n` interno e trailing `\n` (PEM-like) → value retornado **byte-identical** (NO `.replace(/\n$/, "")` — defesa contra footgun S5).
6. Real ctx + valid ref + fake spawn exit 1 → `ReconcileError("fatal", "secret resolve failed: <name>")` — mensagem cita só name; stderr (mesmo com sentinel) descartado.
7. Fake spawn never returns + `timeoutMs:100` → SIGTERM, 200ms grace, SIGKILL + `ReconcileError("fatal", "secret resolve timeout: <name>")`. Assert `exitCode` resolveu como `-1` (não `null`, coercion da §1.2).
8. Spawn fake emits stderr containing sentinel `S3CR3T-fake-leak-XYZ` no fail path → assert sentinel NÃO aparece em nenhuma exception message capturada (defesa contra L5).
9. Spawn fake records `opts.env` keys → assert keys === `{PATH, HOME, SOPS_AGE_KEY_FILE}` exato (zero leak via env, defesa contra L8). E assert keys NÃO contém `AGENT_CREDENTIALS`/`HCLOUD_TOKEN`/`DATABASE_URL`/`RESTIC_*`.
10. Spawn fake records args → assert `args[0] === "-d"`, `args[1] === "--extract"`, `args[2] === `["${name}"]\`` (template literal verbatim, NÃO `JSON.stringify`), `args[3] === "--output-type"`, `args[4] === "binary"`, `args[5] === secretsFile`. Forma robusta a whitespace.
11. Fake spawn emits stdout > 64 KB → kill + `ReconcileError("fatal", "secret resolve oversized: <name>")` (defesa OOM Buffer cap §1.5).

§ "Cut: case 'opts.shell === false' strict-equal" — type system da `SpawnFn` §1.2 já proíbe `shell: true` na assinatura. Constructor signature É o teste.

### 4.4 Casos novos em `entrypoint-wiring.test.ts` (boot validation)

1. `SECRETS_FILE` path não existe → `ReconcileError("fatal", "secrets file not found")`.
2. `SOPS_AGE_KEY_FILE` path não existe → `ReconcileError("fatal", "age key file not found")`.
3. Key file mode 0644 (group readable) → `ReconcileError("fatal", "age key file has insecure permissions or ownership")` (defesa contra L7).
4. Key file owned por outro UID (mesmo com 0600) → mesma fatal (defesa Security #4).
5. Key file é symlink (mesmo apontando pra arquivo legítimo) → `lstatSync` rejeita → mesma fatal (defesa Security #4 — `statSync` mascararia perms do target).
6. Key file mode 0600 + owned-by-self + não-symlink → passa.
7. sops binary ENOENT (fake spawn returns spawn error com code "ENOENT") → `ReconcileError("fatal", "sops binary not found")`.
8. Tudo OK → retorna sem erro.

§ "Cut: case 'dry-decrypt fail'" — step 5 do §1.4 foi CORTADO (vide §1.4 nota). Primeiro resolve real cobre o cenário com mesma fatal envelope.

### 4.5 Smoke test manual (post-merge, pre-tag)

Runbook NOVO em `deploy/runbook-secrets-go-live.md`:

1. Generate age keypair + init sops file (procedimento §5).
2. `sops --set '["smoke-test"] "ABC123"' <file>` no file.
3. Restart daemon. `journalctl -u bevox-daemon -n 30` — confirma `boot ok`, sem leak de "ABC123" em nenhuma linha.
4. Apply manifest com service `OPENAI_API_KEY: secret:smoke-test`.
5. `ssh server "docker inspect svc | jq .Env"` — confirma `OPENAI_API_KEY=ABC123` no container.
6. `curl -H 'Auth' /api/state` — confirma value NÃO aparece (só ref).
7. `curl -H 'Auth' /api/events` — confirma value NÃO aparece (só ref).
8. `journalctl -u bevox-daemon | grep ABC123` — zero matches.

## 5. Operator workflow (resumido — detalhe vai pra runbook)

### 5.1 Setup inicial (operador faz UMA vez por ambiente)

```bash
mkdir -p ~/.config/bevox
age-keygen -o ~/.config/bevox/age.key
chmod 600 ~/.config/bevox/age.key
AGE_PUB=$(grep "^# public key:" ~/.config/bevox/age.key | cut -d' ' -f4)

# Adiciona o primeiro secret real via §5.2 ANTES do restart — sops cria o
# arquivo encriptado na primeira chamada `--set` (não precisa init com
# placeholder, que vira footgun de "esqueci de deletar").
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops --age "$AGE_PUB" --set '["bevox-init"] "ok"' \
       ~/.config/bevox/secrets.enc.yaml

echo "SECRETS_FILE=$HOME/.config/bevox/secrets.enc.yaml" >> core/.env
echo "SOPS_AGE_KEY_FILE=$HOME/.config/bevox/age.key" >> core/.env

# BACKUP IMEDIATO do age.key offsite — daemon + chave em trust zones separados.
# Sem essa chave, todos os secrets ficam permanently inaccessible.

# HARDENING do host (defense-in-depth pro Buffer-de-resolve ~30ms por apply):
# Em /etc/systemd/system/bevox-daemon.service.d/hardening.conf:
#   [Service]
#   LimitCORE=0                  # no core dumps (núncá salvar Buffer em /var/lib/systemd/coredump)
#   ProtectKernelTunables=yes
#   ProtectSystem=strict
#   MemoryDenyWriteExecute=yes
# E em /etc/sysctl.d/99-bevox.conf:
#   vm.swappiness=0              # never swap (Buffer page nunca vai pro disk)
# Sem `node --heapsnapshot-near-heap-limit` no ExecStart.

sudo systemctl daemon-reload
sudo systemctl restart bevox-daemon
sudo journalctl -u bevox-daemon -n 20 --no-pager
```

### 5.2 Adicionar / editar secret

Interativo:
```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops ~/.config/bevox/secrets.enc.yaml
```

Script-friendly:
```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops --set '["openai-api-key"] "sk-proj-..."' ~/.config/bevox/secrets.enc.yaml
```

### 5.3 Listar nomes (sem leak)

```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops -d ~/.config/bevox/secrets.enc.yaml | yq 'keys' --output-format json
```

### 5.4 Rotação do age key (recipient swap)

```bash
age-keygen -o ~/.config/bevox/age.key.new
NEW_PUB=$(grep "^# public key:" ~/.config/bevox/age.key.new | cut -d' ' -f4)

SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops updatekeys --age "$NEW_PUB" ~/.config/bevox/secrets.enc.yaml

mv ~/.config/bevox/age.key ~/.config/bevox/age.key.old
mv ~/.config/bevox/age.key.new ~/.config/bevox/age.key
sudo systemctl restart bevox-daemon
# Após validar boot OK, arquivar .old fora do host.
```

## 6. Migration path

Estado atual: daemon em produção (PID 3311385) rodando com stub resolver, sem `SECRETS_FILE`/`SOPS_AGE_KEY_FILE`, zero manifests com `secret:<ref>` resolvendo.

Sequência:

1. Operator faz §5.1 (setup inicial).
2. Append 2 keys novas a `core/.env`.
3. `npm --prefix core run build`.
4. `sudo systemctl restart bevox-daemon`.
5. Daemon boota com resolver real. Manifests SEM `secret:<ref>` continuam idênticos.

**Breaking change explícito**: `ConfigSchema` ganha 2 fields REQUIRED. Daemon não sobe sem eles. Mitigação: doc em `core/.env.example` + runbook §5 + minor version bump.

**Sem fallback automático ao stub.** Trade-off da Abordagem A (Strict v1) — coerência > flex.

## 7. Files changed (impl checklist)

- `core/src/config.ts` — adiciona `SECRETS_FILE`, `SOPS_AGE_KEY_FILE`, `SECRETS_TIMEOUT_MS` ao `ConfigSchema`. Estende `intKnob` pra suportar max bound (ou usa Zod schema explícito pra timeout).
- `core/src/config.test.ts` — extend com casos pra as 3 keys novas (required-ness + bounds).
- `core/.env.example` — adiciona doc das 3 keys.
- `core/src/store/secrets.ts` — adiciona `createSopsAgeSecretResolver` + `SopsAgeResolverConfig` interface + `SpawnFn` type (módulo-internal, não-exportado publicamente). **NÃO TOCA** `createStubSecretResolver`.
- `core/src/entrypoint-wiring.ts` — adiciona helper não-exportado `validateSopsAgeConfig` (§1.4) + adiciona `realSpawnWrapper` helper (~30 linhas) + em `buildBootDeps`, chama `validateSopsAgeConfig` antes de qualquer recurso, então swap `createStubSecretResolver` por `createSopsAgeSecretResolver`.
- `core/src/entrypoint-wiring.test.ts` — extend com 8 casos §4.4 (boot validation).
- `core/test/fakes/sops-cli.ts` (NOVO) — spawn fake compatível com `SpawnFn`.
- `core/src/store/secrets-sops-age.test.ts` (NOVO) — 11 casos §4.3.
- `core/src/reconciler/idempotency-property.test.ts` — extend com caso secret (harness injeta fake-spawn — §4.1).
- `deploy/runbook-secrets-go-live.md` (NOVO) — operator workflow §5 + systemd hardening + smoke test §4.5.
- `CHANGELOG.md` — entry minor version explicando o **breaking change** (config schema ganha 2 fields REQUIRED) com rationale CVE-class, não "feature".

Arquivos **EXPLICITAMENTE NÃO TOCADOS**:
- `core/src/server.ts` — zero mudança na DI factory (já recebe `secretResolver` via deps).
- `core/src/providers/docker.ts` — zero mudança no consumidor.
- `core/src/agent/rest.ts` — continua chamando `resolver.describe()` (metadata-only path, defendido por `rest.secrets.test.ts` invariantes). Interface unchanged. NÃO HÁ value path via REST.
- `core/src/agent/*` (resto) — zero mudança na agent surface.
- `core/src/reconciler/secret-apply.test.ts` — golden test PRESERVADO byte-identical.
- `core/src/store/secrets.test.ts` — testes do stub PRESERVADOS (stub continua exportado).

## 8. Risks & mitigations

| Risco | Mitigação |
|---|---|
| Daemon não sobe pós-deploy por config nova faltando | `core/.env.example` atualizado + runbook §5 + minor version bump documentado em CHANGELOG. |
| Operator perde a age key | `BACKUP IMEDIATO` é step obrigatório no runbook §5.1. Sem chave = secrets perdidos permanentemente (by design — é encryption). |
| Subprocess sops trava (e.g., aguardando stdin) | Timeout default 5s → SIGTERM → 200ms → SIGKILL. Configurable via `SECRETS_TIMEOUT_MS`. |
| sops binary versão divergente entre dev e prod | `sops --version` é assertado no boot validation step 4. Operador deve pin via apt/aqua/manage manual. Fora de escopo desta spec. |
| stderr do subprocess contém value plaintext (sops verbose bug?) | DESCARTADO antes de qualquer throw (defesa em profundidade — L5 + sentinel test §4.3 caso 8). |
| Race: 2 applies concorrentes resolvem mesmo ref ao mesmo tempo | Reconciler tem advisory lock per scope (ground rule). 2 applies concorrentes do mesmo scope são serializados. Mesmo se não fossem, sops file é read-only — 2 reads paralelos são safe. |
| sops file tampered/oversized OOMa o daemon | Buffer cap 64KB §1.5; reject + kill subprocess se exceeded (L9). Cap é generoso pra TLS certs PEM (~3KB) mas firme contra GB-sized adversarial input. |
| Buffer-de-resolve plaintext capturado via core dump / swap / heap snapshot | Hardening systemd no runbook §5.1: `LimitCORE=0`, `vm.swappiness=0`, `ProtectKernelTunables=yes`, `ProtectSystem=strict`, NUNCA `--heapsnapshot-near-heap-limit` no ExecStart. Defense-in-depth fora da spec do código. |
| `child.on('error')` payload contém filesystem path do binary | Wrapped em `ReconcileError("fatal", "secret resolve failed: <name>")` — nunca rethrown raw (§2.2). |
| age-plugin-* não encontrado em prod (mas presente em dev) | `HOME` incluído no env do subprocess (§3.1) — sops resolve plugins via `$HOME/bin` ou similar. Sem isso o erro seria opaco em prod. |

## 9. Acceptance criteria

- [ ] `npm --prefix core run typecheck` limpo.
- [ ] `npm --prefix core test` continua **897/898** verde (1 @live skipped). Soma os ~20 testes novos (11 sops-age + 8 boot validation no `entrypoint-wiring.test.ts` + 1 property extend) = **917/918** verde esperado.
- [ ] `core/src/reconciler/secret-apply.test.ts` passa byte-identical (golden preservado).
- [ ] `core/src/store/secrets.test.ts` passa byte-identical (stub preservado).
- [ ] `core/src/agent/rest.secrets.test.ts` passa byte-identical (REST `describe()` path preservado).
- [ ] Smoke test §4.5 passa contra o daemon real após restart.
- [ ] Nenhum sentinel `S3CR3T-*` / `fakecert-*` / `fakekey-*` em `core/src/**` non-test (leak-sentinel-auditor passa). Novos test files (sops-cli fake, secrets-sops-age.test.ts) que usem sentinel `S3CR3T-fake-leak-XYZ` devem estar allowlisted em `.gitleaks.toml`.
- [ ] `core/.env.example` documenta as 3 keys novas (paths absolutos, sem `~`).
- [ ] `CHANGELOG.md` tem entry minor version explicando o breaking change com rationale CVE-class (não "feature": secret resolver real fecha a leak surface antes esperando no stub).

## 10. Non-goals (YAGNI v1)

| Não-objetivo | Por quê não agora |
|---|---|
| Tool MCP `rotate_secret` / `set_secret` | Operator rotaciona via `sops` CLI + restart. MCP write tool exigiria nova capability + Approval Gate + StateEvent shape — outra spec. |
| Per-secret capability granularity | Hoje qualquer credential com `apply_manifest`/`deploy_service` resolve QUALQUER secret. Restrição por secret name é trabalho futuro acoplado a `capability.ts`. |
| `StateEvent` por resolve | Decisão Abordagem A. Apply event já registra actor. |
| Múltiplos arquivos sops | Single file. Multi-operator (multi-recipient) é suportado nativamente pelo sops via lista de age public keys no header — zero mudança no daemon. |
| Hot reload do sops file | Mudou? Restart daemon. Sem watcher, sem SIGHUP, sem inotify. |
| Cloud KMS / TPM / HSM | Pure file-based. v2/v3 work. |
| Boot-scan de manifests pra validar refs | Daemon não pré-scaneia desired state procurando refs sem value. Primeiro apply que precisar throw no resolve. |
| Tool `get_secret` / introspection de valor | Refs only via `describe(ref)`. Value resolution é provider-internal durante apply. Inspeção operator é via `sops` CLI direto. |
| Histórico/timeline "secret X foi rotacionado em Y" | Não rastreado. Operator mantém via git log do sops file (que é versionado). |
| Multi-tenant secret namespaces | Bevox é single-tenant (CLAUDE.md "Não-objetivos"). |
| Backward-compat com daemon que rodava sem `SECRETS_FILE` | Breaking change deliberado. Daemon não sobe sem as duas env vars novas. |

## 11. Decisões registradas

| Decisão | Escolhida | Recusadas | Razão |
|---|---|---|---|
| Backend criptográfico | sops + age | age puro, Vault, Postgres-encrypted | `sopsPath` já cabeçado no stub; sem daemon externo; encrypted-at-rest no git; multi-recipient nativo |
| Storage layout | Single sops file | 1 file/secret, file+index, Postgres | KISS; sops cifra cada value independentemente já (AES-GCM por value); 1 commit por mudança |
| Localização da age key | File 0600 no disco | Env var, Cloudflared, HSM | Convenção age padrão; isolamento do `.env`; Hetzner Cloud sem HSM acessível |
| Cache | On-demand sem cache | Boot-load em memória, per-ApplyContext | Posture máxima; ~30ms por resolve é negligível vs Docker pull/create |
| Integração sops | Subprocess binário | Library TS, age binário + parser custom | Pattern do repo (`HCloud via fetch`, `SSH via ssh client`); zero npm dep nova; trust no canonical binary |
| Boot behavior | Strict — fail-fast | Lazy fallback ao stub, audit per-resolve | Coerência com `AGENT_CREDENTIALS`/`HCLOUD_TOKEN`/`DATABASE_URL`; nada de split-brain |

## 12. Referências

- v1 spec FROZEN: [`2026-05-17-bevox-hetzner-mcp-design.md`](./2026-05-17-bevox-hetzner-mcp-design.md) §4.2 (secret resolution at apply only).
- Stub atual: `core/src/store/secrets.ts:218` (`createStubSecretResolver`, INERT por design v1).
- Golden test: `core/src/reconciler/secret-apply.test.ts` (preservar byte-identical).
- DI seam: `core/src/server.ts:454`, `core/src/entrypoint-wiring.ts:buildBootDeps`.
- Consumidor principal: `core/src/providers/docker.ts:420-427` (env injection no container).
- Ground rules: [`CONTRIBUTING.md`](../../CONTRIBUTING.md) §"Ground rules" #4 (secrets resolved at apply only) + `SECURITY.md` (sentinels).
- Motivação concreta: bevox-harness go-live spec §6.1 (`bevox-harness/docs/superpowers/specs/2026-05-28-go-live-via-hetzner-mcp.md`).
