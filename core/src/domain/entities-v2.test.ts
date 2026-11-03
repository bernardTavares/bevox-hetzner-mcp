// core/src/domain/entities-v2.test.ts
import { describe, it, expect } from "vitest";
import {
  FirewallSchema,
  FirewallRuleSchema,
  PrimaryIPSchema,
  CertificateSchema,
  LoadBalancerSchema,
  IngressSchema,
  KubeManifestSchema,
  EnsureK3sSchema,
} from "./entities-v2.js";
import {
  FirewallSchema as ConsoleFirewall,
  PrimaryIPSchema as ConsolePrimaryIP,
  CertificateSchema as ConsoleCertificate,
  LoadBalancerSchema as ConsoleLoadBalancer,
  IngressSchema as ConsoleIngress,
} from "../../../console/src/api/contract-v2.js";

const minimalFirewall = {
  name: "bevox-edge",
  rules: [
    {
      direction: "in",
      protocol: "tcp",
      port: "443",
      source_ips: ["10.0.0.0/8"],
    },
  ],
  applied_to: { label: "app" },
};

describe("FirewallSchema (v2 entity, spec-mãe §3 Bloco A)", () => {
  it("parses a minimal valid Firewall", () => {
    expect(() => FirewallSchema.parse(minimalFirewall)).not.toThrow();
  });

  it("a core-valid Firewall is console-valid (cross-package oracle)", () => {
    expect(() => FirewallSchema.parse(minimalFirewall)).not.toThrow();
    expect(() => ConsoleFirewall.parse(minimalFirewall)).not.toThrow();
  });

  it("rejects kebab-case violation on name", () => {
    expect(() =>
      FirewallSchema.parse({ ...minimalFirewall, name: "BevoxEdge" }),
    ).toThrow();
  });

  it("rejects tcp rule without port", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "tcp",
        source_ips: ["10.0.0.0/8"],
      }),
    ).toThrow();
  });

  it("rejects udp rule without port", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "udp",
        source_ips: ["10.0.0.0/8"],
      }),
    ).toThrow();
  });

  it("accepts icmp rule without port", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "icmp",
        source_ips: ["10.0.0.0/8"],
      }),
    ).not.toThrow();
  });

  it("rejects icmp rule WITH port (port forbidden for icmp)", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "icmp",
        port: "443",
        source_ips: ["10.0.0.0/8"],
      }),
    ).toThrow();
  });

  it("rejects direction:in without source_ips", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "tcp",
        port: "443",
      }),
    ).toThrow();
  });

  it("rejects direction:out without destination_ips", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "out",
        protocol: "tcp",
        port: "443",
      }),
    ).toThrow();
  });

  it("rejects 0.0.0.0/0 on port 22 (direction:in) without acknowledged_public_ssh", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22",
            source_ips: ["0.0.0.0/0"],
          },
        ],
        applied_to: { label: "app" },
      }),
    ).toThrow();
  });

  it("rejects 0.0.0.0/0 on port range 22-22 (direction:in) without acknowledged_public_ssh", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22-22",
            source_ips: ["0.0.0.0/0"],
          },
        ],
        applied_to: { label: "app" },
      }),
    ).toThrow();
  });

  it("accepts 0.0.0.0/0 on port 22 with acknowledged_public_ssh: true", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22",
            source_ips: ["0.0.0.0/0"],
          },
        ],
        applied_to: { label: "app" },
        acknowledged_public_ssh: true,
      }),
    ).not.toThrow();
  });

  // I1 — empty rules array must be rejected (implicit-deny-all is user error)
  it("rejects empty rules array", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [],
        applied_to: { label: "app" },
      }),
    ).toThrow();
  });

  // I2 — empty applied_to selector must be rejected
  it("rejects empty applied_to selector", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "443",
            source_ips: ["10.0.0.0/8"],
          },
        ],
        applied_to: {},
      }),
    ).toThrow();
  });

  // I3 — literal-true design: `acknowledged_public_ssh: false` must be rejected
  it("rejects acknowledged_public_ssh: false (literal-true design)", () => {
    expect(() =>
      FirewallSchema.parse({ ...minimalFirewall, acknowledged_public_ssh: false }),
    ).toThrow();
  });

  // I4 — SSH on private CIDR without ack is fine (internal-SSH everyday case)
  it("accepts SSH on private CIDR without acknowledged_public_ssh", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22",
            source_ips: ["10.0.0.0/8"],
          },
        ],
        applied_to: { label: "app" },
      }),
    ).not.toThrow();
  });

  // I5 — outbound SSH to 0.0.0.0/0 is exempt from the SSH guard
  it("accepts outbound SSH to 0.0.0.0/0 without acknowledged_public_ssh", () => {
    expect(() =>
      FirewallSchema.parse({
        name: "bevox-edge",
        rules: [
          {
            direction: "out",
            protocol: "tcp",
            port: "22",
            destination_ips: ["0.0.0.0/0"],
          },
        ],
        applied_to: { label: "app" },
      }),
    ).not.toThrow();
  });

  // M6 — port regex: rejects whitespace and non-numeric, accepts plain numeric
  it("rejects port with leading whitespace (' 22')", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "tcp",
        port: " 22",
        source_ips: ["10.0.0.0/8"],
      }),
    ).toThrow();
  });

  it("rejects non-numeric port ('foo')", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "tcp",
        port: "foo",
        source_ips: ["10.0.0.0/8"],
      }),
    ).toThrow();
  });

  it("accepts plain numeric port ('22')", () => {
    expect(() =>
      FirewallRuleSchema.parse({
        direction: "in",
        protocol: "tcp",
        port: "22",
        source_ips: ["10.0.0.0/8"],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PrimaryIPSchema (v2 entity, spec-mãe §3 Bloco A) — F2.1
// ---------------------------------------------------------------------------
// TODO(bloco-c): the "≤1 server" invariant on `assignee_selector` is enforced
// by the PolicyEngine, not the schema. The schema only validates shape.

const minimalPrimaryIP = {
  name: "bevox-edge-ip",
  type: "ipv4",
  location: "fsn1",
};

describe("PrimaryIPSchema (v2 entity, spec-mãe §3 Bloco A)", () => {
  it("parses a minimal valid PrimaryIP (no assignee_selector)", () => {
    expect(() => PrimaryIPSchema.parse(minimalPrimaryIP)).not.toThrow();
  });

  it("parses a valid PrimaryIP with assignee_selector", () => {
    expect(() =>
      PrimaryIPSchema.parse({
        ...minimalPrimaryIP,
        assignee_selector: { label: "app" },
      }),
    ).not.toThrow();
  });

  it("accepts type: ipv6", () => {
    expect(() =>
      PrimaryIPSchema.parse({ ...minimalPrimaryIP, type: "ipv6" }),
    ).not.toThrow();
  });

  it("a core-valid PrimaryIP is console-valid (cross-package oracle)", () => {
    expect(() => PrimaryIPSchema.parse(minimalPrimaryIP)).not.toThrow();
    expect(() => ConsolePrimaryIP.parse(minimalPrimaryIP)).not.toThrow();
  });

  it("rejects kebab-case violation on name", () => {
    expect(() =>
      PrimaryIPSchema.parse({ ...minimalPrimaryIP, name: "BevoxEdgeIP" }),
    ).toThrow();
  });

  it("rejects type outside ipv4|ipv6", () => {
    expect(() =>
      PrimaryIPSchema.parse({ ...minimalPrimaryIP, type: "ipv7" }),
    ).toThrow();
  });

  it("rejects missing location", () => {
    const { location: _omit, ...withoutLocation } = minimalPrimaryIP;
    expect(() => PrimaryIPSchema.parse(withoutLocation)).toThrow();
  });

  it("rejects empty-string location", () => {
    expect(() =>
      PrimaryIPSchema.parse({ ...minimalPrimaryIP, location: "" }),
    ).toThrow();
  });

  it("rejects empty assignee_selector ({})", () => {
    expect(() =>
      PrimaryIPSchema.parse({ ...minimalPrimaryIP, assignee_selector: {} }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CertificateSchema (v2 entity, spec-mãe §3 Bloco A) — F3.1
// ---------------------------------------------------------------------------
// TODO(bloco-c): PolicyEngine cross-checks that `type: managed` certificates
// have DNS zone coverage (HetznerDNSProvider zone for each `domains[*]`).
// TODO(bloco-c): PEM parser / chain+key match validation is deferred to the
// F3.3 provider; the schema only enforces non-empty strings here.

const minimalManagedCert = {
  name: "bevox-edge-cert",
  type: "managed",
  domains: ["bevox.example.com"],
};

const minimalUploadedCert = {
  name: "bevox-uploaded-cert",
  type: "uploaded",
  domains: ["bevox.example.com"],
  certificate_pem: "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----",
  private_key_secret_ref: "secret://bevox/tls/bevox-edge-cert",
};

describe("CertificateSchema (v2 entity, spec-mãe §3 Bloco A)", () => {
  it("parses a minimal valid managed Certificate (1 domain)", () => {
    expect(() => CertificateSchema.parse(minimalManagedCert)).not.toThrow();
  });

  it("parses a managed Certificate with multiple domains", () => {
    expect(() =>
      CertificateSchema.parse({
        ...minimalManagedCert,
        domains: ["a.bevox.example.com", "b.bevox.example.com", "c.bevox.example.com"],
      }),
    ).not.toThrow();
  });

  it("parses a minimal valid uploaded Certificate (PEM + secret ref)", () => {
    expect(() => CertificateSchema.parse(minimalUploadedCert)).not.toThrow();
  });

  it("a core-valid managed Certificate is console-valid (cross-package oracle)", () => {
    expect(() => CertificateSchema.parse(minimalManagedCert)).not.toThrow();
    expect(() => ConsoleCertificate.parse(minimalManagedCert)).not.toThrow();
  });

  it("a core-valid uploaded Certificate is console-valid (cross-package oracle)", () => {
    expect(() => CertificateSchema.parse(minimalUploadedCert)).not.toThrow();
    expect(() => ConsoleCertificate.parse(minimalUploadedCert)).not.toThrow();
  });

  it("rejects kebab-case violation on name", () => {
    expect(() =>
      CertificateSchema.parse({ ...minimalManagedCert, name: "BevoxEdgeCert" }),
    ).toThrow();
  });

  it("rejects type outside managed|uploaded", () => {
    expect(() =>
      CertificateSchema.parse({ ...minimalManagedCert, type: "self-signed" }),
    ).toThrow();
  });

  it("rejects empty domains ([])", () => {
    expect(() =>
      CertificateSchema.parse({ ...minimalManagedCert, domains: [] }),
    ).toThrow();
  });

  it("rejects uploaded without certificate_pem", () => {
    const { certificate_pem: _omit, ...withoutPem } = minimalUploadedCert;
    expect(() => CertificateSchema.parse(withoutPem)).toThrow();
  });

  it("rejects uploaded without private_key_secret_ref", () => {
    const { private_key_secret_ref: _omit, ...withoutRef } = minimalUploadedCert;
    expect(() => CertificateSchema.parse(withoutRef)).toThrow();
  });

  it("rejects managed WITH certificate_pem (strict discriminated union)", () => {
    expect(() =>
      CertificateSchema.parse({
        ...minimalManagedCert,
        certificate_pem: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
      }),
    ).toThrow();
  });

  it("rejects managed WITH private_key_secret_ref (strict discriminated union)", () => {
    expect(() =>
      CertificateSchema.parse({
        ...minimalManagedCert,
        private_key_secret_ref: "secret://bevox/tls/x",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// LoadBalancerSchema (v2 entity, spec-mãe §3 Bloco A) — F4.1
// ---------------------------------------------------------------------------
// TODO(bloco-c): PolicyEngine enforces `targets` must match ≥1 Service
// (otherwise policy `error`). The schema only validates shape here.

const minimalLoadBalancer = {
  name: "bevox-edge-lb",
  location: "fsn1",
  algorithm: "round_robin",
  targets: { label: "app" },
  health_check: {
    protocol: "http",
    port: 80,
    path: "/healthz",
    interval: 10,
    timeout: 5,
    retries: 3,
  },
};

describe("LoadBalancerSchema (v2 entity, spec-mãe §3 Bloco A)", () => {
  it("parses a minimal valid LoadBalancer (round_robin + http health check)", () => {
    expect(() => LoadBalancerSchema.parse(minimalLoadBalancer)).not.toThrow();
  });

  it("parses a LoadBalancer with least_connections + tcp health check (no path)", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        algorithm: "least_connections",
        health_check: {
          protocol: "tcp",
          port: 5432,
          interval: 10,
          timeout: 5,
          retries: 3,
        },
      }),
    ).not.toThrow();
  });

  it("parses a LoadBalancer with https health check (requires path)", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: {
          protocol: "https",
          port: 443,
          path: "/healthz",
          interval: 10,
          timeout: 5,
          retries: 3,
        },
      }),
    ).not.toThrow();
  });

  it("a core-valid LoadBalancer is console-valid (cross-package oracle)", () => {
    expect(() => LoadBalancerSchema.parse(minimalLoadBalancer)).not.toThrow();
    expect(() => ConsoleLoadBalancer.parse(minimalLoadBalancer)).not.toThrow();
  });

  it("rejects kebab-case violation on name", () => {
    expect(() =>
      LoadBalancerSchema.parse({ ...minimalLoadBalancer, name: "BevoxEdgeLB" }),
    ).toThrow();
  });

  it("rejects algorithm outside round_robin|least_connections", () => {
    expect(() =>
      LoadBalancerSchema.parse({ ...minimalLoadBalancer, algorithm: "random" }),
    ).toThrow();
  });

  it("rejects missing location", () => {
    const { location: _omit, ...withoutLocation } = minimalLoadBalancer;
    expect(() => LoadBalancerSchema.parse(withoutLocation)).toThrow();
  });

  it("rejects empty-string location", () => {
    expect(() =>
      LoadBalancerSchema.parse({ ...minimalLoadBalancer, location: "" }),
    ).toThrow();
  });

  it("rejects empty targets selector ({})", () => {
    expect(() =>
      LoadBalancerSchema.parse({ ...minimalLoadBalancer, targets: {} }),
    ).toThrow();
  });

  it("rejects health_check.protocol outside http|https|tcp", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: {
          ...minimalLoadBalancer.health_check,
          protocol: "udp",
        },
      }),
    ).toThrow();
  });

  it("rejects http health_check WITHOUT path", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: {
          protocol: "http",
          port: 80,
          interval: 10,
          timeout: 5,
          retries: 3,
        },
      }),
    ).toThrow();
  });

  it("rejects https health_check WITHOUT path", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: {
          protocol: "https",
          port: 443,
          interval: 10,
          timeout: 5,
          retries: 3,
        },
      }),
    ).toThrow();
  });

  it("rejects health_check.interval as zero", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, interval: 0 },
      }),
    ).toThrow();
  });

  it("rejects health_check.interval as negative", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, interval: -1 },
      }),
    ).toThrow();
  });

  it("rejects health_check.timeout as zero", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, timeout: 0 },
      }),
    ).toThrow();
  });

  it("rejects health_check.timeout as negative", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, timeout: -1 },
      }),
    ).toThrow();
  });

  it("rejects health_check.retries as negative", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, retries: -1 },
      }),
    ).toThrow();
  });

  it("rejects health_check.port outside 1-65535", () => {
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, port: 0 },
      }),
    ).toThrow();
    expect(() =>
      LoadBalancerSchema.parse({
        ...minimalLoadBalancer,
        health_check: { ...minimalLoadBalancer.health_check, port: 70000 },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// IngressSchema (v2 entity, spec-mãe §3 Bloco A) — F5.1
// ---------------------------------------------------------------------------
// TODO(bloco-c): cross-entity invariants enforced by PolicyEngine —
//   (1) `tls.certificate_ref` resolves to a Certificate whose `domains`
//       covers `hostname`.
//   (2) `routes[*].backend.service_selector` matches ≥1 Service.
// Schema-level checks below only enforce shape; cross-entity resolution is
// deferred to Bloco C.

const minimalIngress = {
  name: "bevox-edge-ingress",
  hostname: "edge.example.org",
  tls: { certificate_ref: "bevox-edge-cert" },
  routes: [
    {
      path: "/",
      backend: {
        service_selector: { label: "app" },
        port: 8080,
      },
    },
  ],
  load_balancer_ref: "bevox-edge-lb",
};

describe("IngressSchema (v2 entity, spec-mãe §3 Bloco A)", () => {
  it("parses a minimal valid Ingress (1 route, no firewall_ref)", () => {
    expect(() => IngressSchema.parse(minimalIngress)).not.toThrow();
  });

  it("parses an Ingress with firewall_ref", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        firewall_ref: "bevox-edge-fw",
      }),
    ).not.toThrow();
  });

  it("parses a multi-route Ingress (first-match by order)", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        routes: [
          {
            path: "/api",
            backend: { service_selector: { label: "api" }, port: 8080 },
          },
          {
            path: "/",
            backend: { service_selector: { label: "web" }, port: 3000 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("a core-valid Ingress is console-valid (cross-package oracle)", () => {
    expect(() => IngressSchema.parse(minimalIngress)).not.toThrow();
    expect(() => ConsoleIngress.parse(minimalIngress)).not.toThrow();
  });

  it("rejects empty routes array (≥1 required)", () => {
    expect(() =>
      IngressSchema.parse({ ...minimalIngress, routes: [] }),
    ).toThrow();
  });

  it("rejects empty hostname", () => {
    expect(() =>
      IngressSchema.parse({ ...minimalIngress, hostname: "" }),
    ).toThrow();
  });

  it("rejects empty tls.certificate_ref", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        tls: { certificate_ref: "" },
      }),
    ).toThrow();
  });

  it("rejects empty load_balancer_ref", () => {
    expect(() =>
      IngressSchema.parse({ ...minimalIngress, load_balancer_ref: "" }),
    ).toThrow();
  });

  it("rejects firewall_ref as empty string if provided", () => {
    expect(() =>
      IngressSchema.parse({ ...minimalIngress, firewall_ref: "" }),
    ).toThrow();
  });

  it("rejects route with empty path", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        routes: [
          {
            path: "",
            backend: { service_selector: { label: "app" }, port: 8080 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects route with empty backend.service_selector", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        routes: [
          {
            path: "/",
            backend: { service_selector: {}, port: 8080 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects route with backend.port = 0 (must be 1-65535 int)", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        routes: [
          {
            path: "/",
            backend: { service_selector: { label: "app" }, port: 0 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects route with backend.port > 65535", () => {
    expect(() =>
      IngressSchema.parse({
        ...minimalIngress,
        routes: [
          {
            path: "/",
            backend: { service_selector: { label: "app" }, port: 70000 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-kebab-case name", () => {
    expect(() =>
      IngressSchema.parse({ ...minimalIngress, name: "BevoxIngress" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EnsureK3sSchema (Bloco E §3.1) — typed, restricted, no free-exec (D7)
// ---------------------------------------------------------------------------

const minimalEnsureK3s = {
  host: "prod-k3s",
  version: "v1.30.2+k3s1",
  role: "server" as const,
};

describe("EnsureK3sSchema (Bloco E §3.1 — typed, restricted, no free-exec D7)", () => {
  it("parses a valid server role", () => {
    expect(() => EnsureK3sSchema.parse(minimalEnsureK3s)).not.toThrow();
  });

  it("parses a valid agent role", () => {
    expect(() =>
      EnsureK3sSchema.parse({ ...minimalEnsureK3s, role: "agent" }),
    ).not.toThrow();
  });

  it("rejects missing host", () => {
    const { host: _omit, ...withoutHost } = minimalEnsureK3s;
    expect(() => EnsureK3sSchema.parse(withoutHost)).toThrow();
  });

  it("rejects missing version", () => {
    const { version: _omit, ...withoutVersion } = minimalEnsureK3s;
    expect(() => EnsureK3sSchema.parse(withoutVersion)).toThrow();
  });

  it("rejects missing role", () => {
    const { role: _omit, ...withoutRole } = minimalEnsureK3s;
    expect(() => EnsureK3sSchema.parse(withoutRole)).toThrow();
  });

  it("rejects role outside server|agent (e.g. 'worker')", () => {
    expect(() =>
      EnsureK3sSchema.parse({ ...minimalEnsureK3s, role: "worker" }),
    ).toThrow();
  });

  it("rejects an input carrying a `command` field (D7 — no free-exec)", () => {
    expect(() =>
      EnsureK3sSchema.parse({ ...minimalEnsureK3s, command: "curl -sfL https://get.k3s.io | sh" }),
    ).toThrow();
  });

  it("rejects an input carrying a `script` field (D7 — no free-exec)", () => {
    expect(() =>
      EnsureK3sSchema.parse({ ...minimalEnsureK3s, script: "#!/bin/bash\ninstall-k3s" }),
    ).toThrow();
  });

  it("rejects an input carrying an `exec` field (D7 — no free-exec)", () => {
    expect(() =>
      EnsureK3sSchema.parse({ ...minimalEnsureK3s, exec: "/usr/local/bin/k3s" }),
    ).toThrow();
  });

  it("parsed result has ONLY the typed fields (no passthrough of unknown keys)", () => {
    const result = EnsureK3sSchema.parse(minimalEnsureK3s);
    expect(Object.keys(result).sort()).toStrictEqual(["host", "role", "version"]);
  });
});

const minimalKubeManifest = {
  host: "prod-k3s",
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api" },
  namespace: "bevox",
  body: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n",
};

describe("KubeManifestSchema (v2 entity, Bloco E §2.1)", () => {
  it("parses a minimal valid kube manifest", () => {
    expect(() => KubeManifestSchema.parse(minimalKubeManifest)).not.toThrow();
  });

  it("preserves the opaque body byte-identical", () => {
    const parsed = KubeManifestSchema.parse(minimalKubeManifest);
    expect(parsed.body).toBe(minimalKubeManifest.body);
  });

  it("accepts an arbitrary k8s kind (no kind enum — D2)", () => {
    expect(() =>
      KubeManifestSchema.parse({ ...minimalKubeManifest, kind: "ConfigMap" }),
    ).not.toThrow();
    expect(() =>
      KubeManifestSchema.parse({ ...minimalKubeManifest, kind: "Service" }),
    ).not.toThrow();
  });

  it("rejects a missing namespace", () => {
    const { namespace: _omit, ...withoutNamespace } = minimalKubeManifest;
    expect(() => KubeManifestSchema.parse(withoutNamespace)).toThrow();
  });

  it("rejects a missing metadata.name", () => {
    expect(() =>
      KubeManifestSchema.parse({ ...minimalKubeManifest, metadata: {} }),
    ).toThrow();
  });

  it("rejects a missing host (named ref required — Q-c)", () => {
    const { host: _omit, ...withoutHost } = minimalKubeManifest;
    expect(() => KubeManifestSchema.parse(withoutHost)).toThrow();
  });

  it("rejects a non-string body", () => {
    expect(() =>
      KubeManifestSchema.parse({ ...minimalKubeManifest, body: 123 }),
    ).toThrow();
  });
});
