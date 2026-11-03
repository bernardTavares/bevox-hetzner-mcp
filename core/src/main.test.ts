/**
 * core/src/main.test.ts
 *
 * Task 7.1 — TDD for the runnable daemon entrypoint. It proves the PURE
 * wiring module (buildBootDeps) and main()'s fail-fast process discipline
 * WITHOUT a real listening daemon, real network, real SSH or real signals:
 *
 *   - Hetzner Cloud + DNS go GENUINELY LIVE: buildBootDeps constructs them
 *     over a real HttpClient. A capturing fetch seam proves the Authorization
 *     header carries the CONFIGURED token and the request hits the CORRECT
 *     real base URL (Cloud API vs the separate hcloud DNS API) — and that no
 *     token is ever logged/leaked.
 *   - SSH-backed Docker/WG/restic are built from the injected transport
 *     factory; the full ProviderRoutes is assembled so server.ts's
 *     fail-fast preconditions (providers/loadDesired/writeDesired required)
 *     are satisfied end-to-end.
 *   - A production boot WITHOUT a transports factory fails fast with a
 *     value-free precondition NAMING the missing piece (never a silent
 *     no-op backend) — the SSH transports arrive in Task 7.2.
 *   - loadConfig failure (missing secret) aborts value-free, non-zero exit,
 *     NO secret in any stream (the 1.9/3.3 sentinel).
 *   - main() installs a single graceful shutdown and exits cleanly.
 *
 * No real process is spawned; main() is exercised via injected process
 * seams (env, exit, signal install, server factory).
 */

import { describe, it, expect, vi } from "vitest";

import {
  buildBootDeps,
  type BuildOptions,
  runMain,
  type EntrypointTransports,
} from "./entrypoint-wiring.js";
import { loadConfig } from "./config.js";
import { HttpClient } from "./providers/http-client.js";
import type { DockerTransport } from "./providers/docker-transport.js";
import type { WireGuardController } from "./providers/wireguard-transport.js";
import type { ResticTransport } from "./providers/backup-restic-transport.js";
import { ReconcileError } from "./domain/errors.js";
import type { BootDeps } from "./server.js";
import type { Logger, LogFields } from "./observability/logger.js";
import { createSopsCliFake } from "../test/fakes/sops-cli.js";

// ---------------------------------------------------------------------------
// Fixtures — a secret-laced env (every secret MUST be sentinel-checked never
// to appear in any boot output) + in-memory transport fakes.
// ---------------------------------------------------------------------------

const SECRET = "S3CR3T-7.1-must-never-leak-Qx7";

function envFor(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: `postgres://u:db-${SECRET}@localhost:5432/bevox`,
    HCLOUD_TOKEN: `hcloud-${SECRET}`,
    HCLOUD_DNS_TOKEN: `dns-${SECRET}`,
    RESTIC_REPO: "sftp:b@v:/r",
    RESTIC_PASSWORD: `restic-${SECRET}`,
    SSH_HOST: "10.0.0.1",
    SSH_USER: "deploy",
    SSH_PRIVATE_KEY: `key-${SECRET}`,
    AGENT_CREDENTIALS: JSON.stringify({
      "tok-vox": { actor: "agent:vox", capabilities: ["get_state"] },
    }),
    // Task 5.2 — sops-age resolver paths (placeholders; filesystem validation
    // happens in validateSopsAgeConfig at boot, not in ConfigSchema).
    SECRETS_FILE: "/tmp/secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age.key",
    ...over,
  };
}

const fakeDocker: DockerTransport = {
  async request() {
    return { status: 200, json: [] };
  },
};
const fakeWg: WireGuardController = {
  async listPeers() {
    return [];
  },
  async setPeer() {},
  async removePeer() {},
};
const fakeRestic: ResticTransport = {
  async snapshots() {
    return [];
  },
  async backup() {
    return { id: "s1", time: "2026-05-18T00:00:00Z" };
  },
  async restore() {},
};

function fakeTransports(): EntrypointTransports {
  return {
    docker: () => fakeDocker,
    wireguard: () => fakeWg,
    restic: () => fakeRestic,
  };
}

// ---------------------------------------------------------------------------
// Task 5.3 — `buildBootDeps` now validates sops-age preconditions BEFORE
// opening any resource. This file's env supplies placeholder paths
// (`/tmp/secrets.yaml`, `/tmp/age.key`) that don't exist as 0o600 regular
// files on every dev box, so we inject fs+spawn fakes via BuildOptions.
// Production omits BuildOptions ⇒ falls back to real `node:fs` + the real
// `realSpawnWrapper` adapter (Task 4.1).
// ---------------------------------------------------------------------------

