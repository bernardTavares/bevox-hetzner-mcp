/**
 * core/src/providers/docker.ts
 *
 * Task 3.2 — DockerProvider: the concrete `Provider` (provider.ts) for the
 * Service entity (entities.ts). It is the ONLY translation seam between a
 * declarative Service and the Docker Engine API container surface, driving
 * every request through an injected `DockerTransport` (the SSH-tunnel-shaped
 * seam from core/test/fakes/docker-http.ts). The provider is transport-
 * agnostic: it never learns whether it speaks to the in-process fake or a
 * future `ssh2`-backed live Engine client — only Engine API method+path+body.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; YAGNI):
 *
 *   - IDEMPOTENCY IS THE CENTRAL INVARIANT (Fase 2 exit criterion, must keep
 *     holding now that Services join — Task 3.5 verifies end-to-end). A
 *     Service with N replicas maps to N containers with DETERMINISTIC stable
 *     names `<service>-<i>` (i = 0..N-1). apply() OBSERVES BEFORE IT CREATES
 *     per replica: it lists managed containers, and for every replica index
 *     that already exists it performs NO create; existing-but-stopped
 *     replicas are (re)started. Once every replica exists and runs, apply()
 *     is a NO-OP returning `changed:false`. conformanceHarness(makeProvider,
 *     action, "service") is the oracle, wired directly in the test.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. This task only observes / creates /
 *     starts / verifies. There is NO container removal: orphan/extra
 *     containers are the reconciler's drift concern (Task 2.9), not ours. A
 *     destructive `op` (remove/destroy/…) is a deliberate NO-OP returning
 *     `changed:false` (consistent with hetzner-cloud.ts) — it NEVER deletes
 *     a container. No destructive rollback on partial failure.
 *
 *   - PRECONDITION BEFORE WRITE. Malformed Service desired (fails the
 *     entities.ts ServiceSchema) is a ReconcileError("precondition"), never a
 *     crash, raised before any Engine write. An unknown scope/kind is
 *     likewise "precondition".
 *
 *   - 3.2 / 3.3 SECRET BOUNDARY. Any env value shaped `secret:<ref>` is
 *     preserved as the structured non-Env binding `bevox.secret.<envKey> =
 *     secret:<ref>` container Label (the ref is non-sensitive, mirroring
 *     Fase-1 secrets.ts) — that label is the STABLE convergence key
 *     isConverged() compares, byte-identical regardless of resolution, so
 *     verify() never flaps. The raw `secret:` string NEVER reaches Docker
 *     `Env`, observe() or the plan. Task 3.3 (this task) adds APPLY-ONLY
 *     resolution: when a `SecretResolver` + an unforgeable `ApplyContext`
 *     token are injected via options (minted at the apply boundary —
 *     reconcile/applyPlan — NEVER in plan/dry_run), apply() resolves each
 *     binding behind secrets.ts's gate and injects the RESOLVED VALUE into
 *     the running container's Env, ONLY over the create transport, ONLY in
 *     the real apply branch. Resolution is structurally unreachable from
 *     observe()/verify()/plan; absent resolver/token, apply() is byte-
 *     identical to 3.2 (no value in Env). NO resolved secret value EVER
 *     appears in plan/dry_run/observe/logs/StateEvents/error messages.
 *
 *   - ERROR MAPPING via domain/errors.ts ONLY. The transport returns
 *     {status,json}; any non-2xx is classified through classify() into a
 *     ReconcileError (engine 500 → transient, etc). A 409 dup-name is treated
 *     as idempotent-existing (converged), never an error — observe-before-
 *     create normally avoids it, but a race is safe.
 *
 *   - MINIMAL SURFACE. One factory `createDockerProvider(opts)` returning
 *     `Provider`; opts inject the `DockerTransport`. Scope is Services only —
 *     no networks/volumes-as-objects, no logs/exec, no real ssh2 (YAGNI).
 *
 * Exported API:
 *   createDockerProvider(opts: DockerProviderOptions): Provider
 *   interface DockerProviderOptions
 */

import { z } from "zod";
import { ServiceSchema, type Service } from "../domain/entities.js";
import { classify, ReconcileError } from "../domain/errors.js";
import type { ApplyContext, SecretResolver } from "../store/secrets.js";
import type { DockerTransport } from "./docker-transport.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "./provider.js";
import {
  waitForHealthy,
  parseWaitTimeout,
  type WaitHealthyDeps,
} from "./docker-wait-healthy.js";

// ---------------------------------------------------------------------------
// Options — the test injects the Docker Engine fake's transport here.
// ---------------------------------------------------------------------------

export interface DockerProviderOptions {
  /**
   * The SSH-tunnel-shaped Engine API seam (method,path,body → {status,json}).
   * Injected in tests as the in-process fake; a live `ssh2`-backed transport
   * implements the SAME interface unchanged.
   */
  readonly transport: DockerTransport;

