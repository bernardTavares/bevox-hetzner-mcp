/**
 * core/src/config.ts
 *
 * Task 6.6 — the typed, fail-fast configuration boundary for the bootstrap
 * daemon. ONE Zod schema parses the process environment (or an injected env
 * record, for tests) into a frozen `Config`. There is exactly one validation
 * point; `server.ts` consumes the parsed result and never re-reads
 * `process.env`.
 *
 * Design principles (CLAUDE.md non-negotiables — 1.9/3.3 secret discipline;
 * fail-safe, never a partial boot):
 *
 *   - FAIL-FAST, VALUE-FREE. A missing/invalid required key is a HARD error
 *     raised BEFORE any pool/listener/timer is created (boot is all-or-nothing
 *     — server.ts only calls loadConfig() first). The thrown
 *     ReconcileError("precondition") lists the offending key NAMES only — it
 *     NEVER echoes a value (a malformed secret must not leak via the error
 *     text). Zod's per-issue `path` is the key name; the raw input is dropped.
 *
 *   - NO SECRET DEFAULTS. Tokens / passwords / connection strings / the agent
 *     credential seed have NO default: an absent secret is a fatal config error,
 *     never a silent empty string or placeholder (the 1.9/3.3 "a missing secret
 *     is a hard error" rule carried to the boot layer). Only NON-SECRET
 *     operational knobs (HTTP port, reconcile/drift intervals, cycle timeout,
 *     log level) carry sane, documented defaults.
 *
 *   - INJECTABLE FOR TESTS. `loadConfig(env = process.env)` takes the env
 *     record so the suite passes a fake object — NO real `process.env`
 *     mutation, deterministic, no global state.
 *
 *   - MINIMAL SURFACE. ONLY `Config`, `ConfigSchema`, `loadConfig`. No I/O, no
 *     pool, no provider construction here (that is server.ts) — this module is
 *     pure parse+validate.
 *
 * Exported API (ONLY these):
 *   type Config            — the frozen, validated configuration
 *   ConfigSchema           — the Zod schema (exposed for assertions/tests)
 *   loadConfig(env?)       — parse+validate; throws value-free on missing/invalid
 */

import { z } from "zod";

