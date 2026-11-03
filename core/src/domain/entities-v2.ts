/**
 * core/src/domain/entities-v2.ts
 *
 * v2 entity schemas (spec-mãe §3 Bloco A and onward). v1 entities live in
 * `./entities.ts` and are FROZEN — v2 additions land here so v1 stays stable.
 *
 * As with v1, each schema is mirrored byte-identically in
 * `console/src/api/contract-v2.ts` so the same cross-package oracle invariant
 * holds: any core-valid v2 entity is also console-valid. If a v2 schema drifts
 * between the two files, the oracle test in `entities-v2.test.ts` fails.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** kebab-case identifier: lower-case letters, digits, single hyphens. */
const KebabCaseString = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

/**
 * Selector input shape — value-for-value the same grammar as
 * `Service.server_selector` in v1 and `resolveServerSelector` in
 * `core/src/agent/v2/resolve-selector.ts`. Intentionally permissive on read
 * (record of unknown) — semantics live in the resolver, not the schema.
 *
 * Inlined here rather than imported from `agent/v2/` to keep the domain layer
 * free of agent-layer imports (a later refactor may hoist a shared
 * `domain/selector.ts` if more entities reuse it).
 */
const SelectorSchema = z.record(z.unknown());

// ---------------------------------------------------------------------------
// FirewallRule (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------
//
// Discriminated union on `direction` so `source_ips` is required for `in`
// and `destination_ips` is required for `out`. A super-refine then enforces
// the protocol↔port interaction: `icmp` forbids `port`; every other protocol
// requires `port`.

const FirewallProtocolEnum = z.enum(["tcp", "udp", "icmp", "esp", "gre"]);

/**
 * Syntactic port shape: a single numeric port (`"80"`) or a numeric range
 * (`"80-90"`). Rejects whitespace, leading zeros aside, non-numeric typos
 * (`"foo"`, `" 22"`) at parse time so the SSH guard's literal `"22"` /
 * `"22-22"` comparison is robust. Semantic bounds (port ≤ 65535, lo ≤ hi)
 * are deferred to the PolicyEngine in a later Bloco.
 */
const PortString = z
  .string()
  .regex(
    /^\d+(-\d+)?$/,
    "port must be a number or numeric range like '80' or '80-90'",
  );

const FirewallRuleInSchema = z.object({
  direction: z.literal("in"),
  protocol: FirewallProtocolEnum,
  port: PortString.optional(),
  source_ips: z.array(z.string()).min(1),
  destination_ips: z.array(z.string()).optional(),
});

const FirewallRuleOutSchema = z.object({
  direction: z.literal("out"),
  protocol: FirewallProtocolEnum,
  port: PortString.optional(),
  source_ips: z.array(z.string()).optional(),
  destination_ips: z.array(z.string()).min(1),
});

export const FirewallRuleSchema = z
  .discriminatedUnion("direction", [FirewallRuleInSchema, FirewallRuleOutSchema])
  .superRefine((rule, ctx) => {
    if (rule.protocol === "icmp") {
      if (rule.port !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "icmp rules must not specify `port`",
          path: ["port"],
        });
      }
      return;
    }
    if (rule.port === undefined || rule.port === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${rule.protocol} rules require \`port\``,
        path: ["port"],
      });
    }
  });
export type FirewallRule = z.infer<typeof FirewallRuleSchema>;

// ---------------------------------------------------------------------------
// Firewall (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------

/**
 * Returns true if `port` denotes SSH (port 22) — covers literal `"22"` and
 * the explicit single-element range `"22-22"`. Broader ranges that *contain*
 * 22 (e.g. `"20-30"`) are intentionally NOT detected here; spec-mãe §3 Bloco A
 * delegates exhaustive range-vs-port containment to the PolicyEngine in a
 * later Bloco.
 * TODO(bloco-c): broader range parsing via PolicyEngine.
 */
function portIsSsh(port: string | undefined): boolean {
  if (port === undefined) return false;
  return port === "22" || port === "22-22";
}

