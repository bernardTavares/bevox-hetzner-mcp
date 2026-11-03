# Console Operacional — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o Console Operacional interno (12 telas) do bevox-hetzner-mcp como casca humana sobre a Agent Interface REST, totalmente testado contra um fake server, sem lógica de negócio paralela.

**Architecture:** SPA que consome **apenas** a Agent Interface REST do core. Não há lógica de reconciliação/validação no frontend — toda escrita passa por `dry_run` e Approval Gate exatamente como um agente. Como o core REST (Fase 4) ainda não existe, o plano define primeiro o **contrato REST tipado** e um **fake server (MSW)** que o implementa; o console é construído e testado 100% contra o fake. A fiação ao core real é tarefa explícita da Fase 4 (fora deste plano).

**Portão de design:** antes de qualquer código de produção, a Task 1 entrega um **protótipo HTML estático clicável** (descartável, dados fake hardcoded) das 12 telas, navegável no browser, para aprovação humana explícita. Nenhuma tarefa de scaffold/implementação começa sem o "Aprovado" no protótipo. O protótipo congela o design comum; a implementação real (Tasks 7–18) deve reproduzi-lo.

**Tech Stack:** ✅ **Ratificado em 2026-05-17 (Bernard, Task 0):** **Vite + React 18 + TypeScript (ESM/NodeNext)**, React Router, TanStack Query, Zod (contratos compartilhados com o core), MSW (fake server), Vitest + Testing Library. Justificativa: console interno read/operate não precisa de SSR/RSC (YAGNI vs Next.js); SPA estática servida atrás do mesmo serviço REST é o menor caminho e alinha com Zod/Vitest já previstos no core.

**Escopo:** apenas o sub-pacote `console/`. Não toca core/reconciler/providers. A integração console↔core real é Fase 4 e **não** está neste plano.

---

## Pré-requisitos e contrato de fronteira

O console depende de uma API REST que **ainda não existe**. Este plano:

1. Define o **contrato REST** (`console/CONTRACT.md` + tipos Zod) derivado do catálogo de tools da spec (linhas 130-143).
2. Implementa um **fake server MSW** fiel a esse contrato (dry_run, pending_approval, erros estruturados `{code,message,retryable,entity}`, drift fail-safe).
3. Constrói o console contra o fake. Quando o core entregar a Fase 4, o contrato é o ponto de integração — fiar a base URL real é trabalho de outro plano.

Mapa tool → endpoint REST (todos `POST` exceto leituras `GET`):

| Tool (spec) | REST |
|---|---|
| `get_state` | `GET /api/state` |
| `diff` | `GET /api/diff?source=working\|git` |
| `events` | `GET /api/events?actor=&entity=&result=` |
| `health` | `GET /api/health` |
| `provision_server` | `POST /api/servers` (`dry_run` no body) |
| `deploy_service` | `POST /api/services` |
| `scale_service` | `POST /api/services/:name/scale` |
| `set_dns` | `POST /api/dns` |
| `snapshot` | `POST /api/backups/:target/snapshot` |
| `restore` | `POST /api/backups/:target/restore` |
| `destroy` | `POST /api/destroy` |
| `apply_manifest` | `POST /api/apply` |
| (approvals espelho) | `GET /api/approvals`, `POST /api/approvals/:id/{approve,reject}` |

Toda resposta de escrita segue o envelope da spec: `{status: "planned"|"pending_approval"|"applied"|"error", plan?, approval_id?, error?}`.

---

## File Structure

```
console/
  package.json                       # sub-pacote, scripts dev/build/test
  vite.config.ts
  tsconfig.json
  index.html
  CONTRACT.md                        # contrato REST canônico (fronteira p/ Fase 4)
  src/
    main.tsx                         # bootstrap React
    app.tsx                          # router + layout shell
    api/
      contract.ts                    # schemas Zod de TODAS as entidades + envelopes
      client.ts                      # client REST tipado (fetch + parse Zod)
      query.ts                       # hooks TanStack Query por endpoint
    api/__fakes__/
      handlers.ts                    # MSW handlers implementando CONTRACT.md
      fixtures.ts                    # estado fake (stack Bevox de exemplo)
      browser.ts                     # worker MSW p/ dev
      server.ts                      # server MSW p/ testes
    components/
      Layout.tsx                     # nav + header (agent atual)
      StatusBadge.tsx                # enum pending|applying|healthy|degraded|drift|error
      EntityTable.tsx                # tabela genérica reutilizável
      DiffView.tsx                   # render de plan/diff (op/entity/change/impact)
      ConfirmDestructive.tsx         # gate visual p/ ações destrutivas
    screens/
      Overview.tsx                   # Task 7
      EntityDetail.tsx               # Task 8
      PlanApply.tsx                  # Task 9
      Approvals.tsx                  # Task 10
      Events.tsx                     # Task 11
      Manifest.tsx                   # Task 12
      ProvisionServer.tsx            # Task 13 (wizard)
      Secrets.tsx                    # Task 14
      Backups.tsx                    # Task 15
      Network.tsx                    # Task 16
      Dns.tsx                        # Task 17
      Health.tsx                     # Task 18
  tests/
    setup.ts                         # MSW server + Testing Library
    contract.test.ts
    client.test.ts
    screens/*.test.tsx               # um por tela
    e2e-happy-path.test.tsx
```

