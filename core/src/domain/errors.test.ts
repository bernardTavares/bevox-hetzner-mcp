// core/src/domain/errors.test.ts
import { describe, it, expect } from "vitest";
import { classify, ReconcileError } from "./errors.js";

// ---------------------------------------------------------------------------
// Prescribed cases (must not be weakened or removed)
// ---------------------------------------------------------------------------

it("maps to the 5 spec classes", () => {
  expect(classify({ httpStatus: 429 })).toBe("transient");
  expect(classify({ httpStatus: 503, code: "timeout" })).toBe("transient");
  expect(classify({ kind: "missing-dependency" })).toBe("precondition");
  expect(classify({ kind: "drift" })).toBe("conflict");
  expect(classify({ httpStatus: 401 })).toBe("fatal");
  expect(classify({ kind: "partial" })).toBe("partial");
});

it("ReconcileError carries class + retryable + entity for the envelope", () => {
  const e = new ReconcileError("transient", "rate limited", { entity: "server:a", retryAfterMs: 1000 });
  expect(e.retryable).toBe(true);
  expect(e.toApiError()).toMatchObject({ code: "transient", retryable: true, entity: "server:a" });
});

// ---------------------------------------------------------------------------
// Additional assertions for completeness
// ---------------------------------------------------------------------------

describe("classify — additional cases", () => {
  it("5xx HTTP statuses are transient", () => {
    expect(classify({ httpStatus: 500 })).toBe("transient");
    expect(classify({ httpStatus: 503 })).toBe("transient");
    expect(classify({ httpStatus: 504 })).toBe("transient");
  });

  it("403 is fatal", () => {
    expect(classify({ httpStatus: 403 })).toBe("fatal");
  });

  it("kind=conflict is conflict", () => {
    expect(classify({ kind: "conflict" })).toBe("conflict");
  });

  it("kind=partial is partial", () => {
    expect(classify({ kind: "partial" })).toBe("partial");
  });

  it("unknown input defaults to fatal (stop-the-cycle safe default)", () => {
    // Unknown errors must NOT silently retry forever — defaulting to fatal
    // halts the reconcile cycle and surfaces the issue for human/agent review.
    expect(classify({})).toBe("fatal");
    expect(classify({ httpStatus: 418 })).toBe("fatal");
    expect(classify({ kind: "unknown-kind" })).toBe("fatal");
  });
});

describe("ReconcileError — additional assertions", () => {
  it("fatal class is not retryable", () => {
    const e = new ReconcileError("fatal", "quota exceeded", { entity: "network:b" });
    expect(e.retryable).toBe(false);
    expect(e.toApiError()).toMatchObject({ code: "fatal", retryable: false, entity: "network:b" });
  });

  it("precondition class is not retryable", () => {
    const e = new ReconcileError("precondition", "missing dep", {});
    expect(e.retryable).toBe(false);
  });

  it("conflict class is not retryable", () => {
    const e = new ReconcileError("conflict", "drift detected", {});
    expect(e.retryable).toBe(false);
  });

  it("partial class IS retryable", () => {
    const e = new ReconcileError("partial", "some failed", {});
    expect(e.retryable).toBe(true);
  });

  it("toApiError entity defaults to empty string when absent", () => {
    const e = new ReconcileError("transient", "network hiccup", {});
    const api = e.toApiError();
    expect(api.entity).toBe("");
    expect(api.message).toBe("network hiccup");
    expect(api.code).toBe("transient");
    expect(api.retryable).toBe(true);
  });

  it("is an instance of Error", () => {
    const e = new ReconcileError("fatal", "oops", {});
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("oops");
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — network error codes → transient
// ---------------------------------------------------------------------------

describe("classify — network error codes (Fix 1)", () => {
  it("ECONNRESET → transient", () => {
    expect(classify({ code: "ECONNRESET" })).toBe("transient");
  });

  it("ETIMEDOUT → transient", () => {
    expect(classify({ code: "ETIMEDOUT" })).toBe("transient");
  });

  it("ECONNREFUSED → transient", () => {
    expect(classify({ code: "ECONNREFUSED" })).toBe("transient");
  });

  it("EAI_AGAIN → transient", () => {
    expect(classify({ code: "EAI_AGAIN" })).toBe("transient");
  });

  it("EPIPE → transient", () => {
    expect(classify({ code: "EPIPE" })).toBe("transient");
  });

  it("ABORT_ERR → transient", () => {
    expect(classify({ code: "ABORT_ERR" })).toBe("transient");
  });

  it("ABORTERR → transient", () => {
    expect(classify({ code: "ABORTERR" })).toBe("transient");
  });

  it("timeout → transient (fetch/AbortController code)", () => {
    expect(classify({ code: "timeout" })).toBe("transient");
  });

  it("network codes are case-insensitive (lowercase)", () => {
    expect(classify({ code: "econnreset" })).toBe("transient");
    expect(classify({ code: "etimedout" })).toBe("transient");
  });

  it("non-network unknown code still defaults to fatal", () => {
    expect(classify({ code: "NOPE" })).toBe("fatal");
  });

  it("httpStatus 503 with code 'timeout' is still transient (httpStatus 5xx path; both paths agree)", () => {
    // Prescribed test: must remain transient. Code path: kind → network code → httpStatus.
    // Network code fires first here (timeout → transient), but 5xx would also match.
    expect(classify({ httpStatus: 503, code: "timeout" })).toBe("transient");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — kind:"network-error" + httpStatus 408/425 → transient
// ---------------------------------------------------------------------------

describe("classify — kind:network-error and HTTP 408/425 (Fix 2)", () => {
  it("kind=network-error → transient", () => {
    expect(classify({ kind: "network-error" })).toBe("transient");
  });

  it("httpStatus 408 (Request Timeout) → transient", () => {
    expect(classify({ httpStatus: 408 })).toBe("transient");
  });

  it("httpStatus 425 (Too Early) → transient", () => {
    expect(classify({ httpStatus: 425 })).toBe("transient");
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — cause forwarding + optional options
// ---------------------------------------------------------------------------

describe("ReconcileError — cause forwarding and optional options (Fix 3)", () => {
  it("forwards cause via ES2022 error chaining", () => {
    const inner = new Error("inner");
    const e = new ReconcileError("fatal", "x", { cause: inner });
    expect(e.cause).toBe(inner);
  });

  it("toApiError does NOT expose cause (no cause key in output)", () => {
    const inner = new Error("inner");
    const e = new ReconcileError("fatal", "x", { cause: inner });
    const api = e.toApiError();
    expect(api).not.toHaveProperty("cause");
    // Confirm exact shape: only the 4 specified keys
    expect(Object.keys(api).sort()).toEqual(["code", "entity", "message", "retryable"]);
  });

  it("options bag is optional — new ReconcileError('fatal','x') works", () => {
    const e = new ReconcileError("fatal", "x");
    expect(e.message).toBe("x");
    expect(e.errorClass).toBe("fatal");
    expect(e.entity).toBe("");
    expect(e.retryable).toBe(false);
    expect(e.toApiError()).toMatchObject({ code: "fatal", message: "x", retryable: false, entity: "" });
    expect(e.toApiError()).not.toHaveProperty("cause");
  });

  it("cause is undefined when not provided", () => {
    const e = new ReconcileError("fatal", "x", {});
    expect(e.cause).toBeUndefined();
  });
});