  /**
   * 3.3 SECRET-AT-APPLY SEAM (OPTIONAL — additive, backward-compatible).
   *
   * When BOTH `secretResolver` and `applyContext` are supplied, apply()
   * resolves each `secret:<ref>` env binding (preserved by 3.2 as the
   * `bevox.secret.<envKey>` label) WITH the unforgeable `applyContext` token
   * and injects the resolved value into the container's Engine `Env` — ONLY
   * at apply, ONLY over the create transport. The token MUST be minted at the
   * apply boundary (reconcile/applyPlan), NEVER in plan/dry_run.
   *
   * When EITHER is absent (the 3.2 default / plan / dry_run / unit tests in
   * isolation), apply() behaves EXACTLY as 3.2: secret-bound keys are NOT
   * resolved and NOT placed in Env; the `bevox.secret.<k>` binding label is
   * still preserved. observe()/verify()/plan never resolve and never depend
   * on these options — so no secret value can surface there by construction.
   */
  readonly secretResolver?: SecretResolver;
  /**
   * The apply-only capability token (secrets.ts `createApplyContext()`).
   * Its sole purpose: pass secrets.ts's unforgeable gate at apply. plan /
   * dry_run code paths must never construct or pass it, so they are
   * STRUCTURALLY unable to reach a resolved secret value.
   *
   * ISOLATION-TEST-ONLY. Supplying the token HERE (via provider options) is
   * permitted ONLY for unit tests exercising apply() in isolation. The
   * PRODUCTION apply path MUST instead forward the token through the
   * action-carried `applyContext` — threaded by applyPlan via
   * `ctx.applyContext` and attached ONLY to items that reach
   * `provider.apply()` — NEVER by constructing the provider with an options
   * token. Rationale (spec §SECRET BOUNDARY): a provider built once with an
   * options token would carry secret-resolution capability for its WHOLE
   * lifetime, decoupled from the per-cycle apply boundary; the per-action
   * channel rebinds that capability to each apply cycle, keeping resolution
   * structurally unreachable outside it.
   */
  readonly applyContext?: ApplyContext;

  /**
   * WAIT-FOR-HEALTHY CLOCK SEAM (OPTIONAL — additive, Phase 2.0). Injected in
   * tests so `apply()`'s dep health-wait never touches the wall clock. Default:
   * real `Date.now` / `setTimeout`-based sleep. Pure plumbing — no behavioural
   * effect beyond the poll cadence.
   */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;

