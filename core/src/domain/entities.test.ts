// core/src/domain/entities.test.ts
import { describe, it, expect } from "vitest";
import {
  ServerSchema,
  ServiceSchema,
  StateSchema,
  StateEventSchema,
} from "./entities.js";
import {
  ServerSchema as ConsoleServer,
  StateSchema as ConsoleState,
} from "../../../console/src/api/contract.js"; // downstream oracle

const validServer = {
  name: "bevox-app-1", type: "cx32", location: "nbg1",
  image: "ubuntu-24.04", ssh_keys: ["k1"], labels: { app: "x" },
  network: "bevox-priv", status: "healthy",
};

describe("ServiceSchema — depends_on reaches the provider (gap #2, Phase 2.0)", () => {
  it("retains depends_on short form (no longer stripped)", () => {
    const r = ServiceSchema.parse({
      name: "app",
      image: "img",
      replicas: 1,
      depends_on: ["db"],
    });
    expect(r.depends_on).toEqual(["db"]);
  });

  it("retains depends_on object form with wait_healthy_timeout", () => {
    const r = ServiceSchema.parse({
      name: "app",
      image: "img",
      replicas: 1,
      depends_on: [{ name: "db", wait_healthy_timeout: "120s" }],
    });
    expect(r.depends_on).toEqual([{ name: "db", wait_healthy_timeout: "120s" }]);
  });

  it("ServerSchema retains user_data (cloud-init reaches the provision body)", () => {
    const s = ServerSchema.parse({
      name: "s",
      type: "cx22",
      location: "nbg1",
      network: "net",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      user_data: "#cloud-config\n",
    });
    expect(s.user_data).toBe("#cloud-config\n");
  });

  it("retains healthcheck so it reaches the provider (Phase 2.1)", () => {
    const r = ServiceSchema.parse({
      name: "pg",
      image: "postgres:16",
      replicas: 1,
      healthcheck: { test: ["CMD", "pg_isready"], retries: 3, interval: "10s" },
    });
    expect(r.healthcheck).toEqual({
      test: ["CMD", "pg_isready"],
      retries: 3,
      interval: "10s",
    });
  });
});

describe("entities ↔ console contract", () => {
  it("a core-valid Server is console-valid", () => {
    expect(() => ServerSchema.parse(validServer)).not.toThrow();
    expect(() => ConsoleServer.parse(validServer)).not.toThrow();
  });
  // Spec docs/specs/2026-05-27-server-schema-status-default.md — manifest-shape
  // input (status absent) parses with the "pending" default. Output stays
  // non-nullable; the oracle "core output → console-valid" holds.
  it("ServerSchema parses manifest-shape input (no status) with 'pending' default", () => {
    const manifestServer = {
      name: "bevox-app-1",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-22.04",
      ssh_keys: ["k1"],
      labels: { app: "x" },
      network: "bevox-priv",
    };
    const parsed = ServerSchema.parse(manifestServer);
    expect(parsed.status).toBe("pending");
  });
  it("ServerSchema output (default-filled status) stays console-valid", () => {
    const manifestServer = {
      name: "bevox-app-2",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-22.04",
      ssh_keys: [],
      labels: {},
      network: "bevox-priv",
    };
    const coreOut = ServerSchema.parse(manifestServer);
    expect(() => ConsoleServer.parse(coreOut)).not.toThrow();
  });
  it("StateSchema has the six collections the console expects", () => {
    const empty = { servers: [], networks: [], volumes: [], services: [], dns: [], backups: [] };
    expect(() => StateSchema.parse(empty)).not.toThrow();
    expect(() => ConsoleState.parse(empty)).not.toThrow();
  });
  it("StateEvent requires ts, actor, op, entity, result", () => {
    expect(() => StateEventSchema.parse({ actor: "vox" })).toThrow();
  });
});
