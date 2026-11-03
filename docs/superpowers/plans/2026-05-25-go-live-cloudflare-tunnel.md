# Go-Live via Cloudflare Tunnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colocar o daemon `bevox-hetzner-mcp` em produção nesta máquina, expondo só a REST (loopback) via um Cloudflare named tunnel com Cloudflare Access, sob systemd, com Postgres dedicado em Docker.

**Architecture:** O daemon (`core/dist/main.js`) escuta REST em `127.0.0.1:8787`. Um Postgres em Docker escuta em `127.0.0.1:5434`. `cloudflared` (named tunnel) é o único ingress público (`https://bevox-mcp.<DOMÍNIO>` → `http://127.0.0.1:8787`), com Cloudflare Access (service token) na borda e bearer token (`AGENT_CREDENTIALS`) no daemon. Daemon e cloudflared rodam como serviços systemd. **Nenhuma alteração em `core/src/`.**

**Tech Stack:** Node 20 (fnm), Docker Compose, systemd, cloudflared 2026.3.0, PostgreSQL 16, Cloudflare Tunnel + Access.

**Spec:** `docs/specs/2026-05-25-go-live-cloudflare-tunnel.md`

**Legenda de execução:**
- **[Claude]** — pode ser executado nesta sessão (usuário `bernard` tem acesso a `docker`, `node`, `git`, edição de arquivos).
- **[Operador]** — você executa (precisa de `sudo`, login interativo, ou o dashboard da Cloudflare). Dica: rode no prompt com o prefixo `!` para a saída cair na conversa (ex.: `! sudo systemctl status bevox-daemon`).

**Parâmetros a definir antes de começar:**
| Símbolo | Valor |
|---|---|
| `<DOMÍNIO>` | hostname público, ex. `bevox-mcp.seudominio.com` |
| `<TUNNEL_UUID>` | gerado por `cloudflared tunnel create` (Task 6) |
| `<POSTGRES_PASSWORD>` | gerado na Task 2 |
| `<RO_TOKEN>` / `<OP_TOKEN>` | gerados na Task 3 |

---

## File Structure

| Arquivo | Responsabilidade | Commit? |
|---|---|---|
| `.gitignore` (modificar) | ignorar `deploy/postgres/.env` | sim |
| `deploy/postgres/docker-compose.yml` (criar) | Postgres dedicado, loopback `:5434` | sim |
| `deploy/postgres/.env` (criar) | `POSTGRES_PASSWORD` | **não (gitignored)** |
| `core/.env` (criar) | config do daemon (segredos) | **não (gitignored)** |
| `deploy/systemd/bevox-daemon.service` (criar) | unit do daemon | sim |
| `deploy/cloudflared/config.yml` (criar) | ingress do túnel | sim |
| `deploy/systemd/cloudflared-bevox.service` (criar) | unit do cloudflared | sim |
| `deploy/README.md` (criar) | runbook (subida/verificação/rollback/rotação) | sim |

Unidades systemd e config do cloudflared são **versionadas** em `deploy/` e **copiadas** para os locais de sistema na execução (mantém a fonte da verdade no repo, sem segredo).

---

## FASE 0 — Preparação

### Task 1: Branch de trabalho + gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1 [Claude]: Criar branch a partir de `main`**

Run:
```bash
cd ~/bevox-hetzner-mcp
git checkout -b feat/go-live-cloudflare-tunnel
```
Expected: `Switched to a new branch 'feat/go-live-cloudflare-tunnel'`

- [ ] **Step 2 [Claude]: Adicionar `deploy/postgres/.env` ao `.gitignore`**

Acrescentar ao bloco "Environment" do `.gitignore` (após a linha `console/.env`):
```gitignore
deploy/postgres/.env
```

- [ ] **Step 3 [Claude]: Verificar que os segredos estão ignorados**

Run:
```bash
git check-ignore -v core/.env deploy/postgres/.env
```
Expected: duas linhas, cada arquivo casando uma regra do `.gitignore` (ex.: `.gitignore:NN:core/.env	core/.env`).

- [ ] **Step 4 [Claude]: Commit do gitignore**

