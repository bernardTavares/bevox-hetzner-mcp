/**
 * core/src/providers/v2/hetzner-firewall.test.ts
 *
 * Task F1.3 — HetznerFirewallProvider drives observe + plan + apply + verify
 * against the in-process Hetzner v2 firewalls fake. ZERO network.
 *
 * Central guarantees (spec-mãe §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; spec-filha Bloco A allow-list semantics):
 *
 *   - plan() returns `{ ops: [...] }` derived from (desired, observed). On a
 *     fresh backend (observed null) it emits `create`. When desired == observed
 *     under SET semantics (rules, applied_to), ops is empty (no-op).
 *   - apply() converges then is a NO-OP on the second run.
 *   - Drift (extra rule on Hetzner not in desired) is REPORTED via a `drift`
 *     plan item; apply NEVER removes the extra (fail-safe: `set_rules` is a
 *     wholesale replace, so apply only re-runs set_rules when desired ⊄
 *     observed — pure-extra observed state is left untouched).
 *   - Error classification follows v1 taxonomy via HttpClient: 429 →
 *     transient (retryable); 422 invalid rules → fatal/precondition
 *     (provider re-wraps the http-client "fatal" as `precondition` since
 *     malformed input is a caller-correctable precondition violation).
 */

import { describe, it, expect } from "vitest";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import {
  createHetznerV2HttpClient,
  type HetznerV2HttpClient,
} from "./hetzner-cloud-v2-http.js";
import { createHetznerFirewallProvider } from "./hetzner-firewall.js";
import type { Firewall } from "../../domain/entities-v2.js";
import type { Server } from "../../domain/entities.js";
import { ReconcileError } from "../../domain/errors.js";

const BASE = "https://api.hetzner.cloud/v1";

/**
 * Boot the fake + a v2 http client wired to it, and a provider that resolves
 * its selector against the supplied fixture servers. Returns helpers callers
 * compose as needed.
 */
function providerWithFake(opts?: { servers?: Server[] }) {
  const fake = createHetznerHttpFake();
  const v2: HetznerV2HttpClient = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fake.fetch,
  });
  const servers: Server[] = opts?.servers ?? [];
  const p = createHetznerFirewallProvider({
    http: v2,
    serversProvider: async () => servers,
  });
  return { fake, v2, p, servers };
}

function mkServer(name: string, hcloud_id: number, labels: Record<string, string> = {}): Server {
  return {
    name,
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels,
    network: "mesh",
    status: "healthy",
    hcloud_id,
  };
}

const DESIRED: Firewall = {
  name: "web-fw",
  rules: [
    {
      direction: "in",
      protocol: "tcp",
      port: "443",
      source_ips: ["0.0.0.0/0"],
    },
  ],
  applied_to: { label: "web" },
};

describe("HetznerFirewallProvider — plan/apply/verify (F1.3)", () => {
  it("plan creates firewall when absent", async () => {
    const { p } = providerWithFake();
    const plan = await p.plan(DESIRED, null);
    expect(plan.ops).toEqual([{ op: "create", entity: "firewall:web-fw" }]);
  });

  it("plan is no-op when desired == observed (idempotency)", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Pre-seed Hetzner with the exact desired state.
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        rules: DESIRED.rules,
        apply_to: [{ type: "server", server: { id: 10 } }],
      }),
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toEqual([]);
  });

  it("apply is idempotent: second call same desired = no-op", async () => {
    const { p } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    let observed = await p.observe(DESIRED.name);
    const first = await p.apply(DESIRED, observed);
    expect(first.changed).toBe(true);
    observed = await p.observe(DESIRED.name);
    const second = await p.apply(DESIRED, observed);
    expect(second.changed).toBe(false);
  });

  it("drift: extra rule on Hetzner is reported, NEVER removed", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Pre-seed Hetzner with DESIRED rules PLUS an extra rule not in desired.
    const extraRule = {
      direction: "in",
      protocol: "tcp",
      port: "22",
      source_ips: ["10.0.0.0/8"],
    };
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        rules: [...DESIRED.rules, extraRule],
        apply_to: [{ type: "server", server: { id: 10 } }],
      }),
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    // Drift IS reported.
    expect(plan.ops.some((o) => o.op === "drift")).toBe(true);
    // Apply does NOT remove the extra rule (fail-safe: set_rules is a
    // wholesale replace and would lose extras; provider therefore does NOT
    // call set_rules when desired ⊆ observed).
    const r = await p.apply(DESIRED, observed);
    expect(r.changed).toBe(false);
    const after = await p.observe(DESIRED.name);
    expect(after).not.toBeNull();
    expect(after!.hetzner.rules.length).toBe(2);
    expect(
      after!.hetzner.rules.some(
        (rule) => rule.port === "22" && rule.protocol === "tcp",
      ),
    ).toBe(true);
  });

  it("verify() returns true only after observed matches desired", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Initially nothing exists → verify is false.
    expect(await p.verify(DESIRED)).toBe(false);
    // Seed with a mismatched applied_to (wrong server id).
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        rules: DESIRED.rules,
        apply_to: [{ type: "server", server: { id: 999 } }],
      }),
    });
    expect(await p.verify(DESIRED)).toBe(false);
    // Sync via apply().
    const observed = await p.observe(DESIRED.name);
    await p.apply(DESIRED, observed);
    expect(await p.verify(DESIRED)).toBe(true);
  });

  it("classify error: 429 → transient; 422 invalid rules → fatal precondition", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });

    // --- 429 path: one-shot rate-limit, retried by HttpClient → success.
    // Here we want the error to actually surface, not be retried away.
    // The HttpClient's default maxRetries is 3, so a permanent 429 would
    // eventually surface; the simplest deterministic check is to set MANY
    // 429s so retries are exhausted.
    fake.setRateLimitFault({ times: 10, retryAfter: 0 });
    let raised: unknown;
    try {
      await p.observe(DESIRED.name);
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(ReconcileError);
    expect((raised as ReconcileError).errorClass).toBe("transient");

    // Clear and exercise 422 → precondition.
    fake.reset();
    fake.setNextRequestFault({
      status: 422,
      code: "invalid_input",
      message: "rules: invalid port",
    });
    let raised422: unknown;
    try {
      await p.observe(DESIRED.name);
    } catch (e) {
      raised422 = e;
    }
    expect(raised422).toBeInstanceOf(ReconcileError);
    expect((raised422 as ReconcileError).errorClass).toBe("precondition");
  });
});
