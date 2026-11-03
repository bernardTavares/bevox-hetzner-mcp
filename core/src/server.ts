/**
 * core/src/server.ts
 *
 * Task 6.6 — the bootstrap daemon. It WIRES the already-built, already-tested
 * pieces into ONE running control plane and owns NOTHING else: no new policy,
 * no new tool, no new endpoint, no new convergence logic. It is composition +
 * lifecycle ONLY (the minimal-change discipline).
 *
 * What it composes (each piece is reused verbatim):
 *
 *   pool + migrations (db.ts)
 *     → composite Provider (composite-provider.ts) routing by kind
 *         · server  → [HetznerCloud, WireGuard]   (fan-out: host + mesh peer)
 *         · service → Docker
 *         · network/volume → HetznerCloud
 *         · dns     → HetznerDNS
 *         · backup  → restic BackupProvider
 *       — EACH concrete provider wrapped in its own 6.2 CircuitBreaker; the
 *         live breaker REGISTRY (provider.name → CircuitBreaker) is RETAINED
 *         so the HealthSource folds REAL breaker state (the seam 6.4 left for
 *         6.6 — wired here to genuine signals, no new tracking).
 *     → the SINGLE 4.4 tool catalog (createToolCatalog) + the v1 credential
 *       store (4.2) + the REAL 4.3 approval gate + the secret resolver.
 *     → ONE REST server (4.5) AND ONE MCP server (4.7) over the SAME catalog /
 *       gate / pool (no parallel core — a REST destroy and an MCP destroy
 *       produce the same envelope+StateEvent, already guaranteed by 4.7).
 *     → the periodic reconciler (schedulePeriodicReconcile) + the periodic
 *       6.1 drift sweep, both via the SAME injectable timer seam (no second
 *       scheduler), each cycle bounded by the 6.3 cycle timeout.
 *
 * Design principles (CLAUDE.md non-negotiables):
 *
 *   - BOOT IS ALL-OR-NOTHING (fail-safe). loadConfig() runs FIRST (a missing
 *     secret throws value-free BEFORE any resource exists). Each subsequent
 *     init step registers a cleanup; ANY init error runs every registered
 *     cleanup in reverse (pool ended, lock never acquired half-way, no
 *     listener bound) and re-throws — a config/boot failure NEVER leaves a
 *     daemon holding a lock or a pool.
 *
 *   - GRACEFUL SHUTDOWN, NO FAIL-DELETE. stop() (also bound to SIGTERM/SIGINT
 *     when the daemon owns the process) STOPS the timers first (no new cycle
 *     starts), then closes REST + MCP, then ends the pg pool — which RELEASES
 *     every advisory lock cleanly (withScopeLock's finally + pool.end). An
 *     in-flight reconcile cycle is allowed to finish (await the periodic
 *     handle's flush) or is bounded by the 6.3 cycle timeout — it is NEVER
 *     killed mid-mutation, so nothing is half-applied / orphaned / fail-
 *     deleted. stop() is idempotent.
 *
 *   - NO SECRET LEAK. The pino logger seam (6.3) logs only actor/scope/entity
 *     + classes/counts — never a token/password/connection string. Boot/
 *     shutdown log lines and the config error are value-free (config.ts owns
 *     the value-free guarantee; this module never logs a Config field).
 *
 *   - DETERMINISTIC TESTS. EVERY environmental seam is injectable: the pool
 *     (pg harness), the provider routes (fakes), the timer + reconcile clock +
 *     cycle-timeout timer (no real timers), the logger (capturing). Tests
 *     drive `handle()` in-process (no bound port) and call `stop()` directly
 *     (no real signals). No real network/SSH/Docker/restic — those concrete
 *     transports are operator/deploy config, out of Task-6.6 scope.
 *
 * Exported API (ONLY these — minimal surface):
 *   interface BevoxServer        — { rest, mcp, breakers, stop }
 *   interface BootDeps           — the injectable seams (tests pass fakes)
 *   createServer(config, deps?)  — build + start everything; returns BevoxServer
 *   startServer(env?)            — loadConfig(env) → createServer (the entrypoint)
 */

import type pg from "pg";

