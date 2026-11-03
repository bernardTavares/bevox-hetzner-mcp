# Reference deployment

A single-host deployment of the daemon (REST + MCP + reconciler) behind a
Cloudflare Tunnel protected by Cloudflare Access. This is how the original
alpha ran in production; adapt names, paths and hostnames to your setup.

```
 AI agent / MCP client ──HTTPS──▶ Cloudflare edge (Access: service tokens)
                                         │
                                         ▼ dedicated tunnel
                              cloudflared (systemd)
                                         │ http://127.0.0.1:8787
                                         ▼
                         bevox-daemon (systemd) ──▶ Postgres 16 (docker)
                                         │
                                         ▼
                           Hetzner Cloud API · Docker over SSH
```

## Components

| File | Purpose |
|---|---|
| `postgres/docker-compose.yml` | Postgres 16 for working state and the event log |
| `systemd/bevox-daemon.service` | The control-plane daemon (`core/dist/main.js`) |
| `cloudflared/config.yml` | Dedicated tunnel config; replace `<TUNNEL_UUID>` and the hostname |
| `systemd/cloudflared-bevox-hetzner-mcp.service` | Runs the tunnel with an explicit `--config` |
| `runbook-secrets-go-live.md` | Enabling the sops + age secret resolver |

## Steps

1. **Database:** `docker compose -f deploy/postgres/docker-compose.yml up -d`.
2. **Build:** `npm --prefix core ci && npm --prefix core run build`.
3. **Configure:** `cp core/.env.example core/.env`, then set `DATABASE_URL`, the Hetzner tokens and `AGENT_CREDENTIALS` (capability-scoped credentials, one per agent).
4. **Daemon:** install `systemd/bevox-daemon.service` and enable it. Check that `curl -s 127.0.0.1:8787/health` answers.
5. **Tunnel:**
   - `cloudflared tunnel create bevox-hetzner-mcp`;
   - route your hostname to it;
   - fill in `cloudflared/config.yml`;
   - install the tunnel unit.
6. **Edge auth:** put the hostname behind a Cloudflare Access application that accepts **service tokens only**. Each agent gets its own token on top of its daemon credential.
7. **MCP clients:** point `core/bin/mcp-stdio-bridge.mjs` at the public URL. Note that the bridge does not send Access headers itself, so wrap it or inject `CF-Access-Client-Id` / `CF-Access-Client-Secret`.

## Security notes

- Keep tunnel credentials and `core/.env` at mode `0400` / `0600`, readable only by the service user.
- The daemon never deletes resources on failure paths. Destructive and cost-bearing operations wait in the Approval Gate.
- Secrets are resolved only at apply time and never appear in plans, logs or observed state (see `SECURITY.md`).
