/**
 * core/src/providers/v2/hetzner-load-balancer.ts
 *
 * Task F4.3 — HetznerLoadBalancerProvider. The v2 provider for Hetzner Cloud
 * Load Balancers. Drives create / in-place mutations (algorithm, targets,
 * health-check) via the v2 HTTP adapter (`hetzner-cloud-v2-http.ts`) and
 * detects the location-change destructive case for the F4.4 tool layer.
 *
 * Design principles (spec-mãe + spec-filha Bloco A; F4.3 brief):
 *
 *   - IDEMPOTENCY. apply(desired, observed) converges then is a NO-OP on a
 *     second call. Algorithm / target-set / health-check equality drives the
 *     no-op decision.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. Out-of-band targets surface as `drift`
 *     in plan (read-only channel). F4.3 simplification: managed = all observed
 *     (see SIMPLIFICATIONS below). Apply DOES re-converge by removing
 *     unmanaged extras AND adding missing servers, but drift surfaces first so
 *     the agent sees the picture pre-apply. F5 IngressProvider may refine the
 *     "managed" notion (e.g. tag-based bookkeeping) without breaking this
 *     provider's interface.
 *
 *   - LOCATION IS IMMUTABLE. Hetzner's LB location is fixed at create. A
 *     location change is DESTRUCTIVE: it forces destroy+recreate AND changes
 *     the public IP. F4.3 surfaces this as a single `recreate` plan op with
 *     impact note `"public IP will change"`; apply REFUSES with
 *     `precondition`. The F4.4 tool gates the actual destroy+create flow via
 *     explicit Approval.
 *
 *   - NO FIREWALL HANDLING. Hetzner does not accept a direct firewall
 *     attachment on a Load Balancer (firewall_ref on an Ingress targets
 *     BACKEND Servers, not the LB itself). F5 IngressProvider composes the
 *     two; this provider has ZERO firewall imports/calls.
 *
 *   - SELECTOR RESOLUTION IS A SEAM. Provider takes both `serversProvider`
 *     and `servicesProvider` callback deps (the reconciler wires them with
 *     frozen-per-cycle snapshots, spec-mãe §2.2 freeze invariant). Tests pass
 *     fixture arrays.
 *
 *   - service_selector → server_selector CHAIN. The LB's `targets` is a
 *     SELECTOR over Services (not Servers): provider walks matched Services →
 *     each Service's `server_selector` → union of matched Servers. Final
 *     ordered target set = union, sorted by hcloud_id.
 *
 *   - ERROR MAPPING. Reuses the shared `rewrapHetznerError` from
 *     `./error-rewrap.ts` (hoisted in F3.3): 422 from Hetzner is
 *     caller-correctable input → re-wrapped to `precondition`.
 *
 * SIMPLIFICATIONS (F4.3 scope; F5 may refine):
 *
 *   - SINGLE SERVICE per LB. F4.3 manages exactly one LB-service derived from
 *     `desired.health_check`: protocol `https`, listen_port `443`,
 *     destination_port `80`. This is sufficient for the canonical "TLS-front
 *     LB → backend Servers on port 80" topology that spec-filha Bloco A
 *     uses. F5 IngressProvider may need per-route services; the
 *     update-service path here keys off `listen_port === 443` and the same
 *     factory can be extended without breaking the public port.
 *
 *   - "MANAGED = ALL OBSERVED" for the target set. F4.3 does not maintain a
 *     separate "this provider added it" bookkeeping; observed targets that
 *     are NOT in the desired union are treated as in-scope for remove during
 *     apply (because we cannot tell out-of-band-add from prior-apply-add
 *     without a label-set tag, which the LB API does not surface per
 *     target). Drift IS surfaced in plan so the agent observes the
 *     out-of-band activity before reconciliation. F5 may refine by tagging
 *     target adds (e.g. via Hetzner labels on the corresponding backend
 *     server) so drift becomes truly read-only.
 *
 * Exported API:
 *   createHetznerLoadBalancerProvider(opts) → LoadBalancerProvider
 *   interface LoadBalancerProvider
 *   interface LoadBalancerProviderOptions
 *   interface ObservedLoadBalancer
 */

