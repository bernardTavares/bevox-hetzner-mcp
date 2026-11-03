/**
 * core/src/providers/backup-restic.test.ts
 *
 * Task 5.3 — drives BackupProvider against an in-process deterministic restic
 * fake implementing the src-owned ResticTransport seam. ZERO real restic, no
 * shell, no network / DB / filesystem.
 *
 * Central guarantees under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"):
 *
 *   - apply(BackupPolicy) converges "≥1 snapshot exists for the target": it
 *     takes the INITIAL snapshot once, then is a NO-OP (changed:false, ZERO
 *     transport writes) — proven by the provider-agnostic conformanceHarness
 *     (with observe-scope teeth) AND an independent write-count assertion.
 *     No re-converge flap.
 *   - snapshot(target) requires NO approval, ALWAYS appends a new snapshot,
 *     and returns a contract-shaped SnapshotEntry.
 *   - restore(target,id) performs the restore mechanics via the seam; the
 *     provider has ZERO approval logic and never auto-destructs (apply never
 *     restores; destructive plan ops are safe no-ops).
 *   - listBackup → BackupEntry (policy + last_run + snapshots[]) parses
 *     against a FAITHFUL mirror of the FROZEN console contract schemas.
 *   - NEVER deletes: the seam has no forget/prune; destructive ops no-op.
 *   - error mapping flows strictly via domain/errors.ts; the restic repo
 *     password is NEVER leaked in errors / observe / snapshot entries.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createBackupProvider } from "./backup-restic.js";
import type {
  ResticSnapshot,
  ResticTransport,
} from "./backup-restic-transport.js";
import { conformanceHarness, type PlanAction } from "./provider.js";
import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// In-memory restic fake — implements the src-owned ResticTransport seam
// (type-only import; the seam lives in src/, NOT here — Task 3.2 lesson).
// Deterministic, per-instance, resettable, no real restic / shell.
//
// A future real `restic`-CLI-backed transport implements this SAME interface
// unchanged (shelling `restic snapshots/backup/restore --json` over SSH,
// injecting RESTIC_PASSWORD into the child env out-of-band) — the provider
// never changes. The fake intentionally takes a `RESTIC_PASSWORD`-like secret
// so the non-leak teeth are real: it must NEVER appear in any provider output.
// ---------------------------------------------------------------------------

const REPO_PASSWORD = "s3cr3t-restic-repo-password";

interface FakeOpts {
  /** Fail every call with this raw error (drives the error-mapping teeth). */
  readonly fault?: { code?: string };
}

class FakeRestic implements ResticTransport {
  /** target → snapshots, in insertion order (deterministic). */
  private readonly store = new Map<string, ResticSnapshot[]>();
  private seq = 0;
  /** Records restore calls so a test can prove the mechanics ran. */
  readonly restored: { target: string; id: string }[] = [];
  /** Counts mutating `backup` calls — the write-count teeth. */
  backupCalls = 0;
  constructor(private readonly opts: FakeOpts = {}) {}

