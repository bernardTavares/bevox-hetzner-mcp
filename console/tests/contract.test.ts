// console/tests/contract.test.ts
import { describe, it, expect } from "vitest";
import { ServerSchema, WriteEnvelopeSchema, ErrorSchema, SecretSchema } from "../src/api/contract";

describe("contract", () => {
  it("valida Server canônico da spec", () => {
    const ok = ServerSchema.safeParse({
      name: "bevox-app-1", type: "cx32", location: "nbg1",
      image: "ubuntu-24.04", ssh_keys: ["bevox-ops"], labels: { app: "harness" },
      network: "bevox-priv", status: "healthy",
    });
    expect(ok.success).toBe(true);
  });

  it("rejeita status fora do enum da spec", () => {
    expect(ServerSchema.safeParse({ name: "x", type: "cx32", location: "nbg1",
      image: "i", ssh_keys: [], labels: {}, network: "n", status: "weird" }).success).toBe(false);
  });

  it("envelope de escrita aceita pending_approval com approval_id", () => {
    const r = WriteEnvelopeSchema.safeParse({ status: "pending_approval", approval_id: "apr_1" });
    expect(r.success).toBe(true);
  });

  it("erro estruturado segue {code,message,retryable,entity}", () => {
    expect(ErrorSchema.safeParse({ code: "conflict", message: "drift", retryable: false, entity: "server:x" }).success).toBe(true);
  });

  describe("SecretSchema .strict() — security invariant", () => {
    it("accepts a clean secret with exactly name, keys, used_by", () => {
      const result = SecretSchema.safeParse({ name: "bevox-harness", keys: 5, used_by: ["service:bevox-harness"] });
      expect(result.success).toBe(true);
    });

    it("rejects a secret object that contains an unexpected 'value' field (I1 strict)", () => {
      // A Fase 4 backend that accidentally returns a value field must be caught.
      const result = SecretSchema.safeParse({ name: "x", keys: 1, used_by: [], value: "super-secret-abc123" });
      expect(result.success).toBe(false);
    });

    it("rejects a secret object that contains a 'data' field", () => {
      const result = SecretSchema.safeParse({ name: "x", keys: 1, used_by: [], data: "sensitive" });
      expect(result.success).toBe(false);
    });

    it("rejects a secret object that contains a 'secret_value' field", () => {
      const result = SecretSchema.safeParse({ name: "x", keys: 1, used_by: [], secret_value: "tok_abc123" });
      expect(result.success).toBe(false);
    });
  });
});
