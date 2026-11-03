/**
 * core/src/providers/backup-restic-transport.ts
 *
 * The ResticTransport seam — OWNED BY src/, not by a test fake.
 *
 * PORT-OWNERSHIP DISCIPLINE (same rule as provider.ts / docker-transport.ts /
 * wireguard-transport.ts headers: production code must not import from
 * `test/`). BackupProvider (backup-restic.ts) is written PURELY against this
 * seam, so the contract lives here, in the production tree, next to its only
 * consumer. Implementations live elsewhere and depend INWARD on this file:
 *
 *   - core/test/fakes/restic-cli.ts (or co-located in the provider test) —
 *     the in-process deterministic fake used by every Task-5.3 test
 *     (implements this interface, type-only import).
 *   - a future real `restic`-CLI-backed transport (Fase 5+/6) — shelling out
 *     to the `restic` binary over the existing SSH tunnel — implements the
 *     SAME interface unchanged, so the provider stays transport-agnostic.
 *
 * WHY A RESTIC-OP SEAM (not method+path+body, not a raw argv): restic is a
 * CLI, not an HTTP API. The honest seam is exactly the restic *subcommands*
 * the provider needs, one method per subcommand, returning the structured
 * JSON restic itself emits with `--json`:
 *
 *   - snapshots(target): `restic snapshots --json --tag <target>` — the list
 *     of snapshots currently in the repo for this backup target. Read-only.
 *   - backup(target):    `restic backup <paths> --tag <target> --json` — take
 *     a new snapshot of the target; returns the created snapshot's id + meta.
 *     This is the ONLY append; it never deletes anything.
 *   - restore(target,id):`restic restore <id> --target <path>` — restore the
 *     given snapshot. This is the only intentionally-DESTRUCTIVE restic op.
 *
 * Deliberately ABSENT (YAGNI + fail-safe, never fail-deleting): there is NO
 * `forget` / `prune` method. Pruning unmanaged/expired snapshots is the
 * reconciler's drift concern (Task 2.9 discipline), never the provider's — so
 * the provider is STRUCTURALLY unable to delete repo data. A real transport
 * adding `forget` later would still not be reachable from this provider.
 *
 * SECRET-BOUNDARY CONTRACT (spec §SECRET BOUNDARY; binds every
 * implementation, especially the future real one): the restic repository
 * PASSWORD (`RESTIC_PASSWORD` / `--password-*`) and any repo/backend
 * credentials are SECRET MATERIAL. They are NEVER part of this seam — no
 * method parameter and no return field carries the password or credentials.
 * The real transport injects `RESTIC_PASSWORD` into the child process
 * environment out-of-band; it MUST NOT echo the password, repo URL
 * credentials, or any secret into return values, error messages, rejections,
 * retry logs or debug logs. Only non-secret operational metadata (snapshot
 * id, timestamp, size, tags) crosses this boundary.
 *
 * Exported API:
 *   interface ResticSnapshot   — one non-secret restic snapshot record
 *   interface ResticTransport  — the seam BackupProvider is written against
 */

/**
 * One restic snapshot as `restic snapshots --json` exposes it, projected to
 * the non-secret fields the provider needs. `id` is restic's snapshot id
 * (stable identity); `time` is the snapshot timestamp (RFC3339, as restic
 * emits); `sizeBytes` is the snapshot's total size in bytes (restic `summary`
 * data — optional, since older restic / a partial listing may omit it).
 *
 * Volatile/host fields a real `restic snapshots --json` also returns
 * (hostname, username, full path list, tree hash) are intentionally NOT
 * modelled: they are not part of the declarative backup policy, so comparing
 * them would flap convergence. NO password / credential field exists here by
 * construction (secret-boundary contract above).
 */
export interface ResticSnapshot {
  /** restic snapshot id. Stable identity. */
  readonly id: string;
  /** Snapshot timestamp, RFC3339 (as restic `--json` emits `time`). */
  readonly time: string;
  /** Total snapshot size in bytes (restic summary). Optional. */
  readonly sizeBytes?: number;
  /** restic tags on the snapshot — the provider tags each with its target. */
  readonly tags?: readonly string[];
}

/**
 * The restic-CLI-shaped seam BackupProvider (5.3) is written against. The
 * fake and a future real `restic`-backed transport implement this exact
 * interface so the provider stays transport-agnostic.
 *
 * `snapshots()` is read-only and idempotent. `backup()` appends exactly one
 * new snapshot and returns it (the provider tags it with the target so the
 * listing filter is reliable). `restore()` is the only destructive op — the
 * provider performs it only via its explicit `restore()` method; the
 * destructive→approval routing lives ABOVE the provider (the Task 4.3 gate /
 * 4.4 catalog), never inside it.
 *
 * NO `forget`/`prune`: see header. The provider can never delete repo data.
 */
export interface ResticTransport {
  /** Read-only: snapshots in the repo for `target` (restic `--tag` filter). */
  snapshots(target: string): Promise<readonly ResticSnapshot[]>;
  /** Append one new snapshot of `target`; returns the created snapshot. */
  backup(target: string): Promise<ResticSnapshot>;
  /**
   * Restore snapshot `snapshotId` of `target`. The ONLY destructive op.
   * Approval for this is owned by the gate/catalog ABOVE the provider; the
   * provider never self-approves and only ever calls this from its explicit
   * restore() method (never from observe/verify/plan).
   */
  restore(target: string, snapshotId: string): Promise<void>;
}
