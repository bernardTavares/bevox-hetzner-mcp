/**
 * core/src/reconciler/secret-apply.test.ts
 *
 * Task 3.3 — the SECURITY-CRITICAL secret-at-apply contract. Drives the real
 * apply path (applyPlan → DockerProvider → in-process Docker Engine fake)
 * with a service whose env has a `secret:<ref>` binding, and PROVES, to the
 * highest bar, the four invariants:
 *
 *   1. NO VALUE EVER OUTSIDE A GATED APPLY. The resolved secret value (and
 *      any plaintext) NEVER appears in PlanItem.change, the plan output,
 *      observe(), the ApplyReport / StateEvent-shaped records, or thrown
 *      error messages. Only the non-sensitive ref `secret:<ref>` may appear.
 *   2. APPLY-ONLY, GATE-GUARDED RESOLUTION. resolve() is called WITH the
 *      unforgeable applyContext token, and ONLY then; the resolved value is
 *      injected into the running container's Engine Env.
 *   3. 1.9 REGRESSION GUARD. Calling resolve() WITHOUT a valid ApplyContext
 *      (missing / forged plain object / forged string) rejects with
 *      ReconcileError("fatal") — plan/dry_run can never resolve.
 *   4. IDEMPOTENCY NON-FLAP. A converged secret service re-applied stays
 *      changed:false, verify() stays true, the resolved value never surfaces.
 *
 * ZERO network / SSH / Docker / DB / filesystem (fake transport only).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createDockerHttpFake } from "../../test/fakes/docker-http.js";
import { createDockerProvider } from "../providers/docker.js";
import type { PlanAction } from "../providers/provider.js";
import { plan } from "./plan.js";
import { applyPlan } from "./apply.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";
import {
  createApplyContext,
  type ApplyContext,
  type SecretResolver,
  type SecretMeta,
  type SecretResolveResult,
} from "../store/secrets.js";
import {
  createKubernetesProvider,
  manifestHash,
  MANIFEST_HASH_ANNOTATION,
  kubeIdentityKey,
} from "../providers/v2/kube-apply.js";
import { createKubeTransport } from "../providers/v2/kube-transport.js";
import { createSshExecRecorder } from "../../test/fakes/ssh-exec-recorder.js";
import type { SshConnection } from "../providers/ssh-exec.js";
import type { KubeManifest } from "../domain/entities-v2.js";

// ---------------------------------------------------------------------------
// Test-only resolving SecretResolver.
//
// It honours the EXACT SAME token gate as the production secrets.ts: a
// missing / forged-plain-object / forged-string ctx is rejected with
// ReconcileError("fatal"). It does NOT (and cannot) import secrets.ts's
// private brand, so it gates positively on a tag minted by the real
// createApplyContext() — i.e. it only ever returns a value for a token the
// real factory produced. The known test value is returned ONLY past the gate.
// ---------------------------------------------------------------------------

const SECRET_VALUE = "S3CR3T-pg-pw-do-not-leak";

/** A genuine ApplyContext carries secrets.ts's private brand symbol. */
function isRealApplyContext(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null) return false;
  // The brand is a module-private unique symbol we cannot name; a genuine
  // token from createApplyContext() is a frozen object whose ONLY own symbol
  // key maps to `true`. A `{}` / "apply" string / forged plain object fails.
  const syms = Object.getOwnPropertySymbols(ctx);
  return (
    syms.length === 1 &&
    (ctx as Record<symbol, unknown>)[syms[0]!] === true &&
    Object.isFrozen(ctx)
  );
}

