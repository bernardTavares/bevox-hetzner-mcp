# Onboarding — deploy bevox-hetzner-mcp + connect Claude as MCP client

A focused kickstart: stand up the daemon on a Linux server, wire Claude
Desktop (or Claude Code) to it via the stdio bridge, and run your first tool
call end-to-end.

**Time:** ~30 minutes if you have a fresh Ubuntu VM + a Hetzner account.

---

## What you'll have at the end

```
┌──────────────────┐    spawn (stdio)    ┌──────────────────────┐    HTTP    ┌────────────────────┐
│ Claude Desktop / │ ──────────────────► │ mcp-stdio-bridge.mjs │ ─────────► │ bevox daemon       │
│ Claude Code      │ ◄────────────────── │ (your laptop)        │ ◄───────── │ (your server :8787)│
└──────────────────┘                     └──────────────────────┘            └────────────────────┘
                                                                                       │
                                                                                       ▼
                                                                              Hetzner Cloud + DNS,
                                                                              Postgres (state),
                                                                              Docker / WG / restic
                                                                                       │
                                                                                       ▼
                                                                              YOUR INFRASTRUCTURE
```

Claude calls a tool → the bridge proxies to the daemon's REST API → the daemon
reconciles your declared desired state on Hetzner.

---

## Prerequisites

**On the server (where the daemon runs):**

- Linux x86_64, root or sudo. Tested on Ubuntu 24.04. ~1 GB RAM is plenty.
- Outbound HTTPS to `api.hetzner.cloud` and `dns.hetzner.com`.
- (Strongly recommended) Cloudflare Tunnel + Access (or a reverse proxy with
  TLS) in front of port 8787 — the daemon's REST surface is bearer-token
  authenticated but binds to `127.0.0.1` only. To reach it remotely you
  either tunnel (Cloudflare Tunnel is the reference deploy — see
  [`deploy/README.md`](./deploy/README.md)) or terminate TLS upstream. The
  bridge (`core/bin/mcp-stdio-bridge.mjs`) supports Cloudflare Access
  service-token headers via `BEVOX_CF_ACCESS_CLIENT_ID` /
  `BEVOX_CF_ACCESS_CLIENT_SECRET` (see Step 6).

**On your laptop (where Claude runs):**

- Node.js 20.12+ (the bridge uses native `fetch`). For the daemon's compiled
  artifact path (`node dist/main.js`), `--env-file` is used (since Node 20.6);
  the older `--env-file-if-exists` flag is not required and is not available
  on every 20.x minor.
- Claude Desktop OR Claude Code installed.

**Hetzner side:**

- A Hetzner Cloud project. Generate an API token: project → Security → API
  Tokens → Generate (Read & Write).
- A Hetzner DNS zone for any DNS-bearing manifests. Generate a separate DNS
  API token: DNS Console → API Tokens.
- A restic-compatible repository (S3, B2, SSH, etc.) + repo password if you
  want backups.

---

## 1. Provision the runtime on the server

SSH to your server. Install Node 20+, Docker (for the test Postgres
container), and git:

```bash
# Ubuntu 24.04
sudo apt-get update
sudo apt-get install -y curl git docker.io
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo usermod -aG docker $USER && newgrp docker
node --version   # expected: v20.12+ (the daemon needs --env-file-if-exists)
```

Start a Postgres container for the daemon's observed/working state. **In
production**, run a real managed Postgres or a hardened pg deployment; this
container is fine for a kickstart.

```bash
docker run -d --restart=unless-stopped --name bevox-pg \
  -e POSTGRES_USER=bevox -e POSTGRES_PASSWORD='change-me' \
  -e POSTGRES_DB=bevox \
  -p 127.0.0.1:5432:5432 \
  -v bevox-pg-data:/var/lib/postgresql/data \
  postgres:16
```

---

## 2. Get the code

```bash
git clone https://github.com/bernardTavares/bevox-hetzner-mcp.git
cd bevox-hetzner-mcp
npm --prefix core install
```

