/**
 * core/src/domain/migrations-v2.ts
 *
 * Migration runner input schema (spec §1.2 of
 * `docs/specs/2026-05-28-migration-runner-v1.md`).
 *
 * `RunMigrationsInput` is the agent-facing payload for the
 * `run_migrations` MCP tool. It carries ZERO secrets — the DB password
 * lives in the target container's env (set at deploy time by the
 * SecretResolver) and is consumed via `psql -U $POSTGRES_USER` from
 * inside the container. The daemon never sees nor transmits a password
 * for this path.
 *
 * `MigrationReportEntry` / `MigrationReport` are the result schemas
 * returned by the runner. The entry is `.strict()` so accidental
 * inclusion of `sql` / `error_message` (which could leak via the
 * report surface) fails parsing rather than silently propagating.
 */

import { z } from "zod";

export const RunMigrationsInput = z.object({
  /** Service name in desired state (the container running Postgres). */
  target_service: z.string().min(1),
  /** Postgres database name (passed to `psql -d`). */
  database: z.string().min(1),
  /** Ordered batch — applied in array order; stops at first failure. */
  migrations: z
    .array(
      z.object({
        filename: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]+\.sql$/, "filename must be <safe>.sql"),
        sql: z.string().min(1).max(1024 * 1024), // 1 MB cap per migration
      }),
    )
    .min(1)
    .max(100), // batch cap
});

export type RunMigrationsInput = z.infer<typeof RunMigrationsInput>;

export const MigrationReportEntry = z
  .object({
    filename: z.string(),
    result: z.enum(["ok", "noop", "error"]),
    duration_ms: z.number().int().min(0).optional(),
    error_code: z
      .enum([
        "syntax",
        "constraint",
        "timeout",
        "container_exited",
        "permission",
        "unknown",
      ])
      .optional(),
  })
  .strict();

export type MigrationReportEntry = z.infer<typeof MigrationReportEntry>;

export const MigrationReport = z.object({
  applied: z.array(MigrationReportEntry),
});

export type MigrationReport = z.infer<typeof MigrationReport>;