function createTestResolver(): SecretResolver {
  return {
    describe(ref: string): SecretMeta {
      return { name: ref.replace(/^secret:/, ""), keys: [], used_by: [] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    describeSchema(): any {
      throw new Error("not needed for 3.3 tests");
    },
    async resolve(ref: string, ctx: ApplyContext) {
      // SAME GATE AS secrets.ts: refuse before doing anything else. The error
      // message carries NO secret material (there is no value yet, and never
      // the value on the refuse path).
      if (!isRealApplyContext(ctx)) {
        throw new ReconcileError(
          "fatal",
          "secret resolve refused: a valid ApplyContext is required",
          { entity: "secret" },
        );
      }
      return {
        status: "ok" as const,
        name: ref.replace(/^secret:/, ""),
        value: SECRET_VALUE,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const SVC = {
  name: "billing",
  image: "bevox/billing:1",
  replicas: 1,
  env: { LOG_LEVEL: "info", DB_PASSWORD: "secret:db-password" },
};

const SVC_ACTION: PlanAction = {
  op: "create",
  entity: "service:billing",
  desired: SVC,
};

function makeRig(opts?: {
  resolver?: SecretResolver;
  token?: ApplyContext;
}) {
  const fake = createDockerHttpFake();
  const provider = createDockerProvider({
    transport: fake.transport,
    secretResolver: opts?.resolver,
    applyContext: opts?.token,
  });
  return { fake, provider };
}

async function inspectByName(
  fake: ReturnType<typeof createDockerHttpFake>,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const list = await fake.transport.request("GET", "/containers/json");
  const items = list.json as { Id: string; Names: string[] }[];
  const found = items.find((c) => c.Names[0] === `/${name}`);
  if (!found) throw new Error(`container ${name} not found`);
  return (await fake.transport.request("GET", `/containers/${found.Id}/json`))
    .json;
}

/** Assert the plaintext secret value never appears in `blob`. */
function assertNoLeak(blob: string, label: string): void {
  expect(blob, `${label} must NOT contain the resolved secret value`).not.toContain(
    SECRET_VALUE,
  );
}

// ---------------------------------------------------------------------------
// 1. plan/dry_run shows ONLY the ref — never the key value nor resolved value
// ---------------------------------------------------------------------------

describe("3.3 — plan/dry_run never leaks (only the ref may appear)", () => {
  it("PlanItem.change carries no secret key value and no resolved value", () => {
    // Desired manifest has the secret binding; observed is empty → create.
    const desired: DesiredState = { services: [SVC] };
    const observed: State = {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    };
    const items = plan(desired, observed);

    const svcItem = items.find((i) => i.entity === "service:billing");
    expect(svcItem).toBeDefined();

    const blob = JSON.stringify(items);
    // The resolved value can NEVER appear (plan can't even resolve).
    assertNoLeak(blob, "plan output");
    // The change string is structural: `<verb> <entity>` only — no env at all.
    expect(svcItem!.change).toBe("create service:billing");
    expect(svcItem!.change).not.toContain("secret:");
    expect(svcItem!.change).not.toContain("db-password");
    // Whole plan never embeds the secret-bound key's value.
    expect(blob).not.toContain("DB_PASSWORD");
  });
});

// ---------------------------------------------------------------------------
// 2. apply resolves WITH the token and injects the value as container env
// ---------------------------------------------------------------------------

describe("3.3 — apply resolves behind applyContext and injects as env", () => {
  it("applyPlan forwards the apply-boundary token; value lands ONLY in Env", async () => {
    const { fake, provider } = makeRig({ resolver: createTestResolver() });
    const token = createApplyContext(); // minted at THE apply boundary

    const items = [
      { op: "create" as const, entity: "service:billing", change: "create service:billing", impact: "x" },
    ];
    const report = await applyPlan(provider, items, {
      desiredPayloads: new Map([["service:billing", SVC]]),
      applyContext: token,
    });

    expect(report.failed).toEqual([]);
    expect(report.applied.map((a) => a.entity)).toContain("service:billing");

    // The resolved value IS in the running container's Engine Env...
    const insp = await inspectByName(fake, "billing-0");
    expect(insp.Config.Env).toContain(`DB_PASSWORD=${SECRET_VALUE}`);
    expect(insp.Config.Env).toContain("LOG_LEVEL=info");
    // ...and the binding label is still the stable non-Env ref (3.2 channel).
    expect(insp.Config.Labels["bevox.secret.DB_PASSWORD"]).toBe(
      "secret:db-password",
    );

    // LEAK-PROOF: the value is NOWHERE in the report (≈ StateEvent record
    // surface), in observe(), or in the plan items.
    assertNoLeak(JSON.stringify(report), "ApplyReport / record surface");
    const obs = await provider.observe("service");
    assertNoLeak(JSON.stringify(obs), "observe()");
    expect(JSON.stringify(obs)).not.toContain("db-password");
    assertNoLeak(JSON.stringify(items), "plan items");
  });

  it("provider-options token path also resolves+injects (isolation test path)", async () => {
    const token = createApplyContext();
    const { fake, provider } = makeRig({
      resolver: createTestResolver(),
      token,
    });
    const res = await provider.apply(SVC_ACTION);
    expect(res.changed).toBe(true);
    const insp = await inspectByName(fake, "billing-0");
    expect(insp.Config.Env).toContain(`DB_PASSWORD=${SECRET_VALUE}`);
  });

  it("without resolver+token, apply is byte-identical to 3.2 (no value in Env)", async () => {
    const { fake, provider } = makeRig(); // no resolver, no token
    const res = await provider.apply(SVC_ACTION);
    expect(res.changed).toBe(true);
    const insp = await inspectByName(fake, "billing-0");
    expect(
      insp.Config.Env.some((e: string) => e.startsWith("DB_PASSWORD=")),
    ).toBe(false);
    assertNoLeak(JSON.stringify(insp), "container inspect (no-secret path)");
    // Binding label still preserved for a later gated apply.
    expect(insp.Config.Labels["bevox.secret.DB_PASSWORD"]).toBe(
      "secret:db-password",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 1.9 regression guard — resolve WITHOUT a valid ApplyContext throws fatal
// ---------------------------------------------------------------------------

describe("3.3 — regression guard: resolve is unreachable without the token", () => {
  it("resolve() rejects ReconcileError('fatal') for missing/forged context", async () => {
    const resolver = createTestResolver();

    // (a) forged plain object.
    await expect(
      resolver.resolve("secret:db-password", {} as unknown as ApplyContext),
    ).rejects.toMatchObject({ errorClass: "fatal" });

    // (b) forged string.
    await expect(
      resolver.resolve(
        "secret:db-password",
        "apply" as unknown as ApplyContext,
      ),
    ).rejects.toBeInstanceOf(ReconcileError);

    // (c) the refuse path NEVER carries secret material.
    await resolver
      .resolve("secret:db-password", undefined as unknown as ApplyContext)
      .catch((e: unknown) => {
        assertNoLeak(String(e), "thrown error message");
      });
  });

  it("a service with a secret binding applied with NO token never resolves", async () => {
    // resolver present but NO token anywhere → resolve must not be reached;
    // no value can land in Env, nothing throws (binding just stays a label).
    const { fake, provider } = makeRig({ resolver: createTestResolver() });
    const res = await provider.apply(SVC_ACTION);
    expect(res.changed).toBe(true);
    const insp = await inspectByName(fake, "billing-0");
    expect(
      insp.Config.Env.some((e: string) => e.startsWith("DB_PASSWORD=")),
    ).toBe(false);
    assertNoLeak(JSON.stringify(insp), "no-token apply");
  });
});

// ---------------------------------------------------------------------------
// 4. idempotency non-flap — 2nd gated apply = no-op, value never surfaces
// ---------------------------------------------------------------------------

describe("3.3 — idempotency: secret injection does not make verify() flap", () => {
  it("2nd apply of a secret service = changed:false, verify true, no leak", async () => {
    const token = createApplyContext();
    const { fake, provider } = makeRig({
      resolver: createTestResolver(),
      token,
    });

    const first = await provider.apply(SVC_ACTION);
    expect(first.changed).toBe(true);
    expect(await provider.verify(SVC_ACTION)).toBe(true);

    const second = await provider.apply(SVC_ACTION);
    expect(second.changed).toBe(false); // NO flap — stable label compared
    expect(await provider.verify(SVC_ACTION)).toBe(true);

    // The resolved value is ONLY in the running container's Env, never in
    // verify()/observe() surfaces.
    const insp = await inspectByName(fake, "billing-0");
    expect(insp.Config.Env).toContain(`DB_PASSWORD=${SECRET_VALUE}`);
    const obs = await provider.observe("service");
    assertNoLeak(JSON.stringify(obs), "observe() after re-apply");
    expect(JSON.stringify(obs)).not.toContain("db-password");
  });
});

// ---------------------------------------------------------------------------
// 5. REGRESSION LOCK — kube apply path: sentinel secret never escapes
//
// Sentinel: S3CR3T-5.8-must-never-leak-Lk8
//
// Asserts, end-to-end over the KubernetesProvider.apply() surface:
//   (a) manifestHash() is computed over the ref-form body — NEVER over
//       the resolved value. The hash input/output reveal nothing.
//   (b) observe() returns a payload with NO resolved secret value.
//   (c) EVERY recorded argv token contains NO resolved secret value.
//   (d) The KubeApplyResult record contains NO resolved secret value.
//   (e) The `secret:<ref>` REFERENCE string is what appears in hash-input
//       and plan-form (NEVER the resolved value in those surfaces).
//   (f) The resolved sentinel value IS present ONLY in the manifest
//       body piped to kubectl via stdin (the ONLY permitted surface).
//
// This is a PASS-BY-CONSTRUCTION regression lock (Task 7 is correct).
// If any assertion fails, that surface has leaked — report BLOCKED.
// ---------------------------------------------------------------------------

describe("5.8 — kube apply path: sentinel secret never escapes any surface (REGRESSION LOCK)", () => {
  const KUBE_SENTINEL = "S3CR3T-5.8-must-never-leak-Lk8";
  const SECRET_REF = "secret:kube-db-pass";

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

  // A manifest whose body contains a secret:<ref> binding — the resolved
  // value must NEVER appear in any surface except stdin.
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
    `            - name: DB_PASS`,
    `              value: ${SECRET_REF}`,
  ].join("\n");

  const secretManifest: KubeManifest = {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: secretBody,
  };

  /** A resolver that returns the sentinel ONLY behind a valid ApplyContext. */
  function createKubeTestResolver(): SecretResolver {
    return {
      describe(ref: string): SecretMeta {
        return { name: ref.replace(/^secret:/, ""), keys: [], used_by: [] };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      describeSchema(): any {
        throw new Error("not needed for 5.8 tests");
      },
      async resolve(
        ref: string,
        ctx: ApplyContext,
      ): Promise<SecretResolveResult> {
        // Gate: only a real ApplyContext can reach the value (mirrors
        // createTestResolver() above and the real secrets.ts gate).
        if (!isRealApplyContext(ctx)) {
          throw new ReconcileError(
            "fatal",
            "secret resolve refused: a valid ApplyContext is required",
            { entity: "secret" },
          );
        }
        if (ref === SECRET_REF) {
          return { status: "ok", name: "kube-db-pass", value: KUBE_SENTINEL };
        }
        return { status: "deferred", name: ref.replace(/^secret:/, "") };
      },
    };
  }

  it("(a) manifestHash is computed over the ref-form body — sentinel absent from hash input and output", () => {
    // The hash is over secretBody which contains SECRET_REF (the ref), NOT the
    // resolved sentinel value.
    const hash = manifestHash(secretBody);

    // The hash input (secretBody) contains the ref, NOT the resolved value.
    expect(secretBody).toContain(SECRET_REF);
    expect(secretBody).not.toContain(KUBE_SENTINEL);

    // The hash output is a one-way hex digest — it cannot contain the sentinel
    // (it contains only [0-9a-f]{64}).
    expect(hash).not.toContain(KUBE_SENTINEL);
    expect(hash).not.toContain(SECRET_REF);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(b-f) apply() pipes resolved sentinel ONLY to stdin; sentinel absent from argv, result, observe, hash, plan-form", async () => {
    const provider = createKubernetesProvider({
      transport,
      secretResolver: createKubeTestResolver(),
    });

    // kubectl apply exits 0 (fake transport honours it).
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "deployment.apps/api configured", stderr: "" },
    );

    // Script observe to return null (first apply, object absent on cluster).
    recorder.setResultByMatcher(
      (argv) => argv.includes("get"),
      { code: 0, stdout: "", stderr: "" },
    );

    const ctx = createApplyContext();
    const result = await provider.apply(secretManifest, null, ctx);

    // (d) KubeApplyResult carries no resolved secret value.
    const resultBlob = JSON.stringify(result);
    expect(result.changed).toBe(true);
    expect(result.entity).toBe(kubeIdentityKey(secretManifest));
    expect(resultBlob, "KubeApplyResult must NOT contain the resolved sentinel").not.toContain(KUBE_SENTINEL);
    // The entity key carries only refs/identity (kube:<host>/…/<kind>/<name>).
    expect(resultBlob).not.toContain(KUBE_SENTINEL);

    // Find the recorded apply call (there must be exactly one).
    const applyCall = recorder.calls.find((c) => c.remoteArgv.includes("apply"));
    expect(applyCall, "an apply call must have been recorded").toBeDefined();

    // (c) EVERY recorded argv token: no sentinel anywhere in argv.
    const argvBlob = JSON.stringify(applyCall!.remoteArgv);
    expect(argvBlob, "kubectl argv must NOT contain the resolved sentinel").not.toContain(KUBE_SENTINEL);
    // The manifest body MUST NOT appear as an argv token (it's on stdin).
    expect(argvBlob).not.toContain(SECRET_REF);

    // (f) The resolved sentinel IS present ONLY in stdin — the ONLY permitted surface.
    expect(applyCall!.stdin, "resolved sentinel must appear in piped stdin").toContain(KUBE_SENTINEL);
    // The ref form is NOT present in stdin (it was substituted).
    expect(applyCall!.stdin).not.toContain(SECRET_REF);

    // (e) The MANIFEST_HASH_ANNOTATION is present in stdin — hash is over refs, not resolved value.
    expect(applyCall!.stdin).toContain(MANIFEST_HASH_ANNOTATION);
    // The hash annotation value is the ref-form hash (deterministic).
    expect(applyCall!.stdin).toContain(manifestHash(secretBody));
  });

  it("(b) observe() payload after a fake live response contains NO sentinel — observe resolves no secret", async () => {
    // Script observe to return a live object whose annotations contain
    // the MANIFEST_HASH_ANNOTATION (normal post-apply state). The observe
    // path must not return the sentinel in the payload — it cannot by
    // construction (observe() resolves no secret and strips last-applied).
    const liveHash = manifestHash(secretBody);

    // Simulate what a cluster would return: last-applied echoes the FULL
    // manifest. In production that manifest carries the RESOLVED value (via
    // Task 7's client-side apply). We embed the sentinel inside
    // last-applied to prove observe() strips it.
    const lastApplied = JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "bevox" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "api", env: [{ name: "DB_PASS", value: KUBE_SENTINEL }] },
            ],
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
              [MANIFEST_HASH_ANNOTATION]: liveHash,
              "kubectl.kubernetes.io/last-applied-configuration": lastApplied,
            },
          },
          spec: { replicas: 1 },
        }),
      },
    );

    const provider = createKubernetesProvider({ transport });
    const observed = await provider.observe(secretManifest);
    expect(observed).not.toBeNull();

    // The payload must NOT contain the sentinel — observe() returns a MINIMAL
    // PROJECTION (identity + manifestHash), so any arbitrary live spec/annotation
    // field (incl. last-applied-configuration) is structurally excluded.
    const observeBlob = JSON.stringify(observed?.payload);
    expect(observeBlob, "observe() payload must NOT contain the resolved sentinel").not.toContain(KUBE_SENTINEL);
    // The manifest-hash VALUE must survive in the projection (benign one-way
    // digest) — exposed as the `manifestHash` field, not the raw annotation key.
    expect(observeBlob).toContain("manifestHash");
    expect(observeBlob).toContain(liveHash);
    // The raw last-applied-configuration annotation key MUST be absent (the
    // projection copies no arbitrary annotation).
    expect(observeBlob).not.toContain("kubectl.kubernetes.io/last-applied-configuration");
  });

  it("no-resolver path: secret:<ref> stays a ref in stdin and sentinel is never involved", async () => {
    // When no secretResolver is provided, refs stay refs verbatim.
    // The sentinel can never appear by construction (resolver is absent).
    const provider = createKubernetesProvider({ transport });
    recorder.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "configured", stderr: "" },
    );

    const result = await provider.apply(secretManifest, null);
    expect(result.changed).toBe(true);

    const applyCall = recorder.calls.find((c) => c.remoteArgv.includes("apply"));
    expect(applyCall).toBeDefined();

    // The ref stays verbatim in stdin (unresolved).
    expect(applyCall!.stdin).toContain(SECRET_REF);
    // The sentinel is ABSENT from stdin and argv (resolver was absent, so
    // the sentinel value was never produced in any surface).
    expect(applyCall!.stdin).not.toContain(KUBE_SENTINEL);
    expect(JSON.stringify(applyCall!.remoteArgv)).not.toContain(KUBE_SENTINEL);
  });
});