```bash
git add .gitignore
git commit -m "chore(deploy): gitignore deploy/postgres/.env

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## FASE A — Borda (validar túnel + REST + Access, sem creds Hetzner reais)

### Task 2: Postgres dedicado em Docker (loopback :5434)

**Files:**
- Create: `deploy/postgres/docker-compose.yml`
- Create: `deploy/postgres/.env` (gitignored)

- [ ] **Step 1 [Claude]: Criar `deploy/postgres/docker-compose.yml`**

```yaml
name: bevox-hetzner-mcp
services:
  postgres:
    image: postgres:16-alpine
    container_name: bevox-mcp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: bevox
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?defina em deploy/postgres/.env}
      POSTGRES_DB: bevox
    ports:
      - "127.0.0.1:5434:5432"
    volumes:
      - bevox_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bevox -d bevox"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  bevox_pgdata:
```

- [ ] **Step 2 [Claude]: Gerar a senha e gravar `deploy/postgres/.env`**

Run:
```bash
cd ~/bevox-hetzner-mcp
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > deploy/postgres/.env
chmod 600 deploy/postgres/.env
```
Guardar o valor: `grep POSTGRES_PASSWORD deploy/postgres/.env` → é o `<POSTGRES_PASSWORD>` usado na Task 3.

- [ ] **Step 3 [Claude]: Subir o Postgres**

Run:
```bash
docker compose -f deploy/postgres/docker-compose.yml up -d
```
Expected: container `bevox-mcp-postgres` criado/iniciado.

- [ ] **Step 4 [Claude]: Verificar que está saudável e escutando só no loopback**

Run:
```bash
docker compose -f deploy/postgres/docker-compose.yml ps
ss -ltn | grep 5434
```
Expected: `ps` mostra `running (healthy)`; `ss` mostra `127.0.0.1:5434` (NÃO `0.0.0.0`).

- [ ] **Step 5 [Claude]: Commit (só o compose; o `.env` é ignorado)**

```bash
git add deploy/postgres/docker-compose.yml
git commit -m "feat(deploy): dedicated postgres on loopback :5434

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `core/.env` de produção (Fase A)

**Files:**
- Create: `core/.env` (gitignored)

- [ ] **Step 1 [Claude]: Gerar os tokens de agente**

Run:
```bash
echo "RO_TOKEN=$(openssl rand -hex 32)"
echo "OP_TOKEN=$(openssl rand -hex 32)"
```
Guardar os dois valores (`<RO_TOKEN>` = leitura; `<OP_TOKEN>` = operação plena).

- [ ] **Step 2 [Claude]: Escrever `core/.env`** (uma linha por chave; SEM aspas envolvendo valores; `AGENT_CREDENTIALS` numa única linha)

Substituir `<POSTGRES_PASSWORD>`, `<RO_TOKEN>`, `<OP_TOKEN>` pelos valores gerados. Para a Fase A, as chaves Hetzner/SSH/restic ficam com placeholder **não-vazio** (o boot só checa não-vazio; chamadas reais só no reconcile, com circuit breaker fail-safe):

```dotenv
# --- Postgres dedicado (Docker, loopback :5434) ---
DATABASE_URL=postgres://bevox:<POSTGRES_PASSWORD>@127.0.0.1:5434/bevox

# --- REST (loopback; alvo do cloudflared) ---
PORT=8787
LOG_LEVEL=info

# --- Credenciais de agente: token -> {actor, capabilities=nomes de tools} ---
# RO_TOKEN: leitura. OP_TOKEN: operação plena (todas as tools v1 + v2).
AGENT_CREDENTIALS={"<RO_TOKEN>":{"actor":"agent:claude-code","capabilities":["get_state","diff","events","health"]},"<OP_TOKEN>":{"actor":"agent:vox","capabilities":["get_state","diff","events","health","provision_server","deploy_service","scale_service","set_dns","snapshot","restore","destroy","apply_manifest","resolve_selector","set_firewall","set_primary_ip","set_certificate","set_load_balancer","set_ingress","expose_service"]}}

# --- Hetzner/SSH/restic: PLACEHOLDERS Fase A (trocar por reais na Task 10) ---
HCLOUD_TOKEN=placeholder-fase-a
HCLOUD_DNS_TOKEN=placeholder-fase-a
RESTIC_REPO=placeholder-fase-a
RESTIC_PASSWORD=placeholder-fase-a
SSH_HOST=placeholder-fase-a
SSH_USER=placeholder-fase-a
SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----
```

- [ ] **Step 3 [Claude]: Travar permissões e confirmar que está ignorado**

Run:
```bash
chmod 600 core/.env
git check-ignore core/.env
```
Expected: `git check-ignore` imprime `core/.env` (ignorado) e sai 0.

---

### Task 4: Build de produção + smoke local do daemon

