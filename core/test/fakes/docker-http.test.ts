/**
 * core/test/fakes/docker-http.test.ts
 *
 * Task 3.1 — proves the in-memory Docker Engine API fake is a faithful
 * `DockerTransport` seam for DockerProvider (3.2) and the env-injection path
 * (3.3):
 *   - container create / start / stop / list / inspect over the
 *     SSH-tunnel-shaped transport (method + path + JSON body)
 *   - create returns a deterministic id; duplicate name → 409 (so 3.2 can do
 *     observe-before-create as a no-op)
 *   - list filters by label and name (sufficient for 3.2 observe())
 *   - inspect reflects running/stopped state + Config.Env (3.3 reads this)
 *   - start/stop are idempotent (304 when already in target state)
 *   - settable engine fault → 500 on every call until toggled off
 *   - per-instance, resettable in-memory state (no global/static state)
 *
 * This tests OUR fake's seam-compatibility, NOT Docker.
 */

import { describe, it, expect } from "vitest";
import {
  createDockerHttpFake,
  type ContainerCreateBody,
} from "./docker-http.js";

function createBody(over: Partial<ContainerCreateBody> = {}): ContainerCreateBody {
  return { Image: "nginx:1", ...over };
}

describe("createDockerHttpFake", () => {
  it("create → start → inspect → stop → list round-trip", async () => {
    const { transport } = createDockerHttpFake();

    const created = await transport.request(
      "POST",
      "/containers/create?name=web-1",
      createBody({ Labels: { "bevox.service": "web" } }),
    );
    expect(created.status).toBe(201);
    const { Id } = created.json as { Id: string };
    expect(Id).toBe("c1");

    const beforeStart = await transport.request("GET", `/containers/${Id}/json`);
    expect((beforeStart.json as { State: { Running: boolean } }).State.Running).toBe(
      false,
    );

    const started = await transport.request("POST", `/containers/${Id}/start`);
    expect(started.status).toBe(204);

    const inspected = await transport.request("GET", `/containers/${Id}/json`);
    expect(inspected.status).toBe(200);
    const ins = inspected.json as {
      State: { Running: boolean };
      Config: { Image: string };
    };
    expect(ins.State.Running).toBe(true);
    expect(ins.Config.Image).toBe("nginx:1");

    const stopped = await transport.request("POST", `/containers/${Id}/stop`);
    expect(stopped.status).toBe(204);

    // The container is now stopped (exited); the Engine hides non-running
    // containers unless all=true (faithful behaviour — see the fidelity test).
    const listed = await transport.request("GET", "/containers/json?all=true");
    expect(listed.status).toBe(200);
    const list = listed.json as Array<{ Id: string; Names: string[]; State: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.Names).toEqual(["/web-1"]);
    expect(list[0]!.State).toBe("exited");
  });

  it("list returns only RUNNING containers unless all=true (faithful to the Engine)", async () => {
    const { transport } = createDockerHttpFake();
    const c = await transport.request(
      "POST",
      "/containers/create?name=created-only",
      createBody(),
    );
    const { Id } = c.json as { Id: string };
    // Created (not started) ⇒ hidden from the default list…
    const def = await transport.request("GET", "/containers/json");
    expect((def.json as unknown[]).length).toBe(0);
    // …but visible with all=true.
    const all = await transport.request("GET", "/containers/json?all=true");
    expect((all.json as unknown[]).length).toBe(1);
    // Once started, it appears in the default list.
    await transport.request("POST", `/containers/${Id}/start`);
    const running = await transport.request("GET", "/containers/json");
    expect((running.json as unknown[]).length).toBe(1);
  });

  it("ids increment deterministically per instance", async () => {
    const { transport } = createDockerHttpFake();
    const a = await transport.request("POST", "/containers/create?name=a", createBody());
    const b = await transport.request("POST", "/containers/create?name=b", createBody());
    expect((a.json as { Id: string }).Id).toBe("c1");
    expect((b.json as { Id: string }).Id).toBe("c2");
  });

  // --- 2.0.3: drivable State.Health.Status for wait-for-healthy tests --------
  it("setHealth drives State.Health.Status over successive inspects; last sticks", async () => {
    const fake = createDockerHttpFake();
    const { transport } = fake;
    const created = await transport.request(
      "POST",
      "/containers/create?name=db-0",
      createBody(),
    );
    const { Id } = created.json as { Id: string };
    fake.setHealth("db-0", ["starting", "healthy"]);

    const read = async (): Promise<string> => {
      const r = await transport.request("GET", `/containers/${Id}/json`);
      return (r.json as { State: { Health?: { Status: string } } }).State.Health!
        .Status;
    };
    expect(await read()).toBe("starting");
    expect(await read()).toBe("healthy");
    expect(await read()).toBe("healthy"); // last value sticks after drain
  });

  it("no setHealth ⇒ inspect has NO State.Health (no-HEALTHCHECK case)", async () => {
    const fake = createDockerHttpFake();
    const { transport } = fake;
    const created = await transport.request(
      "POST",
      "/containers/create?name=plain-0",
      createBody(),
    );
    const { Id } = created.json as { Id: string };
    const insp = await transport.request("GET", `/containers/${Id}/json`);
    expect("Health" in (insp.json as { State: object }).State).toBe(false);
  });

  it("duplicate name → 409 (lets 3.2 observe-before-create as a no-op)", async () => {
    const { transport } = createDockerHttpFake();
    const first = await transport.request("POST", "/containers/create?name=dup", createBody());
    expect(first.status).toBe(201);
    const second = await transport.request("POST", "/containers/create?name=dup", createBody());
    expect(second.status).toBe(409);
    expect((second.json as { message: string }).message).toMatch(/already in use/);

    // truth still observable by name so 3.2 can treat it as a no-op
    const listed = await transport.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: ["dup"] }))}`,
    );
    expect((listed.json as unknown[])).toHaveLength(1);
  });

  it("missing name or Image → 400", async () => {
    const { transport } = createDockerHttpFake();
    const noName = await transport.request("POST", "/containers/create", createBody());
    expect(noName.status).toBe(400);
    const noImage = await transport.request(
      "POST",
      "/containers/create?name=x",
      {},
    );
    expect(noImage.status).toBe(400);
  });

  it("list filters by label and by name (sufficient for 3.2 observe)", async () => {
    const { transport } = createDockerHttpFake();
    await transport.request(
      "POST",
      "/containers/create?name=svc-a",
      createBody({ Labels: { "bevox.service": "a", env: "prod" } }),
    );
    await transport.request(
      "POST",
      "/containers/create?name=svc-b",
      createBody({ Labels: { "bevox.service": "b" } }),
    );

    const byLabelKV = await transport.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["bevox.service=a"] }))}`,
    );
    expect((byLabelKV.json as Array<{ Names: string[] }>).map((c) => c.Names[0])).toEqual([
      "/svc-a",
    ]);

    const byLabelKey = await transport.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["env"] }))}`,
    );
    expect(byLabelKey.json as unknown[]).toHaveLength(1);

    const byName = await transport.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: ["svc-b"] }))}`,
    );
    expect((byName.json as Array<{ Names: string[] }>)[0]!.Names).toEqual(["/svc-b"]);
  });

  it("inspect reflects Env / ports / binds so 3.3 can assert injected env", async () => {
    const { transport } = createDockerHttpFake();
    const created = await transport.request(
      "POST",
      "/containers/create?name=app",
      createBody({
        Env: ["FOO=bar", "SECRET=resolved"],
        ExposedPorts: { "80/tcp": {} },
        HostConfig: { Binds: ["/data:/var/lib/data"] },
      }),
    );
    const { Id } = created.json as { Id: string };
    const ins = (await transport.request("GET", `/containers/${Id}/json`)).json as {
      Config: { Env: string[]; ExposedPorts: Record<string, unknown> };
      HostConfig: { Binds: string[] };
    };
    expect(ins.Config.Env).toEqual(["FOO=bar", "SECRET=resolved"]);
    expect(Object.keys(ins.Config.ExposedPorts)).toEqual(["80/tcp"]);
    expect(ins.HostConfig.Binds).toEqual(["/data:/var/lib/data"]);
  });

  it("start/stop are idempotent (304 when already in target state)", async () => {
    const { transport } = createDockerHttpFake();
    const { Id } = (
      await transport.request("POST", "/containers/create?name=i", createBody())
    ).json as { Id: string };

    expect((await transport.request("POST", `/containers/${Id}/start`)).status).toBe(204);
    expect((await transport.request("POST", `/containers/${Id}/start`)).status).toBe(304);
    expect((await transport.request("POST", `/containers/${Id}/stop`)).status).toBe(204);
    expect((await transport.request("POST", `/containers/${Id}/stop`)).status).toBe(304);
  });

  it("operations on a missing container → 404", async () => {
    const { transport } = createDockerHttpFake();
    expect((await transport.request("GET", "/containers/nope/json")).status).toBe(404);
    expect((await transport.request("POST", "/containers/nope/start")).status).toBe(404);
    expect((await transport.request("POST", "/containers/nope/stop")).status).toBe(404);
  });

  it("setEngineFault(true): every call → 500 until toggled off", async () => {
    const { transport, setEngineFault } = createDockerHttpFake();
    setEngineFault(true);
    const faulted = await transport.request("GET", "/containers/json");
    expect(faulted.status).toBe(500);
    expect((faulted.json as { message: string }).message).toBe("fake engine fault");
    setEngineFault(false);
    expect((await transport.request("GET", "/containers/json")).status).toBe(200);
  });

  it("reset() clears state and id counter; instances are isolated", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request("POST", "/containers/create?name=x", createBody());
    fake.setEngineFault(true);
    fake.reset();

    const recreated = await fake.transport.request(
      "POST",
      "/containers/create?name=y",
      createBody(),
    );
    expect(recreated.status).toBe(201); // no lingering fault
    expect((recreated.json as { Id: string }).Id).toBe("c1"); // counter restarted

    const other = createDockerHttpFake();
    const otherList = await other.transport.request("GET", "/containers/json");
    expect(otherList.json as unknown[]).toHaveLength(0); // independent instance
  });

  it("unknown Engine route → 404", async () => {
    const { transport } = createDockerHttpFake();
    const res = await transport.request("GET", "/images/json");
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Task 4.1 — exec/start endpoints for the migration runner.
  //
  // The runner issues `docker exec <ctr> psql -c "<sql>"` via the Engine API:
  //   POST /containers/{id}/exec  → 201 { Id: "exec<N>" }   (creates context)
  //   POST /exec/{id}/start       → 200 { exitCode, stdout, stderr } (runs it)
  // The fake's job is to be a deterministic seam — the response is SCRIPTED
  // (setExecResult / setExecResultByMatcher), not derived from running psql.
  // -------------------------------------------------------------------------

  it("POST /containers/{id}/exec creates an exec context with an Id", async () => {
    const { transport } = createDockerHttpFake();
    const created = await transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    const { Id } = created.json as { Id: string };
    const { status, json } = await transport.request(
      "POST",
      `/containers/${Id}/exec`,
      { Cmd: ["psql", "-U", "u", "-d", "db", "-c", "SELECT 1"], AttachStdout: true },
    );
    expect(status).toBe(201);
    expect((json as { Id: string }).Id).toMatch(/^exec[0-9]+$/);
  });

  it("POST /exec/{id}/start returns exitCode + stdout + stderr (scripted)", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    fake.setExecResult({ exitCode: 0, stdout: "OK\n", stderr: "" });
    const execRes = await fake.transport.request(
      "POST",
      "/containers/c1/exec",
      { Cmd: ["psql", "-c", "SELECT 1"] },
    );
    const exec = execRes.json as { Id: string };
    const { status, json } = await fake.transport.request(
      "POST",
      `/exec/${exec.Id}/start`,
      {},
    );
    expect(status).toBe(200);
    const r = json as { exitCode: number; stdout: string; stderr: string };
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("OK\n");
  });

  it("setExecResult({exitCode:1, stderr:'…syntax error…'}) → exit 1", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    fake.setExecResult({
      exitCode: 1,
      stdout: "",
      stderr: 'ERROR:  syntax error at or near "SLECT"\nSQLSTATE: 42601\n',
    });
    const execRes = await fake.transport.request(
      "POST",
      "/containers/c1/exec",
      { Cmd: ["psql", "-c", "SLECT 1"] },
    );
    const exec = execRes.json as { Id: string };
    const { json } = await fake.transport.request(
      "POST",
      `/exec/${exec.Id}/start`,
      {},
    );
    const r = json as { exitCode: number; stderr: string };
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/SQLSTATE: 42601/);
  });

  it("setExecResultByMatcher dispatches scripted result per Cmd predicate", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    fake.setExecResultByMatcher(
      (cmd) =>
        cmd.some((a) => a.includes("CREATE TABLE IF NOT EXISTS schema_migrations")),
      { exitCode: 0, stdout: "", stderr: "" },
    );
    fake.setExecResultByMatcher(
      (cmd) => cmd.some((a) => a.includes("SLECT")),
      { exitCode: 1, stdout: "", stderr: "SQLSTATE: 42601" },
    );

    const okExec = (
      await fake.transport.request("POST", "/containers/c1/exec", {
        Cmd: [
          "psql",
          "-c",
          "CREATE TABLE IF NOT EXISTS schema_migrations(version text primary key)",
        ],
      })
    ).json as { Id: string };
    const okStart = await fake.transport.request(
      "POST",
      `/exec/${okExec.Id}/start`,
      {},
    );
    expect((okStart.json as { exitCode: number }).exitCode).toBe(0);

    const badExec = (
      await fake.transport.request("POST", "/containers/c1/exec", {
        Cmd: ["psql", "-c", "SLECT 1"],
      })
    ).json as { Id: string };
    const badStart = await fake.transport.request(
      "POST",
      `/exec/${badExec.Id}/start`,
      {},
    );
    const r = badStart.json as { exitCode: number; stderr: string };
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/SQLSTATE: 42601/);
  });

  it("exec call log records containerId + cmd + execId + started flag", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    const execRes = await fake.transport.request(
      "POST",
      "/containers/c1/exec",
      { Cmd: ["psql", "-c", "SELECT 1"] },
    );
    const exec = execRes.json as { Id: string };
    expect(fake.execCallLog).toHaveLength(1);
    expect(fake.execCallLog[0]!.containerId).toBe("c1");
    expect(fake.execCallLog[0]!.cmd).toEqual(["psql", "-c", "SELECT 1"]);
    expect(fake.execCallLog[0]!.execId).toBe(exec.Id);
    expect(fake.execCallLog[0]!.started).toBe(false);

    await fake.transport.request("POST", `/exec/${exec.Id}/start`, {});
    expect(fake.execCallLog[0]!.started).toBe(true);
  });

  it("POST /containers/{id}/exec on a missing container → 404", async () => {
    const { transport } = createDockerHttpFake();
    const res = await transport.request("POST", "/containers/nope/exec", {
      Cmd: ["psql", "-c", "SELECT 1"],
    });
    expect(res.status).toBe(404);
  });

  it("POST /exec/{id}/start on a missing exec context → 404", async () => {
    const { transport } = createDockerHttpFake();
    const res = await transport.request("POST", "/exec/exec999/start", {});
    expect(res.status).toBe(404);
  });

  it("reset() clears exec map, call log and scripted result", async () => {
    const fake = createDockerHttpFake();
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    fake.setExecResult({ exitCode: 1, stdout: "", stderr: "err" });
    await fake.transport.request("POST", "/containers/c1/exec", {
      Cmd: ["psql", "-c", "SELECT 1"],
    });
    expect(fake.execCallLog.length).toBeGreaterThan(0);

    fake.reset();
    expect(fake.execCallLog).toHaveLength(0);

    // After reset: default result is exitCode 0 / empty streams.
    await fake.transport.request(
      "POST",
      "/containers/create?name=pg",
      createBody({ Image: "postgres:16" }),
    );
    const execRes = await fake.transport.request(
      "POST",
      "/containers/c1/exec",
      { Cmd: ["psql", "-c", "SELECT 1"] },
    );
    const exec = execRes.json as { Id: string };
    const start = await fake.transport.request(
      "POST",
      `/exec/${exec.Id}/start`,
      {},
    );
    expect(start.status).toBe(200);
    const r = start.json as { exitCode: number; stdout: string; stderr: string };
    expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  // -------------------------------------------------------------------------
  // Task 1 (spec 2026-06-01-docker-private-registry-auth): the fake must model
  // image-presence (GET /images/<ref>/json 200/404) and capture X-Registry-Auth
  // on POST /images/create — or it masks Bug 11 (skip-if-exists + private auth).
  // -------------------------------------------------------------------------
  describe("image presence + X-Registry-Auth capture (Bug 11 fidelity)", () => {
    const REF = "ghcr.io/example-org/bevox-backend@sha256:abc";

    it("GET /images/<ref>/json → 404 when absent, 200 when seeded present", async () => {
      const fake = createDockerHttpFake();
      const enc = encodeURIComponent(REF);

      const absent = await fake.transport.request("GET", `/images/${enc}/json`);
      expect(absent.status).toBe(404);

      fake.setImagePresent(REF);
      const present = await fake.transport.request("GET", `/images/${enc}/json`);
      expect(present.status).toBe(200);
    });

    it("a successful POST /images/create marks the image present", async () => {
      const fake = createDockerHttpFake();
      const enc = encodeURIComponent(REF);

      await fake.transport.request(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(REF)}`,
      );
      const after = await fake.transport.request("GET", `/images/${enc}/json`);
      expect(after.status).toBe(200);
    });

    it("captures the X-Registry-Auth header passed to POST /images/create", async () => {
      const fake = createDockerHttpFake();
      const AUTH = "BASE64URL-auth-blob";

      await fake.transport.request(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(REF)}`,
        undefined,
        { "X-Registry-Auth": AUTH },
      );
      expect(fake.capturedRegistryAuth(REF)).toBe(AUTH);
    });

    it("no X-Registry-Auth header ⇒ nothing captured for that ref", async () => {
      const fake = createDockerHttpFake();
      await fake.transport.request(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(REF)}`,
      );
      expect(fake.capturedRegistryAuth(REF)).toBeUndefined();
    });
  });
});
