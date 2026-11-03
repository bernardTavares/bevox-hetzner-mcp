# Real secret resolver v1 (sops+age) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Spec:** [`docs/specs/2026-05-28-secret-resolver-real-v1.md`](../../specs/2026-05-28-secret-resolver-real-v1.md)
(Status: Aceita 2026-05-28, commit `4cd8890`)
**Spec-mãe (v1 FROZEN):** [`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`](../../specs/2026-05-17-bevox-hetzner-mcp-design.md) §4.2
**Branch:** to be cut `feat/secret-resolver-sops-age` from `main`.
**Baseline:** suite ~990/992 verde (pós PR #25 — strict manifest approval knob shipped).

**Goal:** ao final, o daemon boota com um `createSopsAgeSecretResolver` real,
que spawn-a `sops` por resolve, decripta secrets on-demand a partir de um único
arquivo YAML (`SECRETS_FILE`) usando uma age key file (`SOPS_AGE_KEY_FILE`),
e fail-fasta value-free no boot quando qualquer pré-condição é violada. O stub
`createStubSecretResolver` continua exportado como test seam — boot prod
nunca o seleciona. Golden test (`secret-apply.test.ts`) preservado byte-identical.

**Architecture:** factory nova `createSopsAgeSecretResolver` em
`core/src/store/secrets.ts` que consome um `SpawnFn` injetável (módulo-internal
type). Produção passa um wrapper `realSpawnWrapper` (~30 linhas) sobre
`node:child_process.spawn`; testes passam o fake `core/test/fakes/sops-cli.ts`.
Helper boot validation não-exportado `validateSopsAgeConfig` em
`core/src/entrypoint-wiring.ts` executa 4 etapas sequenciais (file lstat × 2 +
perm/uid check + `sops --version` exit 0) antes de abrir qualquer recurso.
`buildBootDeps` swap-a `createStubSecretResolver` por `createSopsAgeSecretResolver`.
Zero mudança em `server.ts`, `providers/docker.ts`, `agent/rest.ts`,
`reconciler/secret-apply.test.ts`, `store/secrets.test.ts`.

**Tech Stack:** Node 20+, TypeScript 5.x (ESM/NodeNext, strict), `node:child_process`
(zero npm dep nova), Zod (config schema), Vitest + fakes. Subprocess sops chamado
com `shell:false`, env mínimo `{PATH, HOME, SOPS_AGE_KEY_FILE}`, Buffer cap
64 KB, SIGTERM → 200ms grace → SIGKILL no timeout.

---

## How this plan is executed

Tarefas numeradas `1.1 .. 7.1` em ordem TDD-canonical: foundation (spawn seam +
fake) → boot validation → resolver factory (1 caso por commit) → config →
wiring → property test → docs. Cada tarefa é um commit isolado red→green; a
ordem é gated (não dá pra implementar resolver sem fake; não dá pra fazer
wiring sem resolver). Tasks 7.x são docs (sem produção em `core/src/`, podem
sair pré-merge).

### Working agreement (all tasks)

- TDD, always: red → green → commit. Reference
  @superpowers:test-driven-development e `.claude/rules/tdd-required.md`.
- DRY / YAGNI / mudança mínima. Reference
  @superpowers:minimal-change-engineer.
- Frequent commits: one task = one commit. Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- @superpowers:verification-before-completion antes de qualquer "done".
- Tests **never** spawn real `sops` ou tocam disk em paths não-tmp.
  Boot validation tests passam `deps.fs` injetado + `deps.spawn` fake;
  resolver tests passam `config.spawn` fake. Live smoke (§4.5 da spec)
  é manual, post-merge, fora do CI.
- Sentinel `S3CR3T-fake-leak-XYZ` (e variantes `fakecert-*` / `fakekey-*`)
  só pode existir em test files allowlisted no `.gitleaks.toml`.
- StateEvent actor: N/A — resolver não emite event (decisão Abordagem A,
  spec §1.5 nota 6).
- No silent drift / no fail-deleting (já garantido — resolver é read-only).
- Steps usam `- [ ]` checkboxes. Marque ao concluir.

---

## Non-negotiable principles (carryover v1)

- Secrets resolved at apply only — `plan` / `dry_run` / logs / StateEvent /
  HTTP response NUNCA carregam value resolvido (CONTRIBUTING §"Ground rules" #4).
- ApplyContext token unforgeable é a única chave que destrava `resolve()` —
  resolver gate-checka via `isApplyContext(ctx)` antes de validar ref.
- Fail-safe, nunca fail-deleting — resolver é read-only por construção; boot
  validation apenas lê (`lstatSync`, `spawn sops --version`), nunca escreve.
- ESM/NodeNext + strict TS + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`
  (rules em `.claude/rules/esm-nodenext.md`).
- One responsibility per file — todo o resolver + `SpawnFn` type +
  `realSpawnWrapper` cabem em `core/src/store/secrets.ts` (estimado ~150 linhas
  adicionais; arquivo atual está ~264, fica abaixo do soft limit 600).

---

## Testing strategy

| Layer | How | What it covers |
|---|---|---|
| Unit — resolver | `core/src/store/secrets-sops-age.test.ts` (NEW) com `core/test/fakes/sops-cli.ts` injetado via `config.spawn` | 11 casos spec §4.3 (gate, ref, happy, stderr-on-success, newline preservation, exit ≠ 0, timeout SIGTERM/SIGKILL, child.on('error'), sentinel-not-in-error, env hygiene, args form, 64 KB cap) |
| Unit — boot validation | `core/src/entrypoint-wiring.test.ts` (EXTEND) com `deps.fs` + `deps.spawn` fakes | 8 casos spec §4.4 (4 fail paths + symlink rejection + uid rejection + sops ENOENT + happy path) |
| Unit — config | `core/src/config.test.ts` (EXTEND) | `SECRETS_FILE`/`SOPS_AGE_KEY_FILE` requiredness; `SECRETS_TIMEOUT_MS` bounds [1000, 60000] + default 5000 |
| Unit — fake self-test | `core/test/fakes/sops-cli.test.ts` (NEW) | Fake honra contract `SpawnFn` (resolve order, kill behavior, stderr/stdout buffers) |
| Property — idempotency | `core/src/reconciler/idempotency.property.test.ts` (EXTEND) — note: file canon name é `idempotency.property.test.ts`, não `idempotency-property.test.ts` (divergência §4.1 spec — usar nome real) | 2x apply de service com `secret:<ref>` env → cycle 2 plan.ops == []; harness injeta `createSopsAgeSecretResolver({spawn: fakeSpawn})` |
| Golden (preservado) | `core/src/reconciler/secret-apply.test.ts` | NÃO TOCADO — byte-identical |
| Live (manual) | spec §4.5 smoke test (runbook `deploy/runbook-secrets-go-live.md`) | Pré-tag manual; nunca em CI |

---

## FROZEN CONTRACT — interface preserved

- `SecretResolver` interface (em `core/src/store/secrets.ts`): UNCHANGED. Resolver
  novo implementa a mesma shape; consumers (`providers/docker.ts:420-427`,
  `agent/rest.ts`) nunca mudam.
- `SecretResolveResult` discriminated union: UNCHANGED. Resolver real nunca
  retorna `{status: "deferred"}` (esse era pattern do stub); retorna `{status: "ok", name, value}` ou throw `ReconcileError`.
- `ApplyContext` brand: UNCHANGED. `isApplyContext` gate é primeira ação no `resolve()`.

---

## File structure (one responsibility per file)

```
core/
├── src/
│   ├── config.ts                                   MODIFIED  (3 keys novas + intKnob estende max)
│   ├── config.test.ts                              MODIFIED  (3 casos)
│   ├── entrypoint-wiring.ts                        MODIFIED  (validateSopsAgeConfig + realSpawnWrapper + swap)
│   ├── entrypoint-wiring.test.ts                   MODIFIED  (8 casos boot validation)
│   ├── store/
│   │   ├── secrets.ts                              MODIFIED  (createSopsAgeSecretResolver + SpawnFn + SopsAgeResolverConfig)
│   │   ├── secrets.test.ts                         UNCHANGED (stub preservado)
│   │   └── secrets-sops-age.test.ts                NEW       (11 casos resolver)
│   └── reconciler/
│       ├── secret-apply.test.ts                    UNCHANGED (golden preservado byte-identical)
│       └── idempotency.property.test.ts            MODIFIED  (1 caso secret:<ref> end-to-end)
├── test/
│   └── fakes/
│       ├── sops-cli.ts                             NEW       (SpawnFn-shaped fake)
│       └── sops-cli.test.ts                        NEW       (fake self-test)
└── .env.example                                    MODIFIED  (3 keys novas com doc)

deploy/
└── runbook-secrets-go-live.md                      NEW       (operator workflow + systemd hardening + smoke test)

.gitleaks.toml                                      MODIFIED  (allowlist novos files com sentinel S3CR3T-fake-leak-XYZ)
```

**EXPLICITAMENTE NÃO TOCADO** (spec §7):
- `core/src/server.ts` — DI já recebe `secretResolver` via deps.
- `core/src/providers/docker.ts` — consumer unchanged.
- `core/src/agent/rest.ts` — `describe()` path preservado.
- `core/src/reconciler/secret-apply.test.ts` — golden byte-identical.
- `core/src/store/secrets.test.ts` — stub preservado.

---

# Task 1 — Spawn seam foundation (BLOCKING GATE)

**Goal/deliverable:** `SpawnFn` type + sops-cli fake + fake self-test verde,
sem nenhum consumer ainda. Toda a feature depende deste seam.

**Exit criteria:** `npm --prefix core test core/test/fakes/sops-cli.test.ts` green,
`npm --prefix core run typecheck` clean.

### Task 1.1 — `SpawnFn` type (module-internal) em `core/src/store/secrets.ts`

- Files: `core/src/store/secrets.ts`.
- [ ] Familiarise: re-read `core/src/store/secrets.ts` §1.2 da spec
      (linhas 75-127). Note que `SpawnFn` NÃO é exportado publicamente —
      apenas `SopsAgeResolverConfig` e a factory são.
- [ ] Failing test: este task é type-only (sem behavior). Salte direto
      pro Minimal impl + typecheck — `SpawnFn` será exercitado pelo
      Task 1.2 (fake) e Task 3.1+ (resolver).
- [ ] Minimal impl:
  - Adicionar `type SpawnFn = (cmd, args, opts) => { stdout, stderr, exitCode, kill }`
    conforme spec §1.2 (linhas 109-122), com JSDoc explicando
    `null → -1` coercion de exitCode e o NO-stdin invariant.
  - NÃO exportar `SpawnFn` publicamente (módulo-internal).
- [ ] Run `npm --prefix core run typecheck` → expect clean.
- [ ] Commit: `feat(core): SpawnFn module-internal type (1.1)`

### Task 1.2 — `core/test/fakes/sops-cli.ts` (sops fake)

- Files: `core/test/fakes/sops-cli.ts` (NEW), `core/test/fakes/sops-cli.test.ts` (NEW).
- [ ] Familiarise: read `core/test/fakes/hetzner-http.ts` (pattern de
      `create*Fake` retornando `{handler, state, reset}`).
- [ ] Failing test em `sops-cli.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { createSopsCliFake } from "./sops-cli.js";

  describe("sops-cli fake", () => {
    it("happy: configured exit + stdout + stderr resolve via SpawnFn shape", async () => {
      const fake = createSopsCliFake();
      fake.setResponse({ exitCode: 0, stdout: Buffer.from("abc"), stderr: Buffer.alloc(0) });
      const child = fake.spawn("sops", ["-d", "--extract", `["k"]`, "f.yaml"],
        { shell: false, env: { PATH: "/usr/bin" } });
      expect(await child.exitCode).toBe(0);
      expect((await child.stdout).toString("utf8")).toBe("abc");
      expect((await child.stderr).length).toBe(0);
    });
  });
  ```
- [ ] Run `npm --prefix core test core/test/fakes/sops-cli.test.ts` → expect FAIL
      (module not found).
- [ ] Minimal impl em `sops-cli.ts`:
  - Export `createSopsCliFake()` retornando `{ spawn: SpawnFn, setResponse, setTimeout, setSpawnError, callLog, reset }`.
  - `spawn(cmd, args, opts)` retorna `{ stdout, stderr, exitCode, kill }` Promises;
    `kill(signal)` resolve as Promises com `exitCode: -1`.
  - `setResponse({exitCode, stdout, stderr})` configura próximo call.
  - `setTimeout()` faz spawn never-resolve até `kill` ser chamado (cobertura caso 7).
  - `setSpawnError({code: "ENOENT"})` faz Promises rejeitarem com erro
    shaped como `child.on('error')` payload (cobertura caso 8 §4.3 + caso 7 §4.4).
  - `callLog` é `Array<{cmd, args, opts}>` pra assertions de caso 9/10.
  - **IMPORTANTE**: importar `SpawnFn` via type-only path interno?
    `SpawnFn` é module-internal em `secrets.ts` — duplicar a shape no fake
    como type local (NÃO importar de `secrets.ts` — manter encapsulation).
    JSDoc cita "shape compatível com SpawnFn em store/secrets.ts §1.2".
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): sops-cli SpawnFn-shaped fake (1.2)`

**Done (Task 1) =** spawn seam disponível em `secrets.ts` + fake disponível
em `test/fakes/sops-cli.ts`, com self-test verde. Sem consumer ainda.

---

# Task 2 — Boot validation (`validateSopsAgeConfig`)

**Goal/deliverable:** helper não-exportado `validateSopsAgeConfig` em
`entrypoint-wiring.ts` cobre 4 etapas spec §1.4. Não wireado ainda em
`buildBootDeps` (esse swap é Task 5.1).

**Exit criteria:** 8 casos novos em `entrypoint-wiring.test.ts` verde;
`npm --prefix core run typecheck` clean.

### Task 2.1 — `validateSopsAgeConfig` skeleton + happy path

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: read `core/src/entrypoint-wiring.ts:143-266` (`buildBootDeps`),
      e `entrypoint-wiring.test.ts` pattern de capturing-logger + injected seams.
- [ ] Failing test (caso §4.4 #8 — happy path):
  ```ts
  it("validateSopsAgeConfig: all preconditions ok → returns void", () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid()! },
      "/s/key":  { isFile: true, mode: 0o600, uid: process.getuid()! },
    });
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setResponse({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(() => validateSopsAgeConfig(
      { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
      { fs: fakeFs, spawn: fakeSpawn.spawn },
    )).not.toThrow();
  });
  ```
- [ ] Run `npm --prefix core test core/src/entrypoint-wiring.test.ts` → expect FAIL
      (`validateSopsAgeConfig` undefined).
- [ ] Minimal impl em `entrypoint-wiring.ts`:
  - Adicionar `function validateSopsAgeConfig(config, deps?): void` NÃO exportado.
  - Aceita opcional `deps.fs` (default `import("node:fs")`) e `deps.spawn`
    (default — a definir em Task 5.1; aqui aceita opcional).
  - Por enquanto: implementação retorna void sem fazer nada (smallest impl
    que faz happy path passar — etapas reais virão nas próximas tasks 2.2-2.5).
  - **NOTA**: a tarefa de tornar export de `validateSopsAgeConfig` testable
    cross-module fica via re-export from the test (não export from module).
    Pode ser via dynamic import + acesso a `__esModule.validateSopsAgeConfig`
    ou via export interno re-exposto só pro test seam — alinhe com o
    pattern existente no repo (read `strict-manifest-sensitivity.ts` se
    houver helper similar). Se não existir pattern: **exporte** o helper
    com prefixo `_validateSopsAgeConfig` (convenção "test-only" repo já usa
    em alguns pontos) e documente no JSDoc.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): validateSopsAgeConfig skeleton + happy path (2.1)`

### Task 2.2 — Etapa 1: `SECRETS_FILE` lstat (missing → fatal)

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Failing test (caso §4.4 #1):
  ```ts
  it("validateSopsAgeConfig: SECRETS_FILE missing → ReconcileError fatal", () => {
    const fakeFs = makeFakeFs({});  // empty — lstatSync throws ENOENT
    expect(() => validateSopsAgeConfig({ SECRETS_FILE: "/nope", SOPS_AGE_KEY_FILE: "/k" },
      { fs: fakeFs })).toThrow(/secrets file not found/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: etapa 1 — `fs.lstatSync(SECRETS_FILE).isFile()`; else
      `throw new ReconcileError("fatal", "secrets file not found", {entity: "config"})`.
      Catch `ENOENT` errno + isFile-false ambos resultam no mesmo throw.
      **L7 invariant**: usar `lstatSync` (não `statSync`) — rejeita symlinks.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): validateSopsAgeConfig step 1 SECRETS_FILE lstat (2.2)`

### Task 2.3 — Etapa 2: `SOPS_AGE_KEY_FILE` lstat (missing → fatal)

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Failing test (caso §4.4 #2):
  ```ts
  it("validateSopsAgeConfig: SOPS_AGE_KEY_FILE missing → fatal", () => {
    const fakeFs = makeFakeFs({ "/s/file": { isFile: true, mode: 0o644, uid: process.getuid()! } });
    expect(() => validateSopsAgeConfig({ SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/nope" },
      { fs: fakeFs })).toThrow(/age key file not found/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: etapa 2 — `fs.lstatSync(SOPS_AGE_KEY_FILE).isFile()`; else
      `throw new ReconcileError("fatal", "age key file not found", {entity: "config"})`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): validateSopsAgeConfig step 2 SOPS_AGE_KEY_FILE lstat (2.3)`

### Task 2.4 — Etapa 3: perm/uid check (defesa L7)

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Failing tests (3 casos §4.4 #3, #4, #5 em UM commit — todos cobrem
      mesma etapa, é 1 check com 2 conjunções):
  ```ts
  it("validateSopsAgeConfig: key file mode 0644 → fatal insecure perms", () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid()! },
      "/s/key":  { isFile: true, mode: 0o644, uid: process.getuid()! },  // group readable
    });
    expect(() => validateSopsAgeConfig({...}, {fs: fakeFs}))
      .toThrow(/age key file has insecure permissions or ownership/);
  });

  it("validateSopsAgeConfig: key file owned by other uid → fatal", () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid()! },
      "/s/key":  { isFile: true, mode: 0o600, uid: (process.getuid()! + 1) },
    });
    expect(() => validateSopsAgeConfig({...}, {fs: fakeFs}))
      .toThrow(/age key file has insecure permissions or ownership/);
  });

  it("validateSopsAgeConfig: key file is symlink → fatal (lstat rejects)", () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid()! },
      "/s/key":  { isFile: false, isSymbolicLink: true, mode: 0o600, uid: process.getuid()! },
    });
    expect(() => validateSopsAgeConfig({...}, {fs: fakeFs}))
      .toThrow(/age key file not found/);  // step 2 já rejeita (isFile=false)
  });
  ```
- [ ] Run → expect FAIL nos 3.
- [ ] Minimal impl:
  - Etapa 3 — após etapa 2 passar: `const st = fs.lstatSync(SOPS_AGE_KEY_FILE)`;
    `if ((st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw ReconcileError fatal`.
  - Mensagem fixed-format conforme spec §1.4 e §4.4 caso 3.
  - **Cuidado L7**: NÃO usar `statSync` em etapa 2 nem aqui. `lstatSync`
    em etapa 2 já garante symlink rejection (isFile retorna false em symlink
    → step 2 fatal). Caso #5 cobre essa cascata.
  - Confirme que `fakeFs` retorna um objeto `{isFile(): boolean, mode, uid}`
    shape — extend `makeFakeFs` helper se necessário (em `entrypoint-wiring.test.ts`).
- [ ] Run → expect PASS nos 3.
- [ ] Commit: `feat(core): validateSopsAgeConfig step 3 perm+uid+symlink check L7 (2.4)`

### Task 2.5 — Etapa 4: `sops --version` exit 0

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Failing test (caso §4.4 #7):
  ```ts
  it("validateSopsAgeConfig: sops binary ENOENT → fatal sops binary not found", () => {
    const fakeFs = makeFakeFs({/* both files ok */});
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setSpawnError({ code: "ENOENT" });
    expect(() => validateSopsAgeConfig({...}, {fs: fakeFs, spawn: fakeSpawn.spawn}))
      .toThrow(/sops binary not found/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Etapa 4 — após etapa 3 passar: chama `spawn("sops", ["--version"],
    {shell: false, env: {PATH, HOME}})`. **NOTA**: como `validateSopsAgeConfig`
    é sync (signature `void`, não `Promise<void>`), e `SpawnFn` é async-shaped,
    há tensão de design aqui. **Decisão**: torne `validateSopsAgeConfig`
    async (`Promise<void>`) — caller em `buildBootDeps` faz `await`.
    Update Task 2.1 signature em consequência (return `Promise<void>` desde
    início, ajuste tests pra `await expect(...).rejects.toThrow`).
  - Espera `await child.exitCode === 0`; else throw ReconcileError fatal
    "sops binary not found". Catch também rejection do spawn (ENOENT).
  - Env: `{PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? ""}`.
- [ ] **REVISITAR** Tasks 2.1-2.4: mudar signature pra async + ajustar todos
      os tests pra `await expect().rejects.toThrow`. Este é o momento certo
      (custo de mudança ≤ custo de manter sync API que não consegue
      consumir SpawnFn).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): validateSopsAgeConfig step 4 sops --version (2.5)`

**Done (Task 2) =** `validateSopsAgeConfig(config, deps)` async helper
não-exportado em `entrypoint-wiring.ts` cobre 4 etapas spec §1.4 com 8
casos verdes em `entrypoint-wiring.test.ts`. NÃO wireado ainda.

---

# Task 3 — `createSopsAgeSecretResolver` factory

**Goal/deliverable:** factory completa em `core/src/store/secrets.ts`, 11
casos verdes em `secrets-sops-age.test.ts`. NÃO wireada ainda em
`buildBootDeps` (swap é Task 5.1).

**Exit criteria:** `npm --prefix core test core/src/store/secrets-sops-age.test.ts`
verde com 11 casos; `npm --prefix core test core/src/store/secrets.test.ts`
PRESERVADO (stub byte-identical); `npm --prefix core run typecheck` clean.

### Task 3.1 — Gate `isApplyContext(ctx)` (caso §4.3 #1)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts` (NEW).
- [ ] Familiarise: read `core/src/store/secrets.ts:218-263` (stub pattern de
      gate-first + requireRef). Re-read spec §1.2 (interface) e §4.3 caso 1.
- [ ] Failing test:
  ```ts
  import { describe, it, expect } from "vitest";
  import { createSopsAgeSecretResolver } from "./secrets.js";
  import { createSopsCliFake } from "../../test/fakes/sops-cli.js";

  describe("createSopsAgeSecretResolver", () => {
    it("refuses forged ctx → fatal, spawn never called", async () => {
      const fake = createSopsCliFake();
      const r = createSopsAgeSecretResolver({
        secretsFile: "/s/file", ageKeyFile: "/s/key", spawn: fake.spawn,
      });
      await expect(r.resolve("secret:foo", {} as any)).rejects.toThrow(/secret resolve refused/);
      expect(fake.callLog).toHaveLength(0);
    });
  });
  ```
- [ ] Run → expect FAIL (`createSopsAgeSecretResolver` undefined).
- [ ] Minimal impl em `secrets.ts`:
  - Adicionar `interface SopsAgeResolverConfig` (exportada) conforme spec §1.2.
  - Adicionar `function createSopsAgeSecretResolver(config): SecretResolver`.
  - Implementar APENAS gate `isApplyContext(ctx)` + throw fatal (mesmo
    pattern do stub linha 244-251). `describe(ref)` pode retornar igual
    ao stub por ora (caso 2 nas próximas tasks valida).
  - `resolve` não chama `config.spawn` ainda — só throw após gate.
- [ ] Run → expect PASS. Confirme `fake.callLog` length 0.
- [ ] Commit: `feat(core): sops-age resolver gate isApplyContext (3.1)`

### Task 3.2 — Ref validation (caso §4.3 #2)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("real ctx + malformed ref → precondition, spawn never called", async () => {
    const fake = createSopsCliFake();
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    await expect(r.resolve("not-a-ref", createApplyContext())).rejects.toThrow(/secret ref invalid/);
    expect(fake.callLog).toHaveLength(0);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: após gate, chamar `requireRef(ref)` existente — herda
      "precondition" throw. spawn não chamado.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver ref validation (3.2)`

### Task 3.3 — Happy path: spawn + stdout → value (caso §4.3 #3)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("happy: exit 0 + stdout 'abc' → {status: ok, name, value: 'abc'}", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("abc"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:openai-api-key", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "openai-api-key", value: "abc" });
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Após `requireRef`, chama `config.spawn("sops" || config.sopsBinary, args, opts)`.
  - `args = ["-d", "--extract", `["${name}"]`, "--output-type", "binary", config.secretsFile]`.
  - `opts = {shell: false, env: {PATH, HOME, SOPS_AGE_KEY_FILE: config.ageKeyFile}}`.
  - `await child.stdout` → Buffer → `.toString("utf8")` → value.
  - `await child.exitCode === 0` → return `{status: "ok", name, value}`.
  - Por enquanto NÃO trate exit ≠ 0 (próxima task), NÃO trate timeout
    (Task 3.7), NÃO trate Buffer cap (Task 3.11).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver happy path spawn+stdout (3.3)`

### Task 3.4 — Exit ≠ 0 → fatal (caso §4.3 #6)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("exit 1 → fatal 'secret resolve failed: <name>', stderr discarded", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 1, stdout: Buffer.alloc(0),
                       stderr: Buffer.from("sops: file not found S3CR3T-fake-leak-XYZ") });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try { await r.resolve("secret:k", createApplyContext()); } catch (e) { captured = e as Error; }
    expect(captured?.message).toMatch(/secret resolve failed: k/);
    expect(captured?.message).not.toMatch(/S3CR3T-fake-leak-XYZ/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Após `await child.exitCode`, branch `if (code !== 0) throw new ReconcileError("fatal", "secret resolve failed: " + name, {entity: "secret"})`.
  - stderr Buffer NUNCA referenciado em throw nem logger.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver exit non-zero fatal (3.4)`

### Task 3.5 — Newline preservation (caso §4.3 #5 — footgun S5)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("PEM-like value with internal+trailing newlines → byte-identical", async () => {
    const pem = "-----BEGIN-----\nABC\nDEF\n-----END-----\n";
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from(pem), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:tls-key", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "tls-key", value: pem });  // trailing \n preserved
  });
  ```
- [ ] Run → expect (might already PASS depending on Task 3.3 impl — see below).
- [ ] Minimal impl:
  - **Se já passou em 3.3**: este task vira test-only (add o test, run, commit
    como `test(core): assert newline preservation in resolver (3.5)`).
  - **Se falhou**: garanta que `stdout.toString("utf8")` é return AS-IS — sem
    `.replace(/\n$/, "")`, sem `.trim()`. Add comment NO-TRIM no código
    citando spec §1.5 (footgun S5).
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): sops-age resolver newline preservation (3.5)`

### Task 3.6 — stderr-on-success ignored (caso §4.3 #4)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("exit 0 + non-empty stderr (sops warning) → still {status: ok}", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("abc"),
                       stderr: Buffer.from("warning: deprecated cipher") });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:k", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "k", value: "abc" });
  });
  ```
- [ ] Run → expect PASS (Task 3.3 impl already exit-code-only).
- [ ] Commit: `test(core): sops-age resolver exit-code-only decision (3.6)`

### Task 3.7 — Timeout SIGTERM → 200ms → SIGKILL (caso §4.3 #7)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("timeout: SIGTERM, 200ms grace, SIGKILL, exitCode coerced to -1", async () => {
    const fake = createSopsCliFake();
    fake.setTimeout();  // never resolves until killed
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn, timeoutMs: 50 });
    let captured: Error | null = null;
    try { await r.resolve("secret:slow", createApplyContext()); } catch (e) { captured = e as Error; }
    expect(captured?.message).toMatch(/secret resolve timeout: slow/);
    expect(fake.lastKillSignals).toEqual(["SIGTERM", "SIGKILL"]);  // ambos enviados
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Wrappa `await child.exitCode` em `Promise.race` com timer
    `setTimeout(timeoutMs ?? 5000)`.
  - Timer fires: `child.kill("SIGTERM")`, espera 200ms, `child.kill("SIGKILL")`,
    throw `ReconcileError("fatal", "secret resolve timeout: " + name)`.
  - Garantir cleanup do timer no happy path (`clearTimeout`).
  - Extender `sops-cli` fake pra registrar `lastKillSignals: NodeJS.Signals[]`.
    Se o fake já registra via Task 1.2 ótimo; senão extend numa sub-edição
    do fake (mesmo commit é ok porque é mudança puramente test-fixture).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver timeout SIGTERM→SIGKILL (3.7)`

### Task 3.8 — `child.on('error')` wrapping (caso §4.3 #8)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("spawn error (ENOENT) is wrapped, never rethrown raw with path", async () => {
    const fake = createSopsCliFake();
    fake.setSpawnError({ code: "ENOENT", message: "spawn /usr/bin/sops ENOENT" });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try { await r.resolve("secret:k", createApplyContext()); } catch (e) { captured = e as Error; }
    expect(captured?.message).toBe("secret resolve failed: k");  // no /usr/bin/sops leak
    expect(captured?.message).not.toMatch(/ENOENT|usr|bin|sops/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Wrappar TODO o `try` do spawn em `try {...} catch (err) { throw new ReconcileError("fatal", "secret resolve failed: " + name, {entity: "secret"}) }`.
  - O upstream `err` NÃO vai em `.cause` (ou se for, garantir que cause
    não exposed via `.toString()` / `.message` — verificar `ReconcileError`
    constructor signature em `core/src/domain/errors.ts`).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver child.on('error') wrap L5 (3.8)`

