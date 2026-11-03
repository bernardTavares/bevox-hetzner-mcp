/**
 * core/src/providers/hetzner-cloud.test.ts
 *
 * Task 2.4 — drives HetznerCloudProvider against the in-process Hetzner HTTP
 * fake (core/test/fakes/hetzner-http.ts). ZERO network / DB / filesystem.
 *
 * Central guarantee under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"):
 *
 *   - observe(scope) lists existing servers/networks/volumes via getAllPages
 *     (multi-page walks terminate).
 *   - apply(create) converges (changed:true) then is a NO-OP (changed:false)
 *     the 2nd time — proven by the provider-agnostic conformanceHarness
 *     (including its observe(scope) teeth assertion) AND by a write-count.
 *   - error mapping flows strictly through domain/errors.ts: 429 → transient,
 *     401 → fatal, missing referenced network → precondition (detected BEFORE
 *     the create), malformed desired → precondition (no crash).
 */

import { describe, it, expect } from "vitest";
import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import {
  createCaptureHetznerHttpFake,
  type CaptureHetznerHttpFakeOptions,
} from "../../test/fakes/hetzner-http-capture.js";
import { HttpClient } from "./http-client.js";
import { createHetznerCloudProvider } from "./hetzner-cloud.js";
import { ServerSchema, NetworkSchema, VolumeSchema } from "../domain/entities.js";
import { conformanceHarness, type PlanAction } from "./provider.js";
import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Harness: a provider wired to a fresh fake, with zero-delay retry seams so
// the 429 path is deterministic and fast.
// ---------------------------------------------------------------------------

function makeRig() {
  const fake = createHetznerHttpFake();
  const makeProvider = () =>
    createHetznerCloudProvider({
      token: "secret-token",
      baseUrl: "https://api.hetzner.cloud/v1",
      http: new HttpClient({
        fetchImpl: fake.fetch,
        sleep: async () => {},
        random: () => 0,
        defaultHeaders: { Authorization: "Bearer secret-token" },
      }),
    });
  return { fake, makeProvider };
}

describe("observe carries rich entities.ts-shaped payloads (task 3)", () => {
  it("server observe payload is ServerSchema-valid with mapped wire fields", async () => {
    const { fake, makeProvider } = makeRig();
    fake.seed("servers", {
      name: "bevox-prod-1",
      server_type: { name: "cpx22" },
      datacenter: { location: { name: "nbg1" } },
      image: { name: "ubuntu-24.04" },
      public_net: { ipv4: { ip: "1.2.3.4" } },
      labels: { app: "bevox" },
      status: "running",
    });
    const obs = await makeProvider().observe("server");
    expect(obs.entities).toHaveLength(1);
    const e = obs.entities[0]!;
    expect(e.key).toBe("server:bevox-prod-1");
    const parsed = ServerSchema.safeParse(e.payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("cpx22");
      expect(parsed.data.image).toBe("ubuntu-24.04");
      expect(parsed.data.location).toBe("nbg1");
      expect(parsed.data.hcloud_id).toBe(1);
    }
  });

  it("network + volume observe payloads are schema-valid with mapped fields", async () => {
    const { fake, makeProvider } = makeRig();
    fake.seed("networks", {
      name: "bevox-priv",
      ip_range: "10.0.0.0/16",
      subnets: [{ ip_range: "10.0.1.0/24" }],
    });
    fake.seed("volumes", { name: "pg-data", size: 20, format: "ext4", linux_device: "/dev/x" });
    const p = makeProvider();

    const net = (await p.observe("network")).entities[0]!;
    const np = NetworkSchema.safeParse(net.payload);
    expect(np.success).toBe(true);
    if (np.success) {
      expect(np.data.ip_range).toBe("10.0.0.0/16");
      expect(np.data.subnets).toEqual(["10.0.1.0/24"]);
    }

    const vol = (await p.observe("volume")).entities[0]!;
    const vp = VolumeSchema.safeParse(vol.payload);
    expect(vp.success).toBe(true);
    if (vp.success) expect(vp.data.fs).toBe("ext4");
  });
});

const NETWORK_ACTION: PlanAction = {
  op: "create",
  entity: "network:mesh",
  desired: { name: "mesh", ip_range: "10.0.0.0/16", subnets: [] },
};

const SERVER_ACTION: PlanAction = {
  op: "create",
  entity: "server:app-1",
  desired: {
    name: "app-1",
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-24.04",
    ssh_keys: [],
    labels: {},
    network: "mesh",
    status: "pending",
  },
};