import { ReconcileError } from "./domain/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A REQUIRED secret/connection value: a non-empty (post-trim) string with NO
 * default. `.min(1)` (after trim) makes an absent/blank value a validation
 * FAILURE — never a silent empty fallback (1.9/3.3: a missing secret is a hard
 * error). The error carries ONLY the key name (Zod's `path`), never the value.
 */
const requiredSecret = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required (no default; a missing secret is fatal)`);

/**
 * A non-secret integer knob parsed from its string env value, with a documented
 * default. Operational tuning ONLY (never a credential) — a sane default here
 * is explicitly allowed (it is not secret material).
 *
 * Optional `max` bound (spec 2026-05-28-migration-runner-v1 §1.3) allows
 * knobs to declare a closed upper limit, e.g. MIGRATION_TIMEOUT_MS ∈
 * [1000, 600000]. When `max` is omitted, behaviour is identical to the
 * original `(def, min)` signature (backward compatible).
 */
export const intKnob = (def: number, min: number, max?: number) => {
  let n = z.number().int().min(min);
  if (max !== undefined) n = n.max(max);
  return z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : Number(v)),
      n.optional(),
    )
    .transform((v) => v ?? def);
};

// ---------------------------------------------------------------------------
// The schema — required (no-default) secrets + defaulted non-secret knobs
// ---------------------------------------------------------------------------

/**
 * The full configuration schema. Required keys are derived from what the
 * providers / tool catalog / approval gate the daemon wires actually need:
 *
 *   - DATABASE_URL          — the pg pool / observed-state store / advisory
 *                             locks / StateEvents (db.ts).
 *   - HCLOUD_TOKEN          — HetznerCloudProvider auth (servers/networks/vols).
 *   - HCLOUD_DNS_TOKEN      — HetznerDNSProvider auth (separate hcloud DNS API).
 *   - RESTIC_REPO           — restic BackupProvider repository URL.
 *   - RESTIC_PASSWORD       — restic repository password (secret).
 *   - SSH_HOST / SSH_USER / SSH_PRIVATE_KEY
 *                           — the Docker-Engine-over-SSH + WireGuard control
 *                             transport params (operator-supplied; the key is
 *                             secret material).
 *
 * Task 7.2 adds three NON-SECRET, OPTIONAL, backward-compatible SSH knobs
 * (sane defaults; absent ⇒ identical pre-7.2 behaviour for every existing
 * test): SSH_PORT (default 22), SSH_HOST_KEY_POLICY (default "accept-new" —
 * TOFU; NEVER a blanket "no" that silently permits MITM), SSH_KNOWN_HOSTS
 * (optional explicit known_hosts path; when set, the policy is enforced
 * against it). They are host/connection tuning, never credentials.
 *   - AGENT_CREDENTIALS     — the v1 injected credential-store seed (the 4.2
 *                             token→{actor,capabilities} JSON map). Secret
 *                             (bearer tokens) — no default, never logged.
 *
 * Non-secret operational knobs (PORT, intervals, timeout, LOG_LEVEL) have sane
 * documented defaults — they are tuning, never credentials.
 */
export const ConfigSchema = z.object({
  // --- required secrets / connection strings (NO DEFAULTS) ----------------
  DATABASE_URL: requiredSecret("DATABASE_URL"),
  HCLOUD_TOKEN: requiredSecret("HCLOUD_TOKEN"),
  HCLOUD_DNS_TOKEN: requiredSecret("HCLOUD_DNS_TOKEN"),
  RESTIC_REPO: requiredSecret("RESTIC_REPO"),
  RESTIC_PASSWORD: requiredSecret("RESTIC_PASSWORD"),
  SSH_HOST: requiredSecret("SSH_HOST"),
  SSH_USER: requiredSecret("SSH_USER"),
  // Node --env-file does NOT unescape `\n`; operators write PEM keys with
  // literal `\n` (the .env.example convention). Normalise to real newlines and
  // ensure a trailing newline (OpenSSH rejects a key file without one). The
  // `.trim()` in requiredSecret runs first on the escaped form (inert to `\n`
  // literals); the trailing newline we add here survives. Scope: ONLY the PEM
  // key — single-line secrets (RESTIC_PASSWORD, tokens) are NOT unescaped, since
  // a password may legitimately contain the 2-char sequence `\n`.
  SSH_PRIVATE_KEY: requiredSecret("SSH_PRIVATE_KEY").transform((s) => {
    // Collapse both `\n` and CRLF-escaped `\r\n` to a real newline (a `\r\n`
    // value from Windows tooling must NOT leave a stray literal `\r`).
    const pem = s.replace(/(?:\\r)?\\n/g, "\n");
    return pem.endsWith("\n") ? pem : pem + "\n";
  }),
  AGENT_CREDENTIALS: requiredSecret("AGENT_CREDENTIALS"),

  // --- sops-age resolver paths (Task 5.2; required, no defaults) -----------
  /**
   * Absolute path to the encrypted secrets file the sops-age resolver decrypts
   * on demand inside `apply()`. Non-secret (a path) but REQUIRED — the
   * resolver cannot fall back to a default location silently. Filesystem
   * lstat / permission checks happen in validateSopsAgeConfig at boot.
   */
  SECRETS_FILE: requiredSecret("SECRETS_FILE"),
  /**
   * Absolute path to the age private-key file used by sops to decrypt
   * SECRETS_FILE. Path itself is non-secret; the FILE behind it is the
   * decryption key — boot-time validation enforces 0600 + owner == euid +
   * non-symlink (Task 2.4 L7 invariant).
   */
  SOPS_AGE_KEY_FILE: requiredSecret("SOPS_AGE_KEY_FILE"),

  /**
   * Per-resolve subprocess timeout in ms for the sops-age resolver. Default
   * 5000 (5s). Range [1000, 60000]. Caps the SIGTERM-then-SIGKILL ladder
   * the resolver runs around each `sops -d` invocation.
   */
  SECRETS_TIMEOUT_MS: intKnob(5000, 1000, 60000),

  /**
   * OPTIONAL private-registry auth (Bug 11; spec
   * 2026-06-01-docker-private-registry-auth.md). A JSON-encoded map
   * `{ "<registry-host>": "<secret-ref>" }`, e.g. `{"ghcr.io":"ghcr-pat"}`.
   * Kept as a raw string here (pure string-parse, like the rest of the
   * schema); the JSON parse + shape validation happen at boot in
   * entrypoint-wiring (fail-closed, value-free). Absent / "" / "{}" ⇒ no
   * registry auth wired ⇒ public pulls keep working byte-identically. The
   * ref resolves AT APPLY (behind ApplyContext) to `{username,password}`.
   */
  REGISTRY_AUTH_REFS: z.string().optional(),

  // --- non-secret SSH connection knobs (Task 7.2; sane defaults) ----------
  /** Remote SSH port for the Docker/WireGuard/restic transport. Default 22. */
  SSH_PORT: intKnob(22, 1),
  /**
   * Host-key trust policy mapped to OpenSSH `-o StrictHostKeyChecking=`.
   * "accept-new" (DEFAULT) = TOFU: accept a NEW host key on first contact,
   * but REFUSE a CHANGED key (MITM-safe). "yes" = require the key to already
   * be in known_hosts (strictest). "no" is DELIBERATELY NOT OFFERED — a
   * blanket accept-anything is a silent man-in-the-middle hole in a
   * security-sensitive control plane (spec 1.9/6.3 discipline).
   */
  SSH_HOST_KEY_POLICY: z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : v),
      z.enum(["accept-new", "yes"]).optional(),
    )
    .transform((v) => v ?? "accept-new"),
  /**
   * OPTIONAL explicit known_hosts file path. When set, it is passed via
   * `-o UserKnownHostsFile=` so the policy above is enforced against an
   * operator-curated trust store (the strongest posture). Absent ⇒ OpenSSH's
   * default user known_hosts under the chosen policy. Non-secret (a path).
   */
  SSH_KNOWN_HOSTS: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().min(1).optional(),
    ),

  // --- non-secret operational knobs (sane documented defaults) ------------
  /**
   * WireGuard mesh management policy. "on" (DEFAULT) = the reconciler
   * auto-manages the mesh network topology and peer connections.
   * "off" = manual mesh management by the operator (spec 2026-05-26 §4.3).
   */
  MANAGED_MESH: z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : v),
      z.enum(["on", "off"]).optional(),
    )
    .transform((v) => v ?? "on"),
  /**
   * Docker service management policy. "on" (DEFAULT) = the reconciler
   * routes the `service` scope to the Docker provider (via SSH).
   * "off" = the operator manages container orchestration outside the MCP
   * (e.g. k3s/CNI); routes.service is unwired and `service`-scope is
   * excluded from the periodic reconcile cycle. Spec 2026-05-26
   * (tolerant-meta-scope-and-managed-services) §3.
   */
  MANAGED_SERVICES: z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : v),
      z.enum(["on", "off"]).optional(),
    )
    .transform((v) => v ?? "on"),
  /**
   * STRICT_MANIFEST_APPROVAL — opt-in policy strengthening for apply_manifest.
   * When "off" (DEFAULT), apply_manifest uses defaultIsSensitive (only
   * destroy/remove/restore gate). When "on", apply_manifest consults
   * TOOL_POLICY per-entity-kind — e.g. `create server:*` lifts to
   * `provision_server`'s "always" policy → server creates require approval.
   * Default "off" preserves v1 FROZEN behavior; opt-in additive only.
   * Spec docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.1.
   */
  STRICT_MANIFEST_APPROVAL: z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : v),
      z.enum(["on", "off"]).optional(),
    )
    .transform((v) => v ?? "off"),
  /** Loopback HTTP port for the REST server (0 ⇒ ephemeral). Default 8787. */
  PORT: intKnob(8787, 0),
  /** Periodic reconcile interval (ms). Default 60s. */
  RECONCILE_INTERVAL_MS: intKnob(60_000, 1),
  /** Periodic drift-sweep interval (ms). Default 5min (DEFAULT_DRIFT_SWEEP_MS). */
  DRIFT_SWEEP_INTERVAL_MS: intKnob(5 * 60 * 1000, 1),
  /** Per-cycle reconcile deadline (ms). Default 5min (DEFAULT_CYCLE_TIMEOUT_MS). */
  CYCLE_TIMEOUT_MS: intKnob(5 * 60 * 1000, 1),
  /**
   * Per-migration execution timeout for the migration runner (ms). Bounds the
   * single `docker exec`/SSH-exec window for ONE migration statement; the
   * runner aborts the migration and returns "timeout" if exceeded. Range
   * [1000, 600000], default 60_000 (60s). Spec
   * docs/specs/2026-05-28-migration-runner-v1.md §1.5 / §4.
   */
  MIGRATION_TIMEOUT_MS: intKnob(60_000, 1000, 600_000),
  /** Pino log level. Default "info". */
  LOG_LEVEL: z
    .preprocess(
      (v) => (v === undefined || v === "" ? undefined : v),
      z
        .enum(["trace", "debug", "info", "warn", "error", "fatal"])
        .optional(),
    )
    .transform((v) => v ?? "info"),
});

/** The frozen, validated configuration. */
export type Config = Readonly<z.infer<typeof ConfigSchema>>;

// ---------------------------------------------------------------------------
// loadConfig — the single parse+validate point (injectable env)
// ---------------------------------------------------------------------------

/**
 * Parse + validate the environment into a frozen {@link Config}.
 *
 * FAIL-FAST & VALUE-FREE: on ANY missing/invalid key this throws
 * ReconcileError("precondition") whose message lists ONLY the offending key
 * NAMES (Zod's issue `path`) — the raw values are dropped, so a malformed
 * secret can never leak through the error text or any boot log. There is NO
 * partial config: either every required key is present & valid, or nothing is
 * returned (server.ts calls this FIRST, before any pool/listener/timer — so a
 * config failure leaves zero resources held; boot is all-or-nothing).
 *
 * @param env Injected env record (default `process.env`) — tests pass a fake;
 *            no real `process.env` mutation.
 * @throws ReconcileError("precondition") listing the missing/invalid key names.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Collect ONLY the offending key NAMES — never a value. Deduped + sorted
    // so the message is deterministic and actionable.
    const names = [
      ...new Set(
        parsed.error.issues.map((i) =>
          i.path.length > 0 ? String(i.path[0]) : "(root)",
        ),
      ),
    ].sort();
    throw new ReconcileError(
      "precondition",
      `invalid configuration: missing or invalid required key(s): ` +
        `${names.join(", ")} — set them in the environment ` +
        `(see core/.env.example). No values are echoed (secret-safe).`,
      { entity: "config" },
    );
  }
  return Object.freeze(parsed.data);
}
