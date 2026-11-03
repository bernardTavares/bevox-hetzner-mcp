/**
 * core/src/providers/v2/ingress.test.ts
 *
 * Task F5.2 — IngressProvider composite. Drives a DAG of sub-providers:
 * Certificate → LoadBalancer → (Firewall, applied_to = LB backend servers) →
 * DnsRecord. Status aggregation: healthy iff all sub-components healthy.
 *
 * Central guarantees (spec-mãe §"idempotência por design"; §"fail-safe";
 * spec-filha Bloco A; F5.2 brief):
 *
 *   - apply DAG ORDER: Certificate kickoff → LoadBalancer → (Firewall if
 *     ref) → DNS. Each sibling failure leaves the others to run if their
 *     inputs are available (e.g. DNS still gets the LB ip if cert failed).
 *   - firewall_ref RESOLVED with BACKEND servers, not LB-level (Hetzner LBs
 *     have no direct firewall attachment).
 *   - STATUS AGGREGATION: healthy iff every sub is healthy; otherwise the
 *     composite is `degraded` with the first failing component as the
 *     `worst_component_reason` (cert | load_balancer | firewall | dns).
 *   - PARTIAL FAILURE: a single sub-provider apply error does not abort the
 *     DAG; siblings still run and the composite reports degraded.
 *   - IDEMPOTENCY: a second apply with the same desired is a NO-OP (changed
 *     = false) when every sub-provider is idempotent.
 *   - DECISION: managed-cert pending does NOT block LB / firewall / DNS —
 *     the LB can serve even before the cert finishes issuing (the cert id
 *     is attached at the LB-service level, which is in scope for F5.3 not
 *     here). Composite reports degraded while cert is pending.
 */

import { describe, it, expect, vi } from "vitest";
import { createIngressProvider } from "./ingress.js";
import type {
  IngressProvider,
  IngressProviderOptions,
  ObservedIngress,
} from "./ingress.js";
import type {
  Certificate,
  Firewall,
  Ingress,
  LoadBalancer,
} from "../../domain/entities-v2.js";
import type { Server } from "../../domain/entities.js";
import type {
  LoadBalancerProvider,
  ObservedLoadBalancer,
  HetznerLoadBalancerShape,
} from "./hetzner-load-balancer.js";
import type {
  FirewallProvider,
  ObservedFirewall,
  HetznerFirewallShape,
} from "./hetzner-firewall.js";
import type {
  CertificateProvider,
  ObservedCertificate,
  HetznerCertificateShape,
} from "./hetzner-certificate.js";
import type {
  ApplyResult as DnsApplyResult,
  ObservedSlice,
  PlanAction,
  Provider as DnsProvider,
} from "../provider.js";
import { ReconcileError } from "../../domain/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CERT: Certificate = {
  name: "web-cert",
  type: "managed",
  domains: ["web.example.com"],
};

const UPLOADED_CERT: Certificate = {
  name: "web-cert",
  type: "uploaded",
  domains: ["web.example.com"],
  certificate_pem:
    "-----BEGIN CERTIFICATE-----\nfakecert-web\n-----END CERTIFICATE-----",
  private_key_secret_ref: "secret:web-cert-key",
};

const LB: LoadBalancer = {
  name: "web-lb",
  location: "fsn1",
  algorithm: "round_robin",
  targets: { label: "lb-backend" },
  health_check: {
    protocol: "http",
    port: 80,
    interval: 15,
    timeout: 10,
    retries: 3,
    path: "/health",
  },
};

const FW: Firewall = {
  name: "web-fw",
  rules: [
    {
      direction: "in",
      protocol: "tcp",
      port: "80",
      source_ips: ["0.0.0.0/0"],
    },
  ],
  applied_to: { label: "lb-backend" }, // gets overridden by IngressProvider
};

const ING: Ingress = {
  name: "web",
  hostname: "web.example.com",
  tls: { certificate_ref: "web-cert" },
  routes: [
    {
      path: "/",
      backend: {
        service_selector: { label: "web" },
        port: 80,
      },
    },
  ],
  load_balancer_ref: "web-lb",
  firewall_ref: "web-fw",
};

const ING_NO_FW: Ingress = { ...ING, firewall_ref: undefined };

const SERVERS: Server[] = [
  {
    name: "web-1",
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels: { web: "" },
    network: "mesh",
    status: "healthy",
    hcloud_id: 10,
  },
  {
    name: "web-2",
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels: { web: "" },
    network: "mesh",
    status: "healthy",
    hcloud_id: 11,
  },
];

