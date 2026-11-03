/**
 * core/src/store/manifest-repo.ts
 *
 * Read-only access to the canonical desired-state manifest committed in a git
 * repository working tree, a PURE structural drift diff between the working
 * DesiredState and the git (canonical) DesiredState (Task 1.8), AND the
 * explicit, approval-gated promote write/commit path (Task 4.8).
 *
 * Design principles (spec §5 — fail-safe, never fail-deleting; drift reported,
 * never silently reconciled):
 *   - readCanonicalManifest performs a plain, read-only file read of the repo
 *     working tree. It NEVER shells out to git and NEVER mutates the repo.
 *   - diffManifest is a pure function: identical inputs → empty drift array;
 *     differing inputs → drift items only. It performs NO action and NO
 *     auto-correction — it merely *describes* divergence so Fase 4 can act.
 *   - Drift output is deterministic: items are sorted by their stable entity
 *     key so the result is byte-reproducible across runs.
 *   - Entity keys are built via the SHARED `entityKey`/`escapePart`
 *     (state-store-helper.ts — the single source of truth, Task 2.5). A `:`
 *     inside an entity name is escaped per-component so two distinct entities
 *     can NEVER alias to the same key. Raw `${prefix}:${name}` interpolation
 *     (the last raw-key site in the codebase) is gone: a `:`-collision in a
 *     working×git diff would be a missed/duplicated drift item — fail-safe
 *     adjacent (follow-up #40).
 *   - writeCanonicalManifest / commitManifest are the explicit promote path
 *     (Task 4.8): a forward-only serialize+commit. They NEVER delete git
 *     history, NEVER touch a remote, NEVER resolve a `secret:` ref (the
 *     serializer round-trips refs verbatim — 1.9/3.3 discipline). They are
 *     invoked ONLY from the approval-gated `promote_manifest` agent entry
 *     point (tools.ts): no write/commit happens unless an approval is
 *     resolved `approved` (fail-safe — pending/rejected/expired ⇒ no write).
 *
 * Exported API (ONLY these):
 *   readCanonicalManifest(repoPath, manifestPath?) → Promise<DesiredState>
 *   writeCanonicalManifest(repoPath, desired, manifestPath?) → Promise<string>
 *   commitManifest(repoPath, manifestPath, message) → Promise<void>
 *   diffManifest(working, git) → ManifestDriftItem[]
 *   type ManifestDriftItem
 */

import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { relative, isAbsolute, join, sep } from "node:path";

import { stringify as yamlStringify } from "yaml";

import {
  parseManifest,
  DesiredStateSchema,
  type DesiredState,
} from "../domain/desired-state.js";
import { ReconcileError, type ErrorClass } from "../domain/errors.js";
import { entityKey } from "./state-store-helper.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Canonical manifest path convention
//
// The spec mandates "manifestos YAML versionados (git)" but fixes no filename.
// We default to `bevox.manifest.yaml` at the repo root and allow an explicit
// repo-relative override so a caller can point at e.g. `infra/stack.yaml`.
// ---------------------------------------------------------------------------

/** Default canonical manifest filename at the repo root. */
export const DEFAULT_MANIFEST_PATH = "bevox.manifest.yaml";

/**
 * Read and parse the canonical manifest from a git repo working tree.
 *
 * This is a read-only operation: it resolves the manifest path *within*
 * `repoPath`, reads the file from disk, and passes its text through the
 * existing desired-state parser (no re-implementation of YAML/Zod logic).
 * It does not invoke git and does not write anything.
 *
 * @param repoPath     Absolute or relative path to the repo working tree root.
 * @param manifestPath Repo-relative manifest path. Defaults to
 *                      {@link DEFAULT_MANIFEST_PATH}. Must stay inside repoPath.
 * @throws ReconcileError("precondition") if the file is missing/unreadable, if
 *         manifestPath escapes the repo, or (via parseManifest) on invalid YAML.
 */
