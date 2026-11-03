/**
 * core/src/agent/capability.test.ts
 *
 * TDD tests for the pure capability model (capability.ts).
 *
 * Verified properties:
 *   1. The tool vocabulary is exactly the 12 spec tools.
 *   2. hasCapability is true iff the tool is in the credential's set
 *      (superset/subset semantics: Vox ⊇ destroy; runner ⊂ deploy_service).
 *   3. assertCapability returns silently for an in-scope tool.
 *   4. assertCapability throws ReconcileError("fatal") for an out-of-scope
 *      tool — the authz/non-recoverable class (errors.ts 401/403 == fatal).
 *   5. The thrown error → contract ApiError has code "fatal", retryable:false.
 *   6. The denial message names the denied tool but does NOT enumerate the
 *      credential's full capability set (no escalation aid / no secret leak).
 *   7. A credential cannot be fabricated downstream: a plain object claiming
 *      capabilities is NOT a VerifiedCredential (brand is module-private);
 *      assertCapability rejects an unbranded object as fatal.
 *   8. effectiveScope(cred) yields a stable, recordable scope string.
 *   9. Module surface is minimal — only the documented exports.
 */

import { describe, it, expect } from "vitest";
import * as cap from "./capability.js";
import { ReconcileError } from "../domain/errors.js";

// A "verified" credential may only be minted via the auth boundary; tests use
// the test-only mint exported by capability.ts for the trust seam (auth.ts is
// exercised separately in auth.test.ts).
const vox = cap.__mintVerifiedCredentialForTest("vox", cap.ALL_TOOLS);
const runner = cap.__mintVerifiedCredentialForTest("runner-7", [
  "deploy_service",
  "scale_service",
  "get_state",
]);

describe("tool vocabulary", () => {
  it("ALL_TOOLS is exactly the 12 spec tools", () => {
    expect([...cap.ALL_TOOLS].sort()).toEqual(
      [
        "get_state",
        "diff",
        "events",
        "health",
        "provision_server",
        "deploy_service",
        "scale_service",
        "set_dns",
        "snapshot",
        "restore",
        "destroy",
        "apply_manifest",
      ].sort(),
    );
  });
});

describe("hasCapability — superset/subset semantics", () => {
  it("Vox (superset) has destroy", () => {
    expect(cap.hasCapability(vox, "destroy")).toBe(true);
  });

  it("runner (subset) has deploy_service but NOT destroy", () => {
    expect(cap.hasCapability(runner, "deploy_service")).toBe(true);
    expect(cap.hasCapability(runner, "destroy")).toBe(false);
  });
});

