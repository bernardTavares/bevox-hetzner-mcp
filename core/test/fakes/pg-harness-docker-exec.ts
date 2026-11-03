/**
 * core/test/fakes/pg-harness-docker-exec.ts
 *
 * Tasks 8.1 + 9.1 — shared adapter that translates the migration runner's
 * `psql ... -c <sql>` argv into a `pool.query(sql)` call against the
 * `pg-harness` Postgres. Originally inlined in
 * `core/src/agent/v2/run-migrations.integration.test.ts` (Task 8.1); factored
 * here so Task 9.1's property test reuses it without duplicating the shape.
 *
 * Maps the result back into the `{ exitCode, stdout, stderr }` shape the
 * runner consumes:
 *   - SELECT queries with rowCount > 0  → stdout includes "(N row)" so the
 *     runner's noop detector (`/\(1 row\)/`) matches.
 *   - Multi-statement BEGIN/COMMIT      → executed as a single simple-query
 *     batch; pg aborts the transaction on first failure (matches psql
 *     `ON_ERROR_STOP=1` semantics closely enough for M6 validation).
 *   - Errors                            → exitCode=1, stderr carries the
 *     SQLSTATE in the `SQLSTATE: <code>` form the runner expects.
 *
 * NOTE: this is a TEST FAKE — it bypasses psql entirely and runs SQL via
 * `pool.query`. The argv form (psql -U $POSTGRES_USER -d <db> -c <sql>) is
 * exercised by the unit test 5.11 and end-to-end by the @live test (11.2).
 */

import type pg from "pg";

export type DockerExecFn = (
  containerId: string,
  argv: readonly string[],
  opts?: { readonly signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function makePgHarnessDockerExec(pool: pg.Pool): DockerExecFn {
  return async (
    _containerId: string,
    argv: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const cIdx = argv.indexOf("-c");
    if (cIdx < 0 || cIdx + 1 >= argv.length) {
      return { exitCode: 1, stdout: "", stderr: "no -c arg in argv" };
    }
    const sql = argv[cIdx + 1]!;
    try {
      const result = await pool.query(sql);
      const isSelect = sql.trim().toUpperCase().startsWith("SELECT");
      const rc = result.rowCount ?? 0;
      const stdout =
        isSelect && rc > 0
          ? ` ?column?\n----------\n        1\n(${rc} row)\n`
          : "";
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const sqlstate = e.code ?? "XXXXX";
      return {
        exitCode: 1,
        stdout: "",
        stderr: `ERROR: ${e.message ?? "(no message)"}\nSQLSTATE: ${sqlstate}\n`,
      };
    }
  };
}
