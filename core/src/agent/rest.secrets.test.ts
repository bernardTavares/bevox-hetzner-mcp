/**
 * core/src/agent/rest.secrets.test.ts
 *
 * Task 4.5b — TDD teeth for `GET /api/secrets` (the console-only read that is
 * NOT in the Tool→Endpoint table). HARD SECURITY INVARIANT: this endpoint
 * MUST NEVER expose a secret value — only `{ name, keys, used_by }` (the bare
 * name, the key COUNT, and which entities use the secret).
 *
 * The handler is exercised IN-PROCESS via the same minimal IncomingMessage/
 * ServerResponse doubles as rest.test.ts (NO real port — deterministic).
 *
 * Teeth asserted (the exact contract guarantees):
 *   - GET /api/secrets → SecretSchema[] derived ONLY from the Fase-1 secrets
 *     model's `describe()` metadata: each item `{ name, keys(count), used_by }`;
 *   - every item parses against a byte-faithful mirror of the FROZEN console
 *     `.strict()` `SecretSchema` (the envelope.ts/errors.ts mirror precedent —
 *     the live cross-package check is Task 4.6);
 *   - `.strict()` REJECTS any injected `value`-like field (the schema itself is
 *     a tooth: a Fase-4 backend that bolted a `value` on is caught);
 *   - a sentinel secret value planted in the resolver NEVER appears anywhere in
 *     the serialized response body (deep scan);
 *   - the route NEVER calls `resolve()` (no `applyContext` on a read path) —
 *     a resolver whose `resolve()` throws if invoked proves it is untouched;
 *   - read-route discipline: missing/invalid credential → contract error +
 *     correct status + NO secret metadata leaked (deny-before-write);
 *   - no store mutation (no working_state / approvals rows written).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { ALL_TOOLS } from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import { createToolCatalog } from "./tools.js";
import { createInjectedCredentialStore } from "./auth.js";
import { createRestServer, type RestServer } from "./rest.js";
import {
  createStubSecretResolver,
  type SecretResolver,
  type SecretMeta,
} from "../store/secrets.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

// ===========================================================================
// By-value mirror of the FROZEN console/src/api/contract.ts `SecretSchema`
// (envelope.ts/errors.ts precedent — no console import; the 4.6 oracle owns
// the cross-package live-schema check). MUST stay byte-faithful: `keys` is a
// non-negative integer COUNT (NOT the key-name array the core models), and
// `.strict()` so an injected `value` is REJECTED rather than stripped.
// ===========================================================================

const SecretSchema = z
  .object({
    name: z.string(),
    keys: z.number().int().nonnegative(),
    used_by: z.array(z.string()),
  })
  .strict();

// ===========================================================================
// In-process HTTP request/response doubles (NO port bound) — copied from
// rest.test.ts so the exact handler path is exercised deterministically.
// ===========================================================================

class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private body: Buffer;
  constructor(opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) {
    super();
    this.method = opts.method;
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.body =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body), "utf8");
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.body.length > 0) yield this.body;
  }
}

class FakeRes {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  done: Promise<void>;
  private resolveDone!: () => void;
  constructor() {
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }
  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(chunk?: Buffer | string): void {
    if (chunk) {
      this.chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    }
    this.resolveDone();
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  json(): unknown {
    const t = this.text;
    return t === "" ? undefined : JSON.parse(t);
  }
}

// ===========================================================================
// Network-free catalog/gate fakes (mirror rest.test.ts so REST stays in sync)
// ===========================================================================

let pool: pg.Pool;

beforeAll(() => {
  pool = getTestPool();
});
afterAll(async () => {
  await closeTestPool();
});
beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

const FIXED = new Date("2026-05-18T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };

function makeFakeProvider(): Provider {
  const reality = new Set<string>();
  return {
    name: "fake",
    async observe(scope: string): Promise<ObservedSlice> {
      const prefix = `${scope}:`;
      return {
        scope,
        entities: [...reality]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      if (reality.has(action.entity)) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
}

const TOKEN = "tok-vox";

// The planted secret value MUST never appear anywhere in the response.
const SENTINEL = "S3NT1NEL-secret-material-DO-NOT-LEAK";

/**
 * A resolver that:
 *   - on describe(): returns rich metadata (name + key NAMES + used_by). The
 *     route MUST collapse `keys` to a COUNT and NEVER emit the names/value.
 *   - on resolve(): THROWS — proving the read route never takes the value path.
 * The SENTINEL is buried in a closure the route can only reach via resolve(),
 * so if it appears in the body the no-resolve invariant is broken.
 */
function makePoisonResolver(): {
  resolver: SecretResolver;
  refs: readonly string[];
} {
  const meta: Record<string, SecretMeta> = {
    "secret:bevox-harness": {
      name: "bevox-harness",
      keys: ["API_KEY", "DB_URL", "JWT_SECRET"],
      used_by: ["service:bevox-harness", "service:bevox-backend"],
    },
    "secret:bevox-web": {
      name: "bevox-web",
      keys: ["SENTRY_DSN"],
      used_by: ["service:bevox-web"],
    },
  };
  return {
    refs: Object.keys(meta),
    resolver: {
      describe(ref: string): SecretMeta {
        const m = meta[ref];
        if (!m) throw new Error(`unknown ref ${ref}`);
        return m;
      },
      describeSchema() {
        return createStubSecretResolver().describeSchema();
      },
      async resolve(): Promise<never> {
        // The read route must NEVER reach this. The sentinel only lives on
        // this value path; reaching it would both throw AND leak.
        throw new Error(`resolve() MUST NOT be called on a read route: ${SENTINEL}`);
      },
    },
  };
}