import { ReconcileError } from "../../domain/errors.js";
import type { LoadBalancer } from "../../domain/entities-v2.js";
import type { Server, Service } from "../../domain/entities.js";
import { resolveServerSelector } from "../../agent/v2/resolve-selector.js";
import type { SelectorInput } from "../../agent/v2/resolve-selector.js";
import { rewrapHetznerError } from "./error-rewrap.js";
import type {
  HetznerV2HttpClient,
  V2LoadBalancerResourceClient,
} from "./hetzner-cloud-v2-http.js";

// ---------------------------------------------------------------------------
// Observed-state shape
// ---------------------------------------------------------------------------

export interface HetznerLbHealthCheck {
  readonly protocol: string;
  readonly port: number;
  readonly interval: number;
  readonly timeout: number;
  readonly retries: number;
  readonly http?: { readonly path?: string };
}

export interface HetznerLbService {
  readonly protocol: string;
  readonly listen_port: number;
  readonly destination_port: number;
  readonly health_check: HetznerLbHealthCheck;
}

export interface HetznerLbTarget {
  readonly type: string;
  readonly server?: { readonly id: number };
  readonly label_selector?: { readonly selector: string };
  readonly ip?: { readonly ip: string };
}

/** Raw Hetzner load_balancer as returned by GET /load_balancers/:id. */
export interface HetznerLoadBalancerShape {
  readonly id: number;
  readonly name: string;
  readonly load_balancer_type: { readonly name: string };
  readonly location: { readonly name: string };
  readonly algorithm: { readonly type: string };
  readonly services: readonly HetznerLbService[];
  readonly targets: readonly HetznerLbTarget[];
  readonly labels: Record<string, string>;
  readonly public_net: {
    readonly enabled: boolean;
    readonly ipv4: { readonly ip: string };
    readonly ipv6: { readonly ip: string };
  };
  readonly created: string;
}

/** Persisted under `load_balancers.observed` (jsonb). Thin wrapper. */
export interface ObservedLoadBalancer {
  readonly hetzner: HetznerLoadBalancerShape;
}

// ---------------------------------------------------------------------------
// Plan envelope
// ---------------------------------------------------------------------------

export type LoadBalancerPlanOp =
  | { readonly op: "create"; readonly entity: string }
  | {
      readonly op: "recreate";
      readonly entity: string;
      readonly impact: string;
    }
  | { readonly op: "update_algorithm"; readonly entity: string }
  | { readonly op: "update_targets"; readonly entity: string }
  | { readonly op: "update_health_check"; readonly entity: string }
  | {
      readonly op: "drift";
      readonly entity: string;
      readonly target: "targets";
    };

export interface LoadBalancerPlan {
  readonly ops: readonly LoadBalancerPlanOp[];
}

