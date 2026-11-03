/**
 * core/src/providers/docker.test.ts
 *
 * Task 3.2 — drives DockerProvider against the in-process Docker Engine fake
 * (core/test/fakes/docker-http.ts) through the SSH-tunnel-shaped
 * `DockerTransport` seam. ZERO network / SSH / Docker / DB / filesystem.
 *
 * Central guarantee under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"):
 *
 *   - observe(scope) lists managed containers by the bevox label.
 *   - apply(create) converges N replica containers (create+start), then is a
 *     NO-OP (changed:false) on every repeat — proven by the provider-agnostic
 *     conformanceHarness (incl. its observe(scope) teeth) AND a write-count.
 *   - idempotency holds ACROSS ALL replicas (no duplicate container for any
 *     replica index already converged).
 *   - fail-safe: remove/destroy are no-ops — they NEVER delete a container.
 *   - the 3.2/3.3 secret boundary: env values shaped `secret:<ref>` are NOT
 *     resolved and their value/raw `secret:` string NEVER reach the container
 *     Env or observe(), BUT the envKey→ref binding is preserved in a
 *     structured non-Env label channel so 3.3 can resolve+inject at apply.
 *   - error mapping flows strictly through domain/errors.ts: engine 500 →
 *     transient; malformed Service desired → precondition (no crash).
 */

import { describe, it, expect } from "vitest";
import { createDockerHttpFake } from "../../test/fakes/docker-http.js";
import { createDockerProvider, _parseImageRef, _registryHostOf } from "./docker.js";
import { conformanceHarness, type PlanAction } from "./provider.js";
import { ReconcileError } from "../domain/errors.js";
import { ServiceSchema } from "../domain/entities.js";
import { observedAdapter } from "../reconciler/observed-adapter.js";
import { createApplyContext, type ApplyContext, type SecretResolver } from "../store/secrets.js";

// ---------------------------------------------------------------------------
// Rig: a provider wired to a fresh Docker Engine fake transport.
// ---------------------------------------------------------------------------

function makeRig() {
  const fake = createDockerHttpFake();
  const makeProvider = () =>
    createDockerProvider({ transport: fake.transport });
  return { fake, makeProvider };
}

const SERVICE_ACTION: PlanAction = {
  op: "create",
  entity: "service:api",
  desired: {
    name: "api",
    image: "bevox/api:1",
    replicas: 2,
    env: { LOG_LEVEL: "info" },
    ports: ["80", "443/tcp"],
    volumes: ["/srv/data:/data"],
    server_selector: { role: "app" },
  },
};

const SINGLE_ACTION: PlanAction = {
  op: "create",
  entity: "service:web",
  desired: { name: "web", image: "bevox/web:1", replicas: 1 },
};

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

describe("DockerProvider — observe", () => {
  it("lists only bevox-managed services by label, deduped per service", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(SERVICE_ACTION); // 2 replicas
    await p.apply(SINGLE_ACTION); // 1 replica

    const obs = await p.observe("service");
    expect(obs.scope).toBe("service");
    // One entity per Service (not per replica container).
    expect(obs.entities.map((e) => e.key).sort()).toEqual([
      "service:api",
      "service:web",
    ]);
  });

  it("returns empty when nothing managed exists", async () => {
    const { makeProvider } = makeRig();
    expect((await makeProvider().observe("service")).entities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// idempotency — conformanceHarness is the oracle
// ---------------------------------------------------------------------------

describe("DockerProvider — idempotency (conformanceHarness oracle)", () => {
  it("passes the conformance harness for a multi-replica service (observe teeth)", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, SERVICE_ACTION, "service");
  });

  it("passes the conformance harness for a single-replica service", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, SINGLE_ACTION, "service");
  });

  it("create then apply again = no-op the 2nd time across ALL replicas", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    const first = await p.apply(SERVICE_ACTION);
    expect(first.changed).toBe(true);
    expect(await p.verify(SERVICE_ACTION)).toBe(true);

    const second = await p.apply(SERVICE_ACTION);
    expect(second.changed).toBe(false);
    expect(await p.verify(SERVICE_ACTION)).toBe(true);

    // Exactly the N replica containers exist — no duplicate for any index.
    const list = (await rawList(fake)).filter((c) =>
      c.Names[0]!.startsWith("/api-"),
    );
    expect(list.map((c) => c.Names[0]).sort()).toEqual(["/api-0", "/api-1"]);
  });

  it("converges a missing replica without duplicating the existing ones", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(SERVICE_ACTION); // api-0, api-1
    // Simulate api-1 vanishing: stop+forget is not exposed; instead scale up.
    const scaled: PlanAction = {
      ...SERVICE_ACTION,
      desired: { ...(SERVICE_ACTION.desired as object), replicas: 3 },
    };
    const res = await p.apply(scaled);
    expect(res.changed).toBe(true); // api-2 created
    expect(await p.verify(scaled)).toBe(true);

    const names = (await rawList(fake)).map((c) => c.Names[0]).sort();
    expect(names).toEqual(["/api-0", "/api-1", "/api-2"]);
    fake.reset();
  });

  it("scale DOWN is fail-safe: no-op, verify true, extra container left alone, flap-pinned", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply({
      ...SERVICE_ACTION,
      desired: { ...(SERVICE_ACTION.desired as object), replicas: 3 },
    }); // api-0, api-1, api-2

    const down: PlanAction = {
      ...SERVICE_ACTION,
      desired: { ...(SERVICE_ACTION.desired as object), replicas: 2 },
    };

    // (a) scaling down creates/starts nothing -> changed:false.
    const res = await p.apply(down);
    expect(res.changed).toBe(false);
    // (b) the 2 desired replicas converge.
    expect(await p.verify(down)).toBe(true);
    // (c) fail-safe: the extra api-2 is STILL present (NOT deleted).
    const names = (await rawList(fake)).map((c) => c.Names[0]).sort();
    expect(names).toEqual(["/api-0", "/api-1", "/api-2"]);
    // (d) flap pin: a 2nd apply at replicas:2 is still a no-op.
    const second = await p.apply(down);
    expect(second.changed).toBe(false);
    expect(await p.verify(down)).toBe(true);
    fake.reset();
  });
});

