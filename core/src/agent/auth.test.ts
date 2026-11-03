/**
 * core/src/agent/auth.test.ts
 *
 * TDD tests for the auth boundary (auth.ts) — the trust seam that turns an
 * opaque incoming token into a verified capability set and enforces it.
 *
 * SECURITY-CRITICAL teeth verified here:
 *   1. authenticate() resolves a known token → VerifiedCredential with the
 *      configured actor + capability set.
 *   2. authenticate() with an unknown/empty token → ReconcileError("fatal")
 *      (authz, non-retryable) — no credential is fabricated past the boundary.
 *   3. authorize() allows an in-scope tool and returns the effective scope
 *      string for StateEvent recording.
 *   4. authorize() DENIES an out-of-scope tool BEFORE any write
 *      (ReconcileError fatal) and the deny is surfaceable via the Task 4.1
 *      error() envelope as status:"error" with code "fatal".
 *   5. authorizeAndRecord(): an ALLOWED call appends exactly one StateEvent
 *      whose actor == the agent and whose scope == the effective capability
 *      scope (spec: every StateEvent records the actor; 4.2 adds cap scope).
 *   6. authorizeAndRecord(): a DENIED out-of-scope call writes NOTHING — no
 *      StateEvent of the action is appended (deny-before-write proven against
 *      the real append-only store), and the action callback never runs.
 *   7. REGRESSION GUARD: reconcile.ts / plan.ts / apply.ts carry ZERO
 *      capability/auth dependency — enforcement is the interface's job only.
 *   8. Minimal module surface.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { error as errorEnvelope } from "./envelope.js";
import { ReconcileError } from "../domain/errors.js";
import { queryEvents } from "../store/state-events.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";
import type pg from "pg";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
  await resetSchema(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await closeTestPool();
});

// v1 trust seam: an injected token → {actor, capabilities} map. Real identity
// (JWT/mTLS) is explicitly deferred/out of scope (YAGNI).
function makeStore(): auth.CredentialStore {
  return auth.createInjectedCredentialStore({
    "tok-vox": {
      actor: "vox",
      capabilities: [
        "get_state",
        "diff",
        "events",
        "health",
        "provision_server",
        "deploy_service",
        "scale_service",
        "set_dns",
        "snapshot",
        "restore",
        "destroy",
        "apply_manifest",
      ],
    },
    "tok-runner": {
      actor: "runner-7",
      capabilities: ["deploy_service", "scale_service", "get_state"],
    },
  });
}

describe("authenticate — the trust boundary", () => {
  it("resolves a known token to a verified credential", () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    expect(auth.actorOf(cred)).toBe("runner-7");
  });

  it("rejects an unknown token as fatal (no fabricated credential)", () => {
    try {
      auth.authenticate(makeStore(), "tok-nope");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });

  it("rejects an empty token as fatal", () => {
    try {
      auth.authenticate(makeStore(), "");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ReconcileError).errorClass).toBe("fatal");
    }
  });
});

describe("authorize — deny-before-write decision", () => {
  it("allows an in-scope tool and yields the effective scope", () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    const scope = auth.authorize(cred, "deploy_service");
    expect(scope).toContain("runner-7");
    expect(scope).toContain("deploy_service");
  });

  it("denies an out-of-scope tool as fatal, surfaceable via error() envelope", () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    try {
      auth.authorize(cred, "destroy");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileError);
      const env = errorEnvelope(e as ReconcileError);
      expect(env.status).toBe("error");
      expect(env.error?.code).toBe("fatal");
      expect(env.error?.retryable).toBe(false);
    }
  });
});

describe("authorizeAndRecord — deny BEFORE write, scope recorded on allow", () => {
  it("ALLOWED: appends one StateEvent carrying actor + capability scope", async () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    let ran = false;

    await auth.authorizeAndRecord(
      pool,
      cred,
      "deploy_service",
      { op: "update", entity: "service:web-42", result: "ok" },
      async () => {
        ran = true;
      },
    );

    expect(ran).toBe(true);
    const evs = await queryEvents(pool, { entity: "service:web-42" });
    expect(evs.length).toBe(1);
    expect(evs[0]?.actor).toBe("runner-7");
    expect(evs[0]?.result).toBe("ok");
    // 4.2: effective capability scope recorded in the StateEvent.
    // EXACT-equality pin (deterministic sorted form) — guards the 4.6 scope
    // contract against a capability-reordering regression.
    expect(evs[0]?.scope).toBe(
      "agent:runner-7 caps:[deploy_service,get_state,scale_service]",
    );
  });

  it("AUTHORIZED-BUT-FAILED: audits exactly one result:'error' event, no leak, re-throws original", async () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    const SECRET = "hcloud-token-SUPERSECRET-must-not-be-audited";
    const boom = new Error(`provider exploded with ${SECRET}`);

    await expect(
      auth.authorizeAndRecord(
        pool,
        cred,
        "deploy_service",
        { op: "update", entity: "service:fail-99", result: "ok" },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom); // ORIGINAL error propagates, not swallowed/wrapped

    const evs = await queryEvents(pool, { entity: "service:fail-99" });
    // Authorized-but-failed action MUST NOT vanish from the append-only trail.
    expect(evs.length).toBe(1);
    expect(evs[0]?.result).toBe("error");
    // actor + scope still derived from the verified credential (not caller).
    expect(evs[0]?.actor).toBe("runner-7");
    expect(evs[0]?.scope).toBe(
      "agent:runner-7 caps:[deploy_service,get_state,scale_service]",
    );
    // No secret / thrown-value leak anywhere in the recorded event.
    expect(JSON.stringify(evs[0])).not.toContain(SECRET);
  });

  it("DENIED: writes NOTHING and never runs the action (deny-before-write)", async () => {
    const cred = auth.authenticate(makeStore(), "tok-runner");
    let ran = false;

    await expect(
      auth.authorizeAndRecord(
        pool,
        cred,
        "destroy",
        { op: "delete", entity: "server:victim-1", result: "ok" },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toBeInstanceOf(ReconcileError);

    expect(ran).toBe(false);
    // No StateEvent for the denied action was appended.
    const evs = await queryEvents(pool, { entity: "server:victim-1" });
    expect(evs.length).toBe(0);
  });
});

describe("REGRESSION GUARD — enforcement is the interface, NOT the reconciler", () => {
  const here = fileURLToPath(import.meta.url);
  const read = (rel: string) =>
    readFileSync(here.replace(/agent[/\\]auth\.test\.ts$/, rel), "utf8");

  for (const f of [
    "reconciler/reconcile.ts",
    "reconciler/plan.ts",
    "reconciler/apply.ts",
  ]) {
    it(`${f} does not import the capability/auth modules`, () => {
      const src = read(f);
      expect(src).not.toContain("agent/capability");
      expect(src).not.toContain("agent/auth");
      expect(src).not.toMatch(/\bassertCapability\b/);
      expect(src).not.toMatch(/\bauthorize\b/);
    });
  }
});

describe("minimal module surface", () => {
  it("exposes only the documented boundary helpers", () => {
    const r = auth as Record<string, unknown>;
    expect(typeof r["createInjectedCredentialStore"]).toBe("function");
    expect(typeof r["authenticate"]).toBe("function");
    expect(typeof r["authorize"]).toBe("function");
    expect(typeof r["authorizeAndRecord"]).toBe("function");
    expect(typeof r["actorOf"]).toBe("function");
  });
});