Responsabilidade: `api/contract.ts` é a única fonte de tipos (espelha entidades da spec, linhas 75-83); telas nunca falam HTTP direto — só via `api/query.ts`; componentes em `components/` são burros e reutilizáveis.

---

## Task 0: Ratificação de stack

**Files:**
- Modify: este plano (registrar decisão)

- [x] **Step 1: Confirmar stack com o humano**

✅ **2026-05-17:** Bernard ratificou a proposta integral (Vite + React 18 + TS + React Router + TanStack Query + Zod + MSW + Vitest/RTL). Decisão registrada no header **Tech Stack** acima. Task 0 concluída.

---

## Task 1: Protótipo de Design (HTML estático clicável) — PORTÃO DE APROVAÇÃO

**Files:**
- Create: `console/prototype/index.html` + `console/prototype/<screen>.html` (12) + `console/prototype/style.css`
- Create: `docs/superpowers/plans/2026-05-17-console-operacional.md` (registrar veredito)

> Descartável. HTML/CSS puro, **zero** build, dados fake hardcoded, sem JS de lógica (só navegação por links/âncoras). Não é a implementação — é o artefato de alinhamento visual. Não há TDD aqui (protótipo throwaway).

- [ ] **Step 1: Construir as 12 telas em HTML estático**

Uma página por tela, **1:1 com os 12 arquivos de `src/screens/`** da tabela de Tasks 7–18 (`overview.html`↔Overview/Task 7, `entity-detail.html`↔EntityDetail/Task 8, `plan-apply.html`↔PlanApply/Task 9, `approvals.html`↔Approvals/Task 10, `events.html`↔Events/Task 11, `manifest.html`↔Manifest/Task 12, `provision.html`↔ProvisionServer/Task 13, `secrets.html`↔Secrets/Task 14, `backups.html`↔Backups/Task 15, `network.html`↔Network/Task 16, `dns.html`↔DNS/Task 17, `health.html`↔Health/Task 18), mais `index.html` com a navegação. Reproduzir fielmente os mockups acordados (entidades/estados da spec: enum `pending|applying|healthy|degraded|drift|error`, drift sem botão de remover, secrets sem valor, ações destrutivas com aviso "→ Approval Gate"). `style.css` compartilhado.

- [ ] **Step 2: Navegação clicável**

`index.html` linka todas as telas; cada tela tem nav de volta. Abrir `console/prototype/index.html` no browser deve permitir percorrer as 12 telas e os fluxos-chave (Overview→Detail, PlanApply→Approvals→Events, wizard Provision).

- [ ] **Step 3: Commit do protótipo**

```bash
git add console/prototype
git commit -m "design(console): clickable static HTML prototype (12 screens)"
```

- [x] **Step 4: PORTÃO — apresentar ao humano e obter aprovação explícita**

✅ **APROVADO por Bernard em 2026-05-17.** Iteração 1 (tema escuro, commit `eaf4809`) → feedback "mais claro, clean e elegante" → Iteração 2 (tema claro/clean/elegante: Inter + JetBrains Mono, badges suaves, tabelas hairline, sombras sutis — commit `9ed484f`) → **Aprovado, seguir**. Design **congelado**: as Tasks 7–18 devem reproduzir `console/prototype/*.html` 1:1. Portão liberado — Task 2 em diante autorizada.

---

## Task 2: Scaffold do sub-pacote

**Files:**
- Create: `console/package.json`, `console/vite.config.ts`, `console/tsconfig.json`, `console/index.html`, `console/src/main.tsx`, `console/src/app.tsx`

- [ ] **Step 1: Criar projeto Vite + React + TS**

