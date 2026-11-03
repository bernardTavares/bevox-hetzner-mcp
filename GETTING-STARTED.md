# Getting started

This guide takes you from zero to an AI agent (Claude Code or Claude Desktop) managing your Hetzner Cloud project through `bevox-hetzner-mcp`:
- what you need before you start, and which credentials;
- installing and configuring the daemon;
- giving agents scoped tokens;
- connecting Claude;
- the first safe calls.

**Time:** about 45 minutes with a fresh Linux VM and a Hetzner account.

```
┌──────────────────┐  stdio  ┌──────────────────────┐  HTTPS/REST  ┌─────────────────────────┐
│ Claude Code /    │ ──────► │ mcp-stdio-bridge.mjs │ ───────────► │ bevox-hetzner-mcp daemon │
│ Claude Desktop   │ ◄────── │ (your laptop)        │ ◄─────────── │ (your server, :8787)    │
└──────────────────┘         └──────────────────────┘              └────────────┬────────────┘
                                                                                │
                                         Hetzner Cloud API · Hetzner DNS API · Postgres (state + audit)
                                         Docker over SSH · WireGuard · restic
```

Claude calls a tool. The bridge forwards it to the daemon's REST API with your agent token. The daemon plans the change, holds anything destructive or billable for approval, applies it, and records an audit event.

---

## 1. What you need

### Credentials and accounts

The daemon **refuses to boot** unless every key marked *required* is set and non-empty (`core/src/config.ts`). It fails fast and never prints a secret value. If you don't use a feature, you can give its keys a placeholder value. The table says when that's safe.

| Env key | Required | Used for | How to get it | Not using the feature? |
|---|:-:|---|---|---|
| `HCLOUD_TOKEN` | ✅ | Servers, networks, volumes, firewalls, load balancers, certificates, primary IPs | Hetzner Cloud Console → your project → **Security → API tokens → Generate**, with **Read & Write** access | Always needed: it is the point of the tool |
| `HCLOUD_DNS_TOKEN` | ✅ | `set_dns`, and DNS records created by `set_ingress` / `expose_service` | Hetzner **DNS Console** → API tokens. It is a separate product from Cloud. | Any placeholder works if you never declare DNS records |
| `DATABASE_URL` | ✅ | Desired, observed and working state, advisory locks, the approval queue and the audit trail | Your own Postgres 16 (step 3) | Always needed |
| `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` | ✅ | Docker over SSH (`deploy_service`), WireGuard mesh, restic | An SSH key pair. Upload the **public** key to Hetzner Cloud (**Security → SSH keys**) and reference it by name in `servers[].ssh_keys` so Hetzner injects it when it creates a server. | Placeholders boot fine **if** you set `MANAGED_MESH=off` and `MANAGED_SERVICES=off` (Cloud-API-only mode, step 4) |
| `RESTIC_REPO`, `RESTIC_PASSWORD` | ✅ | `snapshot` / `restore` | Any restic backend (S3, B2, SFTP…) plus the repository password you choose | Placeholders work if you never declare `backups[]` |
| `SECRETS_FILE`, `SOPS_AGE_KEY_FILE` | ✅ | Encrypted app secrets injected into containers at apply time (`env: { KEY: "secret:<ref>" }`) | Created with `sops` + `age` (step 3). **Absolute paths**; `~` is not expanded. | Always needed: the daemon checks the key file at boot |
| `AGENT_CREDENTIALS` | ✅ | Bearer tokens for agents and humans, each with an actor name and a capability list | You mint them (step 5) | Always needed |

### Software

- **Server** (where the daemon runs): Linux x86_64, Node.js **20.12+**, Docker (only for the Postgres container below), `sops` and `age`.
- **Laptop** (where Claude runs): Node.js 20.12+ and a copy of `core/bin/mcp-stdio-bridge.mjs`. It is a single ESM file with no dependencies.

---

## 2. Install

