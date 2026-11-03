/**
 * core/test/fakes/docker-http.ts
 *
 * In-memory, per-instance fake of the Docker Engine API. Its sole job is to be
 * a deterministic `DockerTransport` seam for DockerProvider (3.2) and the
 * secret→env injection path (3.3) so the reconciler's Service convergence
 * logic can be exercised in-process with ZERO network, SSH, Docker, DB or
 * filesystem.
 *
 * ⚠ THIS IS NOT A TEST OF DOCKER and is NOT a spec-faithful Engine API
 * emulator. It models only the MINIMAL container surface Fase 3 needs
 * (create / start / stop / list / inspect) plus one deterministic Engine-fault
 * toggle. No images/pull, networks, volumes-as-objects, exec, logs, events,
 * healthchecks, restart policies, auth — those are out of scope (YAGNI; later
 * or never).
 *
 * THE SSH-TUNNEL-SHAPED SEAM (why `DockerTransport`, not `fetch`):
 *
 *   The real DockerProvider (3.2) reaches the Docker Engine API on a remote
 *   host through an SSH tunnel, NOT over a public URL. Over a tunnel the
 *   Engine API is HTTP-over-a-forwarded-stream: there is no DNS host, no TLS,
 *   no origin — you speak to Engine API *paths* (`/containers/create`,
 *   `/containers/{id}/start`, …) through an already-established connection.
 *   Modelling that as a `fetch(url)` seam would smuggle in a URL/origin that
 *   does not exist on a tunnel. So the honest seam is method + path + optional
 *   JSON body → { status, json }: exactly the bytes that cross the tunnel.
 *   A future real transport (an `ssh2`-backed Engine client) implements this
 *   SAME `DockerTransport` interface unchanged; 3.2's provider is written
 *   purely against `DockerTransport` and is therefore transport-agnostic — it
 *   never learns whether it is talking to this fake or a live SSH tunnel.
 *
 * Design principles (mirrors core/test/fakes/hetzner-http.ts &
 * pg-harness.ts isolation philosophy):
 *
 *   - PER-INSTANCE, RESETTABLE. `createDockerHttpFake()` returns a fresh
 *     isolated instance; container map and id counter live in a closure (no
 *     global/static state). `reset()` returns it to pristine — each test gets
 *     full isolation.
 *
 *   - DETERMINISTIC IDS. Container ids are `"c<n>"` with `n` incrementing per
 *     instance from 1; `reset()` restarts the counter. No randomness, no clock.
 *
 *   - IDEMPOTENCY-FRIENDLY FOR 3.2. `create` of an already-used name returns
 *     409 Conflict (Engine API's real behaviour), AND list/inspect can find a
 *     container by name, so 3.2 can implement observe-before-create as a
 *     no-op. This fake exposes the truth; it does NOT implement provider logic.
 *
 *   - DETERMINISTIC FAULT. `setEngineFault(on)` makes every transport call
 *     resolve with a 500 (engine error) until toggled off, so 3.2 can test
 *     error mapping. Per-instance; minimal (YAGNI).
 *
 * SEAM OWNERSHIP: `DockerTransport` / `DockerResponse` are OWNED by the
 * production tree (core/src/providers/docker-transport.ts) — port-ownership
 * discipline: src/ must not import from test/. This fake IMPLEMENTS that seam
 * (type-only import below); it does not declare it.
 *
 * Exported API (minimal — only what Fase 3 needs):
 *   createDockerHttpFake(): DockerHttpFake
 *   interface DockerHttpFake  { transport; reset(); setEngineFault(on) }
 *   (plus the container-model types 3.2/3.3 narrow against)
 */

import type {
  DockerResponse,
  DockerTransport,
} from "../../src/providers/docker-transport.js";

// ---------------------------------------------------------------------------
// Container model — just rich enough for 3.2 observe/apply/verify + 3.3 env
// ---------------------------------------------------------------------------

/**
 * The create payload 3.2 sends (subset of Engine's ContainerCreate). Only the
 * fields a Service maps to: Image, Env (3.3 injects resolved secrets here),
 * exposed ports, bind volumes, and Labels (3.2's observe/idempotency key).
 */
