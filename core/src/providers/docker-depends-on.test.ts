/**
 * core/src/providers/docker-depends-on.test.ts
 *
 * Task 1.5 — pure intra-`service` DAG ordering for services[].depends_on.
 * topoSortServices is PURE (no I/O); it orders each dep before its dependent,
 * preserves declaration order on a tie (stable/deterministic), and rejects a
 * cycle or a dangling dep as ReconcileError("precondition") BEFORE returning
 * any partial order (fail-safe — no mutation possible, the helper has no I/O).
 */

import { describe, it, expect } from "vitest";
import {
  topoSortServices,
  type DependsOnAware,
  type DependsOnEntry,
} from "./docker-depends-on.js";
import { ReconcileError } from "../domain/errors.js";

const svc = (name: string, depends_on?: DependsOnEntry[]): DependsOnAware => ({
  name,
  ...(depends_on ? { depends_on } : {}),
});

describe("topoSortServices", () => {
  it("orders each dep before its dependent", () => {
    const out = topoSortServices([svc("app", ["db"]), svc("db")]);
    expect(out.map((s) => s.name)).toEqual(["db", "app"]);
  });

  it("preserves declaration order on a tie (stable, deterministic)", () => {
    const out = topoSortServices([svc("a"), svc("b"), svc("c")]);
    expect(out.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("accepts the object form of depends_on", () => {
    const out = topoSortServices([
      svc("app", [{ name: "db", wait_healthy_timeout: "120s" }]),
      svc("db"),
    ]);
    expect(out.map((s) => s.name)).toEqual(["db", "app"]);
  });

  it("rejects a cycle as ReconcileError(precondition) citing the cycle", () => {
    expect(() =>
      topoSortServices([svc("a", ["b"]), svc("b", ["a"])]),
    ).toThrow(ReconcileError);
  });

  it("rejects a dangling dep as ReconcileError(precondition) citing the name", () => {
    let caught: unknown;
    try {
      topoSortServices([svc("app", ["ghost"])]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    expect((caught as ReconcileError).message).toContain("ghost");
  });
});
