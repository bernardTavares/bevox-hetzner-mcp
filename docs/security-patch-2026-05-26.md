# Patch proposto para `SECURITY.md` — 2026-05-26

`SECURITY.md` é deliberadamente protegido contra edição automatizada (rule
`fail-safe` + `PreToolUse-guard.sh` + `deny` em `.claude/settings.json`).
Mudanças requerem PR humano explícito.

Este arquivo descreve **o que aplicar** após o go-live (Phase A + B
deployment + bridge CF Access). Aplique manualmente quando aprovar.

## Como aplicar

Abra `SECURITY.md` num editor e **acrescente as duas seções abaixo logo
após a seção `## Secret hygiene`** (no final do arquivo). Não modifique
seções existentes.

## Conteúdo a acrescentar

````markdown
## Deployment posture (defense-in-depth)

The reference deployment under `deploy/` and the daemon's wire surface
assume the following posture; deviations should be reasoned about
explicitly:

- **Loopback-only origin.** The daemon binds to `127.0.0.1:8787`. It never
  listens on a public interface in any shipped configuration. Edge
  exposure is via Cloudflare Tunnel (`cloudflared`) only — the reference
  deploy uses a named tunnel published to a single hostname.
- **Two-layer authentication for remote callers.** The edge enforces a
  Cloudflare Access policy (the reference deploy uses `non_identity` +
  service token). The origin enforces a bearer token resolved from
  `AGENT_CREDENTIALS`. Either layer alone rejects an unauthorized
  request; together they form defense-in-depth, and they fail
  independently — Access denial returns an Access-branded 403; daemon
  denial returns the contract `ApiError` JSON envelope.
- **Capability scope per token.** Each entry in `AGENT_CREDENTIALS`
  carries an `actor` and a `capabilities` allowlist over the FROZEN tool
  vocabulary (v1 12 tools + v2 7 tools). Capabilities outside this
  vocabulary are silently filtered out at mint time. Tokens are minted
  per agent / consumer project, not shared. Capability denial occurs
  *before* any desired-state mutation or reconcile (deny-before-write).

## Secrets outside the repo

These files live on the operator's host with `0600` permissions and are
never committed. A leaked secret in any of them is high-severity; rotate
immediately and report under the channels listed above.

| Path | Contents | Used by |
|---|---|---|
| `core/.env` | DB URL, Hetzner / DNS tokens, restic password, SSH private key, `AGENT_CREDENTIALS`, AWS S3 keys (Object Storage for restic) | daemon process |
| `deploy/postgres/.env` | Postgres password for the local container | docker compose (Postgres) |
| `~/.cloudflared/<tunnel-uuid>.json` | Cloudflare Tunnel connector credentials | `cloudflared.service` |
| `~/.cf-access-svc-token` | Cloudflare Access service-token client id + secret (for remote MCP consumers) | bridge / consumer projects |
| `~/.hcloud-token` | Hetzner Cloud API token (operator scope) | setup scripts only — NOT consumed by the daemon at runtime |
| `~/.hetzner-dns-token` | Hetzner DNS API token (operator scope) | setup scripts only |
| `~/.hetzner-s3-creds` | S3 access/secret + endpoint + bucket for Hetzner Object Storage | setup scripts to initialize the restic repo |
| `~/.bevox-restic-password` | Restic repository password (mirror of `RESTIC_PASSWORD` in `core/.env`) | restic CLI invocations |
| `~/.ssh/bevox_mcp` | SSH private key dedicated to the daemon (no passphrase, scoped to one managed host) | daemon's SSH transports |

Rotation policy (operator-driven):

- Bearer tokens in `AGENT_CREDENTIALS`: rotate when an agent / consumer
  leaves; the credential map is load-time, so a restart is required.
- Cloudflare Access service token: rotate via dashboard / API; update
  `~/.cf-access-svc-token` on each consumer.
- Hetzner Cloud / DNS tokens: rotate per provider best practice; only
  used by setup scripts, so an in-flight daemon is unaffected.
- SSH key: rotate by generating a new pair, uploading the public side to
  the managed host's `authorized_keys`, updating `SSH_PRIVATE_KEY` in
  `core/.env`, restarting the daemon, and finally removing the old public
  key from the host.
````

## Justificativa

- Spec do go-live (`docs/specs/2026-05-25-go-live-cloudflare-tunnel.md`)
  define explicitamente esta postura como o modelo de deploy de referência.
- Bridge passou a suportar headers CF Access (PR
  `feat/bridge-cf-access-headers`), portanto a postura "defense-in-depth"
  é agora a recomendação default.
- Adição é **puramente aditiva** — não modifica nada de "Reporting",
  "Response timeline", "Scope" ou "Secret hygiene".

Após aplicar e commitar (no mesmo PR que mergeia este `docs/post-go-live-refresh`
ou em PR próprio), pode deletar este arquivo (`docs/security-patch-2026-05-26.md`).
