# Reference: fake-pattern

Annotated template and a real excerpt from the repo. Read this alongside
`SKILL.md`.

## 1. Annotated template

```typescript
/**
 * core/test/fakes/<name>.ts
 *
 * In-memory, per-instance fake of <SERVICE>. Its sole job is to be a
 * deterministic `fetchImpl` seam for HttpClient so the reconciler /
 * provider can exercise its translation, pagination-walking and error-
 * class mapping with ZERO network, DB or filesystem.
 *
 * NOT a spec-faithful emulator — models only the MINIMAL surface that
 * production code parses. Anything else is YAGNI.
 *
 * Design principles (mirror core/test/fakes/hetzner-http.ts):
 *   - PER-INSTANCE. `createMyFake()` returns a fresh isolated instance;
 *     state and id counters live in a closure. `reset()` returns it to
 *     pristine — each test gets full isolation.
 *   - WIRE-COMPATIBLE. `fetch` is a real `(input, init?) => Promise<Response>`
 *     handler usable directly as HttpClient's `fetchImpl`.
 *   - DETERMINISTIC FAULTS. Rate-limit (N × 429 + Retry-After), sticky 401,
 *     one-shot next-request fault. Consumed predictably.
 */

// --- 1) Public shape -------------------------------------------------------
//
// The ONLY surface tests are allowed to touch. Adding methods here is an
// API change — review accordingly.

export interface MyFake {
  /** Drop-in `fetchImpl` for HttpClient — never touches the network. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  /** Clear all resources, id counters and pending faults. */
  reset(): void;

  /** Next `times` responses → 429 with `Retry-After: <retryAfter>` (seconds). */
  setRateLimitFault(opts: { times: number; retryAfter: number }): void;

  /** While true, every response → 401 (fatal, not retried by HttpClient). */
  setAuthFault(on: boolean): void;

  /** One-shot custom error consumed by the very next request. */
  setNextRequestFault(opts: { status: number; code: string; message: string }): void;
}

// --- 2) Resource model -----------------------------------------------------
//
// Only fields production parses. If a Zod schema in src/domain/ doesn't
// reference a field, the field does not exist here.

interface MyResource {
  id: number;
  name: string;
  labels: Record<string, string>;
  created: string;
}

// --- 3) Factory ------------------------------------------------------------

export function createMyFake(): MyFake {
  // Per-instance state. NO module-level mutable state anywhere in this file.
  let resources = new Map<number, MyResource>();
  let seq = 0;
  let rateLimit: { remaining: number; retryAfter: number } | null = null;
  let authFault = false;
  let nextFault: { status: number; code: string; message: string } | null = null;

  function reset(): void {
    resources = new Map();
    seq = 0;
    rateLimit = null;
    authFault = false;
    nextFault = null;
  }

  // ----- helpers (closed-over) --------------------------------------------

  function json(body: unknown, status: number): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function err(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
  }

  function parseBody(init: RequestInit | undefined): Record<string, unknown> | Response {
    try {
      return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      return err(400, "invalid_input", "malformed JSON body");
    }
  }

  // ----- fault gate (runs BEFORE routing) ----------------------------------

  function maybeFault(): Response | null {
    if (authFault) return err(401, "unauthorized", "auth fault");
    if (nextFault) {
      const f = nextFault;
      nextFault = null;
      return err(f.status, f.code, f.message);
    }
    if (rateLimit && rateLimit.remaining > 0) {
      rateLimit.remaining -= 1;
      return new Response(
        JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(rateLimit.retryAfter),
          },
        },
      );
    }
    return null;
  }

  // ----- pagination (Hetzner-style; mirror upstream exactly) ---------------

  function clampInt(raw: string | null, fallback: number): number {
    const n = raw === null ? fallback : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function listResponse(url: URL): Response {
    const all = [...resources.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const nextPage = page < lastPage ? page + 1 : null;
    return json(
      {
        resources: slice,
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: nextPage,
            last_page: lastPage,
            total_entries: all.length,
          },
        },
      },
      200,
    );
  }

  // ----- routing -----------------------------------------------------------

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    const fault = maybeFault();
    if (fault) return fault;

    // Match on trailing path segments — host / version-prefix irrelevant.
    const segs = url.pathname.split("/").filter(Boolean);
    const tail = segs[segs.length - 1] ?? "";

    if (method === "GET" && tail === "resources") return listResponse(url);

    if (method === "POST" && tail === "resources") {
      const body = parseBody(init);
      if (body instanceof Response) return body;
      seq += 1;
      const resource: MyResource = {
        id: seq,
        name: String(body["name"] ?? ""),
        labels: (body["labels"] as Record<string, string> | undefined) ?? {},
        created: new Date().toISOString(),
      };
      resources.set(seq, resource);
      return json({ resource }, 201);
    }

    return err(404, "not_found", `unhandled ${method} ${url.pathname}`);
  }

  return {
    fetch: fetchImpl,
    reset,
    setRateLimitFault: (opts) => {
      rateLimit = { remaining: opts.times, retryAfter: opts.retryAfter };
    },
    setAuthFault: (on) => {
      authFault = on;
    },
    setNextRequestFault: (opts) => {
      nextFault = opts;
    },
  };
}
```

## 2. Sibling test template