// ---------------------------------------------------------------------------
// Service → container spec mapping
// ---------------------------------------------------------------------------

describe("DockerProvider — Service→container mapping", () => {
  it("maps image, ports, volumes, labels and starts every replica", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(SERVICE_ACTION);

    const inspect = await rawInspectByName(fake, "api-0");
    expect(inspect.Config.Image).toBe("bevox/api:1");
    expect(inspect.Config.ExposedPorts).toEqual({
      "80/tcp": {},
      "443/tcp": {},
    });
    expect(inspect.HostConfig.Binds).toEqual(["/srv/data:/data"]);
    expect(inspect.State.Running).toBe(true);
    // Labels carry managed marker + service identity + replica + selector.
    expect(inspect.Config.Labels["bevox.managed"]).toBe("true");
    expect(inspect.Config.Labels["bevox.service"]).toBe("api");
    expect(inspect.Config.Labels["bevox.replica"]).toBe("0");
    expect(inspect.Config.Labels["bevox.selector.role"]).toBe("app");
  });

  it("does NOT leak secret env value/ref but PRESERVES the key→ref binding for 3.3", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    const SEC_ACTION: PlanAction = {
      op: "create",
      entity: "service:sec",
      desired: {
        name: "sec",
        image: "x:1",
        replicas: 1,
        env: { PLAIN: "ok", TOKEN: "secret:db-password" },
      },
    };
    await p.apply(SEC_ACTION);

    const inspect = await rawInspectByName(fake, "sec-0");

    // (a) Env carries the plain pair and NEITHER a resolved value NOR the
    //     raw `secret:` ref string for the secret-bound key.
    expect(inspect.Config.Env).toContain("PLAIN=ok");
    expect(inspect.Config.Env.join("\n")).not.toContain("secret:db-password");
    expect(inspect.Config.Env.some((e: string) => e.startsWith("TOKEN="))).toBe(
      false,
    );

    // (b) The key→ref binding IS preserved in the structured non-Env channel
    //     (a label) so 3.3's apply path can find that TOKEN binds db-password.
    expect(inspect.Config.Labels["bevox.secret.TOKEN"]).toBe(
      "secret:db-password",
    );

    // (c) observe() never surfaces a secret value/ref — only the service key.
    const obs = await p.observe("service");
    expect(obs.entities.map((e) => e.key)).toEqual(["service:sec"]);
    expect(JSON.stringify(obs)).not.toContain("db-password");

    // (d) STABILITY ACROSS RE-APPLY (highest-risk 3.5 regression vector): a
    //     second apply of the SAME secret-bearing service is a no-op, verify
    //     stays true, and the secret-label boundary does NOT flap — the
    //     binding label is byte-identical and still no value/ref in Env.
    const second = await p.apply(SEC_ACTION);
    expect(second.changed).toBe(false);
    expect(await p.verify(SEC_ACTION)).toBe(true);

    const reinspect = await rawInspectByName(fake, "sec-0");
    expect(reinspect.Config.Labels["bevox.secret.TOKEN"]).toBe(
      "secret:db-password",
    );
    expect(reinspect.Config.Env.join("\n")).not.toContain("secret:db-password");
    expect(
      reinspect.Config.Env.some((e: string) => e.startsWith("TOKEN=")),
    ).toBe(false);
    const obs2 = await p.observe("service");
    expect(JSON.stringify(obs2)).not.toContain("db-password");
  });
});

