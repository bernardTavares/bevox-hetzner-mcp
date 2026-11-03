/**
 * core/src/domain/desired-state.ts
 *
 * Parses a YAML manifest into a typed DesiredState.
 *
 * Design constraints (from spec + Task 1.3):
 *   - secret: refs (env values that start with "secret:") are preserved
 *     verbatim as plain strings — never resolved or expanded. (The dead
 *     env_from field was removed; see 2026-05-28-manifest-schema-gaps.md.)
 *   - YAML syntax errors → ReconcileError("precondition") with line/col.
 *   - Zod validation failures → ReconcileError("precondition") with source path.
 *   - No console import; no rollback; no side effects.
 */

import { z } from "zod";
import { parseDocument, YAMLParseError, YAMLWarning } from "yaml";

import { ReconcileError } from "./errors.js";

// ---------------------------------------------------------------------------
// Manifest-specific item schemas
//
// The manifest is a *declarative intent* form; it is a subset of the observed
// state entity schemas (entities.ts). Fields that are only meaningful in the
// observed state (status, hcloud_id, container_ids, …) are omitted.
// secret: refs appear as plain strings → validated as z.string() only.
//
// NOTE: Item schemas (ManifestServer, ManifestVolume, …) are intentionally
// NOT strict — unknown keys are stripped to allow forward-compat manifests
// written for a newer server version to parse safely on an older parser.
// The TOP-LEVEL DesiredStateSchema IS strict (see below) to catch typos such
// as `servics:` that would otherwise silently drop an entire collection.
// ---------------------------------------------------------------------------

/** Server as expressed in a manifest (no status, no internal IDs). */
const ManifestServerSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  location: z.string().min(1),
  network: z.string().min(1),
  // image is OPTIONAL in the manifest: the spec canonical example omits it
  // and the reconciler may default to a base image at provision time.
  // This intentionally diverges from ServerSchema.image (required) because
  // the manifest expresses *desired intent*, not the fully-resolved entity.
  image: z.string().optional(),
  ssh_keys: z.array(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  // cloud-init passthrough → Hetzner POST /servers `user_data` (Bug 3). Lets a
  // fresh server come up with Docker pre-installed. Omitted ⇒ not sent.
  user_data: z.string().optional(),
});

/** Network as expressed in a manifest. */
const ManifestNetworkSchema = z.object({
  name: z.string().min(1),
  ip_range: z.string().min(1),
  subnets: z.array(z.string()).optional(),
});

/** Volume as expressed in a manifest. */
const ManifestVolumeSchema = z.object({
  name: z.string().min(1),
  size: z.string().min(1),
  server: z.string().optional(),
  // fs is REQUIRED in the manifest: volumes always need a filesystem type
  // (mirrors VolumeSchema.fs which is also required in entities.ts).
  fs: z.string().min(1),
  mount_path: z.string().optional(),
});

/** Docker restart policy (gap #4). Mirrors the Engine RestartPolicy.Name set. */
const RestartPolicySchema = z.enum([
  "no",
  "on-failure",
  "always",
  "unless-stopped",
]);

/** Duration string accepted for wait_healthy_timeout (gap #2): "<N>s" | "<N>m". */
const DurationSchema = z.string().regex(/^\d+[sm]$/);

/**
 * One depends_on entry (gap #2). Short form is the bare service name; object
 * form adds an optional per-dep wait_healthy_timeout (used in Phase 2.0 —
 * parsed and validated here, ordering-only in Phase 1).
 */
const DependsOnEntrySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    wait_healthy_timeout: DurationSchema.optional(),
  }),
]);

/** Compose-style container healthcheck (gap #2, Phase 2.1). */
const HealthcheckSchema = z.object({
  test: z.array(z.string()).min(1),
  interval: DurationSchema.optional(),
  timeout: DurationSchema.optional(),
  retries: z.number().int().positive().optional(),
  start_period: DurationSchema.optional(),
});