---

## 3. Configure the daemon (`core/.env`)

`core/.env` is **gitignored** — never commit it. Use `core/.env.example` as
the template (every REQUIRED key is documented inline) and fill the real
values:

```bash
cp core/.env.example core/.env
nano core/.env
```

Minimum required keys for a productive boot:

| Key | What | Where to get it |
|---|---|---|
| `DATABASE_URL` | Postgres for observed + working state + advisory locks. | `postgres://bevox:change-me@127.0.0.1:5432/bevox` |
| `HCLOUD_TOKEN` | Hetzner Cloud API token. | Hetzner project → Security → API Tokens. |
| `HCLOUD_DNS_TOKEN` | Hetzner DNS API token (separate product). | Hetzner DNS Console → API Tokens. |
| `RESTIC_REPO` | restic repository URL. | Your bucket/SSH/local path. |
| `RESTIC_PASSWORD` | restic repo password. | Whatever you set when initializing. |
| `SSH_HOST` / `SSH_USER` / `SSH_PRIVATE_KEY` | Where Docker + WireGuard transports SSH to. | Your fleet's control SSH (paste the PEM; `\n` for newlines on single-line loaders). |
| `AGENT_CREDENTIALS` | JSON map `token → {actor, capabilities}`. **This is how agents authenticate.** | You mint these. See below. |
| `PORT` (optional) | REST listen port. | Default `8787`. |

### Mint an agent token

The simplest credential map for one agent with full scope:

```bash
# Generate a strong token (don't use a real one in shell history; this is
# illustrative — pipe through `xclip`/`pbcopy` or write directly into .env)
openssl rand -hex 32
# → e.g. 7f5b1c9d...   (call this $TOKEN)
```

In `core/.env`, set:

```ini
AGENT_CREDENTIALS={"7f5b1c9d...":{"actor":"agent:you","capabilities":["get_state","diff","events","health","provision_server","deploy_service","scale_service","set_dns","snapshot","restore","destroy","apply_manifest"]}}
```

That's the full v1 12-tool capability set. For least-privilege, scope it
down (a read-only agent: `["get_state","diff","events","health"]`). v2 tools
have their own capability vocabulary (`set_firewall`, `set_certificate`,
`set_load_balancer`, `set_ingress`, `set_primary_ip`, `expose_service`,
`resolve_selector`) — add the ones the agent needs.

---

## 4. Boot the daemon

```bash
npm --prefix core start
```

You should see structured logs ending with something like
`bevox daemon started (REST+MCP+reconciler)`. The REST API is now on `PORT`
(default 8787); the periodic reconciler runs every `RECONCILE_INTERVAL_MS`
(default 60 s).

Smoke test from another shell on the server:

```bash
curl -s http://127.0.0.1:8787/api/health \
  -H "Authorization: Bearer $TOKEN" | head
```

Expected: a JSON `HealthReport` with `circuit_breakers`, `degraded`,
`blocked`, `drift`, `reconciler` keys.

### Run as a systemd service

For unattended operation:

For a **kickstart**, you can run `ExecStart=npm --prefix core start` (uses
`tsx`; reads `src/` directly — fine for trying it out). For a **production**
unit, build the daemon first and run the compiled artifact with `node` +
`--env-file`:

```bash
npm --prefix core run build      # produces core/dist/main.js
                                 # AND copies SQL migrations into dist/store/migrations/
```

```ini
# /etc/systemd/system/bevox-hetzner-mcp.service
[Unit]
Description=bevox-hetzner-mcp daemon
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=bevox
Group=bevox
WorkingDirectory=/home/bevox/bevox-hetzner-mcp/core
Environment=HOME=/home/bevox
Environment=NODE_ENV=production
# Absolute node path is safer for systemd (env-managed `node` symlinks may not
# be stable). Adjust to match your installation.
ExecStart=/usr/bin/node --env-file=.env dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bevox-hetzner-mcp
journalctl -u bevox-hetzner-mcp -f
```

---

