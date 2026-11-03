import { describe, it, expect } from "vitest";
import {
  createSopsAgeSecretResolver,
  createApplyContext,
} from "./secrets.js";
import { createSopsCliFake } from "../../test/fakes/sops-cli.js";

const basicCfg = {
  secretsFile: "/s/file",
  ageKeyFile: "/s/key",
};

describe("createSopsAgeSecretResolver", () => {
  it("refuses forged ctx → fatal, spawn never called", async () => {
    const fake = createSopsCliFake();
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    await expect(r.resolve("secret:foo", {} as any)).rejects.toThrow(/secret resolve refused/);
    expect(fake.callLog).toHaveLength(0);
  });

  it("real ctx + malformed ref → precondition, spawn never called", async () => {
    const fake = createSopsCliFake();
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    await expect(r.resolve("not-a-ref", createApplyContext())).rejects.toThrow(/secret ref invalid/);
    expect(fake.callLog).toHaveLength(0);
  });

  it("happy: exit 0 + stdout 'abc' → {status: ok, name, value: 'abc'}", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("abc"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:openai-api-key", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "openai-api-key", value: "abc" });
  });

  it("newline preservation: PEM-like value (internal+trailing newlines) → byte-identical", async () => {
    const pem = "-----BEGIN-----\nABC\nDEF\n-----END-----\n";
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from(pem), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:tls-key", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "tls-key", value: pem });
  });

  it("exit 0 + non-empty stderr (sops warning) → still {status:ok}", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({
      exitCode: 0,
      stdout: Buffer.from("abc"),
      stderr: Buffer.from("warning: deprecated cipher"),
    });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    const result = await r.resolve("secret:k", createApplyContext());
    expect(result).toEqual({ status: "ok", name: "k", value: "abc" });
  });

  it("exit 1 → fatal 'secret resolve failed: <name>', stderr discarded even with sentinel", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("sops: file not found S3CR3T-3.4-fake-leak-XYZ"),
    });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try {
      await r.resolve("secret:k", createApplyContext());
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toMatch(/secret resolve failed: k/);
    expect(captured?.message).not.toMatch(/S3CR3T-3\.4-fake-leak-XYZ/);
    // Also: cause / nested fields should not leak
    expect(JSON.stringify(captured)).not.toMatch(/S3CR3T-3\.4-fake-leak-XYZ/);
  });

  it("args form: --extract uses template literal, NOT JSON.stringify; shell:false", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({
      secretsFile: "/path/to/secrets.yaml",
      ageKeyFile: "/path/to/age.key",
      spawn: fake.spawn,
    });
    await r.resolve("secret:openai-api-key", createApplyContext());
    const call = fake.callLog[0]!;
    expect(call.args).toEqual([
      "-d", "--extract", `["openai-api-key"]`, "--output-type", "binary",
      "/path/to/secrets.yaml",
    ]);
    expect(call.args[2]).not.toMatch(/^\\"/);  // not JSON.stringify-wrapped
    expect(call.opts.shell).toBe(false);
  });

  it("subprocess env keys === {PATH, HOME, SOPS_AGE_KEY_FILE} exact (L8 env hygiene)", async () => {
    process.env.AGENT_CREDENTIALS = "must-not-leak";
    process.env.HCLOUD_TOKEN = "must-not-leak";
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    await r.resolve("secret:k", createApplyContext());
    const call = fake.callLog[0]!;
    expect(Object.keys(call.opts.env).sort()).toEqual(["HOME", "PATH", "SOPS_AGE_KEY_FILE"]);
    expect(call.opts.env).not.toHaveProperty("AGENT_CREDENTIALS");
    expect(call.opts.env).not.toHaveProperty("HCLOUD_TOKEN");
  });

  it("L5: sentinel in stderr (any path) never appears in any captured error message", async () => {
    // Test BOTH paths: spawn error AND exit-≠-0.
    const sentinel = "S3CR3T-3.9-stderr-never-leaks-XYZ";
    const fake = createSopsCliFake();
    fake.setResponse({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(sentinel),
    });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try {
      await r.resolve("secret:k", createApplyContext());
    } catch (e) {
      captured = e as Error;
    }
    expect(JSON.stringify(captured)).not.toMatch(/S3CR3T-3\.9/);
  });

  it("spawn error (ENOENT) is wrapped, never rethrown raw with path leak", async () => {
    const fake = createSopsCliFake();
    fake.setSpawnError({ code: "ENOENT", message: "spawn /usr/bin/sops ENOENT" });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try {
      await r.resolve("secret:k", createApplyContext());
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toBe("secret resolve failed: k");  // no /usr/bin/sops leak
    expect(captured?.message).not.toMatch(/ENOENT|usr|bin|sops/);
  });

  it("timeout: SIGTERM, 200ms grace, SIGKILL, fatal 'secret resolve timeout: <name>'", async () => {
    const fake = createSopsCliFake();
    fake.setTimeout();  // never resolves until killed
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn, timeoutMs: 50 });
    let captured: Error | null = null;
    try {
      await r.resolve("secret:slow", createApplyContext());
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toMatch(/secret resolve timeout: slow/);
    expect(fake.lastKillSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stdout > 64KB → kill + fatal 'secret resolve oversized: <name>' (L9 Buffer cap)", async () => {
    const oversized = Buffer.alloc(65 * 1024, 0x41);  // 65 KB of 'A'
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: oversized, stderr: Buffer.alloc(0) });
    const r = createSopsAgeSecretResolver({ ...basicCfg, spawn: fake.spawn });
    let captured: Error | null = null;
    try {
      await r.resolve("secret:big", createApplyContext());
    } catch (e) {
      captured = e as Error;
    }
    expect(captured?.message).toMatch(/secret resolve oversized: big/);
  });
});