export interface ContainerCreateBody {
  readonly Image: string;
  readonly Cmd?: readonly string[];
  readonly Env?: readonly string[];
  readonly Labels?: Readonly<Record<string, string>>;
  /** Container ports exposed, Engine shape: `{ "80/tcp": {} }`. */
  readonly ExposedPorts?: Readonly<Record<string, Record<string, never>>>;
  readonly HostConfig?: {
    /** Bind mounts, Engine shape: `["/host:/ctr"]`. */
    readonly Binds?: readonly string[];
    /** Restart policy, Engine shape: `{ Name: "on-failure" }` (gap #4). */
    readonly RestartPolicy?: { readonly Name?: string };
  };
  /** Engine healthcheck, durations in ns (gap #2, Phase 2.1). */
  readonly Healthcheck?: {
    readonly Test?: readonly string[];
    readonly Interval?: number;
    readonly Timeout?: number;
    readonly Retries?: number;
    readonly StartPeriod?: number;
  };
}

/** A container as the fake holds it (Engine-ish inspect/list projection). */
export interface FakeContainer {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  /** Engine Cmd — present only when the create body set it (gap #1). */
  readonly Cmd?: readonly string[];
  /** Restart policy — present only when the create body set it (gap #4). */
  readonly RestartPolicy?: { readonly Name?: string };
  /** Engine healthcheck — present only when the create body set it (Phase 2.1). */
  readonly Healthcheck?: ContainerCreateBody["Healthcheck"];
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly ExposedPorts: Readonly<Record<string, Record<string, never>>>;
  readonly Binds: readonly string[];
  /** "running" | "exited" — the minimal lifecycle 3.2 verify() needs. */
  State: "running" | "exited";
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Scripted result for `POST /exec/{id}/start`. The migration runner (5.x)
 * only inspects exitCode + stderr (SQLSTATE classification); stdout is kept
 * for completeness so the same fake can serve any future psql-driven test.
 */
export interface FakeExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A predicate over the Cmd argv that, on first match, picks a scripted result. */
export type FakeExecMatcher = (cmd: readonly string[]) => boolean;

/** Per-call record of every exec context the fake has handed out. */
export interface FakeExecCall {
  readonly containerId: string;
  readonly cmd: readonly string[];
  readonly execId: string;
  /** Flipped true once `POST /exec/{id}/start` is invoked. */
  started: boolean;
}

export interface DockerHttpFake {
  /** Drop-in `DockerTransport` for DockerProvider — never touches network/SSH. */
  readonly transport: DockerTransport;
  /** Clear all containers, the id counter and the engine-fault toggle. */
  reset(): void;
  /** While true, every transport call → 500 engine error (fatal-ish). */
  setEngineFault(on: boolean): void;
  /**
   * Drive a container's `State.Health.Status` over successive inspects (2.0.3).
   * Each inspect consumes one status; the LAST value sticks once the queue
   * drains. A container with no setHealth returns inspect WITHOUT `State.Health`
   * (the no-HEALTHCHECK case wait-for-healthy degrades on). Keyed by container
   * name (the `?name=` used at create).
   */
  setHealth(name: string, statuses: readonly string[]): void;
  /**
   * Seed image-default exposed ports (Bug 6). The real Engine's inspect
   * `Config.ExposedPorts` includes the ports the IMAGE exposes (e.g. nginx →
   * 80/tcp), not only those set at create. A container created from `image`
   * then carries these in inspect, so a test can prove isConverged tolerates
   * image-default ports beyond the manifest's declared set.
   */
  setImageExposedPorts(image: string, ports: readonly string[]): void;
  /** Mark an image absent → ContainerCreate 404s until it is pulled (Bug 4). */
  setImageAbsent(ref: string): void;
  /** Make `POST /images/create` report an in-stream error for `ref` (Bug 4). */
  failPull(ref: string): void;
  /** Mark an image present locally → `GET /images/<ref>/json` → 200 (Bug 11). */
  setImagePresent(ref: string): void;
  /** Read the `X-Registry-Auth` value captured on the pull of `ref` (Bug 11). */
  capturedRegistryAuth(ref: string): string | undefined;
  /** Set the default scripted result for `POST /exec/{id}/start`. */
  setExecResult(result: FakeExecResult): void;
  /**
   * Register a Cmd-predicate → scripted result mapping. Predicates are tried
   * in registration order; the first match wins, else the default applies.
   */
  setExecResultByMatcher(predicate: FakeExecMatcher, result: FakeExecResult): void;
  /** Read-only audit log of every exec context the fake has created. */
  readonly execCallLog: ReadonlyArray<FakeExecCall>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDockerHttpFake(): DockerHttpFake {
  // --- per-instance state (closure; no global/static) ---------------------
  const containers = new Map<string, FakeContainer>(); // by Id
  let counter = 0;
  let engineFault = false;
  // 2.0.3: per-container health queue, keyed by container Name. Absent ⇒ the
  // inspect response carries no State.Health (no-HEALTHCHECK case).
  const health = new Map<string, string[]>();
  // image → default exposed ports (Bug 6): merged into a container's inspect.
  const imagePorts = new Map<string, readonly string[]>();
  // Image pull state (Bug 4). Faithful to the Engine: ContainerCreate 404s on
  // an absent image. Default permissive (an image not marked absent is
  // creatable); a test marks one absent to force a pull, or fails its pull.
  const presentImages = new Set<string>(); // pulled / locally present
  const absentImages = new Set<string>(); // not present until pulled
  const failedPulls = new Set<string>(); // /images/create reports in-stream error
  // Bug 11: captures the X-Registry-Auth header value sent to /images/create,
  // keyed by image ref, so a test can assert the base64url the provider built.
  const capturedRegistryAuth = new Map<string, string>();

  // exec subsystem state (Task 4.1) ---------------------------------------
  interface ExecContext {
    readonly containerId: string;
    readonly cmd: readonly string[];
  }
  const execs = new Map<string, ExecContext>(); // by execId
  let nextExecId = 0;
  const defaultExecResult: FakeExecResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  let execResult: FakeExecResult = defaultExecResult;
  const execMatchers: Array<{
    predicate: FakeExecMatcher;
    result: FakeExecResult;
  }> = [];
  const execCallLog: FakeExecCall[] = [];

  /** Current health for a container Name, consuming one queued status per
   * call; the last value sticks once the queue is down to one. undefined ⇒
   * no health was scripted (no-HEALTHCHECK). */
  function currentHealth(name: string): string | undefined {
    const q = health.get(name);
    if (!q || q.length === 0) return undefined;
    return q.length === 1 ? q[0] : q.shift();
  }

  function fresh(): void {
    containers.clear();
    counter = 0;
    engineFault = false;
    health.clear();
    imagePorts.clear();
    presentImages.clear();
    absentImages.clear();
    failedPulls.clear();
    capturedRegistryAuth.clear();
    execs.clear();
    nextExecId = 0;
    execResult = defaultExecResult;
    execMatchers.length = 0;
    execCallLog.length = 0;
  }

  function ok(status: number, json: unknown): DockerResponse {
    return { status, json };
  }

  function err(status: number, message: string): DockerResponse {
    // Engine API error envelope: { message: string }.
    return { status, json: { message } };
  }

  function byName(name: string): FakeContainer | undefined {
    for (const c of containers.values()) if (c.Name === name) return c;
    return undefined;
  }

  /** `/containers/<id>/<verb>` → ["<id>", "<verb>"]; tolerant of leading "/". */
  function containerIdAndVerb(
    path: string,
  ): { id: string; verb: string | undefined } | null {
    const segs = path.split("?")[0]!.split("/").filter(Boolean);
    // ["containers", "<id>", "<verb>?"]  — "create"/"json" handled separately
    if (segs[0] !== "containers" || segs.length < 2) return null;
    return { id: segs[1]!, verb: segs[2] };
  }

  function request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<DockerResponse> {
    return Promise.resolve(route(method.toUpperCase(), path, body, headers));
  }

  function route(
    method: string,
    rawPath: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): DockerResponse {
    // Engine fault is checked BEFORE routing so any call exercises it.
    if (engineFault) {
      return err(500, "fake engine fault");
    }

    const path = rawPath.split("?")[0]!;
    const url = new URL(`http://tunnel${rawPath}`); // parse query only

    // --- GET /images/<ref>/json (docker inspect image) — Bug 11 -------
    // Faithful to the Engine: 200 with a minimal inspect if the image is
    // present locally, 404 (error envelope) if absent. ensureImage's
    // skip-if-exists probes this with encodeURIComponent(full ref).
    {
      const segs = path.split("/").filter(Boolean); // ["images","<enc-ref>","json"]
      if (
        method === "GET" &&
        segs[0] === "images" &&
        segs.length === 3 &&
        segs[2] === "json"
      ) {
        const ref = decodeURIComponent(segs[1]!);
        return presentImages.has(ref)
          ? ok(200, { Id: `sha256:fake-${ref}`, RepoTags: [ref] })
          : err(404, `no such image: ${ref}`);
      }
    }

    // --- POST /images/create (docker pull) — NDJSON stream -------------
    if (method === "POST" && path === "/images/create") {
      const fromImage = url.searchParams.get("fromImage") ?? "";
      const tag = url.searchParams.get("tag");
      // Reconstruct the image ref the way the provider's Image is keyed.
      const ref = tag ? `${fromImage}:${tag}` : fromImage;
      // Bug 11: capture the registry-auth header (the provider's base64url) so
      // a test can assert it; absent header ⇒ nothing captured for this ref.
      const auth = headers?.["X-Registry-Auth"];
      if (auth !== undefined) capturedRegistryAuth.set(ref, auth);
      if (failedPulls.has(ref)) {
        // Engine reports pull errors IN-STREAM at HTTP 200 (NDJSON array).
        return ok(200, [
          { status: `Pulling from ${fromImage}` },
          { error: `manifest for ${ref} not found`, errorDetail: { message: "manifest unknown" } },
        ]);
      }
      presentImages.add(ref);
      absentImages.delete(ref);
      return ok(200, [
        { status: `Pulling from ${fromImage}` },
        { status: `Status: Downloaded newer image for ${ref}` },
      ]);
    }

    // --- POST /containers/create ---------------------------------------
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name");
      if (!name) {
        return err(400, "container name is required (?name=)");
      }
      if (byName(name)) {
        // Engine's real behaviour: 409 on duplicate name. Lets 3.2 do
        // observe-before-create / treat as no-op.
        return err(
          409,
          `Conflict. The container name "/${name}" is already in use`,
        );
      }
      const payload = (body ?? {}) as Partial<ContainerCreateBody>;
      if (typeof payload.Image !== "string" || payload.Image.length === 0) {
        return err(400, "Image is required");
      }
      // Faithful to the Engine (Bug 4): create 404s when the image is absent
      // (marked absent and not yet pulled). Default permissive otherwise.
      if (absentImages.has(payload.Image) && !presentImages.has(payload.Image)) {
        return err(404, `No such image: ${payload.Image}`);
      }
      counter += 1;
      const container: FakeContainer = {
        Id: `c${counter}`,
        Name: name,
        Image: payload.Image,
        ...(payload.Cmd !== undefined ? { Cmd: [...payload.Cmd] } : {}),
        ...(payload.HostConfig?.RestartPolicy !== undefined
          ? { RestartPolicy: { ...payload.HostConfig.RestartPolicy } }
          : {}),
        ...(payload.Healthcheck !== undefined
          ? { Healthcheck: { ...payload.Healthcheck } }
          : {}),
        Env: [...(payload.Env ?? [])],
        Labels: { ...(payload.Labels ?? {}) },
        ExposedPorts: { ...(payload.ExposedPorts ?? {}) },
        Binds: [...(payload.HostConfig?.Binds ?? [])],
        State: "exited", // created but not started, like real Engine
      };
      containers.set(container.Id, container);
      return ok(201, { Id: container.Id, Warnings: [] });
    }

    // --- GET /containers/json (list, optional ?filters=) ----------------
    if (method === "GET" && path === "/containers/json") {
      let list = [...containers.values()];
      // FAITHFUL to the real Engine: list returns ONLY running containers
      // unless `?all=true`. A freshly-created container is "exited" (Created)
      // here, so without all=true it is hidden — exactly the behaviour that
      // exposed Bug 5 (the provider must pass all=true to find/start it).
      const allParam = url.searchParams.get("all");
      const includeAll = allParam === "true" || allParam === "1";
      if (!includeAll) list = list.filter((c) => c.State === "running");
      const filtersRaw = url.searchParams.get("filters");
      if (filtersRaw) {
        let filters: {
          label?: string[];
          name?: string[];
        } = {};
        try {
          filters = JSON.parse(filtersRaw) as typeof filters;
        } catch {
          return err(400, "invalid filters JSON");
        }
        // Engine filters are { label: ["k=v"|"k"], name: ["n"] }.
        for (const lf of filters.label ?? []) {
          const [k, v] = lf.split("=");
          list = list.filter((c) =>
            v === undefined ? k! in c.Labels : c.Labels[k!] === v,
          );
        }
        for (const nf of filters.name ?? []) {
          list = list.filter((c) => c.Name === nf);
        }
      }
      // Engine list projection: enough for 3.2 observe() (Names[], State).
      return ok(
        200,
        list
          .sort((a, b) => a.Id.localeCompare(b.Id))
          .map((c) => ({
            Id: c.Id,
            Names: [`/${c.Name}`],
            Image: c.Image,
            Labels: c.Labels,
            State: c.State === "running" ? "running" : "exited",
          })),
      );
    }

    const cv = containerIdAndVerb(path);
    if (cv) {
      const { id, verb } = cv;

      // --- DELETE /containers/{id}[?force=true] (approved-destroy) ------
      if (method === "DELETE" && verb === undefined) {
        if (!containers.has(id)) return err(404, `No such container: ${id}`);
        containers.delete(id);
        return ok(204, null);
      }

      // --- GET /containers/{id}/json (inspect) --------------------------
      if (method === "GET" && verb === "json") {
        const c = containers.get(id);
        if (!c) return err(404, `No such container: ${id}`);
        // Engine inspect projection: State.Running + full Config (incl. Env)
        // so 3.2 verify() and 3.3 env assertions can read it back.
        const healthStatus = currentHealth(c.Name);
        return ok(200, {
          Id: c.Id,
          Name: `/${c.Name}`,
          State: {
            Running: c.State === "running",
            Status: c.State,
            // 2.0.3: present ONLY when scripted via setHealth (else absent ⇒
            // no-HEALTHCHECK case for wait-for-healthy).
            ...(healthStatus !== undefined
              ? { Health: { Status: healthStatus } }
              : {}),
          },
          Config: {
            Image: c.Image,
            ...(c.Cmd !== undefined ? { Cmd: c.Cmd } : {}),
            ...(c.Healthcheck !== undefined
              ? { Healthcheck: c.Healthcheck }
              : {}),
            Env: c.Env,
            Labels: c.Labels,
            ExposedPorts: {
              // image-default ports (Bug 6) UNION the create-body ports.
              ...Object.fromEntries(
                (imagePorts.get(c.Image) ?? []).map((p) => [p, {}]),
              ),
              ...c.ExposedPorts,
            },
          },
          HostConfig: {
            Binds: c.Binds,
            ...(c.RestartPolicy !== undefined
              ? { RestartPolicy: c.RestartPolicy }
              : {}),
          },
        });
      }

      // --- POST /containers/{id}/start ----------------------------------
      if (method === "POST" && verb === "start") {
        const c = containers.get(id);
        if (!c) return err(404, `No such container: ${id}`);
        if (c.State === "running") {
          return ok(304, null); // Engine: 304 already started (idempotent)
        }
        c.State = "running";
        return ok(204, null);
      }

      // --- POST /containers/{id}/stop -----------------------------------
      if (method === "POST" && verb === "stop") {
        const c = containers.get(id);
        if (!c) return err(404, `No such container: ${id}`);
        if (c.State === "exited") {
          return ok(304, null); // Engine: 304 already stopped (idempotent)
        }
        c.State = "exited";
        return ok(204, null);
      }

      // --- POST /containers/{id}/exec (4.1) -----------------------------
      // Creates an exec CONTEXT (cmd + container) and returns its Id; the
      // command itself runs on `POST /exec/{id}/start`. Engine returns 201.
      if (method === "POST" && verb === "exec") {
        const c = containers.get(id);
        if (!c) return err(404, `No such container: ${id}`);
        const payload = (body ?? {}) as { Cmd?: readonly string[] };
        const cmd = [...(payload.Cmd ?? [])];
        nextExecId += 1;
        const execId = `exec${nextExecId}`;
        execs.set(execId, { containerId: id, cmd });
        execCallLog.push({
          containerId: id,
          cmd,
          execId,
          started: false,
        });
        return ok(201, { Id: execId });
      }
    }

    // --- POST /exec/{id}/start (4.1) -----------------------------------
    // Returns the SCRIPTED result (default 0/""/""; predicate or default
    // setter can override). Faithful enough for the runner's exit-code +
    // SQLSTATE classification.
    {
      const segs = path.split("/").filter(Boolean);
      if (
        method === "POST" &&
        segs[0] === "exec" &&
        segs[2] === "start" &&
        segs.length === 3
      ) {
        const execId = segs[1]!;
        const ctx = execs.get(execId);
        if (!ctx) return err(404, `No such exec instance: ${execId}`);
        const entry = execCallLog.find((e) => e.execId === execId);
        if (entry) entry.started = true;
        const matched = execMatchers.find((m) => m.predicate(ctx.cmd));
        const result = matched ? matched.result : execResult;
        return ok(200, { ...result });
      }
    }

    return err(404, `unknown Engine route ${method} ${path}`);
  }

  fresh();

  return {
    transport: { request },
    reset: fresh,
    setEngineFault(on) {
      engineFault = on;
    },
    setHealth(name, statuses) {
      health.set(name, [...statuses]);
    },
    setImageExposedPorts(image, ports) {
      imagePorts.set(image, [...ports]);
    },
    setImageAbsent(ref) {
      absentImages.add(ref);
    },
    failPull(ref) {
      failedPulls.add(ref);
    },
    setImagePresent(ref) {
      presentImages.add(ref);
    },
    capturedRegistryAuth(ref) {
      return capturedRegistryAuth.get(ref);
    },
    setExecResult(result) {
      execResult = { ...result };
    },
    setExecResultByMatcher(predicate, result) {
      execMatchers.push({ predicate, result: { ...result } });
    },
    execCallLog,
  };
}
