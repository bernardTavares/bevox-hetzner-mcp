/**
 * core/src/config.test.ts
 *
 * Task 6.6 — TDD for the config boundary. Proves: required secrets have NO
 * default (a missing one is a HARD error), the error is FAIL-FAST and
 * VALUE-FREE (lists key NAMES only, never echoes a secret), non-secret knobs
 * carry sane defaults, and `loadConfig(env)` is injectable (no real
 * `process.env` mutation). Pure unit — no DB, no network, no timers.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { loadConfig, ConfigSchema, intKnob, type Config } from "./config.js";
import { ReconcileError } from "./domain/errors.js";

// A complete, valid env with DISTINCTIVE secret SENTINELS so a leak is
// unambiguous if one ever appears in an error message.
const DB_SENTINEL = "postgresql://u:PWD_SENTINEL_db_xyz@h:5432/d";
const HCLOUD_SENTINEL = "HCLOUD_TOKEN_SENTINEL_aaa";
const DNS_SENTINEL = "HCLOUD_DNS_TOKEN_SENTINEL_bbb";
const RESTIC_PW_SENTINEL = "RESTIC_PASSWORD_SENTINEL_ccc";
const SSH_KEY_SENTINEL = "-----BEGIN KEY-----SSH_PRIVATE_SENTINEL_ddd-----END-----";
const CREDS_SENTINEL =
  '{"tok-vox":{"actor":"agent:vox","capabilities":["destroy"]}}';

function fullEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: DB_SENTINEL,
    HCLOUD_TOKEN: HCLOUD_SENTINEL,
    HCLOUD_DNS_TOKEN: DNS_SENTINEL,
    RESTIC_REPO: "sftp:backup@vault:/restic",
    RESTIC_PASSWORD: RESTIC_PW_SENTINEL,
    SSH_HOST: "10.0.0.1",
    SSH_USER: "deploy",
    SSH_PRIVATE_KEY: SSH_KEY_SENTINEL,
    AGENT_CREDENTIALS: CREDS_SENTINEL,
    // Task 5.2 — required path values for the sops-age secret resolver.
    // Placeholders (not real files) — config layer validates non-emptiness
    // only; filesystem lstat lives in validateSopsAgeConfig.
    SECRETS_FILE: "/tmp/secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age.key",
  };
}

const ALL_SENTINELS = [
  DB_SENTINEL,
  HCLOUD_SENTINEL,
  DNS_SENTINEL,
  RESTIC_PW_SENTINEL,
  SSH_KEY_SENTINEL,
  CREDS_SENTINEL,
];

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "HCLOUD_TOKEN",
  "HCLOUD_DNS_TOKEN",
  "RESTIC_REPO",
  "RESTIC_PASSWORD",
  "SSH_HOST",
  "SSH_USER",
  "SSH_PRIVATE_KEY",
  "AGENT_CREDENTIALS",
  // Task 5.2 — required path values for the sops-age resolver.
  "SECRETS_FILE",
  "SOPS_AGE_KEY_FILE",
] as const;

describe("6.6 config — required secrets, no defaults, fail-fast", () => {
  it("parses a complete env into a frozen typed Config", () => {
    const cfg: Config = loadConfig(fullEnv());
    expect(cfg.DATABASE_URL).toBe(DB_SENTINEL);
    expect(cfg.HCLOUD_TOKEN).toBe(HCLOUD_SENTINEL);
    expect(cfg.AGENT_CREDENTIALS).toBe(CREDS_SENTINEL);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  // Bug 1 — Node --env-file does not unescape `\n`; operators write PEM keys
  // with literal `\n`. config.ts normalises SSH_PRIVATE_KEY to real newlines
  // (+ trailing newline OpenSSH requires). RESTIC_PASSWORD is NOT touched.
  it("unescapes literal \\n in SSH_PRIVATE_KEY and ensures a trailing newline", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      SSH_PRIVATE_KEY: "-----BEGIN-----\\nLINE1\\nLINE2\\n-----END-----",
    });
    expect(cfg.SSH_PRIVATE_KEY).toBe(
      "-----BEGIN-----\nLINE1\nLINE2\n-----END-----\n",
    );
  });

  it("collapses CRLF-escaped \\r\\n too — no stray backslash-r in the PEM", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      SSH_PRIVATE_KEY: "-----BEGIN-----\\r\\nABC\\r\\n-----END-----",
    });
    expect(cfg.SSH_PRIVATE_KEY).toBe("-----BEGIN-----\nABC\n-----END-----\n");
    expect(cfg.SSH_PRIVATE_KEY).not.toContain("\\r");
  });

  it("is idempotent for a PEM that already has real newlines (only ensures trailing)", () => {
    const real = "-----BEGIN-----\nABC\n-----END-----\n";
    const cfg = loadConfig({ ...fullEnv(), SSH_PRIVATE_KEY: real });
    expect(cfg.SSH_PRIVATE_KEY).toBe(real);
  });

  it("does NOT unescape \\n in RESTIC_PASSWORD (scope guard)", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      RESTIC_PASSWORD: "pw\\nwith\\nliteral",
    });
    expect(cfg.RESTIC_PASSWORD).toBe("pw\\nwith\\nliteral");
  });

  it("non-secret knobs carry sane documented defaults when absent", () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.PORT).toBe(8787);
    expect(cfg.RECONCILE_INTERVAL_MS).toBe(60_000);
    expect(cfg.DRIFT_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(cfg.CYCLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(cfg.LOG_LEVEL).toBe("info");
  });

  it("REGISTRY_AUTH_REFS is optional, preserved verbatim (no JSON parse here) (Bug 11)", () => {
    const absent = loadConfig(fullEnv());
    expect(absent.REGISTRY_AUTH_REFS).toBeUndefined();

    const present = loadConfig({ ...fullEnv(), REGISTRY_AUTH_REFS: '{"ghcr.io":"ghcr-pat"}' });
    expect(present.REGISTRY_AUTH_REFS).toBe('{"ghcr.io":"ghcr-pat"}');
  });

  it("overrides non-secret knobs from the env (string→typed)", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      PORT: "0",
      RECONCILE_INTERVAL_MS: "1000",
      DRIFT_SWEEP_INTERVAL_MS: "2000",
      CYCLE_TIMEOUT_MS: "3000",
      LOG_LEVEL: "warn",
    });
    expect(cfg.PORT).toBe(0);
    expect(cfg.RECONCILE_INTERVAL_MS).toBe(1000);
    expect(cfg.DRIFT_SWEEP_INTERVAL_MS).toBe(2000);
    expect(cfg.CYCLE_TIMEOUT_MS).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe("warn");
  });

  it.each(REQUIRED_SECRETS)(
    "FAILS FAST when the required secret %s is missing (no default)",
    (key) => {
      const env = fullEnv();
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ReconcileError);
      try {
        loadConfig(env);
      } catch (e) {
        const err = e as ReconcileError;
        expect(err.errorClass).toBe("precondition");
        // The message names the OFFENDING key (actionable)…
        expect(err.message).toContain(key);
      }
    },
  );

  it("a blank/whitespace secret is rejected (never a silent empty fallback)", () => {
    for (const key of REQUIRED_SECRETS) {
      const env = { ...fullEnv(), [key]: "   " };
      expect(() => loadConfig(env), `${key} blank`).toThrow(ReconcileError);
    }
  });

  it("VALUE-FREE error: no secret value is ever echoed, even when malformed", () => {
    // Every required key absent → the error lists ALL names but NO values.
    const err = (() => {
      try {
        loadConfig({});
        return undefined;
      } catch (e) {
        return e as ReconcileError;
      }
    })();
    expect(err).toBeInstanceOf(ReconcileError);
    const text = `${err!.message} ${JSON.stringify(err!.toApiError())}`;
    for (const secret of ALL_SENTINELS) {
      expect(text, "error must not echo any secret value").not.toContain(
        secret,
      );
    }
    // It DOES list the missing key names (actionable, secret-safe).
    for (const key of REQUIRED_SECRETS) {
      expect(err!.message).toContain(key);
    }
  });

  it("a malformed secret-bearing value is not echoed in the error", () => {
    // Supply a present-but-invalid non-secret knob alongside a secret that
    // carries a sentinel: the error must name the bad KEY, never the secret.
    const env = { ...fullEnv(), PORT: "-5" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as ReconcileError).message;
    }
    expect(msg).toContain("PORT");
    for (const secret of ALL_SENTINELS) {
      expect(msg).not.toContain(secret);
    }
  });

  it("loadConfig defaults to process.env but accepts an injected record (no global mutation)", () => {
    const before = JSON.stringify(process.env);
    expect(() => loadConfig(fullEnv())).not.toThrow();
    // The injected-env call did NOT touch process.env.
    expect(JSON.stringify(process.env)).toBe(before);
    // ConfigSchema is exported for assertions.
    expect(ConfigSchema.safeParse(fullEnv()).success).toBe(true);
  });
});

describe("intKnob — optional max bound (Task 5.1)", () => {
  it("intKnob enforces max bound (when provided)", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(() => schema.parse({ X: "70000" })).toThrow(/X/);
    expect(schema.parse({ X: "5000" })).toEqual({ X: 5000 });
    expect(schema.parse({})).toEqual({ X: 5000 });
  });
});

describe("MANAGED_MESH knob (Task 1.1)", () => {
  it("ConfigSchema parses MANAGED_MESH default to 'on' when absent", () => {
    const env = fullEnv();
    delete env.MANAGED_MESH;
    const cfg = loadConfig(env);
    expect(cfg.MANAGED_MESH).toBe("on");
  });

  it("ConfigSchema parses MANAGED_MESH='off' verbatim", () => {
    const cfg = loadConfig({ ...fullEnv(), MANAGED_MESH: "off" });
    expect(cfg.MANAGED_MESH).toBe("off");
  });

  it("ConfigSchema treats MANAGED_MESH empty string as default 'on'", () => {
    const cfg = loadConfig({ ...fullEnv(), MANAGED_MESH: "" });
    expect(cfg.MANAGED_MESH).toBe("on");
  });

  it("ConfigSchema rejects MANAGED_MESH invalid value", () => {
    expect(() => loadConfig({ ...fullEnv(), MANAGED_MESH: "maybe" }))
      .toThrow(/MANAGED_MESH/);
  });
});

describe("MANAGED_SERVICES knob (Task 2.1 — spec 2026-05-26 §3)", () => {
  it("ConfigSchema parses MANAGED_SERVICES default to 'on' when absent", () => {
    const env = fullEnv();
    delete env.MANAGED_SERVICES;
    const cfg = loadConfig(env);
    expect(cfg.MANAGED_SERVICES).toBe("on");
  });

  it("ConfigSchema parses MANAGED_SERVICES='off' verbatim", () => {
    const cfg = loadConfig({ ...fullEnv(), MANAGED_SERVICES: "off" });
    expect(cfg.MANAGED_SERVICES).toBe("off");
  });

  it("ConfigSchema treats MANAGED_SERVICES empty string as default 'on'", () => {
    const cfg = loadConfig({ ...fullEnv(), MANAGED_SERVICES: "" });
    expect(cfg.MANAGED_SERVICES).toBe("on");
  });

  it("ConfigSchema rejects MANAGED_SERVICES invalid value", () => {
    expect(() => loadConfig({ ...fullEnv(), MANAGED_SERVICES: "maybe" }))
      .toThrow(/MANAGED_SERVICES/);
  });
});

describe("MIGRATION_TIMEOUT_MS knob (Task 3.2 — spec 2026-05-28 §1.5/§4)", () => {
  it("defaults to 60000 when absent", () => {
    expect(loadConfig({ ...fullEnv() }).MIGRATION_TIMEOUT_MS).toBe(60000);
  });

  it("accepts values in [1000, 600000]", () => {
    expect(
      loadConfig({ ...fullEnv(), MIGRATION_TIMEOUT_MS: "1000" })
        .MIGRATION_TIMEOUT_MS,
    ).toBe(1000);
    expect(
      loadConfig({ ...fullEnv(), MIGRATION_TIMEOUT_MS: "30000" })
        .MIGRATION_TIMEOUT_MS,
    ).toBe(30000);
    expect(
      loadConfig({ ...fullEnv(), MIGRATION_TIMEOUT_MS: "600000" })
        .MIGRATION_TIMEOUT_MS,
    ).toBe(600000);
  });

  it("rejects out-of-bounds (below min or above max)", () => {
    expect(() =>
      loadConfig({ ...fullEnv(), MIGRATION_TIMEOUT_MS: "500" }),
    ).toThrow(/MIGRATION_TIMEOUT_MS/);
    expect(() =>
      loadConfig({ ...fullEnv(), MIGRATION_TIMEOUT_MS: "700000" }),
    ).toThrow(/MIGRATION_TIMEOUT_MS/);
  });
});

describe("intKnob optional max bound (Task 3.1 — spec 2026-05-28 §1.3)", () => {
  it("enforces max bound when provided (rejects above)", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(() => schema.parse({ X: "70000" })).toThrow(/X/);
  });

  it("accepts value at the max bound (inclusive)", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(schema.parse({ X: "60000" })).toEqual({ X: 60000 });
  });

  it("accepts value within range and applies default when absent", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(schema.parse({ X: "5000" })).toEqual({ X: 5000 });
    expect(schema.parse({})).toEqual({ X: 5000 });
  });

  it("still enforces min bound (rejects below)", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(() => schema.parse({ X: "500" })).toThrow(/X/);
  });
});

describe("STRICT_MANIFEST_APPROVAL knob (Task 1.1 — spec 2026-05-27)", () => {
  it("defaults to 'off' when absent (v1 FROZEN preservation)", () => {
    const env = fullEnv();
    delete env.STRICT_MANIFEST_APPROVAL;
    const cfg = loadConfig(env);
    expect(cfg.STRICT_MANIFEST_APPROVAL).toBe("off");
  });

  it("parses 'on' verbatim (opt-in)", () => {
    const cfg = loadConfig({ ...fullEnv(), STRICT_MANIFEST_APPROVAL: "on" });
    expect(cfg.STRICT_MANIFEST_APPROVAL).toBe("on");
  });

  it("parses 'off' verbatim", () => {
    const cfg = loadConfig({ ...fullEnv(), STRICT_MANIFEST_APPROVAL: "off" });
    expect(cfg.STRICT_MANIFEST_APPROVAL).toBe("off");
  });

  it("treats empty string as default 'off'", () => {
    const cfg = loadConfig({ ...fullEnv(), STRICT_MANIFEST_APPROVAL: "" });
    expect(cfg.STRICT_MANIFEST_APPROVAL).toBe("off");
  });

  it("rejects invalid value", () => {
    expect(() =>
      loadConfig({ ...fullEnv(), STRICT_MANIFEST_APPROVAL: "maybe" }),
    ).toThrow(/STRICT_MANIFEST_APPROVAL/);
  });
});

describe("sops-age resolver config (Task 5.2)", () => {
  it("ConfigSchema requires SECRETS_FILE", () => {
    const env = fullEnv();
    delete env.SECRETS_FILE;
    expect(() => loadConfig(env)).toThrow(/SECRETS_FILE/);
  });

  it("ConfigSchema requires SOPS_AGE_KEY_FILE", () => {
    const env = fullEnv();
    delete env.SOPS_AGE_KEY_FILE;
    expect(() => loadConfig(env)).toThrow(/SOPS_AGE_KEY_FILE/);
  });

  it("ConfigSchema: SECRETS_TIMEOUT_MS default 5000, bounded [1000, 60000]", () => {
    expect(loadConfig({ ...fullEnv() }).SECRETS_TIMEOUT_MS).toBe(5000);
    expect(
      loadConfig({ ...fullEnv(), SECRETS_TIMEOUT_MS: "10000" })
        .SECRETS_TIMEOUT_MS,
    ).toBe(10000);
    expect(() =>
      loadConfig({ ...fullEnv(), SECRETS_TIMEOUT_MS: "500" }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...fullEnv(), SECRETS_TIMEOUT_MS: "70000" }),
    ).toThrow();
  });
});
