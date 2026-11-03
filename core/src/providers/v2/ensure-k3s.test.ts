/**
 * core/src/providers/v2/ensure-k3s.test.ts
 *
 * Bloco E Phase 2 (host axis) Task 16 — drives `EnsureK3sProvider.observe()`
 * against the INJECTED `ssh-exec-recorder` fake (the `SshRunner` seam), wrapped
 * in a real `KubeTransport`. ZERO real ssh / host / k3s / kubectl / network.
 * Deterministic.
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md §3.2 — observe() runs
 * `k3s --version` / `systemctl is-active k3s` / `kubectl get nodes` on the host
 * → state (installed? which version? node Ready?). Read-only.
 *
 * What is proven HERE:
 *   - the identity key is `k3s:<host>`;
 *   - with `k3s --version` → "k3s version v1.30.2+k3s1 (..)" and
 *     `systemctl is-active k3s` → "active", observe returns
 *     `{ installed:true, version:"v1.30.2+k3s1" }`;
 *   - with `k3s --version` exiting non-zero (absent), observe returns
 *     `installed:false`;
 *   - observe is READ-ONLY: it issues ONLY read commands (no install / mutating
 *     verb) — fail-safe.md.
 */

import { describe, it, expect } from "vitest";
import { createEnsureK3sProvider, k3sIdentityKey } from "./ensure-k3s.js";
import type { EnsureK3sObservedProjection } from "./ensure-k3s.js";
import { createKubeTransport } from "./kube-transport.js";
import type { EnsureK3s } from "../../domain/entities-v2.js";
import type { SshConnection } from "../ssh-exec.js";
import { createSshExecRecorder } from "../../../test/fakes/ssh-exec-recorder.js";

const CONN: SshConnection = {
  host: "10.0.0.42",
  user: "deploy",
  port: 22,
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----K3S_KEY_LEAK-----END-----",
  hostKeyPolicy: "accept-new",
};

const DESIRED: EnsureK3s = {
  host: "k3s-host-1",
  version: "v1.30.2+k3s1",
  role: "server",
};

/** A k3s `get nodes -o json` reply with one Ready node. */
const NODES_READY_JSON = JSON.stringify({
  items: [
    {
      metadata: { name: "k3s-host-1" },
      status: {
        conditions: [
          { type: "MemoryPressure", status: "False" },
          { type: "Ready", status: "True" },
        ],
      },
    },
  ],
});

describe("Bloco E Task 16 — k3sIdentityKey", () => {
  it("is `k3s:<host>`", () => {
    expect(k3sIdentityKey(DESIRED)).toBe("k3s:k3s-host-1");
  });
});

describe("Bloco E Task 16 — EnsureK3sProvider.observe (version / active / ready)", () => {
  it("returns installed:true + parsed version when k3s is present & active", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    expect(observed).not.toBeNull();
    expect(observed!.key).toBe("k3s:k3s-host-1");
    expect(observed!.payload).toMatchObject({
      installed: true,
      version: "v1.30.2+k3s1",
    });
  });

  it("returns active:true from `systemctl is-active k3s` == 'active'", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    expect(observed!.payload).toMatchObject({ active: true });
  });

  it("returns active:false when systemd reports a non-'active' state", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      // systemctl is-active exits non-zero for inactive; stdout is the state.
      { code: 3, stdout: "inactive\n", stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    expect(observed!.payload).toMatchObject({ active: false });
  });

  it("returns installed:false when `k3s --version` exits non-zero (absent)", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 127, stdout: "", stderr: "k3s: command not found" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    expect(observed).not.toBeNull();
    expect(observed!.key).toBe("k3s:k3s-host-1");
    expect(observed!.payload).toMatchObject({ installed: false });
    // No version is reported when k3s is absent.
    expect((observed!.payload as { version?: unknown }).version).toBeUndefined();
  });

  it("does NOT probe systemctl/nodes when k3s is absent (short-circuit, read-only)", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 127, stdout: "", stderr: "k3s: command not found" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.observe(DESIRED);

    // Absent ⇒ only the version probe ran.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.remoteArgv).toEqual(["k3s", "--version"]);
  });

  it("reports node readiness when `get nodes` shows a Ready node", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    expect(observed!.payload).toMatchObject({ ready: true });
  });

  it("READ-ONLY: observe issues NO install/mutating verb on any command", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.observe(DESIRED);

    const FORBIDDEN = [
      "install",
      "uninstall",
      "sh",
      "curl",
      "apply",
      "delete",
      "create",
      "start",
      "stop",
      "restart",
      "rm",
    ];
    for (const call of rec.calls) {
      for (const token of call.remoteArgv) {
        expect(FORBIDDEN).not.toContain(token);
      }
    }
  });

  it("does NOT carry any secret-bearing dump in the observed payload", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const observed = await provider.observe(DESIRED);

    // Minimal projection: only installed/version/active/ready keys, no full
    // command dump.
    const payload = observed!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["active", "installed", "ready", "version"].filter((k) => k in payload).sort(),
    );
    expect(JSON.stringify(payload)).not.toContain("BEGIN OPENSSH");
  });
});

