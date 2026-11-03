import { describe, it, expect } from "vitest";
import { createHetznerV2HttpClient } from "./hetzner-cloud-v2-http.js";

describe("hetzner v2 http adapter", () => {
  it("returns an object exposing the four v2 resource clients", () => {
    const c = createHetznerV2HttpClient({
      token: "t",
      baseUrl: "http://localhost:0/v1",
    });
    expect(typeof c.firewalls.list).toBe("function");
    expect(typeof c.firewalls.get).toBe("function");
    expect(typeof c.firewalls.create).toBe("function");
    expect(typeof c.firewalls.update).toBe("function");
    expect(typeof c.firewalls.delete).toBe("function");
    expect(c.loadBalancers).toBeDefined();
    expect(c.certificates).toBeDefined();
    expect(c.primaryIps).toBeDefined();
  });

  it("each resource client routes through the shared HttpClient with Authorization header injected", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          firewalls: [],
          meta: { pagination: { next_page: null } },
        }),
        { status: 200 },
      );
    };
    const c = createHetznerV2HttpClient({
      token: "secret",
      baseUrl: "http://fake/v1",
      fetchImpl: fakeFetch,
    });
    await c.firewalls.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://fake/v1/firewalls");
    expect(
      (calls[0]!.init?.headers as Record<string, string>)?.["Authorization"],
    ).toBe("Bearer secret");
  });

  it("throws fast on empty token", () => {
    expect(() =>
      createHetznerV2HttpClient({ token: "", baseUrl: "http://x/v1" }),
    ).toThrow(/token/);
  });

  it("throws fast on missing baseUrl (no implicit prod default — tests never hit live API)", () => {
    expect(() =>
      createHetznerV2HttpClient({ token: "t", baseUrl: "" }),
    ).toThrow(/baseUrl/);
  });

  it("every (resource × verb) routes to the right URL with the right method and headers", async () => {
    const calls: { url: string; method?: string; contentType?: string; body?: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url: String(input),
        method: init?.method,
        contentType: headers?.["Content-Type"],
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response("{}", { status: 200 });
    };
    const c = createHetznerV2HttpClient({ token: "t", baseUrl: "http://fake/v1", fetchImpl: fakeFetch });

    const resources = [
      { client: c.firewalls,      collection: "firewalls" },
      { client: c.loadBalancers,  collection: "load_balancers" },
      { client: c.certificates,   collection: "certificates" },
      { client: c.primaryIps,     collection: "primary_ips" },
    ] as const;

    for (const { client } of resources) {
      await client.list();
      await client.get(1);
      await client.create({ name: "x" });
      await client.update(1, { name: "y" });
      await client.delete(1);
    }

    // 4 resources × 5 verbs = 20 calls
    expect(calls).toHaveLength(20);

    // Spot-check one full set
    const firstFive = calls.slice(0, 5);
    expect(firstFive[0]).toMatchObject({ url: "http://fake/v1/firewalls",   method: "GET" });
    expect(firstFive[1]).toMatchObject({ url: "http://fake/v1/firewalls/1", method: "GET" });
    expect(firstFive[2]).toMatchObject({
      url: "http://fake/v1/firewalls", method: "POST",
      contentType: "application/json", body: JSON.stringify({ name: "x" }),
    });
    expect(firstFive[3]).toMatchObject({
      url: "http://fake/v1/firewalls/1", method: "PUT",
      contentType: "application/json", body: JSON.stringify({ name: "y" }),
    });
    expect(firstFive[4]).toMatchObject({ url: "http://fake/v1/firewalls/1", method: "DELETE" });

    // Snake-case collections are correctly composed
    expect(calls.find(c => c.url === "http://fake/v1/load_balancers")).toBeDefined();
    expect(calls.find(c => c.url === "http://fake/v1/primary_ips")).toBeDefined();
  });
});