import { type Config, loadConfig } from "./config.js";
import { createPool, runMigrations } from "./store/db.js";
import type { DesiredState } from "./domain/desired-state.js";
import type { State, PlanItem } from "./domain/entities.js";
import { compositeProvider } from "./reconciler/composite-provider.js";
import {
  CircuitBreaker,
  type Clock as BreakerClock,
} from "./reconciler/circuit-breaker.js";
import type { Provider, ObservedSlice } from "./providers/provider.js";
import {
  reconcile,
  runDriftSweep,
  schedulePeriodicReconcile,
  DEFAULT_DRIFT_SWEEP_MS,
  type ReconcileGate,
  type TimerLike,
  type PeriodicHandle,
  type StartTimeout,
} from "./reconciler/reconcile.js";
import { createToolCatalog } from "./agent/tools.js";
import { createApprovalGate } from "./agent/approval-gate.js";
import {
  createInjectedCredentialStore,
  type CredentialStore,
  type CredentialRecord,
} from "./agent/auth.js";
import { createRestServer, type RestServer } from "./agent/rest.js";
import { createMcpServer, type McpServer } from "./agent/mcp.js";
import { createHetznerFirewallProvider } from "./providers/v2/hetzner-firewall.js";
import { getState as getObservedState } from "./store/observed-store.js";
import { appendEvent as appendStateEvent } from "./store/state-events.js";
import {
  type HealthSource,
  type HealthSnapshot,
  type ReconcilerSnapshot,
} from "./agent/health.js";
import { createStubSecretResolver, createApplyContext } from "./store/secrets.js";
import type { SecretResolver } from "./store/secrets.js";
import { V2_TOOLS, type V2ToolName } from "./agent/capability.js";
import type { KubeTransport } from "./providers/v2/kube-transport.js";
import type {
  KubectlApplyDeps,
  KubeHostConfig,
} from "./agent/v2/kubectl-apply.js";
import type {
  EnsureK3sToolDeps,
  EnsureK3sHostConfig,
} from "./agent/v2/ensure-k3s.js";
import {
  createPinoLogger,
  type Logger,
} from "./observability/logger.js";
import { ReconcileError } from "./domain/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The kind→Provider routes the composite needs. Each is the CONCRETE provider
 * (HetznerCloud/Docker/WireGuard/HetznerDNS/restic) BEFORE breaker-wrapping —
 * server.ts wraps each in its own 6.2 CircuitBreaker and keeps the registry.
 * `server` fans out to [host, mesh-peer] exactly like composite-provider.ts.
 *
 * The concrete transports (SSH for Docker/WireGuard, restic CLI) are
 * operator/deploy configuration and OUT OF Task-6.6 SCOPE — so the provider
 * set is an injected seam: tests pass in-process fakes; a deploy wires the
 * real transports. server.ts never touches a real socket itself.
 */
export interface ProviderRoutes {
  readonly network: Provider;
  readonly server: readonly Provider[];
  readonly volume: Provider;
  /**
   * Spec 2026-05-26 (tolerant-meta-scope-and-managed-services) §3 — OPTIONAL
   * to mirror CompositeRoutes. Absent (MANAGED_SERVICES=off) ⇒ the daemon
   * does not manage Docker services; the `service` scope is excluded from
   * the periodic reconcile cycle (BootDeps.scopes; see entrypoint-wiring).
   */
  readonly service?: Provider;
  readonly dns?: Provider;
  readonly backup?: Provider;
}

/**
 * Injectable boot seams. EVERYTHING environmental is here so the suite is
 * deterministic (no real network/timers/signals/port). Omitted ⇒ the
 * documented production default (a real pool from config, real pino, real
 * timers, the v1 stub secret resolver).
 */
