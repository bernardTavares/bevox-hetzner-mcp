/**
 * core/test/fakes/ssh-exec-recorder.test.ts
 *
 * Task 4.2 — proves the in-memory `SshRunner` fake is a faithful seam for
 * the migration runner (5.x). The runner reaches the remote Docker host via
 * the `SshRunner` shape declared in `core/src/providers/ssh-transports.ts`
 * (conn, remoteArgv, opts) → Promise<SshResult>. The recorder:
 *   - dispatches a scripted SshResult (default + predicate matchers)
 *   - records argv per call so the runner's `docker exec` invocations can
 *     be asserted token-by-token (argv-only — no shell interpolation)
 *
 * This tests OUR fake's seam-compatibility, NOT ssh.
 */

import { describe, it, expect } from "vitest";
import type { SshConnection } from "../../src/providers/ssh-exec.js";
import { createSshExecRecorder } from "./ssh-exec-recorder.js";

const CONN: SshConnection = {
  host: "h",
  user: "u",
  port: 22,
  privateKey: "k",
  hostKeyPolicy: "accept-new",
};

describe("ssh-exec-recorder fake", () => {
  it("records argv per call and returns scripted SshResult", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "ok\n", stderr: "" });
    const res = await rec.run(CONN, [
      "docker",
      "exec",
      "c1",
      "psql",
      "-U",
      "u",
      "-d",
      "db",
      "-c",
      "SELECT 1",
    ]);
    expect(res).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.remoteArgv).toEqual([
      "docker",
      "exec",
      "c1",
      "psql",
      "-U",
      "u",
      "-d",
      "db",
      "-c",
      "SELECT 1",
    ]);
  });

  it("setResultByMatcher dispatches scripted result per argv predicate", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) =>
        argv.some((a) => a.includes("CREATE TABLE IF NOT EXISTS schema_migrations")),
      { code: 0, stdout: "", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.some((a) => a.includes("SLECT")),
      { code: 1, stdout: "", stderr: "ERROR:  syntax error\nSQLSTATE: 42601" },
    );
    const ok = await rec.run(CONN, [
      "docker",
      "exec",
      "c1",
      "psql",
      "-c",
      "CREATE TABLE IF NOT EXISTS schema_migrations(...)",
    ]);
    expect(ok.code).toBe(0);
    const bad = await rec.run(CONN, [
      "docker",
      "exec",
      "c1",
      "psql",
      "-c",
      "SLECT 1",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/SQLSTATE: 42601/);
  });

  it("default fall-through is { code: 0, stdout: \"\", stderr: \"\" }", async () => {
    const rec = createSshExecRecorder();
    const res = await rec.run(CONN, ["whoami"]);
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("first matching predicate wins over later ones", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(() => true, { code: 7, stdout: "first", stderr: "" });
    rec.setResultByMatcher(() => true, { code: 99, stdout: "second", stderr: "" });
    const res = await rec.run(CONN, ["any"]);
    expect(res.code).toBe(7);
    expect(res.stdout).toBe("first");
  });

  it("records the conn passed to each call", async () => {
    const rec = createSshExecRecorder();
    await rec.run(CONN, ["echo", "1"]);
    expect(rec.calls[0]!.conn).toEqual(CONN);
  });

  it("reset() clears calls, default result and matchers", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 5, stdout: "x", stderr: "y" });
    rec.setResultByMatcher(() => true, { code: 9, stdout: "", stderr: "" });
    await rec.run(CONN, ["a"]);
    expect(rec.calls).toHaveLength(1);

    rec.reset();
    expect(rec.calls).toHaveLength(0);
    const res = await rec.run(CONN, ["b"]);
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("records opts.stdin on the SshExecCall and stdin does NOT appear in remoteArgv", async () => {
    const manifest = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api";
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "deployment.apps/api configured", stderr: "" },
    );

    const res = await rec.run(CONN, ["kubectl", "apply", "-f", "-"], { stdin: manifest });

    // Scripted result is returned
    expect(res.stdout).toBe("deployment.apps/api configured");
    expect(res.code).toBe(0);

    // stdin is recorded on the call
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.stdin).toBe(manifest);

    // The manifest body MUST NOT appear anywhere in remoteArgv
    const argvJoined = rec.calls[0]!.remoteArgv.join(" ");
    expect(argvJoined).not.toContain("apiVersion");
    expect(argvJoined).not.toContain("Deployment");
    expect(argvJoined).not.toContain(manifest);
  });

  it("stdin is undefined on the call when opts.stdin is not provided", async () => {
    const rec = createSshExecRecorder();
    await rec.run(CONN, ["kubectl", "get", "pods"]);
    expect(rec.calls[0]!.stdin).toBeUndefined();
  });
});