  /**
   * VOLUME-NAME BIND RESOLUTION SEAM (OPTIONAL — additive, backward-compatible).
   * spec: 2026-06-01-volume-hetzner-bind-automount.md §3.
   *
   * Given a declared Hetzner volume NAME, returns its real on-host mount
   * (e.g. `/mnt/HC_Volume_42`) or `undefined` when the volume is not yet
   * observed / has no `hcloud_id`. When supplied, a `service.volumes` entry
   * shaped `<name>:<container_path>` (with `<name>` NOT an absolute path) is
   * resolved to `<mount>:<container_path>` in BOTH createBody AND isConverged,
   * so the resolved bind is what gets written AND what convergence compares —
   * keeping re-apply a no-op (no container re-create flap).
   *
   * When absent (the default / isolation tests), every bind passes AS-IS —
   * behaviour is byte-identical to before this seam. Resolution reads the
   * observed VOLUME store at the composition root; the DockerProvider never
   * calls the Hetzner provider (no cross-provider coupling).
   */
  readonly resolveVolumeMount?: (volumeName: string) => Promise<string | undefined>;
  /**
   * OPTIONAL host→secret-ref map for private-registry auth (Bug 11; e.g.
   * `{"ghcr.io":"ghcr-pat"}`). Absent / empty ⇒ `ensureImage` never sends an
   * `X-Registry-Auth` header (public pulls unchanged). When the image's
   * registry host has a configured ref, the ref resolves AT APPLY (behind the
   * `ApplyContext`, via `secretResolver`) to `{username,password}`, encoded as
   * the auth-config header. Wired at the composition root from REGISTRY_AUTH_REFS.
   */
  readonly registryAuthRefs?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Labels — mark managed containers + carry the Service identity so observe()
// and the per-replica idempotency lookup are reliable and scope-correct.
// ---------------------------------------------------------------------------

// Managed-container label vocabulary. Exported so the co-located
// wait-for-healthy helper (docker-wait-healthy.ts) finds a dep's replicas
// through the same label contract (DRY — single source).
export const L_MANAGED = "bevox.managed";
export const L_SERVICE = "bevox.service";
const L_REPLICA = "bevox.replica";
/** server_selector entries are flattened to `bevox.selector.<k>=<v>`. */
const L_SELECTOR_PREFIX = "bevox.selector.";
/**
 * 3.2→3.3 SECRET-BINDING CHANNEL. An env value shaped `secret:<ref>` records
 * the binding `envKey → ref` as `bevox.secret.<envKey>=secret:<ref>` on the
 * container Labels — NEVER in Docker `Env`. The label namespace is the
 * minimal sound channel: it is part of the create body (so it round-trips),
 * is retrievable by 3.3's apply path via list/inspect Labels, and is
 * structurally separate from `Env` so no secret-shaped string ever lands in
 * the container environment or in observe()'s entity list.
 */
const L_SECRET_PREFIX = "bevox.secret.";
const SECRET_RE = /^secret:(.+)$/;

/**
 * Bug 11: the resolved registry credential shape. A ref configured in
 * REGISTRY_AUTH_REFS must resolve to this JSON; anything else fail-closes
 * (the value never enters the error — only the host does).
 */
const RegistryCredSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const SCOPE = "service";

/**
 * Convert a `"<N>s"` | `"<N>m"` duration (schema-validated `^\d+[sm]$`) to
 * nanoseconds — the unit the Engine `Healthcheck.Interval`/`Timeout`/
 * `StartPeriod` fields expect (gap #2, Phase 2.1).
 */
function durationToNs(d: string): number {
  const m = /^(\d+)([sm])$/.exec(d);
  if (!m) return 0;
  const n = Number(m[1]);
  const seconds = m[2] === "m" ? n * 60 : n;
  return seconds * 1_000_000_000;
}

/**
 * Split an image reference into the Docker `POST /images/create` query parts
 * (Bug 4). Digest-pinned refs (`repo@sha256:…`) carry the digest in `fromImage`
 * with NO tag; otherwise the tag is the segment after the last `:` (when that
 * `:` is after the last `/`, so a registry `host:port` is not mistaken for a
 * tag); a bare name defaults to `latest`. Exported test-only (Rule 8).
 */
export function _parseImageRef(image: string): {
  fromImage: string;
  tag?: string;
} {
  if (image.includes("@")) return { fromImage: image };
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return { fromImage: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  }
  return { fromImage: image, tag: "latest" };
}

/**
 * Derive the registry host an image ref pulls from (Bug 11; spec §1.4). The
 * segment BEFORE the first `/` is the host IFF it looks like one — it contains
 * `.` or `:` (a domain or `host:port`) or equals `localhost`; otherwise the
 * ref is unqualified and pulls from Docker Hub, whose canonical host (BOTH the
 * `REGISTRY_AUTH_REFS` map key AND the auth-config `serveraddress`) is
 * `docker.io` (the Engine's internal `registry-1.docker.io` is not surfaced).
 * Exported test-only (Rule 8); sibling to `_parseImageRef`.
 */
export function _registryHostOf(image: string): string {
  const slash = image.indexOf("/");
  if (slash === -1) return "docker.io";
  const first = image.slice(0, slash);
  if (first === "localhost" || first.includes(".") || first.includes(":")) {
    return first;
  }
  return "docker.io";
}

// ---------------------------------------------------------------------------
// Engine list/inspect projections (subset the fake/Engine return).
// ---------------------------------------------------------------------------

interface ListItem {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly State: string;
}

interface Inspect {
  readonly State: { readonly Running: boolean };
  readonly Config: {
    readonly Image: string;
    readonly Labels: Readonly<Record<string, string>>;
    readonly Env?: readonly string[];
    readonly ExposedPorts?: Readonly<Record<string, unknown>>;
    readonly Cmd?: readonly string[];
    readonly Healthcheck?: { readonly Test?: readonly string[] };
  };
  readonly HostConfig?: {
    readonly Binds?: readonly string[];
    readonly RestartPolicy?: { readonly Name?: string };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDockerProvider(opts: DockerProviderOptions): Provider {
  if (!opts.transport) {
    throw new ReconcileError(
      "fatal",
      "DockerProvider: a DockerTransport is required",
    );
  }
  const tx = opts.transport;
  const secretResolver = opts.secretResolver;
  const applyContext = opts.applyContext;
  const resolveVolumeMount = opts.resolveVolumeMount;
  const registryAuthRefs = opts.registryAuthRefs;

  /**
   * Map ONE `service.volumes` entry to its effective Engine bind. The SINGLE
   * source of truth used by BOTH createBody and isConverged so the written
   * bind and the convergence comparison never diverge (idempotency lock —
   * spec §3 / §6). AS-IS when: bare name (no ':'), absolute host path (`left`
   * starts with '/'), no resolver, or the resolver returns undefined.
   */
  async function resolveBind(entry: string): Promise<string> {
    const idx = entry.indexOf(":");
    if (idx < 0) return entry; // bare name → AS-IS
    const left = entry.slice(0, idx);
    const containerPath = entry.slice(idx + 1);
    if (left.startsWith("/")) return entry; // absolute host path → AS-IS
    if (resolveVolumeMount === undefined) return entry; // no resolver → AS-IS
    const mount = await resolveVolumeMount(left);
    if (mount === undefined) return entry; // unresolved → AS-IS
    return `${mount}:${containerPath}`;
  }
  // Wait-for-healthy clock seam (Phase 2.0): real clock unless injected.
  const nowMs = opts.now ?? ((): number => Date.now());
  const sleepMs =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));

  /** Narrow a "<kind>:<name>" key / scope to "service"; else precondition. */
  function assertScope(scopeOrEntity: string): void {
    const kind = scopeOrEntity.split(":", 1)[0] ?? "";
    if (kind !== SCOPE) {
      throw new ReconcileError(
        "precondition",
        `DockerProvider: unsupported scope/kind "${kind}" (supported: ${SCOPE})`,
        { entity: scopeOrEntity },
      );
    }
  }