export const FirewallSchema = z
  .object({
    name: KebabCaseString,
    rules: z
      .array(FirewallRuleSchema)
      .min(1, "firewall must declare at least one rule"),
    applied_to: SelectorSchema.refine(
      (s) => Object.keys(s).length > 0,
      "applied_to must declare at least one selector clause",
    ),
    /**
     * Explicit acknowledgement that this firewall intentionally exposes SSH
     * (port 22) to the public internet (`0.0.0.0/0`). Without this flag, any
     * such rule is rejected at parse time. The literal-true type means the
     * field is either present-and-true or absent — `false` is invalid by
     * design (no ambiguous "explicitly not acknowledged" state).
     */
    acknowledged_public_ssh: z.literal(true).optional(),
  })
  .superRefine((fw, ctx) => {
    if (fw.acknowledged_public_ssh === true) return;
    fw.rules.forEach((rule, idx) => {
      if (rule.direction !== "in") return;
      if (!portIsSsh(rule.port)) return;
      const ips = rule.source_ips ?? [];
      if (ips.includes("0.0.0.0/0")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "rule exposes SSH (port 22) to 0.0.0.0/0 — set `acknowledged_public_ssh: true` to permit",
          path: ["rules", idx, "source_ips"],
        });
      }
    });
  });
export type Firewall = z.infer<typeof FirewallSchema>;

// ---------------------------------------------------------------------------
// PrimaryIP (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------
//
// Schema only validates shape. The "≤1 server" invariant on
// `assignee_selector` (a PrimaryIP is not a load balancer) is enforced by the
// PolicyEngine in Bloco C — matching ≥2 servers there yields a policy
// `error`. The empty-selector rejection here mirrors FirewallSchema's
// `applied_to` stance: an empty record is never a meaningful selector.
// TODO(bloco-c): PolicyEngine enforces ≤1 server matched by assignee_selector.

const PrimaryIPTypeEnum = z.enum(["ipv4", "ipv6"]);

export const PrimaryIPSchema = z.object({
  name: KebabCaseString,
  type: PrimaryIPTypeEnum,
  location: z.string().min(1),
  assignee_selector: SelectorSchema.refine(
    (s) => Object.keys(s).length > 0,
    "assignee_selector must declare at least one selector clause",
  ).optional(),
});
export type PrimaryIP = z.infer<typeof PrimaryIPSchema>;

// ---------------------------------------------------------------------------
// Certificate (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------
//
// Discriminated union on `type`:
//   - `managed`  — ACME via Hetzner; only `domains` is needed.
//   - `uploaded` — operator-supplied; requires `certificate_pem` AND
//                  `private_key_secret_ref` (resolved via secret store).
//
// The `managed` branch uses `.strict()` so an `uploaded`-only field arriving on
// a `managed` cert (e.g. `certificate_pem`) is rejected at parse time rather
// than silently stripped — symmetric with the spec invariant that `managed`
// MUST NOT carry PEM material.
//
// TODO(bloco-c): PolicyEngine cross-checks `type: managed` against
// HetznerDNSProvider zones to confirm each `domains[*]` falls inside a
// managed zone (per spec-mãe §3 Bloco A invariants).
// TODO(bloco-c): PEM parser / chain+key match validation is deferred to the
// F3.3 provider; the schema here only enforces non-empty strings.

const ManagedCertificateSchema = z
  .object({
    name: KebabCaseString,
    type: z.literal("managed"),
    domains: z.array(z.string().min(1)).min(1),
  })
  .strict();

const UploadedCertificateSchema = z.object({
  name: KebabCaseString,
  type: z.literal("uploaded"),
  domains: z.array(z.string().min(1)).min(1),
  certificate_pem: z.string().min(1),
  private_key_secret_ref: z.string().min(1),
});

export const CertificateSchema = z.discriminatedUnion("type", [
  ManagedCertificateSchema,
  UploadedCertificateSchema,
]);
export type Certificate = z.infer<typeof CertificateSchema>;

// ---------------------------------------------------------------------------
// LoadBalancer (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------
//
// Discriminated union on `health_check.protocol`:
//   - `http`  / `https` — `path` is REQUIRED (HTTP semantics need a target URI).
//   - `tcp`            — no `path` (L4 probe).
//
// `port` is a NUMBER 1-65535 (Hetzner LB health-check uses port-as-int), unlike
// FirewallRule's string-range `port`. Empty `targets` selector is rejected at
// parse time (same stance as Firewall.applied_to / PrimaryIP.assignee_selector).
//
// TODO(bloco-c): PolicyEngine enforces `targets` must match ≥1 Service
// (otherwise policy `error` — a LB with no backend is a user error).

const LoadBalancerAlgorithmEnum = z.enum(["round_robin", "least_connections"]);

const BaseHealthCheckSchema = z.object({
  port: z.number().int().min(1).max(65535),
  interval: z.number().int().positive(),
  timeout: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});