describe("_parseImageRef (Bug 4)", () => {
  it("parses tag / default-latest / registry-port / digest forms", () => {
    expect(_parseImageRef("nginx:alpine")).toEqual({ fromImage: "nginx", tag: "alpine" });
    expect(_parseImageRef("nginx")).toEqual({ fromImage: "nginx", tag: "latest" });
    expect(_parseImageRef("reg:5000/repo:tag")).toEqual({ fromImage: "reg:5000/repo", tag: "tag" });
    expect(_parseImageRef("repo@sha256:abc123")).toEqual({ fromImage: "repo@sha256:abc123" });
  });
});

describe("_registryHostOf (Bug 11)", () => {
  it("derives the registry host; unqualified ⇒ docker.io default", () => {
    expect(_registryHostOf("ghcr.io/example-org/bevox-backend@sha256:abc")).toBe("ghcr.io");
    expect(_registryHostOf("redis:7-alpine")).toBe("docker.io");
    expect(_registryHostOf("postgres:16-alpine")).toBe("docker.io");
    expect(_registryHostOf("library/redis")).toBe("docker.io");
    expect(_registryHostOf("r:5000/img:tag")).toBe("r:5000");
    expect(_registryHostOf("localhost/img")).toBe("localhost");
  });
});

describe("DockerProvider — pulls image before create (Bug 4)", () => {
  it("pulls an absent image (POST /images/create) so ContainerCreate does not 404", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setImageAbsent("nginx:alpine"); // create would 404 without a prior pull
    const res = await p.apply({
      op: "create",
      entity: "service:nginx",
      desired: { name: "nginx", image: "nginx:alpine", replicas: 1 },
    });
    expect(res.changed).toBe(true);
    const insp = await rawInspectByName(fake, "nginx-0");
    expect(insp.State.Running).toBe(true);
  });

  it("pulls a digest-pinned image (@sha256:) before create", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    const digest = "ghcr.io/bevox/runtime@sha256:abc123";
    fake.setImageAbsent(digest);
    const res = await p.apply({
      op: "create",
      entity: "service:rt",
      desired: { name: "rt", image: digest, replicas: 1 },
    });
    expect(res.changed).toBe(true);
  });

  it("fail-closed: a pull error fails the action and creates NO container", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setImageAbsent("bad:image");
    fake.failPull("bad:image");
    await expect(
      p.apply({
        op: "create",
        entity: "service:bad",
        desired: { name: "bad", image: "bad:image", replicas: 1 },
      }),
    ).rejects.toBeInstanceOf(ReconcileError);
    const list = await fake.transport.request("GET", "/containers/json?all=true");
    expect((list.json as unknown[]).length).toBe(0);
  });
});

describe("DockerProvider — observe carries the Service payload (task 3/4)", () => {
  it("observe builds a ServiceSchema-valid payload; secret env is OMITTED (no value, no ref)", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({ transport: fake.transport });
    // A managed container whose Env carries a RESOLVED value (what a real
    // running container has) and whose bevox.secret.<k> label carries the ref.
    // observe must surface NEITHER (3.2/3.3 boundary): the secret-bound key is
    // omitted; the binding lives only on the label for the apply path.
    await fake.transport.request("POST", "/containers/create?name=backend-0", {
      Image: "ghcr.io/bevox/backend:v1",
      Env: ["DB_PASSWORD=S3CR3T-6.2-resolved-must-not-leak-XYZ", "LOG_LEVEL=info"],
      Labels: {
        "bevox.managed": "true",
        "bevox.service": "backend",
        "bevox.replica": "0",
        "bevox.secret.DB_PASSWORD": "secret:pg-pw",
      },
    });

    const obs = await provider.observe("service");
    expect(obs.entities).toHaveLength(1);
    const e = obs.entities[0]!;
    expect(e.key).toBe("service:backend");

    const parsed = ServiceSchema.safeParse(e.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("backend");
      expect(parsed.data.image).toBe("ghcr.io/bevox/backend:v1");
      expect(parsed.data.replicas).toBe(1);
      // non-secret env surfaces; the secret-bound key is OMITTED entirely.
      expect(parsed.data.env?.["LOG_LEVEL"]).toBe("info");
      expect(parsed.data.env?.["DB_PASSWORD"]).toBeUndefined();
    }
    // NEITHER the resolved value NOR the ref name leaks into the payload.
    const blob = JSON.stringify(e.payload);
    expect(blob).not.toContain("S3CR3T-6.2-resolved-must-not-leak-XYZ");
    expect(blob).not.toContain("pg-pw");
  });

  // Task 8: lock the full observe → adapter → State chain (the PERSISTED
  // snapshot surface). A sentinel resolved value seeded in Config.Env must
  // never reach the State get_state returns; neither must the ref name.
  it("sentinel: observe → adapter → State carries no resolved value, no ref name", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({ transport: fake.transport });
    await fake.transport.request("POST", "/containers/create?name=svc-0", {
      Image: "ghcr.io/bevox/svc:v1",
      Env: ["TOKEN=S3CR3T-6.2-observed-must-never-leak-XYZ", "TZ=UTC"],
      Labels: {
        "bevox.managed": "true",
        "bevox.service": "svc",
        "bevox.replica": "0",
        "bevox.secret.TOKEN": "secret:svc-token",
      },
    });

    const slice = await provider.observe("service");
    const state = observedAdapter(slice);
    const blob = JSON.stringify(state);

    // The persisted snapshot surface is non-empty (the service is present)…
    expect(state.services.map((s) => s.name)).toEqual(["svc"]);
    // …and leaks NEITHER the resolved value NOR the secret ref name.
    expect(blob).not.toContain("S3CR3T-6.2-observed-must-never-leak-XYZ");
    expect(blob).not.toContain("svc-token");
  });
});