### Task 3.9 — Sentinel-in-stderr never in error message (caso §4.3 #8 reinforço L5)

- Files: `core/src/store/secrets-sops-age.test.ts`.
- [ ] Familiarise: confirme que Task 3.4 já testa `S3CR3T-fake-leak-XYZ` not in
      error message no exit-≠-0 path. Este task amplia: testa também no
      timeout path e no spawn-error path. Se já coberto, vira teste de
      reinforço (não-trivial).
- [ ] Failing test:
  ```ts
  it("L5: sentinel S3CR3T-fake-leak-XYZ in stderr/error path never appears in any thrown message", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 1, stdout: Buffer.alloc(0),
                       stderr: Buffer.from("S3CR3T-fake-leak-XYZ") });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try { await r.resolve("secret:k", createApplyContext()); } catch (e) { captured = e as Error; }
    expect(JSON.stringify(captured)).not.toMatch(/S3CR3T/);  // não em .message, não em .cause
  });
  ```
- [ ] Run → expect (provavelmente PASS dado Task 3.4 + 3.8).
- [ ] Confirme: este test pode demandar adicionar `S3CR3T-fake-leak-XYZ` ao
      allowlist em `.gitleaks.toml` se o sentinel é literal no test file.
      Se não-allowlisted, leak-sentinel-auditor bloqueia. Mesmo commit pode
      incluir a edit do `.gitleaks.toml` (single concern: introdução do test
      sentinel).
