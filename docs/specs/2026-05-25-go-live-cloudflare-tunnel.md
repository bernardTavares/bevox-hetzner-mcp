# bevox-hetzner-mcp — Go-Live via Cloudflare Tunnel (nesta máquina)

- **Data:** 2026-05-25
- **Status:** Em revisão
- **Autor:** Bernard (brainstorm com Claude)
- **Tipo:** Spec operacional / runbook de deploy (NÃO altera `core/src/`)
- **Spec-base (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)

## 0. Escopo e relação com as outras specs

Esta spec descreve **como colocar o daemon `bevox-hetzner-mcp` em produção
nesta máquina**, expondo a API REST (única superfície de rede) através de um
**Cloudflare Tunnel**, com supervisão por **systemd**, **Postgres dedicado em
Docker** e **Cloudflare Access** na borda.

**Não há mudança em `core/src/`.** O daemon já é um servidor REST+MCP+reconciler
(`core/src/main.ts` → `core/src/server.ts`). Logo, as regras `specs-first` e
`tdd-required` (que cobrem mudança de comportamento em `core/src/`) **não são
acionadas** por esta spec. Os entregáveis são artefatos de deploy + runbook.

> Se durante a execução surgir necessidade real de tocar `core/src/` (ex.: um
> endpoint `/healthz` sem auth para bypass do Access, ou honrar
> `X-Forwarded-*`), isso vira **spec + plano + TDD próprios** — fora do escopo
> aqui (YAGNI).

### Dentro do escopo
- Postgres dedicado em container Docker (loopback `127.0.0.1:5434`).
- `core/.env` de produção (gitignored) com todas as chaves obrigatórias.
- Build de produção (`core/dist/main.js`) rodado por `node` (não `tsx`).
- Dois serviços systemd: `bevox-daemon.service` e `cloudflared-bevox.service`.
- Named tunnel Cloudflare (credentials + `config.yml` + rota DNS).
- Cloudflare Access (service token) protegendo o hostname.
- Runbook: ordem de subida, verificação, rollback, rotação de token.

### Fora do escopo (não-objetivos)
- Qualquer alteração de comportamento em `core/src/`.
- Multi-host / HA do control plane (uma máquina só).
- CI/CD do deploy (subida manual operada; automação fica para depois).
- Provisionamento dos recursos Hetzner em si (isso é trabalho do daemon, não
  desta spec).

## 1. Estado atual (fatos verificados nesta máquina)

| Fato | Verificação |
|---|---|
| REST faz bind **somente em `127.0.0.1`** | `core/src/agent/rest.ts`: `s.listen(port ?? 0, "127.0.0.1", …)` — comentário literal *"Loopback only — never expose beyond localhost"* |
| MCP **não** é exposto pela rede no daemon | `core/src/agent/mcp.ts`: transporte injetado (stdio/in-memory). Acesso MCP remoto é via `core/bin/mcp-stdio-bridge.mjs`, que proxia para a REST (`BEVOX_REST_URL`) |
| Auth já existe | Bearer token via `AGENT_CREDENTIALS` (mapa `token → {actor, capabilities}`), validado na REST |
| Boot é fail-fast e value-free | `core/src/config.ts`: chaves obrigatórias sem default; erro lista só nomes, nunca valores |
| Porta REST `8787` | **livre** nesta máquina |
| Porta `5433` (Postgres proposto originalmente) | **EM USO** (`bevox-meta-api-postgres-prod`, `127.0.0.1:5433->5432`) → trocada |
| Porta `5434` | **livre** → usada pelo Postgres dedicado |
| Ferramentas presentes | `cloudflared 2026.3.0`, `docker 29.4.1`, `node v20.18.1` |

> Nota lateral (fora do escopo): `bevox-backend-postgres` escuta em
> `0.0.0.0:5432` (todas as interfaces). Revisar exposição depois; esta spec não
> mexe nisso.

## 2. Arquitetura / topologia

```
Agente remoto (OpenClaw/Vox, ou cliente MCP via mcp-stdio-bridge)
   │  HTTPS → https://bevox-mcp.<DOMÍNIO>
   │  headers: Authorization: Bearer <token AGENT_CREDENTIALS>
   │           CF-Access-Client-Id / CF-Access-Client-Secret  (service token)
   ▼
Cloudflare Edge  ──[ Access policy: service token ]──►  nega se não-autorizado
   │  (tunnel — nenhuma porta pública aberta nesta máquina)
   ▼
cloudflared  (systemd: cloudflared-bevox.service)
   │  ──►  http://127.0.0.1:8787
   ▼
bevox daemon  (systemd: bevox-daemon.service)
   │  ──►  Postgres (Docker, 127.0.0.1:5434)
   ├─ REST /api/*            ← única superfície exposta
   ├─ MCP (in-process; remoto via bridge apontando p/ a URL pública)
   └─ reconciler + drift     ──► Hetzner Cloud/DNS · Docker-over-SSH · WireGuard · restic
```