export interface BootDeps {
  /** The pg pool (tests pass the disposable harness pool; prod: from config). */
  readonly pool?: pg.Pool;
  /**
   * Override pool ownership. By default server.ts ends ONLY a pool it created
   * itself (never a borrowed/harness pool — correct production discipline).
   * A test that injects a pool but wants to exercise the OWNED-pool shutdown
   * path (prove stop()/boot-unwind calls `pool.end()`) sets this true. Purely
   * additive & test-facing; production never sets it (the default — end iff
   * self-created — is unchanged, so every prior path is byte-identical).
   */
  readonly ownsInjectedPool?: boolean;
  /** Skip migrations (tests that ran them already via the harness). */
  readonly skipMigrations?: boolean;
  /**
   * The concrete provider routes (REQUIRED — the concrete transports are
   * out-of-scope operator config, so the provider set is always injected;
   * tests pass fakes). Without it boot fails fast (no silent no-op backend).
   */
  readonly providers?: ProviderRoutes;
  /** provider→State adapter (the inverse of plan.ts keying; deploy-specific). */
  readonly observedAdapter?: (slice: ObservedSlice) => State;
  /**
   * Desired-state source (REQUIRED — scope-keyed). State (observed entity
   * shape, entities.ts) and DesiredState (manifest intent shape,
   * desired-state.ts) are genuinely DIFFERENT schemas with no runtime
   * adapter, so server.ts ships NO default backend for this seam: the
   * deploy-specific adapter is always injected (same fail-fast precedent
   * `providers` sets). Without it boot fails fast (value-free precondition).
   */
  readonly loadDesired?: (scope: string) => Promise<DesiredState>;
  /** Desired-state writer (REQUIRED — same rationale as loadDesired). */
  readonly writeDesired?: (
    scope: string,
    desired: DesiredState,
  ) => Promise<void>;
  /** Periodic timer seam (default: global timers). Tests inject a fake. */
  readonly timer?: TimerLike;
  /** Injected clock for the breakers + approval gate (tests advance it). */
  readonly clock?: BreakerClock;
  /** Injected reconcile cycle-timeout timer (test determinism). */
  readonly startTimeout?: StartTimeout;
  /** Structured logger (default: real pino at config.LOG_LEVEL). */
  readonly logger?: Logger;
  /** Secret resolver (default: the v1 inert stub). */
  readonly secretResolver?: SecretResolver;
  /** approval_id factory (default: random "apr_…"; tests pass deterministic). */
  readonly idFactory?: () => string;
  /** Scopes the periodic reconciler/sweep iterate (default: the plan-able 4). */
  readonly scopes?: readonly string[];
  /** The actor recorded for periodic (non-agent-triggered) cycles. */
  readonly periodicActor?: string;
  /**
   * Bind a real loopback HTTP port on boot (production). Tests leave this
   * false and drive `rest.handle()` in-process (no port race).
   */
  readonly listen?: boolean;
  /**
   * Install SIGTERM/SIGINT → stop() handlers (production daemon owns the
   * process). Tests leave this false and invoke stop() directly (no real
   * signals fired uncontrolled).
   */
  readonly installSignalHandlers?: boolean;
  /**
   * OPTIONAL — v2 Bloco A `set_firewall` cabling (spec
   * docs/specs/2026-05-27-wire-v2-set-firewall.md §2.3). buildBootDeps
   * provides the static pieces (HetznerV2HttpClient bound to HCLOUD_TOKEN
   * + the in-memory WorkingFirewallStore); server.ts builds the
   * serversProvider closure (needs the local pool) and the FirewallProvider
   * (needs serversProvider), assembles the SetFirewallDeps with the
   * approvalGate, and forwards to BOTH createRestServer and createMcpServer.
   * Omitted ⇒ POST /api/v2/firewalls and the MCP tool route stay absent
   * (backward-compatible — the same pre-existing optional dep contract).
   */
  readonly setFirewallPieces?: {
    readonly v2Http: import("./providers/v2/hetzner-cloud-v2-http.js").HetznerV2HttpClient;
    readonly workingStore: import("./agent/v2/set-firewall.js").WorkingFirewallStore;
  };
  /**
   * OPTIONAL — v2 `run_migrations` cabling (spec
   * docs/specs/2026-05-28-migration-runner-v1.md §6). buildBootDeps
   * provides the static pieces (per-migration timeout from
   * MIGRATION_TIMEOUT_MS + the docker-exec adapter over the SSH-backed
   * Docker transport); server.ts builds the servicesProvider closure
   * (needs the local pool) and assembles the full RunMigrationsDeps with
   * the always-sensitive approval gate + appendEvent + pool, forwarding
   * to BOTH createRestServer and createMcpServer. Omitted ⇒ POST
   * /api/v2/migrations and the MCP run_migrations tool stay absent
   * (backward-compatible — same optional-dep contract as setFirewallPieces).
   */
  readonly runMigrationsPieces?: {
    readonly timeoutMs: number;
    readonly dockerExec: import("./providers/docker-exec-adapter.js").DockerExecFn;
  };
  /**
   * OPTIONAL — Bloco E (Phase 2) kube/k3s cabling (spec
   * 2026-06-12-bloco-e-kubernetes-k3s-provider §"kube() transport factory").
   * buildBootDeps (entrypoint-wiring.ts Task 21) builds these from the injected
   * `transports.kube(config)` seam (the SSH key bound SERVER-SIDE — Q-c);
   * server.ts (Task 23 — THE GAP FIX) assembles BOTH the `kubectl_apply`
   * (Task 14) `KubectlApplyDeps` and the `ensure_k3s` (Task 23) `EnsureK3sToolDeps`
   * from them — with an always-sensitive approval gate + (for kubectl_apply) the
   * per-call ApplyContext mint — and forwards them, plus the granted `v2Tools`
   * set, into createMcpServer/createRestServer so the WHOLE v2 surface becomes
   * reachable. Omitted ⇒ the two kube/k3s tools' DEPS are absent (their routes
   * 404 / MCP dispatch no-ops), but the v2 surface is STILL advertised (same
   * optional-dep contract as setFirewallPieces / runMigrationsPieces).
   *
   * Shape mirrors entrypoint-wiring.ts `KubePieces` (defined inline here to
   * avoid an import cycle — entrypoint-wiring imports `BootDeps` from this file).
   */
  readonly kubePieces?: {
    readonly transport: KubeTransport;
    readonly resolveHost: (host: string) => Promise<KubeHostConfig>;
    readonly getProvider: (
      cfg: KubeHostConfig,
    ) => import("./providers/v2/kube-apply.js").KubernetesProvider;
    readonly getEnsureK3sProvider: (
      cfg: EnsureK3sHostConfig,
    ) => import("./providers/v2/ensure-k3s.js").EnsureK3sProvider;
    readonly namespaceExists: (
      cfg: KubeHostConfig,
      namespace: string,
    ) => Promise<boolean>;
  };
  /**
   * OPTIONAL — when `true`, `apply_manifest` uses `strictManifestIsSensitive`
   * (consults TOOL_POLICY per-entity-kind) instead of `defaultIsSensitive`.
   * Wired from `STRICT_MANIFEST_APPROVAL === "on"` via buildBootDeps.
   * Default `false` preserves v1 FROZEN behavior. Spec
   * docs/specs/2026-05-27-strict-manifest-approval-knob.md.
   */
  readonly strictManifestApproval?: boolean;
}