// ---------------------------------------------------------------------------
// Task 17 — apply() install-only + version-divergence DRIFT (Q-a) + verify()
// ---------------------------------------------------------------------------

/** A k3s `get nodes -o json` reply with the node NOT yet Ready. */
const NODES_NOTREADY_JSON = JSON.stringify({
  items: [
    {
      metadata: { name: "k3s-host-1" },
      status: {
        conditions: [{ type: "Ready", status: "False" }],
      },
    },
  ],
});

/** Build an observed projection slice the way observe() would. */
function observed(p: EnsureK3sObservedProjection): {
  key: string;
  payload: EnsureK3sObservedProjection;
} {
  return { key: k3sIdentityKey(DESIRED), payload: p };
}

/** The set of mutating verbs an install/upgrade/uninstall recipe could carry. */
const INSTALL_OR_MUTATE_TOKENS = [
  "curl",
  "sh",
  "get.k3s.io",
  "k3s-uninstall.sh",
  "k3s-agent-uninstall.sh",
  "upgrade",
];

/** True iff any recorded call carries an install/mutate marker token. */
function recordedAnyInstallArgv(rec: ReturnType<typeof createSshExecRecorder>): boolean {
  return rec.calls.some((call) =>
    call.remoteArgv.some((tok) =>
      INSTALL_OR_MUTATE_TOKENS.some((m) => tok.includes(m)),
    ),
  );
}