- [ ] Commit: `test(core): sops-age resolver L5 sentinel never leaks (3.9)`

### Task 3.10 — Env hygiene (caso §4.3 #9 — defesa L8)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("subprocess env keys === {PATH, HOME, SOPS_AGE_KEY_FILE} exact", async () => {
    process.env.AGENT_CREDENTIALS = "must-not-leak";
    process.env.HCLOUD_TOKEN = "must-not-leak";
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    await r.resolve("secret:k", createApplyContext());
    const call = fake.callLog[0]!;
    expect(Object.keys(call.opts.env).sort()).toEqual(["HOME", "PATH", "SOPS_AGE_KEY_FILE"]);
    expect(call.opts.env).not.toHaveProperty("AGENT_CREDENTIALS");
    expect(call.opts.env).not.toHaveProperty("HCLOUD_TOKEN");
  });
  ```
- [ ] Run → expect (provavelmente PASS dado Task 3.3 já passa `env` explícito).
      Se falhou: ajustar `opts.env` em Task 3.3 impl pra ser literal-object
      com SÓ as 3 keys (não spread `process.env`).
- [ ] Commit: `test(core): sops-age resolver env hygiene L8 (3.10)`

### Task 3.11 — Args form (caso §4.3 #10 — defesa L8 / footgun JSON.stringify)

- Files: `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("args form: --extract template literal verbatim, NOT JSON.stringify", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({
      secretsFile: "/path/to/secrets.yaml", ageKeyFile: "/path/to/age.key", spawn: fake.spawn,
    });
    await r.resolve("secret:openai-api-key", createApplyContext());
    const call = fake.callLog[0]!;
    expect(call.args).toEqual([
      "-d", "--extract", `["openai-api-key"]`, "--output-type", "binary",
      "/path/to/secrets.yaml",
    ]);
    expect(call.args[2]).not.toMatch(/^\\"/);  // not JSON.stringify-wrapped
    expect(call.opts.shell).toBe(false);
  });
  ```
- [ ] Run → expect PASS (Task 3.3 impl deve já estar correto).
- [ ] Commit: `test(core): sops-age resolver args form template literal (3.11)`

### Task 3.12 — Buffer cap 64 KB (caso §4.3 #11 — defesa L9)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Failing test:
  ```ts
  it("stdout > 64 KB → kill + fatal 'oversized'", async () => {
    const oversized = Buffer.alloc(65 * 1024, 0x41);  // 65 KB of 'A'
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: oversized, stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try { await r.resolve("secret:big", createApplyContext()); } catch (e) { captured = e as Error; }
    expect(captured?.message).toMatch(/secret resolve oversized: big/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Após coletar `stdoutBuffer`, check `stdoutBuffer.length > 64 * 1024`.
  - Se sim: `child.kill("SIGTERM")` (best-effort cleanup), throw
    `ReconcileError("fatal", "secret resolve oversized: " + name)`.
  - **Decisão de implementação**: o fake atual provavelmente entrega o Buffer
    inteiro em `child.stdout` (Promise<Buffer>). A cap-check é simples
    `if (buf.length > CAP)`. Mas a produção real (`realSpawnWrapper` em
    Task 4.1) precisa cap STREAMING — somar chunks até passar 64 KB e
    então kill+abort. Documente no JSDoc da factory que essa diferença é
    intencional: o test exercita a guarda do `length > cap`; o wrapper
    real exerce a mesma guarda incrementalmente.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): sops-age resolver Buffer cap 64KB L9 (3.12)`

**Done (Task 3) =** factory `createSopsAgeSecretResolver` completa, 11
casos verdes em `secrets-sops-age.test.ts`. NÃO wireada ainda em
`buildBootDeps`. Stub (`createStubSecretResolver`) preservado, byte-identical.

---

# Task 4 — `realSpawnWrapper` (production-side seam)

**Goal/deliverable:** wrapper `realSpawnWrapper` (~30 linhas) em
`core/src/store/secrets.ts` (mesma file, módulo-interno) que adapta
`node:child_process.spawn` à shape `SpawnFn`. Usado como default quando
`config.spawn` é omitido.

**Exit criteria:** 2 casos de cobertura streaming + `null → -1` coercion
verdes em `secrets-sops-age.test.ts`; `npm --prefix core run typecheck` clean.

### Task 4.1 — `realSpawnWrapper` (production seam)

- Files: `core/src/store/secrets.ts`, `core/src/store/secrets-sops-age.test.ts`.
- [ ] Familiarise: read MDN/Node docs sobre `child_process.spawn` event model
      (`on('exit', code|null)`, `on('error')`, `stdout.on('data')`,
      `stdout.on('end')`).
- [ ] Failing test (this is the tricky bit — testing the wrapper requires
      a way to inject without spawning real sops. Solução:
      `realSpawnWrapper` é exportado **internamente** (`export` mas not
      part of public API; doc'd as test-only). O test spawn-a `node -e`
      pra rodar um echo determinístico):
  ```ts
  it("realSpawnWrapper: spawns child, resolves stdout/stderr/exitCode", async () => {
    const child = realSpawnWrapper("node", ["-e", "process.stdout.write('hi'); process.exit(7)"],
      { shell: false, env: { PATH: process.env.PATH ?? "" } });
    expect((await child.stdout).toString("utf8")).toBe("hi");
    expect(await child.exitCode).toBe(7);
  });

  it("realSpawnWrapper: signal-killed child resolves exitCode as -1, not null", async () => {
    const child = realSpawnWrapper("node", ["-e", "setInterval(()=>{}, 1000)"],
      { shell: false, env: { PATH: process.env.PATH ?? "" } });
    setTimeout(() => child.kill("SIGTERM"), 50);
    expect(await child.exitCode).toBe(-1);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - `function realSpawnWrapper(cmd, args, opts): ReturnType<SpawnFn>`.
  - Internally `const cp = require("node:child_process").spawn(cmd, args, opts)`.
  - Collect `cp.stdout` data into `Buffer[]`, resolve on `'end'`.
  - Same pra stderr.
  - `exitCode` Promise resolves on `cp.on('exit', (code) => code ?? -1)` ou
    `cp.on('error', () => -1)`.
  - `kill(signal = "SIGTERM"): void` chama `cp.kill(signal)`.
- [ ] Run → expect PASS. **NOTA**: estes 2 tests spawn-am `node` real
      (mini-subprocess), o que é diferente de "spawn sops real" — node
      sempre está disponível em CI, e o test não toca disk/network/sops.
      Justificativa para não violar "fakes only": o seam testado AQUI é
      o adapter `node:child_process.spawn → SpawnFn`; testá-lo com fake
      é circular. Mesma justificativa que existe pra `pg-harness` (que
      sobe Postgres real em CI).
- [ ] Commit: `feat(core): realSpawnWrapper production spawn adapter (4.1)`

**Done (Task 4) =** `realSpawnWrapper` disponível em `secrets.ts`; factory
`createSopsAgeSecretResolver` usa `config.spawn ?? realSpawnWrapper` como
default.

---

# Task 5 — Config + wiring

**Goal/deliverable:** 3 keys novas em `ConfigSchema`, `intKnob` estendido,
`buildBootDeps` chama `validateSopsAgeConfig` então swap stub→sops-age.

**Exit criteria:** `npm --prefix core test` cobre suite completa verde
(~+20 tests vs baseline); `npm --prefix core run typecheck` clean.

### Task 5.1 — `intKnob` estende max bound

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Familiarise: read `core/src/config.ts:66-72` (`intKnob` atual,
      `(def, min)` signature).
- [ ] Failing test em `config.test.ts`:
  ```ts
  it("intKnob enforces max bound (when provided)", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(() => schema.parse({ X: "70000" })).toThrow(/X/);
    expect(schema.parse({ X: "5000" })).toEqual({ X: 5000 });
    expect(schema.parse({})).toEqual({ X: 5000 });  // default preserved
  });
  ```
- [ ] Run → expect FAIL (max not enforced).
- [ ] Minimal impl: estende signature pra `intKnob(def, min, max?)`. Quando
      max provided: `z.number().int().min(min).max(max).optional()`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): intKnob optional max bound (5.1)`

### Task 5.2 — 3 keys novas em ConfigSchema

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Failing test:
  ```ts
  it("ConfigSchema requires SECRETS_FILE", () => {
    const env = { ...baselineEnv };
    delete env.SECRETS_FILE;
    expect(() => loadConfig(env)).toThrow(/SECRETS_FILE/);
  });

  it("ConfigSchema requires SOPS_AGE_KEY_FILE", () => {
    const env = { ...baselineEnv };
    delete env.SOPS_AGE_KEY_FILE;
    expect(() => loadConfig(env)).toThrow(/SOPS_AGE_KEY_FILE/);
  });

  it("ConfigSchema: SECRETS_TIMEOUT_MS default 5000, bounded [1000, 60000]", () => {
    expect(loadConfig({ ...baselineEnv }).SECRETS_TIMEOUT_MS).toBe(5000);
    expect(loadConfig({ ...baselineEnv, SECRETS_TIMEOUT_MS: "10000" }).SECRETS_TIMEOUT_MS).toBe(10000);
    expect(() => loadConfig({ ...baselineEnv, SECRETS_TIMEOUT_MS: "500" })).toThrow();
    expect(() => loadConfig({ ...baselineEnv, SECRETS_TIMEOUT_MS: "70000" })).toThrow();
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: append a `ConfigSchema`:
  ```ts
  SECRETS_FILE: requiredSecret("SECRETS_FILE"),
  SOPS_AGE_KEY_FILE: requiredSecret("SOPS_AGE_KEY_FILE"),
  SECRETS_TIMEOUT_MS: intKnob(5000, 1000, 60000),
  ```
- [ ] Atualizar `baselineEnv` helper de teste (se existir) pra incluir as
      2 keys novas — outros tests do `config.test.ts` continuarão verdes
      sem alteração lógica.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): ConfigSchema SECRETS_FILE/KEY_FILE/TIMEOUT_MS (5.2)`

### Task 5.3 — `buildBootDeps` swap stub → sops-age + validate

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: read `buildBootDeps` linhas 143-266; note que
      `secretResolver` NÃO aparece no return atual (passa default no
      `server.ts:454`). Pra wirear daqui, precisamos adicionar
      `secretResolver` ao return + ao `BootDeps` type em `server.ts`.
- [ ] **CHECK FIRST**: ler `core/src/server.ts:440-470` pra confirmar se
      `BootDeps` já tem opcional `secretResolver?: SecretResolver`. Spec
      §1.1 afirma "DI já recebe `secretResolver` via `deps` em
      `createServer(config, deps)`" — confirme. Se não — esta task
      ganha um passo de "add to BootDeps type" (mínima mudança em
      server.ts), o que CONTRADIZ spec §7 ("server.ts EXPLICITAMENTE
      NÃO TOCADO"). **Resolução de conflito**: priorize execução do
      plano; se BootDeps NÃO tem o field, registre como divergência da
      spec (necessária pra wireamento real) e atualize em mínima mudança
      (1-line type field). Documente no commit body.
- [ ] Failing test:
  ```ts
  it("buildBootDeps: wires sops-age resolver and calls validate before resources", async () => {
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setResponse({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const fakeFs = makeFakeFs({/* both files ok */});
    const deps = await buildBootDeps(config, transports, {
      fs: fakeFs, spawn: fakeSpawn.spawn,  // boot validation seams
    });
    expect(deps.secretResolver).toBeDefined();
    expect(typeof deps.secretResolver!.resolve).toBe("function");
  });

  it("buildBootDeps: validate failure aborts before opening providers", async () => {
    const fakeFs = makeFakeFs({});  // SECRETS_FILE missing
    await expect(buildBootDeps(config, transports, { fs: fakeFs })).rejects.toThrow(/secrets file not found/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl em `entrypoint-wiring.ts`:
  - Extender `BuildOptions` com `fs?` e `spawn?` opcionais (test-only seams).
  - `buildBootDeps` se torna `async`. Em primeiro statement (antes de qualquer
    HttpClient/createDesiredStateSeam): `await validateSopsAgeConfig(config, {fs: opts.fs, spawn: opts.spawn})`.
  - Após validate ok, instanciar:
    `const secretResolver = createSopsAgeSecretResolver({
       secretsFile: config.SECRETS_FILE,
       ageKeyFile: config.SOPS_AGE_KEY_FILE,
       timeoutMs: config.SECRETS_TIMEOUT_MS,
       spawn: opts.spawn,  // tests override; prod undefined → realSpawnWrapper
     })`.
  - Add `secretResolver` ao return.
  - **NÃO** remover `createStubSecretResolver` import / export — stub
    permanece exportado como test seam (spec §0.6).
  - `runMain` precisa `await buildBootDeps(...)` agora — atualizar
    consequentemente.
- [ ] **MUDANÇA EM `server.ts`** (se necessária): adicionar
      `secretResolver?: SecretResolver` ao `BootDeps` interface; em
      `createServer`, usar `deps.secretResolver ?? createStubSecretResolver()`
      como fallback (preserva compat com tests). **Esta linha É
      ABSOLUTAMENTE A ÚNICA MUDANÇA EM `server.ts`** — citar spec §7 no
      commit body explicando o necessário-mas-mínimo desvio.
- [ ] Run → expect PASS.
- [ ] Run full suite: `npm --prefix core test` → esperar ~+20 tests, golden
      preservado, stub preservado.
- [ ] Commit: `feat(core): buildBootDeps async + sops-age wire + validate (5.3)`

**Done (Task 5) =** daemon boota com resolver real. Suite full verde.

---

# Task 6 — Property test extension

**Goal/deliverable:** caso novo em `idempotency.property.test.ts` exercita
service com `secret:<ref>` env apply 2x → cycle 2 plan.ops == [].

**Exit criteria:** property test verde com harness injetando
`createSopsAgeSecretResolver({spawn: fakeSpawn})`.

### Task 6.1 — Property: secret:<ref> 2x apply zero drift

- Files: `core/src/reconciler/idempotency.property.test.ts`.
- [ ] Familiarise: read `core/src/reconciler/idempotency.property.test.ts`
      atual — entender o harness de fast-check + a forma como service
      manifests são gerados + onde o `secretResolver` é injetado no
      `createServer`/test setup.
- [ ] Failing test (adicionar arbitrary que gera service com env
      `{KEY: "secret:<refname>"}`, e que setupa fakeSpawn pra retornar
      o value correspondente). O property:
  ```ts
  property("service with secret:<ref> env: 2x apply → 0 drift in cycle 2", async () => {
    await fc.assert(fc.asyncProperty(arbServiceWithSecretEnv(), async (manifest) => {
      const fakeSpawn = createSopsCliFake();
      fakeSpawn.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
      const harness = await makeReconcileHarness({
        secretResolver: createSopsAgeSecretResolver({...cfg, spawn: fakeSpawn.spawn}),
      });
      await harness.applyManifest(manifest);
      const cycle2 = await harness.observePlan();
      expect(cycle2.ops).toHaveLength(0);
    }));
  });
  ```
- [ ] Run → expect FAIL (provavelmente — depende do estado atual do
      property test e do harness).
- [ ] Minimal impl:
  - Adicionar `arbServiceWithSecretEnv` arbitrary.
  - Ajustar harness pra aceitar `secretResolver` override (se ainda não
    aceita).
  - **CRÍTICO** (spec §4.1): a harness DEVE injetar fake-spawn — sem
    spawn real. Confirme via `fakeSpawn.callLog.length > 0` no asserção.
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): idempotency property covers secret:<ref> env (6.1)`

**Done (Task 6) =** invariante de idempotência cobre o fluxo secret-resolve;
2x apply do mesmo manifest com `secret:<ref>` não emite mutating action no
cycle 2.

---

# Task 7 — Docs

**Goal/deliverable:** `core/.env.example` + runbook + CHANGELOG documentam
o breaking change + operator workflow + smoke test §4.5.

**Exit criteria:** docs revisáveis; sem prod code em `core/src/` mudando.

### Task 7.1 — `core/.env.example` + runbook + CHANGELOG

- Files: `core/.env.example`, `deploy/runbook-secrets-go-live.md` (NEW),
  `CHANGELOG.md` (NEW or extend; check repo root — se inexistente, criar
  via convenção Keep-a-Changelog).
- [ ] Familiarise: read `core/.env.example` atual; read `deploy/README.md`
      pra voice/tom do runbook.
- [ ] Doc edits (sem failing test — esta é doc-only task; verification é
      "review the rendered markdown"):
  - `core/.env.example` ganha 3 blocos comentados conforme spec §1.3
    (linhas 152-163).
  - `deploy/runbook-secrets-go-live.md` (NEW) — conteúdo conforme spec §5
    (setup §5.1, edit §5.2, list §5.3, rotation §5.4) + smoke test §4.5
    + systemd hardening (§5.1 sub-block).
  - `CHANGELOG.md` — entry minor version (e.g. `## [Unreleased] / Added`)
    explicando o breaking change (config schema ganha 2 fields REQUIRED)
    + rationale CVE-class (não "feature" — stub deixava manifests com
    `secret:<ref>` em env unusable; resolver real fecha leak surface).
- [ ] Confirme: nenhuma menção a value real em runbook (`ABC123` no smoke
      test §4.5 é placeholder operacional, ok).
- [ ] Commit: `docs: sops-age secret resolver runbook + env.example + CHANGELOG (7.1)`

**Done (Task 7) =** docs entregues; operator pode seguir runbook
unassisted; CHANGELOG informa breaking change.

---

## Fora de escopo / depende de credenciais reais

Spec §10 lista non-goals YAGNI v1. Os principais aqui:

- MCP tool `rotate_secret` / `set_secret` — rotação via `sops` CLI + restart.
- Per-secret capability granularity — qualquer credential `apply_manifest`
  resolve qualquer secret hoje. Hardening pra outra spec.
- `StateEvent` per resolve — Abordagem A; apply event registra actor.
- Múltiplos arquivos sops, hot reload, KMS, multi-tenant — todos diferidos.
- Smoke test §4.5 contra daemon real — manual, post-merge, pré-tag.

## Done = (per task, summary)

- **Task 1:** `SpawnFn` type módulo-interno + `sops-cli` fake + fake self-test verde.
- **Task 2:** `validateSopsAgeConfig` async cobre 4 etapas + 8 casos verdes.
- **Task 3:** `createSopsAgeSecretResolver` cobre 11 casos verdes; stub preservado byte-identical.
- **Task 4:** `realSpawnWrapper` adapter `node:child_process.spawn → SpawnFn`.
- **Task 5:** `intKnob` estende max + 3 keys novas em ConfigSchema + `buildBootDeps` async wire-a sops-age + validate-first.
- **Task 6:** Property test cobre service-with-secret 2x apply zero drift.
- **Task 7:** `.env.example` + runbook + CHANGELOG.

**Suite expected:** ~990/992 baseline → ~1010/1012 verde (+11 sops-age + +8 boot + +3 config + +2 realSpawn + +1 fake + +1 property = +26 net; alguns Tasks viraram test-reinforço puro vs feature). Golden + stub byte-identical.

**Total: 7 tasks (sub-tasks 1.1, 1.2, 2.1-2.5, 3.1-3.12, 4.1, 5.1-5.3, 6.1, 7.1) = 24 commits.**