```bash
# On the server (Ubuntu 24.04 example)
sudo apt-get update && sudo apt-get install -y git docker.io sops age
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
node --version          # v20.12 or newer

git clone https://github.com/bernardTavares/bevox-hetzner-mcp.git
cd bevox-hetzner-mcp
npm --prefix core install
```

---

## 3. Postgres and the secrets file

**Postgres** (fine for a first run; use a managed or hardened Postgres in production):

```bash
docker run -d --restart=unless-stopped --name hmcp-pg \
  -e POSTGRES_USER=hmcp -e POSTGRES_PASSWORD='choose-a-password' -e POSTGRES_DB=hmcp \
  -p 127.0.0.1:5432:5432 -v hmcp-pg-data:/var/lib/postgresql/data postgres:16
```

The daemon creates its own tables on boot.

**Secrets (sops + age).** App secrets live in one encrypted YAML file. Plans, logs and observed state only ever carry *references* (`secret:<name>`), never values.

```bash
mkdir -p ~/.config/hmcp
age-keygen -o ~/.config/hmcp/age.key
chmod 600 ~/.config/hmcp/age.key                     # boot enforces 0600 + owned by the daemon user
AGE_PUB=$(grep "^# public key:" ~/.config/hmcp/age.key | cut -d' ' -f4)

# Create the file with a first entry
SOPS_AGE_KEY_FILE=~/.config/hmcp/age.key \
  sops --age "$AGE_PUB" --set '["init"] "ok"' ~/.config/hmcp/secrets.enc.yaml
```

To add a real secret later, for example a database URL that a container needs:

```bash
SOPS_AGE_KEY_FILE=~/.config/hmcp/age.key \
  sops --set '["app-database-url"] "postgres://..."' ~/.config/hmcp/secrets.enc.yaml
```

**Back up `age.key` somewhere else.** Without it the secrets file can never be decrypted, by design. Rotation and hardening are covered in [`deploy/runbook-secrets-go-live.md`](./deploy/runbook-secrets-go-live.md).

---

## 4. Configure `core/.env`

```bash
cp core/.env.example core/.env
chmod 600 core/.env
```

`core/.env` is gitignored. Every key is documented inline in `core/.env.example`. Write values **raw and unquoted**: Node's `--env-file` keeps quotes as part of the value.

### Profile A: full (Cloud API + Docker services + mesh + backups)

```ini
DATABASE_URL=postgres://hmcp:choose-a-password@127.0.0.1:5432/hmcp
HCLOUD_TOKEN=<cloud-token>
HCLOUD_DNS_TOKEN=<dns-token>
RESTIC_REPO=s3:https://s3.example.com/my-bucket
RESTIC_PASSWORD=<restic-password>
SSH_HOST=<ip-or-hostname-of-the-docker-host>
SSH_USER=<ssh-user>
SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----
SECRETS_FILE=/home/<user>/.config/hmcp/secrets.enc.yaml
SOPS_AGE_KEY_FILE=/home/<user>/.config/hmcp/age.key
AGENT_CREDENTIALS=<see step 5>
```

`SSH_PRIVATE_KEY` goes on **one line** with literal `\n`. To produce it from a key file:

```bash
awk 'BEGIN{ORS="\\n"}1' ~/.ssh/hmcp_daemon
```

### Profile B: Cloud API only (you run containers yourself, e.g. with k3s)

Same as A, but SSH and restic get placeholders and the daemon never opens SSH:

```ini
MANAGED_MESH=off
MANAGED_SERVICES=off
SSH_HOST=unused
SSH_USER=unused
SSH_PRIVATE_KEY=unused
RESTIC_REPO=unused
RESTIC_PASSWORD=unused
```

In this mode, declaring a `services[]` entry is rejected at plan time on purpose.

### Optional knobs