describe("DockerProvider — skip pull when image present locally (Bug 11)", () => {
  it("present image ⇒ NO POST /images/create (skip survives a failing pull)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    const ref = "ghcr.io/bevox/runtime@sha256:present";
    fake.setImagePresent(ref); // GET /images/<ref>/json → 200
    fake.failPull(ref); // if the pull WERE reached, it would error → reject
    // skip-if-exists must short-circuit before the pull, so apply succeeds.
    const res = await p.apply({
      op: "create",
      entity: "service:rt",
      desired: { name: "rt", image: ref, replicas: 1 },
    });
    expect(res.changed).toBe(true);
    const insp = await rawInspectByName(fake, "rt-0");
    expect(insp.State.Running).toBe(true);
  });

  it("absent image ⇒ still pulls (a failing pull rejects)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    const ref = "ghcr.io/bevox/runtime@sha256:absent";
    fake.setImageAbsent(ref);
    fake.failPull(ref);
    await expect(
      p.apply({
        op: "create",
        entity: "service:rt",
        desired: { name: "rt", image: ref, replicas: 1 },
      }),
    ).rejects.toBeInstanceOf(ReconcileError);
  });
});

describe("DockerProvider — X-Registry-Auth for private registries (Bug 11)", () => {
  // Resolver returning a (JSON-encoded) {username,password} credential for any
  // ref, but ONLY behind a real ApplyContext (mirrors secrets.ts's gate).
  function credResolver(jsonValue: string): SecretResolver {
    return {
      describe(ref: string) {
        return { name: ref.replace(/^secret:/, ""), keys: [], used_by: [] };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeSchema(): any {
        throw new Error("not needed");
      },
      async resolve(ref: string, ctx: ApplyContext) {
        if (typeof ctx !== "object" || ctx === null) {
          throw new ReconcileError("fatal", "resolve refused: ApplyContext required");
        }
        return { status: "ok" as const, name: ref.replace(/^secret:/, ""), value: jsonValue };
      },
    };
  }

  const DIGEST = "ghcr.io/example-org/bevox-backend@sha256:abc";

  it("private host with a configured ref ⇒ pull carries the base64url auth-config", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      secretResolver: credResolver(JSON.stringify({ username: "bevox-bot", password: "ghp_x" })),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });
    await provider.apply({
      op: "create",
      entity: "service:bevox-backend",
      desired: { name: "bevox-backend", image: DIGEST, replicas: 1 },
      applyContext: createApplyContext(),
    });
    const expected = Buffer.from(
      JSON.stringify({ username: "bevox-bot", password: "ghp_x", serveraddress: "ghcr.io" }),
    ).toString("base64url");
    expect(fake.capturedRegistryAuth(DIGEST)).toBe(expected);
  });

  it("public host (no configured ref) ⇒ NO X-Registry-Auth", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      secretResolver: credResolver(JSON.stringify({ username: "u", password: "p" })),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" }, // docker.io NOT configured
    });
    await provider.apply({
      op: "create",
      entity: "service:redis",
      desired: { name: "redis", image: "redis:7-alpine", replicas: 1 },
      applyContext: createApplyContext(),
    });
    expect(fake.capturedRegistryAuth("redis:7-alpine")).toBeUndefined();
  });

  it("fail-closed: malformed credential ⇒ fatal, host-only message, NO pull, NO container", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      // resolves OK but the value is NOT {username,password} (missing password)
      secretResolver: credResolver(JSON.stringify({ username: "u" })),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });
    await expect(
      provider.apply({
        op: "create",
        entity: "service:bevox-backend",
        desired: { name: "bevox-backend", image: DIGEST, replicas: 1 },
        applyContext: createApplyContext(),
      }),
    ).rejects.toMatchObject({ errorClass: "fatal" });

    // No pull was issued (capture only happens on POST /images/create) and no
    // container exists — the malformed cred aborts BEFORE either.
    expect(fake.capturedRegistryAuth(DIGEST)).toBeUndefined();
    const list = await fake.transport.request("GET", "/containers/json?all=true");
    expect((list.json as unknown[]).length).toBe(0);
  });

  it("fail-closed message cites only the host, never the resolved value", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      secretResolver: credResolver('"SENTINEL-not-a-cred-object"'),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });
    try {
      await provider.apply({
        op: "create",
        entity: "service:bevox-backend",
        desired: { name: "bevox-backend", image: DIGEST, replicas: 1 },
        applyContext: createApplyContext(),
      });
      expect.fail("expected fatal");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("ghcr.io");
      expect(msg).not.toContain("SENTINEL-not-a-cred-object");
    }
  });

  it("hygiene: resolved password + base64 header never leak to report or container (Bug 11)", async () => {
    const PW = "ghp_REGISTRY_PW_LEAK_CANARY";
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      secretResolver: credResolver(JSON.stringify({ username: "bevox-bot", password: PW })),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });
    const report = await provider.apply({
      op: "create",
      entity: "service:bevox-backend",
      desired: { name: "bevox-backend", image: DIGEST, replicas: 1 },
      applyContext: createApplyContext(),
    });
    const base64 = Buffer.from(
      JSON.stringify({ username: "bevox-bot", password: PW, serveraddress: "ghcr.io" }),
    ).toString("base64url");

    // The ApplyResult (≈ StateEvent record surface) carries neither the raw
    // password nor the base64 auth blob.
    const reportBlob = JSON.stringify(report);
    expect(reportBlob).not.toContain(PW);
    expect(reportBlob).not.toContain(base64);

    // The container's Env/Labels never carry them either.
    const insp = await rawInspectByName(fake, "bevox-backend-0");
    const inspBlob = JSON.stringify(insp);
    expect(inspBlob).not.toContain(PW);
    expect(inspBlob).not.toContain(base64);

    // The base64 blob appears ONLY in the intended Engine destination
    // (capturedRegistryAuth) — that is the header, not a leak surface.
    expect(fake.capturedRegistryAuth(DIGEST)).toBe(base64);
  });

  it("no ApplyContext (plan/dry_run posture) ⇒ NO header even with a configured ref", async () => {
    const fake = createDockerHttpFake();
    const provider = createDockerProvider({
      transport: fake.transport,
      secretResolver: credResolver(JSON.stringify({ username: "u", password: "p" })),
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });
    await provider.apply({
      op: "create",
      entity: "service:bevox-backend",
      desired: { name: "bevox-backend", image: DIGEST, replicas: 1 },
      // no applyContext ⇒ resolution gated off ⇒ no header
    });
    expect(fake.capturedRegistryAuth(DIGEST)).toBeUndefined();
  });
});

