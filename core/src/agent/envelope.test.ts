/**
 * core/src/agent/envelope.test.ts
 *
 * Oracle test for the WriteEnvelope builders.
 *
 * The FROZEN console contract (console/src/api/contract.ts) is imported
 * directly as the downstream truth oracle — the exact precedent set by
 * src/domain/entities.test.ts (no vendored snapshot in this repo; the oracle
 * is the live console schema). Every builder output MUST parse against
 * WriteEnvelopeSchema without throwing.
 */

import { describe, expect, it } from "vitest";
import {
  WriteEnvelopeSchema,
  type WriteEnvelope as ContractWriteEnvelope,
} from "../../../console/src/api/contract.js"; // downstream oracle
import { ReconcileError } from "../domain/errors.js";
import type { PlanItem } from "../domain/entities.js";
import { applied, error, pendingApproval, planned } from "./envelope.js";

const PLAN: PlanItem[] = [
  { op: "create", entity: "server:app-1", change: "create cx22", impact: "new server" },
  { op: "update", entity: "service:web", change: "image bump", impact: "rolling restart" },
];

describe("WriteEnvelope builders ↔ frozen console contract", () => {
  it("planned() parses against WriteEnvelopeSchema and carries a non-empty contract-shaped plan", () => {
    const env = planned(PLAN);
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.status).toBe("planned");
    expect(parsed.plan).toEqual(PLAN);
    expect(parsed.plan?.length).toBeGreaterThan(0);
  });

  it("pendingApproval() parses and carries an approval_id in the contract's apr_ format", () => {
    const env = pendingApproval("apr_01J9X2K7Qf");
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.status).toBe("pending_approval");
    expect(parsed.approval_id).toMatch(/^apr_/);
  });

  it("applied() parses against WriteEnvelopeSchema", () => {
    const env = applied();
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.status).toBe("applied");
    expect(parsed.plan).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  it("error() forwards a transient ReconcileError → retryable:true contract ApiError", () => {
    const re = new ReconcileError("transient", "rate limited by upstream", {
      entity: "server:app-1",
    });
    const env = error(re);
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toEqual({
      code: "transient",
      message: "rate limited by upstream",
      retryable: true,
      entity: "server:app-1",
    });
  });

  it("error() forwards a fatal ReconcileError → retryable:false contract ApiError", () => {
    const re = new ReconcileError("fatal", "bad credentials", { entity: "network:mesh" });
    const env = error(re);
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.error?.retryable).toBe(false);
    expect(parsed.error?.code).toBe("fatal");
  });

  it("error() accepts an already-built ApiError unchanged", () => {
    const apiErr = { code: "conflict", message: "drift detected", retryable: false, entity: "dns:a" };
    const env = error(apiErr);
    const parsed = WriteEnvelopeSchema.parse(env);
    expect(parsed.error).toEqual(apiErr);
  });

  it("error() message must not leak the ReconcileError cause/stack", () => {
    const re = new ReconcileError("fatal", "auth failure", {
      entity: "server:x",
      cause: new Error("SECRET_TOKEN=abc123"),
    });
    const env = error(re);
    expect(JSON.stringify(env)).not.toContain("SECRET_TOKEN");
  });

  it("next is passthrough — present on the value, stripped by the lenient schema parse", () => {
    const next = { hint: "poll GET /api/approvals" };
    const env = pendingApproval("apr_xyz", next);
    expect(env.next).toEqual(next);
    // WriteEnvelopeSchema is a non-strict z.object: it strips unknown keys
    // rather than rejecting, so `next` survives on the builder output but is
    // intentionally NOT part of the parsed/validated contract surface.
    const parsed = WriteEnvelopeSchema.parse(env) as ContractWriteEnvelope & {
      next?: unknown;
    };
    expect(parsed.next).toBeUndefined();
  });
});