const VOLUME_ACTION: PlanAction = {
  op: "create",
  entity: "volume:data",
  desired: { name: "data", size: "10", fs: "ext4" },
};

describe("HetznerCloudProvider — observe", () => {
  it("lists servers/networks/volumes across pages via getAllPages", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    // Create 60 networks (fake default per_page=25 → 3 pages) to prove the
    // pagination cursor is followed to exhaustion.
    for (let i = 0; i < 60; i++) {
      await p.apply({
        op: "create",
        entity: `network:n${i}`,
        desired: { name: `n${i}`, ip_range: "10.0.0.0/16", subnets: [] },
      });
    }

    const obs = await p.observe("network");
    expect(obs.scope).toBe("network");
    expect(obs.entities).toHaveLength(60);
    expect(obs.entities.map((e) => e.key)).toContain("network:n0");
    expect(obs.entities.map((e) => e.key)).toContain("network:n59");

    // Other scopes are empty and isolated.
    expect((await p.observe("server")).entities).toEqual([]);
    expect((await p.observe("volume")).entities).toEqual([]);
    fake.reset();
  });
});

describe("HetznerCloudProvider — idempotency (conformanceHarness oracle)", () => {
  it("passes the conformance harness for a network (with observe scope teeth)", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, NETWORK_ACTION, "network");
  });

  it("passes the conformance harness for a volume (with observe scope teeth)", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, VOLUME_ACTION, "volume");
  });

  it("create server then apply again = no-op the 2nd time (write-count pinned)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(NETWORK_ACTION); // satisfy the network precondition

    const first = await p.apply(SERVER_ACTION);
    expect(first.changed).toBe(true);
    expect(await p.verify(SERVER_ACTION)).toBe(true);

    const second = await p.apply(SERVER_ACTION);
    expect(second.changed).toBe(false);
    expect(await p.verify(SERVER_ACTION)).toBe(true);

    // Exactly one server exists — no duplicate created.
    expect((await p.observe("server")).entities.map((e) => e.key)).toEqual([
      "server:app-1",
    ]);
  });

  it("server passes the conformance harness once its network exists", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(() => {
      const p = makeProvider();
      // Pre-seed the network dependency so the server action can converge.
      return {
        name: p.name,
        observe: (s: string) => p.observe(s),
        verify: (a: PlanAction) => p.verify(a),
        apply: async (a: PlanAction) => {
          await p.apply(NETWORK_ACTION);
          return p.apply(a);
        },
      };
    }, SERVER_ACTION, "server");
  });
});

describe("HetznerCloudProvider — error mapping (via domain/errors.ts)", () => {
  it("429 from the API → transient ReconcileError", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    // Exhaust retries so the classified error surfaces (maxRetries default 3
    // → 4 attempts; 5 faults guarantees terminal 429).
    fake.setRateLimitFault({ times: 5, retryAfter: 1 });

    await expect(p.observe("network")).rejects.toMatchObject({
      errorClass: "transient",
    });
  });

  it("401 from the API → fatal ReconcileError", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setAuthFault(true);

    await expect(p.observe("server")).rejects.toMatchObject({
      errorClass: "fatal",
    });
  });

  it("server referencing a missing network → precondition (before create)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    let caught: unknown;
    try {
      await p.apply(SERVER_ACTION); // "mesh" network does not exist
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    expect((caught as ReconcileError).errorClass).toBe("precondition");
    // Fail-safe: no server was created by the failed precondition path.
    expect((await p.observe("server")).entities).toEqual([]);
  });

  it("malformed desired → precondition (no crash)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    await expect(
      p.apply({ op: "create", entity: "network:bad", desired: { ip_range: 42 } }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });

  it("does not leak the token in error messages", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setAuthFault(true);

    try {
      await p.observe("server");
      throw new Error("expected a ReconcileError");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret-token");
    }
  });

  it("does not leak the token when the create POST path fails", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    // Fault the auth so the create POST (write path) fails, not just reads.
    fake.setAuthFault(true);

    try {
      await p.apply(NETWORK_ACTION);
      throw new Error("expected a ReconcileError");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret-token");
    }
  });
});