const HttpHealthCheckSchema = BaseHealthCheckSchema.extend({
  protocol: z.literal("http"),
  path: z.string().min(1),
});
const HttpsHealthCheckSchema = BaseHealthCheckSchema.extend({
  protocol: z.literal("https"),
  path: z.string().min(1),
});
const TcpHealthCheckSchema = BaseHealthCheckSchema.extend({
  protocol: z.literal("tcp"),
});
const HealthCheckSchema = z.discriminatedUnion("protocol", [
  HttpHealthCheckSchema,
  HttpsHealthCheckSchema,
  TcpHealthCheckSchema,
]);

export const LoadBalancerSchema = z.object({
  name: KebabCaseString,
  location: z.string().min(1),
  algorithm: LoadBalancerAlgorithmEnum,
  targets: SelectorSchema.refine(
    (s) => Object.keys(s).length > 0,
    "targets must declare at least one selector clause",
  ),
  health_check: HealthCheckSchema,
});
export type LoadBalancer = z.infer<typeof LoadBalancerSchema>;

// ---------------------------------------------------------------------------
// Ingress (spec-mãe §3 Bloco A)
// ---------------------------------------------------------------------------
//
// `hostname` is the public FQDN the LB terminates TLS for. `routes` is a
// first-match-by-order list — empty is rejected (an Ingress with no route is
// a user error). `firewall_ref`, when present, applies to the Servers that
// back the LB (Hetzner Cloud LBs cannot carry a Firewall directly).
//
// Schema validates SHAPE only. Cross-entity invariants — `tls.certificate_ref`
// resolves to a Certificate whose `domains` covers `hostname`, and each
// `routes[*].backend.service_selector` matches ≥1 Service — are deferred to
// the PolicyEngine in Bloco C (a Bloco-A Ingress with a dangling cert or
// selector still parses; the policy gate is where it earns its `error`).
// TODO(bloco-c): PolicyEngine enforces (1) hostname ∈ cert.domains and
//                (2) service_selector matches ≥1 Service.
// TODO(bloco-c): real FQDN validation for `hostname` (today `z.string().min(1)`).

const IngressTlsSchema = z.object({
  certificate_ref: z.string().min(1),
});

const IngressBackendSchema = z.object({
  service_selector: SelectorSchema.refine(
    (s) => Object.keys(s).length > 0,
    "service_selector must declare at least one clause",
  ),
  port: z.number().int().min(1).max(65535),
});

const IngressRouteSchema = z.object({
  path: z.string().min(1),
  backend: IngressBackendSchema,
});

export const IngressSchema = z.object({
  name: KebabCaseString,
  hostname: z.string().min(1),
  tls: IngressTlsSchema,
  routes: z
    .array(IngressRouteSchema)
    .min(1, "ingress must declare at least one route"),
  load_balancer_ref: z.string().min(1),
  firewall_ref: z.string().min(1).optional(),
});
export type Ingress = z.infer<typeof IngressSchema>;

// ---------------------------------------------------------------------------
// KubeManifest (Bloco E §2.1)
// ---------------------------------------------------------------------------
//
// Envelope-only (decision D2): the schema validates ONLY the identity used
// for observe / dedup / idempotency; the k8s document itself rides in the
// opaque `body` string and is NEVER validated field-by-field here — it is
// piped verbatim to `kubectl apply -f -`. `host` is a NAMED REFERENCE to a
// server-side SSH host config (Q-c) — the credential never travels in the
// manifest. The `body` may carry `secret:<ref>` tokens; resolution happens
// ONLY at apply behind ApplyContext (ground rule #4), never here.
export const KubeManifestSchema = z.object({
  host: z.string().min(1),
  apiVersion: z.string().min(1),
  kind: z.string().min(1),
  metadata: z.object({ name: z.string().min(1) }),
  namespace: z.string().min(1),
  body: z.string(),
});
export type KubeManifest = z.infer<typeof KubeManifestSchema>;

// ---------------------------------------------------------------------------
// EnsureK3s (Bloco E §3.1)
// ---------------------------------------------------------------------------
//
// Typed, restricted install-recipe for k3s — D7 (no arbitrary command).
// `host` is a NAMED REFERENCE to a server-side SSH host config (credential
// never in the manifest, like KubeManifest.host). `version` is the desired
// k3s version channel/tag (e.g. "v1.30.2+k3s1"). `role` is either
// "server" (control-plane) or "agent" (worker). `.strict()` rejects any
// unknown key so free-exec fields (`command`, `script`, `exec`, `shell`,
// etc.) are refused at the schema boundary — D7 locked at parse time.
export const EnsureK3sSchema = z
  .object({
    host: z.string().min(1),
    version: z.string().min(1),
    role: z.enum(["server", "agent"]),
  })
  .strict();
export type EnsureK3s = z.infer<typeof EnsureK3sSchema>;