**Files:** nenhum (build + verificação)

- [ ] **Step 1 [Claude]: Instalar deps + typecheck + build**

Run:
```bash
npm --prefix core ci          # deps não vêm no checkout; necessário p/ tsc/build
npm --prefix core run typecheck   # pode acusar erros em test/ + oráculo console (deps do console ausentes) — NÃO bloqueiam o build de produção
npm --prefix core run build
ls core/dist/main.js core/dist/store/migrations/
```
Expected: `core/dist/main.js` existe e `core/dist/store/migrations/` contém os 4 `.sql` (o script `build` copia os assets `.sql`, senão o boot falha com ENOENT). O `typecheck` cobre `core/src` runtime; erros em `test/`/`console` são fora do escopo do go-live.

- [ ] **Step 2 [Claude]: Subir o daemon em background pra smoke**

Run:
```bash
cd core
# node ABSOLUTO (fnm) + --env-file (v20.18.1 não suporta --env-file-if-exists)
~/.local/share/fnm/node-versions/v20.18.1/installation/bin/node \
  --env-file=.env dist/main.js > /tmp/bevox-smoke.log 2>&1 &
echo $! > /tmp/bevox-smoke.pid
sleep 4
```

- [ ] **Step 3 [Claude]: Verificar boot + REST no loopback (com o RO token)**

Run:
```bash
ss -ltn | grep 8787
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer <RO_TOKEN>" \
  http://127.0.0.1:8787/api/health
```
Expected: `ss` mostra `127.0.0.1:8787`; o `curl` retorna `200`. (Se 401/403 → token errado no `.env`. Se conexão recusada → ver `/tmp/bevox-smoke.log`: provavelmente Postgres/`DATABASE_URL`.)

- [ ] **Step 4 [Claude]: Confirmar que NÃO há segredo no log de boot**

Run:
```bash
grep -Ei 'placeholder|POSTGRES_PASSWORD|BEGIN OPENSSH|<RO_TOKEN>|<OP_TOKEN>' /tmp/bevox-smoke.log || echo "OK: nenhum segredo no log"
```
Expected: `OK: nenhum segredo no log`.

- [ ] **Step 5 [Claude]: Parar o smoke (vamos rodar sob systemd)**

Run:
```bash
kill "$(cat /tmp/bevox-smoke.pid)" && rm -f /tmp/bevox-smoke.pid
```

---

### Task 5: systemd — `bevox-daemon.service`

**Files:**
- Create: `deploy/systemd/bevox-daemon.service`

- [ ] **Step 1 [Claude]: Criar `deploy/systemd/bevox-daemon.service`**

(O caminho do `node` é a instalação **estável** do fnm — não o symlink de shell.)
```ini
[Unit]
Description=bevox-hetzner-mcp control plane daemon (REST+MCP+reconciler)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=bernard
Group=bernard
WorkingDirectory=core
Environment=HOME=~
Environment=NODE_ENV=production
ExecStart=~/.local/share/fnm/node-versions/v20.18.1/installation/bin/node --env-file=.env dist/main.js
Restart=on-failure
RestartSec=5
# Hardening mínimo seguro (workdir no HOME; chave SSH vai p/ temp 0600).
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2 [Operador]: Instalar, recarregar e habilitar**

```bash
sudo cp deploy/systemd/bevox-daemon.service /etc/systemd/system/bevox-daemon.service
sudo systemctl daemon-reload
sudo systemctl enable --now bevox-daemon.service
```

- [ ] **Step 3 [Operador]: Verificar que está ativo**

```bash
systemctl status bevox-daemon.service --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <RO_TOKEN>" http://127.0.0.1:8787/api/health
```
Expected: `active (running)`; curl `200`.

- [ ] **Step 4 [Operador]: Conferir logs sem segredo**

```bash
journalctl -u bevox-daemon.service -n 50 --no-pager | grep -Ei 'placeholder|BEGIN OPENSSH|POSTGRES_PASSWORD' || echo "OK: sem segredo nos logs"
```
Expected: `OK: sem segredo nos logs`.

- [ ] **Step 5 [Claude]: Commit do unit**

```bash
git add deploy/systemd/bevox-daemon.service
git commit -m "feat(deploy): systemd unit for bevox daemon

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Named tunnel (cloudflared) + `config.yml`

**Files:**
- Create: `deploy/cloudflared/config.yml`

- [ ] **Step 1 [Operador]: Autenticar o cloudflared (login interativo)**

