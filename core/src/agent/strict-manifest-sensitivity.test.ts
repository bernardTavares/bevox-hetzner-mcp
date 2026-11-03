/**
 * core/src/agent/strict-manifest-sensitivity.test.ts
 *
 * Unit tests for `strictManifestIsSensitive` — the STRICT_MANIFEST_APPROVAL=on
 * sensitivity predicate. Spec
 * docs/specs/2026-05-27-strict-manifest-approval-knob.md §3 (acceptance).
 */

import { describe, it, expect } from "vitest";
import type { PlanItem } from "./../domain/entities.js";
import {
  ownerToolFor,
  strictManifestIsSensitive,
} from "./strict-manifest-sensitivity.js";

function plan(op: PlanItem["op"], entity: string): PlanItem {
  return { op, entity, change: "test", impact: "test" };
}

describe("strictManifestIsSensitive (spec 2026-05-27 §1.2)", () => {
  // ---- "always" policy lifts ----
  it("create server:* → sensitive (provision_server always)", () => {
    expect(strictManifestIsSensitive(plan("create", "server:app-1"))).toBe(true);
  });

  it("destroy server:* → sensitive (destroy always)", () => {
    expect(strictManifestIsSensitive(plan("destroy", "server:app-1"))).toBe(true);
  });

  it("destroy network:* → sensitive (destroy always, op-precedence)", () => {
    expect(strictManifestIsSensitive(plan("destroy", "network:net-a"))).toBe(
      true,
    );
  });

  it("restore volume:* → sensitive (restore always, op-precedence)", () => {
    expect(strictManifestIsSensitive(plan("restore", "volume:pg-data"))).toBe(
      true,
    );
  });

  // ---- "none" policy lifts ----
  it("snapshot volume:* → not sensitive (snapshot none, op-precedence)", () => {
    expect(strictManifestIsSensitive(plan("snapshot", "volume:pg-data"))).toBe(
      false,
    );
  });

  it("create dns:* → not sensitive (set_dns none)", () => {
    expect(strictManifestIsSensitive(plan("create", "dns:zone-a.com.A.www"))).toBe(
      false,
    );
  });

  // ---- "conditional" → falls back to defaultIsSensitive ----
  it("create service:* → not sensitive (deploy_service conditional → default false for create)", () => {
    expect(strictManifestIsSensitive(plan("create", "service:web-1"))).toBe(
      false,
    );
  });

  it("update service:* → not sensitive (conditional → update not in default set)", () => {
    expect(strictManifestIsSensitive(plan("update", "service:web-1"))).toBe(
      false,
    );
  });

  // ---- no dedicated tool → fallback ----
  it("create network:* → not sensitive (no tool → defaultIsSensitive false for create)", () => {
    expect(strictManifestIsSensitive(plan("create", "network:net-a"))).toBe(
      false,
    );
  });

  it("create volume:* → not sensitive (no create tool → default fallback)", () => {
    expect(strictManifestIsSensitive(plan("create", "volume:pg-data"))).toBe(
      false,
    );
  });

  it("noop / drift items → not sensitive (default fallback)", () => {
    expect(strictManifestIsSensitive(plan("noop", "server:app-1"))).toBe(false);
    expect(strictManifestIsSensitive(plan("drift", "server:app-1"))).toBe(false);
  });

  // ---- ownerToolFor mapping (white-box) ----
  it("ownerToolFor: destroy maps to destroy regardless of kind", () => {
    expect(ownerToolFor(plan("destroy", "server:x"))).toBe("destroy");
    expect(ownerToolFor(plan("destroy", "network:x"))).toBe("destroy");
  });

  it("ownerToolFor: server kind → provision_server", () => {
    expect(ownerToolFor(plan("create", "server:x"))).toBe("provision_server");
  });

  it("ownerToolFor: unknown kind → undefined", () => {
    expect(ownerToolFor(plan("create", "weird:x"))).toBeUndefined();
  });
});