```typescript
// core/test/fakes/<name>.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createMyFake, type MyFake } from "./<name>.js";

describe("<name> fake", () => {
  let fake: MyFake;
  beforeEach(() => {
    fake = createMyFake();
  });

  it("is per-instance: two fakes do not share state", async () => {
    const a = createMyFake();
    const b = createMyFake();
    await a.fetch("https://x/resources", {
      method: "POST",
      body: JSON.stringify({ name: "one" }),
    });
    const resB = await b.fetch("https://x/resources");
    expect((await resB.json()).resources).toEqual([]);
  });

  it("reset() clears resources and counters", async () => {
    await fake.fetch("https://x/resources", {
      method: "POST",
      body: JSON.stringify({ name: "one" }),
    });
    fake.reset();
    const res = await fake.fetch("https://x/resources");
    const body = await res.json();
    expect(body.resources).toEqual([]);
    expect(body.meta.pagination.total_entries).toBe(0);
  });

  it("rate-limit fault: exactly N × 429 then normal", async () => {
    fake.setRateLimitFault({ times: 2, retryAfter: 1 });
    const a = await fake.fetch("https://x/resources");
    const b = await fake.fetch("https://x/resources");
    const c = await fake.fetch("https://x/resources");
    expect(a.status).toBe(429);
    expect(a.headers.get("Retry-After")).toBe("1");
    expect(b.status).toBe(429);
    expect(c.status).toBe(200);
  });

  it("auth fault: sticky 401 until toggled off", async () => {
    fake.setAuthFault(true);
    expect((await fake.fetch("https://x/resources")).status).toBe(401);
    expect((await fake.fetch("https://x/resources")).status).toBe(401);
    fake.setAuthFault(false);
    expect((await fake.fetch("https://x/resources")).status).toBe(200);
  });

  it("next-request fault is one-shot", async () => {
    fake.setNextRequestFault({ status: 422, code: "invalid_input", message: "nope" });
    expect((await fake.fetch("https://x/resources")).status).toBe(422);
    expect((await fake.fetch("https://x/resources")).status).toBe(200);
  });

  it("pagination terminates on next_page: null", async () => {
    const res = await fake.fetch("https://x/resources?per_page=10&page=1");
    expect((await res.json()).meta.pagination.next_page).toBeNull();
  });
});
```

## 3. Real excerpt from the repo

Verbatim from `core/test/fakes/hetzner-http.ts` (header + public interface).
This is the load-bearing contract; the template above is its generalization.

```typescript
/**
 * core/test/fakes/hetzner-http.ts
 *
 * In-memory, per-instance fake of the Hetzner Cloud HTTP API. Its sole job is
 * to be a deterministic `fetchImpl` seam for HttpClient (2.2) and
 * HetznerCloudProvider (2.4) so the reconciler's translation/convergence logic
 * can be exercised in-process with ZERO network, DB or filesystem.
 *
 * Design principles (mirrors core/test/fakes/pg-harness.ts isolation
 * philosophy):
 *
 *   - PER-INSTANCE, RESETTABLE. `createHetznerHttpFake()` returns a fresh
 *     isolated instance; state and id counters live in a closure (no
 *     global/static state). `reset()` returns it to pristine — each test
 *     gets full isolation.
 *
 *   - WIRE-COMPATIBLE. `fetch` is a real `(input, init?) => Promise<Response>`
 *     handler usable directly as HttpClient's `fetchImpl`. List responses
 *     emit Hetzner's exact `meta.pagination.next_page` shape so
 *     HttpClient.getAllPages walks them and terminates on `null`.
 *
 *   - DETERMINISTIC FAULTS. `setRateLimitFault` makes the next N responses a
 *     429 with `Retry-After`; `setAuthFault` forces 401 until toggled off.
 *     Both are per-instance and consumed predictably.
 */

export interface HetznerHttpFake {
  /** Drop-in `fetchImpl` for HttpClient — never touches the network. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Clear all resources, id counters and pending faults. */
  reset(): void;
  /** Next `times` responses → 429 with `Retry-After: <retryAfter>` (seconds). */
  setRateLimitFault(opts: { times: number; retryAfter: number }): void;
  /** While true, every response → 401 (fatal, not retried by HttpClient). */
  setAuthFault(on: boolean): void;
  setNextRequestFault(opts: { status: number; code: string; message: string }): void;
  // ... plus per-fake test-only escape hatches (e.g. firewalls.injectExtraRule)
  // documented in-file as "Read-only escape hatch — production code MUST NOT
  // depend on this surface."
}
```

## 4. Sub-store split (when the fake outgrows one file)

When a single fake passes the ~600-line soft limit (CONTRIBUTING §"Code
style"), split per-resource sub-stores under `core/test/fakes/<name>-v2/`.
The parent owns faults and `reset()`; sub-stores own routing + state for
their resource.

Real example: `core/test/fakes/hetzner-http-v2/firewalls.ts` exports
`createFirewallStore()` returning `{ handle(url, method, init), reset(),
injectExtraRule(...) }`. The parent `hetzner-http.ts` constructs the
sub-store inside its factory closure and calls `firewallStore.reset()`
from its own `reset()`. Faults stay in the parent and run BEFORE
delegation — sub-stores are purely routing + state.

Reference files:

- `core/test/fakes/hetzner-http.ts` (parent + delegation)
- `core/test/fakes/hetzner-http-v2/firewalls.ts` (sub-store)
- `core/test/fakes/hetzner-http-v2/load-balancers.ts`
- `core/test/fakes/hetzner-http-v2/certificates.ts`
- `core/test/fakes/hetzner-http-v2/primary-ips.ts`