describe("Bloco E Task 17 — EnsureK3sProvider.apply (install-only)", () => {
  it("ABSENT (observed null) ⇒ runs the install recipe + changed:true", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(DESIRED, null);

    expect(result.entity).toBe("k3s:k3s-host-1");
    expect(result.changed).toBe(true);
    expect(result.result).toBeUndefined();

    // EXACTLY one install command recorded.
    expect(rec.calls).toHaveLength(1);
    const argv = rec.calls[0]!.remoteArgv;

    // The recipe carries version/role as DISCRETE `env` assignment tokens
    // (NEVER concatenated into the -c script — no injection surface).
    expect(argv).toContain("env");
    expect(argv).toContain("INSTALL_K3S_VERSION=v1.30.2+k3s1");
    expect(argv).toContain("INSTALL_K3S_EXEC=server");

    // The pipeline script is a FIXED constant token, never a caller free string.
    const scriptIdx = argv.indexOf("-c");
    expect(scriptIdx).toBeGreaterThanOrEqual(0);
    const script = argv[scriptIdx + 1]!;
    expect(script).toBe("curl -sfL https://get.k3s.io | sh -");
    // The desired.version / role NEVER appear inside the -c script token.
    expect(script).not.toContain("v1.30.2+k3s1");
    expect(script).not.toContain("server");
  });

  it("ABSENT (observed.installed=false) ⇒ runs the install recipe + changed:true", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(DESIRED, observed({ installed: false }));

    expect(result.changed).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.remoteArgv).toContain("INSTALL_K3S_VERSION=v1.30.2+k3s1");
  });

  it("recipe NEVER contains a caller-supplied free-form command string", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.apply(DESIRED, null);

    // Every token is from the provider-owned constant recipe or a typed,
    // discrete env assignment built from the schema-validated version/role.
    const argv = rec.calls[0]!.remoteArgv;
    const ALLOWED = new Set([
      "env",
      "INSTALL_K3S_VERSION=v1.30.2+k3s1",
      "INSTALL_K3S_EXEC=server",
      "sh",
      "-c",
      "curl -sfL https://get.k3s.io | sh -",
    ]);
    for (const tok of argv) expect(ALLOWED.has(tok)).toBe(true);
  });

  it("maps role agent ⇒ INSTALL_K3S_EXEC=agent (discrete token)", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.apply({ ...DESIRED, role: "agent" }, null);

    expect(rec.calls[0]!.remoteArgv).toContain("INSTALL_K3S_EXEC=agent");
  });

  it("PRESENT same version ⇒ strict no-op: changed:false + ZERO install argv", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(
      DESIRED,
      observed({ installed: true, version: "v1.30.2+k3s1", active: true, ready: true }),
    );

    expect(result.entity).toBe("k3s:k3s-host-1");
    expect(result.changed).toBe(false);
    expect(result.result).toBeUndefined();
    // STRICT no-op — NO command at all.
    expect(rec.calls).toHaveLength(0);
  });

  it("VERSION-DIVERGENT ⇒ DRIFT: changed:false, result 'drift', ZERO install/upgrade argv", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(
      DESIRED, // desired v1.30.2+k3s1
      observed({ installed: true, version: "v1.29.0+k3s1", active: true, ready: true }),
    );

    // Q-a: report DRIFT — NEVER changed:true, NEVER throw, NO auto-upgrade.
    expect(result.entity).toBe("k3s:k3s-host-1");
    expect(result.changed).toBe(false);
    expect(result.result).toBe("drift");
    // ZERO install/upgrade/uninstall argv recorded.
    expect(rec.calls).toHaveLength(0);
    expect(recordedAnyInstallArgv(rec)).toBe(false);
  });

  it("FAIL-SAFE: NO uninstall verb on ANY apply branch", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.apply(DESIRED, null); // install
    await provider.apply(
      DESIRED,
      observed({ installed: true, version: "v1.29.0+k3s1" }),
    ); // drift

    const FORBIDDEN = ["uninstall", "k3s-uninstall.sh", "k3s-agent-uninstall.sh", "delete", "rm"];
    for (const call of rec.calls) {
      for (const tok of call.remoteArgv) {
        for (const bad of FORBIDDEN) expect(tok).not.toContain(bad);
      }
    }
  });
});

