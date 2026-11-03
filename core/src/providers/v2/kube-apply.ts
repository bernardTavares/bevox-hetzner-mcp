/**
 * core/src/providers/v2/kube-apply.ts
 *
 * Bloco E — Kubernetes/k3s provider (Phase 1, Tasks 2 + 5 + 6 + 7 + 9).
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md §2.1, §2.3, §2.5, Q-b
 *
 * Exports:
 *   kubeIdentityKey   — Task 2: canonical resource identity key
 *   manifestHash      — Task 5: sha256 hex digest of the manifest body
 *   annotateManifest  — Task 5: injects hetzner-mcp/manifest-hash into metadata
 *   MANIFEST_HASH_ANNOTATION — Task 5: canonical annotation key constant
 *   createKubernetesProvider — Tasks 6/7/9: observe / apply / verify / destroy
 */

import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

import type { KubeManifest } from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type { ApplyContext, SecretResolver } from "../../store/secrets.js";
import type { ObservedEntity } from "../provider.js";
import type { KubeTransport } from "./kube-transport.js";

// ---------------------------------------------------------------------------
// Task 2 — identity key
// ---------------------------------------------------------------------------

/**
 * Returns the canonical identity key for a KubeManifest.
 * Format: `kube:<host>/<namespace>/<kind>/<name>`
 *
 * The `host` segment disambiguates manifests across clusters (spec §2.1, Q-c).
 */
export function kubeIdentityKey(m: KubeManifest): string {
  return `kube:${m.host}/${m.namespace}/${m.kind}/${m.metadata.name}`;
}

// ---------------------------------------------------------------------------
// Task 5 — content-hash annotation helpers
// ---------------------------------------------------------------------------

/**
 * Canonical annotation key injected into every applied manifest.
 * Used by observe() to read the live hash back and by apply() to detect
 * whether a re-apply is a no-op (Q-b change-detection signal).
 */
export const MANIFEST_HASH_ANNOTATION = "hetzner-mcp/manifest-hash";

/**
 * Returns the sha256 hex digest of `body`.
 *
 * CRITICAL: `body` MUST be the manifest in its plan/observe form — i.e. it
 * still contains `secret:<ref>` REFERENCES, NOT resolved values. Secret
 * resolution happens later, inside apply() only (Task 7), AFTER hashing.
 * This ensures:
 *   (a) the hash is stable across applies (same refs → same hash),
 *   (b) the hash never contains or reveals a secret value,
 *   (c) observe() can compute the same hash without resolving any secret.
 *
 * A sha256 hex digest is one-way and reveals nothing about the input even
 * if the input contained a resolved secret — but by design it never does.
 */
export function manifestHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Parses `body` as YAML, sets `metadata.annotations[MANIFEST_HASH_ANNOTATION]`
 * to `hash`, and returns the re-serialized YAML string.
 *
 * - Creates `metadata` and/or `metadata.annotations` if absent.
 * - Does NOT mutate any other field.
 * - Pure: no I/O, no SSH, no secret resolution.
 *
 * kubectl accepts re-serialized YAML on stdin (single-document only).
 * Multi-document YAML bodies (---) are not supported by KubeManifest.body;
 * each manifest in the desired state is a separate KubeManifest entity.
 */
export function annotateManifest(body: string, hash: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc: Record<string, unknown> = yamlParse(body) as Record<
    string,
    unknown
  >;

  // Ensure metadata exists.
  if (
    doc["metadata"] === null ||
    doc["metadata"] === undefined ||
    typeof doc["metadata"] !== "object"
  ) {
    doc["metadata"] = {};
  }
  const metadata = doc["metadata"] as Record<string, unknown>;

  // Ensure annotations exists.
  if (
    metadata["annotations"] === null ||
    metadata["annotations"] === undefined ||
    typeof metadata["annotations"] !== "object"
  ) {
    metadata["annotations"] = {};
  }
  const annotations = metadata["annotations"] as Record<string, string>;

  annotations[MANIFEST_HASH_ANNOTATION] = hash;

  return yamlStringify(doc);
}

