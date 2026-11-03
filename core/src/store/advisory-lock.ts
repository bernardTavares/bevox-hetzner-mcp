/**
 * core/src/store/advisory-lock.ts
 *
 * Per-scope PostgreSQL session advisory lock.
 *
 * Design:
 * - One dedicated pg client is checked out for the lock's entire lifetime.
 *   Session-scoped advisory locks are bound to the connection — they MUST be
 *   acquired and released on the same client. Using pool.query() is WRONG
 *   because it may route acquire and release to different clients.
 * - pg_try_advisory_lock — non-blocking tryLock semantics. Returns true if
 *   acquired, false if already held by another session (second concurrent
 *   same-scope call → { acquired: false } without running fn).
 * - pg_advisory_unlock — always called in `finally` to guarantee no lock leak.
 *   The client is also released in `finally` to prevent pool exhaustion.
 * - scopeLockKey maps any string scope into [0, 8_999_999_999] (the reconcile
 *   lock partition). It MUST NOT produce values in [9_000_000_000, 9_999_999_999]
 *   (migration lock partition). See db.ts advisory-key partition contract.
 *
 * Key hash algorithm:
 *   djb2-style unsigned 32-bit hash → BigInt → mod RECONCILE_LOCK_RANGE
 *   Effective key space is 2^32 (~4.29e9); the modulo is a safety/future-proof
 *   guard that keeps keys in [0, 8_999_999_999] even if the hash widens later.
 *   This gives a stable, deterministic mapping with low collision probability
 *   for typical scope strings, and always lands in [0, 8_999_999_999].
 */

import type pg from "pg";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Upper bound (exclusive) for the reconcile-lock range.
 * Reconcile locks: [0, RECONCILE_LOCK_RANGE)
 * Migration locks: [9_000_000_000, 9_999_999_999]
 */
const RECONCILE_LOCK_RANGE = 9_000_000_000n;

// ---------------------------------------------------------------------------
// scopeLockKey — deterministic hash into [0, 8_999_999_999]
// ---------------------------------------------------------------------------

/**
 * Maps a scope string to a deterministic pg advisory lock key in
 * [0, 8_999_999_999].
 *
 * Uses a djb2-style unsigned 32-bit hash (widely used, stable, no runtime
 * deps). The effective key space is 2^32 (~4.29e9 distinct values); the
 * `% RECONCILE_LOCK_RANGE` modulo is a safety/future-proof guard that keeps
 * keys in the reserved reconcile range [0, 8_999_999_999] (never the migration
 * range [9_000_000_000, 9_999_999_999] per db.ts MIGRATION_LOCK_KEY contract)
 * even if the hash algorithm is ever widened to 64-bit.
 *
 * Collision note: for realistic scope cardinality (≤ ~100 scopes) the
 * birthday-collision probability is <1e-6 (acceptable; a collision only causes
 * one scope to needlessly block another — availability impact, not data loss).
 * Upgrade path if cardinality ever reaches tens of thousands: replace with
 * 64-bit FNV-1a BigInt within the same modulo guard.
 *
 * Same input → same key (deterministic).
 * Output range: [0n, 8_999_999_999n] — guaranteed by construction.
 */
export function scopeLockKey(scope: string): bigint {
  // djb2 hash over UTF-16 code units — stable across Node versions
  let hash = 5381;
  for (let i = 0; i < scope.length; i++) {
    // >>> 0 keeps the result in 32-bit unsigned integer range
    hash = ((hash * 33) ^ scope.charCodeAt(i)) >>> 0;
  }
  // hash is now in [0, 2^32 - 1]; effective key space is 2^32 (~4.29e9).
  // BigInt(hash) is in [0n, 4_294_967_295n].
  // % RECONCILE_LOCK_RANGE keeps result in [0n, 8_999_999_999n] even if the
  // hash widens later (safety guard — currently a no-op for 32-bit values).
  return BigInt(hash) % RECONCILE_LOCK_RANGE;
}

// ---------------------------------------------------------------------------
// withScopeLock — acquire, run fn, release in finally
// ---------------------------------------------------------------------------

/** Returned when the lock was acquired and fn ran successfully. */
export interface LockAcquired<T> {
  acquired: true;
  result: T;
}

/** Returned when the lock was already held by another session. fn is NOT run. */
export interface LockNotAcquired {
  acquired: false;
}

export type LockOutcome<T> = LockAcquired<T> | LockNotAcquired;

/**
 * Acquires a SESSION-level pg advisory lock for `scope`, runs `fn`, then
 * ALWAYS releases the lock and the dedicated client in `finally`.
 *
 * tryLock semantics:
 *  - If the lock is free → acquire, run fn, return { acquired:true, result }.
 *  - If the lock is already held by another session → return { acquired:false }
 *    WITHOUT running fn. No waiting, no blocking.
 *
 * The same dedicated client is used for both pg_try_advisory_lock and
 * pg_advisory_unlock to honour session-scoped lock semantics (the lock is
 * bound to the connection). pool.query() MUST NOT be used for lock/unlock.
 *
 * If `fn` throws, the error propagates out of withScopeLock AFTER the lock
 * and client are released in `finally`.
 *
 * Consumer note: a { acquired:false } outcome means a reconcile cycle was
 * skipped due to scope contention. The caller (Task 2.7 reconcile) MUST emit
 * an observable signal (StateEvent / log → surfaced in /api/health Task 6.4)
 * — withScopeLock intentionally is NOT an observability layer.
 */
export async function withScopeLock<T>(
  pool: pg.Pool,
  scope: string,
  fn: () => Promise<T>
): Promise<LockOutcome<T>> {
  const key = scopeLockKey(scope);
  // String representation is required because pg's native bigint64 binding
  // is unreliable for large int8 values — passing String(key) matches the
  // ::bigint cast pattern used in db.ts (MIGRATION_LOCK_KEY).
  const keyStr = String(key);

  const client = await pool.connect();
  let caught: unknown;
  try {
    const tryResult = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS pg_try_advisory_lock",
      [keyStr]
    );

    const acquired = tryResult.rows[0]?.pg_try_advisory_lock ?? false;

    if (!acquired) {
      // Lock held elsewhere — return without running fn (no unlock needed)
      return { acquired: false };
    }

    // Lock acquired — run fn, then release in finally
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      // Always unlock on the SAME client (session advisory lock semantics).
      // Ignore errors from unlock: if the connection is broken the lock will
      // be released automatically when the session ends.
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [keyStr])
        .catch(() => undefined);
    }
  } catch (err) {
    caught = err;
    throw err;
  } finally {
    // Pass the caught error so the pool DISCARDS a broken connection instead
    // of recycling it (pg pool.release(err) marks the client as destroyed).
    client.release(caught instanceof Error ? caught : undefined);
  }
}