describe("DockerProvider — starts freshly-created containers (Bug 5)", () => {
  it("a just-created (Created) replica is found and STARTED, and re-apply is a no-op", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    const res = await p.apply(SINGLE_ACTION); // web, replicas 1
    expect(res.changed).toBe(true);
    const insp = await rawInspectByName(fake, "web-0");
    expect(insp.State.Running).toBe(true); // STARTED — not stuck in Created
    // converged re-apply: zero mutation
    const res2 = await p.apply(SINGLE_ACTION);
    expect(res2.changed).toBe(false);
    expect(await p.verify(SINGLE_ACTION)).toBe(true);
  });
});

describe("DockerProvider — isConverged tolerates image-default ports (Bug 6)", () => {
  it("converges with NO declared ports even though the image exposes 80/tcp", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setImageExposedPorts("nginx:alpine", ["80/tcp"]);
    const action: PlanAction = {
      op: "create",
      entity: "service:nginx",
      desired: { name: "nginx", image: "nginx:alpine", replicas: 1 }, // no ports
    };
    await p.apply(action);
    expect(await p.verify(action)).toBe(true); // image's 80/tcp is not drift
  });

  it("still requires a DECLARED port to be present on the container", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setImageExposedPorts("nginx:alpine", ["80/tcp"]);
    await p.apply({
      op: "create",
      entity: "service:nginx",
      desired: { name: "nginx", image: "nginx:alpine", replicas: 1 },
    });
    // Declares 443 — the container only has the image's 80/tcp → not converged.
    expect(
      await p.verify({
        op: "create",
        entity: "service:nginx",
        desired: { name: "nginx", image: "nginx:alpine", replicas: 1, ports: ["443"] },
      }),
    ).toBe(false);
  });
});

