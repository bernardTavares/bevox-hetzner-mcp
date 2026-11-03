# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `bevox-hetzner-mcp`, **do not open a
public issue**. Instead, report it privately so we can fix it before it is
disclosed.

**Preferred channel:** GitHub Security Advisories
→ <https://github.com/bernardTavares/bevox-hetzner-mcp/security/advisories/new>


When reporting, please include:

- Affected component (`core/`, `console/`, specific provider/tool, etc.).
- Affected version / commit SHA.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- Observed impact (e.g. credential disclosure, privilege escalation, data
  destruction, denial of service).
- Any mitigations you have already identified.

## Response timeline

- **Acknowledgement:** within 3 business days.
- **Triage + severity assessment:** within 7 business days.
- **Fix or mitigation plan:** depends on severity; we aim for a coordinated
  disclosure within 90 days of triage.

## Scope

In-scope:

- `core/` agent control plane (MCP server, REST API, reconciler, providers).
- `console/` operational frontend.
- Documentation and configuration that, if followed, would produce an insecure
  deployment.
- Default configurations shipped in the repository.

Out-of-scope:

- Vulnerabilities in upstream dependencies — please report those upstream
  (Hetzner Cloud API, restic, Docker Engine, WireGuard, PostgreSQL, etc.). We
  will update the dependency once a fix is available.
- Issues that require physical access to the operator's machine or already
  having operator-level credentials.
- Self-XSS or any vulnerability that requires the victim to disable browser
  security features.
- Best-practice deviations without a concrete exploit path.

## Hall of fame

We will credit responsible reporters in the release notes of the fix (unless
the reporter requests anonymity).

## Secret hygiene

This repository contains test fixtures that look like secrets but are
**deliberately not real**:

- Strings matching `S3CR3T-X.Y-must-never-leak-XYZ` are leak-detection
  sentinels used by the test suite.
- Strings matching `fakecert-*` / `fakekey-*` are stub PEMs consumed by the
  mock PEM parser in `HetznerCertificateProvider` tests.

These are allowlisted in `.gitleaks.toml`. If you find a real credential
committed by mistake, please report it via the channel above so we can rotate
it and rewrite history.

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
  | `core/.env` | DB URL, Hetzner / DNS tokens, restic password, SSH private key, `AGENT_CREDENTIALS`, AWS S3 keys (Object Storage for restic) | daemon
  process |
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