`console/package.json` com scripts `dev`, `build`, `test` (vitest), `lint`. Deps: react, react-dom, react-router-dom, @tanstack/react-query, zod. Dev: vite, typescript, vitest, @testing-library/react, @testing-library/jest-dom, msw, jsdom. `tsconfig.json` com `"module": "NodeNext"`, `"strict": true`, alinhado ao core.

- [ ] **Step 2: App shell mínimo**

`main.tsx` monta `<App/>`; `app.tsx` com `<RouterProvider>` e uma rota `/` renderizando `<div>console</div>`.

- [ ] **Step 3: Verificar build**

Run: `cd console && npm install && npm run build`
Expected: build sem erros, `dist/` gerado.

- [ ] **Step 4: Commit**

```bash
git add console
git commit -m "chore(console): scaffold Vite+React+TS sub-package"
```

---

## Task 3: Contrato REST (Zod) — fronteira para a Fase 4

**Files:**
- Create: `console/CONTRACT.md`, `console/src/api/contract.ts`, `console/tests/contract.test.ts`

- [ ] **Step 1: Escrever teste falho dos schemas**

```ts
// console/tests/contract.test.ts
import { describe, it, expect } from "vitest";
import { ServerSchema, WriteEnvelopeSchema, ErrorSchema } from "../src/api/contract";

describe("contract", () => {
  it("valida Server canônico da spec", () => {
    const ok = ServerSchema.safeParse({
      name: "bevox-app-1", type: "cx32", location: "nbg1",
      image: "ubuntu-24.04", ssh_keys: ["bevox-ops"], labels: { app: "harness" },
      network: "bevox-priv", status: "healthy",
    });
    expect(ok.success).toBe(true);
  });

  it("rejeita status fora do enum da spec", () => {
    expect(ServerSchema.safeParse({ name: "x", type: "cx32", location: "nbg1",
      image: "i", ssh_keys: [], labels: {}, network: "n", status: "weird" }).success).toBe(false);
  });

  it("envelope de escrita aceita pending_approval com approval_id", () => {
    const r = WriteEnvelopeSchema.safeParse({ status: "pending_approval", approval_id: "apr_1" });
    expect(r.success).toBe(true);
  });

  it("erro estruturado segue {code,message,retryable,entity}", () => {
    expect(ErrorSchema.safeParse({ code: "conflict", message: "drift", retryable: false, entity: "server:x" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar teste — deve falhar**

Run: `cd console && npx vitest run tests/contract.test.ts`
Expected: FAIL ("Cannot find module ../src/api/contract").

- [ ] **Step 3: Implementar `contract.ts`**

Schemas Zod para entidades canônicas (`Server`, `Network`, `Volume`, `Service`, `DnsRecord`, `BackupPolicy`, `StateEvent` — spec linhas 75-83), enum de status `pending|applying|healthy|degraded|drift|error` (linha 203), `PlanItemSchema` (`op`,`entity`,`change`,`impact`), `WriteEnvelopeSchema` (`status: planned|pending_approval|applied|error`, `plan?`, `approval_id?`, `error?`), `ErrorSchema` (`code`,`message`,`retryable`,`entity`).

- [ ] **Step 4: Rodar teste — deve passar**

Run: `cd console && npx vitest run tests/contract.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Escrever `CONTRACT.md`**

Documentar a tabela tool→endpoint, envelopes e exemplos (incl. `deploy_service` dry_run da spec linhas 145-156). Marcar explicitamente: "fronteira de integração — o core (Fase 4) DEVE implementar este contrato".

- [ ] **Step 6: Commit**

```bash
git add console/src/api/contract.ts console/tests/contract.test.ts console/CONTRACT.md
git commit -m "feat(console): REST contract schemas (Zod) + CONTRACT.md boundary"
```

---

## Task 4: Fake server (MSW) fiel ao contrato

**Files:**
- Create: `console/src/api/__fakes__/fixtures.ts`, `console/src/api/__fakes__/handlers.ts`, `console/src/api/__fakes__/server.ts`, `console/src/api/__fakes__/browser.ts`, `console/tests/setup.ts`

- [ ] **Step 1: Fixtures da stack Bevox de exemplo**

`fixtures.ts`: estado in-memory com servers (incl. um em `drift`), services (um `degraded`), volumes, dns, backups, networks, events, approvals — espelha os mockups das telas.

- [ ] **Step 2: Handlers MSW implementando CONTRACT.md**

