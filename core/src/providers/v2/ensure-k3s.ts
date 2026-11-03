/**
 * core/src/providers/v2/ensure-k3s.ts
 *
 * Bloco E Phase 2 (host axis) — `EnsureK3sProvider` (Task 16: observe;
 * Task 17: apply + verify).
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md §3.2 / §3.3 / Q-a
 *
 * observe() — READ-ONLY host inspection. It runs THREE read-only host commands
 * over the `KubeTransport.run` seam (raw host exec, no kubectl/kubeconfig
 * prefix — Task 16):
 *   1. `k3s --version`            → installed? + which version?
 *   2. `systemctl is-active k3s`  → is the unit active?
 *   3. `k3s kubectl get nodes …`  → is a node Ready?
 * It builds a MINIMAL, secret-free observed projection keyed `k3s:<host>`.
 * It issues NO install / uninstall / mutating verb — fail-safe.md.
 *
 * apply() — INSTALL-ONLY (Task 17, §3.2 / §3.3 / Q-a). Runs the PROVIDER-OWNED
 * install recipe ONLY when k3s is ABSENT (`changed:true`). Present at the same
 * version ⇒ strict no-op (`changed:false`). Present at a DIFFERENT version ⇒
 * reports DRIFT (`changed:false`, `result:"drift"`) — Q-a: NEVER auto-upgrade,
 * NEVER reinstall, NEVER throw. There is NO uninstall path on ANY branch
 * (fail-safe.md / D7 — install-only). The recipe passes `version`/`role` as
 * DISCRETE `env KEY=VALUE` argv tokens (NEVER concatenated into the `-c`
 * script), so ssh-exec's per-token single-quote escaping neutralises any
 * metacharacter — no shell-injection surface, no input-supplied free command.
 *
 * verify() — READ-ONLY (Task 17). true iff k3s is present AND a node is Ready
 * (re-uses observe()'s readiness parse). Issues NO mutating verb.
 *
 * Exports:
 *   k3sIdentityKey            — canonical resource identity key `k3s:<host>`
 *   EnsureK3sApplyResult      — apply() outcome ({entity, changed, result?})
 *   createEnsureK3sProvider   — the provider factory (observe/apply/verify)
 */

import { z } from "zod";

import type { EnsureK3s } from "../../domain/entities-v2.js";
import type { ObservedEntity } from "../provider.js";
import type { KubeTransport } from "./kube-transport.js";

// ---------------------------------------------------------------------------
// Identity key
// ---------------------------------------------------------------------------

/**
 * Canonical identity key for an EnsureK3s host recipe: `k3s:<host>`.
 * The `host` is a NAMED reference (entities-v2.ts EnsureK3sSchema), so the key
 * is non-ambiguous per host and follows the `<kind>:<name>` convention of
 * `observed-store.ts`.
 */
export function k3sIdentityKey(desired: EnsureK3s): string {
  return `k3s:${desired.host}`;
}

// ---------------------------------------------------------------------------
// observe() — wire guard-parse helpers (no `as` on command output)
// ---------------------------------------------------------------------------

/**
 * Pulls the version token out of `k3s --version` stdout, e.g.
 *   "k3s version v1.30.2+k3s1 (abcdef12)\n" → "v1.30.2+k3s1"
 * Returns `null` if no recognisable version token is present (guard-parse —
 * never an `as`-cast; a careful regex over the trusted, non-secret stdout).
 */
function parseK3sVersion(stdout: string): string | null {
  // The token after the literal "version " up to the next whitespace.
  const m = /version\s+(\S+)/i.exec(stdout);
  return m && m[1] !== undefined ? m[1] : null;
}

/**
 * LENIENT wire schema for `kubectl get nodes -o json`. We read ONLY what node
 * readiness needs: each item's `.status.conditions[]` (`type`/`status`). The
 * rest of the (large) NodeList document is ignored — never copied into the
 * returned payload. Per `.claude/rules/esm-nodenext.md` Rule 4 every byte off
 * the wire is Zod-validated, NEVER `as`-cast (`.passthrough()` keeps validation
 * lenient without pulling unknown fields into the typed surface).
 */
const NodeListSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            status: z
              .object({
                conditions: z
                  .array(
                    z
                      .object({
                        type: z.string().optional(),
                        status: z.string().optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Returns `true` iff the parsed NodeList carries at least one node with a
 * `Ready`/`True` condition. Guard-parses `stdout` via `NodeListSchema`; any
 * non-JSON / non-matching output safely yields `false` (no node proven Ready).
 */
function parseNodeReady(stdout: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return false;
  }
  const parsed = NodeListSchema.safeParse(raw);
  if (!parsed.success) return false;
  const items = parsed.data.items ?? [];
  return items.some((node) =>
    (node.status?.conditions ?? []).some(
      (c) => c.type === "Ready" && c.status === "True",
    ),
  );
}

// ---------------------------------------------------------------------------
// observe() — minimal, secret-free projection
// ---------------------------------------------------------------------------

/**
 * The MINIMAL, secret-free PROJECTION observe() returns as
 * `ObservedEntity.payload`. k3s status carries no secrets, but the payload is
 * kept minimal regardless (no full command dumps): only the booleans/version
 * apply()/verify() (Task 17) need. `version`/`ready` are present only when k3s
 * is installed.
 */
export interface EnsureK3sObservedProjection {
  /** True when `k3s --version` exits 0. */
  readonly installed: boolean;
  /** The parsed k3s version token, present only when installed & parsable. */
  readonly version?: string;
  /** True when `systemctl is-active k3s` stdout trims to "active". */
  readonly active?: boolean;
  /** True when `kubectl get nodes` shows at least one Ready node. */
  readonly ready?: boolean;
}

/**
 * Guard-parse the observed `payload` (typed `unknown` at the `ObservedEntity`
 * boundary) back into the minimal projection apply()/verify() reason over.
 * Per `.claude/rules/esm-nodenext.md` Rule 4 we never `as`-cast a payload —
 * a lenient Zod schema validates the shape and any mismatch safely yields
 * `null` (treated as "not enough signal" by the caller). `.passthrough()`
 * keeps it tolerant of extra keys without pulling them into the typed surface.
 */
const ObservedProjectionSchema = z
  .object({
    installed: z.boolean(),
    version: z.string().optional(),
    active: z.boolean().optional(),
    ready: z.boolean().optional(),
  })
  .passthrough();

function readProjection(
  observed: ObservedEntity | null,
): EnsureK3sObservedProjection | null {
  if (observed === null) return null;
  const parsed = ObservedProjectionSchema.safeParse(observed.payload);
  if (!parsed.success) return null;
  const { installed, version, active, ready } = parsed.data;
  return {
    installed,
    ...(version !== undefined ? { version } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(ready !== undefined ? { ready } : {}),
  };
}

// ---------------------------------------------------------------------------
// Install recipe — PROVIDER-OWNED constant argv (security-critical)
// ---------------------------------------------------------------------------

/**
 * The FIXED pipeline script token. It is a CONSTANT string — the desired
 * `version`/`role` are NEVER concatenated into it (that would re-enter the
 * shell-injection surface). It is the official k3s install one-liner; it is
 * parameterised EXCLUSIVELY by the `INSTALL_K3S_*` env assignments below,
 * which ride as DISCRETE `env` argv tokens.
 */
const K3S_INSTALL_SCRIPT = "curl -sfL https://get.k3s.io | sh -";

/**
 * Map the typed `role` enum to the exact k3s `INSTALL_K3S_EXEC` selector.
 * `server` is the control-plane default; `agent` is the worker exec mode (the
 * documented k3s mechanism: the install script reads `INSTALL_K3S_EXEC=agent`).
 * The mapping is over a CLOSED enum (`EnsureK3sSchema.role`) — never an
 * input-supplied free command (D7).
 */
function k3sExecForRole(role: EnsureK3s["role"]): string {
  return role === "agent" ? "agent" : "server";
}

/**
 * Build the install recipe argv. SECURITY-CRITICAL: `version` and `role` ride
 * as DISCRETE `env KEY=VALUE` argv tokens, NEVER concatenated into the `-c`
 * script. ssh-exec.ts single-quote-escapes every remote argv token, so each
 * `INSTALL_K3S_VERSION=<v>` token reaches the remote shell verbatim — any
 * metacharacter in `version` (only `z.string().min(1)`, not pattern-constrained)
 * is neutralised by that per-token escaping and can NOT break out of the
 * assignment. The script token is a FIXED constant. No part is a caller free
 * string.
 */
function buildInstallRecipe(desired: EnsureK3s): readonly string[] {
  return [
    "env",
    `INSTALL_K3S_VERSION=${desired.version}`,
    `INSTALL_K3S_EXEC=${k3sExecForRole(desired.role)}`,
    "sh",
    "-c",
    K3S_INSTALL_SCRIPT,
  ];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface EnsureK3sProviderOptions {
  /** The raw-host-exec seam (KubeTransport.run — Task 16). observe drives it. */
  readonly transport: KubeTransport;
}

/**
 * The outcome of one `apply()`. `entity` is the `k3sIdentityKey`; `changed`
 * is the idempotency signal (true ⇒ the install recipe ran; false ⇒ either a
 * strict converged no-op OR a reported DRIFT — disambiguated by `result`).
 *
 * `result` is the value-free drift discriminator (mirrors the canonical
 * `result:"drift"` literal of `core/src/reconciler/drift.ts`'s `DriftEventSpec`).
 * Present ONLY on the version-divergence branch (Q-a): `{ changed:false,
 * result:"drift" }` lets the reconciler/tool tell "converged no-op"
 * (`changed:false`, no `result`) apart from "version drift, NO auto-upgrade"
 * (`changed:false`, `result:"drift"`). It carries NO divergent value — the
 * observed/desired versions are NOT copied here (no-leak + value-free drift,
 * by construction). NEVER carries a resolved secret value.
 */
export interface EnsureK3sApplyResult {
  readonly entity: string;
  readonly changed: boolean;
  /** ALWAYS the literal "drift" when present (version-divergence, Q-a). */
  readonly result?: "drift";
}

export interface EnsureK3sProvider {
  readonly name: string;
  /**
   * Read-only observe BY IDENTITY. Returns the observed slice
   * (`{ key, payload }`) for the host's k3s state. Takes NO `ApplyContext` —
   * structurally unable to resolve a secret; mutates nothing (fail-safe.md).
   */
  observe(desired: EnsureK3s): Promise<ObservedEntity | null>;
  /**
   * INSTALL-ONLY apply (Task 17). Runs the PROVIDER-OWNED install recipe ONLY
   * when k3s is ABSENT (`observed` null OR `installed:false`) ⇒ `changed:true`.
   * Present at the SAME version ⇒ strict no-op (`changed:false`, NO argv).
   * Present at a DIFFERENT version ⇒ reports DRIFT (`changed:false`,
   * `result:"drift"`, NO install/upgrade argv) — Q-a: NEVER auto-upgrade.
   * There is NO uninstall path on ANY branch (fail-safe.md, D7).
   */
  apply(
    desired: EnsureK3s,
    observed: ObservedEntity | null,
  ): Promise<EnsureK3sApplyResult>;
  /**
   * Read-only verify (Task 17). true iff k3s is present AND a node is Ready
   * (re-uses observe()'s readiness parse). Issues NO mutating verb.
   */
  verify(desired: EnsureK3s): Promise<boolean>;
}

/**
 * Build an `EnsureK3sProvider` over the injected `KubeTransport`.
 *
 * `observe()` runs `k3s --version`, then (only if installed) `systemctl
 * is-active k3s` and `k3s kubectl get nodes -o json`, all via the RAW host-exec
 * seam (`transport.run`). It is READ-ONLY: no install / uninstall / mutating
 * verb (install is apply()'s job, Task 17). When k3s is absent (`k3s --version`
 * exits non-zero) it short-circuits to `{ installed:false }` WITHOUT probing
 * the unit or the nodes.
 */
export function createEnsureK3sProvider(
  opts: EnsureK3sProviderOptions,
): EnsureK3sProvider {
  const { transport } = opts;

  return {
    name: "ensure-k3s",

    async observe(desired: EnsureK3s): Promise<ObservedEntity | null> {
      const key = k3sIdentityKey(desired);

      // (1) Installed? `k3s --version` exits non-zero when k3s is absent. The
      // KubeTransport.run seam returns the non-zero exit faithfully (it never
      // invents a failure from a command's own status) — we map it here.
      const versionRes = await transport.run(["k3s", "--version"]);
      if (versionRes.code !== 0) {
        const projection: EnsureK3sObservedProjection = { installed: false };
        return { key, payload: projection };
      }

      const version = parseK3sVersion(versionRes.stdout);

      // (2) Active? `systemctl is-active k3s` prints the state on stdout; it
      // exits non-zero for a non-active unit, so the SUBSTANTIVE signal is the
      // trimmed stdout, not the exit code.
      const activeRes = await transport.run(["systemctl", "is-active", "k3s"]);
      const active = activeRes.stdout.trim() === "active";

      // (3) Ready? `k3s kubectl get nodes -o json` — guard-parse for a Ready
      // node. Read-only; readiness richness is verify()'s job (Task 17), so we
      // include only the cheap boolean here.
      const nodesRes = await transport.run([
        "k3s",
        "kubectl",
        "get",
        "nodes",
        "-o",
        "json",
      ]);
      const ready = nodesRes.code === 0 && parseNodeReady(nodesRes.stdout);

      const projection: EnsureK3sObservedProjection = {
        installed: true,
        ...(version !== null ? { version } : {}),
        active,
        ready,
      };
      return { key, payload: projection };
    },

    async apply(
      desired: EnsureK3s,
      observed: ObservedEntity | null,
    ): Promise<EnsureK3sApplyResult> {
      const entity = k3sIdentityKey(desired);
      const projection = readProjection(observed);

      // ABSENT — observed is null OR k3s is not installed. Run the install
      // recipe (idempotent by design) and report the mutation.
      if (projection === null || projection.installed === false) {
        await transport.run(buildInstallRecipe(desired));
        return { entity, changed: true };
      }

      // PRESENT + SAME version — strict no-op. NO argv at all (the property
      // test / idempotency contract depends on zero mutating commands here).
      if (projection.version === desired.version) {
        return { entity, changed: false };
      }

      // VERSION-DIVERGENT (Q-a) — report DRIFT. install-only / fail-safe.md:
      // NEVER auto-upgrade, NEVER reinstall, NEVER throw. Run NO install /
      // upgrade / uninstall argv. `result:"drift"` (value-free) lets the
      // reconciler distinguish this from a converged no-op; the divergent
      // versions are NOT copied into the result (no-leak / value-free drift).
      return { entity, changed: false, result: "drift" };
    },

    async verify(desired: EnsureK3s): Promise<boolean> {
      // Read-only. true iff k3s is present AND a node is Ready. Re-uses the
      // observe() probes (k3s --version then kubectl get nodes); issues NO
      // install / mutating verb (fail-safe.md).
      const versionRes = await transport.run(["k3s", "--version"]);
      if (versionRes.code !== 0) return false;

      const nodesRes = await transport.run([
        "k3s",
        "kubectl",
        "get",
        "nodes",
        "-o",
        "json",
      ]);
      return nodesRes.code === 0 && parseNodeReady(nodesRes.stdout);
    },
  };
}