## 5. Expose the daemon to your laptop

The daemon listens on `127.0.0.1:8787` by default. Two safe ways for your
laptop to reach it:

### Option A — SSH tunnel (simplest, no public exposure)

```bash
# On your laptop:
ssh -N -L 8787:127.0.0.1:8787 your-server
```

Leave it running. The daemon is now reachable at `http://localhost:8787` from
your laptop.

### Option B — Reverse proxy with TLS

Put nginx/caddy in front of `127.0.0.1:8787` on the server, terminate TLS
publicly, and use `https://bevox.your-domain.com` as the bridge URL. The
bearer token is the only auth — do not skip TLS for public exposure.

### Option C — Cloudflare Tunnel + Access (reference deploy)

This is what the reference deployment under `deploy/` uses. The daemon
stays loopback-only; `cloudflared` runs as a systemd service and connects
your hostname through Cloudflare's edge. Cloudflare Access (service token,
`non_identity` policy) becomes the edge gate; the bearer token remains the
origin gate (defense-in-depth — both must be satisfied).

See [`deploy/README.md`](./deploy/README.md) for the full runbook: tunnel
creation, DNS, Access app + policy, systemd unit, verification.

When using Access, the bridge needs the service-token headers — see Step 6
for the env vars to pass to `claude mcp add`.

---

## 6. Wire Claude to the daemon (MCP)

Install the bridge somewhere stable on your laptop (e.g. clone the repo
there too, then run `npm --prefix core install`). The bridge is just one
file: `core/bin/mcp-stdio-bridge.mjs` — pure ESM, no build step.

### Claude Desktop

Edit (or create) the MCP config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bevox-hetzner": {
      "command": "node",
      "args": ["/absolute/path/to/bevox-hetzner-mcp/core/bin/mcp-stdio-bridge.mjs"],
      "env": {
        "BEVOX_REST_URL": "http://localhost:8787",
        "BEVOX_AGENT_TOKEN": "7f5b1c9d..."
      }
    }
  }
}
```

Restart Claude Desktop. The tools should appear in the tool picker
(`get_state`, `provision_server`, `expose_service`, ...).

### Claude Code

```bash
# Local daemon (Option A — SSH tunnel) or plain reverse proxy without Access:
claude mcp add bevox-hetzner \
  --env BEVOX_REST_URL=http://localhost:8787 \
  --env BEVOX_AGENT_TOKEN=7f5b1c9d... \
  -- node /absolute/path/to/bevox-hetzner-mcp/core/bin/mcp-stdio-bridge.mjs

# Behind Cloudflare Tunnel + Access (Option C):
claude mcp add bevox-hetzner \
  --env BEVOX_REST_URL=https://bevox.your-domain.com \
  --env BEVOX_AGENT_TOKEN=7f5b1c9d... \
  --env BEVOX_CF_ACCESS_CLIENT_ID=<service-token-client-id> \
  --env BEVOX_CF_ACCESS_CLIENT_SECRET=<service-token-secret> \
  -- node /absolute/path/to/bevox-hetzner-mcp/core/bin/mcp-stdio-bridge.mjs