describe("HetznerCloudProvider — scope guard", () => {
  it("rejects an unknown scope as precondition (no silent crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(makeProvider().observe("dragon")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("non-create/converge ops are deferred (no-op, handled in later tasks)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(NETWORK_ACTION);
    const res = await p.apply({
      op: "destroy",
      entity: "network:mesh",
      desired: { name: "mesh", ip_range: "10.0.0.0/16", subnets: [] },
    });
    expect(res.changed).toBe(false);
    // Fail-safe: the destroy op did NOT delete the network.
    expect((await p.observe("network")).entities.map((e) => e.key)).toEqual([
      "network:mesh",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wire shape tests (capture fake) — Task 1.1 / 1.2 / 2.1 / 2.2 / 2.3 / 3.1 / 3.2 / 4.1
// ---------------------------------------------------------------------------

/** Build a provider wired to the capture fake (NOT the stateful fake). */
function makeWireRig(opts?: CaptureHetznerHttpFakeOptions) {
  const capture = createCaptureHetznerHttpFake(opts);
  const makeProvider = () =>
    createHetznerCloudProvider({
      token: "fake-token",
      baseUrl: "https://api.hetzner.cloud/v1",
      http: new HttpClient({
        fetchImpl: capture.fetchImpl,
        sleep: async () => {},
        random: () => 0,
        defaultHeaders: { Authorization: "Bearer fake-token" },
      }),
    });
  return { capture, makeProvider };
}

describe("HetznerCloudProvider — wire shape (capture fake)", () => {
  it("network create POSTs subnets as array of objects with cloud/eu-central defaults", async () => {
    const { capture, makeProvider } = makeWireRig();
    const provider = makeProvider();
    await provider.apply({
      op: "create",
      entity: "network:bevox-priv",
      desired: { name: "bevox-priv", ip_range: "10.50.0.0/16", subnets: ["10.50.1.0/24"] },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      name: "bevox-priv",
      ip_range: "10.50.0.0/16",
      subnets: [
        { ip_range: "10.50.1.0/24", type: "cloud", network_zone: "eu-central" },
      ],
    });
  });

  it("network create with empty subnets sends subnets: []", async () => {
    const { capture, makeProvider } = makeWireRig();
    await makeProvider().apply({
      op: "create",
      entity: "network:bare",
      desired: { name: "bare", ip_range: "10.99.0.0/16", subnets: [] },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0]?.body).toEqual({ name: "bare", ip_range: "10.99.0.0/16", subnets: [] });
  });

  it("server create renames type→server_type and resolves network name→id", async () => {
    const { capture, makeProvider } = makeWireRig({
      collections: { networks: [{ id: 42, name: "bevox-priv" }] },
    });
    await makeProvider().apply({
      op: "create",
      entity: "server:app-1",
      desired: {
        name: "app-1",
        type: "cx22",
        image: "ubuntu-22.04",
        location: "nbg1",
        network: "bevox-priv",
        ssh_keys: ["k1"],
        labels: { role: "app" },
        status: "pending",
      },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toMatch(/\/v1\/servers$/);
    expect(posts[0]?.body).toEqual({
      name: "app-1",
      server_type: "cx22",
      image: "ubuntu-22.04",
      location: "nbg1",
      networks: [42],
      ssh_keys: ["k1"],
      labels: { role: "app" },
    });
    // crucially, NO `type` and NO `network` (string) leak through:
    expect((posts[0]?.body as Record<string, unknown>)["type"]).toBeUndefined();
    expect((posts[0]?.body as Record<string, unknown>)["network"]).toBeUndefined();
    // omitted user_data ⇒ no user_data key (byte-identical body).
    expect((posts[0]?.body as Record<string, unknown>)["user_data"]).toBeUndefined();
  });

  it("server create passes servers[].user_data (cloud-init) into the Hetzner body when declared (Bug 3)", async () => {
    const { capture, makeProvider } = makeWireRig({
      collections: { networks: [{ id: 42, name: "bevox-priv" }] },
    });
    const cloudInit = "#cloud-config\npackages: [docker.io]\n";
    await makeProvider().apply({
      op: "create",
      entity: "server:app-1",
      desired: {
        name: "app-1",
        type: "cx22",
        image: "ubuntu-24.04",
        location: "nbg1",
        network: "bevox-priv",
        ssh_keys: ["k1"],
        labels: {},
        status: "pending",
        user_data: cloudInit,
      },
    });
    const posts = capture.requests.filter((r) => r.method === "POST");
    expect((posts[0]?.body as Record<string, unknown>)["user_data"]).toBe(
      cloudInit,
    );
  });

  it("server create with missing network throws precondition BEFORE any server POST", async () => {
    const { capture, makeProvider } = makeWireRig({ collections: { networks: [] } });
    await expect(
      makeProvider().apply({
        op: "create",
        entity: "server:orphan-1",
        desired: {
          name: "orphan-1",
          type: "cx22",
          image: "ubuntu-22.04",
          location: "nbg1",
          network: "no-such-net",
          ssh_keys: [],
          labels: {},
          status: "pending",
        },
      })
    ).rejects.toMatchObject({
      errorClass: "precondition",
      entity: "server:orphan-1",
    });
    // GETs (the listAll for findByName) may have happened, but no POST may have.
    const serverPosts = capture.requests.filter(
      r => r.method === "POST" && /\/v1\/servers$/.test(r.url),
    );
    expect(serverPosts).toHaveLength(0);
  });

  it("volume create (attached) renames fs→format, parses size, and resolves server id", async () => {
    const { capture, makeProvider } = makeWireRig({
      collections: { servers: [{ id: 7, name: "app-1" }] },
    });
    await makeProvider().apply({
      op: "create",
      entity: "volume:data-1",
      desired: { name: "data-1", size: "10G", fs: "xfs", server: "app-1" },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0]?.url).toMatch(/\/v1\/volumes$/);
    expect(posts[0]?.body).toEqual({
      name: "data-1",
      size: 10,
      format: "xfs",
      automount: true,
      server: 7,
    });
  });

  it("volume create (standalone) omits server and includes location", async () => {
    const { capture, makeProvider } = makeWireRig();
    await makeProvider().apply({
      op: "create",
      entity: "volume:cold-1",
      desired: { name: "cold-1", size: "100", fs: "ext4", location: "nbg1" },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0]?.body).toEqual({
      name: "cold-1",
      size: 100,
      format: "ext4",
      automount: true,
      location: "nbg1",
    });
    expect((posts[0]?.body as Record<string, unknown>)["server"]).toBeUndefined();
  });

  // Bug fix / feature: automount on volume create so Hetzner formats the NEW
  // volume once and mounts it at /mnt/HC_Volume_<id> (data-safe, never
  // reformats). mount_path stays advisory and is NOT sent.
  // spec: 2026-06-01-volume-hetzner-bind-automount.md §2
  it("volume create sends automount:true alongside format; mount_path is NOT sent", async () => {
    const { capture, makeProvider } = makeWireRig();
    await makeProvider().apply({
      op: "create",
      entity: "volume:pg-data",
      desired: {
        name: "pg-data",
        size: "20",
        fs: "ext4",
        location: "nbg1",
        mount_path: "/var/lib/postgresql/data",
      },
    });
    const posts = capture.requests.filter((r) => r.method === "POST");
    const body = posts[0]?.body as Record<string, unknown>;
    expect(body["automount"]).toBe(true);
    expect(body["format"]).toBe("ext4");
    expect(body["mount_path"]).toBeUndefined();
  });

  it("volume create rejects unparseable size as precondition (e.g. '500M')", async () => {
    const { makeProvider } = makeWireRig();
    await expect(
      makeProvider().apply({
        op: "create",
        entity: "volume:bad-1",
        desired: { name: "bad-1", size: "500M", fs: "ext4", location: "nbg1" },
      })
    ).rejects.toMatchObject({ errorClass: "precondition", entity: "volume:bad-1" });
  });

  it("create network then create server resolving its id — both bodies wire-correct, in order", async () => {
    // 1. Create the network using a standalone rig (no seeded networks yet).
    const { capture, makeProvider } = makeWireRig();
    const provider = makeProvider();

    await provider.apply({
      op: "create",
      entity: "network:bevox-priv",
      desired: { name: "bevox-priv", ip_range: "10.50.0.0/16", subnets: ["10.50.1.0/24"] },
    });

    const networkPost = capture.requests.find(
      r => r.method === "POST" && /\/v1\/networks$/.test(r.url),
    );
    expect(networkPost?.body).toEqual({
      name: "bevox-priv",
      ip_range: "10.50.0.0/16",
      subnets: [{ ip_range: "10.50.1.0/24", type: "cloud", network_zone: "eu-central" }],
    });

    // 2. Second rig: server apply with pre-seeded network for findByName.
    // (The capture fake is stateless for list responses — we pre-seed for the GET lookup.)
    const { capture: cap2, makeProvider: makeProvider2 } = makeWireRig({
      collections: { networks: [{ id: 1, name: "bevox-priv" }] },
    });
    await makeProvider2().apply({
      op: "create",
      entity: "server:app-1",
      desired: {
        name: "app-1",
        type: "cx22",
        image: "ubuntu-22.04",
        location: "nbg1",
        network: "bevox-priv",
        ssh_keys: [],
        labels: {},
        status: "pending",
      },
    });
    const serverPost = cap2.requests.find(
      r => r.method === "POST" && /\/v1\/servers$/.test(r.url),
    );
    expect(serverPost?.body).toMatchObject({
      name: "app-1",
      server_type: "cx22",
      networks: [1],
    });
  });
});
