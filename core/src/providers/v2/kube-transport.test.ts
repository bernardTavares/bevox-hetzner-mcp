/**
 * core/src/providers/v2/kube-transport.test.ts
 *
 * Bloco E Task 4 — drives the `KubeTransport` seam (kubectl-over-SSH) against
 * the INJECTED `ssh-exec-recorder` fake (the `SshRunner` seam). ZERO real ssh /
 * host / kubectl / k3s / network. Deterministic.
 *
 * What is proven HERE (seam-conformance — real-host kubectl is the operator's
 * first-deploy @live step, see the module header):
 *   - the remote argv is assembled argv-only as
 *     `["kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml", ...args]`
 *     (asserted token-by-token), NO shell, NO body in argv;
 *   - the manifest body travels ONLY via `opts.stdin`, NEVER an argv token;
 *   - the runner's `{code,stdout,stderr}` is returned faithfully on success;
 *   - SECRET-BOUNDARY: on a non-zero / 255 failure, the thrown error message
 *     contains ONLY host + a scrubbed exit signal — NOT the stdin body (which
 *     in later tasks carries a resolved secret), NOT the manifest.
 */

import { describe, it, expect } from "vitest";
import { createKubeTransport } from "./kube-transport.js";
import { ReconcileError } from "../../domain/errors.js";
import type { SshConnection } from "../ssh-exec.js";
import type { SshRunner } from "../ssh-transports.js";
import { createSshExecRecorder } from "../../../test/fakes/ssh-exec-recorder.js";

const CONN: SshConnection = {
  host: "10.0.0.9",
  user: "deploy",
  port: 22,
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----KUBE_KEY_LEAK-----END-----",
  hostKeyPolicy: "accept-new",
};

/** A manifest body standing in for a (future) secret-bearing resolved YAML. */
const MANIFEST =
  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n        - name: api\n          env:\n            - name: PW\n              value: S3CR3T-5.4-must-never-leak-Kt4";

describe("Bloco E Task 4 — KubeTransport: kubectl-over-SSH, manifest on stdin", () => {
  it("assembles `kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml <args>` (default path)", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "NAME\napi\n", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    await transport.kubectl(["get", "pods", "-o", "json"]);

    expect(rec.calls).toHaveLength(1);
    // Token-by-token assertion: kubectl, the kubeconfig flag+default path, args.
    expect(rec.calls[0]!.remoteArgv).toEqual([
      "kubectl",
      "--kubeconfig",
      "/etc/rancher/k3s/k3s.yaml",
      "get",
      "pods",
      "-o",
      "json",
    ]);
    // The connection threaded through unchanged.
    expect(rec.calls[0]!.conn).toEqual(CONN);
  });

  it("honours an explicit kubeconfig override", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({
      run: rec.run,
      conn: CONN,
      kubeconfig: "/home/deploy/.kube/config",
    });

    await transport.kubectl(["version", "--client"]);

    expect(rec.calls[0]!.remoteArgv).toEqual([
      "kubectl",
      "--kubeconfig",
      "/home/deploy/.kube/config",
      "version",
      "--client",
    ]);
  });

  it("pipes the manifest via opts.stdin, NEVER as an argv token", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv.includes("apply"),
      { code: 0, stdout: "deployment.apps/api configured", stderr: "" },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    const res = await transport.kubectl(["apply", "-f", "-"], MANIFEST);

    expect(res).toEqual({
      code: 0,
      stdout: "deployment.apps/api configured",
      stderr: "",
    });
    // The body landed on stdin…
    expect(rec.calls[0]!.stdin).toBe(MANIFEST);
    // …and NOWHERE in argv.
    const argvJoined = rec.calls[0]!.remoteArgv.join(" ");
    expect(argvJoined).not.toContain("apiVersion");
    expect(argvJoined).not.toContain("Deployment");
    expect(argvJoined).not.toContain("S3CR3T");
    expect(argvJoined).not.toContain(MANIFEST);
  });

  it("omits stdin entirely when no manifest is given", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    await transport.kubectl(["get", "nodes"]);

    expect(rec.calls[0]!.stdin).toBeUndefined();
  });

  it("returns the runner's {code,stdout,stderr} faithfully on success", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: `{"items":[]}`, stderr: "warn: deprecated" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    const res = await transport.kubectl(["get", "deploy", "-o", "json"]);

    expect(res).toEqual({
      code: 0,
      stdout: `{"items":[]}`,
      stderr: "warn: deprecated",
    });
  });

  it("SECRET-BOUNDARY: a non-zero kubectl exit throws host + scrubbed signal — never the stdin body", async () => {
    const rec = createSshExecRecorder();
    rec.setResultByMatcher(
      (argv) => argv.includes("apply"),
      {
        code: 1,
        stdout: "",
        // A hostile/verbose kubectl could echo the applied manifest back in
        // stderr — including the resolved secret. We must scrub it.
        stderr: `error validating data: S3CR3T-5.4-must-never-leak-Kt4; apiVersion: apps/v1`,
      },
    );
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    let thrown: unknown;
    try {
      await transport.kubectl(["apply", "-f", "-"], MANIFEST);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ReconcileError);
    const err = thrown as ReconcileError;
    // A non-zero kubectl exit is a remote APPLICATION/exec failure (e.g. an
    // invalid manifest) — NOT a network blip. It must classify `fatal` (a
    // permanent application/config failure), so it is NOT retryable and will
    // not mistrigger retry / circuit-breaker logic downstream.
    expect(err.errorClass).toBe("fatal");
    expect(err.retryable).toBe(false);
    // Host (non-secret) IS present; the manifest body / sentinel is NOT.
    expect(err.message).toContain("10.0.0.9");
    expect(err.message).not.toContain("S3CR3T");
    expect(err.message).not.toContain(MANIFEST);
    expect(err.message).not.toContain("apiVersion");
    // The cause chain must not carry the body either.
    expect(JSON.stringify(err.cause ?? null)).not.toContain("S3CR3T");
    expect(JSON.stringify(err.cause ?? null)).not.toContain(MANIFEST);
  });

  it("SECRET-BOUNDARY: an ssh-level (255) ReconcileError from the runner propagates already-scrubbed", async () => {
    const sshErr = new ReconcileError(
      "fatal",
      "ssh: connection to 10.0.0.9 failed (exit 255): permission denied",
      { entity: "ssh:10.0.0.9" },
    );
    // A runner that throws a pre-scrubbed ssh-level error (as real runSsh does).
    const run: SshRunner = () => Promise.reject(sshErr);
    const transport = createKubeTransport({ run, conn: CONN });

    let thrown: unknown;
    try {
      await transport.kubectl(["apply", "-f", "-"], MANIFEST);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(sshErr); // propagated verbatim — already secret-free
    expect((thrown as ReconcileError).message).not.toContain("S3CR3T");
  });

  it("SECRET-BOUNDARY: a non-ReconcileError from the runner is wrapped without echoing the body", async () => {
    // A raw error whose message embeds the secret (e.g. a buggy seam).
    const run: SshRunner = () =>
      Promise.reject(new Error(`spawn failed near S3CR3T-5.4-must-never-leak-Kt4`));
    const transport = createKubeTransport({ run, conn: CONN });

    let thrown: unknown;
    try {
      await transport.kubectl(["apply", "-f", "-"], MANIFEST);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ReconcileError);
    const err = thrown as ReconcileError;
    // A raw runner throw is a connectivity/exec-seam failure — the seam wraps
    // it as `network-error` → `transient`, so it IS retryable (guards the
    // circuit-breaker semantics, mirroring the non-zero-exit test above).
    expect(err.errorClass).toBe("transient");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("10.0.0.9");
    expect(err.message).not.toContain("S3CR3T");
    expect(err.message).not.toContain(MANIFEST);
  });
});

