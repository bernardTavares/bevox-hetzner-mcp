/**
 * core/src/agent/v2/working-store.ts
 *
 * Hoisted in F4.4 — the generic v2 working desired-state store shape.
 *
 * F1.4 (firewall) introduced the first `WorkingXStore` interface; F2.4
 * (primary-ip) duplicated it and explicitly deferred the rule-of-three hoist
 * to F4.4 (LoadBalancer). F3.5 (certificate) duplicated it a third time. With
 * F4.4 adding the FOURTH `WorkingXStore` (LoadBalancer), the rule-of-three has
 * long been satisfied; we extract the shape here and re-export thin
 * type-aliases / factories from each set-*.ts module so every existing call
 * site (REST / MCP / contract-v2-conformance / set-*.test.ts) is byte-for-byte
 * unchanged.
 *
 * Contract:
 *   - `get(name)`        — nullable lookup by canonical entity name.
 *   - `put(name, value)` — idempotent put keyed by `name` (the entity's
 *     canonical name; the caller passes both so a put that changed the name
 *     would never silently re-key). Mirrors the F1.4/F2.4/F3.5 shape verbatim.
 *   - `delete(name)`     — idempotent removal.
 *   - `list()`           — deterministic order (sorted by `name` ascending
 *     unless caller supplies a different `sorter`).
 *
 * Open concern carried from F1.4/F2.4/F3.5 review: the working-store-put
 * then StateEvent-append pair is NOT atomic (put can succeed and the append
 * fail). Bloco A keeps the working store in-memory (no durable surface to
 * drift); Bloco C lands a durable backing store and an atomic write seam.
 */

export interface WorkingStore<T extends { name: string }> {
  get(name: string): Promise<T | null>;
  /** Idempotent put. `name` is the canonical key; `value.name` should match. */
  put(name: string, value: T): Promise<void>;
  /** Idempotent removal. */
  delete(name: string): Promise<void>;
  /** Deterministic order — sorted by `name` ascending unless `sorter` supplied. */
  list(): Promise<readonly T[]>;
}

/**
 * Trivial in-memory backing store — the default Bloco-A implementation for
 * every v2 write tool (firewall, primary-ip, certificate, load-balancer).
 */
export function createInMemoryWorkingStore<T extends { name: string }>(
  sorter?: (a: T, b: T) => number,
): WorkingStore<T> {
  const m = new Map<string, T>();
  const cmp =
    sorter ??
    ((a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    async get(name: string): Promise<T | null> {
      return m.get(name) ?? null;
    },
    async put(name: string, value: T): Promise<void> {
      m.set(name, value);
    },
    async delete(name: string): Promise<void> {
      m.delete(name);
    },
    async list(): Promise<readonly T[]> {
      return [...m.values()].sort(cmp);
    },
  };
}