`handlers.ts`: todos os endpoints da tabela. Regras fiéis à spec:
- `dry_run:true` (default em destrutivas) → `{status:"planned", plan:[...]}`, **não** muta fixtures.
- destrutivas com `dry_run:false` → `{status:"pending_approval", approval_id}` (linha 125).
- drift nunca é destruído pelo fake (fail-safe, linhas 200-201).
- erro de exemplo retorna `ErrorSchema`.

- [ ] **Step 3: `server.ts` (testes) e `browser.ts` (dev) + `tests/setup.ts`**

`setup.ts` liga MSW server antes dos testes, reseta handlers entre eles. Configurar `vitest.config` para usar `tests/setup.ts` e `jsdom`.

- [ ] **Step 4: Teste de fumaça do fake**

```ts
// dentro de tests/contract.test.ts ou novo
it("fake /api/state responde estado válido", async () => {
  const res = await fetch("/api/state");
  const json = await res.json();
  expect(json.servers.length).toBeGreaterThan(0);
});
```
Run: `cd console && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add console/src/api/__fakes__ console/tests/setup.ts console/vite.config.ts
git commit -m "test(console): MSW fake server faithful to REST contract"
```

---

## Task 5: Client REST tipado + hooks de query

**Files:**
- Create: `console/src/api/client.ts`, `console/src/api/query.ts`, `console/tests/client.test.ts`

- [ ] **Step 1: Teste falho do client**

```ts
// console/tests/client.test.ts
import { describe, it, expect } from "vitest";
import { getState, postWrite } from "../src/api/client";

describe("client", () => {
  it("getState parseia resposta via Zod", async () => {
    const s = await getState();
    expect(s.servers[0].status).toBeDefined();
  });
  it("postWrite com dry_run retorna envelope planned", async () => {
    const r = await postWrite("/api/services", { name: "x", image: "i:v1", replicas: 1, dry_run: true });
    expect(r.status).toBe("planned");
    expect(r.plan?.length).toBeGreaterThan(0);
  });
  it("erro estruturado é lançado tipado", async () => {
    await expect(postWrite("/api/destroy", { entity: "__force_error__" })).rejects.toMatchObject({ code: expect.any(String) });
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `cd console && npx vitest run tests/client.test.ts`
Expected: FAIL (módulo ausente).

- [ ] **Step 3: Implementar `client.ts` + `query.ts`**

`client.ts`: `fetch` + parse com schemas de `contract.ts`; em resposta `error` lança objeto tipado. `query.ts`: hooks TanStack Query (`useState`, `useDiff`, `useEvents`, `useHealth`, `useApprovals`) e mutations (`useWrite`).

- [ ] **Step 4: Rodar — deve passar**

Run: `cd console && npx vitest run tests/client.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add console/src/api/client.ts console/src/api/query.ts console/tests/client.test.ts
git commit -m "feat(console): typed REST client + TanStack Query hooks"
```

---

## Task 6: Layout + componentes compartilhados

**Files:**
- Create: `console/src/components/{Layout,StatusBadge,EntityTable,DiffView,ConfirmDestructive}.tsx`, `console/tests/screens/components.test.tsx`

- [ ] **Step 1: Teste falho dos componentes-chave**

```tsx
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../src/components/StatusBadge";