### Fluxo de requisição
1. Agente chama `https://bevox-mcp.<DOMÍNIO>/api/...` com **dois** pares de
   credenciais: o service token do Cloudflare Access (`CF-Access-Client-Id` /
   `CF-Access-Client-Secret`) e o bearer token do daemon (`Authorization`).
2. O **edge da Cloudflare** avalia a política de Access; nega no edge se o
   service token não casar.
3. O tráfego desce pelo túnel até o `cloudflared` local, que repassa para
   `http://127.0.0.1:8787` (os headers passam adiante).
4. O **daemon** valida o bearer token contra `AGENT_CREDENTIALS`, resolve
   actor + capabilities e executa pela mesma engine 4.x (envelope + StateEvent).

## 3. Portas (resolvidas após double-check)

| Serviço | Endereço | Observação |
|---|---|---|
| REST do daemon | `127.0.0.1:8787` | livre; `PORT=8787` no `.env`; alvo do `cloudflared` |
| Postgres dedicado (Docker) | `127.0.0.1:5434:5432` | 5433 estava ocupada; daemon conecta em `127.0.0.1:5434` |
| Reservas | `8788` (REST), `5435` (PG) | só se necessário |

Tudo **loopback-only**. O único ingress público é o Cloudflare Tunnel.

## 4. Componentes / artefatos novos

Todos **fora de `core/src/`**. Localização sugerida: diretório `deploy/`.

1. **`deploy/postgres/docker-compose.yml`** — `postgres:16-alpine`, volume
   nomeado (`bevox_pgdata`), `ports: ["127.0.0.1:5434:5432"]`, healthcheck,
   `restart: unless-stopped`. Cria role+db `bevox` (via `POSTGRES_*` ou script
   de init).
2. **`core/.env`** (gitignored) — todas as chaves obrigatórias de
   `ConfigSchema`. `DATABASE_URL=postgres://bevox:<senha>@127.0.0.1:5434/bevox`,
   `PORT=8787`, `AGENT_CREDENTIALS` com **um token por agente, escopado por
   capability** (least privilege). Derivar de `core/.env.example`.
3. **Build de produção** — `npm --prefix core run build` → `core/dist/main.js`,
   executado por `node --env-file-if-exists=core/.env core/dist/main.js`
   (produção usa `node`, não `tsx`).
4. **`deploy/systemd/bevox-daemon.service`** — `WorkingDirectory` no repo,
   `ExecStart=node --env-file-if-exists=core/.env core/dist/main.js`,
   `Restart=on-failure`, `After=docker.service` (PG sobe antes), usuário
   dedicado, hardening (`NoNewPrivileges=yes`, `ProtectSystem=strict`,
   `ProtectHome=yes`, `PrivateTmp=yes`). SIGTERM aciona o `stop()` gracioso já
   implementado.
5. **Named tunnel** — `cloudflared tunnel create bevox-mcp` (gera credentials
   JSON em `~/.cloudflared/`), `deploy/cloudflared/config.yml` com ingress
   `bevox-mcp.<DOMÍNIO> → http://127.0.0.1:8787` (fallback `http_status:404`),
   e `cloudflared tunnel route dns bevox-mcp bevox-mcp.<DOMÍNIO>`.
6. **`deploy/systemd/cloudflared-bevox.service`** — roda o named tunnel,
   `Restart=always`, `After=bevox-daemon.service`. (Alternativa:
   `cloudflared service install`.)
7. **Cloudflare Access** — aplicação self-hosted protegendo
   `bevox-mcp.<DOMÍNIO>`, política com **service token** (agentes
   não-interativos). Opcional: política de bypass só para `/api/health` se
   houver healthcheck externo. (Configuração no dashboard/API — passo do
   operador.)
8. **`deploy/README.md` (runbook)** — ordem de subida, verificação, rollback,
   rotação de token.

## 5. Modelo de segurança (alinhado aos não-negociáveis do projeto)

- **Loopback-only**: a REST nunca escuta além de `127.0.0.1` (garantido no
  código); só o `cloudflared` a alcança. Nenhuma porta pública nova.