| Key | Default | What it does |
|---|---|---|
| `PORT` | `8787` | REST port. The daemon binds to `127.0.0.1` only. |
| `RECONCILE_INTERVAL_MS` | `60000` | Background reconcile cycle |
| `DRIFT_SWEEP_INTERVAL_MS` | `300000` | Drift detection sweep |
| `LOG_LEVEL` | `info` | Pino log level |
| `SSH_PORT`, `SSH_HOST_KEY_POLICY`, `SSH_KNOWN_HOSTS` | `22`, `accept-new`, OpenSSH default | Host-key trust. `accept-new` trusts a new key on first contact and refuses one that changed. Set `yes` plus a curated `SSH_KNOWN_HOSTS` for the strictest mode. |
| `REGISTRY_AUTH_REFS` | none | Private registries: `{"ghcr.io":"ghcr-pat"}`, where the value is a secret ref holding `{"username":…,"password":…}` |
| `STRICT_MANIFEST_APPROVAL` | off | Route every `apply_manifest` through approval |

---

## 5. Agent tokens and capabilities

`AGENT_CREDENTIALS` is a JSON map from **bearer token** to **who it is** and **what it may call**:

```ini
AGENT_CREDENTIALS={"<token-1>":{"actor":"agent:claude","capabilities":["get_state","diff","events","health","provision_server","deploy_service","set_dns","snapshot"]},"<token-2>":{"actor":"human:you","capabilities":["get_state","diff","events","health"]}}
```

- Generate each token with `openssl rand -hex 32`. Never reuse a token across agents.
- The `actor` is written into every audit event and every approval.
- **Capabilities are tool names.** An unknown name is silently dropped. For example, `"read"` grants nothing.
- The map is read at boot. Restart the daemon after you change it.

### The tool catalog

| Tool | Capability | What happens when called |
|---|---|---|
| `get_state`, `diff`, `events`, `health` | same name | Read only |
| `set_dns`, `snapshot` | same name | Applied directly (non-destructive), audited |
| `deploy_service`, `scale_service`, `apply_manifest` | same name | Applied directly **unless** the plan contains a destructive or billable change, which then waits for approval |
| `provision_server`, `restore`, `destroy` | same name | **Always** waits for approval |
| `resolve_selector` | same name | Read only (v2) |
| `set_firewall`, `set_ingress` | same name | Public-edge resources (v2). Creating one is applied directly; a destructive change (removing rules, swapping an ingress hostname or load balancer) waits for approval. |
| `set_certificate`, `set_load_balancer`, `set_primary_ip` | same name | **Always** waits for approval (v2) |
| `expose_service` | same name | Certificate + load balancer + firewall + DNS for one service, behind **one bundled approval** (v2) |
| `list_approvals`, `approve`, `reject` | none (any valid token) | Approval lifecycle |

Every mutating tool accepts `dry_run: true`, which returns the plan and changes nothing.

### Recipes

- **Read-only observer:** `["get_state","diff","events","health","resolve_selector"]`
- **Day-to-day operator agent:** the observer set plus `deploy_service`, `scale_service`, `set_dns`, `snapshot`, `apply_manifest`
- **Full v1 + public edge:** every name in the table above

> ⚠️ **Known limitation: approval is not separation of duties yet.** Any valid token can approve or reject any pending request, **including one its own actor created**. The bridge also exposes `approve` to the agent. Every resolution is audited with the resolver's actor, but nothing in v1 stops an agent from approving itself.
>
> Until per-actor approval rights exist:
> - tell your agent never to call `approve` or `reject`;
> - approve yourself over REST with a separate human token (step 8);
> - review `events` regularly.

---

## 6. Boot the daemon

```bash
npm --prefix core start          # tsx, reads core/.env
```

Smoke test from another shell on the server:

```bash
curl -s http://127.0.0.1:8787/api/health -H "Authorization: Bearer <token-1>"
```

You should get a JSON health report with `circuit_breakers`, `degraded`, `blocked`, `drift` and `reconciler`.

**As a systemd service (production):** build once, then run the compiled artifact.

```bash
npm --prefix core run build      # core/dist/main.js + SQL migrations
```

