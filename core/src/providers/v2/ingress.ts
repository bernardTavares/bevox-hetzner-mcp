/**
 * core/src/providers/v2/ingress.ts
 *
 * Task F5.2 — IngressProvider composite. Unlike F1.3 / F3.3 / F4.3 (which talk
 * to Hetzner directly via the v2 HTTP adapter), this provider ORCHESTRATES
 * other providers — it owns NO HTTP/wire surface itself. It composes:
 *
 *   - HetznerCertificateProvider  (F3.3 / F3.4)
 *   - HetznerLoadBalancerProvider (F4.3)
 *   - HetznerFirewallProvider     (F1.3)
 *   - HetznerDNSProvider          (v1, `core/src/providers/hetzner-dns.ts`)
 *
 * Design principles (spec-mãe + spec-filha Bloco A; F5.2 brief):
 *
 *   - APPLY DAG ORDER. Certificate kickoff → LoadBalancer → (Firewall if a
 *     `firewall_ref` is present) → DNS. The certificate's `apply()` is invoked
 *     first to KICK OFF issuance, but a managed cert in `pending` does NOT
 *     block the LB / firewall / DNS — the LB can serve before the cert is
 *     fully issued (the cert id is attached at the LB-service level, which is
 *     a F5.3 concern). The composite reports `degraded` while the cert is
 *     still pending. DECISION: serial cert-then-LB; we do not parallelise
 *     even uploaded certs (the brief allows it, but the determinism win for
 *     test/diagnosis outweighs the negligible time saved over an in-process
 *     adapter call).
 *
 *   - FIREWALL ON BACKEND SERVERS. Hetzner Cloud LBs cannot carry a Firewall
 *     directly; spec-filha §3 Bloco A delegates the `firewall_ref` to the
 *     SERVERS backing the LB. The IngressProvider intercepts the looked-up
 *     desired Firewall and OVERRIDES its `applied_to` selector to `{ in:
 *     [<backend-server-names>] }`, derived from the LB's resolved targets
 *     (cross-referenced against the per-cycle Server snapshot). This keeps
 *     the FirewallProvider itself oblivious to "I'm an LB-backend firewall"
 *     semantics — it just applies a Firewall whose `applied_to` happens to
 *     be a literal name list.
 *
 *   - DNS POINTS AT THE LB. A/AAAA records are emitted for the Ingress's
 *     `hostname` pointing at the LB's `public_net.ipv4.ip` /
 *     `public_net.ipv6.ip` respectively. Zone is the part of `hostname` past
 *     the first dot (Bloco-A simplification — explicit per-Ingress zone
 *     selection is deferred to Bloco C). The v1 DnsRecord is wrapped in a
 *     PlanAction({ op:"upsert", entity:"dns:<name>.<zone>" }) for the v1
 *     `Provider` port; the v1 DNS provider's idempotency invariants then
 *     guarantee the no-op on re-apply.
 *
 *   - FAIL-SAFE, PARTIAL FAILURE. A single sub-provider's apply throwing does
 *     NOT abort siblings whose inputs are still available — e.g. if firewall
 *     apply errors AFTER the LB succeeded, DNS still gets a chance (the LB
 *     ip is known). Aborting steps are recorded in the composite outcome's
 *     `worst_component_reason`; the composite `status` flips to `degraded`
 *     and the reconciler retries on the next cycle (the spec's idempotency
 *     invariant means the second pass is a no-op on the steps that
 *     succeeded).
 *
 *   - STATUS AGGREGATION. The composite is `healthy` iff every sub-component
 *     is `healthy`. Otherwise `degraded`, with `worst_component_reason` set
 *     to the FIRST failing component in DAG order (cert / load_balancer /
 *     firewall / dns) — first-fail wins because it is most likely the root
 *     cause (cert pending → LB still ok → composite degraded → reason=cert).
 *
 *   - LOOKUP DEPS. The IngressProvider does NOT itself read the desired
 *     state store; instead the caller wires in `certificateLookup`,
 *     `firewallLookup`, `loadBalancerLookup` callbacks that return the
 *     resolved entities (or null if dangling). Dangling refs are a
 *     `precondition` failure (parser-level cross-entity checks are deferred
 *     to the PolicyEngine in Bloco C; here we fail-safe at apply time).
 *
 *   - IDEMPOTENCY. apply(desired, observed) is changed:false on a second
 *     call when every sub-provider's apply is a no-op (each sub provider
 *     enforces its own idempotency contract). The composite does no extra
 *     bookkeeping — it AND-reduces the sub-results.
 *
 *   - NO APPROVAL LOGIC. Destructive intents (e.g. remove an Ingress) are
 *     gated by the F5.3 tool, not here. This provider observes / creates /
 *     converges only.
 *
 * Exported API:
 *   createIngressProvider(opts) → IngressProvider
 *   interface IngressProvider
 *   interface IngressProviderOptions
 *   interface ObservedIngress
 */