  /** Secret material the real transport would hold; must never leak out. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly password = REPO_PASSWORD;

  private maybeFault(): void {
    if (this.opts.fault) {
      const e = new Error(
        // The seam contract forbids the password here; the fake honours it.
        "restic transport failure",
      ) as Error & { code?: string };
      if (this.opts.fault.code) e.code = this.opts.fault.code;
      throw e;
    }
  }

  async snapshots(target: string): Promise<readonly ResticSnapshot[]> {
    this.maybeFault();
    return [...(this.store.get(target) ?? [])];
  }

  async backup(target: string): Promise<ResticSnapshot> {
    this.maybeFault();
    this.backupCalls++;
    this.seq++;
    const snap: ResticSnapshot = {
      id: `snap-${this.seq}`,
      time: `2026-05-18T00:00:0${this.seq % 10}Z`,
      sizeBytes: 1024 * this.seq,
      tags: [target],
    };
    const list = this.store.get(target) ?? [];
    list.push(snap);
    this.store.set(target, list);
    return snap;
  }

  async restore(target: string, snapshotId: string): Promise<void> {
    this.maybeFault();
    this.restored.push({ target, id: snapshotId });
  }
}

// ---------------------------------------------------------------------------
// Faithful mirror of the FROZEN console contract schemas
// (console/src/api/contract.ts SnapshotEntrySchema / BackupEntrySchema).
// Mirrored BY VALUE — we do not import the console package (same boundary as
// errors.ts/provider.ts; the live cross-package oracle is Task 4.6/5.4). The
// provider's outputs MUST parse against these.
// ---------------------------------------------------------------------------

const ContractSnapshotEntry = z.object({
  id: z.string(),
  timestamp: z.string(),
  size: z.string(),
});

const ContractBackupPolicy = z.object({
  target: z.string(),
  schedule: z.string(),
  retention: z.string(),
  repo: z.string(),
});

const ContractBackupEntry = ContractBackupPolicy.extend({
  last_run: z.string().optional(),
  snapshots: z.array(ContractSnapshotEntry),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY = {
  target: "pg-main",
  schedule: "0 3 * * *",
  retention: "7d",
  repo: "sftp:backup@host:/srv/restic",
};

const POLICY_ACTION: PlanAction = {
  op: "upsert",
  entity: "backup:pg-main",
  desired: POLICY,
};

const POLICY_ACTION_2: PlanAction = {
  op: "upsert",
  entity: "backup:redis-cache",
  desired: { ...POLICY, target: "redis-cache" },
};

function makeRig(opts?: FakeOpts) {
  const fake = new FakeRestic(opts);
  const makeProvider = () => createBackupProvider({ transport: fake });
  return { fake, makeProvider };
}

// ---------------------------------------------------------------------------
// idempotency — conformanceHarness oracle + write-count teeth
// ---------------------------------------------------------------------------

describe("BackupProvider — idempotency (conformanceHarness oracle)", () => {
  it("passes the conformance harness for a policy (observe scope teeth)", async () => {
    // Fresh fake per makeProvider so the harness's apply-twice is isolated.
    const makeProvider = () =>
      createBackupProvider({ transport: new FakeRestic() });
    await conformanceHarness(makeProvider, POLICY_ACTION, "backup:pg-main");
  });

  it("passes the conformance harness for a SECOND policy", async () => {
    const makeProvider = () =>
      createBackupProvider({ transport: new FakeRestic() });
    await conformanceHarness(
      makeProvider,
      POLICY_ACTION_2,
      "backup:redis-cache",
    );
  });

  it("initial snapshot then re-apply = no-op (ZERO extra writes, no flap)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    const first = await p.apply(POLICY_ACTION);
    expect(first.changed).toBe(true);
    expect(fake.backupCalls).toBe(1); // exactly one initial snapshot
    expect(await p.verify(POLICY_ACTION)).toBe(true);

    // Re-converge several times — must stay changed:false with NO new writes.
    for (let i = 0; i < 4; i++) {
      const again = await p.apply(POLICY_ACTION);
      expect(again.changed).toBe(false);
    }
    expect(fake.backupCalls).toBe(1); // STILL exactly one — zero extra writes
    expect(await p.verify(POLICY_ACTION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// snapshot(target) — NO approval, always appends, contract-shaped
// ---------------------------------------------------------------------------

describe("BackupProvider — snapshot(target) (no approval)", () => {
  it("appends a NEW snapshot every call and returns a contract SnapshotEntry", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    const s1 = await p.snapshot("pg-main");
    const s2 = await p.snapshot("pg-main");

    // ALWAYS appends — imperative op, distinct from idempotent apply().
    expect(fake.backupCalls).toBe(2);
    expect(s1.id).not.toBe(s2.id);

    // Parses against the FROZEN contract SnapshotEntry shape.
    expect(() => ContractSnapshotEntry.parse(s1)).not.toThrow();
    expect(ContractSnapshotEntry.parse(s2)).toEqual(s2);
    expect(typeof s1.size).toBe("string");
  });

  it("empty target → precondition (no crash, no write)", async () => {
    const { fake, makeProvider } = makeRig();
    await expect(makeProvider().snapshot("")).rejects.toMatchObject({
      errorClass: "precondition",
    });
    expect(fake.backupCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// restore — mechanics only; provider never self-approves / auto-destructs
// ---------------------------------------------------------------------------

describe("BackupProvider — restore (mechanics; gate owned upstream)", () => {
  it("performs the restore via the seam (provider has no approval logic)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.snapshot("pg-main");
    await p.restore("pg-main", "snap-1");

    // The provider exposed & performed the restore mechanics. Approval is
    // NOT this provider's concern (4.3 gate / 4.4 catalog own it; 5.4 wires).
    expect(fake.restored).toEqual([{ target: "pg-main", id: "snap-1" }]);
  });

  it("empty target/id → precondition", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await expect(p.restore("", "snap-1")).rejects.toMatchObject({
      errorClass: "precondition",
    });
    await expect(p.restore("pg-main", "")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("apply NEVER restores and NEVER auto-destructs", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(POLICY_ACTION);
    for (let i = 0; i < 3; i++) await p.apply(POLICY_ACTION);

    // No restore was ever triggered by the convergence path.
    expect(fake.restored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listBackup → contract BackupEntry
// ---------------------------------------------------------------------------

describe("BackupProvider — listBackup → contract BackupEntry", () => {
  it("returns policy + last_run + snapshots[] parsing against the contract", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    await p.snapshot("pg-main");
    await p.snapshot("pg-main");

    const entry = await p.listBackup(POLICY);

    expect(() => ContractBackupEntry.parse(entry)).not.toThrow();
    expect(entry.target).toBe("pg-main");
    expect(entry.schedule).toBe(POLICY.schedule);
    expect(entry.snapshots).toHaveLength(2);
    // last_run = most recent snapshot timestamp.
    expect(entry.last_run).toBe(entry.snapshots[1]!.timestamp);
  });

  it("no snapshots yet → snapshots:[] and last_run absent (still parses)", async () => {
    const { makeProvider } = makeRig();
    const entry = await makeProvider().listBackup(POLICY);

    expect(() => ContractBackupEntry.parse(entry)).not.toThrow();
    expect(entry.snapshots).toEqual([]);
    expect(entry.last_run).toBeUndefined();
  });

  it("malformed policy → precondition (no crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(
      makeProvider().listBackup({ target: "x" } as never),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });
});

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

describe("BackupProvider — observe", () => {
  it("reports the target entity once it has a snapshot", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    expect((await p.observe("backup:pg-main")).entities).toEqual([]);
    await p.apply(POLICY_ACTION);
    const obs = await p.observe("backup:pg-main");
    expect(obs.scope).toBe("backup:pg-main");
    expect(obs.entities.map((e) => e.key)).toEqual(["backup:pg-main"]);
  });

  it("a bare 'backup' partition reports no entities (store's job)", async () => {
    const { makeProvider } = makeRig();
    const obs = await makeProvider().observe("backup");
    expect(obs.entities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fail-safe — NEVER deletes
// ---------------------------------------------------------------------------

describe("BackupProvider — fail-safe (never deletes)", () => {
  it("destructive ops (remove/destroy) are a safe no-op, snapshots kept", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(POLICY_ACTION);
    expect(fake.backupCalls).toBe(1);

    for (const op of ["remove", "destroy"] as const) {
      const res = await p.apply({ ...POLICY_ACTION, op });
      expect(res.changed).toBe(false);
    }
    // Fail-safe: the snapshot still exists, nothing forgotten/pruned.
    expect((await p.snapshot("pg-main")) !== undefined).toBe(true);
    expect(await p.verify(POLICY_ACTION)).toBe(true);
  });

  it("the seam exposes NO forget/prune (structurally cannot delete)", () => {
    const fake = new FakeRestic();
    // ResticTransport surface = snapshots/backup/restore only.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(fake))).toEqual(
      expect.arrayContaining(["snapshots", "backup", "restore"]),
    );
    expect("forget" in fake).toBe(false);
    expect("prune" in fake).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// error mapping — strictly via domain/errors.ts + secret non-leak
// ---------------------------------------------------------------------------

describe("BackupProvider — error mapping (via domain/errors.ts)", () => {
  it("a network-blip code from the transport → transient ReconcileError", async () => {
    const { makeProvider } = makeRig({ fault: { code: "ECONNRESET" } });
    await expect(makeProvider().verify(POLICY_ACTION)).rejects.toMatchObject({
      errorClass: "transient",
    });
  });

  it("an unknown transport failure → transient (network-error default)", async () => {
    const { makeProvider } = makeRig({ fault: {} });
    await expect(
      makeProvider().snapshot("pg-main"),
    ).rejects.toMatchObject({ errorClass: "transient" });
  });

  it("malformed desired → precondition (no crash, no write)", async () => {
    const { fake, makeProvider } = makeRig();
    await expect(
      makeProvider().apply({
        op: "upsert",
        entity: "backup:bad",
        desired: { target: "bad", schedule: 5 },
      }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
    expect(fake.backupCalls).toBe(0);
  });

  it("unknown scope → precondition (no silent crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(makeProvider().observe("server")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("NEVER leaks the restic repo password (error path)", async () => {
    const { makeProvider } = makeRig({ fault: { code: "ETIMEDOUT" } });
    try {
      await makeProvider().snapshot("pg-main");
      throw new Error("expected a ReconcileError");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(REPO_PASSWORD);
      // and the entity key / repo URL are not echoed either
      expect(String((e as Error).message)).not.toContain(POLICY.repo);
    }
  });

  it("NEVER leaks the restic repo password (success outputs)", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();
    await p.snapshot("pg-main");
    const entry = await p.listBackup(POLICY);
    expect(JSON.stringify(entry)).not.toContain(REPO_PASSWORD);
    const obs = await p.observe("backup:pg-main");
    expect(JSON.stringify(obs)).not.toContain(REPO_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

describe("BackupProvider — construction", () => {
  it("a missing transport is a fatal construction error", () => {
    expect(() =>
      createBackupProvider({ transport: undefined as never }),
    ).toThrow(ReconcileError);
  });
});
