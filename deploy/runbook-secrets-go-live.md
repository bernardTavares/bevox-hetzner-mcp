# Runbook — sops-age secret resolver go-live

Operator playbook to migrate the daemon from the inert stub resolver to the
real sops+age resolver. After this, manifests with `secret:<ref>` env values
actually decrypt at apply time.

**Spec:** `docs/specs/2026-05-28-secret-resolver-real-v1.md`.

## Pre-flight

- `sops` binary installed on the daemon host. `apt install sops` (Debian) or
  `brew install sops` (macOS). Pin version (e.g., `sops --version` = `3.10.x`).
- `age` binary installed (for `age-keygen`). `apt install age` or `brew install age`.

## §5.1 — Initial setup (operator does ONCE per environment)

```bash
mkdir -p ~/.config/bevox
age-keygen -o ~/.config/bevox/age.key
chmod 600 ~/.config/bevox/age.key
AGE_PUB=$(grep "^# public key:" ~/.config/bevox/age.key | cut -d' ' -f4)

# Add first real secret (creates the file).
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops --age "$AGE_PUB" --set '["bevox-init"] "ok"' \
       ~/.config/bevox/secrets.enc.yaml

# Wire env into the daemon.
echo "SECRETS_FILE=$HOME/.config/bevox/secrets.enc.yaml" >> /path/to/core/.env
echo "SOPS_AGE_KEY_FILE=$HOME/.config/bevox/age.key" >> /path/to/core/.env

# BACKUP IMEDIATO da age.key offsite — daemon + chave em trust zones separados.
# Sem chave = todos os secrets ficam permanently inaccessible (by design).

# Systemd hardening (defense-in-depth for the Buffer-de-resolve ~30ms window):
# Append to /etc/systemd/system/bevox-daemon.service.d/hardening.conf:
#   [Service]
#   LimitCORE=0
#   ProtectKernelTunables=yes
#   ProtectSystem=strict
#   MemoryDenyWriteExecute=yes
# And /etc/sysctl.d/99-bevox.conf:
#   vm.swappiness=0
# Never run with `node --heapsnapshot-near-heap-limit`.

sudo systemctl daemon-reload
sudo systemctl restart bevox-daemon
sudo journalctl -u bevox-daemon -n 20 --no-pager
```

## §5.2 — Add / edit secret

Interactive:

```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops ~/.config/bevox/secrets.enc.yaml
```

Non-interactive:

```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops --set '["openai-api-key"] "sk-proj-..."' ~/.config/bevox/secrets.enc.yaml
```

## §5.3 — List secret names (no value leak)

```bash
SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops -d ~/.config/bevox/secrets.enc.yaml | yq 'keys' --output-format json
```

## §5.4 — Rotate the age key (recipient swap)

```bash
age-keygen -o ~/.config/bevox/age.key.new
NEW_PUB=$(grep "^# public key:" ~/.config/bevox/age.key.new | cut -d' ' -f4)

SOPS_AGE_KEY_FILE=~/.config/bevox/age.key \
  sops updatekeys --age "$NEW_PUB" ~/.config/bevox/secrets.enc.yaml

mv ~/.config/bevox/age.key ~/.config/bevox/age.key.old
mv ~/.config/bevox/age.key.new ~/.config/bevox/age.key
sudo systemctl restart bevox-daemon
# After boot OK, archive .old offsite.
```

## §4.5 — Smoke test (post-restart, pre-tag)

1. Setup §5.1 above.
2. `sops --set '["smoke-test"] "ABC123"' ~/.config/bevox/secrets.enc.yaml` (set known value).
3. `sudo systemctl restart bevox-daemon` + `journalctl -u bevox-daemon -n 30 --no-pager` — confirm boot OK, NO `ABC123` in any log line.
4. Apply a manifest with a service: `services[0].env.OPENAI_API_KEY: "secret:smoke-test"`.
5. SSH to the target server, `docker inspect <svc> | jq .Config.Env` — confirm `OPENAI_API_KEY=ABC123` in the container env.
6. `curl -H "Authorization: Bearer $TOKEN" http://daemon/api/state | jq '..|.env? // empty'` — confirm `secret:smoke-test` (the REF), never `ABC123` (the VALUE).
7. `curl -H "Authorization: Bearer $TOKEN" http://daemon/api/events` — confirm no event payload contains `ABC123`.
8. `journalctl -u bevox-daemon --since "1 hour ago" | grep ABC123` → zero matches.

If ALL 8 pass, the resolver is live and leak-free. Cleanup: `sops --set '["smoke-test"] null'` or delete the key.