describe("DockerProvider — services[].command -> Cmd (gap #1)", () => {
  const CMD_ACTION: PlanAction = {
    op: "create",
    entity: "service:redis",
    desired: {
      name: "redis",
      image: "redis:7",
      replicas: 1,
      command: ["redis-server", "--appendonly", "yes"],
    },
  };

  it("maps command to container Cmd when declared", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(CMD_ACTION);
    const insp = await rawInspectByName(fake, "redis-0");
    expect(insp.Config.Cmd).toEqual(["redis-server", "--appendonly", "yes"]);
  });

  it("omits Cmd when command not declared (byte-identical body)", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(SINGLE_ACTION);
    const insp = await rawInspectByName(fake, "web-0");
    expect("Cmd" in insp.Config).toBe(false);
  });

  it("isConverged: declared command drift -> verify() false; omitted -> not compared", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(CMD_ACTION);
    expect(await p.verify(CMD_ACTION)).toBe(true);
    const drifted: PlanAction = {
      ...CMD_ACTION,
      desired: {
        ...(CMD_ACTION.desired as object),
        command: ["redis-server", "--maxmemory", "1gb"],
      },
    };
    expect(await p.verify(drifted)).toBe(false);
  });
});

describe("DockerProvider — services[].restart -> HostConfig.RestartPolicy (gap #4)", () => {
  const RESTART_ACTION: PlanAction = {
    op: "create",
    entity: "service:api",
    desired: {
      name: "api",
      image: "bevox/api:1",
      replicas: 1,
      volumes: ["/srv/data:/data"],
      restart: "on-failure",
    },
  };

  it("sets RestartPolicy.Name and preserves Binds when volumes also present", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(RESTART_ACTION);
    const insp = await rawInspectByName(fake, "api-0");
    expect(insp.HostConfig.RestartPolicy.Name).toBe("on-failure");
    expect(insp.HostConfig.Binds).toEqual(["/srv/data:/data"]);
  });

  it("omits RestartPolicy when restart not declared (byte-identical body)", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(SINGLE_ACTION);
    const insp = await rawInspectByName(fake, "web-0");
    expect("RestartPolicy" in (insp.HostConfig ?? {})).toBe(false);
  });

  it("isConverged: declared restart drift -> verify() false", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(RESTART_ACTION);
    expect(await p.verify(RESTART_ACTION)).toBe(true);
    const drifted: PlanAction = {
      ...RESTART_ACTION,
      desired: { ...(RESTART_ACTION.desired as object), restart: "always" },
    };
    expect(await p.verify(drifted)).toBe(false);
  });
});

describe("DockerProvider — services[].healthcheck -> ContainerCreate.Healthcheck (2.1.2)", () => {
  const HC_ACTION: PlanAction = {
    op: "create",
    entity: "service:pg",
    desired: {
      name: "pg",
      image: "postgres:16",
      replicas: 1,
      healthcheck: {
        test: ["CMD", "pg_isready", "-U", "bevox"],
        interval: "10s",
        timeout: "5s",
        retries: 5,
        start_period: "30s",
      },
    },
  };

  it("maps healthcheck to the Engine Healthcheck with nanosecond durations", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(HC_ACTION);
    const insp = await rawInspectByName(fake, "pg-0");
    expect(insp.Config.Healthcheck.Test).toEqual([
      "CMD",
      "pg_isready",
      "-U",
      "bevox",
    ]);
    expect(insp.Config.Healthcheck.Interval).toBe(10_000_000_000);
    expect(insp.Config.Healthcheck.Timeout).toBe(5_000_000_000);
    expect(insp.Config.Healthcheck.Retries).toBe(5);
    expect(insp.Config.Healthcheck.StartPeriod).toBe(30_000_000_000);
  });

  it("omits Healthcheck when not declared (byte-identical body)", async () => {
    const { fake, makeProvider } = makeRig();
    await makeProvider().apply(SINGLE_ACTION);
    const insp = await rawInspectByName(fake, "web-0");
    expect("Healthcheck" in insp.Config).toBe(false);
  });

  it("isConverged: declared healthcheck test drift -> verify() false", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(HC_ACTION);
    expect(await p.verify(HC_ACTION)).toBe(true);
    const drifted: PlanAction = {
      ...HC_ACTION,
      desired: {
        ...(HC_ACTION.desired as object),
        healthcheck: { test: ["CMD", "false"] },
      },
    };
    expect(await p.verify(drifted)).toBe(false);
  });
});

describe("DockerProvider — depends_on never leaks into container shape (2.0.2)", () => {
  const base = { name: "dep-app", image: "x:1", replicas: 1 };

  it("body has no depends_on key; isConverged ignores depends_on changes", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply({
      op: "create",
      entity: "service:dep-app",
      desired: { ...base, depends_on: ["db"] },
    });
    const insp = await rawInspectByName(fake, "dep-app-0");
    expect("depends_on" in insp.Config).toBe(false);
    expect("depends_on" in (insp.HostConfig ?? {})).toBe(false);

    // isConverged ignores depends_on entirely: converged with the original,
    // AND still converged when depends_on differs (it is not compared).
    expect(
      await p.verify({
        op: "create",
        entity: "service:dep-app",
        desired: { ...base, depends_on: ["db"] },
      }),
    ).toBe(true);
    expect(
      await p.verify({
        op: "create",
        entity: "service:dep-app",
        desired: { ...base, depends_on: ["other-dep"] },
      }),
    ).toBe(true);
  });
});