it("StatusBadge renderiza cada estado do enum da spec", () => {
  render(<StatusBadge status="drift" />);
  expect(screen.getByText(/drift/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Rodar — falha.** Run: `cd console && npx vitest run tests/screens/components.test.tsx` → FAIL.

- [ ] **Step 3: Implementar componentes**

`StatusBadge` (cores por estado), `EntityTable` (colunas configuráveis), `DiffView` (lista `op/entity/change/impact`, destaca `drift` como não-destrutivo), `ConfirmDestructive` (exige texto de confirmação + aviso "→ Approval Gate"), `Layout` (nav das 12 telas + header com agente atual).

- [ ] **Step 4: Rodar — passa.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add console/src/components console/tests/screens/components.test.tsx
git commit -m "feat(console): shared layout + status/table/diff/confirm components"
```

---

## Tasks 7–18: As 12 telas

> Cada tela deve **reproduzir o protótipo HTML aprovado na Task 1** (design já congelado). Cada tela segue o **mesmo padrão de 5 passos**. Telas read-only não têm botões de escrita; telas de escrita sempre passam por `dry_run` e, se destrutivas, por `ConfirmDestructive` + envelope `pending_approval`.

Padrão por tela (substituir `<Screen>`/`<rota>`/asserções):

- [ ] **Step 1:** Escrever `tests/screens/<screen>.test.tsx` — renderiza a tela com MSW fake, asserta que os dados do contrato aparecem e (se houver) que ação de escrita dispara `dry_run` antes de aplicar. **Falha primeiro.**
- [ ] **Step 2:** `npx vitest run tests/screens/<screen>.test.tsx` → FAIL.
- [ ] **Step 3:** Implementar `src/screens/<Screen>.tsx` usando hooks de `query.ts` e componentes compartilhados; registrar rota em `app.tsx`.
- [ ] **Step 4:** `npx vitest run tests/screens/<screen>.test.tsx` → PASS.
- [ ] **Step 5:** `git add` tela+teste, `git commit -m "feat(console): <screen> screen"`.

| Task | Tela | Rota | Fonte de dados | Escrita |
|---|---|---|---|---|
| 7 | Overview/Fleet | `/` | `useStateQuery` (health não necessário — drift derivado de state) | — |
| 8 | EntityDetail | `/e/:kind/:name` | `useState` | Edit/Scale/Restart/Destroy (dry_run→approval) |
| 9 | PlanApply | `/apply` | `useDiff` | `apply_manifest` dry_run→approval |
| 10 | Approvals | `/approvals` | `useApprovals` | approve/reject (link externo p/ Approval Center) |
| 11 | Events | `/events` | `useEvents` (filtros actor/entity/result) | — |
| 12 | Manifest/Working | `/manifest` | `useDiff(source)` | "promover working→git" (approval) |
| 13 | ProvisionServer | `/provision` | — | wizard 3 passos → `dry_run` → approval (custo) |
| 14 | Secrets | `/secrets` | `GET /api/secrets` (só nomes/uso) | criar (sem exibir valor) |
| 15 | Backups | `/backups` | `GET /api/backups` | snapshot (sem approval) / restore (destrutivo→approval) |
| 16 | Network | `/network` | `useState` (networks) | — (membership é declarativo via label) |
| 17 | DNS | `/dns` | `GET /api/dns` | `set_dns` upsert (sem approval) |
| 18 | Health | `/health` | `useHealth` | — (mostra circuit breaker + blocked) |

Notas de fidelidade à spec por tarefa sensível (números/nomes conforme a tabela acima):
- **Task 14 (Secrets):** nunca renderizar valor; só referência `secret:nome` e contagem de uso (spec linhas 107-108, 240-243). Teste deve asseverar ausência de valores.
- **Task 15 (Backups → Restore):** `ConfirmDestructive` obrigatório + envelope `pending_approval` (linha 141).
- **Tasks 8/9/12 destrutivas (EntityDetail / PlanApply / Manifest):** teste deve provar que `dry_run:true` ocorre antes de qualquer `dry_run:false`.
- **Drift em qualquer tela:** mostrado como aviso read-only, nunca com botão "remover" (fail-safe, linhas 200-201).

---

## Task 19: E2E happy path (fakes)

**Files:**
- Create: `console/tests/e2e-happy-path.test.tsx`

- [ ] **Step 1: Teste falho do fluxo agent-native pelo console**

Cenário: abrir Overview → ver stack → ir a PlanApply → `dry_run` mostra plan → aplicar → recebe `pending_approval` → Approvals lista o `approval_id` → aprovar → Events reflete resultado com ator. Asserções em cada etapa.

- [ ] **Step 2: Rodar — falha** (até telas integradas). Run: `cd console && npx vitest run tests/e2e-happy-path.test.tsx`

- [ ] **Step 3: Ajustar integração entre telas/rotas até passar.** Apenas fiação de navegação/estado entre telas já implementadas — **nenhuma lógica de negócio nova** pode ser introduzida aqui (consistente com a seção Architecture: o console não tem lógica própria).

- [ ] **Step 4: Rodar suíte completa.** Run: `cd console && npx vitest run` → tudo PASS.

- [ ] **Step 5: Commit**

```bash
git add console/tests/e2e-happy-path.test.tsx
git commit -m "test(console): e2e happy path over fake server (agent-native flow)"
```

---

## Fora de escopo (Fase 4 — outro plano)

- Fiar `client.ts` à base URL do core REST real (env var) e remover MSW do bundle de produção.
- AuthN/escopo por capability do console (a spec exige enforcement na Agent Interface, linhas 244-246 — o console só transporta a credencial).
- Webhook do Approval Center para atualização em tempo real (hoje: polling via TanStack Query).
- Servir `dist/` estático atrás do serviço REST.