/**
 * Service as expressed in a manifest.
 *
 * env: values may be "secret:NAME" strings — preserved verbatim (the only
 * working secret channel; see docs/manifest-schema-cheatsheet.md).
 */
const ManifestServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  replicas: z.number().int().positive(),
  // container argv → Docker Engine Cmd (gap #1). Optional: omitted ⇒ no Cmd.
  command: z.array(z.string()).optional(),
  // restart policy → HostConfig.RestartPolicy (gap #4). Omitted ⇒ not set.
  restart: RestartPolicySchema.optional(),
  // intra-service ordering (gap #2). Manifest-only: stripped before the
  // provider (entities ServiceSchema lacks it), never enters the container
  // body or isConverged. Consumed by the reconciler DAG (task 1.6).
  depends_on: z.array(DependsOnEntrySchema).optional(),
  // declarative healthcheck → ContainerCreate.Healthcheck (gap #2, Phase 2.1).
  // Overrides the image HEALTHCHECK (compose precedence). Omitted ⇒ not set.
  healthcheck: HealthcheckSchema.optional(),
  // secret: refs stay as plain strings; no resolution ever happens here.
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
});

/** DNS record as expressed in a manifest. */
const ManifestDnsRecordSchema = z.object({
  zone: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  value: z.string().min(1),
  ttl: z.number().int().positive().optional(),
});