function makeServer(opts?: {
  secrets?: { resolver: SecretResolver; refs: readonly string[] };
}): { rest: RestServer } {
  const desiredByScope = new Map<string, DesiredState>();
  const provider = makeFakeProvider();
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock,
    idFactory: () => `apr_test_${++idn}`,
  });
  const catalog = createToolCatalog({
    pool,
    provider,
    observedAdapter: () => ({
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    }),
    loadDesired: async (scope: string): Promise<DesiredState> =>
      desiredByScope.get(scope) ?? {},
    writeDesired: async (scope: string, desired: DesiredState) => {
      desiredByScope.set(scope, desired);
    },
    makeGate: (isSensitive): ReconcileGate =>
      createApprovalGate({
        pool,
        clock,
        isSensitive,
        idFactory: () => `apr_test_${++idn}`,
      }),
  });
  const credentials = createInjectedCredentialStore({
    [TOKEN]: { actor: "agent:vox", capabilities: [...ALL_TOOLS] },
    "tok-empty": { actor: "agent:weak", capabilities: [] },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    secrets: opts?.secrets,
  });
  return { rest };
}

async function call(
  rest: RestServer,
  opts: { method: string; url: string; token?: string | null },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    headers["authorization"] = `Bearer ${opts.token ?? TOKEN}`;
  }
  const req = new FakeReq({ method: opts.method, url: opts.url, headers });
  const res = new FakeRes();
  await rest.handle(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  await res.done;
  return { status: res.statusCode, body: res.json() };
}

/** Recursively collect every string that appears anywhere in a value. */
function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, out);
  else if (v && typeof v === "object")
    for (const x of Object.values(v)) deepStrings(x, out);
  return out;
}

// ===========================================================================
// GET /api/secrets — refs/usage only, NEVER values
// ===========================================================================

describe("GET /api/secrets (Task 4.5b — refs/usage only, never values)", () => {
  it("returns SecretSchema[] from describe() metadata: name + key COUNT + used_by", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, { method: "GET", url: "/api/secrets" });

    expect(r.status).toBe(200);
    const items = z.array(SecretSchema).parse(r.body);
    expect(items).toEqual([
      { name: "bevox-harness", keys: 3, used_by: ["service:bevox-harness", "service:bevox-backend"] },
      { name: "bevox-web", keys: 1, used_by: ["service:bevox-web"] },
    ]);
  });

  it(".strict() SecretSchema REJECTS any injected `value`-like field", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, { method: "GET", url: "/api/secrets" });
    const arr = r.body as unknown[];
    // The real response must parse…
    expect(() => z.array(SecretSchema).parse(arr)).not.toThrow();
    // …and the schema is genuinely a tooth: a `value` bolted on is rejected.
    const poisoned = [{ ...(arr[0] as object), value: SENTINEL }];
    expect(() => z.array(SecretSchema).parse(poisoned)).toThrow();
  });

  it("NO secret value / key-name / sentinel material appears anywhere in the body", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, { method: "GET", url: "/api/secrets" });

    const blob = JSON.stringify(r.body);
    expect(blob).not.toContain(SENTINEL);
    // Key NAMES are secret-adjacent material — only the COUNT may be exposed.
    for (const keyName of ["API_KEY", "DB_URL", "JWT_SECRET", "SENTRY_DSN"]) {
      expect(blob).not.toContain(keyName);
    }
    // Deep structural scan: every item has EXACTLY {name,keys,used_by}.
    for (const item of r.body as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual(["keys", "name", "used_by"]);
      expect(typeof item.keys).toBe("number");
    }
    expect(deepStrings(r.body)).not.toContain(SENTINEL);
  });

  it("never calls resolve() (no applyContext on a read path)", async () => {
    // makePoisonResolver().resolve() throws if invoked; a 200 + clean body
    // proves the route stayed on describe() only.
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, { method: "GET", url: "/api/secrets" });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
  });

  it("missing credential → contract error, correct status, NO secret metadata leaked (deny-before-write)", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, {
      method: "GET",
      url: "/api/secrets",
      token: null,
    });
    expect(r.status).toBe(403);
    const blob = JSON.stringify(r.body);
    expect(blob).not.toContain("bevox-harness");
    expect(blob).not.toContain(SENTINEL);
  });

  it("invalid credential → contract error, NO secret metadata leaked", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    const r = await call(rest, {
      method: "GET",
      url: "/api/secrets",
      token: "tok-bogus",
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("bevox-harness");
  });

  it("no store mutation (no working_state / approvals rows written)", async () => {
    const { rest } = makeServer({ secrets: makePoisonResolver() });
    await call(rest, { method: "GET", url: "/api/secrets" });
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("no secrets dep injected → empty list (backward-compatible default)", async () => {
    const { rest } = makeServer(); // prior 4.x callers pass no `secrets`
    const r = await call(rest, { method: "GET", url: "/api/secrets" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});