function defaultBuildOpts(): BuildOptions {
  const fakeFs = {
    lstatSync: (path: string) => {
      if (path !== "/tmp/secrets.yaml" && path !== "/tmp/age.key") {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return {
        isFile: () => true,
        mode: 0o600,
        uid: process.getuid!(),
      };
    },
  };
  const fakeSpawn = createSopsCliFake();
  fakeSpawn.setResponse({
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  return { fs: fakeFs, spawn: fakeSpawn.spawn };
}

// ---------------------------------------------------------------------------
// buildBootDeps — the pure wiring (no process, no real network/SSH)
// ---------------------------------------------------------------------------

describe("buildBootDeps — pure daemon wiring", () => {
  it("assembles ProviderRoutes covering every routed kind", async () => {
    const config = loadConfig(envFor());
    const deps = await buildBootDeps(config, fakeTransports(), defaultBuildOpts());

    expect(deps.providers).toBeDefined();
    const r = deps.providers!;
    expect(r.network.name).toBe("hetzner-cloud");
    expect(r.volume.name).toBe("hetzner-cloud");
    expect(r.server.map((p) => p.name).sort()).toEqual([
      "hetzner-cloud",
      "wireguard",
    ]);
    expect(r.service?.name).toBe("docker");
    expect(r.dns?.name).toBe("hetzner-dns");
    expect(r.backup?.name).toBe("backup-restic");
    expect(typeof deps.loadDesired).toBe("function");
    expect(typeof deps.writeDesired).toBe("function");
    expect(deps.logger).toBeDefined();
  });

  it("Hetzner Cloud goes LIVE: real HttpClient, configured token, Cloud API base URL", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({ url, auth: headers.get("authorization") });
      return new Response(JSON.stringify({ servers: [], meta: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const config = loadConfig(envFor());
    const deps = await buildBootDeps(config, fakeTransports(), {
      ...defaultBuildOpts(),
      httpFor: (token) =>
        new HttpClient({
          defaultHeaders: { Authorization: `Bearer ${token}` },
          fetchImpl: capturingFetch,
        }),
    });

    await deps.providers!.network.observe("network:any");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/^https:\/\/api\.hetzner\.cloud\/v1\//);
    // The Authorization header MUST carry the configured Cloud token …
    expect(seen[0]!.auth).toBe(`Bearer ${config.HCLOUD_TOKEN}`);
  });

  it("Hetzner DNS goes LIVE on the SEPARATE hcloud DNS API base URL", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({ url, auth: headers.get("authorization") });
      return new Response(JSON.stringify({ zones: [], meta: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const config = loadConfig(envFor());
    const deps = await buildBootDeps(config, fakeTransports(), {
      ...defaultBuildOpts(),
      httpFor: (token) =>
        new HttpClient({
          defaultHeaders: { Authorization: `Bearer ${token}` },
          fetchImpl: capturingFetch,
        }),
    });

    await deps.providers!.dns!.observe("dns");

    expect(seen.length).toBeGreaterThan(0);
    // The hcloud DNS API is a DISTINCT origin from the Cloud API.
    expect(seen[0]!.url).toMatch(/^https:\/\/dns\.hetzner\.com\/api\/v1\//);
    expect(seen[0]!.url).not.toMatch(/api\.hetzner\.cloud/);
    expect(seen[0]!.auth).toBe(`Bearer ${config.HCLOUD_DNS_TOKEN}`);
  });

  it("SSH providers are built from the injected transport factory (config passed through)", async () => {
    const calls: string[] = [];
    const config = loadConfig(envFor());
    const transports: EntrypointTransports = {
      docker: (cfg) => {
        calls.push(`docker:${cfg.SSH_HOST}`);
        return fakeDocker;
      },
      wireguard: (cfg) => {
        calls.push(`wg:${cfg.SSH_USER}`);
        return fakeWg;
      },
      restic: (cfg) => {
        calls.push(`restic:${cfg.RESTIC_REPO}`);
        return fakeRestic;
      },
    };
    await buildBootDeps(config, transports, defaultBuildOpts());
    expect(calls.sort()).toEqual([
      "docker:10.0.0.1",
      "restic:sftp:b@v:/r",
      "wg:deploy",
    ]);
  });

  it("missing transports factory ⇒ value-free fail-fast naming the missing piece (no silent no-op backend)", async () => {
    const config = loadConfig(envFor());
    let err: unknown;
    try {
      await buildBootDeps(
        config,
        // deliberately omitting the required transports seam.
        undefined as unknown as EntrypointTransports,
        defaultBuildOpts(),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    const msg = (err as ReconcileError).message;
    expect((err as ReconcileError).errorClass).toBe("precondition");
    expect(msg).toMatch(/transport/i);
    // value-free: NO secret in the precondition message.
    expect(msg).not.toContain(SECRET);
  });

  it("loadDesired/writeDesired round-trip in-process DesiredState by scope", async () => {
    const config = loadConfig(envFor());
    const deps = await buildBootDeps(config, fakeTransports(), defaultBuildOpts());
    expect(await deps.loadDesired!("server")).toEqual({});
    await deps.writeDesired!("server", { servers: [] });
    expect(await deps.loadDesired!("server")).toEqual({ servers: [] });
    // scope-keyed: an untouched scope stays empty.
    expect(await deps.loadDesired!("dns")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// runMain — the thin process shell (injected process seams; no real daemon)
// ---------------------------------------------------------------------------

describe("runMain — process shell", () => {
  it("loadConfig failure ⇒ value-free abort, non-zero exit, NO secret leaked", async () => {
    const out: string[] = [];
    const exits: number[] = [];
    const code = await runMain({
      // HCLOUD_TOKEN missing → loadConfig throws value-free.
      env: envFor({ HCLOUD_TOKEN: undefined }),
      transports: fakeTransports(),
      // start MUST NOT be reached.
      start: async () => {
        throw new Error("startServer must not be called on a config failure");
      },
      log: (line) => out.push(line),
      exit: (c) => {
        exits.push(c);
      },
    });

    expect(code).not.toBe(0);
    expect(exits[0]).not.toBe(0);
    const all = out.join("\n");
    expect(all).toMatch(/invalid configuration|HCLOUD_TOKEN/);
    // 1.9/3.3 sentinel — no secret material anywhere in the failure output.
    expect(all).not.toContain(SECRET);
  });

  it("missing transports ⇒ value-free fail-fast before any daemon, non-zero exit", async () => {
    const out: string[] = [];
    let started = false;
    const code = await runMain({
      env: envFor(),
      // no transports → buildBootDeps fails fast.
      transports: undefined,
      start: async () => {
        started = true;
        throw new Error("must not start");
      },
      log: (line) => out.push(line),
      exit: () => {},
    });
    expect(started).toBe(false);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/transport/i);
    expect(out.join("\n")).not.toContain(SECRET);
  });

  it("emits the v1 in-process desired-state warning EXACTLY ONCE at boot, value-free, structured", async () => {
    // Capture every logger call via the wrapBootDeps test seam (no real pino).
    const warns: Array<{ fields: LogFields; msg: string }> = [];
    const infos: number[] = [];
    const errors: number[] = [];
    const wrapBootDeps = (d: BootDeps): BootDeps => {
      const capturing: Logger = {
        info: () => infos.push(1),
        warn: (fields, msg) => warns.push({ fields, msg }),
        error: () => errors.push(1),
      };
      return { ...d, logger: capturing };
    };

    const code = await runMain({
      env: envFor(),
      transports: fakeTransports(),
      buildOpts: defaultBuildOpts(),
      wrapBootDeps,
      start: async () =>
        ({
          rest: {} as never,
          mcp: {} as never,
          breakers: new Map(),
          health: { snapshot: () => ({} as never) },
          stop: async () => {},
        }) as never,
      log: () => {},
      exit: () => {},
      waitForShutdown: async () => {},
    });

    expect(code).toBe(0);
    // EXACTLY ONCE at boot — not per reconcile cycle.
    expect(warns).toHaveLength(1);
    const w = warns[0]!;
    // Structured per the 6.3 logger discipline: mandatory observability fields.
    expect(w.fields.actor).toBe("system:boot");
    expect(w.fields.scope).toBe("daemon");
    expect(w.fields.entity).toBe("config");
    expect(w.fields.subsystem).toBe("desired-state");
    // Names the deferral + the tracked follow-up.
    expect(w.fields.followUp).toBe(70);
    expect(w.msg).toMatch(/in-process|non-durable/i);
    expect(w.msg).toMatch(/restart/i);
    expect(w.msg).toMatch(/follow-up #70/);
    // Value-free 1.9/3.3 sentinel: NO secret anywhere in the warning.
    const blob = `${w.msg} ${JSON.stringify(w.fields)}`;
    expect(blob).not.toContain(SECRET);
  });

  it("happy path: builds, starts, returns 0, stop() wired to a single graceful shutdown", async () => {
    const stop = vi.fn(async () => {});
    let installed = false;
    const code = await runMain({
      env: envFor(),
      transports: fakeTransports(),
      buildOpts: defaultBuildOpts(),
      start: async (config, deps) => {
        // server.ts's required seams must be present (proves full wiring).
        expect(deps.providers).toBeDefined();
        expect(deps.loadDesired).toBeDefined();
        expect(deps.writeDesired).toBeDefined();
        expect(config.PORT).toBe(8787);
        return {
          rest: {} as never,
          mcp: {} as never,
          breakers: new Map(),
          health: { snapshot: () => ({} as never) },
          stop,
        };
      },
      onStarted: () => {
        installed = true;
      },
      log: () => {},
      exit: () => {},
      // Resolve immediately instead of waiting for a real signal.
      waitForShutdown: async () => {},
    });
    expect(code).toBe(0);
    expect(installed).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