export interface ApplyResult {
  readonly entity: string;
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Provider port (v2 shape)
// ---------------------------------------------------------------------------

export interface LoadBalancerProvider {
  readonly name: string;
  observe(name: string): Promise<ObservedLoadBalancer | null>;
  plan(
    desired: LoadBalancer,
    observed: ObservedLoadBalancer | null,
  ): Promise<LoadBalancerPlan>;
  apply(
    desired: LoadBalancer,
    observed: ObservedLoadBalancer | null,
  ): Promise<ApplyResult>;
  verify(desired: LoadBalancer): Promise<boolean>;
}

export interface LoadBalancerProviderOptions {
  readonly http: HetznerV2HttpClient;
  /** Frozen-for-this-cycle Server snapshot (spec-mãe §2.2 freeze invariant). */
  readonly serversProvider: () => Promise<readonly Server[]>;
  /** Frozen-for-this-cycle Service snapshot (same freeze invariant). */
  readonly servicesProvider: () => Promise<readonly Service[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * F4.3 simplification — listen/destination ports for the single LB-service.
 * See SIMPLIFICATIONS in the module header. F5 IngressProvider may extend.
 */
const LB_LISTEN_PORT = 443;
const LB_DESTINATION_PORT = 80;
const LB_SERVICE_PROTOCOL = "https";
const DEFAULT_LB_TYPE = "lb11";

export function createHetznerLoadBalancerProvider(
  opts: LoadBalancerProviderOptions,
): LoadBalancerProvider {
  const lbs: V2LoadBalancerResourceClient = opts.http.loadBalancers;

  return {
    name: "hetzner-load-balancer",

    async observe(name: string): Promise<ObservedLoadBalancer | null> {
      try {
        const res = await lbs.list();
        const body = (await res.json()) as {
          load_balancers?: HetznerLoadBalancerShape[];
        };
        const found = (body.load_balancers ?? []).find((l) => l.name === name);
        if (!found) return null;
        return { hetzner: found };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async plan(
      desired: LoadBalancer,
      observed: ObservedLoadBalancer | null,
    ): Promise<LoadBalancerPlan> {
      const entity = `load_balancer:${desired.name}`;
      if (observed === null) {
        return { ops: [{ op: "create", entity }] };
      }

      // Location change is DESTRUCTIVE — single `recreate` op supersedes all
      // others. The F4.4 tool drives the destroy+create flow via Approval.
      if (observed.hetzner.location.name !== desired.location) {
        return {
          ops: [
            {
              op: "recreate",
              entity,
              impact: "public IP will change",
            },
          ],
        };
      }

      const ops: LoadBalancerPlanOp[] = [];

      // Algorithm diff — in-place mutation via actions/change_algorithm.
      if (observed.hetzner.algorithm.type !== desired.algorithm) {
        ops.push({ op: "update_algorithm", entity });
      }

      // Health-check diff — in-place via actions/update_service (the single
      // LB-service; F4.3 simplification). Only emit when actually different.
      const observedSvc = findLbService(observed.hetzner);
      if (!observedSvc || !sameHealthCheck(observedSvc.health_check, desired.health_check)) {
        ops.push({ op: "update_health_check", entity });
      }

      // Target set diff — resolved via service_selector → server_selector chain.
      const desiredIds = await resolveDesiredTargetIds(
        desired.targets as SelectorInput,
        opts,
      );
      const observedIds = observedServerTargetIds(observed.hetzner);
      const desiredSet = new Set(desiredIds);
      const observedSet = new Set(observedIds);
      const needsAdd = desiredIds.some((id) => !observedSet.has(id));
      const needsRemove = observedIds.some((id) => !desiredSet.has(id));
      if (needsAdd || needsRemove) {
        ops.push({ op: "update_targets", entity });
        // Out-of-band addition surfaces as drift (read-only channel) — fail-
        // safe so the agent sees the picture pre-apply. F4.3 simplification:
        // managed = all observed (see module header).
        if (needsRemove) {
          ops.push({ op: "drift", entity, target: "targets" });
        }
      }

      return { ops };
    },

    async apply(
      desired: LoadBalancer,
      observed: ObservedLoadBalancer | null,
    ): Promise<ApplyResult> {
      const entity = `load_balancer:${desired.name}`;

      try {
        // Branch 1: create when absent. Bundle algorithm/service/targets in
        // the create payload to save round-trips.
        if (observed === null) {
          const desiredIds = await resolveDesiredTargetIds(
            desired.targets as SelectorInput,
            opts,
          );
          const body: Record<string, unknown> = {
            name: desired.name,
            load_balancer_type: DEFAULT_LB_TYPE,
            location: desired.location,
            algorithm: { type: desired.algorithm },
            services: [
              {
                protocol: LB_SERVICE_PROTOCOL,
                listen_port: LB_LISTEN_PORT,
                destination_port: LB_DESTINATION_PORT,
                health_check: serializeHealthCheck(desired.health_check),
              },
            ],
            targets: desiredIds.map((id) => ({
              type: "server",
              server: { id },
            })),
          };
          await drain(await lbs.create(body));
          return { entity, changed: true };
        }

        // Location change refused — destroy+create flow lives in the F4.4 tool
        // (Approval-gated). Apply NEVER auto-recreates a billed resource.
        if (observed.hetzner.location.name !== desired.location) {
          throw new ReconcileError(
            "precondition",
            `${entity} location immutable (observed=${observed.hetzner.location.name}, desired=${desired.location}); recreation required — use the set_load_balancer tool (F4.4) for the approved destroy+create flow (public IP will change)`,
            { entity },
          );
        }

        let changed = false;
        const id = observed.hetzner.id;

        // Algorithm converge.
        if (observed.hetzner.algorithm.type !== desired.algorithm) {
          await drain(
            await lbs.changeAlgorithm(id, { type: desired.algorithm }),
          );
          changed = true;
        }

        // Health-check converge (single-service simplification — see header).
        const observedSvc = findLbService(observed.hetzner);
        if (
          !observedSvc ||
          !sameHealthCheck(observedSvc.health_check, desired.health_check)
        ) {
          await drain(
            await lbs.updateService(id, {
              listen_port: LB_LISTEN_PORT,
              protocol: LB_SERVICE_PROTOCOL,
              destination_port: LB_DESTINATION_PORT,
              health_check: serializeHealthCheck(desired.health_check),
            }),
          );
          changed = true;
        }

        // Targets converge — add missing, remove extras (F4.3: managed = all
        // observed; see module header).
        const desiredIds = await resolveDesiredTargetIds(
          desired.targets as SelectorInput,
          opts,
        );
        const observedIds = observedServerTargetIds(observed.hetzner);
        const desiredSet = new Set(desiredIds);
        const observedSet = new Set(observedIds);
        const toAdd = desiredIds.filter((x) => !observedSet.has(x));
        const toRemove = observedIds.filter((x) => !desiredSet.has(x));

        for (const targetId of toAdd) {
          await drain(
            await lbs.addTarget(id, {
              type: "server",
              server: { id: targetId },
            }),
          );
          changed = true;
        }
        for (const targetId of toRemove) {
          await drain(
            await lbs.removeTarget(id, {
              type: "server",
              server: { id: targetId },
            }),
          );
          changed = true;
        }

        return { entity, changed };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async verify(desired: LoadBalancer): Promise<boolean> {
      const observed = await this.observe(desired.name);
      if (observed === null) return false;
      const plan = await this.plan(desired, observed);
      // verify is TRUE iff no convergent op is pending. `drift` ops reflect
      // out-of-band state — we deliberately do NOT silently re-correct them
      // (per spec invariant: drift reported, not silently fixed), but for
      // F4.3's "managed = all observed" simplification we DO converge them on
      // apply, so they ARE a pending convergent op. Hence drift counts as
      // divergence here. Returning true only when the plan is fully empty.
      return plan.ops.length === 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — selector resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the LB's `service_selector` over the per-cycle Service snapshot,
 * then UNION the matched Services' `server_selector` resolutions against the
 * per-cycle Server snapshot, returning hcloud_ids sorted ascending. Pure
 * function over the injected providers.
 *
 * The selector grammar matches `resolveServerSelector` but operates on the
 * only label-like map a v1 Service exposes: its own `server_selector` keys.
 * `{ name: X }` matches Service.name exactly; `{ label: K }` requires that
 * `Service.server_selector` carries the key `K`. This convention is
 * documented in the module header.
 */
async function resolveDesiredTargetIds(
  selector: SelectorInput,
  opts: LoadBalancerProviderOptions,
): Promise<number[]> {
  const [services, servers] = await Promise.all([
    opts.servicesProvider(),
    opts.serversProvider(),
  ]);
  const matchedServices = resolveServiceSelector(selector, services);
  const idSet = new Set<number>();
  for (const svc of matchedServices) {
    if (!svc.server_selector) continue;
    const serverNames = resolveServerSelector(
      svc.server_selector as SelectorInput,
      servers,
    );
    for (const name of serverNames) {
      const id = hcloudIdOf(name, servers);
      if (id !== null) idSet.add(id);
    }
  }
  return [...idSet].sort((a, b) => a - b);
}

function resolveServiceSelector(
  selector: SelectorInput | null | undefined,
  services: readonly Service[],
): Service[] {
  if (selector === null || selector === undefined || typeof selector !== "object") {
    return [];
  }
  const sel = selector as Record<string, unknown>;
  const keys = Object.keys(sel);
  if (keys.length === 0) return [];
  const matched: Service[] = [];
  for (const s of services) {
    if (matchesAllService(sel, keys, s)) matched.push(s);
  }
  matched.sort((a, b) => a.name.localeCompare(b.name));
  return matched;
}

function matchesAllService(
  sel: Record<string, unknown>,
  keys: readonly string[],
  s: Service,
): boolean {
  for (const k of keys) {
    if (!matchesClauseService(k, sel[k], s)) return false;
  }
  return true;
}

function matchesClauseService(
  key: string,
  value: unknown,
  s: Service,
): boolean {
  if (key === "name") {
    return typeof value === "string" && s.name === value;
  }
  if (key === "label") {
    if (typeof value !== "string") return false;
    return Object.prototype.hasOwnProperty.call(
      s.server_selector ?? {},
      value,
    );
  }
  return Object.prototype.hasOwnProperty.call(s.server_selector ?? {}, key);
}

function hcloudIdOf(name: string, servers: readonly Server[]): number | null {
  const s = servers.find((x) => x.name === name);
  return s && typeof s.hcloud_id === "number" ? s.hcloud_id : null;
}

// ---------------------------------------------------------------------------
// Internals — observed shape helpers
// ---------------------------------------------------------------------------

function findLbService(
  h: HetznerLoadBalancerShape,
): HetznerLbService | undefined {
  // F4.3: single-service simplification — match by canonical listen port.
  return h.services.find((s) => s.listen_port === LB_LISTEN_PORT);
}

function observedServerTargetIds(
  h: HetznerLoadBalancerShape,
): number[] {
  return h.targets
    .filter((t) => t.type === "server" && t.server)
    .map((t) => t.server!.id)
    .sort((a, b) => a - b);
}

function sameHealthCheck(
  observed: HetznerLbHealthCheck,
  desired: LoadBalancer["health_check"],
): boolean {
  if (observed.protocol !== desired.protocol) return false;
  if (observed.port !== desired.port) return false;
  if (observed.interval !== desired.interval) return false;
  if (observed.timeout !== desired.timeout) return false;
  if (observed.retries !== desired.retries) return false;
  if (desired.protocol === "http" || desired.protocol === "https") {
    const observedPath = observed.http?.path;
    if (observedPath !== desired.path) return false;
  }
  return true;
}

function serializeHealthCheck(
  hc: LoadBalancer["health_check"],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    protocol: hc.protocol,
    port: hc.port,
    interval: hc.interval,
    timeout: hc.timeout,
    retries: hc.retries,
  };
  if (hc.protocol === "http" || hc.protocol === "https") {
    body.http = { path: hc.path };
  }
  return body;
}

/** Drain a 2xx response body so the socket is freed (mirrors v1 pattern). */
async function drain(res: Response): Promise<void> {
  await res.json().catch(() => undefined);
}

// Type re-export so consumers don't pull from the adapter directly.
export type { V2LoadBalancerResourceClient };
