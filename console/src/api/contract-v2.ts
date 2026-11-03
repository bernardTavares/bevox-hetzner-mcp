/**
 * console/src/api/contract-v2.ts
 *
 * v2 additive contract surface on top of `./contract.ts` (v1, FROZEN).
 *
 * v2 introduces new write endpoints under `/api/v2/*` (firewalls, primary IPs,
 * certificates, load balancers, ingresses, selectors, expose, …). Every v2
 * write returns a `WriteEnvelopeV2` whose `plan` payload — when present —
 * carries TWO ALWAYS-PRESENT neutral fields beyond v1:
 *
 *   - `cost_estimate`     — Bloco D will activate non-zero deltas;
 *                           Bloco A always emits the zero neutral.
 *   - `policy_violations` — Bloco C will activate non-empty violations;
 *                           Bloco A always emits `[]`.
 *
 * Presence is enforced; non-emptiness is NOT. This keeps the wire shape
 * constant across Blocos so downstream consumers never branch on which Bloco
 * produced the envelope. v1 schemas are imported (NEVER duplicated) so any
 * v1 drift surfaces here too.
 *
 * Entity-shape schemas (Firewall, LoadBalancer, Certificate, PrimaryIP,
 * Ingress) are intentionally NOT defined here — each lands in its own phase
 * file (F1.1, F2.1, …). `CONTRACT-v2.md` is the human-readable companion.
 */

import { z } from "zod";
import { ErrorSchema, WriteEnvelopeStatusEnum } from "./contract.js";

// ---------------------------------------------------------------------------
// Cost & policy primitives (neutral in Bloco A; expanded in Blocos D / C)
// ---------------------------------------------------------------------------

/**
 * A single line item contributing to a plan's monthly cost delta.
 * Concrete shape (`kind`, `eur`, currency, etc.) is finalized in Bloco D;
 * v2 only requires the line items to be objects so the envelope shape is
 * stable today.
 */
export const CostBreakdownItemSchema = z.record(z.unknown());
export type CostBreakdownItem = z.infer<typeof CostBreakdownItemSchema>;

export const CostEstimateSchema = z.object({
  /** Net change in monthly EUR billed by Hetzner if the plan applies. */
  monthly_delta_eur: z.number(),
  /** Per-resource contributions explaining the delta. May be empty. */
  breakdown: z.array(CostBreakdownItemSchema),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/**
 * A policy gate's verdict against the plan. Concrete shape (code, severity,
 * entity, message, …) is finalized in Bloco C; the v2 wire only requires
 * each violation to be an object so the envelope shape is stable today.
 */
export const PolicyViolationSchema = z.record(z.unknown());
export type PolicyViolation = z.infer<typeof PolicyViolationSchema>;

// ---------------------------------------------------------------------------
// v2 plan & envelope
// ---------------------------------------------------------------------------

/**
 * v2 plan payload — diverges from v1's `PlanItem[]`: v2 wraps the op array
 * in an object so cost and policy travel WITH the plan, not as siblings.
 *
 * `ops` is intentionally typed as `unknown[]` here. Per-Bloco op-shape
 * schemas (firewall ops, LB ops, …) land in their own phase files; the v2
 * envelope only enforces the *wrapper* invariants (presence of cost +
 * policy alongside ops). This keeps `contract-v2.ts` minimal and avoids
 * duplicating Bloco-specific schemas.
 */
export const PlanV2Schema = z.object({
  ops: z.array(z.record(z.unknown())),
  cost_estimate: CostEstimateSchema,
  policy_violations: z.array(PolicyViolationSchema),
});
export type PlanV2 = z.infer<typeof PlanV2Schema>;

/**
 * v2 write envelope — same status enum as v1; the `plan` payload is v2-shaped.
 * Reuses v1's `ErrorSchema` and `WriteEnvelopeStatusEnum` (single source of
 * truth, no parallel enums to drift apart).
 */
export const WriteEnvelopeV2Schema = z.object({
  status: WriteEnvelopeStatusEnum,
  plan: PlanV2Schema.optional(),
  approval_id: z.string().optional(),
  error: ErrorSchema.optional(),
});
export type WriteEnvelopeV2 = z.infer<typeof WriteEnvelopeV2Schema>;

// ---------------------------------------------------------------------------
// Firewall (spec-mãe §3 Bloco A) — mirrored byte-for-byte from
// `core/src/domain/entities-v2.ts`. Any drift fails the cross-package oracle
// test in `core/src/domain/entities-v2.test.ts`.
// ---------------------------------------------------------------------------

/** kebab-case identifier: lower-case letters, digits, single hyphens. */
const KebabCaseString = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case");

/** Selector input shape — value-for-value the same grammar as v1
 * `Service.server_selector`. Permissive on read; semantics live in the
 * resolver, not the schema. */
const SelectorSchema = z.record(z.unknown());

const FirewallProtocolEnum = z.enum(["tcp", "udp", "icmp", "esp", "gre"]);

/** Syntactic port shape — mirrors `PortString` in core/entities-v2.ts. */
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
// PrimaryIP (spec-mãe §3 Bloco A) — mirrored byte-for-byte from
// `core/src/domain/entities-v2.ts`. Any drift fails the cross-package oracle
// test in `core/src/domain/entities-v2.test.ts`.
// ---------------------------------------------------------------------------
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
// Certificate (spec-mãe §3 Bloco A) — mirrored byte-for-byte from
// `core/src/domain/entities-v2.ts`. Any drift fails the cross-package oracle
// test in `core/src/domain/entities-v2.test.ts`.
// ---------------------------------------------------------------------------
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
// LoadBalancer (spec-mãe §3 Bloco A) — mirrored byte-for-byte from
// `core/src/domain/entities-v2.ts`. Any drift fails the cross-package oracle
// test in `core/src/domain/entities-v2.test.ts`.
// ---------------------------------------------------------------------------
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
// Ingress (spec-mãe §3 Bloco A) — mirrored byte-for-byte from
// `core/src/domain/entities-v2.ts`. Any drift fails the cross-package oracle
// test in `core/src/domain/entities-v2.test.ts`.
// ---------------------------------------------------------------------------
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