// ---------------------------------------------------------------------------
// Task 6 — KubernetesProvider.observe (read-only, by identity)
// ---------------------------------------------------------------------------

/**
 * LENIENT wire schema for a `kubectl get -o json` object. We read ONLY the
 * fields the MINIMAL PROJECTION needs (identity + the manifest-hash annotation
 * + resourceVersion); the rest of the k8s document is ignored — NEVER copied
 * into the returned payload. Per `.claude/rules/esm-nodenext.md` Rule 4: NEVER
 * `as`-cast `JSON.parse` — every byte off the wire is Zod-validated, even an
 * arbitrary k8s object (`.passthrough()` keeps validation lenient without
 * pulling unknown fields into the typed surface we project from).
 *
 * SECURITY: observe() builds its payload by PROJECTION (see below) — it copies
 * only the listed fields. Arbitrary live `spec` / `data` / `stringData` /
 * `status` / labels / other annotations are STRUCTURALLY excluded, so a value
 * a user inlined into any non-Secret spec (resolved at apply by Task 7) can
 * never land in the observed store (ground rule #4 / secrets-resolution.md
 * "observed-state storage … references only").
 */
const KubeGetObjectSchema = z
  .object({
    apiVersion: z.string().optional(),
    kind: z.string().optional(),
    metadata: z
      .object({
        name: z.string().optional(),
        namespace: z.string().optional(),
        resourceVersion: z.string().optional(),
        annotations: z.record(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Task 7 — apply() helpers (hash-compare + secret substitution)
// ---------------------------------------------------------------------------

/**
 * The MINIMAL, secret-free PROJECTION observe() returns as `ObservedEntity.payload`.
 *
 * It carries ONLY identity (apiVersion/kind/namespace/name), the live
 * `hetzner-mcp/manifest-hash` annotation value (`manifestHash` — the signal
 * apply()/verify() compare against; `null` when absent), and the cheap,
 * secret-free `resourceVersion`. NOTHING else: NO `spec`, NO `data`/`stringData`,
 * NO `status`, NO other annotations, NO labels. This is the structural close of
 * the residual where a `secret:<ref>` inlined into a non-Secret spec — resolved
 * at apply by Task 7 and written into the live object — would otherwise be read
 * back into the observed store (ground rule #4 / secrets-resolution.md).
 */
export interface KubeObservedProjection {
  readonly apiVersion: string | null;
  readonly kind: string | null;
  readonly namespace: string | null;
  readonly name: string | null;
  /** Live `hetzner-mcp/manifest-hash` annotation value, or `null` if absent. */
  readonly manifestHash: string | null;
  /** Live `metadata.resourceVersion`, included when present (secret-free). */
  readonly resourceVersion?: string;
}

/**
 * LENIENT projection of an `ObservedEntity.payload` (`unknown`) down to the
 * single thing apply() needs: the LIVE `hetzner-mcp/manifest-hash` value, read
 * from the minimal projection observe() returns (`payload.manifestHash`). Per
 * `.claude/rules/esm-nodenext.md` Rule 4, payload is wire-ish (built by
 * observe() but typed `unknown` at the port) so we Zod-parse it — NEVER
 * `as`-cast — before reading. A payload that does not match (or carries a
 * `null` hash) safely yields `undefined` ⇒ treated as a hash mismatch ⇒ apply
 * runs.
 */
const ObservedHashSchema = z
  .object({
    manifestHash: z.string().nullish(),
  })
  .passthrough();

/** Read the live manifest-hash off an observed projection payload, or undefined. */
function observedManifestHash(
  observed: ObservedEntity | null,
): string | undefined {
  if (observed === null) return undefined;
  const parsed = ObservedHashSchema.safeParse(observed.payload);
  if (!parsed.success) return undefined;
  return parsed.data.manifestHash ?? undefined;
}

/**
 * Matches every `secret:<name>` token in a manifest body. Same `<name>` grammar
 * as `core/src/store/secrets.ts` SECRET_REF_RE ([a-z0-9][a-z0-9_-]*). `g` so
 * all occurrences resolve. The captured ref (`secret:<name>`) is non-secret —
 * only the RESOLVED value is sensitive, and it appears ONLY in the returned
 * string that is piped to stdin.
 */
const SECRET_TOKEN_RE = /secret:[a-z0-9][a-z0-9_-]*/g;

export interface KubernetesProviderOptions {
  /** The kubectl-over-SSH seam (Task 4). The provider drives ONLY this. */
  readonly transport: KubeTransport;

  /**
   * Task 7 SECRET-AT-APPLY SEAM (OPTIONAL — additive, backward-compatible).
   *
   * Mirrors `DockerProvider`'s `secretResolver` option. When BOTH this resolver
   * AND a valid per-call `ApplyContext` (the `ctx` arg of `apply`) are present,
   * apply() substitutes each `secret:<ref>` token in the manifest body with its
   * resolved value — ONLY in the bytes piped to `kubectl apply -f -` over STDIN,
   * ONLY at apply, ONLY behind secrets.ts's unforgeable gate.
   *
   * When EITHER is absent (the default / plan / dry_run / isolation tests),
   * apply() leaves every `secret:<ref>` token verbatim and still applies — the
   * ref stays a ref (mirrors docker.ts's no-resolver/no-token default). No
   * secret value can surface anywhere by construction.
   *
   * `secretResolver` is a long-lived dependency (like docker.ts's), so it is
   * factory-injected; the apply-only `ApplyContext` is the per-call capability
   * that rebinds resolution to each apply cycle (see `apply`'s `ctx` arg).
   */
  readonly secretResolver?: SecretResolver;
}

export interface KubernetesProvider {
  readonly name: string;
  /**
   * Read-only observe BY IDENTITY. Returns the enriched observed slice
   * (`{ key, payload }`) for the live object, or `null` when it is absent.
   * Takes NO `ApplyContext` — structurally unable to resolve a secret.
   */
  observe(manifest: KubeManifest): Promise<ObservedEntity | null>;
  /**
   * Converge the cluster toward `desired` via `kubectl apply -f -` (NEVER
   * `--prune`). Idempotent by content hash: when `observed` carries the SAME
   * `hetzner-mcp/manifest-hash` annotation as the desired body's hash, apply is a
   * STRICT no-op (`changed:false`, NO kubectl call). Otherwise the annotated
   * manifest (with `secret:<ref>` resolved ONLY when a `secretResolver` + a
   * valid `ctx` ApplyContext are present) is piped on STDIN and `changed:true`
   * is returned.
   *
   * `ctx` is the apply-only capability token (secrets.ts `createApplyContext()`)
   * forwarded by the apply boundary (Task 14's tool). It is `undefined` on
   * plan/dry_run/observe paths, so they are STRUCTURALLY unable to resolve a
   * secret. Carries NO secret material (an opaque brand).
   */
  apply(
    desired: KubeManifest,
    observed: ObservedEntity | null,
    ctx?: ApplyContext,
  ): Promise<KubeApplyResult>;
  /**
   * Read-only confirmation that reality == desired (spec §2.3 / §2.5).
   * Runs ONLY `kubectl get` (via observe) and compares the LIVE
   * `hetzner-mcp/manifest-hash` annotation against `manifestHash(desired.body)`.
   * Returns `true` iff equal; `false` on mismatch OR when the object is absent.
   * Takes NO `ApplyContext` — structurally unable to resolve a secret; mutates
   * nothing (mirrors `LoadBalancerProvider.verify`).
   */
  verify(desired: KubeManifest): Promise<boolean>;
  /**
   * Gated, identity-addressed delete (spec §2.3 / §2.5; fail-safe.md). Issues
   * EXACTLY `kubectl delete <kind> <name> -n <ns>` — NEVER `--prune`, NEVER
   * `-f`, NO body on stdin. Reachable ONLY via the gated tool path (Task 14):
   * it runs when the desired-state explicitly removes the manifest AND the
   * Approval Gate approved. apply() NEVER calls destroy() on any error path.
   */
  destroy(desired: KubeManifest): Promise<KubeApplyResult>;
}

/**
 * The outcome of one `apply()`. `entity` is the `kubeIdentityKey`; `changed`
 * is the idempotency signal (true ⇒ a `kubectl apply` ran; false ⇒ strict
 * hash-driven no-op, NO kubectl call). NEVER carries a resolved secret value.
 */
export interface KubeApplyResult {
  readonly entity: string;
  readonly changed: boolean;
}

/**
 * Build a `KubernetesProvider` over the injected `KubeTransport`.
 *
 * `observe()` runs `kubectl get <kind> <name> -n <ns> -o json --ignore-not-found`
 * by identity (read-only — fail-safe.md: no apply/delete verb ever). The
 * `--ignore-not-found` flag makes kubectl exit 0 with EMPTY stdout when the
 * object is absent, so absence maps to `null` cleanly WITHOUT the transport
 * throwing `ReconcileError("fatal")` on a non-zero NotFound exit (the catch-and-
 * inspect-stderr alternative is more brittle: it depends on kubectl's exact
 * NotFound wording and on the transport not suppressing the excerpt — the
 * `--ignore-not-found` exit-0 path is deterministic).
 *
 * The `{ key, payload }` shape mirrors `core/src/reconciler/observed-adapter.ts`.
 * The `key` is `kubeIdentityKey(manifest)`. The `payload` is a MINIMAL,
 * secret-free PROJECTION (`KubeObservedProjection`) — NOT the full live object:
 * identity (apiVersion/kind/namespace/name), the LIVE `hetzner-mcp/manifest-hash`
 * annotation value (so apply/verify can compare it against
 * `manifestHash(desiredBody)`), and (when present) the secret-free
 * `metadata.resourceVersion`. NOTHING else.
 *
 * Building by PROJECTION (copy only the listed fields) — rather than copying the
 * full object and stripping known-bad fields — is the structural guarantee: the
 * live `spec` / `data` / `stringData` / `status` / labels / arbitrary
 * annotations (including `kubectl.kubernetes.io/last-applied-configuration`) are
 * NEVER copied. This closes the residual where a `secret:<ref>` inlined into a
 * non-Secret spec — resolved at apply by Task 7 and written into the live
 * object — would otherwise be read back into the observed store / get_state.
 *
 * Observed state carries refs/identity only, never a secret value
 * (secrets-resolution.md). observe resolves NO secret.
 */
export function createKubernetesProvider(
  opts: KubernetesProviderOptions,
): KubernetesProvider {
  const { transport } = opts;
  const secretResolver = opts.secretResolver;

  /**
   * Substitute every `secret:<ref>` token in `body` with its resolved value —
   * ONLY when BOTH a `secretResolver` AND a valid `ctx` ApplyContext are
   * present (mirrors docker.ts's no-resolver/no-token default: absent ⇒ refs
   * left verbatim). Resolution is gated by secrets.ts's unforgeable
   * ApplyContext; a value-free "deferred" result (the v1 stub) leaves the ref
   * unchanged — only an explicit "ok" value is substituted.
   *
   * SECRET HYGIENE: any error thrown by the resolver is wrapped so a resolved
   * value can never appear in `.message`/`.cause` — the message names ONLY the
   * (non-secret) ref. The resolved value lives ONLY in the returned string,
   * which apply() pipes straight to stdin and never logs or returns.
   */
  async function resolveSecretsInBody(
    body: string,
    ctx: ApplyContext | undefined,
  ): Promise<string> {
    if (secretResolver === undefined || ctx === undefined) return body;

    // Collect the distinct refs first so each resolves at most once.
    const refs = new Set(body.match(SECRET_TOKEN_RE) ?? []);
    if (refs.size === 0) return body;

    const resolved = new Map<string, string>();
    for (const ref of refs) {
      let result;
      try {
        result = await secretResolver.resolve(ref, ctx);
      } catch (err) {
        // Wrap: the resolver already keeps its messages secret-free, but
        // double-guard — surface ONLY the ref, never re-emit `err` verbatim
        // (it could, in a future backend, carry a value in .message/.cause).
        void err;
        throw new ReconcileError(
          "fatal",
          `Kube apply: secret resolution failed for ${ref}`,
          { entity: ref },
        );
      }
      // Only an explicit "ok" value is substituted; "deferred" leaves the ref.
      if (result.status === "ok") resolved.set(ref, result.value);
    }

    // Replace verbatim. The captured ref is the lookup key; an unresolved ref
    // (deferred) stays as-is.
    return body.replace(SECRET_TOKEN_RE, (ref) => resolved.get(ref) ?? ref);
  }

  /**
   * Read-only observe BY IDENTITY (extracted to a named closure so verify()
   * can reuse it without `this`). See the factory header for the full contract.
   */
  async function observe(
    manifest: KubeManifest,
  ): Promise<ObservedEntity | null> {
    const { kind, namespace } = manifest;
    const name = manifest.metadata.name;

    const res = await transport.kubectl([
      "get",
      kind,
      name,
      "-n",
      namespace,
      "-o",
      "json",
      "--ignore-not-found",
    ]);

    // --ignore-not-found ⇒ exit 0 + empty stdout when the object is absent.
    if (res.stdout.trim() === "") return null;

    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout);
    } catch {
      // Malformed JSON from kubectl is a clear, permanent failure — not a
      // silently-skipped slice. Surface it (no secret can be present here:
      // observe pipes no body and resolves nothing).
      throw new ReconcileError(
        "fatal",
        `Kube observe: kubectl returned non-JSON for ${kubeIdentityKey(manifest)}`,
        { entity: kubeIdentityKey(manifest) },
      );
    }

    const parsed = KubeGetObjectSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReconcileError(
        "fatal",
        `Kube observe: unexpected object shape for ${kubeIdentityKey(manifest)}`,
        { entity: kubeIdentityKey(manifest) },
      );
    }

    // Build a MINIMAL, secret-free PROJECTION (ground rule #4 /
    // secrets-resolution.md "observed-state storage … references only"). We
    // COPY ONLY the listed fields — NEVER the live `spec` / `data` /
    // `stringData` / `status` / labels / arbitrary annotations. This closes the
    // residual where a `secret:<ref>` inlined into a non-Secret spec (resolved
    // at apply by Task 7, then written into the live object) would otherwise be
    // read back into the observed store / get_state.
    const obj = parsed.data;
    const metadata = obj.metadata;

    const projection: KubeObservedProjection = {
      apiVersion: obj.apiVersion ?? null,
      kind: obj.kind ?? null,
      namespace: metadata?.namespace ?? null,
      name: metadata?.name ?? null,
      // The live hetzner-mcp/manifest-hash annotation value — the ONLY annotation
      // copied (a benign one-way digest); all others are excluded. null/absent
      // ⇒ apply/verify treat it as a mismatch.
      manifestHash: metadata?.annotations?.[MANIFEST_HASH_ANNOTATION] ?? null,
      // resourceVersion is cheap, secret-free, and useful for observability —
      // include it only when present.
      ...(metadata?.resourceVersion !== undefined
        ? { resourceVersion: metadata.resourceVersion }
        : {}),
    };

    return { key: kubeIdentityKey(manifest), payload: projection };
  }

  return {
    name: "kubernetes",

    observe,

    /**
     * Converge via `kubectl apply -f -` (NEVER `--prune`, NEVER delete).
     *
     * STRICT hash-driven idempotency (Q-b): `desiredHash = manifestHash(body)`
     * over the body in its PLAN/OBSERVE form (still containing `secret:<ref>`
     * REFERENCES, NOT resolved values). When the observed payload carries the
     * SAME live `hetzner-mcp/manifest-hash` annotation, apply is a STRICT no-op —
     * `changed:false` and NO kubectl call (the property test in Task 13 depends
     * on this: cycle 2..N is a strict no-op). The hash is NEVER recomputed from
     * kubectl output.
     *
     * Because the hash is over the REF form, rotating ONLY a secret value (same
     * `secret:<ref>`) does NOT re-trigger apply — that is the documented,
     * accepted consequence (secret rotation is YAGNI v1; spec §2.3 / §2.4).
     *
     * Secret resolution order (mirrors docker.ts):
     *   1. desiredHash = manifestHash(desired.body)  — refs form.
     *   2. annotated   = annotateManifest(desired.body, desiredHash) — ref form.
     *   3. resolve secret:<ref> in `annotated` → `resolved`, ONLY behind a
     *      valid secretResolver + ApplyContext (else refs stay refs).
     *   4. pipe `resolved` to `kubectl apply -f -` (body on STDIN, never argv,
     *      never --prune).
     *   5. return changed:true.
     *
     * FAIL-SAFE: a failed apply (transport throws a SECRET-FREE error — the
     * KubeTransport suppresses the stdin excerpt on a body-piped failure)
     * leaves cluster state in place. We NEVER delete/destroy on an error path.
     */
    async apply(
      desired: KubeManifest,
      observed: ObservedEntity | null,
      ctx?: ApplyContext,
    ): Promise<KubeApplyResult> {
      const entity = kubeIdentityKey(desired);

      // (1) hash over the REF form (never the resolved value).
      const desiredHash = manifestHash(desired.body);

      // STRICT no-op: equal live annotation ⇒ no kubectl call at all.
      if (observedManifestHash(observed) === desiredHash) {
        return { entity, changed: false };
      }

      // (2) annotate the ref-form body with the hash.
      const annotated = annotateManifest(desired.body, desiredHash);

      // (3) resolve secret:<ref> ONLY behind resolver + valid ApplyContext.
      // The resolved string is the ONLY place a secret value lives; it is
      // piped straight to stdin and never logged/returned.
      const resolved = await resolveSecretsInBody(annotated, ctx);

      // (4) pipe to `kubectl apply -f -` — body on STDIN, NEVER argv, NEVER
      // --prune. The transport throws a secret-free ReconcileError on a
      // non-zero kubectl exit; we let it propagate (fail-safe: no rollback,
      // no delete). We deliberately do NOT echo `resolved` anywhere.
      await transport.kubectl(["apply", "-f", "-"], resolved);

      // (5) created/configured.
      return { entity, changed: true };
    },

    /**
     * Read-only verify (spec §2.3 / §2.5; mirrors LoadBalancerProvider.verify).
     * Drives ONLY `kubectl get` (via observe — no mutating verb, no stdin body)
     * and returns `true` iff the LIVE `hetzner-mcp/manifest-hash` annotation
     * equals `manifestHash(desired.body)` (the ref-form hash apply uses). A
     * mismatch OR an absent object (observe → null ⇒ no live hash) yields
     * `false`. verify NEVER applies, NEVER deletes, resolves NO secret.
     */
    async verify(desired: KubeManifest): Promise<boolean> {
      const observed = await observe(desired);
      if (observed === null) return false;
      return observedManifestHash(observed) === manifestHash(desired.body);
    },

    /**
     * Gated, identity-addressed delete (spec §2.3 / §2.5; fail-safe.md).
     *
     * Issues EXACTLY `kubectl delete <kind> <name> -n <ns>` — by identity, NO
     * `--prune` (that would silently fail-delete objects absent from the
     * applied set), NO `-f`, NO body on stdin (so no manifest/secret crosses
     * the wire). Returns `{ entity, changed:true }`.
     *
     * FAIL-SAFE: this is a SEPARATE method, reachable ONLY via the gated tool
     * path (Task 14) — it runs when the desired-state explicitly removes the
     * manifest AND the Approval Gate approved. apply() NEVER calls destroy() on
     * any error path; the provider never deletes on its own initiative.
     */
    async destroy(desired: KubeManifest): Promise<KubeApplyResult> {
      const { kind, namespace } = desired;
      const name = desired.metadata.name;
      await transport.kubectl(["delete", kind, name, "-n", namespace]);
      return { entity: kubeIdentityKey(desired), changed: true };
    },
  };
}