/** Backup policy as expressed in a manifest (repo is optional at declare-time). */
const ManifestBackupSchema = z.object({
  target: z.string().min(1),
  schedule: z.string().min(1),
  retention: z.string().min(1),
  repo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// DesiredStateSchema — the full manifest shape
// All collections are optional (a manifest need not declare all resource types)
//
// .strict() is applied at the TOP LEVEL ONLY: an unknown top-level key (e.g.
// `servics:` as a typo for `servers:`) triggers a Zod validation failure which
// is surfaced as ReconcileError("precondition"). Without .strict() the typo
// would silently drop every service declared under that key — a silent loss of
// manifest intent that violates the fail-safe principle.
//
// Item schemas (ManifestServer, ManifestVolume, …) are NOT strict so that
// manifests written for a future parser version can be consumed safely.
// ---------------------------------------------------------------------------

export const DesiredStateSchema = z
  .object({
    servers: z.array(ManifestServerSchema).optional(),
    networks: z.array(ManifestNetworkSchema).optional(),
    volumes: z.array(ManifestVolumeSchema).optional(),
    services: z.array(ManifestServiceSchema).optional(),
    dns: z.array(ManifestDnsRecordSchema).optional(),
    backups: z.array(ManifestBackupSchema).optional(),
  })
  .strict();

export type DesiredState = z.infer<typeof DesiredStateSchema>;

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

export interface ParseManifestOptions {
  /** Path shown in error messages for file/line context. */
  sourcePath?: string;
}

/**
 * Parse a YAML manifest string into a typed DesiredState.
 *
 * @throws ReconcileError("precondition", ...) on YAML syntax error,
 *         non-object/empty root, Zod validation failure, or duplicate
 *         identifiers within a collection. The message always includes
 *         sourcePath and, when available, line/column information.
 */
export function parseManifest(
  yamlText: string,
  opts?: ParseManifestOptions,
): DesiredState {
  const src = opts?.sourcePath ?? "<manifest>";

  // -------------------------------------------------------------------------
  // Phase 1 — YAML parse (capture line/col on syntax errors)
  // -------------------------------------------------------------------------
  let raw: unknown;
  try {
    // parseDocument gives us line/col in errors; .toJS() converts to plain JS.
    const doc = parseDocument(yamlText, { prettyErrors: true });

    // Collect YAML parse errors (syntax issues)
    if (doc.errors.length > 0) {
      const first = doc.errors[0]!;
      // YAMLError carries .pos (character offset) and .linePos ([{line,col}])
      const lineInfo = buildLineInfo(first);
      throw new ReconcileError(
        "precondition",
        `${src}${lineInfo}: YAML syntax error — ${first.message}`,
        { entity: src },
      );
    }

    raw = doc.toJS();
  } catch (e) {
    // Re-throw ReconcileErrors as-is
    if (e instanceof ReconcileError) throw e;

    // YAMLParseError thrown directly (e.g. by strict mode)
    if (e instanceof YAMLParseError) {
      const lineInfo = buildLineInfo(e);
      throw new ReconcileError(
        "precondition",
        `${src}${lineInfo}: YAML syntax error — ${e.message}`,
        { entity: src, cause: e },
      );
    }

    // Unknown parse error — wrap as precondition
    const msg = e instanceof Error ? e.message : String(e);
    throw new ReconcileError("precondition", `${src}: YAML parse error — ${msg}`, {
      entity: src,
      cause: e,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 1b — root shape guard (non-object / empty / null / array roots)
  //
  // A YAML file that is entirely comments, empty, a scalar ("hello"), or a
  // sequence ("- a") would pass Zod as an empty object or fail with a confusing
  // message.  Detect early and emit a clear precondition error.
  // -------------------------------------------------------------------------
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new ReconcileError(
      "precondition",
      `${src}: manifest root must be a YAML mapping`,
      { entity: src },
    );
  }

  // -------------------------------------------------------------------------
  // Phase 2 — Zod schema validation
  // -------------------------------------------------------------------------
  const result = DesiredStateSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ReconcileError(
      "precondition",
      `${src}: manifest validation failed — ${issues}`,
      { entity: src },
    );
  }

  // -------------------------------------------------------------------------
  // Phase 3 — Duplicate-identifier guard
  //
  // Zod does not detect duplicate array entries with the same name.  A manifest
  // with two servers named "app-1" is ambiguous: the reconciler cannot know which
  // declaration wins.  Reject early as a precondition error so nothing is applied.
  //
  // Identifying field per collection:
  //   servers   → name
  //   networks  → name
  //   volumes   → name
  //   services  → name
  //   dns       → zone+":"+name+":"+type  (natural composite key for DNS records)
  //   backups   → target  (backup policies are keyed by the resource they protect)
  // -------------------------------------------------------------------------
  const state = result.data;

  checkNoDuplicates("servers", state.servers ?? [], (s) => s.name, src);
  checkNoDuplicates("networks", state.networks ?? [], (n) => n.name, src);
  checkNoDuplicates("volumes", state.volumes ?? [], (v) => v.name, src);
  checkNoDuplicates("services", state.services ?? [], (s) => s.name, src);
  checkNoDuplicates(
    "dns",
    state.dns ?? [],
    (d) => `${d.zone}:${d.name}:${d.type}`,
    src,
  );
  checkNoDuplicates("backups", state.backups ?? [], (b) => b.target, src);

  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert no two items in a collection share the same identifying key.
 * On the first duplicate found, throws ReconcileError("precondition") naming
 * the collection and the duplicated value.
 */
function checkNoDuplicates<T>(
  collection: string,
  items: T[],
  keyOf: (item: T) => string,
  src: string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      throw new ReconcileError(
        "precondition",
        `${src}: ${collection}: name "${key}" already declared in this collection`,
        { entity: collection },
      );
    }
    seen.add(key);
  }
}

/**
 * Build a " line:col" string from a yaml library error if position is available.
 * The yaml library attaches .linePos as [{line,col}] (1-based) on both
 * YAMLParseError and YAMLWarning instances.
 */
function buildLineInfo(err: YAMLParseError | YAMLWarning): string {
  if (Array.isArray(err.linePos) && err.linePos.length > 0) {
    const pos = err.linePos[0]!;
    return ` line ${pos.line}, col ${pos.col}`;
  }
  return "";
}