/** The running daemon. `stop()` is the graceful, idempotent shutdown. */
export interface BevoxServer {
  readonly rest: RestServer;
  readonly mcp: McpServer;
  /** The live breaker registry (provider.name → its CircuitBreaker). */
  readonly breakers: ReadonlyMap<string, CircuitBreaker>;
  /** The wired HealthSource (live breaker registry + last cycle snapshot). */
  readonly health: HealthSource;
  /** The bound port when listen:true (else undefined — in-process only). */
  readonly port?: number;
  /**
   * Graceful shutdown: stop timers → close REST+MCP → end pool (releases every
   * advisory lock cleanly). Idempotent AND concurrency-safe: every caller
   * (including a second concurrent stop() or a SIGTERM during an in-flight
   * SIGINT-stop) awaits the SAME shutdown completion — no caller resolves
   * before the owned pool has actually ended. A periodic tick that fires
   * after stop() began does ZERO DB work (the post-stop gate makes it inert),
   * so it cannot race pool.end(); an already-in-flight cycle is still awaited
   * by the periodic handle's flush() — never killed mid-mutation, no
   * fail-delete.
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults (NON-secret only — secrets come from validated config, never here)
// ---------------------------------------------------------------------------

const DEFAULT_SCOPES = ["network", "server", "service", "volume"] as const;
const DEFAULT_PERIODIC_ACTOR = "agent:reconciler";
/** Generous breaker tuning — a healthy path is transparent (6.2 contract). */
const BREAKER_MAX_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 30_000;

/** A real wall-clock for production breakers/approval gate. */
const REAL_CLOCK: BreakerClock = { now: () => new Date() };

/** Parse the AGENT_CREDENTIALS JSON seed into the 4.2 store map (value-free). */
function parseCredentials(json: string): {
  [token: string]: CredentialRecord;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // NEVER echo the raw value (it carries bearer tokens) — names/shape only.
    throw new ReconcileError(
      "precondition",
      "AGENT_CREDENTIALS is not valid JSON (expected " +
        '{"<token>":{"actor":"…","capabilities":[…]}} — no value echoed)',
      { entity: "config" },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReconcileError(
      "precondition",
      "AGENT_CREDENTIALS must be a JSON object of token→{actor,capabilities}",
      { entity: "config" },
    );
  }
  return parsed as { [token: string]: CredentialRecord };
}

// ---------------------------------------------------------------------------
// createServer — build + start everything (all-or-nothing)
// ---------------------------------------------------------------------------

/**
 * Build and START the daemon. Boot is ALL-OR-NOTHING: every created resource
 * registers a cleanup; ANY init error runs all cleanups in reverse and
 * re-throws (no leaked pool / lock / listener / timer). On success the REST +
 * MCP servers + the periodic reconciler + drift sweep are running over ONE
 * shared core.
 */
export async function createServer(
  config: Config,
  deps: BootDeps = {},
): Promise<BevoxServer> {
  const logger: Logger = deps.logger ?? createPinoLogger();
  // LIFO cleanup stack — populated as resources come up; drained on any
  // failure (fail-safe boot) and by stop() (graceful shutdown).
  const cleanups: (() => Promise<void> | void)[] = [];
  const unwind = async (): Promise<void> => {
    while (cleanups.length > 0) {
      const c = cleanups.pop()!;
      try {
        await c();
      } catch {
        /* best-effort: a cleanup failure must not mask the original error */
      }
    }
  };

  try {
    if (!deps.providers) {
      // The concrete transports are out-of-scope operator config, so the
      // provider set MUST be injected. A missing one is a hard boot error —
      // never a silent no-op backend (fail-safe).
      throw new ReconcileError(
        "precondition",
        "boot: provider routes are required (deps.providers) — the " +
          "concrete transports are operator/deploy configuration",
        { entity: "config" },
      );
    }
    if (!deps.loadDesired || !deps.writeDesired) {
      // State (observed entity shape) and DesiredState (manifest intent
      // shape) are genuinely different schemas with no runtime adapter, so
      // server.ts ships NO default backend for this seam — the
      // deploy-specific adapter is always injected (same fail-fast
      // precedent as `providers`). Value-free: names the dep, no value.
      throw new ReconcileError(
        "precondition",
        "boot: desired-state adapters are required (deps.loadDesired " +
          "and deps.writeDesired) — State and DesiredState are distinct " +
          "schemas with no default runtime adapter",
        { entity: "config" },
      );
    }

    // --- pool + migrations -------------------------------------------------
    // Own (and therefore end on shutdown) a pool we CREATED ourselves; never a
    // borrowed pool — UNLESS a test explicitly opts in via ownsInjectedPool.
    const ownsPool =
      deps.pool === undefined || deps.ownsInjectedPool === true;
    const pool = deps.pool ?? createPool(config.DATABASE_URL);
    if (ownsPool) {
      // Only end a pool we created — never a borrowed (harness) pool.
      cleanups.push(async () => {
        await pool.end();
      });
    }
    if (!deps.skipMigrations) {
      await runMigrations(pool);
    }

    // --- breaker-wrapped composite provider + live registry ---------------
    const clock: BreakerClock = deps.clock ?? REAL_CLOCK;
    const breakers = new Map<string, CircuitBreaker>();
    const wrap = (p: Provider): CircuitBreaker => {
      const existing = breakers.get(p.name);
      if (existing) return existing; // a provider shared across routes (fan-out)
      const cb = new CircuitBreaker(p, {
        maxFailures: BREAKER_MAX_FAILURES,
        cooldownMs: BREAKER_COOLDOWN_MS,
        clock,
      });
      breakers.set(p.name, cb);
      return cb;
    };
    const r = deps.providers;
    const provider = compositeProvider({
      network: wrap(r.network),
      server: r.server.map(wrap),
      volume: wrap(r.volume),
      // Spec 2026-05-26 §3: routes.service is optional (MANAGED_SERVICES=off
      // wires no Docker backend). Same conditional-spread pattern as dns/backup.
      ...(r.service ? { service: wrap(r.service) } : {}),
      ...(r.dns ? { dns: wrap(r.dns) } : {}),
      ...(r.backup ? { backup: wrap(r.backup) } : {}),
    });

    // --- desired-state seam (REQUIRED — guarded above; no unsound cast) ---
    const loadDesired = deps.loadDesired;
    const writeDesired = deps.writeDesired;
    const observedAdapter =
      deps.observedAdapter ??
      ((): State => ({
        servers: [],
        networks: [],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      }));

    // --- the SINGLE shared approval gate (4.3) ----------------------------
    const approvalGate = createApprovalGate({
      pool,
      clock,
      ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
    });

    // --- the SINGLE shared tool catalog (4.4) -----------------------------
    // makeGate reuses the SAME 4.3 implementation with the per-tool
    // sensitivity predicate — the catalog never forks approval logic.
    const catalog = createToolCatalog({
      pool,
      provider,
      observedAdapter,
      loadDesired,
      writeDesired,
      // Spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §3:
      // thread the daemon's logger into the catalog so the apply path's
      // reconcile cycle logs (previously silenced by noopLogger fallback)
      // mirror the periodic timer's observability posture.
      logger,
      // Spec docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.3:
      // opt-in via STRICT_MANIFEST_APPROVAL=on; default false ⇒ v1 FROZEN
      // behavior preserved.
      ...(deps.strictManifestApproval
        ? { strictManifestApproval: deps.strictManifestApproval }
        : {}),
      makeGate: (isSensitive: (item: PlanItem) => boolean): ReconcileGate =>
        createApprovalGate({
          pool,
          clock,
          isSensitive,
          ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
        }),
    });

    // --- credential store (4.2 v1 injected seed) --------------------------
    const credentials: CredentialStore = createInjectedCredentialStore(
      parseCredentials(config.AGENT_CREDENTIALS),
    );
    const secretResolver = deps.secretResolver ?? createStubSecretResolver();

    // --- the wired HealthSource (the seam 6.4 deferred to 6.6) ------------
    // NO new tracking: it folds the REAL live breaker registry snapshots
    // (6.2) + the last periodic reconcile/drift state this module already
    // holds. Pure read; never a secret (breaker snapshot is name+counts only).
    let lastReconciler: ReconcilerSnapshot = {
      state: "idle",
      totalCycles: 0,
    };
    let lastDrift: HealthSnapshot["drift"] = [];
    const health: HealthSource = {
      snapshot(): HealthSnapshot {
        return {
          breakers: [...breakers.values()].map((b) => b.snapshot()),
          drift: lastDrift,
          reconciler: lastReconciler,
        };
      },
    };

    // --- v2 Bloco A: assemble setFirewall deps (spec
    // docs/specs/2026-05-27-wire-v2-set-firewall.md §2.3) — buildBootDeps
    // supplies the HTTP client + working store; serversProvider closure +
    // FirewallProvider need this scope's pool so they're built here.
    let setFirewallDeps:
      | import("./agent/v2/set-firewall.js").SetFirewallDeps
      | undefined;
    if (deps.setFirewallPieces) {
      const {
        v2Http,
        workingStore,
      } = deps.setFirewallPieces;
      const localPool = pool;
      const serversProvider = async (): Promise<
        readonly import("./domain/entities.js").Server[]
      > => {
        const state = await getObservedState(localPool, "server");
        return state.servers;
      };
      const firewallProvider = createHetznerFirewallProvider({
        http: v2Http,
        serversProvider,
      });
      setFirewallDeps = {
        pool: localPool,
        provider: firewallProvider,
        approvalGate,
        workingStore,
        serversProvider,
      };
    }

    // --- v2 run_migrations: assemble RunMigrationsDeps (spec
    // docs/specs/2026-05-28-migration-runner-v1.md §6) — buildBootDeps
    // supplies the timeout + docker-exec adapter; servicesProvider closure
    // needs this scope's pool and the always-sensitive approval gate is
    // built from `makeGate(() => true)` so every invocation routes through
    // the Fase-4 Approval Gate regardless of SQL contents (spec §1.3).
    // Same precedent as setFirewallDeps assembly above.
    let runMigrationsDeps:
      | import("./agent/v2/run-migrations.js").RunMigrationsDeps
      | undefined;
    if (deps.runMigrationsPieces) {
      const localPool = pool;
      const { timeoutMs, dockerExec } = deps.runMigrationsPieces;
      const servicesProvider = async (): Promise<
        readonly import("./domain/entities.js").Service[]
      > => {
        const state = await getObservedState(localPool, "service");
        return state.services;
      };
      // Always-sensitive gate — every run_migrations call passes through
      // the Approval Gate. The runner itself does NOT decide sensitivity
      // (spec §1.3); the caller (server.ts) wires `isSensitive: () => true`.
      const runMigrationsGate = createApprovalGate({
        pool: localPool,
        clock,
        isSensitive: () => true,
        ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
      });
      // appendEvent seam — adapt the {seq} return to the runner's `void`
      // contract (runner uses `unknown` for pool to avoid a hard pg dep).
      const appendEventSeam = async (
        p: unknown,
        event: {
          readonly actor: string;
          readonly scope: "service";
          readonly entity: string;
          readonly op: "create";
          readonly result: "ok" | "noop" | "error";
          readonly after?: Record<string, unknown>;
        },
      ): Promise<void> => {
        await appendStateEvent(p as pg.Pool, event);
      };
      runMigrationsDeps = {
        approvalGate: runMigrationsGate,
        dockerExec,
        servicesProvider,
        timeoutMs,
        appendEvent: appendEventSeam,
        pool: localPool,
      };
    }

    // --- Bloco E (Task 23, THE GAP FIX): assemble the kube/k3s tool deps ---
    // buildBootDeps (entrypoint-wiring.ts Task 21) supplies the transport-backed
    // pieces (`resolveHost` / `getProvider` / `getEnsureK3sProvider` /
    // `namespaceExists`, all over ONE SSH-backed `KubeTransport` whose key was
    // bound SERVER-SIDE — Q-c). Here we add the always-sensitive Approval Gate
    // (`isSensitive: () => true` — applying a manifest / installing k3s on a live
    // host is destructive by category, spec §2 / §3 / Q-a) and, for
    // kubectl_apply ONLY, the per-call ApplyContext mint (its body may carry
    // secret:<ref> tokens resolved ONLY at apply behind the unforgeable gate;
    // ensure_k3s resolves nothing, so it needs no ApplyContext). Mirrors the
    // setFirewallDeps / runMigrationsDeps assembly above.
    let kubectlApplyDeps: KubectlApplyDeps | undefined;
    let ensureK3sDeps: EnsureK3sToolDeps | undefined;
    if (deps.kubePieces) {
      const kp = deps.kubePieces;
      // Always-sensitive gate — every kube/k3s call routes through the Approval
      // Gate regardless of payload (the tools never decide sensitivity).
      const kubeGate = createApprovalGate({
        pool,
        clock,
        isSensitive: () => true,
        ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
      });
      // appendEvent seam (Task 25, ground rule #5) — so an actual apply records
      // a StateEvent in production (the gap fix). Adapts the {seq} return to the
      // tools' `void` contract; the tools type `pool` as `unknown` to avoid a
      // hard pg dep, so we cast back to the real pool here. Same precedent as
      // the runMigrations appendEventSeam above. The tools build the
      // SECRET-FREE / VALUE-FREE `after` payload; here we only persist it.
      const kubeAppendEventSeam = async (
        p: unknown,
        event: {
          readonly actor: string;
          readonly scope: string;
          readonly entity: string;
          readonly op: "create";
          readonly result: "applied";
          readonly after?: Record<string, unknown>;
        },
      ): Promise<void> => {
        await appendStateEvent(p as pg.Pool, event);
      };
      kubectlApplyDeps = {
        resolveHost: kp.resolveHost,
        getProvider: kp.getProvider,
        namespaceExists: kp.namespaceExists,
        approvalGate: kubeGate,
        // Minted ONLY post-gate inside the tool; carries no secret material.
        makeApplyContext: () => createApplyContext(),
        appendEvent: kubeAppendEventSeam,
        pool,
      };
      ensureK3sDeps = {
        resolveHost: kp.resolveHost,
        getEnsureK3sProvider: kp.getEnsureK3sProvider,
        approvalGate: kubeGate,
        appendEvent: kubeAppendEventSeam,
        pool,
      };
    }

    // --- the granted v2 tool surface (Task 23, THE GAP FIX) ---------------
    // server.ts ADVERTISES the WHOLE v2 vocabulary (the prior 8 Bloco A tools +
    // the 2 new kube/k3s) so every v2 tool is reachable in the live daemon.
    // BEFORE this fix createMcpServer was called WITHOUT v2Tools ⇒ it defaulted
    // to the EMPTY set ⇒ the entire v2 surface was DEAD. Advertising all v2
    // tools is correct: per-credential capability (assertV2Capability) + the
    // Approval Gate still gate ACTUAL use — listing a tool does not authorise it.
    const v2Tools: ReadonlySet<V2ToolName> = new Set<V2ToolName>(V2_TOOLS);

    // --- REST (4.5) + MCP (4.7) over the SAME catalog/gate/pool -----------
    const rest = createRestServer({
      catalog,
      credentials,
      approvalGate,
      secrets: { resolver: secretResolver, refs: [] },
      health,
      v2Tools,
      ...(setFirewallDeps ? { setFirewall: setFirewallDeps } : {}),
      ...(runMigrationsDeps ? { runMigrations: runMigrationsDeps } : {}),
      ...(kubectlApplyDeps ? { kubectlApply: kubectlApplyDeps } : {}),
      ...(ensureK3sDeps ? { ensureK3s: ensureK3sDeps } : {}),
    });
    const mcp = createMcpServer({
      catalog,
      credentials,
      // THE GAP FIX: thread the granted v2 tool surface so the WHOLE v2
      // vocabulary is advertised + dispatchable in the live daemon.
      v2Tools,
      ...(setFirewallDeps ? { setFirewall: setFirewallDeps } : {}),
      ...(runMigrationsDeps ? { runMigrations: runMigrationsDeps } : {}),
      ...(kubectlApplyDeps ? { kubectlApply: kubectlApplyDeps } : {}),
      ...(ensureK3sDeps ? { ensureK3s: ensureK3sDeps } : {}),
    });
    cleanups.push(async () => {
      await mcp.close();
    });
    cleanups.push(async () => {
      await rest.close();
    });

    let port: number | undefined;
    if (deps.listen) {
      port = await rest.listen(config.PORT);
    }

    // --- periodic reconciler + drift sweep (ONE timer seam, 6.3-bounded) --
    const scopes = deps.scopes ?? DEFAULT_SCOPES;
    const periodicActor = deps.periodicActor ?? DEFAULT_PERIODIC_ACTOR;
    const reconcileDeps = {
      pool,
      provider,
      gate: approvalGate,
      observedAdapter,
      loadDesired,
      logger,
      cycleTimeoutMs: config.CYCLE_TIMEOUT_MS,
      ...(deps.startTimeout ? { startTimeout: deps.startTimeout } : {}),
    };
    const run = reconcile(reconcileDeps);
    const sweep = runDriftSweep(reconcileDeps);

    // Graceful-shutdown flag, declared BEFORE the schedules so the periodic
    // wrappers can read it. With a REAL setInterval a callback that already
    // fired (queued on the event loop) but has not yet ENTERED its body is
    // NOT guaranteed cancelled by clearInterval — it can still start a cycle
    // AFTER stop()'s flush() resolved and race the LIFO pool.end(). Gating
    // every periodic run on `stopped` makes such a queued-but-not-entered
    // tick an inert no-op (zero DB work) so it cannot race pool.end(); an
    // already-in-flight cycle is unaffected and still awaited by flush().
    // We gate at THIS wrapper layer only — the shared schedulePeriodicReconcile
    // (other callers/tests depend on it) is left untouched.
    let stopped = false;
    const gated =
      <I, O>(fn: (input: I) => Promise<O>) =>
      async (input: I): Promise<O | undefined> => {
        if (stopped) return undefined; // post-stop tick: inert, no DB work
        return fn(input);
      };

    let totalCycles = 0;
    const periodicHandles: PeriodicHandle[] = [];
    for (const scope of scopes) {
      // One periodic reconcile per scope (the per-scope advisory lock already
      // serializes same-scope cycles; an overlapping tick is simply withheld).
      periodicHandles.push(
        schedulePeriodicReconcile(
          gated(async (input) => {
            lastReconciler = {
              state: "running",
              lastCycleAt: clock.now(),
              totalCycles: ++totalCycles,
            };
            const res = await run(input);
            lastReconciler = {
              state: res.timedOut
                ? "timed-out"
                : res.acquired
                  ? "idle"
                  : "withheld",
              lastCycleAt: clock.now(),
              lastResult: res.timedOut
                ? "timeout"
                : `${res.applied.length} applied, ${res.failed.length} failed`,
              nextCycleInMs: config.RECONCILE_INTERVAL_MS,
              totalCycles,
            };
            return res;
          }),
          { scope, actor: periodicActor },
          config.RECONCILE_INTERVAL_MS,
          deps.timer,
        ),
      );
      // The 6.1 drift sweep — observe-only, never corrects. Reuses the SAME
      // periodic timer seam (no second scheduler).
      periodicHandles.push(
        schedulePeriodicReconcile(
          gated(async (input) => {
            const sw = await sweep(input);
            lastDrift = sw.observedDrift.map((d) => ({
              entity: d.entity,
              detail: d.kind,
            }));
            return sw;
          }),
          { scope, actor: periodicActor },
          deps.scopes
            ? config.DRIFT_SWEEP_INTERVAL_MS
            : DEFAULT_DRIFT_SWEEP_MS,
          deps.timer,
        ),
      );
    }
    // Stop timers FIRST on shutdown (no new cycle starts), then await any
    // in-flight tick's flush so a running cycle finishes cleanly (the 6.3
    // cycle timeout already bounds a stuck one) — NEVER killed mid-mutation.
    cleanups.push(async () => {
      for (const h of periodicHandles) h.stop();
      for (const h of periodicHandles) {
        try {
          await h.flush();
        } catch {
          /* a failed in-flight cycle is already recorded as a StateEvent */
        }
      }
    });

    // --- graceful shutdown -------------------------------------------------
    // Cache the shutdown promise so EVERY caller (a second concurrent stop(),
    // or a SIGTERM landing during an in-flight SIGINT-stop) awaits the SAME
    // real completion — no caller resolves before the owned pool has actually
    // ended. doStop() runs exactly once (idempotent); `stopped` is flipped
    // FIRST so a queued periodic tick is already inert before unwind().
    let signalCleanup: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    const doStop = async (): Promise<void> => {
      stopped = true; // gate periodic ticks before tearing anything down
      logger.info(
        { actor: periodicActor, scope: "daemon", entity: "server" },
        "bevox daemon stopping (graceful)",
      );
      signalCleanup?.();
      await unwind(); // timers → MCP → REST → pool (releases advisory locks)
    };
    const stop = (): Promise<void> => (stopping ??= doStop());

    if (deps.installSignalHandlers) {
      const onSignal = (): void => {
        void stop();
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      signalCleanup = (): void => {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
      };
    }

    logger.info(
      { actor: periodicActor, scope: "daemon", entity: "server" },
      "bevox daemon started (REST+MCP+reconciler)",
    );

    return {
      rest,
      mcp,
      breakers,
      health,
      ...(port !== undefined ? { port } : {}),
      stop,
    };
  } catch (err) {
    // BOOT IS ALL-OR-NOTHING: a config/init failure must NOT leave a half-up
    // daemon holding a lock or a pool — unwind every resource created so far
    // (LIFO) and re-throw the (value-free) error untouched.
    await unwind();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// startServer — the process entrypoint (loadConfig → createServer)
// ---------------------------------------------------------------------------

/**
 * The daemon entrypoint: validate the environment (value-free fail-fast,
 * BEFORE any resource — boot all-or-nothing), then build+start everything.
 * `env` is injectable for tests; production passes nothing (process.env). The
 * concrete provider transports are operator/deploy config (out of Task-6.6
 * scope) so a real deploy supplies `deps.providers`; this signature keeps the
 * minimal surface and never opens a real socket itself.
 */
export async function startServer(
  env?: Record<string, string | undefined>,
  deps: BootDeps = {},
): Promise<BevoxServer> {
  const config = loadConfig(env);
  return createServer(config, {
    listen: true,
    installSignalHandlers: true,
    ...deps,
  });
}
