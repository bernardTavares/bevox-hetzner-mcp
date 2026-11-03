/**
 * core/src/providers/v2/kube-apply.test.ts
 *
 * Task 2 — kube identity key helper
 * Task 5 — content-hash annotation helpers (manifestHash, annotateManifest)
 * Task 6 — KubernetesProvider.observe() (by identity; Secret.data redacted)
 * Task 7 — KubernetesProvider.apply() (no --prune; hash no-op; secret at apply)
 * Task 9 — KubernetesProvider.verify() (read-only) + gated destroy() (no --prune)
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md §2.1, §2.3, §2.4, §2.5, Q-b
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  kubeIdentityKey,
  manifestHash,
  annotateManifest,
  MANIFEST_HASH_ANNOTATION,
  createKubernetesProvider,
} from "./kube-apply.js";
import type { KubeManifest } from "../../domain/entities-v2.js";
import { createKubeTransport } from "./kube-transport.js";
import { createSshExecRecorder } from "../../../test/fakes/ssh-exec-recorder.js";
import type { SshConnection } from "../ssh-exec.js";
import {
  createApplyContext,
  type ApplyContext,
  type SecretResolver,
  type SecretMeta,
  type SecretResolveResult,
} from "../../store/secrets.js";
import type { ObservedEntity } from "../provider.js";

describe("kubeIdentityKey", () => {
  const taskOneFixture: KubeManifest = {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: "...",
  };

  it("returns kube:<host>/<namespace>/<kind>/<name> for the Task-1 fixture", () => {
    expect(kubeIdentityKey(taskOneFixture)).toBe(
      "kube:prod-k3s/bevox/Deployment/api",
    );
  });

  it("two manifests differing only by host produce different keys (Q-c: host disambiguates)", () => {
    const otherHost: KubeManifest = { ...taskOneFixture, host: "staging-k3s" };
    expect(kubeIdentityKey(taskOneFixture)).not.toBe(
      kubeIdentityKey(otherHost),
    );
  });
});

describe("manifestHash (Task 5)", () => {
  it("is deterministic — same body produces the same hash", () => {
    const body = "apiVersion: apps/v1\nkind: Deployment\n";
    expect(manifestHash(body)).toBe(manifestHash(body));
  });

  it("differs for a one-byte change in the body", () => {
    const body = "apiVersion: apps/v1\nkind: Deployment\n";
    const bodyChanged = "apiVersion: apps/v1\nkind: DeplXyment\n";
    expect(manifestHash(body)).not.toBe(manifestHash(bodyChanged));
  });

  it("returns a 64-character lowercase hex string (sha256)", () => {
    const hash = manifestHash("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is computed over the plan-form body (secret refs, not values) — MANIFEST_HASH_ANNOTATION is exported", () => {
    // The annotation key must be the canonical constant used everywhere.
    expect(MANIFEST_HASH_ANNOTATION).toBe("hetzner-mcp/manifest-hash");
  });
});

describe("annotateManifest (Task 5)", () => {
  const baseBody = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: api",
    "  namespace: bevox",
    "spec:",
    "  replicas: 1",
  ].join("\n");

  it("injects the hetzner-mcp/manifest-hash annotation into the re-serialized YAML", () => {
    const hash = manifestHash(baseBody);
    const annotated = annotateManifest(baseBody, hash);
    expect(annotated).toContain(`${MANIFEST_HASH_ANNOTATION}: ${hash}`);
  });

  it("preserves other fields (kind, apiVersion, name, spec) after annotation", () => {
    const hash = manifestHash(baseBody);
    const annotated = annotateManifest(baseBody, hash);
    expect(annotated).toContain("Deployment");
    expect(annotated).toContain("apps/v1");
    expect(annotated).toContain("api");
    expect(annotated).toContain("replicas");
  });

  it("creates metadata.annotations if annotations are absent", () => {
    // baseBody has no annotations key — annotateManifest must create it
    const hash = "deadbeef";
    const annotated = annotateManifest(baseBody, hash);
    expect(annotated).toContain(MANIFEST_HASH_ANNOTATION);
  });

  it("does not mutate other annotations already present", () => {
    const bodyWithAnnotation = [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: cfg",
      "  annotations:",
      "    existing.io/key: kept",
    ].join("\n");
    const hash = manifestHash(bodyWithAnnotation);
    const annotated = annotateManifest(bodyWithAnnotation, hash);
    expect(annotated).toContain("existing.io/key: kept");
    expect(annotated).toContain(`${MANIFEST_HASH_ANNOTATION}: ${hash}`);
  });

  it("is pure — calling twice with the same body+hash produces the same output", () => {
    const hash = manifestHash(baseBody);
    expect(annotateManifest(baseBody, hash)).toBe(annotateManifest(baseBody, hash));
  });
});

describe("KubernetesProvider.observe (Task 6)", () => {
  const conn: SshConnection = {
    host: "prod-k3s",
    user: "root",
    port: 22,
    privateKey: "FAKE-KEY-not-secret-in-test",
    hostKeyPolicy: "accept-new",
  };

  const recorder = createSshExecRecorder();
  const transport = createKubeTransport({ run: recorder.run, conn });
  const provider = createKubernetesProvider({ transport });

  beforeEach(() => {
    recorder.reset();
  });

  const deploymentManifest: KubeManifest = {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: "...",
  };

  const LIVE_HASH = "a1b2c3d4e5f6";

  it("runs `kubectl get <kind> <name> -n <ns> -o json` by identity and returns a MINIMAL PROJECTION (identity + manifestHash)", async () => {
    recorder.setResultByMatcher(
      (argv) =>
        argv.includes("get") &&
        argv.includes("Deployment") &&
        argv.includes("api") &&
        argv.includes("bevox"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            resourceVersion: "424242",
            annotations: { [MANIFEST_HASH_ANNOTATION]: LIVE_HASH },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    const observed = await provider.observe(deploymentManifest);
    expect(observed).not.toBeNull();
    expect(observed?.key).toBe("kube:prod-k3s/bevox/Deployment/api");

    // The payload is a minimal, secret-free PROJECTION: identity + the live
    // manifest-hash annotation value (so apply/verify can compare against
    // manifestHash(desiredBody)) + optional resourceVersion. NOTHING else.
    const payload = observed?.payload as {
      apiVersion?: string;
      kind?: string;
      namespace?: string;
      name?: string;
      manifestHash?: string | null;
      resourceVersion?: string;
    };
    expect(payload.apiVersion).toBe("apps/v1");
    expect(payload.kind).toBe("Deployment");
    expect(payload.namespace).toBe("bevox");
    expect(payload.name).toBe("api");
    expect(payload.manifestHash).toBe(LIVE_HASH);
    expect(payload.resourceVersion).toBe("424242");

    // The raw k8s `spec` (and any other arbitrary field) is NEVER present.
    const serialized = JSON.stringify(observed?.payload);
    expect(serialized).not.toContain('"spec"');
    expect(serialized).not.toContain("replicas");
    // No raw `metadata` / `annotations` containers leak arbitrary fields.
    expect(serialized).not.toContain('"annotations"');

    // The kubectl argv is by identity and read-only — no apply/delete verb.
    const call = recorder.calls.at(-1);
    expect(call).toBeDefined();
    const argv = call!.remoteArgv;
    expect(argv).toContain("get");
    expect(argv).toContain("Deployment");
    expect(argv).toContain("api");
    expect(argv).toEqual(expect.arrayContaining(["-n", "bevox"]));
    expect(argv).toEqual(expect.arrayContaining(["-o", "json"]));
    expect(argv).not.toContain("apply");
    expect(argv).not.toContain("delete");
    // observe pipes NO stdin body (read-only).
    expect(call!.stdin).toBeUndefined();
  });

  it("returns null when the object is absent (kubectl get with empty stdout)", async () => {
    // With --ignore-not-found, kubectl exits 0 with EMPTY stdout when absent.
    recorder.setResult({ code: 0, stdout: "", stderr: "" });

    const observed = await provider.observe(deploymentManifest);
    expect(observed).toBeNull();
  });

  it("redacts Secret.data — the secret bytes never appear in the returned payload", async () => {
    const secretManifest: KubeManifest = {
      host: "prod-k3s",
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db-creds" },
      namespace: "bevox",
      body: "...",
    };
    const SECRET_BYTES = "c3VwZXItc2VjcmV0LXBhc3N3b3Jk"; // base64 secret value

    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Secret"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: "db-creds",
            namespace: "bevox",
            annotations: { [MANIFEST_HASH_ANNOTATION]: LIVE_HASH },
          },
          type: "Opaque",
          data: { password: SECRET_BYTES },
          stringData: { plain: "also-secret" },
        }),
      },
    );

    const observed = await provider.observe(secretManifest);
    expect(observed).not.toBeNull();
    expect(observed?.key).toBe("kube:prod-k3s/bevox/Secret/db-creds");

    // The serialized payload MUST NOT contain the secret bytes, the `data`
    // field, or stringData — under the minimal projection these are trivially
    // absent, but lock it explicitly: observed state carries refs/identity only.
    const serialized = JSON.stringify(observed?.payload);
    expect(serialized).not.toContain(SECRET_BYTES);
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain("stringData");

    // The identity + the manifest-hash projection field still survive.
    const payload = observed?.payload as {
      kind?: string;
      name?: string;
      manifestHash?: string | null;
    };
    expect(payload.kind).toBe("Secret");
    expect(payload.name).toBe("db-creds");
    expect(payload.manifestHash).toBe(LIVE_HASH);
  });

  it("redacts last-applied-configuration on a Secret — base64 secret bytes hidden inside the annotation never appear in the payload", async () => {
    const secretManifest: KubeManifest = {
      host: "prod-k3s",
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db-creds" },
      namespace: "bevox",
      body: "...",
    };
    // The proven leak: kubectl apply writes the WHOLE applied manifest (incl.
    // the base64 data block) into the last-applied-configuration annotation on
    // the live object. The secret bytes live ONLY there — NOT in top-level data.
    const SECRET_BYTES = "c3VwZXItc2VjcmV0LXBhc3N3b3Jk"; // base64 secret value
    const lastApplied = JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db-creds", namespace: "bevox" },
      type: "Opaque",
      data: { password: SECRET_BYTES },
    });

    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Secret"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: "db-creds",
            namespace: "bevox",
            annotations: {
              [MANIFEST_HASH_ANNOTATION]: LIVE_HASH,
              "kubectl.kubernetes.io/last-applied-configuration": lastApplied,
            },
          },
          type: "Opaque",
          // NOTE: NO top-level data block here — the leak is ONLY via the
          // annotation, which the old code did not strip.
        }),
      },
    );

    const observed = await provider.observe(secretManifest);
    expect(observed).not.toBeNull();

    const serialized = JSON.stringify(observed?.payload);
    // The secret bytes carried inside last-applied-configuration MUST be gone
    // (trivially, since the projection never includes arbitrary annotations).
    expect(serialized).not.toContain(SECRET_BYTES);
    // The annotation key itself MUST NOT appear in the projection.
    expect(serialized).not.toContain(
      "kubectl.kubernetes.io/last-applied-configuration",
    );

    // The benign manifest-hash projection field MUST still survive.
    const payload = observed?.payload as { manifestHash?: string | null };
    expect(payload.manifestHash).toBe(LIVE_HASH);
  });

  it("strips last-applied-configuration for ALL kinds — a Deployment annotation carrying a resolved secret is redacted", async () => {
    // Task 7's apply() resolves secret:<ref> to the REAL value before client-side
    // kubectl apply, so last-applied-configuration echoes resolved secrets into
    // ANY kind (e.g. a Deployment env value), not just Secrets.
    const SENTINEL = "S3CR3T-5.5-must-never-leak-Lm8";
    const lastApplied = JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "bevox" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "api", env: [{ name: "PW", value: SENTINEL }] }],
          },
        },
      },
    });

    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Deployment"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            annotations: {
              [MANIFEST_HASH_ANNOTATION]: LIVE_HASH,
              "kubectl.kubernetes.io/last-applied-configuration": lastApplied,
            },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    const observed = await provider.observe(deploymentManifest);
    expect(observed).not.toBeNull();

    const serialized = JSON.stringify(observed?.payload);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(
      "kubectl.kubernetes.io/last-applied-configuration",
    );

    // The benign manifest-hash projection field MUST still survive on a non-Secret.
    const payload = observed?.payload as { manifestHash?: string | null };
    expect(payload.manifestHash).toBe(LIVE_HASH);
  });

  it("RESIDUAL CLOSED: an inlined secret value in a NON-Secret spec NEVER reaches the observed payload (minimal projection)", async () => {
    // The residual: if a user inlines secret:<ref> into a Deployment container
    // env literal `value:`, Task 7's apply resolves it to the REAL value and
    // kubectl writes it into the live object's spec. A full-object payload would
    // then carry that value into the observed store / get_state. The minimal
    // projection closes this: NO arbitrary spec field ever rides along.
    const SENTINEL = "S3CR3T-5.9-must-never-leak-Pj9";

    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Deployment"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            annotations: { [MANIFEST_HASH_ANNOTATION]: LIVE_HASH },
          },
          spec: {
            template: {
              spec: {
                containers: [
                  // The resolved secret lives in the LIVE spec — NOT in data,
                  // NOT in an annotation. Only a minimal projection excludes it.
                  { name: "api", env: [{ name: "PW", value: SENTINEL }] },
                ],
              },
            },
          },
        }),
      },
    );

    const observed = await provider.observe(deploymentManifest);
    expect(observed).not.toBeNull();

    const serialized = JSON.stringify(observed?.payload);
    // The inlined sentinel and the whole `spec` are ABSENT from the payload.
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('"spec"');
    expect(serialized).not.toContain("containers");

    // Identity + manifestHash remain present for idempotency/drift.
    const payload = observed?.payload as {
      apiVersion?: string;
      kind?: string;
      namespace?: string;
      name?: string;
      manifestHash?: string | null;
    };
    expect(payload.apiVersion).toBe("apps/v1");
    expect(payload.kind).toBe("Deployment");
    expect(payload.namespace).toBe("bevox");
    expect(payload.name).toBe("api");
    expect(payload.manifestHash).toBe(LIVE_HASH);
  });

  it("happy-path observe argv includes --ignore-not-found (null-path contract)", async () => {
    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Deployment"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            annotations: { [MANIFEST_HASH_ANNOTATION]: LIVE_HASH },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    await provider.observe(deploymentManifest);
    const call = recorder.calls.at(-1);
    expect(call).toBeDefined();
    expect(call!.remoteArgv).toContain("--ignore-not-found");
  });

  it("observe() takes no ApplyContext — it is structurally unable to resolve a secret", () => {
    // The provider's observe accepts only a KubeManifest; there is no second
    // ApplyContext arg, so no secret resolver can be threaded into observe.
    expect(provider.observe.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 7 — KubernetesProvider.apply (no --prune; hash no-op; secret at apply)
// ---------------------------------------------------------------------------

describe("KubernetesProvider.apply (Task 7)", () => {
  const conn: SshConnection = {
    host: "prod-k3s",
    user: "root",
    port: 22,
    privateKey: "FAKE-KEY-not-secret-in-test",
    hostKeyPolicy: "accept-new",
  };

  const recorder = createSshExecRecorder();
  const transport = createKubeTransport({ run: recorder.run, conn });

  beforeEach(() => {
    recorder.reset();
  });

  const baseBody = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: api",
    "  namespace: bevox",
    "spec:",
    "  replicas: 1",
  ].join("\n");

  const deployment: KubeManifest = {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: baseBody,
  };

  /** The kubectl apply call recorded by the transport (argv + stdin). */
  function lastApplyCall(): { remoteArgv: readonly string[]; stdin?: string } | undefined {
    return recorder.calls.find((c) => c.remoteArgv.includes("apply"));
  }

  it("first apply (observed null) pipes the annotated manifest to `kubectl apply -f -` (NO --prune) and returns changed:true", async () => {
    const provider = createKubernetesProvider({ transport });
    // kubectl apply exits 0.
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "deployment.apps/api configured", stderr: "" },
    );

    const result = await provider.apply(deployment, null);
    expect(result.changed).toBe(true);
    expect(result.entity).toBe(kubeIdentityKey(deployment));

    const call = lastApplyCall();
    expect(call).toBeDefined();
    // argv (after the --kubeconfig prefix) is EXACTLY ["apply","-f","-"].
    const argv = call!.remoteArgv;
    const applyIdx = argv.indexOf("apply");
    expect(argv.slice(applyIdx)).toEqual(["apply", "-f", "-"]);
    // NEVER --prune anywhere.
    expect(argv).not.toContain("--prune");
    // The annotated manifest body crosses on STDIN, never argv.
    expect(call!.stdin).toBeDefined();
    expect(call!.stdin).toContain(MANIFEST_HASH_ANNOTATION);
    expect(call!.stdin).toContain("kind: Deployment");
  });

  it("first apply on hash MISMATCH (observed carries a stale hash) applies and returns changed:true", async () => {
    const provider = createKubernetesProvider({ transport });
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "configured", stderr: "" },
    );

    const stale: ObservedEntity = {
      key: kubeIdentityKey(deployment),
      payload: { manifestHash: "stale-different-hash" },
    };

    const result = await provider.apply(deployment, stale);
    expect(result.changed).toBe(true);
    expect(lastApplyCall()).toBeDefined();
  });

  it("second apply on hash MATCH is a strict no-op: changed:false and ZERO kubectl apply call recorded", async () => {
    const provider = createKubernetesProvider({ transport });

    // observed carries the SAME hash the provider will compute over the body.
    const live = manifestHash(deployment.body);
    const observed: ObservedEntity = {
      key: kubeIdentityKey(deployment),
      payload: { manifestHash: live },
    };

    const result = await provider.apply(deployment, observed);
    expect(result.changed).toBe(false);
    expect(result.entity).toBe(kubeIdentityKey(deployment));
    // STRICT no-op: NO kubectl apply was driven (not even to read stdout).
    expect(recorder.calls.some((c) => c.remoteArgv.includes("apply"))).toBe(false);
    expect(recorder.calls.length).toBe(0);
  });

  it("SECRET path: a secret:<ref> in the body is resolved to the real value ONLY in the piped stdin (never argv/result/error)", async () => {
    const SENTINEL = "S3CR3T-5.7-must-never-leak-Ap7";
    const SECRET_REF = "secret:db-pass";

    const secretBody = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "  namespace: bevox",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          env:",
      `            - name: PW`,
      `              value: ${SECRET_REF}`,
    ].join("\n");

    const secretManifest: KubeManifest = {
      ...deployment,
      body: secretBody,
    };

    // A fake resolver that returns the sentinel ONLY behind a real ApplyContext.
    const resolver: SecretResolver = {
      describe(ref: string): SecretMeta {
        return { name: ref.slice("secret:".length), keys: [], used_by: [] };
      },
      describeSchema() {
        throw new Error("unused in this test");
      },
      async resolve(
        ref: string,
        ctx: ApplyContext,
      ): Promise<SecretResolveResult> {
        // Mirror the real gate: a non-ApplyContext must never reach a value.
        void ctx;
        if (ref === SECRET_REF) {
          return { status: "ok", name: "db-pass", value: SENTINEL };
        }
        return { status: "deferred", name: ref.slice("secret:".length) };
      },
    };

    const provider = createKubernetesProvider({ transport, secretResolver: resolver });
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "configured", stderr: "" },
    );

    const ctx = createApplyContext();
    const result = await provider.apply(secretManifest, null, ctx);

    const call = lastApplyCall();
    expect(call).toBeDefined();
    // The resolved value reaches ONLY the piped stdin.
    expect(call!.stdin).toContain(SENTINEL);
    expect(call!.stdin).not.toContain(SECRET_REF); // ref was substituted
    // NEVER in argv.
    expect(JSON.stringify(call!.remoteArgv)).not.toContain(SENTINEL);
    // NEVER in the returned ApplyResult.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("SECRET path: with NO resolver/token the secret:<ref> stays a ref in stdin (apply still runs, ref unresolved) — mirrors docker.ts default", async () => {
    const SECRET_REF = "secret:db-pass";
    const secretBody = [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      "  name: db",
      "  namespace: bevox",
      "stringData:",
      `  password: ${SECRET_REF}`,
    ].join("\n");
    const secretManifest: KubeManifest = {
      ...deployment,
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db" },
      body: secretBody,
    };

    // No secretResolver injected → default path: ref stays a ref.
    const provider = createKubernetesProvider({ transport });
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "configured", stderr: "" },
    );

    const result = await provider.apply(secretManifest, null);
    expect(result.changed).toBe(true);
    const call = lastApplyCall();
    expect(call).toBeDefined();
    // The ref is preserved verbatim (unresolved) — apply still runs.
    expect(call!.stdin).toContain(SECRET_REF);
  });

  it("FAIL-SAFE: a kubectl apply failure throws and NEVER drives a delete/destroy verb", async () => {
    const provider = createKubernetesProvider({ transport });
    // kubectl apply exits non-zero → transport throws a secret-free error.
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 1, stdout: "", stderr: "the Deployment is invalid" },
    );

    await expect(provider.apply(deployment, null)).rejects.toThrow();
    // No delete/destroy verb anywhere — fail-safe never fail-deletes.
    expect(recorder.calls.some((c) => c.remoteArgv.includes("delete"))).toBe(false);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("--prune"))).toBe(false);
  });

  it("apply() resolution is over the ref-form hash: rotating ONLY the secret value (same ref) is a no-op (documented YAGNI consequence)", async () => {
    // The hash is computed over the body in its ref form. So whether or not a
    // resolver exists, the observed hash that matches is the ref-form hash.
    const SECRET_REF = "secret:db-pass";
    const secretBody = [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      "  name: db",
      "  namespace: bevox",
      "stringData:",
      `  password: ${SECRET_REF}`,
    ].join("\n");
    const secretManifest: KubeManifest = {
      ...deployment,
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db" },
      body: secretBody,
    };

    const observed: ObservedEntity = {
      key: kubeIdentityKey(secretManifest),
      payload: { manifestHash: manifestHash(secretBody) },
    };

    // Even with a resolver present, the same ref → same hash → strict no-op.
    const resolver: SecretResolver = {
      describe: (ref) => ({ name: ref, keys: [], used_by: [] }),
      describeSchema() {
        throw new Error("unused");
      },
      resolve: async () => ({ status: "ok", name: "db-pass", value: "rotated" }),
    };
    const provider = createKubernetesProvider({ transport, secretResolver: resolver });

    const result = await provider.apply(secretManifest, observed, createApplyContext());
    expect(result.changed).toBe(false);
    expect(recorder.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 9 — KubernetesProvider.verify (read-only) + gated destroy (no --prune)
// ---------------------------------------------------------------------------

describe("KubernetesProvider.verify + destroy (Task 9)", () => {
  const conn: SshConnection = {
    host: "prod-k3s",
    user: "root",
    port: 22,
    privateKey: "FAKE-KEY-not-secret-in-test",
    hostKeyPolicy: "accept-new",
  };

  const recorder = createSshExecRecorder();
  const transport = createKubeTransport({ run: recorder.run, conn });

  beforeEach(() => {
    recorder.reset();
  });

  const baseBody = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: api",
    "  namespace: bevox",
    "spec:",
    "  replicas: 1",
  ].join("\n");

  const deployment: KubeManifest = {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: baseBody,
  };

  it("verify() returns true when the live hash matches the desired hash (read-only: only `get` argv)", async () => {
    const provider = createKubernetesProvider({ transport });

    // The live object carries the SAME hash the provider computes over the body.
    const live = manifestHash(deployment.body);
    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Deployment"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            annotations: { [MANIFEST_HASH_ANNOTATION]: live },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    const ok = await provider.verify(deployment);
    expect(ok).toBe(true);

    // READ-ONLY: only `kubectl get` was driven — never a mutating verb.
    expect(recorder.calls.length).toBeGreaterThan(0);
    expect(recorder.calls.every((c) => c.remoteArgv.includes("get"))).toBe(true);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("apply"))).toBe(false);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("delete"))).toBe(false);
    // verify pipes NO stdin body (read-only).
    expect(recorder.calls.every((c) => c.stdin === undefined)).toBe(true);
  });

  it("verify() returns false on a hash MISMATCH (live differs from desired)", async () => {
    const provider = createKubernetesProvider({ transport });
    recorder.setResultByMatcher(
      (argv) => argv.includes("get") && argv.includes("Deployment"),
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "api",
            namespace: "bevox",
            annotations: { [MANIFEST_HASH_ANNOTATION]: "stale-different-hash" },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    expect(await provider.verify(deployment)).toBe(false);
    // Still read-only.
    expect(recorder.calls.some((c) => c.remoteArgv.includes("delete"))).toBe(false);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("apply"))).toBe(false);
  });

  it("verify() returns false when the object is absent (not present ⇒ false)", async () => {
    const provider = createKubernetesProvider({ transport });
    // --ignore-not-found ⇒ exit 0 + empty stdout when absent ⇒ observe null.
    recorder.setResult({ code: 0, stdout: "", stderr: "" });

    expect(await provider.verify(deployment)).toBe(false);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("delete"))).toBe(false);
  });

  it("destroy() issues exactly `kubectl delete <kind> <name> -n <ns>` (NO --prune, NO -f) and returns changed:true", async () => {
    const provider = createKubernetesProvider({ transport });
    recorder.setResultByMatcher(
      (argv) => argv.includes("delete"),
      { code: 0, stdout: 'deployment.apps "api" deleted', stderr: "" },
    );

    const result = await provider.destroy(deployment);
    expect(result.changed).toBe(true);
    expect(result.entity).toBe(kubeIdentityKey(deployment));

    const call = recorder.calls.find((c) => c.remoteArgv.includes("delete"));
    expect(call).toBeDefined();
    const argv = call!.remoteArgv;
    const delIdx = argv.indexOf("delete");
    // argv (after the --kubeconfig prefix) is EXACTLY the identity-addressed delete.
    expect(argv.slice(delIdx)).toEqual([
      "delete",
      "Deployment",
      "api",
      "-n",
      "bevox",
    ]);
    // FAIL-SAFE: never --prune, never -f, never a body on stdin.
    expect(argv).not.toContain("--prune");
    expect(argv).not.toContain("-f");
    expect(call!.stdin).toBeUndefined();
  });

  it("FAIL-SAFE: a forced apply() failure records ZERO `kubectl delete` argv (never delete on error)", async () => {
    const provider = createKubernetesProvider({ transport });
    // kubectl apply exits non-zero → transport throws a secret-free error.
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 1, stdout: "", stderr: "the Deployment is invalid" },
    );

    await expect(provider.apply(deployment, null)).rejects.toThrow();
    // The error path NEVER drives a delete/destroy (fail-safe: no rollback).
    expect(recorder.calls.some((c) => c.remoteArgv.includes("delete"))).toBe(false);
    expect(recorder.calls.some((c) => c.remoteArgv.includes("--prune"))).toBe(false);
  });
});
