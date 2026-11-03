import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Absolute path to the env-loader setup file so vitest resolves it correctly
// regardless of which project's working directory is active.
const setupEnv = join(__dirname, "test/setup-env.ts");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // setupFiles at the root level ensures DATABASE_URL_TEST is loaded from
    // core/.env before any test file runs (unit or live). It is a no-op when
    // the var is already set (CI sets it directly).
    setupFiles: [setupEnv],
    // Global serial execution — required because multiple test files (db.test.ts,
    // observed-store.test.ts, working-store.test.ts) all perform DDL against the
    // shared test Postgres container. Concurrent schema resets (DROP/CREATE) race
    // and cause intermittent "no schema selected" failures. fileParallelism:false
    // at the root level guarantees that ALL projects' files run serially, which
    // is safe here because the test suite runs in < 2 s even serially.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["**/*.live.test.ts"],
          environment: "node",
          globals: true,
          // Serialize DB test files so concurrent resetSchema DROP SCHEMA calls
          // do not race on the shared test container (Tasks 1.5/1.6/1.7 add more).
          // Tests within a single file still run concurrently.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "live",
          include: ["**/*.live.test.ts"],
          environment: "node",
          globals: true,
        },
      },
    ],
  },
});
