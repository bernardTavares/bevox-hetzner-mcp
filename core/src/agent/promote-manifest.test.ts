/**
 * core/src/agent/promote-manifest.test.ts
 *
 * Task 4.8 — the approval-gated `promote_manifest` core-internal entry point.
 *
 * Non-negotiables exercised here (the EXACT teeth):
 *   - promote diffs the WORKING desired-state against the GIT canonical
 *     manifest. NO diff ⇒ a no-op `applied()`: NO approval opened, NO write,
 *     NO commit (idempotent re-promote).
 *   - A diff ⇒ SENSITIVE ⇒ the SAME 4.3 approval gate withholds and opens a
 *     pending approval ⇒ `pending_approval`. While pending the canonical YAML
 *     is NOT written and NO new commit exists (fail-safe).
 *   - rejected ⇒ NO write / NO commit. expired(cancelled) ⇒ NO write.
 *     still-pending ⇒ NO write. (all three asserted)
 *   - approved ⇒ the canonical YAML is written (parses back via the existing
 *     parser to EXACTLY the promoted DesiredState — refs preserved verbatim,
 *     never a resolved secret value) AND exactly ONE new forward commit exists
 *     with the expected message (no history rewrite, no remote, no network).
 *   - deny-before-write: an agent WITHOUT the apply_manifest capability gets a
 *     fatal error envelope and NO write/commit.
 *
 * Deterministic: a throwaway local git repo in os.tmpdir with a LOCAL git
 * identity only; injected clock + id factory; pg harness. No network.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";

import { parseManifest, type DesiredState } from "../domain/desired-state.js";
import { createToolCatalog, type ToolContext } from "./tools.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import {
  __mintVerifiedCredentialForTest,
  ALL_TOOLS,
} from "./capability.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { State } from "../domain/entities.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

const exec = promisify(execFile);

let pool: pg.Pool;
let repoDir: string;

const FIXED = new Date("2026-05-18T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const SCOPE = "server";

// Working desired-state carrying a secret: REF — it must round-trip as a ref,
// never a resolved value.
const WORKING_YAML = `
servers:
  - name: app-1
    type: cx32
    location: nbg1
    network: priv
services:
  - name: api
    image: registry/api:v1
    replicas: 1
    env:
      BEVOX_API_KEY: "secret:bevox-api"
`;

const EMPTY: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

function fakeProvider(): Provider {
  const reality = new Set<string>();
  return {
    name: "fake",
    async observe(scope: string): Promise<ObservedSlice> {
      return {
        scope,
        entities: [...reality].map((k) => ({
          key: k,
          payload: { name: k.slice(k.lastIndexOf(":") + 1) },
        })),
      };
    },
    async apply(a: PlanAction): Promise<ApplyResult> {
      reality.add(a.entity);
      return { entity: a.entity, op: a.op, changed: true };
    },
    async verify(a: PlanAction): Promise<boolean> {
      return reality.has(a.entity);
    },
  };
}

let idn = 0;
function makeCatalog(workingByScope: Map<string, DesiredState>) {
  idn = 0;
  return createToolCatalog({
    pool,
    provider: fakeProvider(),
    observedAdapter: (): State => EMPTY,
    loadDesired: async (s: string): Promise<DesiredState> =>
      workingByScope.get(s) ?? {},
    writeDesired: async (s: string, d: DesiredState) => {
      workingByScope.set(s, d);
    },
    makeGate: (isSensitive): ReconcileGate =>
      createApprovalGate({
        pool,
        clock,
        isSensitive,
        idFactory: () => `apr_test_${++idn}`,
      }),
  });
}

function ctxFor(caps: readonly string[]): ToolContext {
  return {
    credential: __mintVerifiedCredentialForTest("agent:vox", [...caps]),
    scope: SCOPE,
  };
}

async function gitLog(): Promise<string[]> {
  try {
    const { stdout } = await exec("git", [
      "-C",
      repoDir,
      "log",
      "--format=%s",
    ]);
    return stdout.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

async function manifestRaw(): Promise<string | null> {
  try {
    return await readFile(join(repoDir, "bevox.manifest.yaml"), "utf8");
  } catch {
    return null;
  }
}

beforeAll(() => {
  pool = getTestPool();
});
afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
  repoDir = await mkdtemp(join(tmpdir(), "bevox-promote-"));
  // Throwaway LOCAL git repo + LOCAL identity ONLY (no global surprises).
  await exec("git", ["-C", repoDir, "init", "-q"]);
  await exec("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
  await exec("git", ["-C", repoDir, "config", "user.name", "Test"]);
  await exec("git", ["-C", repoDir, "commit", "--allow-empty", "-q", "-m", "root"]);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("Task 4.8 — approval-gated promote_manifest", () => {
  it("no working×git diff ⇒ no-op applied(): no approval, no write, no commit", async () => {
    // Pre-seed the canonical manifest to EXACTLY the working state.
    const working = parseManifest(WORKING_YAML);
    const w = new Map<string, DesiredState>([[SCOPE, working]]);
    const cat = makeCatalog(w);

    // First promote (approved) to establish git == working.
    let env = await cat.promoteManifest({ repoPath: repoDir }, ctxFor(ALL_TOOLS));
    expect(env.status).toBe("pending_approval");
    const apr1 = env.approval_id!;
    const gate = createApprovalGate({ pool, clock });
    await gate.resolveApproval(apr1, "approved", "human:op");
    env = await cat.promoteManifest({ repoPath: repoDir }, ctxFor(ALL_TOOLS));
    expect(env.status).toBe("applied");
    const commitsAfterFirst = await gitLog();

    // Second promote with NO change ⇒ no-op applied, NO new approval/commit.
    const before = (await pool.query("SELECT count(*) FROM approvals")).rows[0];
    env = await cat.promoteManifest({ repoPath: repoDir }, ctxFor(ALL_TOOLS));
    expect(env.status).toBe("applied");
    expect(env.approval_id).toBeUndefined();
    const after = (await pool.query("SELECT count(*) FROM approvals")).rows[0];
    expect(after.count).toBe(before.count); // no new approval opened
    expect(await gitLog()).toEqual(commitsAfterFirst); // no new commit
  });

  it("a diff ⇒ pending_approval; while pending NO write and NO new commit", async () => {
    const w = new Map<string, DesiredState>([
      [SCOPE, parseManifest(WORKING_YAML)],
    ]);
    const cat = makeCatalog(w);
    const commitsBefore = await gitLog();

    const env = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // FAIL-SAFE: nothing written / committed while pending.
    expect(await manifestRaw()).toBeNull();
    expect(await gitLog()).toEqual(commitsBefore);

    // Re-promote while still pending ⇒ STILL pending, still no write/commit.
    const env2 = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    expect(env2.status).toBe("pending_approval");
    expect(await manifestRaw()).toBeNull();
    expect(await gitLog()).toEqual(commitsBefore);
  });

  it("rejected approval ⇒ NO write, NO commit", async () => {
    const w = new Map<string, DesiredState>([
      [SCOPE, parseManifest(WORKING_YAML)],
    ]);
    const cat = makeCatalog(w);
    const commitsBefore = await gitLog();

    const env = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    const aprId = env.approval_id!;
    const gate = createApprovalGate({ pool, clock });
    await gate.resolveApproval(aprId, "rejected", "human:op", "nope");

    const env2 = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    // Rejected (terminal) ⇒ gate opens a FRESH pending; still NO write/commit.
    expect(env2.status).toBe("pending_approval");
    expect(await manifestRaw()).toBeNull();
    expect(await gitLog()).toEqual(commitsBefore);
  });

  it("expired (TTL) approval ⇒ NO write, NO commit", async () => {
    const w = new Map<string, DesiredState>([
      [SCOPE, parseManifest(WORKING_YAML)],
    ]);
    const cat = makeCatalog(w);
    const commitsBefore = await gitLog();

    await cat.promoteManifest({ repoPath: repoDir }, ctxFor(ALL_TOOLS));
    // Sweep with a clock advanced past the 24h TTL → cancelled (expired).
    const future: Clock = {
      now: () => new Date(FIXED.getTime() + 25 * 60 * 60 * 1000),
    };
    const sweepGate = createApprovalGate({ pool, clock: future });
    const expired = await sweepGate.sweepExpired();
    expect(expired.length).toBe(1);
    expect(expired[0]!.status).toBe("cancelled");

    // A subsequent promote does NOT see an approved decision ⇒ NO write.
    const env2 = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    expect(env2.status).toBe("pending_approval");
    expect(await manifestRaw()).toBeNull();
    expect(await gitLog()).toEqual(commitsBefore);
  });

  it("approved ⇒ writes canonical YAML (refs preserved) + exactly ONE forward commit", async () => {
    const working = parseManifest(WORKING_YAML);
    const w = new Map<string, DesiredState>([[SCOPE, working]]);
    const cat = makeCatalog(w);
    const commitsBefore = await gitLog();

    const env = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    const aprId = env.approval_id!;
    const gate = createApprovalGate({ pool, clock });
    await gate.resolveApproval(aprId, "approved", "human:op");

    const env2 = await cat.promoteManifest(
      { repoPath: repoDir },
      ctxFor(ALL_TOOLS),
    );
    expect(env2.status).toBe("applied");

    // The written manifest parses back to EXACTLY the promoted DesiredState.
    const raw = await manifestRaw();
    expect(raw).not.toBeNull();
    expect(parseManifest(raw!)).toEqual(working);
    // NO secret leak: the ref is verbatim, never a resolved value.
    expect(raw!).toContain("secret:bevox-api");
    expect(raw!).not.toMatch(/resolved|RESOLVED_VALUE/);

    // Crash-atomic write leaves EXACTLY the canonical file: no orphan `.tmp`
    // sibling remains in the manifest dir after a successful promote.
    const dirEntries = await readdir(repoDir);
    expect(dirEntries).toContain("bevox.manifest.yaml");
    expect(dirEntries.filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // Exactly ONE new forward commit (no history rewrite, no remote).
    const commitsAfter = await gitLog();
    expect(commitsAfter.length).toBe(commitsBefore.length + 1);
    expect(commitsAfter[0]).toBe(
      "chore(manifest): promote working state to git canonical (bevox-hetzner-mcp)",
    );
    // git history is forward-only: the prior root commit is still there.
    expect(commitsAfter).toContain("root");
  });

  it("deny-before-write: missing apply_manifest capability ⇒ error, no write/commit", async () => {
    const w = new Map<string, DesiredState>([
      [SCOPE, parseManifest(WORKING_YAML)],
    ]);
    const cat = makeCatalog(w);
    const commitsBefore = await gitLog();

    const env = await cat.promoteManifest(
      { repoPath: repoDir },
      // grant everything EXCEPT apply_manifest
      ctxFor(ALL_TOOLS.filter((t) => t !== "apply_manifest")),
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("fatal");
    expect(await manifestRaw()).toBeNull();
    expect(await gitLog()).toEqual(commitsBefore);
  });
});
