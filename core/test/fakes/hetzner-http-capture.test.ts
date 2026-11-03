/**
 * core/test/fakes/hetzner-http-capture.test.ts
 *
 * Smoke tests for the createCaptureHetznerHttpFake fixture.
 * Verifies the fake's capture, seeding, and reset behaviour in isolation.
 *
 * Spec: docs/specs/2026-05-27-hetzner-cloud-wire-translation.md §4.4
 */

import { describe, it, expect } from "vitest";
import { createCaptureHetznerHttpFake } from "./hetzner-http-capture.js";

describe("hetzner-http-capture fake", () => {
  it("captures POST /v1/networks body and returns a stable 201 envelope", async () => {
    const fake = createCaptureHetznerHttpFake();
    const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mesh", ip_range: "10.0.0.0/16", subnets: [] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ network: { id: 1, name: "mesh" } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      url: "https://api.hetzner.cloud/v1/networks",
      method: "POST",
      body: { name: "mesh", ip_range: "10.0.0.0/16", subnets: [] },
    });
  });

  it("returns a seeded GET list with Hetzner pagination meta so findByName works", async () => {
    const fake = createCaptureHetznerHttpFake({
      collections: { networks: [{ id: 42, name: "bevox-priv" }] },
    });
    const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks?page=1", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      networks: [{ id: 42, name: "bevox-priv" }],
      meta: { pagination: { next_page: null } },
    });
  });

  it("throws on unhandled methods/paths so leaks fail loud", async () => {
    const fake = createCaptureHetznerHttpFake();
    await expect(
      fake.fetchImpl("https://api.hetzner.cloud/v1/floating_ips", { method: "PUT" })
    ).rejects.toThrow(/unhandled/i);
  });

  it("reset() clears captured requests and id counter", async () => {
    const fake = createCaptureHetznerHttpFake();
    await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
      method: "POST",
      body: JSON.stringify({ name: "a" }),
    });
    fake.reset();
    expect(fake.requests).toHaveLength(0);
    const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
      method: "POST",
      body: JSON.stringify({ name: "b" }),
    });
    const body = await res.json();
    expect(body.network.id).toBe(1); // counter restarted
  });
});