```bash
cloudflared tunnel login
```
Abre o browser; selecione a zona do `<DOMÍNIO>`. Gera `~/.cloudflared/cert.pem`.

- [ ] **Step 2 [Operador]: Criar o named tunnel e capturar o UUID**

```bash
cloudflared tunnel create bevox-mcp
cloudflared tunnel list
```
Expected: cria `~/.cloudflared/<TUNNEL_UUID>.json`. Anotar o `<TUNNEL_UUID>` (coluna ID do `list`).

- [ ] **Step 3 [Claude]: Criar `deploy/cloudflared/config.yml`** (substituir `<TUNNEL_UUID>` e `<DOMÍNIO>`)

```yaml
tunnel: bevox-mcp
credentials-file: ~/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: bevox-mcp.<DOMÍNIO>
    service: http://127.0.0.1:8787
  - service: http_status:404
```

- [ ] **Step 4 [Operador]: Criar a rota DNS**

```bash
cloudflared tunnel route dns bevox-mcp bevox-mcp.<DOMÍNIO>
```
Expected: cria/atualiza o CNAME `bevox-mcp.<DOMÍNIO>` → `<TUNNEL_UUID>.cfargotunnel.com`.

- [ ] **Step 5 [Operador]: Validar a config do túnel (sem rodar ainda como serviço)**

```bash
cloudflared tunnel ingress validate --config deploy/cloudflared/config.yml
```
Expected: `Validating rules ... OK`.

- [ ] **Step 6 [Claude]: Commit da config (sem credenciais — o JSON do túnel fica em ~/.cloudflared)**

```bash
git add deploy/cloudflared/config.yml
git commit -m "feat(deploy): cloudflared named-tunnel ingress config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: systemd — `cloudflared-bevox.service`

**Files:**
- Create: `deploy/systemd/cloudflared-bevox.service`

- [ ] **Step 1 [Claude]: Criar `deploy/systemd/cloudflared-bevox.service`**

```ini
[Unit]
Description=cloudflared tunnel for bevox-hetzner-mcp
After=network-online.target bevox-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=bernard
Group=bernard
Environment=HOME=~
ExecStart=/usr/local/bin/cloudflared tunnel --config deploy/cloudflared/config.yml run
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2 [Operador]: Instalar e habilitar**

```bash
sudo cp deploy/systemd/cloudflared-bevox.service /etc/systemd/system/cloudflared-bevox.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-bevox.service
```

- [ ] **Step 3 [Operador]: Verificar o túnel**

```bash
systemctl status cloudflared-bevox.service --no-pager
cloudflared tunnel info bevox-mcp
```
Expected: `active (running)`; `info` mostra conexões ativas (4 edges).

- [ ] **Step 4 [Claude]: Commit do unit**

```bash
git add deploy/systemd/cloudflared-bevox.service
git commit -m "feat(deploy): systemd unit for cloudflared tunnel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Cloudflare Access (service token na borda)

**Files:** nenhum (configuração no dashboard/API da Cloudflare — **[Operador]**)

- [ ] **Step 1 [Operador]: Criar um service token**
  Zero Trust dashboard → Access → Service Auth → **Create Service Token** (nome `bevox-mcp-agent`). Copiar **Client ID** e **Client Secret** (o secret só aparece uma vez).

- [ ] **Step 2 [Operador]: Criar a aplicação Access self-hosted**
  Access → Applications → **Add an application** → Self-hosted. Application domain: `bevox-mcp.<DOMÍNIO>` (path vazio = cobre tudo).

- [ ] **Step 3 [Operador]: Política de service token**
  Na aplicação, adicionar policy: Action **Service Auth**, Include → **Service Token** → `bevox-mcp-agent`. (Sem política interativa: só o service token entra.)

- [ ] **Step 4 [Operador]: Verificar que o Access está barrando sem token**
```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://bevox-mcp.<DOMÍNIO>/api/health
```
Expected: `302`/`403` (bloqueado pelo Access — sem service token não passa).

---

### Task 9: Verificação E2E da Fase A

**Files:** nenhum (verificação)

- [ ] **Step 1 [Operador]: Requisição válida ponta-a-ponta (service token + bearer)**
```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: <CF_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CF_CLIENT_SECRET>" \
  -H "Authorization: Bearer <RO_TOKEN>" \
  https://bevox-mcp.<DOMÍNIO>/api/health