// ---------------------------------------------------------------------------
// Mock sub-provider builders — these return spy-able objects we can inspect
// for call ordering and arguments.
// ---------------------------------------------------------------------------

interface CallRecord {
  readonly kind: "cert" | "lb" | "fw" | "dns";
  readonly method: "apply" | "observe" | "verify";
  readonly args: readonly unknown[];
}

function mockCertProvider(opts?: {
  observed?: ObservedCertificate | null;
  applyImpl?: CertificateProvider["apply"];
  verifyImpl?: CertificateProvider["verify"];
}): CertificateProvider & { calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const observed = opts?.observed ?? null;
  return {
    name: "mock-cert",
    calls,
    async observe(name) {
      calls.push({ kind: "cert", method: "observe", args: [name] });
      return observed;
    },
    async plan() {
      return { ops: [] };
    },
    async apply(desired, prevObserved) {
      calls.push({ kind: "cert", method: "apply", args: [desired] });
      if (opts?.applyImpl) return opts.applyImpl(desired, prevObserved);
      return {
        entity: `certificate:${desired.name}`,
        changed: true,
        action_status: "completed",
      };
    },
    async verify(desired) {
      calls.push({ kind: "cert", method: "verify", args: [desired] });
      if (opts?.verifyImpl) return opts.verifyImpl(desired);
      return true;
    },
  };
}

function lbObservedFor(name: string, targetIds: number[]): ObservedLoadBalancer {
  const h: HetznerLoadBalancerShape = {
    id: 1,
    name,
    load_balancer_type: { name: "lb11" },
    location: { name: "fsn1" },
    algorithm: { type: "round_robin" },
    services: [],
    targets: targetIds.map((id) => ({ type: "server", server: { id } })),
    labels: {},
    public_net: {
      enabled: true,
      ipv4: { ip: "1.2.3.4" },
      ipv6: { ip: "2001:db8::1" },
    },
    created: "2026-01-01T00:00:00Z",
  };
  return { hetzner: h };
}

function mockLbProvider(opts?: {
  observed?: ObservedLoadBalancer | null;
  applyImpl?: LoadBalancerProvider["apply"];
  verifyImpl?: LoadBalancerProvider["verify"];
}): LoadBalancerProvider & { calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const observed = opts?.observed ?? lbObservedFor("web-lb", [10, 11]);
  return {
    name: "mock-lb",
    calls,
    async observe(name) {
      calls.push({ kind: "lb", method: "observe", args: [name] });
      return observed;
    },
    async plan() {
      return { ops: [] };
    },
    async apply(desired, prevObserved) {
      calls.push({ kind: "lb", method: "apply", args: [desired] });
      if (opts?.applyImpl) return opts.applyImpl(desired, prevObserved);
      return { entity: `load_balancer:${desired.name}`, changed: true };
    },
    async verify(desired) {
      calls.push({ kind: "lb", method: "verify", args: [desired] });
      if (opts?.verifyImpl) return opts.verifyImpl(desired);
      return true;
    },
  };
}

function fwObservedFor(
  name: string,
  serverIds: number[],
): ObservedFirewall {
  const h: HetznerFirewallShape = {
    id: 5,
    name,
    rules: FW.rules,
    applied_to: serverIds.map((id) => ({
      type: "server" as const,
      server: { id },
    })),
  };
  return { hetzner: h };
}

function mockFwProvider(opts?: {
  observed?: ObservedFirewall | null;
  applyImpl?: FirewallProvider["apply"];
  verifyImpl?: FirewallProvider["verify"];
}): FirewallProvider & { calls: CallRecord[]; lastDesired?: Firewall } {
  const calls: CallRecord[] = [];
  const observed = opts?.observed ?? fwObservedFor("web-fw", [10, 11]);
  const out: FirewallProvider & {
    calls: CallRecord[];
    lastDesired?: Firewall;
  } = {
    name: "mock-fw",
    calls,
    async observe(name) {
      calls.push({ kind: "fw", method: "observe", args: [name] });
      return observed;
    },
    async plan() {
      return { ops: [] };
    },
    async apply(desired, prevObserved) {
      out.lastDesired = desired;
      calls.push({ kind: "fw", method: "apply", args: [desired] });
      if (opts?.applyImpl) return opts.applyImpl(desired, prevObserved);
      return { entity: `firewall:${desired.name}`, changed: true };
    },
    async verify(desired) {
      calls.push({ kind: "fw", method: "verify", args: [desired] });
      if (opts?.verifyImpl) return opts.verifyImpl(desired);
      return true;
    },
  };
  return out;
}

