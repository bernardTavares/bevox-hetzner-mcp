/**
 * core/test/fakes/hetzner-http-v2/certificates.test.ts
 *
 * Task 3.2 — proves the Certificate sub-fake (mounted on the Cloud-API fake)
 * is a faithful `fetchImpl` seam for the v2 Certificate provider/reconciler:
 *   - POST /certificates (managed → pending; uploaded → completed immediately)
 *   - GET /certificates/:id (managed flips to completed after N polls)
 *   - GET /certificates (paginated)
 *   - DELETE /certificates/:id
 *   - 404 on unknown id
 *   - 429/Retry-After via the existing setRateLimitFault hook
 *   - Managed state-machine hooks: setManagedIssuanceLatency (default),
 *     setNextManagedIssuanceLatency (one-shot), setNextManagedIssuanceFailure
 *
 * Wire-compat only: NOT a Hetzner spec emulator.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/providers/http-client.js";
import { createHetznerHttpFake } from "../hetzner-http.js";

const BASE = "https://api.hetzner.cloud/v1";

interface CertificateStatus {
  issuance: "pending" | "completed" | "failed";
  renewal: "scheduled" | "pending" | "unavailable";
}

interface Certificate {
  id: number;
  name: string;
  type: "managed" | "uploaded";
  labels: Record<string, string>;
  fingerprint: string;
  certificate: string;
  domain_names: string[];
  not_valid_before: string | null;
  not_valid_after: string | null;
  status: CertificateStatus;
  created: string;
}

interface Action {
  id: number;
  command: string;
  status: "success";
  progress: number;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

async function createManaged(
  fake: ReturnType<typeof createHetznerHttpFake>,
  name = "web-cert",
  domains: string[] = ["app.example.com"],
): Promise<{ certificate: Certificate; action: Action }> {
  const res = await fake.fetch(`${BASE}/certificates`, {
    method: "POST",
    body: JSON.stringify({ name, type: "managed", domains }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { certificate: Certificate; action: Action };
}

describe("createHetznerHttpFake — /certificates routes (3.2)", () => {
  it("POST /certificates managed → 201 pending + action(create_certificate)", async () => {
    const fake = createHetznerHttpFake();
    const { certificate, action } = await createManaged(fake);
    expect(certificate.id).toBe(1);
    expect(certificate.type).toBe("managed");
    expect(certificate.status.issuance).toBe("pending");
    expect(certificate.fingerprint).toBe("");
    expect(certificate.certificate).toBe("");
    expect(certificate.not_valid_before).toBeNull();
    expect(certificate.not_valid_after).toBeNull();
    expect(certificate.domain_names).toEqual(["app.example.com"]);
    expect(action.command).toBe("create_certificate");
    expect(action.status).toBe("success");
  });

  it("POST /certificates uploaded → 201 completed immediately with cert/fingerprint populated", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({
        name: "static-cert",
        type: "uploaded",
        certificate: "-----BEGIN CERTIFICATE-----\nMIIA...\n-----END CERTIFICATE-----",
        private_key: "-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----",
        domain_names: ["api.example.com"],
      }),
    });
    expect(res.status).toBe(201);
    const { certificate, action } = (await res.json()) as {
      certificate: Certificate;
      action: Action;
    };
    expect(certificate.type).toBe("uploaded");
    expect(certificate.status.issuance).toBe("completed");
    expect(certificate.fingerprint.length).toBeGreaterThan(0);
    expect(certificate.certificate).toContain("BEGIN CERTIFICATE");
    expect(certificate.not_valid_before).not.toBeNull();
    expect(certificate.not_valid_after).not.toBeNull();
    expect(certificate.domain_names).toEqual(["api.example.com"]);
    expect(action.command).toBe("create_certificate");
  });

  it("POST /certificates managed without domains → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({ name: "no-domains", type: "managed" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("POST /certificates uploaded without certificate/private_key → 400", async () => {
    const fake = createHetznerHttpFake();
    const r1 = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({ name: "missing-cert", type: "uploaded", private_key: "k" }),
    });
    expect(r1.status).toBe(400);
    const r2 = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({ name: "missing-key", type: "uploaded", certificate: "c" }),
    });
    expect(r2.status).toBe(400);
  });

  it("POST /certificates without name → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({ type: "managed", domains: ["x.example.com"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("POST /certificates with malformed body → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("GET /certificates/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates/999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("GET /certificates/:id managed flips to completed after default (2) polls", async () => {
    const fake = createHetznerHttpFake();
    await createManaged(fake);

    const p1 = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(p1.certificate.status.issuance).toBe("pending");

    const p2 = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(p2.certificate.status.issuance).toBe("completed");
    expect(p2.certificate.fingerprint.length).toBeGreaterThan(0);
    expect(p2.certificate.certificate).toContain("BEGIN CERTIFICATE");
    expect(p2.certificate.not_valid_before).not.toBeNull();
    expect(p2.certificate.not_valid_after).not.toBeNull();
    expect(p2.certificate.status.renewal).toBe("scheduled");

    // Once issued, subsequent GETs are stable (no further state change).
    const p3 = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(p3.certificate.status.issuance).toBe("completed");
    expect(p3.certificate.fingerprint).toBe(p2.certificate.fingerprint);
    expect(p3.certificate.certificate).toBe(p2.certificate.certificate);
  });

  it("setManagedIssuanceLatency(0) → first GET returns completed", async () => {
    const fake = createHetznerHttpFake();
    fake.setManagedIssuanceLatency(0);
    await createManaged(fake);
    const got = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(got.certificate.status.issuance).toBe("completed");
  });

  it("setManagedIssuanceLatency(5) → 5 polls before issued", async () => {
    const fake = createHetznerHttpFake();
    fake.setManagedIssuanceLatency(5);
    await createManaged(fake);
    for (let i = 0; i < 4; i++) {
      const r = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
        certificate: Certificate;
      };
      expect(r.certificate.status.issuance).toBe("pending");
    }
    const final = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(final.certificate.status.issuance).toBe("completed");
  });

  it("setNextManagedIssuanceLatency(1) only affects the NEXT managed cert", async () => {
    const fake = createHetznerHttpFake();
    fake.setNextManagedIssuanceLatency(1);
    await createManaged(fake, "fast-cert", ["fast.example.com"]);
    await createManaged(fake, "slow-cert", ["slow.example.com"]);

    // Cert 1 (fast) flips after 1 poll.
    const fast = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(fast.certificate.status.issuance).toBe("completed");

    // Cert 2 (slow) still uses default (2 polls).
    const slow1 = (await (await fake.fetch(`${BASE}/certificates/2`)).json()) as {
      certificate: Certificate;
    };
    expect(slow1.certificate.status.issuance).toBe("pending");
    const slow2 = (await (await fake.fetch(`${BASE}/certificates/2`)).json()) as {
      certificate: Certificate;
    };
    expect(slow2.certificate.status.issuance).toBe("completed");
  });

  it("setNextManagedIssuanceFailure(true) → next managed cert lands at failed", async () => {
    const fake = createHetznerHttpFake();
    fake.setManagedIssuanceLatency(1);
    fake.setNextManagedIssuanceFailure(true);
    await createManaged(fake, "doomed", ["doomed.example.com"]);

    const r = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(r.certificate.status.issuance).toBe("failed");
    expect(r.certificate.status.renewal).toBe("unavailable");
    expect(r.certificate.fingerprint).toBe("");
    expect(r.certificate.certificate).toBe("");

    // Subsequent managed cert is NOT failed (one-shot consumed).
    await createManaged(fake, "ok", ["ok.example.com"]);
    const ok1 = (await (await fake.fetch(`${BASE}/certificates/2`)).json()) as {
      certificate: Certificate;
    };
    expect(ok1.certificate.status.issuance).toBe("completed");
  });

  it("DELETE /certificates/:id → 204; subsequent GET → 404", async () => {
    const fake = createHetznerHttpFake();
    await createManaged(fake);
    const del = await fake.fetch(`${BASE}/certificates/1`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const gone = await fake.fetch(`${BASE}/certificates/1`);
    expect(gone.status).toBe(404);
  });

  it("DELETE /certificates/:id unknown → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/certificates/999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /certificates paginates per_page=2 over 5 items (1→2→3→null)", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await createManaged(fake, name, [`${name}.example.com`]);
    }

    const p1 = (await (
      await fake.fetch(`${BASE}/certificates?per_page=2&page=1`)
    ).json()) as {
      certificates: Certificate[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p1.certificates).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p2 = (await (
      await fake.fetch(`${BASE}/certificates?per_page=2&page=2`)
    ).json()) as {
      certificates: Certificate[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p2.certificates).toHaveLength(2);
    expect(p2.meta.pagination.next_page).toBe(3);

    const p3 = (await (
      await fake.fetch(`${BASE}/certificates?per_page=2&page=3`)
    ).json()) as {
      certificates: Certificate[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p3.certificates).toHaveLength(1);
    expect(p3.meta.pagination.next_page).toBeNull();
  });

  it("HttpClient.getAllPages walks /certificates next_page chain to completion", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await createManaged(fake, name, [`${name}.example.com`]);
    }
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const all = await client.getAllPages<Certificate>(
      `${BASE}/certificates?per_page=2`,
      "certificates",
    );
    expect(all.map((c) => c.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("reuses the rate-limit fault hook on a /certificates request (429 + Retry-After)", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 1, retryAfter: 3 });
    const limited = await fake.fetch(`${BASE}/certificates`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3");
    expect((await fake.fetch(`${BASE}/certificates`)).status).toBe(200);
  });

  it("reset() clears certificates, id counter, polls and hooks", async () => {
    const fake = createHetznerHttpFake();
    fake.setManagedIssuanceLatency(5);
    fake.setNextManagedIssuanceLatency(7);
    fake.setNextManagedIssuanceFailure(true);
    await createManaged(fake, "before-reset");
    fake.reset();

    // After reset, ids restart at 1 and default latency is back to 2.
    await createManaged(fake, "after-reset");
    const list = (await (await fake.fetch(`${BASE}/certificates`)).json()) as {
      certificates: Certificate[];
    };
    expect(list.certificates).toHaveLength(1);
    expect(list.certificates[0]!.id).toBe(1);
    expect(list.certificates[0]!.name).toBe("after-reset");

    // Default latency (2) restored — first poll should still be pending.
    const p1 = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(p1.certificate.status.issuance).toBe("pending");
    const p2 = (await (await fake.fetch(`${BASE}/certificates/1`)).json()) as {
      certificate: Certificate;
    };
    expect(p2.certificate.status.issuance).toBe("completed");
  });
});