  /** Validate desired against ServiceSchema → precondition on failure. */
  function parseService(action: PlanAction): Service {
    const parsed = ServiceSchema.safeParse(action.desired);
    if (!parsed.success) {
      throw new ReconcileError(
        "precondition",
        `DockerProvider: malformed Service desired for ${action.entity} ` +
          `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        { entity: action.entity },
      );
    }
    if (parsed.data.name.length === 0) {
      throw new ReconcileError(
        "precondition",
        `DockerProvider: Service name must be non-empty for ${action.entity}`,
        { entity: action.entity },
      );
    }
    return parsed.data;
  }

  /**
   * One Engine call with non-2xx mapped through domain/errors.ts. 2xx/204/304
   * pass through. 3xx idempotent-success (304 already started/stopped) is a
   * success for our purposes.
   */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    entity?: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<{ status: number; json: unknown }> {
    const res = await tx.request(method, path, body, headers);
    if (res.status >= 200 && res.status < 400) return res;
    const msg =
      (res.json &&
      typeof res.json === "object" &&
      "message" in res.json &&
      typeof (res.json as { message: unknown }).message === "string"
        ? (res.json as { message: string }).message
        : `Engine API ${method} ${path} failed`) + ` (status ${res.status})`;
    throw new ReconcileError(classify({ httpStatus: res.status }), msg, {
      entity,
    });
  }

  /**
   * All bevox-managed containers (label filter — never touches unmanaged).
   * `all=true` is REQUIRED: the Engine lists only RUNNING containers by
   * default, so a freshly-created ("Created") replica would be invisible and
   * the start loop would skip it (Bug 5). We must see created/exited managed
   * containers to start and reconcile them.
   */
  async function listManaged(): Promise<ListItem[]> {
    const filters = JSON.stringify({ label: [`${L_MANAGED}=true`] });
    const res = await call(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    const j = res.json;
    return Array.isArray(j) ? (j as ListItem[]) : [];
  }

  /** Managed containers for one Service, keyed by replica index. */
  async function replicasOf(
    service: string,
  ): Promise<Map<number, ListItem>> {
    const all = await listManaged();
    const out = new Map<number, ListItem>();
    for (const c of all) {
      if (c.Labels[L_SERVICE] !== service) continue;
      const raw = c.Labels[L_REPLICA];
      const idx = /^\d+$/.test(raw ?? "") ? Number(raw) : NaN;
      if (Number.isInteger(idx)) out.set(idx, c);
    }
    return out;
  }

  /** Deterministic stable container name for replica `i` of `service`. */
  function replicaName(service: string, i: number): string {
    return `${service}-${i}`;
  }

  /**
   * Bug 4: pull the image before create, or ContainerCreate 404s ("No such
   * image"). `POST /images/create` streams NDJSON; the Engine reports pull
   * errors IN-STREAM at HTTP 200, so we inspect the parsed array for `{error}`
   * (non-2xx is already thrown by call()). Fail-closed: a pull error throws and
   * no container is created. Pull does NOT set `changed` (idempotent re-apply).
   */
  /**
   * Bug 11 — resolve the registry credential for `image`'s host (if configured)
   * and return the `{ "X-Registry-Auth": <base64url> }` header, or `undefined`
   * when no auth applies (host without a configured ref, or no apply token).
   * APPLY-ONLY: resolution is gated by the ApplyContext; plan/dry_run carry no
   * token ⇒ undefined ⇒ no header. Fail-closed (L5): a missing or non-
   * {username,password} resolved value throws `fatal`, naming ONLY the host —
   * the resolved value never enters the message.
   */
  async function buildRegistryAuth(
    image: string,
    entity: string,
    token: ApplyContext | undefined,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const host = _registryHostOf(image);
    const ref = registryAuthRefs?.[host];
    if (ref === undefined || token === undefined || secretResolver === undefined) {
      return undefined;
    }
    const resolved = await secretResolver.resolve(`secret:${ref}`, token);
    if (resolved.status !== "ok") {
      throw new ReconcileError("fatal", `registry auth for ${host} is not available`, {
        entity,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resolved.value);
    } catch {
      throw new ReconcileError(
        "fatal",
        `registry auth for ${host} is not a {username,password} JSON`,
        { entity },
      );
    }
    const cred = RegistryCredSchema.safeParse(parsed);
    if (!cred.success) {
      throw new ReconcileError(
        "fatal",
        `registry auth for ${host} is not a {username,password} JSON`,
        { entity },
      );
    }
    const blob = JSON.stringify({
      username: cred.data.username,
      password: cred.data.password,
      serveraddress: host,
    });
    return { "X-Registry-Auth": Buffer.from(blob).toString("base64url") };
  }

  async function ensureImage(
    image: string,
    entity: string,
    actionApplyContext: ApplyContext | undefined,
  ): Promise<void> {
    // Bug 11 / Peça B — skip-if-exists. Probe the local Engine first; a 200
    // means the image is already present (pulled, or pre-pulled by the
    // operator) ⇒ no pull, no registry hit, no `changed`. Route through
    // tx.request (NOT call()) so the expected 404 ("absent") is a branch, not
    // a thrown error. The full ref is the probe key (encodeURIComponent).
    const probe = await tx.request(
      "GET",
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (probe.status === 200) return;

    // Bug 11 / Peça A — private-registry auth. If the image's registry host has
    // a configured ref AND we hold an apply token, resolve the credential AT
    // APPLY (behind the ApplyContext gate, via secretResolver) and build the
    // X-Registry-Auth header. The per-action token takes precedence over the
    // factory-options token (isolation path). Absent host/token ⇒ no header,
    // public-pull path unchanged.
    const token = actionApplyContext ?? applyContext;
    const authHeader = await buildRegistryAuth(image, entity, token);

    const { fromImage, tag } = _parseImageRef(image);
    let q = `fromImage=${encodeURIComponent(fromImage)}`;
    if (tag !== undefined) q += `&tag=${encodeURIComponent(tag)}`;
    const res = await call("POST", `/images/create?${q}`, undefined, entity, authHeader);
    if (Array.isArray(res.json)) {
      const failed = res.json.some(
        (o) => o !== null && typeof o === "object" && "error" in o,
      );
      if (failed) {
        // Do NOT echo the stream (could carry registry detail); name the image.
        throw new ReconcileError(
          "transient",
          `docker pull "${image}" failed (registry/pull error)`,
          { entity },
        );
      }
    }
  }

  /**
   * Build the Engine ContainerCreate body for one replica. server_selector is
   * carried in Labels (host routing is the transport's concern, not ours).
   *
   * 3.2 / 3.3 SECRET BOUNDARY. The env binding `K=secret:<ref>` is split:
   *   - 3.2 (here): does NOT resolve the secret value, does NOT put the
   *     resolved value OR the raw `secret:` string into Docker `Env`, and
   *     never surfaces it via observe(). It DOES preserve the structured
   *     binding `K → secret:<ref>` on the container Labels under
   *     `bevox.secret.<K>` (the ref is non-sensitive — mirrors how Fase-1
   *     secrets.ts/manifest-repo.ts treat the "secret:<name>" form).
   *   - 3.3 (later): reads that label binding, resolves the ref WITH the
   *     applyContext token, and injects the resolved value as container Env
   *     at apply. The Env array built here therefore intentionally omits
   *     every secret-bound key; 3.3 fills it.
   * This keeps the key→ref binding alive for 3.3 while no secret value (and
   * no raw `secret:` string) ever reaches Docker Env, observe() or the plan.
   */
  async function createBody(
    svc: Service,
    i: number,
    /**
     * 3.3: envKey → RESOLVED secret value, populated ONLY by apply() after a
     * gate-guarded resolve. Empty map (the default / plan / 3.2 path) ⇒ NO
     * secret value reaches Env and behaviour is byte-identical to 3.2.
     */
    resolvedSecrets: ReadonlyMap<string, string> = new Map(),
  ): Promise<Record<string, unknown>> {
    const labels: Record<string, string> = {
      [L_MANAGED]: "true",
      [L_SERVICE]: svc.name,
      [L_REPLICA]: String(i),
    };
    for (const [k, v] of Object.entries(svc.server_selector ?? {})) {
      labels[`${L_SELECTOR_PREFIX}${k}`] = String(v);
    }

    const env: string[] = [];
    for (const [k, v] of Object.entries(svc.env ?? {})) {
      const m = SECRET_RE.exec(v);
      if (m) {
        // ALWAYS preserve the key→ref binding in the structured (non-Env)
        // label channel — this is the STABLE convergence key isConverged()
        // compares (3.2), so it must be byte-identical whether or not a
        // secret was resolved (else verify() would flap → breaks idempotency
        // / Task 3.5). Storing the ref is safe (non-secret).
        labels[`${L_SECRET_PREFIX}${k}`] = v;
        // 3.3: ONLY if apply() resolved this binding behind the applyContext
        // gate do we inject the RESOLVED VALUE into the running container's
        // Env. The default/plan/3.2 path passes an empty map ⇒ nothing here,
        // so no secret value can ever reach Env outside a gated apply().
        const resolved = resolvedSecrets.get(k);
        if (resolved !== undefined) env.push(`${k}=${resolved}`);
        continue;
      }
      env.push(`${k}=${v}`);
    }

    const exposed: Record<string, Record<string, never>> = {};
    for (const p of svc.ports ?? []) {
      // "80" → "80/tcp"; "443/tcp" kept as-is. Engine shape: { "80/tcp": {} }.
      exposed[p.includes("/") ? p : `${p}/tcp`] = {};
    }

    const body: Record<string, unknown> = {
      Image: svc.image,
      Labels: labels,
    };
    // gap #1: container argv. Conditional — omitted ⇒ no Cmd key ⇒ body
    // byte-identical to the pre-change mapping (no isConverged flap).
    if (svc.command !== undefined) body.Cmd = [...svc.command];
    if (env.length > 0) body.Env = env;
    if (Object.keys(exposed).length > 0) body.ExposedPorts = exposed;
    if ((svc.volumes ?? []).length > 0) {
      // Resolve each bind through the shared helper (volume-name → real
      // Hetzner mount when a resolver matches; AS-IS otherwise). isConverged
      // resolves identically so re-apply is a no-op.
      const binds: string[] = [];
      for (const entry of svc.volumes!) binds.push(await resolveBind(entry));
      body.HostConfig = { Binds: binds };
    }
    // gap #4: restart policy. MERGE into HostConfig (do not clobber Binds);
    // conditional — omitted ⇒ no RestartPolicy key ⇒ byte-identical body.
    if (svc.restart !== undefined) {
      body.HostConfig = {
        ...((body.HostConfig as Record<string, unknown>) ?? {}),
        RestartPolicy: { Name: svc.restart },
      };
    }
    // gap #2 (Phase 2.1): declarative healthcheck → Engine Healthcheck. Durations
    // map to ns. Conditional — omitted ⇒ no Healthcheck key ⇒ byte-identical body.
    // Declared ⇒ overrides the image HEALTHCHECK (compose precedence).
    if (svc.healthcheck !== undefined) {
      const hc = svc.healthcheck;
      const health: Record<string, unknown> = { Test: [...hc.test] };
      if (hc.interval !== undefined) health.Interval = durationToNs(hc.interval);
      if (hc.timeout !== undefined) health.Timeout = durationToNs(hc.timeout);
      if (hc.retries !== undefined) health.Retries = hc.retries;
      if (hc.start_period !== undefined) {
        health.StartPeriod = durationToNs(hc.start_period);
      }
      body.Healthcheck = health;
    }
    return body;
  }

  /**
   * Inspect → does the container match what create() mapped for this Service?
   *
   * DESIGN PRINCIPLE: verify() checks running + image AND the mapped fields it
   * itself set at create (exposed ports, bind volumes, server_selector). It
   * deliberately does NOT detect orphan/extra containers or unmanaged labels —
   * that broader observed-vs-desired reconciliation is the reconciler's drift
   * concern (Task 2.9). Mapped-field fidelity, however, is THIS provider's
   * mapping contract: post-create port/volume/selector drift must not be
   * invisible, else verify() would be weaker than the mapping it applies.
   */
  async function isConverged(
    item: ListItem,
    svc: Service,
  ): Promise<boolean> {
    const res = await call("GET", `/containers/${item.Id}/json`);
    const insp = res.json as Inspect;
    if (insp.State.Running !== true) return false;
    if (insp.Config.Image !== svc.image) return false;

    // gap #1: compare Cmd ONLY when the desired service declares it. Omitted
    // ⇒ not compared (Engine/image default stays, no flap on existing
    // containers — the transversal idempotency invariant).
    if (svc.command !== undefined) {
      const haveCmd = [...(insp.Config.Cmd ?? [])];
      if (haveCmd.length !== svc.command.length) return false;
      for (let j = 0; j < svc.command.length; j++) {
        if (haveCmd[j] !== svc.command[j]) return false;
      }
    }

    const wantPorts = new Set<string>();
    for (const p of svc.ports ?? []) {
      wantPorts.add(p.includes("/") ? p : `${p}/tcp`);
    }
    // Bug 6: declared ports must be a SUBSET of the container's exposed ports —
    // NOT exact equality. The IMAGE itself exposes ports (e.g. nginx → 80/tcp)
    // that appear in inspect even when the manifest declares none; those are
    // not drift the provider set. Require every declared port to be present;
    // tolerate extra image-default ports.
    const havePorts = new Set(Object.keys(insp.Config.ExposedPorts ?? {}));
    for (const p of wantPorts) if (!havePorts.has(p)) return false;

    // gap #4: compare RestartPolicy ONLY when declared (omitted ⇒ not
    // compared, Engine default stays, no flap).
    if (svc.restart !== undefined) {
      if (insp.HostConfig?.RestartPolicy?.Name !== svc.restart) return false;
    }

    // gap #2 (Phase 2.1): compare healthcheck Test ONLY when declared.
    if (svc.healthcheck !== undefined) {
      const haveTest = [...(insp.Config.Healthcheck?.Test ?? [])];
      const wantTest = svc.healthcheck.test;
      if (haveTest.length !== wantTest.length) return false;
      for (let j = 0; j < wantTest.length; j++) {
        if (haveTest[j] !== wantTest[j]) return false;
      }
    }

    // Resolve wantBinds through the SAME helper createBody uses, BEFORE
    // comparing — otherwise the unresolved desired bind never matches the
    // resolved bind written at create, and re-apply flaps into re-create.
    const wantBinds: string[] = [];
    for (const entry of svc.volumes ?? []) wantBinds.push(await resolveBind(entry));
    const haveBinds = [...(insp.HostConfig?.Binds ?? [])];
    if (haveBinds.length !== wantBinds.length) return false;
    for (let j = 0; j < wantBinds.length; j++) {
      if (haveBinds[j] !== wantBinds[j]) return false;
    }

    const labels = insp.Config.Labels ?? {};
    for (const [k, v] of Object.entries(svc.server_selector ?? {})) {
      if (labels[`${L_SELECTOR_PREFIX}${k}`] !== String(v)) return false;
    }
    return true;
  }

  /**
   * 3.3 APPLY-ONLY secret resolution. For every `K=secret:<ref>` env binding
   * on `svc`, resolve the ref WITH the applyContext token and return
   * envKey → resolved value. Called ONLY from apply() (never observe/verify/
   * plan). When resolver/token are absent, returns an EMPTY map ⇒ apply is
   * byte-identical to 3.2 (no value in Env).
   *
   * SECURITY: the resolve() call is gated by secrets.ts's unforgeable
   * ApplyContext. A resolver returning a value-free "deferred" result (the
   * v1 stub) injects NOTHING — only an explicit "ok" value is injected. No
   * secret value is ever logged, returned in errors, or surfaced elsewhere.
   */
  async function resolveSecretEnv(
    svc: Service,
    /**
     * The apply-boundary token forwarded on PlanAction by applyPlan() (the
     * canonical path). Falls back to the factory-options token only for
     * provider-in-isolation tests. plan/dry_run supply NEITHER.
     */
    actionToken: ApplyContext | undefined,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const token = actionToken ?? applyContext;
    if (!secretResolver || !token) return out;
    for (const [k, v] of Object.entries(svc.env ?? {})) {
      const m = SECRET_RE.exec(v);
      if (!m) continue;
      // resolve() throws ReconcileError("fatal") if the token is missing/
      // forged — a plan/dry_run path can never reach here (no token wired).
      const r = await secretResolver.resolve(v, token);
      if (r.status === "ok") out.set(k, r.value);
      // "deferred" (v1 stub): backend not built — inject nothing, never throw.
    }
    return out;
  }

  return {
    name: "docker",

    async observe(scope: string): Promise<ObservedSlice> {
      assertScope(scope);
      const all = await listManaged();
      // Group replica containers by their Service label.
      const byService = new Map<string, ListItem[]>();
      for (const c of all) {
        const s = c.Labels[L_SERVICE];
        if (!s) continue;
        const list = byService.get(s);
        if (list) list.push(c);
        else byService.set(s, [c]);
      }
      // Task 4: build a ServiceSchema-shaped payload per service. Image comes
      // from inspecting one replica (the list projection omits it). The
      // observed env surfaces ONLY non-secret keys: a secret-bound key
      // (marked by a `bevox.secret.<k>` label) is OMITTED entirely — observe
      // leaks NEITHER the resolved value (in Config.Env) NOR the ref name; the
      // key→ref binding lives only on the label, where the apply path reads it
      // (3.2/3.3 secret boundary — observe carries no ApplyContext).
      const entities: Array<{ key: string; payload: unknown }> = [];
      for (const [name, containers] of byService) {
        const rep = containers[0]!;
        const insp = (await tx.request("GET", `/containers/${rep.Id}/json`))
          .json as Inspect;
        const secretKeys = new Set<string>();
        for (const lk of Object.keys(rep.Labels)) {
          if (lk.startsWith(L_SECRET_PREFIX)) {
            secretKeys.add(lk.slice(L_SECRET_PREFIX.length));
          }
        }
        const env: Record<string, string> = {};
        for (const kv of insp.Config.Env ?? []) {
          const eq = kv.indexOf("=");
          if (eq < 0) continue;
          const k = kv.slice(0, eq);
          if (secretKeys.has(k)) continue; // secret-bound: never surface value or ref
          env[k] = kv.slice(eq + 1);
        }
        const payload: Record<string, unknown> = {
          name,
          image: insp.Config.Image,
          replicas: containers.length,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        entities.push({ key: `${SCOPE}:${name}`, payload });
      }
      return { scope, entities };
    },

    async verify(action: PlanAction): Promise<boolean> {
      assertScope(action.entity);
      const svc = parseService(action);
      const have = await replicasOf(svc.name);
      if (have.size < svc.replicas) return false;
      for (let i = 0; i < svc.replicas; i++) {
        const c = have.get(i);
        if (!c) return false;
        if (!(await isConverged(c, svc))) return false;
      }
      return true;
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      assertScope(action.entity);

      // FAIL-SAFE: destructive intents are NOT handled here. No-op, never
      // delete a container (orphan→drift is the reconciler's job, Task 2.9).
      if (action.op === "remove" || action.op === "destroy") {
        return { entity: action.entity, op: action.op, changed: false };
      }

      const svc = parseService(action);
      const have = await replicasOf(svc.name);

      // Phase 2.0 — wait-for-healthy gate. Provider-surfaced events ride back on
      // ApplyResult.events for the reconciler Record step to persist with the
      // cycle actor. The gate runs ONLY when this apply will CREATE a replica;
      // a converged re-apply skips it entirely (preserves the idempotent no-op).
      const events: Array<{ op: string; after?: Record<string, unknown> }> = [];
      const needsCreate = ((): boolean => {
        for (let i = 0; i < svc.replicas; i++) if (!have.get(i)) return true;
        return false;
      })();
      const deps = svc.depends_on ?? [];
      if (needsCreate && deps.length > 0) {
        const waitDeps: WaitHealthyDeps = {
          call: (m, p, b) => call(m, p, b),
          now: nowMs,
          sleep: sleepMs,
        };
        for (const entry of deps) {
          const dep = typeof entry === "string" ? entry : entry.name;
          const timeoutMs = parseWaitTimeout(
            typeof entry === "string" ? undefined : entry.wait_healthy_timeout,
          );
          const outcome = await waitForHealthy(dep, timeoutMs, waitDeps);
          if (outcome.outcome === "wait_skipped") {
            // Degraded-skip: dep image has no HEALTHCHECK. Proceed (ordering-
            // only) and surface the skip as an event. No secret in payload.
            events.push({
              op: "service.wait_skipped",
              after: { reason: "no_healthcheck", dep },
            });
          } else if (outcome.outcome === "timeout") {
            // ABORT BY RETURN (fail-safe, ground rule #3): do NOT create the
            // dependent, do NOT delete/stop anything. Surface the timeout as an
            // event; the reconciler reconverges next cycle (no backoff).
            events.push({
              op: "service.dep_health_timeout",
              after: {
                dep: outcome.dep,
                status: outcome.status,
                waited_ms: outcome.waited_ms,
              },
            });
            return {
              entity: action.entity,
              op: action.op,
              changed: false,
              events,
            };
          }
          // healthy → proceed.
        }
      }

      // Bug 4: pull the image before creating any replica (only when we will
      // create — a converged re-apply skips it, keeping the no-op cheap).
      if (needsCreate) {
        await ensureImage(svc.image, action.entity, action.applyContext);
      }

      // 3.3: resolve secret-bound env behind the applyContext gate. This is
      // the ONLY place resolution happens; it is reached ONLY in this real
      // apply branch (never plan/dry_run/observe/verify). Empty unless BOTH
      // resolver + token were injected at the apply boundary.
      const resolvedSecrets = await resolveSecretEnv(svc, action.applyContext);

      let changed = false;
      for (let i = 0; i < svc.replicas; i++) {
        const existing = have.get(i);

        if (!existing) {
          // IDEMPOTENCY: observe-before-create per replica. A 409 dup-name
          // race is treated as already-existing (converged), not an error.
          const name = replicaName(svc.name, i);
          const res = await tx.request(
            "POST",
            `/containers/create?name=${encodeURIComponent(name)}`,
            await createBody(svc, i, resolvedSecrets),
          );
          if (res.status === 409) {
            // Raced: container now exists. Re-list to start it below.
          } else if (res.status < 200 || res.status >= 400) {
            const m =
              res.json &&
              typeof res.json === "object" &&
              "message" in res.json
                ? String((res.json as { message: unknown }).message)
                : `create ${name} failed`;
            throw new ReconcileError(
              classify({ httpStatus: res.status }),
              `${m} (status ${res.status})`,
              { entity: action.entity },
            );
          } else {
            changed = true;
          }
        }
      }

      // Re-resolve replicas (covers fresh creates + 409 races) and ensure
      // every one is started. start is idempotent at the Engine (304 if
      // already running) — only a real exited→running transition counts.
      const after = await replicasOf(svc.name);
      for (let i = 0; i < svc.replicas; i++) {
        const c = after.get(i);
        if (!c) continue;
        const res = await call(
          "POST",
          `/containers/${c.Id}/start`,
          undefined,
          action.entity,
        );
        if (res.status === 204) changed = true; // 304 = already running (no-op)
      }

      return {
        entity: action.entity,
        op: action.op,
        changed,
        ...(events.length > 0 ? { events } : {}),
      };
    },

    /**
     * APPROVED-DESTROY ONLY (fail-safe §"Approval Gate gates destruction").
     * The reconcile path never reaches here — `apply(op:"destroy")` above is a
     * no-op and orphans are drift-only. This removes the explicitly-requested,
     * gate-approved service's replica containers (Engine DELETE …?force=true).
     * Idempotent: a replica already gone (404) is a no-op; `changed` is true
     * iff something was actually removed.
     */
    async destroy(action: PlanAction): Promise<ApplyResult> {
      assertScope(action.entity);
      const idx = action.entity.indexOf(":");
      const service = idx >= 0 ? action.entity.slice(idx + 1) : action.entity;
      const have = await replicasOf(service);
      let changed = false;
      for (const c of have.values()) {
        const res = await tx.request("DELETE", `/containers/${c.Id}?force=true`);
        if (res.status === 204) {
          changed = true;
        } else if (res.status === 404) {
          // Already gone — idempotent no-op.
        } else if (res.status < 200 || res.status >= 400) {
          throw new ReconcileError(
            classify({ httpStatus: res.status }),
            `Engine API DELETE /containers/${c.Id} failed (status ${res.status})`,
            { entity: action.entity },
          );
        }
      }
      return { entity: action.entity, op: action.op, changed };
    },
  };
}
