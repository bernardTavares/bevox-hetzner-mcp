/**
 * core/src/providers/http-client.test.ts
 *
 * Task 2.2 — drives the resilient HTTP client contract:
 *   - 429 retry with backoff+jitter, honouring Retry-After
 *   - Hetzner cursor pagination via getAllPages until exhausted
 *   - fatal 401 is NOT retried
 *
 * No real network / no real timers: fetch, sleep and random are injected
 * (constructor dependency seams) so the suite is pure, fast and non-flaky.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "./http-client.js";
import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeUrl = (path: string): string => `https://fake.hetzner.test${path}`;

/** Build a fetch impl that returns the queued responses in order. */
function fetchSequence(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>,
): { fetch: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = (async (_input: unknown, _init?: unknown) => {
    const spec = responses[Math.min(i, responses.length - 1)] ?? {
      status: 200,
    };
    i += 1;
    return new Response(
      spec.body !== undefined ? JSON.stringify(spec.body) : null,
      { status: spec.status, headers: spec.headers },
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => i };
}

// Deterministic seams: no real sleeping, deterministic "jitter".
const noSleep = async (_ms: number): Promise<void> => {};
const fixedRandom = (): number => 0.5;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpClient", () => {
  it("retries 429 with backoff+jitter and respects Retry-After; [429,429,200] → success on 3rd attempt", async () => {
    const { fetch: f, calls } = fetchSequence([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "0" } },
      { status: 200, body: { ok: true } },
    ]);

    const seen: number[] = [];
    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: f,
      sleep: async (ms) => {
        seen.push(ms);
      },
      random: fixedRandom,
    });

    const res = await c.get(fakeUrl("/x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(c.attempts).toBe(3);
    expect(calls()).toBe(3);
    // Retry-After overrides computed backoff: 1000ms then 0ms.
    expect(seen).toEqual([1000, 0]);
  });

  it("follows Hetzner cursor pagination until exhausted (3 pages → flat list)", async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ servers: [1, 2], meta: { pagination: { next_page: 2 } } }),
          { status: 200 },
        );
      }
      if (n === 2) {
        return new Response(
          JSON.stringify({ servers: [3, 4], meta: { pagination: { next_page: 3 } } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ servers: [5], meta: { pagination: { next_page: null } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: impl,
      sleep: noSleep,
      random: fixedRandom,
    });

    const all = await c.getAllPages<number>(fakeUrl("/servers"), "servers");
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(n).toBe(3);
  });

  it("does NOT retry a fatal 401 → attempts === 1", async () => {
    const { fetch: f, calls } = fetchSequence([
      { status: 401, body: { error: { code: "unauthorized" } } },
    ]);

    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: f,
      sleep: noSleep,
      random: fixedRandom,
    });

    await expect(c.get(fakeUrl("/x"))).rejects.toBeInstanceOf(ReconcileError);
    expect(c.attempts).toBe(1);
    expect(calls()).toBe(1);
  });

  it("does NOT retry a non-retryable ReconcileError thrown pre-HTTP → attempts === 1", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw new ReconcileError("fatal", "fatal");
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: impl,
      sleep: noSleep,
      random: fixedRandom,
    });

    await expect(c.get(fakeUrl("/x"))).rejects.toBeInstanceOf(ReconcileError);
    expect(c.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("does not leak the Authorization header into the error message", async () => {
    const { fetch: f } = fetchSequence([{ status: 401, body: {} }]);
    const c = new HttpClient({
      maxRetries: 0,
      baseDelayMs: 1,
      fetchImpl: f,
      sleep: noSleep,
      random: fixedRandom,
      defaultHeaders: { Authorization: "Bearer super-secret-token" },
    });

    try {
      await c.get(fakeUrl("/x"));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as Error).message).not.toContain("super-secret-token");
      expect((e as Error).message).not.toContain("Authorization");
    }
  });

  it("honours Retry-After in HTTP-date form", async () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const { fetch: f } = fetchSequence([
      { status: 429, headers: { "Retry-After": future } },
      { status: 200, body: {} },
    ]);
    const seen: number[] = [];
    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: f,
      sleep: async (ms) => {
        seen.push(ms);
      },
      random: fixedRandom,
    });

    const res = await c.get(fakeUrl("/x"));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // ~2000ms in the future; allow scheduling slack.
    expect(seen[0]).toBeGreaterThan(500);
    expect(seen[0]).toBeLessThanOrEqual(2000);
  });

  it("caps retries at maxRetries then throws the classified error", async () => {
    const { fetch: f, calls } = fetchSequence([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);
    const c = new HttpClient({
      maxRetries: 2,
      baseDelayMs: 1,
      fetchImpl: f,
      sleep: noSleep,
      random: fixedRandom,
    });

    await expect(c.get(fakeUrl("/x"))).rejects.toMatchObject({
      errorClass: "transient",
    });
    // initial + 2 retries
    expect(c.attempts).toBe(3);
    expect(calls()).toBe(3);
  });

  it("clamps an honored Retry-After to maxDelayMs (hostile far value)", async () => {
    const { fetch: f } = fetchSequence([
      { status: 429, headers: { "Retry-After": "999999" } },
      { status: 200, body: {} },
    ]);
    const seen: number[] = [];
    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 50,
      fetchImpl: f,
      sleep: async (ms) => {
        seen.push(ms);
      },
      random: fixedRandom,
    });

    const res = await c.get(fakeUrl("/x"));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(50);
  });

  it("honors Retry-After: 0 as an exact sleep(0), not nullish fallback", async () => {
    const { fetch: f } = fetchSequence([
      { status: 429, headers: { "Retry-After": "0" } },
      { status: 200, body: {} },
    ]);
    const seen: number[] = [];
    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 999,
      maxDelayMs: 30_000,
      fetchImpl: f,
      sleep: async (ms) => {
        seen.push(ms);
      },
      random: fixedRandom,
    });

    const res = await c.get(fakeUrl("/x"));
    expect(res.status).toBe(200);
    expect(seen).toEqual([0]);
  });

  it("per-call timeout: a never-resolving fetch is ABORTED and surfaces transient/retryable (never fatal)", async () => {
    // A fetch that never resolves on its own — it ONLY settles if its
    // AbortSignal fires. No real timer: the injected `startTimeout` IS the
    // deadline clock; invoking the captured callback == the deadline elapsing.
    let abortedCount = 0;
    const pendingTimers: Array<() => void> = [];
    const impl = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () => {
            abortedCount += 1;
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          });
        }
      });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      maxRetries: 1,
      baseDelayMs: 1,
      timeoutMs: 5_000,
      fetchImpl: impl,
      sleep: noSleep, // backoff between the 2 attempts — instant, no real time
      // Deterministic deadline seam: capture each armed timeout's callback so
      // the test fires it exactly when it wants (zero real timers).
      startTimeout: (_ms: number, onElapsed: () => void) => {
        pendingTimers.push(onElapsed);
        return () => {
          /* cancel — no-op for the test */
        };
      },
      random: fixedRandom,
    });

    const p = c.get(fakeUrl("/hang"));
    // Drain timers as attempts arm them: initial attempt + 1 retry. Each
    // fired timer aborts that attempt's in-flight fetch deterministically.
    while (abortedCount < 2) {
      const next = pendingTimers.shift();
      if (next) next();
      // Yield so the rejected fetch flows through request()'s retry loop and
      // arms the next attempt's timeout before we drain again.
      await Promise.resolve();
      await Promise.resolve();
    }

    await expect(p).rejects.toMatchObject({ errorClass: "transient" });
    const err: unknown = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReconcileError);
    const re = err as ReconcileError;
    expect(re.retryable).toBe(true); // transient ⇒ retry/breaker may retry
    expect(re.errorClass).not.toBe("fatal");
    // The in-flight fetch was actually aborted (no hang) — once per attempt.
    expect(abortedCount).toBe(2); // initial + 1 retry
    expect(c.attempts).toBe(2);
  });

  it("per-call timeout does NOT fire when the response arrives in time (default unaffected)", async () => {
    const { fetch: f } = fetchSequence([{ status: 200, body: { ok: 1 } }]);
    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      // generous default timeout; a healthy fast response must be untouched
      fetchImpl: f,
      sleep: noSleep,
      random: fixedRandom,
    });
    const res = await c.get(fakeUrl("/ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(c.attempts).toBe(1);
  });

  it("getAllPages: a 200 page with non-JSON body stays in the ReconcileError taxonomy", async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ servers: [1], meta: { pagination: { next_page: 2 } } }),
          { status: 200 },
        );
      }
      return new Response("not json", { status: 200 });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      maxRetries: 3,
      baseDelayMs: 1,
      fetchImpl: impl,
      sleep: noSleep,
      random: fixedRandom,
    });

    await expect(
      c.getAllPages<number>(fakeUrl("/servers"), "servers"),
    ).rejects.toBeInstanceOf(ReconcileError);
    try {
      await c.getAllPages<number>(fakeUrl("/servers"), "servers");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("transient");
    }
  });
});