describe("assertCapability", () => {
  it("returns silently for an in-scope tool", () => {
    expect(() => cap.assertCapability(runner, "deploy_service")).not.toThrow();
  });

  it("throws ReconcileError('fatal') for an out-of-scope tool", () => {
    try {
      cap.assertCapability(runner, "destroy");
      throw new Error("expected assertCapability to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });

  it("denial maps to a fatal, non-retryable contract ApiError", () => {
    try {
      cap.assertCapability(runner, "destroy");
      throw new Error("expected throw");
    } catch (e) {
      const api = (e as ReconcileError).toApiError();
      expect(api.code).toBe("fatal");
      expect(api.retryable).toBe(false);
    }
  });

  it("denial message names the denied tool but NOT the full capability set", () => {
    try {
      cap.assertCapability(runner, "destroy");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as ReconcileError).message;
      expect(msg).toContain("destroy");
      // must NOT leak the other capabilities the credential holds
      expect(msg).not.toContain("deploy_service");
      expect(msg).not.toContain("scale_service");
      expect(msg).not.toContain("get_state");
    }
  });

  it("rejects an unbranded plain object claiming capabilities (cannot forge)", () => {
    const forged = {
      actor: "evil",
      capabilities: new Set(["destroy"]),
    } as unknown as cap.VerifiedCredential;
    try {
      cap.assertCapability(forged, "destroy");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });
});

describe("actorOf — brand-guarded audit-identity accessor", () => {
  it("returns the actor for a genuine verified credential", () => {
    expect(cap.actorOf(runner)).toBe("runner-7");
  });

  it("rejects a fabricated/plain object as fatal (cannot inject an audit identity)", () => {
    const forged = {
      actor: "evil",
      capabilities: new Set(["destroy"]),
    } as unknown as cap.VerifiedCredential;
    try {
      cap.actorOf(forged);
      throw new Error("expected actorOf to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });
});

describe("effectiveScope", () => {
  it("is a stable, non-empty, recordable string for an allowed credential", () => {
    const s = cap.effectiveScope(vox);
    expect(typeof s).toBe("string");
    expect(s.trim().length).toBeGreaterThan(0);
    // deterministic
    expect(cap.effectiveScope(vox)).toBe(s);
  });

  it("encodes the actor and the granted set (order-independent)", () => {
    const s = cap.effectiveScope(runner);
    expect(s).toContain("runner-7");
    expect(s).toContain("deploy_service");
  });

  it("is EXACTLY the deterministic sorted form (pins the 4.6 scope contract)", () => {
    // Capabilities sorted lexicographically regardless of grant order; this
    // exact-equality pin catches a capability-reordering regression that a
    // toContain assertion would miss.
    expect(cap.effectiveScope(runner)).toBe(
      "agent:runner-7 caps:[deploy_service,get_state,scale_service]",
    );
  });

  it("fails CLOSED: throws fatal for a fabricated/unbranded credential", () => {
    const forged = {
      actor: "evil",
      capabilities: new Set(["destroy"]),
    } as unknown as cap.VerifiedCredential;
    try {
      cap.effectiveScope(forged);
      throw new Error("expected effectiveScope to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });
});

describe("minimal module surface", () => {
  it("does NOT export a public credential constructor", () => {
    const r = cap as Record<string, unknown>;
    expect(r["createVerifiedCredential"]).toBeUndefined();
    expect(r["VerifiedCredential"]).toBeUndefined(); // type-only, not runtime
  });
});

describe("V2_TOOLS — v2 additive vocabulary", () => {
  it("V2_TOOLS length is 10 and includes run_migrations + kubectl_apply + ensure_k3s", () => {
    expect(cap.V2_TOOLS).toHaveLength(10);
    expect([...cap.V2_TOOLS]).toContain("run_migrations");
    expect([...cap.V2_TOOLS]).toContain("kubectl_apply");
    expect([...cap.V2_TOOLS]).toContain("ensure_k3s");
  });
  it("ALL_TOOLS is still exactly the 12 spec tools (FROZEN)", () => {
    expect(cap.ALL_TOOLS).toHaveLength(12);
  });
  it("mintVerifiedCredential grants the kubectl_apply v2 cap (and only it)", () => {
    // Bloco E Task 14 — the kubectl_apply v2 capability is mintable and
    // filters into the v2 vocabulary, NOT the FROZEN 12 (`ALL_TOOLS` stays 12).
    const c = cap.__mintVerifiedCredentialForTest("agent:x", ["kubectl_apply"]);
    expect(cap.hasV2Capability(c, "kubectl_apply")).toBe(true);
    // No v1 cap leaked in; the FROZEN lock holds.
    expect(c.capabilities.size).toBe(0);
    expect(cap.ALL_TOOLS).toHaveLength(12);
  });
  it("mintVerifiedCredential grants the ensure_k3s v2 cap (and only it)", () => {
    // Bloco E Task 23 — the ensure_k3s v2 capability is mintable and filters
    // into the v2 vocabulary, NOT the FROZEN 12 (`ALL_TOOLS` stays 12).
    const c = cap.__mintVerifiedCredentialForTest("agent:x", ["ensure_k3s"]);
    expect(cap.hasV2Capability(c, "ensure_k3s")).toBe(true);
    // No v1 cap leaked in; the FROZEN lock holds.
    expect(c.capabilities.size).toBe(0);
    expect(cap.ALL_TOOLS).toHaveLength(12);
  });
});