```
Expected: `200`.

- [ ] **Step 2 [Operador]: Access ok mas bearer inválido → daemon nega**
```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: <CF_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CF_CLIENT_SECRET>" \
  -H "Authorization: Bearer token-invalido" \
  https://bevox-mcp.<DOMÍNIO>/api/health
```
Expected: `401`/`403` (o daemon rejeita o bearer mesmo passando pelo Access).

- [ ] **Step 3 [Operador]: `get_state` E2E (leitura real pela URL pública)**
```bash
curl -sS \
  -H "CF-Access-Client-Id: <CF_CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <CF_CLIENT_SECRET>" \
  -H "Authorization: Bearer <RO_TOKEN>" \
  https://bevox-mcp.<DOMÍNIO>/api/state | head -c 400; echo
```
Expected: JSON de estado (envelope do contrato), HTTP 200.

- [ ] **Step 4 [Operador]: Sobrevive a reboot (opcional, mas é critério de aceite)**
```bash
sudo systemctl is-enabled bevox-daemon.service cloudflared-bevox.service
```
Expected: ambos `enabled`.

**✅ Checkpoint Fase A:** túnel + REST + Access validados. Pare aqui se ainda não tiver os segredos reais da Hetzner.

---

## FASE B — Operação plena

### Task 10: Trocar placeholders pelos segredos reais + reconcile

**Files:**
- Modify: `core/.env` (substituir os 8 placeholders Hetzner/SSH/restic)

- [ ] **Step 1 [Operador]: Preencher os segredos reais em `core/.env`**
  Substituir os valores `placeholder-fase-a` por:
  `HCLOUD_TOKEN`, `HCLOUD_DNS_TOKEN`, `RESTIC_REPO`, `RESTIC_PASSWORD`, `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` (PEM completo; `\n` para quebras de linha numa só linha). Não commitar (arquivo é gitignored).

- [ ] **Step 2 [Operador]: Reiniciar o daemon**
```bash
sudo systemctl restart bevox-daemon.service
systemctl status bevox-daemon.service --no-pager
```
Expected: `active (running)`.

- [ ] **Step 3 [Operador]: Confirmar que o reconciler converge contra a Hetzner real**
```bash
journalctl -u bevox-daemon.service -n 80 --no-pager | grep -Ei 'reconcile|drift|breaker|applied|failed'
curl -sS -H "Authorization: Bearer <RO_TOKEN>" http://127.0.0.1:8787/api/health | head -c 400; echo
```
Expected: ciclos de reconcile sem erro de auth da Hetzner; `health` sem breakers abertos por credencial inválida. (Breaker aberto por credencial errada → revisar o token correspondente.)

- [ ] **Step 4 [Operador]: Confirmar ausência de segredo nos logs**
```bash
journalctl -u bevox-daemon.service --no-pager | grep -Ei 'BEGIN OPENSSH|hcloud_[A-Za-z0-9]{8,}|RESTIC_PASSWORD' || echo "OK: sem segredo nos logs"
```
Expected: `OK: sem segredo nos logs`.

---

## FASE C — Fechamento

### Task 11: Runbook + finalização

**Files:**
- Create: `deploy/README.md`

- [ ] **Step 1 [Claude]: Escrever `deploy/README.md`** (runbook operacional)

````markdown
# Deploy — bevox-hetzner-mcp (Cloudflare Tunnel)

Spec: `docs/specs/2026-05-25-go-live-cloudflare-tunnel.md`
Plano: `docs/superpowers/plans/2026-05-25-go-live-cloudflare-tunnel.md`

## Portas
- REST do daemon: `127.0.0.1:8787` (loopback; alvo do cloudflared)
- Postgres dedicado: `127.0.0.1:5434` (Docker)

## Segredos (NUNCA commitar)
- `core/.env` — config do daemon (gitignored)
- `deploy/postgres/.env` — senha do Postgres (gitignored)
- `~/.cloudflared/<TUNNEL_UUID>.json` — credenciais do túnel
- Cloudflare Access service token — guardado fora do repo

## Subir (ordem)
```bash
docker compose -f deploy/postgres/docker-compose.yml up -d
sudo systemctl start bevox-daemon.service
sudo systemctl start cloudflared-bevox.service
```

## Verificar
```bash
systemctl status bevox-daemon cloudflared-bevox --no-pager
cloudflared tunnel info bevox-mcp
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "Authorization: Bearer $RO_TOKEN" https://bevox-mcp.<DOMÍNIO>/api/health
```

## Rollback (não-destrutivo)
```bash
sudo systemctl stop cloudflared-bevox.service   # corta o ingress público
sudo systemctl stop bevox-daemon.service        # stop gracioso (libera locks/pool)
docker compose -f deploy/postgres/docker-compose.yml down   # preserva o volume bevox_pgdata
```

## Rotação do bearer token
1. Gerar novo: `openssl rand -hex 32`.
2. Editar `AGENT_CREDENTIALS` em `core/.env` (manter o antigo durante a janela).
3. `sudo systemctl restart bevox-daemon.service`.
4. Migrar os agentes para o novo token e remover o antigo do `.env`; reiniciar.

## Acesso MCP (cliente externo)
O daemon expõe REST; um cliente MCP usa o bridge stdio apontando p/ a URL pública:
```bash
BEVOX_REST_URL=https://bevox-mcp.<DOMÍNIO> BEVOX_AGENT_TOKEN=$OP_TOKEN \
  node core/bin/mcp-stdio-bridge.mjs
