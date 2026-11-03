/**
 * core/src/store/secrets.test.ts
 *
 * Task 1.9 — secret ref model: metadata only, apply-gated resolve.
 *
 * These tests pin the HARD invariants of the secret layer:
 *   - SecretRef parses "secret:<name>" and rejects malformed refs.
 *   - describe(ref) returns ONLY {name,keys,used_by} (.strict): a `value`
 *     key is structurally rejected — no secret value can ever ride along.
 *   - resolve(ref) is unreachable without a real applyContext token: a
 *     missing token, a bare object, and a bare string all reject the
 *     returned promise with a ReconcileError. Only a token from
 *     createApplyContext() is accepted; past the gate the v1 stub resolves
 *     to a value-free `{ status: "deferred" }` marker.
 * DB-free, network-free.
 */

import { describe, it, expect } from "vitest";

import {
  SecretRef,
  createApplyContext,
  createStubSecretResolver,
  type SecretResolver,
} from "./secrets.js";
import { ReconcileError } from "../domain/errors.js";

describe("SecretRef", () => {
  it("parses a well-formed secret: ref", () => {
    expect(SecretRef.parse("secret:bevox-harness")).toBe("secret:bevox-harness");
  });

  it("rejects malformed refs", () => {
    expect(() => SecretRef.parse("bevox-harness")).toThrow();
    expect(() => SecretRef.parse("secret:")).toThrow();
    expect(() => SecretRef.parse("secret:bad name")).toThrow();
    expect(() => SecretRef.parse("Secret:bevox")).toThrow();
    expect(() => SecretRef.parse("")).toThrow();
    expect(() => SecretRef.parse("secret:a/b")).toThrow();
  });
});

describe("SecretResolver.describe — metadata only", () => {
  const resolver: SecretResolver = createStubSecretResolver();

  it("returns exactly {name,keys,used_by}", () => {
    const meta = resolver.describe("secret:bevox-harness");
    expect(Object.keys(meta).sort()).toEqual(["keys", "name", "used_by"]);
    expect(meta.name).toBe("bevox-harness");
    expect(Array.isArray(meta.keys)).toBe(true);
    expect(Array.isArray(meta.used_by)).toBe(true);
  });

  it("describe output has no value field and rejects an extra value key", () => {
    const meta = resolver.describe("secret:bevox-harness");
    expect("value" in meta).toBe(false);
    // The metadata schema is .strict(): a `value` key cannot be carried.
    // .strict() rejects the extra `value` key at parse time.
    expect(() =>
      resolver.describeSchema().parse({ ...meta, value: "leaked" }),
    ).toThrow();
    // And the inferred metadata type cannot statically carry a value.
    // @ts-expect-error — `value` is not part of SecretMeta
    const _noValue: typeof meta.value = undefined;
    void _noValue;
  });

  it("describe rejects a malformed ref", () => {
    expect(() => resolver.describe("not-a-ref")).toThrow(ReconcileError);
  });
});

describe("SecretResolver.resolve — apply-gated", () => {
  const resolver: SecretResolver = createStubSecretResolver();

  it("rejects when called WITHOUT a token", async () => {
    await expect(
      // @ts-expect-error — token is required
      resolver.resolve("secret:bevox-harness"),
    ).rejects.toThrow(ReconcileError);
  });

  it("rejects when called with a forged plain-object token", async () => {
    await expect(
      resolver.resolve("secret:bevox-harness", {} as never),
    ).rejects.toThrow(ReconcileError);
  });

  it("rejects when called with a forged string token", async () => {
    await expect(
      resolver.resolve("secret:bevox-harness", "apply" as never),
    ).rejects.toThrow(ReconcileError);
  });

  it("returns the value-free deferred marker with a real applyContext token", async () => {
    const ctx = createApplyContext();
    // Stub: decryption is DEFERRED/out of scope. Once past the gate it
    // RESOLVES to a value-free deferred marker (never throws auth).
    const out = await resolver.resolve("secret:bevox-harness", ctx);
    expect(out).toEqual({ status: "deferred", name: "bevox-harness" });
    expect("value" in out).toBe(false);
  });

  it("still validates the ref even with a valid token", async () => {
    const ctx = createApplyContext();
    await expect(resolver.resolve("garbage", ctx)).rejects.toThrow(
      ReconcileError,
    );
  });

  it("no rejected error message ever carries secret material", async () => {
    const probes: string[] = [];
    try {
      await resolver.resolve("secret:bevox-harness", {} as never);
    } catch (e) {
      if (e instanceof Error) probes.push(e.message);
    }
    try {
      // @ts-expect-error — token required
      await resolver.resolve("secret:bevox-harness");
    } catch (e) {
      if (e instanceof Error) probes.push(e.message);
    }
    for (const m of probes) {
      expect(m).not.toMatch(/value|secret-data|BEGIN|password/i);
    }
  });
});