import { ReconcileError } from "../../domain/errors.js";
import type { DnsRecord } from "../../domain/entities.js";
import type {
  Certificate,
  Firewall,
  Ingress,
  LoadBalancer,
} from "../../domain/entities-v2.js";
import type { Server, Service } from "../../domain/entities.js";
import type {
  CertificateProvider,
  ObservedCertificate,
} from "./hetzner-certificate.js";
import type {
  FirewallProvider,
  ObservedFirewall,
} from "./hetzner-firewall.js";
import type {
  LoadBalancerProvider,
  ObservedLoadBalancer,
} from "./hetzner-load-balancer.js";
import type { Provider as DnsProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Composite observed state
// ---------------------------------------------------------------------------

/**
 * The composite observed state for an Ingress. Each sub-observed slice is
 * stored verbatim (so cross-cycle re-observation can compare without
 * re-resolving lookups). `status` is the aggregated lifecycle (see module
 * header). The reconciler persists this under the (future) `ingresses.observed`
 * jsonb column.
 */
export interface ObservedIngress {
  readonly certificate: ObservedCertificate | null;
  readonly load_balancer: ObservedLoadBalancer | null;
  readonly firewall: ObservedFirewall | null;
  readonly status?: "healthy" | "degraded";
  readonly worst_component_reason?: ComponentKind;
}

export type ComponentKind =
  | "certificate"
  | "load_balancer"
  | "firewall"
  | "dns";

// ---------------------------------------------------------------------------
// Apply result envelope
// ---------------------------------------------------------------------------

export interface ApplyResult {
  readonly entity: string;
  readonly changed: boolean;
  readonly status: "healthy" | "degraded";
  /** First sub-component (in DAG order) that did NOT come out healthy. */
  readonly worst_component_reason?: ComponentKind;
}

// ---------------------------------------------------------------------------
// Composite plan envelope (F5.3)
// ---------------------------------------------------------------------------

/**
 * Composite plan op surfaced to the F5.3 `set_ingress` tool. Each op carries
 * the originating sub-component `kind` (so the tool can tell DNS-impacting
 * changes apart from in-place LB/firewall/cert tweaks) and the underlying
 * sub-provider op (`create`/`update`/`recreate`/...). `impact` mirrors the v2
 * agent-facing impact note (e.g. the LB recreate's `public IP will change`).
 */
export type IngressPlanOp = {
  readonly kind: ComponentKind;
  readonly op: string;
  readonly entity: string;
  readonly impact?: string;
};

export interface IngressPlan {
  readonly ops: readonly IngressPlanOp[];
}

// ---------------------------------------------------------------------------
// Provider port (v2 composite shape)
// ---------------------------------------------------------------------------

export interface IngressProvider {
  readonly name: string;
  observe(desired: Ingress): Promise<ObservedIngress | null>;
  /**
   * Pure plan — AND-reduce of sub-provider plans (cert + lb + fw) plus a
   * synthetic `dns:upsert` op when the LB hasn't been observed yet OR the
   * Ingress's hostname differs from the existing DNS-record target the
   * reconciler will write. F5.3 consumers (the `set_ingress` tool) use this
   * envelope verbatim. No I/O beyond what the sub-providers' own plan()s do.
   */
  plan(
    desired: Ingress,
    observed: ObservedIngress | null,
  ): Promise<IngressPlan>;
  apply(
    desired: Ingress,
    observed: ObservedIngress | null,
  ): Promise<ApplyResult>;
  /** AND-reduce of sub-provider verifies. Skips firewall if no `firewall_ref`. */
  verify(desired: Ingress): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Lookups + options
// ---------------------------------------------------------------------------

export type CertificateLookup = (
  name: string,
) => Promise<Certificate | null>;
export type FirewallLookup = (name: string) => Promise<Firewall | null>;
export type LoadBalancerLookup = (
  name: string,
) => Promise<LoadBalancer | null>;

export interface IngressProviderOptions {
  readonly certificateProvider: CertificateProvider;
  readonly loadBalancerProvider: LoadBalancerProvider;
  readonly firewallProvider: FirewallProvider;
  readonly dnsProvider: DnsProvider;
  /** Frozen-for-this-cycle Server snapshot (spec-mãe §2.2 freeze invariant). */
  readonly serversProvider: () => Promise<readonly Server[]>;
  /** Frozen-for-this-cycle Service snapshot (same freeze invariant). */
  readonly servicesProvider: () => Promise<readonly Service[]>;
  readonly certificateLookup: CertificateLookup;
  readonly firewallLookup: FirewallLookup;
  readonly loadBalancerLookup: LoadBalancerLookup;
  /** DNS TTL for emitted A/AAAA records. Defaults to 300s. */
  readonly dnsTtlSeconds?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DNS_TTL = 300;

export function createIngressProvider(
  opts: IngressProviderOptions,
): IngressProvider {
  const ttl = opts.dnsTtlSeconds ?? DEFAULT_DNS_TTL;

  /**
   * Look up + validate the three sub-desireds. Dangling refs are a
   * `precondition` failure raised BEFORE any sub-apply — fail-safe: a
   * misconfigured manifest never partially mutates Hetzner.
   */
  async function resolveRefs(
    desired: Ingress,
  ): Promise<{
    cert: Certificate;
    lb: LoadBalancer;
    fw: Firewall | null;
  }> {
    const entity = `ingress:${desired.name}`;
    const cert = await opts.certificateLookup(desired.tls.certificate_ref);
    if (!cert) {
      throw new ReconcileError(
        "precondition",
        `${entity} references certificate "${desired.tls.certificate_ref}" which does not exist`,
        { entity },
      );
    }
    const lb = await opts.loadBalancerLookup(desired.load_balancer_ref);
    if (!lb) {
      throw new ReconcileError(
        "precondition",
        `${entity} references load_balancer "${desired.load_balancer_ref}" which does not exist`,
        { entity },
      );
    }
    let fw: Firewall | null = null;
    if (desired.firewall_ref) {
      const looked = await opts.firewallLookup(desired.firewall_ref);
      if (!looked) {
        throw new ReconcileError(
          "precondition",
          `${entity} references firewall "${desired.firewall_ref}" which does not exist`,
          { entity },
        );
      }
      fw = looked;
    }
    return { cert, lb, fw };
  }

  return {
    name: "ingress",

    async observe(desired: Ingress): Promise<ObservedIngress | null> {
      // Resolve refs FIRST so we can probe each sub-provider with the actual
      // sub-component name (e.g. the Certificate is `web-cert`, not the
      // Ingress name `web`). A dangling ref yields null for that sub-observed
      // (the apply path will then surface the precondition); observe itself
      // never throws on missing lookups.
      const certRef = desired.tls.certificate_ref;
      const lbRef = desired.load_balancer_ref;
      const fwRef = desired.firewall_ref;
      const [certEntity, lbEntity, fwEntity] = await Promise.all([
        opts.certificateLookup(certRef).catch(() => null),
        opts.loadBalancerLookup(lbRef).catch(() => null),
        fwRef
          ? opts.firewallLookup(fwRef).catch(() => null)
          : Promise.resolve(null),
      ]);
      const [cert, lb, fw] = await Promise.all([
        certEntity
          ? opts.certificateProvider.observe(certEntity.name).catch(() => null)
          : Promise.resolve(null),
        lbEntity
          ? opts.loadBalancerProvider.observe(lbEntity.name).catch(() => null)
          : Promise.resolve(null),
        fwEntity
          ? opts.firewallProvider.observe(fwEntity.name).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (cert === null && lb === null && fw === null) return null;
      return { certificate: cert, load_balancer: lb, firewall: fw };
    },

    async plan(
      desired: Ingress,
      observed: ObservedIngress | null,
    ): Promise<IngressPlan> {
      // Plan must be safe to call before apply; we resolve refs FIRST and
      // surface dangling-ref failures as ReconcileError (matches apply()
      // contract — fail-safe). The caller (set_ingress tool) maps these to
      // a `precondition` error envelope.
      const refs = await resolveRefs(desired);
      const entity = `ingress:${desired.name}`;
      const ops: IngressPlanOp[] = [];
      // Cert sub-plan: forwarded with `kind:"certificate"`.
      const certPlan = await opts.certificateProvider.plan(
        refs.cert,
        observed?.certificate ?? null,
      );
      for (const o of certPlan.ops) {
        ops.push({
          kind: "certificate",
          op: o.op,
          entity: (o as { entity?: string }).entity ?? `certificate:${refs.cert.name}`,
          ...((o as { reason?: string }).reason
            ? { impact: (o as { reason: string }).reason }
            : {}),
        });
      }
      // LB sub-plan: forwarded with `kind:"load_balancer"`. The provider's
      // `recreate` carries impact:"public IP will change" — propagated as-is.
      const lbPlan = await opts.loadBalancerProvider.plan(
        refs.lb,
        observed?.load_balancer ?? null,
      );
      for (const o of lbPlan.ops) {
        ops.push({
          kind: "load_balancer",
          op: o.op,
          entity: (o as { entity?: string }).entity ?? `load_balancer:${refs.lb.name}`,
          ...((o as { impact?: string }).impact
            ? { impact: (o as { impact: string }).impact }
            : {}),
        });
      }
      // Firewall sub-plan: built against the OVERRIDDEN `applied_to` so the
      // diff is on the same set the apply path would push.
      if (refs.fw) {
        const lbObs = observed?.load_balancer ?? null;
        const servers = await opts.serversProvider();
        const backendNames = lbObs ? backendServerNames(lbObs, servers) : [];
        const overridden: Firewall = {
          ...refs.fw,
          applied_to: { in: backendNames },
        };
        const fwPlan = await opts.firewallProvider.plan(
          overridden,
          observed?.firewall ?? null,
        );
        for (const o of fwPlan.ops) {
          ops.push({
            kind: "firewall",
            op: o.op,
            entity: (o as { entity?: string }).entity ?? `firewall:${refs.fw.name}`,
          });
        }
      }
      // DNS synthetic op: when there is no observed LB (fresh ingress) OR
      // the LB is being recreated (public IP will change), DNS must be
      // upserted. We do NOT inspect the v1 DnsProvider's observed state here
      // — the v1 provider is action-driven (no plan()); the reconciler's
      // idempotency invariant guarantees a no-op when the record is already
      // present. We surface a single synthetic op so the tool sees the DNS
      // intent (and a hostname-change classification is downstream of `op`).
      const lbObs = observed?.load_balancer ?? null;
      const needsDns =
        lbObs === null || lbPlan.ops.some((o) => o.op === "recreate");
      if (needsDns) {
        ops.push({
          kind: "dns",
          op: "upsert",
          entity: `dns:${desired.hostname}`,
        });
      }
      // Discriminator for the tool's destructiveness classifier: if the LB is
      // being recreated, the public IP and therefore the DNS A/AAAA target
      // changes — this is the destructive class the tool gates on. Composite
      // entity carried for downstream logging.
      void entity;
      return { ops };
    },

    async apply(
      desired: Ingress,
      observed: ObservedIngress | null,
    ): Promise<ApplyResult> {
      const entity = `ingress:${desired.name}`;
      const refs = await resolveRefs(desired);

      const failures: ComponentKind[] = [];
      const componentHealthy: Record<ComponentKind, boolean> = {
        certificate: true,
        load_balancer: true,
        firewall: true,
        dns: true,
      };
      let anyChanged = false;

      // --- 1) Certificate (kickoff; pending does NOT block) -----------
      try {
        const certRes = await opts.certificateProvider.apply(
          refs.cert,
          observed?.certificate ?? null,
        );
        if (certRes.changed) anyChanged = true;
        // For managed certs, `action_status` may be pending / error /
        // cancelled — only `completed` counts as healthy. Uploaded certs
        // have no action_status (treated as healthy on a successful apply).
        if (
          certRes.action_status !== undefined &&
          certRes.action_status !== "completed"
        ) {
          componentHealthy.certificate = false;
          failures.push("certificate");
        }
      } catch {
        componentHealthy.certificate = false;
        failures.push("certificate");
      }

      // --- 2) LoadBalancer --------------------------------------------
      // We capture the freshest observed LB after apply so the firewall step
      // can derive backend server ids from it. If apply throws, fall back to
      // the prior observed; if that's also null, the firewall step skips.
      let lbObserved: ObservedLoadBalancer | null =
        observed?.load_balancer ?? null;
      let lbApplyThrew = false;
      try {
        const lbRes = await opts.loadBalancerProvider.apply(
          refs.lb,
          observed?.load_balancer ?? null,
        );
        if (lbRes.changed) anyChanged = true;
        // Re-observe to get the post-apply public IPs / target ids.
        lbObserved = await opts.loadBalancerProvider
          .observe(refs.lb.name)
          .catch(() => observed?.load_balancer ?? null);
      } catch {
        lbApplyThrew = true;
        componentHealthy.load_balancer = false;
        failures.push("load_balancer");
      }

      // --- 3) Firewall (applied_to = LB backend server NAMES) ---------
      if (refs.fw) {
        try {
          const servers = await opts.serversProvider();
          const backendNames = lbObserved
            ? backendServerNames(lbObserved, servers)
            : [];
          // Override `applied_to` to the explicit name list. We construct a
          // new object (do not mutate the looked-up Firewall — the lookup
          // result is shared with other call sites).
          const desiredFw: Firewall = {
            ...refs.fw,
            applied_to: { in: backendNames },
          };
          const fwRes = await opts.firewallProvider.apply(
            desiredFw,
            observed?.firewall ?? null,
          );
          if (fwRes.changed) anyChanged = true;
        } catch {
          componentHealthy.firewall = false;
          failures.push("firewall");
        }
      }

      // --- 4) DNS (A + AAAA) — runs even if firewall failed, as long
      //          as the LB has a public IP we can read. ------------------
      if (lbObserved) {
        const ipv4 = lbObserved.hetzner.public_net.ipv4.ip;
        const ipv6 = lbObserved.hetzner.public_net.ipv6.ip;
        const zone = zoneFromHostname(desired.hostname);
        const name = leftLabelOf(desired.hostname, zone);
        try {
          if (ipv4) {
            const aRec: DnsRecord = {
              zone,
              name,
              type: "A",
              value: ipv4,
              ttl,
            };
            const aRes = await opts.dnsProvider.apply({
              op: "upsert",
              entity: `dns:${name}.${zone}`,
              desired: aRec,
            });
            if (aRes.changed) anyChanged = true;
          }
          if (ipv6) {
            const aaaaRec: DnsRecord = {
              zone,
              name,
              type: "AAAA",
              value: ipv6,
              ttl,
            };
            const aaaaRes = await opts.dnsProvider.apply({
              op: "upsert",
              entity: `dns:${name}.${zone}`,
              desired: aaaaRec,
            });
            if (aaaaRes.changed) anyChanged = true;
          }
        } catch {
          componentHealthy.dns = false;
          failures.push("dns");
        }
      } else if (!lbApplyThrew && !failures.includes("load_balancer")) {
        // LB apply succeeded but yielded no observable public IPs — this
        // shouldn't happen with the F4 fake but is a genuine DNS-only
        // failure mode we want to flag. If the LB itself already failed,
        // we DON'T double-report `dns`: `load_balancer` already carries the
        // root cause, and adding `dns` would be misleading.
        componentHealthy.dns = false;
        failures.push("dns");
      }

      // Status aggregation: first failing component in DAG order wins.
      const ORDER: ComponentKind[] = [
        "certificate",
        "load_balancer",
        "firewall",
        "dns",
      ];
      const worst = ORDER.find((k) => !componentHealthy[k]);
      const status: "healthy" | "degraded" =
        worst === undefined ? "healthy" : "degraded";
      return {
        entity,
        changed: anyChanged,
        status,
        ...(worst ? { worst_component_reason: worst } : {}),
      };
    },

    async verify(desired: Ingress): Promise<boolean> {
      const refs = await resolveRefs(desired);
      const checks: Promise<boolean>[] = [
        opts.certificateProvider.verify(refs.cert),
        opts.loadBalancerProvider.verify(refs.lb),
      ];
      if (refs.fw) {
        // For verify, reconstruct the same backend-override the apply path
        // built — otherwise the firewall would never verify true (its
        // declared `applied_to` is a label selector, not the resolved names).
        const lbObs = await opts.loadBalancerProvider
          .observe(refs.lb.name)
          .catch(() => null);
        const servers = await opts.serversProvider();
        const backendNames = lbObs
          ? backendServerNames(lbObs, servers)
          : [];
        const overridden: Firewall = {
          ...refs.fw,
          applied_to: { in: backendNames },
        };
        checks.push(opts.firewallProvider.verify(overridden));
      }
      const results = await Promise.all(checks);
      return results.every((x) => x === true);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the BACKEND server NAMES of an LB by intersecting its observed
 * target hcloud_ids against the per-cycle Server snapshot. Returns a sorted,
 * dedup'd name list (deterministic for downstream equality).
 */
function backendServerNames(
  obs: ObservedLoadBalancer,
  servers: readonly Server[],
): string[] {
  const idToName = new Map<number, string>();
  for (const s of servers) {
    if (typeof s.hcloud_id === "number") idToName.set(s.hcloud_id, s.name);
  }
  const names = new Set<string>();
  for (const t of obs.hetzner.targets) {
    if (t.type === "server" && t.server) {
      const n = idToName.get(t.server.id);
      if (n) names.add(n);
    }
  }
  return [...names].sort();
}

/**
 * Bloco-A simplification: the zone is the part of `hostname` past its first
 * dot (`web.example.com` → `example.com`). A label-only hostname is rejected as
 * a precondition (no apex-only Ingress in scope for Bloco A). Explicit zone
 * selection is deferred to a later block.
 */
function zoneFromHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  if (dot < 0 || dot === hostname.length - 1) {
    throw new ReconcileError(
      "precondition",
      `IngressProvider: hostname "${hostname}" is missing a zone suffix (expected "<label>.<zone>")`,
    );
  }
  return hostname.slice(dot + 1);
}

function leftLabelOf(hostname: string, zone: string): string {
  // hostname must end with `.${zone}` — strip it; else fall back to the
  // hostname's first label (defensive: zoneFromHostname already enforced
  // structural shape).
  const suffix = `.${zone}`;
  return hostname.endsWith(suffix)
    ? hostname.slice(0, -suffix.length)
    : hostname.split(".")[0]!;
}