```
(O bridge também precisa enviar os headers do Access — configure-o atrás de um
cliente que injete `CF-Access-Client-Id/Secret`, ou use um Access policy por
`Service Token` aceitando o request.)
````

- [ ] **Step 2 [Claude]: Commit do runbook**

```bash
git add deploy/README.md
git commit -m "docs(deploy): go-live runbook (Cloudflare Tunnel)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3 [Operador]: Abrir PR (quando quiser integrar à main)**

```bash
git push -u origin feat/go-live-cloudflare-tunnel
gh pr create --title "Go-live via Cloudflare Tunnel" \
  --body "Spec: docs/specs/2026-05-25-go-live-cloudflare-tunnel.md
Plano: docs/superpowers/plans/2026-05-25-go-live-cloudflare-tunnel.md
Sem mudança em core/src/ (deploy + runbook)."
```

---

## Notas / decisões

- **Sem mudança em `core/src/`** → regras `specs-first`/`tdd-required` não acionadas. A validação é operacional (curl/systemctl/journalctl).
- **Não há endpoint sem auth**: `/api/health` exige bearer (capability `health`). Probes externos de uptime precisam carregar service token + bearer. Por isso não há "bypass de health" no Access.
- **Hardening systemd** propositalmente mínimo (`NoNewPrivileges`, `PrivateTmp`) para não quebrar o 1º boot (workdir no HOME; ssh grava chave em temp 0600 e known_hosts em `~/.ssh`). Endurecer depois (`ProtectSystem=strict` etc.) é follow-up, validando que o ssh-exec continua funcional.
- **Faseamento**: a Fase A boota com placeholders não-vazios porque `loadConfig` só checa não-vazio; chamadas reais (Hetzner/SSH/restic) só ocorrem no ciclo de reconcile, isoladas por circuit breaker (fail-safe).

## Execução real (2026-05-25) — deltas vs. o plano genérico

- **cloudflared já autenticado** nesta máquina (cert.pem presente) → o passo `cloudflared tunnel login` foi pulado.
- **Tunnel dedicado** `bevox-hetzner-mcp` = `<TUNNEL_UUID>`; credenciais em `~/.cloudflared/<TUNNEL_ID>-….json` (fora do git).
- **Hostname** = `mcp.example.com` (sob o curinga `*.example.com`; a rota DNS explícita aponta esse host pro tunnel novo, vencendo o curinga).
- **Gotcha do `route dns`**: o `cloudflared` lê o `~/.cloudflared/config.yml` default (tunnel `<old-tunnel-id>` = my-tunnel) e o usa, **ignorando o tunnel positional**. A 1ª rota saiu errada (→ <old-tunnel-id>). Corrigido com `cloudflared tunnel --config deploy/cloudflared/config.yml route dns --overwrite-dns <TUNNEL_ID>-… mcp.example.com` (config nossa força o tunnel certo).
- **Config do tunnel**: `deploy/cloudflared/config.yml` (NÃO o `/etc/cloudflared/config.yml` de produção, que roteia example.com/example.net/chat.example.com etc.).
- **Serviço**: `deploy/systemd/cloudflared-bevox-hetzner-mcp.service`, binário `/usr/bin/cloudflared` (igual ao `cloudflared.service` de produção). Convive com `cloudflared.service` e `cloudflared-bevox-site.service` já ativos.
- **Build/boot**: `npm ci` necessário; node absoluto fnm + `--env-file` (não `-if-exists`); `build` copia os `.sql` (fix de packaging).
```
