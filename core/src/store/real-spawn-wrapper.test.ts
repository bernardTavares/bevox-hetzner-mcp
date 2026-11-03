/**
 * core/src/store/real-spawn-wrapper.test.ts
 *
 * Task 4.1 — `realSpawnWrapper`: the production adapter that wraps
 * `node:child_process.spawn` to the `SpawnFn` shape used by the sops-age
 * resolver (`createSopsAgeSecretResolver`) and the boot-time validator
 * (`_validateSopsAgeConfig`).
 *
 * Test strategy. Verifying the adapter REQUIRES a real subprocess (the whole
 * point of the wrapper is the bridge between Node's stream-based ChildProcess
 * and the resolver's Promise-based `SpawnFn`). To stay deterministic we spawn
 * `node` (always present on the CI host — the harness IS Node) with an inline
 * `-e` script, never `sops`. Same precedent as `pg-harness` spawning real
 * Postgres for store tests: the adapter under test is shimming real OS
 * primitives, so a real subprocess is the minimum-honest test surface.
 *
 * Each `-e` script is one line and exits within ~50ms. No sops, no PATH
 * assumptions beyond `node`.
 */

import { describe, it, expect } from "vitest";
import { realSpawnWrapper } from "./secrets.js";

const baseOpts = {
  shell: false as const,
  env: { PATH: process.env.PATH ?? "" } as const,
};

describe("realSpawnWrapper", () => {
  it("spawns child, resolves stdout + exitCode for a normal exit", async () => {
    const child = realSpawnWrapper(
      "node",
      ["-e", "process.stdout.write('hi'); process.exit(7)"],
      baseOpts,
    );
    expect((await child.stdout).toString("utf8")).toBe("hi");
    expect(await child.exitCode).toBe(7);
  });

  it("collects stderr bytes accumulated across data events", async () => {
    const child = realSpawnWrapper(
      "node",
      ["-e", "process.stderr.write('err-out'); process.exit(0)"],
      baseOpts,
    );
    expect((await child.stderr).toString("utf8")).toBe("err-out");
    expect(await child.exitCode).toBe(0);
  });

  it("signal-killed child resolves exitCode as -1 (null → -1 coercion)", async () => {
    // A child that never exits naturally — must be killed by the test.
    const child = realSpawnWrapper(
      "node",
      ["-e", "setInterval(() => {}, 1000)"],
      baseOpts,
    );
    setTimeout(() => child.kill("SIGTERM"), 50);
    expect(await child.exitCode).toBe(-1);
  });

  it("rejects exitCode promise when binary does not exist (spawn ENOENT)", async () => {
    // No PATH lookup will find this; `child.on('error')` fires.
    const child = realSpawnWrapper(
      "this-binary-definitely-does-not-exist-xyz",
      [],
      baseOpts,
    );
    await expect(child.exitCode).rejects.toBeInstanceOf(Error);
  });
});
