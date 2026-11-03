/**
 * core/test/fakes/sops-cli.test.ts
 *
 * Task 1.2 — proves the in-memory sops CLI fake honors the `SpawnFn` shape
 * declared module-internal in `core/src/store/secrets.ts` §1.2:
 *
 *   (cmd, args, opts) => { stdout, stderr, exitCode, kill }
 *
 * All four return values are Promises (Buffer / Buffer / number) plus a
 * synchronous `kill(signal?)`. The fake is per-instance, deterministic, and
 * exercises four configurable behaviours required by later resolver tasks:
 *
 *   - `setResponse` — happy/error exit code + canned stdout/stderr (Task 3.3+)
 *   - `setTimeout` — spawn never resolves until `kill` is called (Task 3.7)
 *   - `setSpawnError` — Promises reject with a `child.on('error')`-shaped
 *     payload (e.g. `code: "ENOENT"`) — Task 3.8 + boot validation 2.5
 *   - `lastKillSignals` — records every signal sent to `kill` (Task 3.7
 *     SIGTERM → SIGKILL escalation assertions)
 *
 * This tests OUR fake — NO real sops binary is invoked.
 */

import { describe, it, expect } from "vitest";
import { createSopsCliFake } from "./sops-cli.js";

describe("sops-cli fake", () => {
  it("happy: configured exit + stdout + stderr resolve via SpawnFn shape", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("abc"), stderr: Buffer.alloc(0) });
    const child = fake.spawn(
      "sops",
      ["-d", "--extract", `["k"]`, "f.yaml"],
      { shell: false, env: { PATH: "/usr/bin" } },
    );
    expect(await child.exitCode).toBe(0);
    expect((await child.stdout).toString("utf8")).toBe("abc");
    expect((await child.stderr).length).toBe(0);
  });

  it("records every spawn invocation in callLog", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 0, stdout: Buffer.from("v"), stderr: Buffer.alloc(0) });
    const child = fake.spawn(
      "sops",
      ["-d", "--extract", `["k"]`, "f.yaml"],
      { shell: false, env: { PATH: "/usr/bin" } },
    );
    await child.exitCode;
    expect(fake.callLog).toHaveLength(1);
    expect(fake.callLog[0]?.cmd).toBe("sops");
    expect(fake.callLog[0]?.args).toEqual(["-d", "--extract", `["k"]`, "f.yaml"]);
    expect(fake.callLog[0]?.opts.shell).toBe(false);
    expect(fake.callLog[0]?.opts.env.PATH).toBe("/usr/bin");
  });

  it("non-zero exit code: stdout/stderr resolve with configured buffers", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({
      exitCode: 128,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("decryption failed"),
    });
    const child = fake.spawn("sops", [], { shell: false, env: {} });
    expect(await child.exitCode).toBe(128);
    expect((await child.stderr).toString("utf8")).toBe("decryption failed");
  });

  it("setTimeout: child never resolves until kill is called", async () => {
    const fake = createSopsCliFake();
    fake.setTimeout();
    const child = fake.spawn("sops", [], { shell: false, env: {} });

    // Race the unresolved Promises against a microtask resolution — neither
    // should win without an explicit kill.
    const sentinel = Symbol("pending");
    const raced = await Promise.race([
      child.exitCode.then((c) => c),
      Promise.resolve(sentinel),
    ]);
    expect(raced).toBe(sentinel);

    child.kill("SIGTERM");
    expect(await child.exitCode).toBe(-1);
    expect((await child.stdout).length).toBe(0);
    expect((await child.stderr).length).toBe(0);
    expect(fake.lastKillSignals).toEqual(["SIGTERM"]);
  });

  it("setSpawnError: exitCode rejects with child.on('error')-shaped payload; stdout/stderr resolve empty", async () => {
    const fake = createSopsCliFake();
    fake.setSpawnError({ code: "ENOENT" });
    const child = fake.spawn("sops", [], { shell: false, env: {} });

    await expect(child.exitCode).rejects.toMatchObject({ code: "ENOENT" });
    // stdout / stderr resolve with empty Buffers — no streams ever opened.
    expect((await child.stdout).length).toBe(0);
    expect((await child.stderr).length).toBe(0);
  });

  it("spawn-error default message uses code", async () => {
    const fake = createSopsCliFake();
    fake.setSpawnError({ code: "ENOENT" });
    const child = fake.spawn("x", [], { shell: false, env: {} });
    await expect(child.exitCode).rejects.toThrow("spawn error: ENOENT");
  });

  it("kill in spawn-error mode does not record (no-op)", async () => {
    const fake = createSopsCliFake();
    fake.setSpawnError({ code: "ENOENT" });
    const child = fake.spawn("x", [], { shell: false, env: {} });
    child.kill("SIGTERM");
    expect(fake.lastKillSignals).toHaveLength(0);
    // Silence the unhandled rejection from the unawaited `exitCode`.
    await expect(child.exitCode).rejects.toThrow();
  });

  it("kill records every signal in lastKillSignals (SIGTERM → SIGKILL)", async () => {
    const fake = createSopsCliFake();
    fake.setTimeout();
    const child = fake.spawn("sops", [], { shell: false, env: {} });
    child.kill("SIGTERM");
    child.kill("SIGKILL");
    expect(fake.lastKillSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await child.exitCode).toBe(-1);
  });

  it("reset() clears callLog, response, kill signals, faults", async () => {
    const fake = createSopsCliFake();
    fake.setResponse({ exitCode: 7, stdout: Buffer.from("x"), stderr: Buffer.alloc(0) });
    const child1 = fake.spawn("sops", ["a"], { shell: false, env: {} });
    await child1.exitCode;
    expect(fake.callLog).toHaveLength(1);

    fake.reset();
    expect(fake.callLog).toHaveLength(0);
    expect(fake.lastKillSignals).toEqual([]);

    // Default after reset: exit 0, empty stdout/stderr.
    const child2 = fake.spawn("sops", ["b"], { shell: false, env: {} });
    expect(await child2.exitCode).toBe(0);
    expect((await child2.stdout).length).toBe(0);
  });

  it("two fake instances are independent", async () => {
    const fakeA = createSopsCliFake();
    const fakeB = createSopsCliFake();
    fakeA.setResponse({ exitCode: 0, stdout: Buffer.from("A"), stderr: Buffer.alloc(0) });
    fakeB.setResponse({ exitCode: 0, stdout: Buffer.from("B"), stderr: Buffer.alloc(0) });

    const a = fakeA.spawn("sops", [], { shell: false, env: {} });
    const b = fakeB.spawn("sops", [], { shell: false, env: {} });

    expect((await a.stdout).toString("utf8")).toBe("A");
    expect((await b.stdout).toString("utf8")).toBe("B");
    expect(fakeA.callLog).toHaveLength(1);
    expect(fakeB.callLog).toHaveLength(1);
  });
});