describe("Bloco E Task 16 — KubeTransport.run: RAW host exec (no kubectl prefix)", () => {
  it("assembles the argv VERBATIM, WITHOUT the kubectl/kubeconfig prefix", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "k3s version v1.30.2+k3s1 (xyz)\n", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    await transport.run(["k3s", "--version"]);

    expect(rec.calls).toHaveLength(1);
    // RAW host argv: NO "kubectl", NO "--kubeconfig", NO k3s.yaml path.
    expect(rec.calls[0]!.remoteArgv).toEqual(["k3s", "--version"]);
    expect(rec.calls[0]!.remoteArgv).not.toContain("kubectl");
    expect(rec.calls[0]!.remoteArgv).not.toContain("--kubeconfig");
    // The connection threaded through unchanged.
    expect(rec.calls[0]!.conn).toEqual(CONN);
  });

  it("returns the runner's {code,stdout,stderr} faithfully on success", async () => {
    const rec = createSshExecRecorder();
    rec.setResult({ code: 0, stdout: "active\n", stderr: "" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    const res = await transport.run(["systemctl", "is-active", "k3s"]);

    expect(res).toEqual({ code: 0, stdout: "active\n", stderr: "" });
  });

  it("returns a NON-ZERO exit faithfully (does NOT throw — caller maps the status)", async () => {
    // `k3s --version` exits non-zero when k3s is absent; observe() maps this to
    // installed:false. `run` must NOT invent a ReconcileError from a command's
    // own non-zero exit (read-only, fail-safe) — it returns the result.
    const rec = createSshExecRecorder();
    rec.setResult({ code: 127, stdout: "", stderr: "k3s: command not found" });
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    const res = await transport.run(["k3s", "--version"]);

    expect(res).toEqual({ code: 127, stdout: "", stderr: "k3s: command not found" });
  });

  it("omits stdin entirely when none is given", async () => {
    const rec = createSshExecRecorder();
    const transport = createKubeTransport({ run: rec.run, conn: CONN });

    await transport.run(["k3s", "kubectl", "get", "nodes", "-o", "json"]);

    expect(rec.calls[0]!.stdin).toBeUndefined();
  });

  it("SECRET-BOUNDARY: an ssh-level (255) ReconcileError from the runner propagates already-scrubbed", async () => {
    const sshErr = new ReconcileError(
      "fatal",
      "ssh: connection to 10.0.0.9 failed (exit 255): permission denied",
      { entity: "ssh:10.0.0.9" },
    );
    const run: SshRunner = () => Promise.reject(sshErr);
    const transport = createKubeTransport({ run, conn: CONN });

    let thrown: unknown;
    try {
      await transport.run(["k3s", "--version"]);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(sshErr); // propagated verbatim — already secret-free
  });

  it("SECRET-BOUNDARY: a non-ReconcileError from the runner is wrapped to host-only signal", async () => {
    const run: SshRunner = () =>
      Promise.reject(new Error(`spawn failed near ${CONN.privateKey}`));
    const transport = createKubeTransport({ run, conn: CONN });

    let thrown: unknown;
    try {
      await transport.run(["k3s", "--version"]);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ReconcileError);
    const err = thrown as ReconcileError;
    expect(err.errorClass).toBe("transient");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("10.0.0.9");
    // The SSH key (a secret) must never reach the error message.
    expect(err.message).not.toContain("KUBE_KEY_LEAK");
    expect(err.message).not.toContain(CONN.privateKey);
  });
});