describe("DockerProvider — verify() detects mapped-field drift", () => {
  it("a drifted exposed port → verify() false", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(SERVICE_ACTION);
    expect(await p.verify(SERVICE_ACTION)).toBe(true);

    // Same Service, but the desired port set drifts from what was created.
    const drifted: PlanAction = {
      ...SERVICE_ACTION,
      desired: {
        ...(SERVICE_ACTION.desired as object),
        ports: ["8080"],
      },
    };
    expect(await p.verify(drifted)).toBe(false);
    fake.reset();
  });
});

// ---------------------------------------------------------------------------
// fail-safe — never fail-deleting
// ---------------------------------------------------------------------------

describe("DockerProvider — destroy() removes a service's containers (Bug 8, approved-only)", () => {
  it("removes all replicas (DELETE force), idempotent on re-destroy", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(SERVICE_ACTION); // api, replicas 2
    expect((await p.observe("service")).entities.map((e) => e.key)).toContain(
      "service:api",
    );
    const res = await p.destroy!({
      op: "destroy",
      entity: "service:api",
      desired: {},
    });
    expect(res.changed).toBe(true);
    expect((await p.observe("service")).entities).toEqual([]); // both replicas gone
    const res2 = await p.destroy!({
      op: "destroy",
      entity: "service:api",
      desired: {},
    });
    expect(res2.changed).toBe(false); // idempotent — already gone
  });

  it("apply(op:'destroy') is STILL a no-op — reconcile-path fail-safe intact", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(SERVICE_ACTION);
    const res = await p.apply({ ...SERVICE_ACTION, op: "destroy" });
    expect(res.changed).toBe(false);
    expect((await p.observe("service")).entities.map((e) => e.key)).toContain(
      "service:api",
    ); // NOT removed
  });
});

describe("DockerProvider — fail-safe (never fail-deleting)", () => {
  it("remove/destroy ops are no-ops and delete nothing", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(SERVICE_ACTION);

    for (const op of ["remove", "destroy"] as const) {
      const res = await p.apply({ ...SERVICE_ACTION, op });
      expect(res.changed).toBe(false);
    }
    // Fail-safe: containers still present.
    expect((await p.observe("service")).entities.map((e) => e.key)).toEqual([
      "service:api",
    ]);
  });
});

// ---------------------------------------------------------------------------
// error mapping (via domain/errors.ts)
// ---------------------------------------------------------------------------

describe("DockerProvider — error mapping (via domain/errors.ts)", () => {
  it("engine 500 → transient ReconcileError", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setEngineFault(true);

    await expect(p.observe("service")).rejects.toMatchObject({
      errorClass: "transient",
    });
  });

  it("malformed Service desired → precondition (no crash)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await expect(
      p.apply({
        op: "create",
        entity: "service:bad",
        desired: { name: "bad", replicas: "lots" },
      }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });

  it("unknown scope → precondition (no silent crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(makeProvider().observe("dragon")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("engine 500 during apply create → transient (no partial leak)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setEngineFault(true);
    await expect(p.apply(SINGLE_ACTION)).rejects.toBeInstanceOf(ReconcileError);
  });
});

// ---------------------------------------------------------------------------
// Volume-name bind resolution via the optional resolveVolumeMount seam.
// spec: 2026-06-01-volume-hetzner-bind-automount.md §3
// ---------------------------------------------------------------------------