```ini
# /etc/systemd/system/hetzner-mcp.service
[Unit]
Description=bevox-hetzner-mcp daemon
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=hmcp
WorkingDirectory=/home/hmcp/bevox-hetzner-mcp/core
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --env-file=.env dist/main.js
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
LimitCORE=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now hetzner-mcp
journalctl -u hetzner-mcp -f
```

---

## 7. Reach the daemon from your laptop and connect Claude

The daemon listens on loopback only. Pick one of three ways in:

| Option | How | When |
|---|---|---|
| **SSH tunnel** | `ssh -N -L 8787:127.0.0.1:8787 your-server`, then use `http://localhost:8787` | Simplest, nothing exposed publicly |
| **Reverse proxy + TLS** | nginx or Caddy in front of `127.0.0.1:8787` | Never expose it without TLS: the bearer token is the only credential |
| **Cloudflare Tunnel + Access** | The reference deploy, see [`deploy/README.md`](./deploy/README.md) | Two gates: an Access service token at the edge, the bearer token at the origin |

**Bridge environment variables:**

| Variable | Required | Value |
|---|:-:|---|
| `BEVOX_REST_URL` | ✅ | `http://localhost:8787` or your HTTPS URL |
| `BEVOX_AGENT_TOKEN` | ✅ | The agent's token from `AGENT_CREDENTIALS` |
| `BEVOX_CF_ACCESS_CLIENT_ID`, `BEVOX_CF_ACCESS_CLIENT_SECRET` | only behind Cloudflare Access | The service-token pair |

**Claude Code:**

```bash
claude mcp add hetzner \
  --env BEVOX_REST_URL=http://localhost:8787 \
  --env BEVOX_AGENT_TOKEN=<token-1> \
  -- node /absolute/path/to/bevox-hetzner-mcp/core/bin/mcp-stdio-bridge.mjs
```

Behind Cloudflare Access, add `--env BEVOX_CF_ACCESS_CLIENT_ID=… --env BEVOX_CF_ACCESS_CLIENT_SECRET=…`. Then run `/mcp` in a session to confirm the server is connected.

**Claude Desktop:** add this to `claude_desktop_config.json`. On macOS it lives in `~/Library/Application Support/Claude/`, on Windows in `%APPDATA%\Claude\`, and on Linux in `~/.config/Claude/`.

```json
{
  "mcpServers": {
    "hetzner": {
      "command": "node",
      "args": ["/absolute/path/to/bevox-hetzner-mcp/core/bin/mcp-stdio-bridge.mjs"],
      "env": { "BEVOX_REST_URL": "http://localhost:8787", "BEVOX_AGENT_TOKEN": "<token-1>" }
    }
  }
}
```

---

## 8. First calls

**1. Look around.** Ask Claude to *"call `health` and `get_state` and summarise."* A fresh daemon has empty collections, which is expected.

**2. Plan a server without touching anything:**

```json
{ "tool": "provision_server", "args": { "dry_run": true, "server": {
  "name": "app-1", "type": "cx22", "location": "nbg1", "image": "ubuntu-24.04",
  "ssh_keys": ["my-uploaded-key"], "labels": { "app": "demo" } } } }
```

You get a `planned` envelope with the diff and the estimated impact. Nothing changes at Hetzner.

**3. Apply it.** Call it again with `"dry_run": false`. A server costs money, so the answer is `pending_approval` with an `approval_id`. **Approve it yourself** with your human token:

```bash
curl -s -H "Authorization: Bearer <token-2>" http://127.0.0.1:8787/api/approvals
curl -s -X POST -H "Authorization: Bearer <token-2>" \
  http://127.0.0.1:8787/api/approvals/<approval_id>/approve