export async function readCanonicalManifest(
  repoPath: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<DesiredState> {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new ReconcileError(
      "precondition",
      "readCanonicalManifest: repoPath must be a non-empty string",
      { entity: "manifest" },
    );
  }
  // Disallow absolute or parent-escaping manifest paths: the canonical manifest
  // must live inside the repo working tree (fail-safe: no reads outside repo).
  const rel = relative(repoPath, join(repoPath, manifestPath));
  if (
    isAbsolute(manifestPath) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`)
  ) {
    throw new ReconcileError(
      "precondition",
      `readCanonicalManifest: manifestPath "${manifestPath}" must be inside the repo`,
      { entity: "manifest" },
    );
  }

  const fullPath = join(repoPath, manifestPath);

  let text: string;
  try {
    text = await readFile(fullPath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReconcileError(
      "precondition",
      `readCanonicalManifest: cannot read manifest at "${fullPath}" — ${msg}`,
      { entity: "manifest", cause: e },
    );
  }

  return parseManifest(text, { sourcePath: fullPath });
}

// ---------------------------------------------------------------------------
// Promote write/commit path (Task 4.8) — explicit, forward-only, fail-safe
//
// These are invoked ONLY by the approval-gated `promote_manifest` agent entry
// point (tools.ts) AFTER an approval is resolved `approved`. They never run on
// a pending/rejected/expired approval (the gate withholds). They are a normal
// forward serialize+commit: NO history rewrite, NO remote, NO secret resolve.
// ---------------------------------------------------------------------------

/**
 * Serialize `desired` to the canonical manifest YAML inside the repo working
 * tree and return the absolute path written.
 *
 * The DesiredState is re-validated through the SAME `DesiredStateSchema` (no
 * ad-hoc shaping) before serialization, then emitted with the `yaml` package
 * (the same dependency `desired-state.ts` parses with — round-trip safe).
 * A `secret:` reference is a plain string in DesiredState and stays a plain
 * string here: the serializer NEVER resolves it to a value (1.9/3.3/4.x
 * no-leak discipline — promoting carries refs, never resolved secrets).
 *
 * Read-only path semantics are preserved: the manifest path is constrained to
 * live inside `repoPath` exactly as readCanonicalManifest enforces (no write
 * escaping the repo working tree — fail-safe).
 *
 * @throws ReconcileError("precondition") on an invalid repoPath/manifestPath,
 *         a schema-invalid desired state, or an unwritable target.
 */
export async function writeCanonicalManifest(
  repoPath: string,
  desired: DesiredState,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): Promise<string> {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new ReconcileError(
      "precondition",
      "writeCanonicalManifest: repoPath must be a non-empty string",
      { entity: "manifest" },
    );
  }
  const rel = relative(repoPath, join(repoPath, manifestPath));
  if (isAbsolute(manifestPath) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ReconcileError(
      "precondition",
      `writeCanonicalManifest: manifestPath "${manifestPath}" must be inside the repo`,
      { entity: "manifest" },
    );
  }

  let validated: DesiredState;
  try {
    validated = DesiredStateSchema.parse(desired);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReconcileError(
      "precondition",
      `writeCanonicalManifest: desired state is not a valid manifest — ${msg}`,
      { entity: "manifest", cause: e },
    );
  }

  const fullPath = join(repoPath, manifestPath);
  const text = yamlStringify(validated);
  // Crash-atomic write: serialize to a unique sibling temp file in the SAME
  // directory (same filesystem ⇒ rename is atomic), then atomically rename it
  // onto the canonical path. A crash mid-write can only ever leave an orphan
  // `.tmp` (never a torn `bevox.manifest.yaml`); the unique suffix avoids any
  // collision if two writes ever overlap. On ANY error we best-effort remove
  // the temp file and rethrow the ORIGINAL error unchanged (same
  // ReconcileError("precondition") semantics — success path is identical).
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, fullPath);
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReconcileError(
      "precondition",
      `writeCanonicalManifest: cannot write manifest at "${fullPath}" — ${msg}`,
      { entity: "manifest", cause: e },
    );
  }
  return fullPath;
}

/**
 * Stage the manifest file and create ONE forward commit in the repo at
 * `repoPath`. This is a plain `git add <manifestPath> && git commit -m <msg>`
 * against THAT repo only — never a remote, never a history rewrite, never a
 * force. Arguments are passed as an argv array via execFile (NO shell), so the
 * message/path can carry no shell injection. The commit message is the
 * caller-supplied promote message — it is value-free by construction (the
 * agent supplies a fixed description; secrets never reach it).
 *
 * Git identity: we do NOT set global identity. The caller (or the repo) owns
 * `user.email`/`user.name`; tests configure a LOCAL identity on the throwaway
 * repo. If git has no identity at all it fails loudly (precondition) — never a
 * silent partial commit.
 *
 * @throws ReconcileError("precondition") if git add/commit fails.
 */
export async function commitManifest(
  repoPath: string,
  manifestPath: string,
  message: string,
): Promise<void> {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new ReconcileError(
      "precondition",
      "commitManifest: repoPath must be a non-empty string",
      { entity: "manifest" },
    );
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new ReconcileError(
      "precondition",
      "commitManifest: a non-empty commit message is required",
      { entity: "manifest" },
    );
  }
  try {
    // execFile (argv form) — NO shell interpolation of message/path. `--`
    // terminates option parsing so a path can never be read as a flag.
    await execFileAsync("git", ["-C", repoPath, "add", "--", manifestPath]);
    await execFileAsync("git", [
      "-C",
      repoPath,
      "commit",
      "-m",
      message,
      "--",
      manifestPath,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReconcileError(
      "precondition",
      `commitManifest: git commit failed in "${repoPath}" — ${msg}`,
      { entity: "manifest", cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// Drift model
// ---------------------------------------------------------------------------

/** The nature of a single working×git divergence. */
export type ManifestDriftKind =
  | "present-only-in-working"
  | "present-only-in-git"
  | "changed";

/**
 * One structural divergence between the working and git DesiredState.
 *
 * Carries enough information for Fase 4 to act, but performs NO action itself.
 * `errorClass` is always "conflict" (observed/desired divergence — errors.ts).
 */
export interface ManifestDriftItem {
  /** Stable entity key, e.g. "server:app-1" — also the deterministic sort key. */
  readonly key: string;
  /** Entity collection this item belongs to (servers→"server", …). */
  readonly entityKind: string;
  /** Nature of the divergence. */
  readonly kind: ManifestDriftKind;
  /** Spec error class for drift — always "conflict". */
  readonly errorClass: ErrorClass;
  /** The working-tree value (undefined when present-only-in-git). */
  readonly working?: unknown;
  /** The git/canonical value (undefined when present-only-in-working). */
  readonly git?: unknown;
}

// Collections compared, with their singular key prefix and the natural-id
// COMPONENTS (each escaped independently by the shared entityKey builder —
// state-store-helper.ts). `partsOf` returns the component values in the SAME
// order/shape stateToRows uses for the stores, so a manifest entity and its
// observed/desired store row share one collision-free key convention.
type Collection = keyof DesiredState;

const COLLECTIONS: ReadonlyArray<{
  field: Collection;
  prefix: string;
  partsOf: (item: Record<string, unknown>) => string[];
}> = [
  { field: "servers", prefix: "server", partsOf: (s) => [String(s.name)] },
  { field: "networks", prefix: "network", partsOf: (n) => [String(n.name)] },
  { field: "volumes", prefix: "volume", partsOf: (v) => [String(v.name)] },
  { field: "services", prefix: "service", partsOf: (s) => [String(s.name)] },
  {
    field: "dns",
    prefix: "dns",
    partsOf: (d) => [String(d.zone), String(d.name), String(d.type)],
  },
  { field: "backups", prefix: "backup", partsOf: (b) => [String(b.target)] },
];

/**
 * Compute the structural drift between the working DesiredState and the git
 * (canonical) DesiredState.
 *
 * PURE: does not mutate its arguments and has no side effects. Identical
 * inputs yield an empty array. The result is deterministically ordered by
 * `key` so it is reproducible across runs.
 *
 * This function ONLY describes divergence — it never corrects, reconciles, or
 * deletes anything (fail-safe principle).
 *
 * @param working The desired state as present in the working tree.
 * @param git     The desired state as committed/canonical in git.
 * @returns Drift items (each classified `conflict`), sorted by key.
 */
export function diffManifest(
  working: DesiredState,
  git: DesiredState,
): ManifestDriftItem[] {
  const items: ManifestDriftItem[] = [];

  for (const { field, prefix, partsOf } of COLLECTIONS) {
    const workingItems = indexBy(
      (working[field] ?? []) as Array<Record<string, unknown>>,
      partsOf,
      prefix,
    );
    const gitItems = indexBy(
      (git[field] ?? []) as Array<Record<string, unknown>>,
      partsOf,
      prefix,
    );

    for (const [key, wVal] of workingItems) {
      const gVal = gitItems.get(key);
      if (gVal === undefined) {
        items.push({
          key,
          entityKind: prefix,
          kind: "present-only-in-working",
          errorClass: "conflict",
          working: wVal,
        });
      } else if (!stableEqual(wVal, gVal)) {
        items.push({
          key,
          entityKind: prefix,
          kind: "changed",
          errorClass: "conflict",
          working: wVal,
          git: gVal,
        });
      }
    }

    for (const [key, gVal] of gitItems) {
      if (!workingItems.has(key)) {
        items.push({
          key,
          entityKind: prefix,
          kind: "present-only-in-git",
          errorClass: "conflict",
          git: gVal,
        });
      }
    }
  }

  // Deterministic ordering: sort by the stable entity key.
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `entityKey → item` map. The key is built via the SHARED
 * `entityKey(prefix, ...parts)` (state-store-helper.ts) — every component is
 * escaped by `escapePart`, so a `:`-bearing entity name can never alias a
 * different entity (follow-up #40: this removes the last raw-key site in the
 * codebase). Behaviour is identical to the previous raw interpolation for any
 * `:`-free name (all Fase-1 drift-manifest tests stay green).
 *
 * The parser (desired-state.ts) already rejects duplicate identifiers, so a
 * "last wins" merge here is unreachable for parsed manifests; it is harmless
 * for hand-built DesiredState fixtures.
 */
function indexBy(
  arr: Array<Record<string, unknown>>,
  partsOf: (item: Record<string, unknown>) => string[],
  prefix: string,
): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const item of arr) {
    m.set(entityKey(prefix, ...partsOf(item)), item);
  }
  return m;
}

/**
 * Order-independent deep structural equality via canonical JSON.
 * Object keys are sorted recursively so that field reordering in the manifest
 * does NOT register as drift (only true value changes do).
 */
function stableEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
