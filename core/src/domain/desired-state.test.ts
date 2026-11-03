/**
 * core/src/domain/desired-state.test.ts
 *
 * TDD tests for parseManifest — Task 1.3.
 *
 * Assertions:
 *  (a) parsing manifest-ok.yaml yields a typed DesiredState with
 *      servers/services/backups populated.
 *  (b) the dead env_from field is dropped (silently stripped by the
 *      non-strict item schema); env: { K: "secret:<ref>" } is the channel.
 *  (c) parsing manifest-bad.yaml throws a ReconcileError whose class is
 *      "precondition" and whose message includes file and line context.
 *  (d) [C1] unknown top-level key (typo like servics:) throws precondition.
 *  (e) [C2] duplicate names within a collection throw precondition.
 *  (f) [I4] non-object/empty/scalar/sequence roots throw precondition.
 *  (g) [M2] YAML syntax error message includes line/col context.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { parseManifest } from "./desired-state.js";
import { ReconcileError } from "./errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to fixture files
const fixturesDir = join(__dirname, "../../test/fixtures");
const okFixture = join(fixturesDir, "manifest-ok.yaml");
const badFixture = join(fixturesDir, "manifest-bad.yaml");

// ---------------------------------------------------------------------------
// (a) Valid manifest produces a typed DesiredState
// ---------------------------------------------------------------------------

describe("parseManifest — valid manifest", () => {
  it("parses manifest-ok.yaml and returns a DesiredState", () => {
    const yaml = readFileSync(okFixture, "utf-8");
    const state = parseManifest(yaml, { sourcePath: okFixture });

    expect(state).toBeDefined();

    // servers
    expect(Array.isArray(state.servers)).toBe(true);
    expect(state.servers).toHaveLength(1);
    const server = state.servers![0]!;
    expect(server.name).toBe("bevox-app-1");
    expect(server.type).toBe("cx32");
    expect(server.location).toBe("nbg1");
    expect(server.network).toBe("bevox-priv");

    // services
    expect(Array.isArray(state.services)).toBe(true);
    expect(state.services).toHaveLength(1);
    const svc = state.services![0]!;
    expect(svc.name).toBe("bevox-harness");
    expect(svc.replicas).toBe(2);

    // backups
    expect(Array.isArray(state.backups)).toBe(true);
    expect(state.backups).toHaveLength(1);
    const backup = state.backups![0]!;
    expect(backup.target).toBe("volume:pg-data");
    expect(backup.schedule).toBe("0 3 * * *");
    expect(backup.retention).toBe("14d");
  });

  // -------------------------------------------------------------------------
  // (b) the dead env_from field is removed — silently stripped by the
  //     non-strict item schema. The only working secret channel is
  //     env: { KEY: "secret:<ref>" } (see manifest-schema-cheatsheet.md).
  // -------------------------------------------------------------------------

  it("drops the dead env_from field (silently stripped, non-strict item schema)", () => {
    const state = parseManifest(
      "services:\n  - name: s\n    image: img\n    replicas: 1\n    env_from: secret:legacy\n",
      { sourcePath: "inline" },
    );
    const svc = state.services![0]!;
    expect("env_from" in svc).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) Invalid manifest throws ReconcileError("precondition") with file/line
// ---------------------------------------------------------------------------

describe("parseManifest — invalid manifest", () => {
  it("throws ReconcileError with class precondition for bad manifest", () => {
    const yaml = readFileSync(badFixture, "utf-8");

    expect(() => parseManifest(yaml, { sourcePath: badFixture })).toThrow(
      ReconcileError,
    );
  });

  it("error class is 'precondition'", () => {
    const yaml = readFileSync(badFixture, "utf-8");
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: badFixture });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
  });

  it("error message includes the sourcePath", () => {
    const yaml = readFileSync(badFixture, "utf-8");
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: badFixture });
    } catch (e) {
      caught = e;
    }
    const err = caught as ReconcileError;
    expect(err.message).toContain(badFixture);
  });

  // [M2] YAML syntax error test — also asserts line/col context in message
  it("throws ReconcileError for YAML syntax error with line context", () => {
    const malformedYaml = `
servers:
  - name: bevox-app-1
    broken: [unclosed bracket
`;
    let caught: unknown;
    try {
      parseManifest(malformedYaml, { sourcePath: "inline-test.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    // Should include source path and line information
    expect(err.message).toContain("inline-test.yaml");
    // [M2] Regression guard: line/col must appear in the message
    expect(err.message).toMatch(/line \d+, col \d+/);
  });
});

// ---------------------------------------------------------------------------
// [C1] Unknown top-level keys → precondition (fail-safe typo guard)
// ---------------------------------------------------------------------------

describe("parseManifest — C1: unknown top-level keys rejected", () => {
  it("throws ReconcileError('precondition') when top-level key is a typo (servics:)", () => {
    // 'servics:' is a typo for 'servers:' — without .strict() this silently
    // drops all declared servers.  With .strict() it must be a precondition error.
    const yaml = `
servics:
  - name: bevox-app-1
    type: cx32
    location: nbg1
    network: bevox-priv
`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "typo-test.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    // The error message must reference the unknown key
    expect(err.message).toContain("servics");
  });

  it("accepts manifests with only known top-level keys", () => {
    const yaml = `
servers:
  - name: app-1
    type: cx21
    location: fsn1
    network: default-net
`;
    const state = parseManifest(yaml, { sourcePath: "known-keys.yaml" });
    expect(state.servers).toHaveLength(1);
    expect(state.servers![0]!.name).toBe("app-1");
  });
});

// ---------------------------------------------------------------------------
// [C2] Duplicate names within a collection → precondition
// ---------------------------------------------------------------------------

describe("parseManifest — C2: duplicate identifiers rejected", () => {
  it("throws ReconcileError('precondition') for duplicate server names", () => {
    const yaml = `
servers:
  - name: app-1
    type: cx21
    location: fsn1
    network: default-net
  - name: app-1
    type: cx32
    location: nbg1
    network: default-net
`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "dup-servers.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    // Message must name the collection and the duplicated value
    expect(err.message).toContain("servers");
    expect(err.message).toContain("app-1");
  });

  it("throws ReconcileError('precondition') for duplicate service names", () => {
    const yaml = `
services:
  - name: api
    image: registry/api:latest
    replicas: 1
  - name: api
    image: registry/api:v2
    replicas: 2
`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "dup-services.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("services");
    expect(err.message).toContain("api");
  });

  it("throws ReconcileError('precondition') for duplicate network names", () => {
    const yaml = `
networks:
  - name: priv-net
    ip_range: 10.0.0.0/16
  - name: priv-net
    ip_range: 10.1.0.0/16
`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "dup-networks.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("networks");
    expect(err.message).toContain("priv-net");
  });

  it("throws ReconcileError('precondition') for duplicate DNS records (zone+name+type)", () => {
    const yaml = `
dns:
  - zone: example.com
    name: www
    type: A
    value: 1.2.3.4
  - zone: example.com
    name: www
    type: A
    value: 5.6.7.8
`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "dup-dns.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("dns");
    // The composite key zone:name:type must appear in the message
    expect(err.message).toContain("example.com:www:A");
  });

  it("accepts collections with all unique names", () => {
    const yaml = `
servers:
  - name: app-1
    type: cx21
    location: fsn1
    network: default-net
  - name: app-2
    type: cx32
    location: nbg1
    network: default-net
`;
    const state = parseManifest(yaml, { sourcePath: "unique-names.yaml" });
    expect(state.servers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// [I4] Non-object / empty / scalar / sequence roots → precondition
// ---------------------------------------------------------------------------

describe("parseManifest — servers[].user_data (Bug 3, cloud-init)", () => {
  it("parses servers[].user_data as a passthrough string", () => {
    const state = parseManifest(
      "servers:\n  - name: s\n    type: cx22\n    location: nbg1\n    network: net\n    user_data: |\n      #cloud-config\n      packages: [docker.io]\n",
      { sourcePath: "inline" },
    );
    expect(state.servers![0]!.user_data).toContain("#cloud-config");
    expect(state.servers![0]!.user_data).toContain("docker.io");
  });
});

describe("parseManifest — services[].command (gap #1)", () => {
  it("parses command as a string[]", () => {
    const state = parseManifest(
      'services:\n  - name: redis\n    image: redis:7\n    replicas: 1\n    command: ["redis-server", "--appendonly", "yes"]\n',
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.command).toEqual([
      "redis-server",
      "--appendonly",
      "yes",
    ]);
  });

  it("rejects a non-array command as a precondition", () => {
    expect(() =>
      parseManifest(
        'services:\n  - name: redis\n    image: redis:7\n    replicas: 1\n    command: "redis-server"\n',
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });
});

describe("parseManifest — services[].restart (gap #4)", () => {
  it("parses a valid restart policy", () => {
    const state = parseManifest(
      "services:\n  - name: s\n    image: img\n    replicas: 1\n    restart: always\n",
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.restart).toBe("always");
  });

  it("rejects an out-of-enum restart policy as a precondition", () => {
    expect(() =>
      parseManifest(
        "services:\n  - name: s\n    image: img\n    replicas: 1\n    restart: sometimes\n",
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });
});

describe("parseManifest — services[].depends_on (gap #2)", () => {
  it("parses the short (string) form", () => {
    const state = parseManifest(
      'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on: ["postgres"]\n',
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.depends_on).toEqual(["postgres"]);
  });

  it("parses the object form with wait_healthy_timeout", () => {
    const state = parseManifest(
      'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on:\n      - { name: postgres, wait_healthy_timeout: "120s" }\n',
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.depends_on).toEqual([
      { name: "postgres", wait_healthy_timeout: "120s" },
    ]);
  });

  it("accepts a minutes duration (2m)", () => {
    const state = parseManifest(
      'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on:\n      - { name: pg, wait_healthy_timeout: "2m" }\n',
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.depends_on).toEqual([
      { name: "pg", wait_healthy_timeout: "2m" },
    ]);
  });

  it("rejects a unit-less duration (120) as a precondition", () => {
    expect(() =>
      parseManifest(
        'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on:\n      - { name: pg, wait_healthy_timeout: "120" }\n',
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });

  it("rejects a millisecond duration (120ms) as a precondition", () => {
    expect(() =>
      parseManifest(
        'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on:\n      - { name: pg, wait_healthy_timeout: "120ms" }\n',
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });

  it("rejects an empty dep name as a precondition", () => {
    expect(() =>
      parseManifest(
        'services:\n  - name: app\n    image: img\n    replicas: 1\n    depends_on:\n      - { name: "" }\n',
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });
});

describe("parseManifest — services[].healthcheck (gap #2, Phase 2.1)", () => {
  it("parses a compose-style healthcheck", () => {
    const state = parseManifest(
      'services:\n  - name: pg\n    image: postgres:16\n    replicas: 1\n    healthcheck:\n      test: ["CMD", "pg_isready", "-U", "bevox"]\n      interval: "10s"\n      timeout: "5s"\n      retries: 5\n      start_period: "30s"\n',
      { sourcePath: "inline" },
    );
    expect(state.services![0]!.healthcheck).toEqual({
      test: ["CMD", "pg_isready", "-U", "bevox"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    });
  });

  it("rejects an empty test array as a precondition", () => {
    expect(() =>
      parseManifest(
        "services:\n  - name: pg\n    image: x\n    replicas: 1\n    healthcheck:\n      test: []\n",
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });

  it("rejects a non-integer retries as a precondition", () => {
    expect(() =>
      parseManifest(
        'services:\n  - name: pg\n    image: x\n    replicas: 1\n    healthcheck:\n      test: ["CMD", "true"]\n      retries: 2.5\n',
        { sourcePath: "inline" },
      ),
    ).toThrow(ReconcileError);
  });
});

// ---------------------------------------------------------------------------
// [I4] Non-object / empty / scalar / sequence roots → precondition
// ---------------------------------------------------------------------------

describe("parseManifest — I4: non-object root rejected", () => {
  it("throws precondition for an empty/comment-only file", () => {
    const yaml = `# just a comment\n`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "empty.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("empty.yaml");
    expect(err.message).toContain("manifest root must be a YAML mapping");
  });

  it("throws precondition for a scalar root", () => {
    const yaml = `hello\n`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "scalar.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("scalar.yaml");
    expect(err.message).toContain("manifest root must be a YAML mapping");
  });

  it("throws precondition for a sequence root", () => {
    const yaml = `- a\n- b\n`;
    let caught: unknown;
    try {
      parseManifest(yaml, { sourcePath: "sequence.yaml" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    const err = caught as ReconcileError;
    expect(err.errorClass).toBe("precondition");
    expect(err.message).toContain("sequence.yaml");
    expect(err.message).toContain("manifest root must be a YAML mapping");
  });
});