```

The next reconcile cycle applies it. Approvals expire after 24 hours, and an expired request becomes `cancelled`.

**4. Work declaratively.** `apply_manifest` takes a whole desired state and reconciles it idempotently. Running it again is how you recover.

```json
{ "tool": "apply_manifest", "args": { "dry_run": true, "manifest": {
  "servers":  [{ "name": "app-1", "type": "cx22", "location": "nbg1", "image": "ubuntu-24.04", "ssh_keys": ["my-uploaded-key"] }],
  "services": [{ "name": "web", "image": "nginx:1.27", "replicas": 1, "ports": ["80"],
                 "env": { "DATABASE_URL": "secret:app-database-url" } }],
  "dns":      [{ "zone": "example.com", "name": "app", "type": "A", "value": "203.0.113.10", "ttl": 300 }]
} } }
```

The full manifest schema is in [`docs/manifest-schema-cheatsheet.md`](./docs/manifest-schema-cheatsheet.md) (in Portuguese). Two traps worth knowing:
- unknown fields *inside* an item are silently dropped; only the top level is strict;
- `secret:<ref>` in `env` is the only way to pass a secret.

**5. Put a service on the internet over HTTPS.** Run this as a dry run first:

```json
{ "tool": "expose_service", "args": { "service": "web", "hostname": "app.example.com", "tls": "managed", "dry_run": true } }
```

---

## 9. How it behaves (so nothing surprises you)

- **Drift is reported, never silently fixed.** If someone changes a resource in the Hetzner console, you get a `drift` event. You decide whether to converge.
- **Fail-safe by construction.** No failure path deletes a resource you didn't explicitly ask to remove. Destructive operations always go through approval.
- **Secrets stay out of everything except the apply.** Plans, logs, events and observed state only carry `secret:<ref>`. Values are decrypted at apply time, behind an internal token that can't be forged.
- **Everything is audited.** Each state change is a `StateEvent` with the actor, the effective capability scope and the approval that authorised it.
- ⚠️ **Adopting existing infrastructure.** The daemon knows only what it created or observed. If `get_state` shows empty lists while you already have servers running (a fresh install, or a wiped database), `apply_manifest` will plan to **create everything from scratch**, new servers included. Always run it with `dry_run: true` first and read the plan. There is no automatic state backfill for existing resources yet.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `invalid configuration: missing or invalid required key(s): …` | A required key is empty. Placeholders are fine for unused features (step 1). |
| Boot fails on the age key | `SOPS_AGE_KEY_FILE` must be an absolute path, mode `0600`, owned by the daemon's user |
| Every tool returns HTTP 401 | `BEVOX_AGENT_TOKEN` doesn't match a key in `AGENT_CREDENTIALS` |
| A tool returns HTTP 403 | The token is valid but lacks that capability. Add the tool name and restart. |
| HTTP 401 from Hetzner | `HCLOUD_TOKEN` is wrong, revoked, or read-only |
| `pending_approval` keeps piling up | Expected for destructive or billable operations. Approve over REST (step 8). |
| A declared `services[]` entry is rejected | You are in Cloud-API-only mode (`MANAGED_SERVICES=off`) |

Useful commands:

```bash
curl -H "Authorization: Bearer $T" 'http://127.0.0.1:8787/api/events?actor=agent:claude'   # audit trail
curl -H "Authorization: Bearer $T" 'http://127.0.0.1:8787/api/approvals'                   # approvals
docker exec -it hmcp-pg psql -U hmcp -d hmcp -c '\dt'                                       # state tables
```

---

## Going further

- **Production checklist:**
  - use a managed or backed-up Postgres (it holds the audit trail);
  - put TLS in front of the daemon;
  - give each agent its own token with the smallest capability set it needs;
  - keep the age key offsite;
  - apply the systemd hardening in [`deploy/runbook-secrets-go-live.md`](./deploy/runbook-secrets-go-live.md).
- **Design:** the [v1 design spec](./docs/specs/2026-05-17-bevox-hetzner-mcp-design.md) and the [v2 architecture contract](./docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md), both in Portuguese.
- **Contributing and the test setup:** [`CONTRIBUTING.md`](./CONTRIBUTING.md).
