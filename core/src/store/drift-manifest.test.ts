/**
 * core/src/store/drift-manifest.test.ts
 *
 * TDD tests for manifest-repo.ts — read-only git working-tree manifest read
 * and a pure working×git structural drift diff (Task 1.8).
 *
 * Non-negotiables exercised here:
 *   - readCanonicalManifest reads the canonical manifest file from a repo
 *     working tree (plain file read, no git mutation) and parses it via the
 *     existing desired-state.ts parser.
 *   - diffManifest is PURE: identical inputs → empty drift array; differing
 *     inputs → drift items only (NO auto-correction, no side effects).
 *   - Drift items are deterministic & stably ordered (reproducible output).
 *   - Drift items are classified as the `conflict` error class.
 *
 * DB-free; touches only files written into an OS tmpdir.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest, type DesiredState } from "../domain/desired-state.js";
import { readCanonicalManifest, diffManifest } from "./manifest-repo.js";

let repoDir: string;

const MANIFEST_A = `
servers:
  - name: app-1
    type: cx32
    location: nbg1
    network: priv
networks:
  - name: priv
    ip_range: 10.0.0.0/16
`;

const MANIFEST_B = `
servers:
  - name: app-1
    type: cx42
    location: nbg1
    network: priv
  - name: app-2
    type: cx32
    location: nbg1
    network: priv
`;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "bevox-drift-"));
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("readCanonicalManifest", () => {
  it("reads & parses the default canonical manifest from the repo working tree", async () => {
    await writeFile(join(repoDir, "bevox.manifest.yaml"), MANIFEST_A, "utf8");
    const state = await readCanonicalManifest(repoDir);
    expect(state.servers).toHaveLength(1);
    expect(state.servers?.[0]?.name).toBe("app-1");
    expect(state.networks?.[0]?.name).toBe("priv");
  });

  it("supports an explicit relative manifest path within the repo", async () => {
    await mkdir(join(repoDir, "infra"), { recursive: true });
    await writeFile(join(repoDir, "infra", "stack.yaml"), MANIFEST_B, "utf8");
    const state = await readCanonicalManifest(repoDir, "infra/stack.yaml");
    expect(state.servers).toHaveLength(2);
  });

  it("throws a precondition error when the manifest file is absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "bevox-drift-empty-"));
    try {
      await expect(readCanonicalManifest(empty)).rejects.toMatchObject({
        errorClass: "precondition",
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("diffManifest", () => {
  it("returns an empty array for identical inputs (determinism)", () => {
    const a = parseManifest(MANIFEST_A);
    const b = parseManifest(MANIFEST_A);
    expect(diffManifest(a, b)).toEqual([]);
  });

  it("does not mutate its inputs (pure function)", () => {
    const working = parseManifest(MANIFEST_A);
    const git = parseManifest(MANIFEST_B);
    const wSnapshot = JSON.stringify(working);
    const gSnapshot = JSON.stringify(git);
    diffManifest(working, git);
    expect(JSON.stringify(working)).toBe(wSnapshot);
    expect(JSON.stringify(git)).toBe(gSnapshot);
  });

  it("reports present-only-in-working, present-only-in-git and changed items", () => {
    const working = parseManifest(MANIFEST_B); // app-1 (cx42) + app-2; no networks
    const git = parseManifest(MANIFEST_A); // app-1 (cx32) + priv network

    const drift = diffManifest(working, git);

    // app-1 changed (type cx42 vs cx32); app-2 only in working;
    // network priv only in git → 3 drift items.
    expect(drift).toHaveLength(3);

    for (const d of drift) {
      expect(d.errorClass).toBe("conflict");
    }

    const byKey = Object.fromEntries(drift.map((d) => [d.key, d]));
    expect(byKey["server:app-1"]?.kind).toBe("changed");
    expect(byKey["server:app-2"]?.kind).toBe("present-only-in-working");
    expect(byKey["network:priv"]?.kind).toBe("present-only-in-git");
  });

  it("treats key reordering as semantically equal (no drift)", () => {
    const working = parseManifest(`
servers:
  - name: app-1
    type: cx32
    location: nbg1
    network: priv
`);
    const git = parseManifest(`
servers:
  - network: priv
    location: nbg1
    type: cx32
    name: app-1
`);
    expect(diffManifest(working, git)).toEqual([]);
  });

  it("reports a dns drift item under the composite zone:name:type key", () => {
    const working = parseManifest(`
dns:
  - zone: example.com
    name: api
    type: A
    value: 1.2.3.4
`);
    const git = parseManifest(`
dns:
  - zone: example.com
    name: api
    type: A
    value: 5.6.7.8
`);

    const drift = diffManifest(working, git);

    expect(drift).toHaveLength(1);
    expect(drift[0]?.key).toBe("dns:example.com:api:A");
    expect(drift[0]?.entityKind).toBe("dns");
    expect(drift[0]?.kind).toBe("changed");
    expect(drift[0]?.errorClass).toBe("conflict");
  });

  it("a ':'-containing entity name does NOT collide (shared entityKey, follow-up #40)", () => {
    // DNS uses a composite zone:name:type natural key. With the OLD raw
    // `${prefix}:${zone}:${name}:${type}` interpolation in manifest-repo's
    // indexBy, a record (zone="a:b", name="api", type="A") and a DISTINCT
    // record (zone="a", name="b:api", type="A") both flatten to the SAME raw
    // key "dns:a:b:api:A" — aliasing two different DNS records and silently
    // dropping/duplicating a drift item (fail-safe adjacent). The shared
    // entityKey/escapePart escapes each component, so they stay distinct.
    //
    // These are HAND-BUILT DesiredState fixtures (not parseManifest): the
    // parser's OWN duplicate-identifier guard is a SEPARATE site; this test
    // isolates indexBy's key construction (the #40 migration surface).
    const working: DesiredState = {
      dns: [
        { zone: "a:b", name: "api", type: "A", value: "1.1.1.1" },
        { zone: "a", name: "b:api", type: "A", value: "2.2.2.2" },
      ],
    };
    const git: DesiredState = {
      dns: [{ zone: "a:b", name: "api", type: "A", value: "9.9.9.9" }],
    };

    const drift = diffManifest(working, git);

    // Three distinct entities: (a:b,api,A) changed; (a,b:api,A) only-in-working.
    // If the two working records aliased, we'd see <2 distinct dns keys.
    const dnsKeys = drift
      .filter((d) => d.entityKind === "dns")
      .map((d) => d.key);
    expect(new Set(dnsKeys).size).toBe(dnsKeys.length); // no collision/merge
    expect(dnsKeys).toHaveLength(2);
    // The `:` in a component is escaped (\\:) — never the separator.
    expect(dnsKeys).toContain("dns:a\\:b:api:A"); // (zone "a:b") changed
    expect(dnsKeys).toContain("dns:a:b\\:api:A"); // (name "b:api") only-working
    const byKey = Object.fromEntries(drift.map((d) => [d.key, d]));
    expect(byKey["dns:a\\:b:api:A"]?.kind).toBe("changed");
    expect(byKey["dns:a:b\\:api:A"]?.kind).toBe("present-only-in-working");
  });

  it("orders drift items deterministically by key (reproducible)", () => {
    const working = parseManifest(MANIFEST_B);
    const git = parseManifest(MANIFEST_A);
    const keys1 = diffManifest(working, git).map((d) => d.key);
    const keys2 = diffManifest(working, git).map((d) => d.key);
    expect(keys1).toEqual(keys2);
    expect(keys1).toEqual([...keys1].sort());
  });
});