function mockDnsProvider(opts?: {
  applyImpl?: (action: PlanAction) => Promise<DnsApplyResult>;
  verifyImpl?: (action: PlanAction) => Promise<boolean>;
  observeImpl?: (scope: string) => Promise<ObservedSlice>;
}): DnsProvider & { calls: CallRecord[]; lastActions: PlanAction[] } {
  const calls: CallRecord[] = [];
  const lastActions: PlanAction[] = [];
  return {
    name: "mock-dns",
    calls,
    lastActions,
    async observe(scope) {
      calls.push({ kind: "dns", method: "observe", args: [scope] });
      if (opts?.observeImpl) return opts.observeImpl(scope);
      return { scope, entities: [] };
    },
    async apply(action) {
      lastActions.push(action);
      calls.push({ kind: "dns", method: "apply", args: [action] });
      if (opts?.applyImpl) return opts.applyImpl(action);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action) {
      calls.push({ kind: "dns", method: "verify", args: [action] });
      if (opts?.verifyImpl) return opts.verifyImpl(action);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Build a wired provider with sensible defaults.
// ---------------------------------------------------------------------------

function buildProvider(
  overrides: Partial<IngressProviderOptions> = {},
  extra?: {
    cert?: Certificate;
    fw?: Firewall;
    lb?: LoadBalancer;
  },
): {
  p: IngressProvider;
  cert: ReturnType<typeof mockCertProvider>;
  lb: ReturnType<typeof mockLbProvider>;
  fw: ReturnType<typeof mockFwProvider>;
  dns: ReturnType<typeof mockDnsProvider>;
  callLog: CallRecord[];
} {
  const cert = mockCertProvider();
  const lb = mockLbProvider();
  const fw = mockFwProvider();
  const dns = mockDnsProvider();
  // Shared chronological log across all mocks. We wire it by pushing
  // each sub-provider's calls array into one combined view via a Proxy on
  // each push — simpler: read them after the fact and sort by occurrence.
  const callLog: CallRecord[] = [];
  for (const m of [cert, lb, fw, dns]) {
    const arr = m.calls;
    const orig = arr.push.bind(arr);
    arr.push = ((...items: CallRecord[]) => {
      for (const it of items) callLog.push(it);
      return orig(...items);
    }) as typeof arr.push;
  }
  const certResolved = extra?.cert ?? CERT;
  const fwResolved = extra?.fw ?? FW;
  const lbResolved = extra?.lb ?? LB;
  const p = createIngressProvider({
    certificateProvider: cert,
    loadBalancerProvider: lb,
    firewallProvider: fw,
    dnsProvider: dns,
    serversProvider: async () => SERVERS,
    servicesProvider: async () => [],
    certificateLookup: async () => certResolved,
    firewallLookup: async () => fwResolved,
    loadBalancerLookup: async () => lbResolved,
    ...overrides,
  });
  return { p, cert, lb, fw, dns, callLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IngressProvider — apply DAG ordering (F5.2)", () => {
  it("apply runs Certificate → LoadBalancer → Firewall → DNS in order", async () => {
    const { p, callLog } = buildProvider();
    await p.apply(ING, null);
    // DNS is called twice (A + AAAA) — dedup adjacent dns entries for the
    // order assertion. The DAG-order invariant is what we test.
    const applyOrder = dedupAdjacent(
      callLog.filter((c) => c.method === "apply").map((c) => c.kind),
    );
    expect(applyOrder).toEqual(["cert", "lb", "fw", "dns"]);
  });

  it("apply skips firewall step when firewall_ref is absent", async () => {
    const { p, callLog } = buildProvider();
    await p.apply(ING_NO_FW, null);
    const applyOrder = dedupAdjacent(
      callLog.filter((c) => c.method === "apply").map((c) => c.kind),
    );
    expect(applyOrder).toEqual(["cert", "lb", "dns"]);
  });

  it("uploaded cert still kicks off before LB (DAG simplicity > parallelism)", async () => {
    // The brief allows parallelism for uploaded; we choose serial for
    // determinism — verify order is still cert → lb.
    const { p, callLog } = buildProvider({}, { cert: UPLOADED_CERT });
    await p.apply({ ...ING, tls: { certificate_ref: "web-cert" } }, null);
    const applyOrder = callLog
      .filter((c) => c.method === "apply")
      .map((c) => c.kind);
    expect(applyOrder.indexOf("cert")).toBeLessThan(applyOrder.indexOf("lb"));
  });
});

function dedupAdjacent<T>(xs: T[]): T[] {
  const out: T[] = [];
  for (const x of xs) {
    if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

describe("IngressProvider — firewall_ref backend resolution (F5.2)", () => {
  it("firewall apply receives applied_to derived from LB backend servers", async () => {
    const { p, fw } = buildProvider();
    await p.apply(ING, null);
    expect(fw.lastDesired).toBeDefined();
    expect(fw.lastDesired!.applied_to).toEqual({
      in: ["web-1", "web-2"],
    });
    // Rules are preserved from the looked-up firewall.
    expect(fw.lastDesired!.rules).toEqual(FW.rules);
    // Name is preserved.
    expect(fw.lastDesired!.name).toBe(FW.name);
  });

  it("DNS apply targets LB's public IPv4 + IPv6", async () => {
    const { p, dns } = buildProvider();
    await p.apply(ING, null);
    const actions = dns.lastActions;
    // Expect one A record and one AAAA record for the hostname.
    const a = actions.find(
      (a) =>
        (a.desired as { type?: string }).type === "A" &&
        (a.desired as { value?: string }).value === "1.2.3.4",
    );
    const aaaa = actions.find(
      (a) =>
        (a.desired as { type?: string }).type === "AAAA" &&
        (a.desired as { value?: string }).value === "2001:db8::1",
    );
    expect(a).toBeDefined();
    expect(aaaa).toBeDefined();
  });
});

describe("IngressProvider — status aggregation (F5.2)", () => {
  it("status `healthy` when all sub-components healthy", async () => {
    const { p } = buildProvider();
    const result = await p.apply(ING, null);
    expect(result.status).toBe("healthy");
    expect(result.changed).toBe(true);
  });

  it("status `degraded` with worst_component_reason=cert when cert pending", async () => {
    const cert = mockCertProvider({
      applyImpl: async (d) => ({
        entity: `certificate:${d.name}`,
        changed: true,
        action_status: "pending",
      }),
    });
    const lb = mockLbProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const result = await p.apply(ING, null);
    expect(result.status).toBe("degraded");
    expect(result.worst_component_reason).toBe("certificate");
  });

  it("status `degraded` when LB apply throws", async () => {
    const lb = mockLbProvider({
      applyImpl: async () => {
        throw new ReconcileError("transient", "lb boom");
      },
    });
    const cert = mockCertProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const result = await p.apply(ING, null);
    expect(result.status).toBe("degraded");
    expect(result.worst_component_reason).toBe("load_balancer");
  });
});

describe("IngressProvider — partial failure (F5.2)", () => {
  it("firewall apply failure does not abort DNS; status=degraded, reason=firewall", async () => {
    const fw = mockFwProvider({
      applyImpl: async () => {
        throw new ReconcileError("transient", "fw boom");
      },
    });
    const cert = mockCertProvider();
    const lb = mockLbProvider();
    const dns = mockDnsProvider();
    const callLog: CallRecord[] = [];
    for (const m of [cert, lb, fw, dns]) {
      const arr = m.calls;
      const orig = arr.push.bind(arr);
      arr.push = ((...items: CallRecord[]) => {
        for (const it of items) callLog.push(it);
        return orig(...items);
      }) as typeof arr.push;
    }
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const result = await p.apply(ING, null);
    expect(result.status).toBe("degraded");
    expect(result.worst_component_reason).toBe("firewall");
    // DNS still ran despite the fw failure.
    const dnsRan = callLog.some(
      (c) => c.kind === "dns" && c.method === "apply",
    );
    expect(dnsRan).toBe(true);
  });
});

describe("IngressProvider — LB failure does not cascade to DNS (F5.2 review)", () => {
  it("LB apply throws → DNS step skipped; only load_balancer in failures, not dns", async () => {
    const cert = mockCertProvider();
    const lb = mockLbProvider({
      applyImpl: async () => {
        throw new ReconcileError("transient", "lb boom");
      },
    });
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const callLog: CallRecord[] = [];
    for (const m of [cert, lb, fw, dns]) {
      const arr = m.calls;
      const orig = arr.push.bind(arr);
      arr.push = ((...items: CallRecord[]) => {
        for (const it of items) callLog.push(it);
        return orig(...items);
      }) as typeof arr.push;
    }
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const result = await p.apply(ING, null);
    // First failing component in DAG order is load_balancer; dns is NOT
    // counted because the LB never produced an observable IP — root cause
    // is the LB, not DNS.
    expect(result.status).toBe("degraded");
    expect(result.worst_component_reason).toBe("load_balancer");
    // DNS provider should never have been called when there's no LB IP.
    const dnsApplied = callLog.some(
      (c) => c.kind === "dns" && c.method === "apply",
    );
    expect(dnsApplied).toBe(false);
  });
});

describe("IngressProvider — idempotency (F5.2)", () => {
  it("second apply with same desired is a no-op (all subs no-op)", async () => {
    const cert = mockCertProvider({
      applyImpl: async (d) => ({
        entity: `certificate:${d.name}`,
        changed: false,
        action_status: "completed",
      }),
    });
    const lb = mockLbProvider({
      applyImpl: async (d) => ({
        entity: `load_balancer:${d.name}`,
        changed: false,
      }),
    });
    const fw = mockFwProvider({
      applyImpl: async (d) => ({
        entity: `firewall:${d.name}`,
        changed: false,
      }),
    });
    const dns = mockDnsProvider({
      applyImpl: async (a) => ({
        entity: a.entity,
        op: a.op,
        changed: false,
      }),
    });
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const observed = await p.observe(ING);
    const result = await p.apply(ING, observed);
    expect(result.changed).toBe(false);
    expect(result.status).toBe("healthy");
  });
});

describe("IngressProvider — verify (F5.2)", () => {
  it("verify is AND-reduce of sub-provider verifies (all true → true)", async () => {
    const { p } = buildProvider();
    const ok = await p.verify(ING);
    expect(ok).toBe(true);
  });

  it("verify false when any sub-provider verify is false", async () => {
    const cert = mockCertProvider({ verifyImpl: async () => false });
    const lb = mockLbProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    expect(await p.verify(ING)).toBe(false);
  });

  it("verify skips firewall sub when firewall_ref absent", async () => {
    const fw = mockFwProvider({ verifyImpl: async () => false });
    const cert = mockCertProvider();
    const lb = mockLbProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    expect(await p.verify(ING_NO_FW)).toBe(true);
  });
});

describe("IngressProvider — observe (F5.2)", () => {
  it("composite observe aggregates sub-observed states", async () => {
    const certObs: ObservedCertificate = {
      hetzner: {
        id: 1,
        name: "web",
        type: "uploaded",
        labels: {},
        fingerprint: "x",
        certificate: "",
        domain_names: ["web.example.com"],
        not_valid_before: null,
        not_valid_after: null,
        status: { issuance: "completed", renewal: "unavailable" },
        created: "",
      } as HetznerCertificateShape,
      status: "healthy",
    };
    const cert = mockCertProvider({ observed: certObs });
    const lb = mockLbProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    const obs = await p.observe(ING);
    expect(obs).not.toBeNull();
    const o = obs as ObservedIngress;
    expect(o.certificate).not.toBeNull();
    expect(o.load_balancer).not.toBeNull();
    expect(o.firewall).not.toBeNull();
  });
});

describe("IngressProvider — lookup failures (F5.2)", () => {
  it("missing certificate lookup → precondition", async () => {
    const cert = mockCertProvider();
    const lb = mockLbProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => null,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => LB,
    });
    await expect(p.apply(ING, null)).rejects.toThrow(ReconcileError);
  });

  it("missing load_balancer lookup → precondition", async () => {
    const cert = mockCertProvider();
    const lb = mockLbProvider();
    const fw = mockFwProvider();
    const dns = mockDnsProvider();
    const p = createIngressProvider({
      certificateProvider: cert,
      loadBalancerProvider: lb,
      firewallProvider: fw,
      dnsProvider: dns,
      serversProvider: async () => SERVERS,
      servicesProvider: async () => [],
      certificateLookup: async () => CERT,
      firewallLookup: async () => FW,
      loadBalancerLookup: async () => null,
    });
    await expect(p.apply(ING, null)).rejects.toThrow(ReconcileError);
  });
});