```

Then in a Claude Code session:

```
> /mcp                          # list connected MCP servers
> ask Claude to call get_state  # should round-trip to the daemon
```

---

## 7. First useful round-trip

In a Claude session, prompt:

> Call `get_state` and summarize what's currently declared.

The bridge proxies to `GET /api/health` first if you wish (use `health`),
then `get_state` returns the desired + observed snapshot. A fresh daemon
has empty collections — that's correct.

Next, declare your first server. Ask Claude to call:

```json
{
  "tool": "provision_server",
  "args": {
    "dry_run": true,
    "server": {
      "name": "bevox-app-1",
      "type": "cx32",
      "location": "nbg1",
      "image": "ubuntu-24.04",
      "ssh_keys": ["your-pre-uploaded-key-name"],
      "labels": { "app": "demo" }
    }
  }
}
```

`dry_run: true` returns a `planned` envelope showing the diff and the
estimated impact — **no Hetzner mutation happens**. Re-run with
`dry_run: false` to actually apply (a destructive or cost-bearing op
returns `pending_approval` with an `approval_id` — approve via the
`approve` tool when you're ready).

For a public-edge example end-to-end (cert + LB + ingress):

```json
{
  "tool": "expose_service",
  "args": {
    "service": "bevox-web",
    "hostname": "app.your-domain.com",
    "tls": "managed",
    "dry_run": true
  }
}
```

---

## 8. Operations cheat-sheet

| Action | Command |
|---|---|
| View daemon logs | `journalctl -u bevox-hetzner-mcp -f` |
| Restart daemon | `sudo systemctl restart bevox-hetzner-mcp` |
| Verify Postgres | `docker exec -it bevox-pg psql -U bevox -d bevox -c '\dt'` |
| Inspect state events | `curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8787/api/events?actor=agent:you'` |
| List pending approvals | `curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8787/api/approvals'` |
| Daemon health | `curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8787/api/health'` |
| Bridge dry-run from laptop | `BEVOX_REST_URL=http://localhost:8787 BEVOX_AGENT_TOKEN=... node core/bin/mcp-stdio-bridge.mjs` (then send JSON-RPC manually) |

---

## 9. Troubleshooting

**`loadConfig failed: <KEY> is required`** — a `.env` key was missing or
empty. The daemon fails fast value-free — no secret material ever reaches a
log. Re-check `core/.env.example` for the required keys.

**Bridge connects but every tool returns `HTTP 401`** — `BEVOX_AGENT_TOKEN`
doesn't match a key in `AGENT_CREDENTIALS` on the daemon. Token never leaves
the bridge env, never appears in URLs/logs.

**Bridge connects but tools return `HTTP 403`** — token is valid but lacks
the capability for that tool. Add the capability to that token's entry in
`AGENT_CREDENTIALS` and restart the daemon (the credential map is
load-time, not hot-reloaded).

**`pending_approval` envelopes pile up** — that's correct for destructive /
cost-bearing operations. Approve them via the `approve` tool (or
`POST /api/approvals/:id/approve`). The default TTL is 24h; expired
approvals become `cancelled` and you can re-issue.

**Daemon won't accept Hetzner calls (`HTTP 401` from Hetzner)** — the
`HCLOUD_TOKEN` is wrong or revoked. Mint a new one and restart.

**`drift` events appear in the audit trail** — that's the intended fail-safe
signal: something on Hetzner changed outside of the desired state. The
reconciler **reports drift, never silently corrects**. Inspect via
`get_state` + `events`, decide manually whether to converge.

---

## 10. What's next

- **Production hardening:** read `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
  (v1 spec) and `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
  (v2 contract). Both define invariants you must not weaken.
- **Real Postgres:** the test container is fine for a kickstart; for
  production, run managed Postgres with backups + monitoring.
- **TLS + auth at the edge:** the daemon's REST is bearer-token only. Put a
  reverse proxy with TLS in front for any non-loopback exposure.
- **Per-agent capability scoping:** mint distinct tokens per agent with the
  minimum capability set each needs. Capabilities show up in every
  `StateEvent`, so this is also your audit story.
- **Backup the Postgres volume** (`bevox-pg-data`). Lose it and you lose
  the observed/working state + audit trail.
- **Roadmap:** Blocos B (HA/DR), C (PolicyEngine + capability tokens), D
  (observability + cost) — see the v2 contract.

---

## Reference

- v1 design spec: [`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`](docs/specs/2026-05-17-bevox-hetzner-mcp-design.md)
- v2 architecture contract: [`docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`](docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
- v2 Bloco A spec-filha: [`docs/specs/2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md`](docs/specs/2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md)
- v1 console contract (frozen): [`console/CONTRACT.md`](console/CONTRACT.md)
- v2 contract appendix: [`console/CONTRACT-v2.md`](console/CONTRACT-v2.md)
- Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