describe("Bloco E Task 17 — EnsureK3sProvider.verify (node Ready)", () => {
  it("true when k3s present + node Ready", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    expect(await provider.verify(DESIRED)).toBe(true);
  });

  it("false when node is NOT Ready", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_NOTREADY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    expect(await provider.verify(DESIRED)).toBe(false);
  });

  it("false when k3s is absent", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 127, stdout: "", stderr: "k3s: command not found" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    expect(await provider.verify(DESIRED)).toBe(false);
  });

  it("READ-ONLY: verify issues NO install/mutating verb", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    await provider.verify(DESIRED);

    const FORBIDDEN = ["install", "uninstall", "sh", "curl", "delete", "rm"];
    for (const call of rec.calls) {
      for (const tok of call.remoteArgv) {
        expect(FORBIDDEN).not.toContain(tok);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 18 — install-only INVARIANT LOCK
// ---------------------------------------------------------------------------
//
// This describe block is the COMPREHENSIVE, dedicated lock asserting that
// EnsureK3sProvider is install-only BY CONSTRUCTION — across EVERY code path.
//
// Spec §3.3 + Q-a: k3s removed from desired ⇒ DRIFT reported (reconciler
// responsibility, not the provider's); the provider structurally has NO
// destroy/uninstall surface. fail-safe.md: no destroy on error, no heuristic
// teardown. The lock is expected to PASS by construction (Task 17 already
// install-only); it makes the invariant explicit and machine-checked.
//
// FORBIDDEN tokens — any argv token containing one of these is a violation:
//   k3s-uninstall.sh, k3s-agent-uninstall.sh, uninstall, upgrade, delete,
//   destroy, rm, --prune, teardown
// ---------------------------------------------------------------------------

/** Every forbidden token for the install-only invariant (Task 18). */
const INVARIANT_FORBIDDEN_TOKENS = [
  "k3s-uninstall.sh",
  "k3s-agent-uninstall.sh",
  "uninstall",
  "upgrade",
  "delete",
  "destroy",
  "rm",
  "--prune",
  "teardown",
] as const;

/**
 * Assert that NONE of the `calls` recorded by `rec` carry a forbidden token.
 * A token "carries" a forbidden marker if the token string includes it
 * (substring match — catches path variants like `/usr/local/bin/k3s-uninstall.sh`).
 */
function assertNoForbiddenTokens(
  calls: ReturnType<typeof createSshExecRecorder>["calls"],
  context: string,
): void {
  for (const call of calls) {
    for (const tok of call.remoteArgv) {
      for (const forbidden of INVARIANT_FORBIDDEN_TOKENS) {
        expect(
          tok.includes(forbidden),
          `[${context}] argv token "${tok}" contains forbidden marker "${forbidden}"`,
        ).toBe(false);
      }
    }
  }
}

describe("Task 18 — ensure_k3s install-only INVARIANT LOCK", () => {
  // -------------------------------------------------------------------------
  // Case 1: ABSENT apply (observed null) — install recipe runs; NO forbidden
  //         token may appear in any recorded argv.
  // -------------------------------------------------------------------------
  it("ABSENT (null observed) ⇒ install runs, ZERO forbidden tokens in argv", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(DESIRED, null);

    // The install DID run (changed:true, exactly one call).
    expect(result.changed).toBe(true);
    expect(rec.calls).toHaveLength(1);

    // But NO forbidden token appears — install recipe only carries the
    // FIXED pipeline constant + discrete env assignments.
    assertNoForbiddenTokens(rec.calls, "ABSENT/null");
  });

  // -------------------------------------------------------------------------
  // Case 2: ABSENT apply (observed.installed=false) — same invariant.
  // -------------------------------------------------------------------------
  it("ABSENT (installed:false) ⇒ install runs, ZERO forbidden tokens in argv", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(
      DESIRED,
      observed({ installed: false }),
    );

    expect(result.changed).toBe(true);
    expect(rec.calls).toHaveLength(1);
    assertNoForbiddenTokens(rec.calls, "ABSENT/installed:false");
  });

  // -------------------------------------------------------------------------
  // Case 3: PRESENT same version — strict no-op, ZERO argv, NO forbidden token.
  // -------------------------------------------------------------------------
  it("PRESENT same version ⇒ strict no-op, ZERO argv, ZERO forbidden tokens", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(
      DESIRED,
      observed({ installed: true, version: "v1.30.2+k3s1", active: true, ready: true }),
    );

    expect(result.changed).toBe(false);
    expect(result.result).toBeUndefined(); // converged no-op, NOT drift
    // ZERO argv — the no-op branch issues no SSH command at all.
    expect(rec.calls).toHaveLength(0);
    // Trivially no forbidden tokens (empty calls), but asserting the shape
    // proves the branch did not silently call something else.
    assertNoForbiddenTokens(rec.calls, "PRESENT/same-version");
  });

  // -------------------------------------------------------------------------
  // Case 4: VERSION-DIVERGENT — DRIFT (Q-a). ZERO argv. NO upgrade token.
  //         This is the EXPLICIT guard against auto-upgrade (spec Q-a).
  // -------------------------------------------------------------------------
  it("VERSION-DIVERGENT ⇒ result:'drift', ZERO argv, NO upgrade/uninstall token", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    const result = await provider.apply(
      DESIRED, // desired v1.30.2+k3s1
      observed({ installed: true, version: "v1.29.0+k3s1", active: true, ready: true }),
    );

    // Q-a: DRIFT, never auto-upgrade.
    expect(result.changed).toBe(false);
    expect(result.result).toBe("drift");
    // ZERO argv — no install, no upgrade, no uninstall.
    expect(rec.calls).toHaveLength(0);
    assertNoForbiddenTokens(rec.calls, "VERSION-DIVERGENT/drift");
  });

  // -------------------------------------------------------------------------
  // Case 5: DESIRED-REMOVED / observe-only scenario.
  //
  // When an entity is removed from desired state, the reconciler does NOT call
  // the provider's apply(); it reports DRIFT for the observed-but-not-desired
  // resource and leaves it in place (fail-safe.md, §3.3). The provider's job
  // is therefore STRUCTURALLY INCAPABLE of uninstalling k3s — it has no
  // destroy/uninstall method.
  //
  // This case asserts TWO complementary properties:
  //   A. STRUCTURAL: the provider interface exposes NO destroy/uninstall member.
  //   B. BEHAVIOURAL: a bare observe() of a present k3s issues ONLY read
  //      commands — no uninstall verbs appear even if called manually.
  //
  // The reconciler's "removal⇒drift" duty is documented here but is tested
  // in the reconciler's own test suite, not here.
  // -------------------------------------------------------------------------
  it("DESIRED-REMOVED: provider has NO destroy/uninstall member (structural)", () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    // Cast through unknown to a loosely-typed record so TypeScript does not
    // prevent us from probing for members the type does not declare (the test
    // PROVES their absence — if someone adds them, the assertion fails and the
    // PR is blocked). The double cast (→ unknown → Record) is the TypeScript-safe
    // pattern when the source type has no index signature (esm-nodenext Rule 3).
    const p = provider as unknown as Record<string, unknown>;

    expect(p["destroy"]).toBeUndefined();
    expect(p["uninstall"]).toBeUndefined();
    expect(p["remove"]).toBeUndefined();
    expect(p["teardown"]).toBeUndefined();
    expect(p["delete"]).toBeUndefined();
  });

  it("DESIRED-REMOVED: bare observe() of a present k3s issues ONLY read commands — no uninstall", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    // Simulate the reconciler's observe pass for an observed-but-not-desired
    // resource: only observe() is called. The provider returns state; no
    // teardown happens.
    const observedState = await provider.observe(DESIRED);

    expect(observedState).not.toBeNull();
    expect(observedState!.payload).toMatchObject({ installed: true });

    // No forbidden token in any of the read-only probe commands.
    assertNoForbiddenTokens(rec.calls, "DESIRED-REMOVED/observe-only");
  });

  // -------------------------------------------------------------------------
  // Case 6: AGGREGATED scan across ALL branches in a single recorder.
  //         Exercises install (absent null), install (absent false), no-op
  //         (same version), drift (divergent version), and observe (present),
  //         then scans EVERY recorded call for forbidden tokens.
  // -------------------------------------------------------------------------
  it("AGGREGATED: ALL branches together — ZERO forbidden tokens across all recorded calls", async () => {
    const rec = createSshExecRecorder();
    // Install branches succeed.
    rec.setResult({ code: 0, stdout: "", stderr: "" });
    // observe branches need specific results — register matchers AFTER default
    // so they win when remoteArgv matches.
    rec.setResultByMatcher(
      (argv) => argv[0] === "k3s" && argv[1] === "--version",
      { code: 0, stdout: "k3s version v1.30.2+k3s1 (abcdef12)\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("is-active"),
      { code: 0, stdout: "active\n", stderr: "" },
    );
    rec.setResultByMatcher(
      (argv) => argv.includes("nodes"),
      { code: 0, stdout: NODES_READY_JSON, stderr: "" },
    );

    const transport = createKubeTransport({ run: rec.run, conn: CONN });
    const provider = createEnsureK3sProvider({ transport });

    // Branch 1: ABSENT (null) — install.
    await provider.apply(DESIRED, null);

    // Branch 2: ABSENT (installed:false) — install.
    await provider.apply(DESIRED, observed({ installed: false }));

    // Branch 3: PRESENT same version — no-op.
    await provider.apply(
      DESIRED,
      observed({ installed: true, version: "v1.30.2+k3s1" }),
    );

    // Branch 4: VERSION-DIVERGENT — drift.
    await provider.apply(
      DESIRED,
      observed({ installed: true, version: "v1.29.0+k3s1" }),
    );

    // Branch 5: observe (present k3s, read-only).
    await provider.observe(DESIRED);

    // Branch 6: verify (present k3s, read-only).
    await provider.verify(DESIRED);

    // All calls from ALL branches must be free of forbidden tokens.
    assertNoForbiddenTokens(rec.calls, "AGGREGATED");

    // Sanity: at least some calls were recorded (install * 2 + observe probes
    // + verify probes = ≥ 2 calls total — prevents a vacuous pass if calls
    // were accidentally empty).
    expect(rec.calls.length).toBeGreaterThan(0);
  });
});
