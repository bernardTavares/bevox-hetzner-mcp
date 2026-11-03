/**
 * core/src/store/advisory-lock.test.ts
 *
 * TDD tests for advisory-lock.ts — per-scope pg session advisory lock.
 *
 * Verified properties:
 *  1. scopeLockKey(s) is deterministic (same input → same key).
 *  2. scopeLockKey output is ALWAYS in [0, 8_999_999_999] — never in the
 *     migration range [9_000_000_000, 9_999_999_999]. Tests several scopes
 *     including long strings and unicode.
 *  3. withScopeLock(pool, "scope-a", fn) runs fn and returns { acquired:true, result }.
 *  4. While "scope-a" is held (fn awaiting a deferred promise), a SECOND
 *     withScopeLock(pool, "scope-a", fn2) returns { acquired:false } and does
 *     NOT run fn2 — tryLock semantics.
 *  5. Concurrently, withScopeLock(pool, "scope-b", fn3) with a DIFFERENT scope
 *     DOES acquire and run fn3 in parallel — per-scope isolation.
 *  6. After the first lock's fn completes (finally runs), a subsequent
 *     withScopeLock(pool, "scope-a", ...) acquires again — lock is released.
 *  7. If fn throws, the lock is STILL released (finally); a subsequent acquire
 *     on the same scope succeeds; the thrown error propagates out.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as m from "./advisory-lock.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { MIGRATION_LOCK_KEY } from "./db.js";
import type pg from "pg";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
  // Advisory locks are connection-level (no DDL required), but resetSchema
  // ensures a clean slate for DB state and terminates any lingering sessions.
  await resetSchema(pool);
});

afterAll(async () => {
  await closeTestPool();
});

// ---------------------------------------------------------------------------
// Helper — deferred promise (resolves/rejects on demand; no sleeps/timers)
// ---------------------------------------------------------------------------

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 1. scopeLockKey — deterministic + in-range
// ---------------------------------------------------------------------------

describe("scopeLockKey determinism and range", () => {
  const testScopes = [
    "scope-a",
    "scope-b",
    "infra:prod",
    "reconcile/servers/hel1",
    // Long string (> 64 chars)
    "a-very-long-scope-name-that-exceeds-what-one-might-normally-use-as-a-scope-identifier",
    // Unicode
    "プロビジョン:東京",
    "αβγδεζηθ",
    // Edge cases
    "",
    " ",
    "0",
  ];

  it("returns the same key for the same input (deterministic)", () => {
    for (const scope of testScopes) {
      const k1 = m.scopeLockKey(scope);
      const k2 = m.scopeLockKey(scope);
      expect(k1).toBe(k2);
    }
  });

  it("key is ALWAYS >= 0n", () => {
    for (const scope of testScopes) {
      const key = m.scopeLockKey(scope);
      expect(key >= 0n).toBe(true);
    }
  });

  it("key is ALWAYS <= 8_999_999_999n (within reconcile range)", () => {
    for (const scope of testScopes) {
      const key = m.scopeLockKey(scope);
      expect(key <= 8_999_999_999n).toBe(true);
    }
  });

  it("key is NEVER >= 9_000_000_000n (never enters migration range)", () => {
    for (const scope of testScopes) {
      const key = m.scopeLockKey(scope);
      expect(key >= 9_000_000_000n).toBe(false);
    }
  });

  it("key never equals MIGRATION_LOCK_KEY (9_876_543_210n)", () => {
    for (const scope of testScopes) {
      const key = m.scopeLockKey(scope);
      expect(key).not.toBe(MIGRATION_LOCK_KEY);
    }
  });

  it("different scopes may produce different keys (collision resistance)", () => {
    const keys = new Set(["scope-a", "scope-b", "infra:prod"].map(m.scopeLockKey));
    // At minimum, these three distinct scopes should hash to distinct keys
    expect(keys.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. withScopeLock — basic acquire + result
// ---------------------------------------------------------------------------

describe("withScopeLock basic acquire", () => {
  it("runs fn and returns { acquired: true, result } when lock is free", async () => {
    const outcome = await m.withScopeLock(pool, "basic-test", async () => 42);
    expect(outcome).toEqual({ acquired: true, result: 42 });
  });

  it("passes the fn return value (string) through result", async () => {
    const outcome = await m.withScopeLock(
      pool,
      "basic-string",
      async () => "hello"
    );
    expect(outcome).toEqual({ acquired: true, result: "hello" });
  });

  it("passes the fn return value (object) through result", async () => {
    const outcome = await m.withScopeLock(pool, "basic-obj", async () => ({
      x: 1,
    }));
    expect(outcome).toEqual({ acquired: true, result: { x: 1 } });
  });
});

// ---------------------------------------------------------------------------
// 3. tryLock semantics — second same-scope returns { acquired:false }
// ---------------------------------------------------------------------------

describe("tryLock semantics — same scope", () => {
  it("returns { acquired:false } for second concurrent acquire of the same scope", async () => {
    const hold = deferred();
    const acquired = deferred(); // signals the moment the first lock is held
    let fn2Ran = false;

    // First: signals `acquired` immediately after the lock is obtained, then
    // holds until we release `hold`.
    const first = m.withScopeLock(pool, "trylock-scope", async () => {
      acquired.resolve(); // deterministic signal: lock is now held
      await hold.promise;
      return "first-done";
    });

    // Wait until the first fn has confirmed the lock is held — no microtask
    // counting, no timers, no flakiness.
    await acquired.promise;

    // Second: must NOT acquire (same scope, lock still held by first)
    const second = await m.withScopeLock(pool, "trylock-scope", async () => {
      fn2Ran = true;
      return "second-done";
    });

    // Release first
    hold.resolve();
    const firstResult = await first;

    expect(second).toEqual({ acquired: false });
    expect(fn2Ran).toBe(false);
    expect(firstResult).toEqual({ acquired: true, result: "first-done" });
  });
});

// ---------------------------------------------------------------------------
// 4. Per-scope isolation — different scope acquires in parallel
// ---------------------------------------------------------------------------

describe("per-scope isolation — different scopes run in parallel", () => {
  it("scope-b acquires while scope-a is held", async () => {
    const holdA = deferred();
    const acquiredA = deferred(); // signals the moment scope-a's lock is held
    let scopeBRan = false;

    // Start scope-a (signals acquiredA, then holds until holdA is released)
    const lockA = m.withScopeLock(pool, "iso-scope-a", async () => {
      acquiredA.resolve(); // deterministic signal: scope-a lock is now held
      await holdA.promise;
      return "a-done";
    });

    // Wait until scope-a has confirmed the lock is held — deterministic, no
    // microtask counting, no timers, no flakiness.
    await acquiredA.promise;

    // scope-b: different key → must acquire successfully while scope-a is held
    const lockB = await m.withScopeLock(pool, "iso-scope-b", async () => {
      scopeBRan = true;
      return "b-done";
    });

    // Release scope-a
    holdA.resolve();
    const resultA = await lockA;

    expect(lockB).toEqual({ acquired: true, result: "b-done" });
    expect(scopeBRan).toBe(true);
    expect(resultA).toEqual({ acquired: true, result: "a-done" });
  });
});

// ---------------------------------------------------------------------------
// 5. Lock is released after fn completes — re-acquire succeeds
// ---------------------------------------------------------------------------

describe("lock release after fn completes", () => {
  it("a subsequent withScopeLock on the same scope succeeds after previous completes", async () => {
    const first = await m.withScopeLock(pool, "release-test", async () => 1);
    expect(first).toEqual({ acquired: true, result: 1 });

    // Lock must be released now — second call must acquire
    const second = await m.withScopeLock(pool, "release-test", async () => 2);
    expect(second).toEqual({ acquired: true, result: 2 });
  });
});

// ---------------------------------------------------------------------------
// 6. Lock is released when fn throws — re-acquire succeeds; error propagates
// ---------------------------------------------------------------------------

describe("lock released on fn throw", () => {
  it("propagates the thrown error out of withScopeLock", async () => {
    await expect(
      m.withScopeLock(pool, "throw-test", async () => {
        throw new Error("fn-threw");
      })
    ).rejects.toThrow("fn-threw");
  });

  it("lock is released after fn throws — subsequent acquire succeeds", async () => {
    // First call: fn throws
    try {
      await m.withScopeLock(pool, "throw-release-test", async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // Lock must be released; second call must acquire without issue
    const outcome = await m.withScopeLock(
      pool,
      "throw-release-test",
      async () => "recovered"
    );
    expect(outcome).toEqual({ acquired: true, result: "recovered" });
  });
});
