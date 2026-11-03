/**
 * core/src/providers/docker-exec-adapter.ts
 *
 * Task 10.1 — slim adapter that exposes the migration runner's expected
 * `dockerExec(containerId, argv, opts?)` shape on top of the existing
 * `DockerTransport` seam (the SSH-backed Engine API client used by
 * `core/src/providers/docker.ts`).
 *
 * Why this lives outside `docker.ts`:
 *
 *   `core/src/providers/docker.ts` (header line 62) EXPLICITLY excludes
 *   exec/logs from the provider's surface (Fase-3 YAGNI). The migration
 *   runner is the FIRST and ONLY consumer of `docker exec` in v1; spec
 *   docs/specs/2026-05-28-migration-runner-v1.md §4 commits to reusing the
 *   existing `createSshTransports().docker` transport ("ZERO new transport")
 *   so the adapter speaks Engine API exec endpoints OVER that same
 *   DockerTransport — no new SSH path, no new transport seam.
 *
 * Choice: Docker HTTP exec endpoints (over the SSH-backed DockerTransport),
 * NOT `runSsh(["docker", "exec", ...])` directly. Rationale:
 *
 *   - The `core/test/fakes/docker-http.ts` fake (Task 4.1) already supports
 *     `POST /containers/{id}/exec` + `POST /exec/{id}/start`, so unit /
 *     integration / property tests of the runner all drive the SAME wire
 *     contract this adapter speaks.
 *   - The existing Docker provider already audits / scrubs every Engine
 *     call via `DockerTransport`; routing exec through it keeps a single
 *     security boundary (no parallel SSH path with its own secret-leak
 *     surface to audit).
 *   - `docker exec` argv-on-shell at the remote is a shell-interpolation
 *     surface; the Engine API exec endpoint takes `Cmd` as a JSON array
 *     (true argv vector, no shell). Aligns with the runner's invariant
 *     that argv is passed VERBATIM — no host-side shell.
 *
 * SHAPE CAVEAT (matches the fake, not the production Engine wire 1:1):
 *
 *   The real Docker Engine `/exec/{id}/start` returns a multiplexed
 *   stdout/stderr STREAM and the exit code lives on `/exec/{id}/json`.
 *   The Task-4.1 fake simplifies this to a single JSON body
 *   `{ exitCode, stdout, stderr }` (the runner only inspects exitCode +
 *   stderr for SQLSTATE classification — spec §2.3). This adapter speaks
 *   the FAKE'S contract:
 *
 *     POST /containers/{id}/exec   →  { Id }
 *     POST /exec/{id}/start        →  { exitCode, stdout, stderr }
 *
 *   The @live test (Task 11.2) is the boundary that exercises the real
 *   Engine wire end-to-end. v1 ships the fake-compatible shape; a future
 *   release can extend the adapter to also parse the real stream
 *   multiplex without changing this signature.
 */

import type { Config } from "../config.js";
import type { DockerTransport } from "./docker-transport.js";

/**
 * Result shape the migration runner consumes (matches
 * `RunMigrationsDeps.dockerExec` return type — see
 * `core/src/agent/v2/run-migrations.ts`).
 */
export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The exec function shape the migration runner depends on. */
export type DockerExecFn = (
  containerId: string,
  argv: readonly string[],
  opts?: { readonly signal?: AbortSignal },
) => Promise<DockerExecResult>;

/**
 * Build a `dockerExec` adapter over the supplied `DockerTransport`. The
 * `config` parameter is reserved for future per-call options (per-exec
 * timeout default, user/working dir overrides) — the runner currently
 * applies its own AbortController via `opts.signal`, so the adapter only
 * forwards the signal and DOES NOT impose a transport-level timeout here
 * (single-source-of-truth on the timeout knob lives in the runner).
 */
export function createDockerExecOverSsh(
  docker: DockerTransport,
  _config: Config,
): DockerExecFn {
  return async (
    containerId: string,
    argv: readonly string[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<DockerExecResult> => {
    // Surface a pre-aborted signal immediately — the runner's safeExec
    // already classifies a thrown error past an aborted signal as
    // "timeout", so a synthetic AbortError carries the right semantics.
    if (opts?.signal?.aborted) {
      throw new Error("aborted");
    }

    // 1. Create the exec context (Cmd is a JSON ARRAY — true argv, no shell).
    const createRes = await docker.request(
      "POST",
      `/containers/${containerId}/exec`,
      {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: argv,
      },
    );
    if (createRes.status < 200 || createRes.status >= 300) {
      // The Engine returns 404 when the container is gone — the runner's
      // `classifyThrown` matches /not running|container.*exited/i, so the
      // message intentionally surfaces "container is not running" on 404
      // to drive the `container_exited` error_code path (spec §2.3).
      if (createRes.status === 404) {
        throw new Error("docker exec: container is not running");
      }
      throw new Error(
        `docker exec create failed (status ${createRes.status})`,
      );
    }
    const createBody = createRes.json as { Id?: string } | null;
    const execId = createBody?.Id;
    if (typeof execId !== "string" || execId.length === 0) {
      throw new Error("docker exec: missing exec Id in create response");
    }

    // 2. Start the exec. The fake returns the result body directly; the
    // production Engine returns a multiplex stream (see SHAPE CAVEAT in
    // the file header — the @live test covers the real wire).
    const startRes = await docker.request("POST", `/exec/${execId}/start`, {
      Detach: false,
      Tty: false,
    });
    if (startRes.status < 200 || startRes.status >= 300) {
      throw new Error(
        `docker exec start failed (status ${startRes.status})`,
      );
    }
    const body = (startRes.json ?? {}) as Partial<DockerExecResult>;
    return {
      exitCode: typeof body.exitCode === "number" ? body.exitCode : 0,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
    };
  };
}