describe("DockerProvider — resolveVolumeMount bind resolution (createBody)", () => {
  const PG_ACTION: PlanAction = {
    op: "create",
    entity: "service:db",
    desired: {
      name: "db",
      image: "pg:16",
      replicas: 1,
      volumes: ["pg-data:/var/lib/postgresql/data"],
    },
  };

  it("resolves `<name>:<path>` to the real Hetzner mount when the resolver matches", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({
      transport: fake.transport,
      resolveVolumeMount: async (n) =>
        n === "pg-data" ? "/mnt/HC_Volume_42" : undefined,
    });
    await p.apply(PG_ACTION);
    const insp = await rawInspectByName(fake, "db-0");
    expect(insp.HostConfig.Binds).toEqual([
      "/mnt/HC_Volume_42:/var/lib/postgresql/data",
    ]);
  });

  it("AS-IS when NO resolver is supplied", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({ transport: fake.transport });
    await p.apply(PG_ACTION);
    const insp = await rawInspectByName(fake, "db-0");
    expect(insp.HostConfig.Binds).toEqual([
      "pg-data:/var/lib/postgresql/data",
    ]);
  });

  it("AS-IS when the resolver returns undefined for the name", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({
      transport: fake.transport,
      resolveVolumeMount: async () => undefined,
    });
    await p.apply(PG_ACTION);
    const insp = await rawInspectByName(fake, "db-0");
    expect(insp.HostConfig.Binds).toEqual([
      "pg-data:/var/lib/postgresql/data",
    ]);
  });

  it("AS-IS for an absolute host-path bind (resolver NOT consulted)", async () => {
    const fake = createDockerHttpFake();
    let consulted = false;
    const p = createDockerProvider({
      transport: fake.transport,
      resolveVolumeMount: async () => {
        consulted = true;
        return "/mnt/HC_Volume_99";
      },
    });
    await p.apply({
      op: "create",
      entity: "service:web",
      desired: {
        name: "web",
        image: "nginx:1",
        replicas: 1,
        volumes: ["/srv/data:/data"],
      },
    });
    const insp = await rawInspectByName(fake, "web-0");
    expect(insp.HostConfig.Binds).toEqual(["/srv/data:/data"]);
    expect(consulted).toBe(false);
  });

  it("AS-IS for a bare name (no ':') — resolver NOT consulted", async () => {
    const fake = createDockerHttpFake();
    let consulted = false;
    const p = createDockerProvider({
      transport: fake.transport,
      resolveVolumeMount: async () => {
        consulted = true;
        return "/mnt/HC_Volume_99";
      },
    });
    await p.apply({
      op: "create",
      entity: "service:web",
      desired: {
        name: "web",
        image: "nginx:1",
        replicas: 1,
        volumes: ["data"],
      },
    });
    const insp = await rawInspectByName(fake, "web-0");
    expect(insp.HostConfig.Binds).toEqual(["data"]);
    expect(consulted).toBe(false);
  });
});

describe("DockerProvider — resolveVolumeMount idempotency lock (isConverged)", () => {
  const PG_ACTION: PlanAction = {
    op: "create",
    entity: "service:db",
    desired: {
      name: "db",
      image: "pg:16",
      replicas: 1,
      volumes: ["pg-data:/var/lib/postgresql/data"],
    },
  };

  it("re-apply with a resolver is a NO-OP (isConverged resolves binds identically)", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({
      transport: fake.transport,
      resolveVolumeMount: async (n) =>
        n === "pg-data" ? "/mnt/HC_Volume_42" : undefined,
    });

    const first = await p.apply(PG_ACTION);
    expect(first.changed).toBe(true);
    expect(await p.verify(PG_ACTION)).toBe(true);

    // The container was created with the RESOLVED bind.
    const insp = await rawInspectByName(fake, "db-0");
    expect(insp.HostConfig.Binds).toEqual([
      "/mnt/HC_Volume_42:/var/lib/postgresql/data",
    ]);

    // 2nd apply: isConverged must resolve `pg-data:...` to the same
    // `/mnt/HC_Volume_42:...` before comparing — else it flaps into re-create.
    const second = await p.apply(PG_ACTION);
    expect(second.changed).toBe(false);
    expect(await p.verify(PG_ACTION)).toBe(true);

    const dbs = (await rawList(fake)).filter((c) =>
      c.Names[0]!.startsWith("/db-"),
    );
    expect(dbs.map((c) => c.Names[0]).sort()).toEqual(["/db-0"]);
  });

  it("regression: no resolver, bare-name bind still converges AS-IS", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({ transport: fake.transport });
    const action: PlanAction = {
      op: "create",
      entity: "service:web",
      desired: { name: "web", image: "nginx:1", replicas: 1, volumes: ["data"] },
    };
    expect((await p.apply(action)).changed).toBe(true);
    expect(await p.verify(action)).toBe(true);
    expect((await p.apply(action)).changed).toBe(false);
    expect(await p.verify(action)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// test-only helpers (read the fake directly through the same transport seam)
// ---------------------------------------------------------------------------

interface ListItem {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
}

async function rawList(
  fake: ReturnType<typeof createDockerHttpFake>,
): Promise<ListItem[]> {
  const res = await fake.transport.request("GET", "/containers/json");
  return res.json as ListItem[];
}

async function rawInspectByName(
  fake: ReturnType<typeof createDockerHttpFake>,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const list = await fake.transport.request("GET", "/containers/json");
  const items = list.json as ListItem[];
  const found = items.find((c) => c.Names[0] === `/${name}`);
  if (!found) throw new Error(`container ${name} not found in fake`);
  const insp = await fake.transport.request(
    "GET",
    `/containers/${found.Id}/json`,
  );
  return insp.json;
}