- **Dupla autenticação**: Cloudflare Access (edge) + bearer token (daemon).
- **Segredos**: vivem apenas em `core/.env` (gitignored) e nos credentials do
  túnel; nunca em git, nunca em log (`config.ts` é value-free; logger é
  estruturado e redigido).
- **Least privilege**: `AGENT_CREDENTIALS` com um token por agente, escopado
  por capability.
- **Fail-safe preservado**: o reconciler não destrói nada por conta própria;
  ações destrutivas passam pelo Approval Gate; circuit breaker isola provider
  com falha.

## 6. Faseamento (rollout)

**Fase A — Validar o caminho de borda (sem creds Hetzner reais).**
Sobe Postgres (Docker) + `AGENT_CREDENTIALS` real; as chaves
Hetzner/SSH/restic podem ser placeholders **não-vazios** (o boot só checa
não-vazio; chamadas reais só ocorrem no ciclo de reconcile, com circuit
breaker fail-safe). Valida: daemon sobe, REST responde no loopback, túnel
publica, Access nega/permite corretamente, `GET /api/health` E2E pela URL
pública.

**Fase B — Operação plena.**
Substitui os placeholders pelos segredos reais (`HCLOUD_TOKEN`,
`HCLOUD_DNS_TOKEN`, `RESTIC_REPO`, `RESTIC_PASSWORD`, `SSH_HOST`/`SSH_USER`/
`SSH_PRIVATE_KEY`), reinicia o daemon e confirma que o reconciler converge
contra a Hetzner real.

## 7. Verificação (checklist de go-live)

- `docker compose ps` (Postgres healthy em `127.0.0.1:5434`).
- `systemctl status bevox-daemon cloudflared-bevox` (ambos `active (running)`).
- `curl -sS -H "Authorization: Bearer <token>" http://127.0.0.1:8787/api/health`
  → 200 local.
- `cloudflared tunnel info bevox-mcp` (conexões saudáveis).
- `curl` externo em `https://bevox-mcp.<DOMÍNIO>/api/health` com service token
  + bearer → 200; **sem** service token → bloqueado pelo Access.
- Um `get_state` / health E2E pela URL pública.
- `journalctl -u bevox-daemon` sem qualquer segredo nos logs.

## 8. Rollback

- `systemctl stop cloudflared-bevox` → corta o ingress público imediatamente
  (daemon segue local).
- `systemctl stop bevox-daemon` → para o control plane (graceful `stop()`:
  libera advisory locks e pool; nunca fail-delete).
- `docker compose down` (Postgres) preserva o volume `bevox_pgdata`.
- Reverter é não-destrutivo: nenhum recurso Hetzner é removido por parar o
  daemon.

## 9. Pré-requisitos do operador (BLOQUEANTES p/ Fase B)

- `HCLOUD_TOKEN`, `HCLOUD_DNS_TOKEN`
- `RESTIC_REPO` + `RESTIC_PASSWORD`
- **`SSH_HOST` (host Hetzner gerenciado) + `SSH_USER` + `SSH_PRIVATE_KEY`** — REQUERIDO apenas se: (a)
  `MANAGED_MESH=on` (comportamento padrão — v1), OU (b) ao menos um `Service` é
  declarado no desired state (Docker ainda acessa via SSH). Ver spec
  [`2026-05-26-server-scope-transport-decoupling.md`](./2026-05-26-server-scope-transport-decoupling.md)
  para a semantics de `MANAGED_MESH=off` (k3s/CNI externalizados).
- Conta Cloudflare com a zona do `<DOMÍNIO>` e `cloudflared` autenticado nesta
  máquina (já confirmado pelo operador).

## 10. Parâmetros a preencher na execução

| Parâmetro | Valor |
|---|---|
| Hostname público | `bevox-mcp.<DOMÍNIO>` (a definir) |
| Nome do tunnel | `bevox-mcp` |
| Senha do Postgres `bevox` | gerada na execução (não commitar) |
| Tokens `AGENT_CREDENTIALS` | gerados por agente na execução |

## 11. Critérios de aceite

- Daemon e túnel sob systemd, sobrevivem a reboot.
- REST acessível **apenas** via `https://bevox-mcp.<DOMÍNIO>` (loopback +
  túnel; nenhuma porta pública nova).
- Access bloqueia requisição sem service token; permite com.
- Bearer token inválido é negado pelo daemon.
- Nenhum segredo em git, em log ou em resposta de erro.
- Nenhuma alteração em `core/src/`.
