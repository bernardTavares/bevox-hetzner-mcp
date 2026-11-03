/**
 * core/src/main.ts
 *
 * Task 7.1 — the executable daemon entrypoint (`npm --prefix core start`).
 * This is the THIN PROCESS SHELL by design: it owns ONLY process concerns
 * (read the real env, choose the SSH transport factory, exit codes, the
 * SIGTERM/SIGINT shutdown wait). EVERY testable decision lives in the pure
 * `entrypoint-wiring.ts` (`buildBootDeps`/`runMain`) so the suite is
 * deterministic with no real process. There is NO new logic here.
 *
 * Lifecycle (delegated to runMain — see entrypoint-wiring.ts):
 *   loadConfig(process.env)  — value-free fail-fast BEFORE any resource
 *   → buildBootDeps           — Hetzner Cloud + DNS LIVE (real HttpClient +
 *                               configured token + real base URL); Docker/WG/
 *                               restic from the SSH transport factory
 *   → startServer             — server.ts (6.6): REST listening + MCP +
 *                               periodic reconciler + SIGTERM/SIGINT handlers,
 *                               all-or-nothing boot
 *   → await shutdown signal → ONE idempotent graceful server.stop()
 *                               (releases advisory locks + pool; in-flight
 *                               cycle bounded by the 6.3 cycle timeout; never
 *                               killed mid-mutation; never fail-delete)
 *   → exit 0 (clean) | exit 1 (value-free boot failure, nothing leaked)
 *
 * THE SSH TRANSPORTS (Task 7.2, NOW WIRED). The real Docker/WireGuard/restic
 * transports are the argv-only `createSshTransports` factory (spawns the
 * system `ssh` client — ZERO npm dependency; ssh-transports.ts /
 * ssh-exec.ts). It plugs into 7.1's `EntrypointTransports` seam UNCHANGED
 * (one constant here), so the daemon now has all backends live. If a future
 * caller ever nulls this, `buildBootDeps` still FAILS FAST value-free —
 * never a silent no-op backend (fail-safe).
 *
 * Operator run steps (clean checkout):
 *   1. cp core/.env.example core/.env   (then fill every REQUIRED key)
 *   2. npm --prefix core start          (loads core/.env via the native
 *                                        `tsx --env-file-if-exists=.env`
 *                                        flag — paths are relative to core/
 *                                        since the npm script runs there)
 *      — or the built path —
 *      npm --prefix core run build
 *      node --env-file-if-exists=core/.env core/dist/main.js
 *
 * Both `npm start` and the built command load core/.env the SAME way (Node's
 * native --env-file-if-exists; NO dotenv dependency). `-if-exists` tolerates an
 * absent file (env injected by a process manager / container) WITHOUT erroring;
 * loadConfig() then still fails fast value-free if a required key is unset. The
 * env-file flag does NOT strip surrounding quotes (see core/.env.example) — do
 * not wrap values in quotes. (Node >=20.12.0 — see core/package.json engines.)
 */

import { runMain, type EntrypointTransports } from "./entrypoint-wiring.js";
import { startServer } from "./server.js";
import { createSshTransports } from "./providers/ssh-transports.js";

/**
 * The SSH transport factory — TASK 7.2 (now real). `createSshTransports`
 * builds the argv-only ssh-exec-backed Docker/WireGuard/restic transports
 * (ZERO npm dependency; the `EntrypointTransports` shape is unchanged so it
 * plugs in here as one constant). It needs NO config at construction — 7.1
 * passes the validated config into each per-kind factory at call time, so
 * loadConfig stays runMain's value-free fail-fast (this shell never parses
 * config itself). `buildBootDeps` still fails fast if this is ever absent.
 */
const transports: EntrypointTransports | undefined = createSshTransports();

void runMain({
  env: process.env,
  transports,
  // startServer (server.ts 6.6) listens + installs SIGTERM/SIGINT → its own
  // idempotent graceful stop(); runMain converges on the SAME stop().
  start: (_config, deps) => startServer(process.env, deps),
  log: (line: string): void => {
    // Value-free single-line boot/shutdown notice. The structured pino logger
    // (wired in buildBootDeps) carries the rich, secret-free fields.
    console.error(line);
  },
  exit: (code: number): void => {
    process.exit(code);
  },
}).catch((err: unknown) => {
  // runMain itself never throws (it converts failures to exit codes); this
  // is a last-resort value-free guard so an unexpected throw still exits
  // non-zero WITHOUT echoing any value/secret.
  console.error(
    "bevox daemon: unexpected fatal error during boot (no value echoed)",
  );
  void err;
  process.exit(1);
});
