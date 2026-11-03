import { describe, it, expect } from "vitest";
import {
  MigrationReport,
  MigrationReportEntry,
  RunMigrationsInput,
} from "./migrations-v2.js";

describe("RunMigrationsInput", () => {
  it("rejects empty target_service", () => {
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "",
        database: "db",
        migrations: [{ filename: "001_x.sql", sql: "SELECT 1" }],
      }),
    ).toThrow(/target_service/);
  });

  it("rejects filename without .sql or with unsafe chars", () => {
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "../etc/passwd", sql: "x" }],
      }),
    ).toThrow();
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001 x.sql", sql: "x" }], // space
      }),
    ).toThrow();
  });

  it("rejects sql > 1 MB", () => {
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "a".repeat(1024 * 1024 + 1) }],
      }),
    ).toThrow();
  });

  it("rejects batch > 100 migrations", () => {
    const m = Array(101).fill({ filename: "x.sql", sql: "x" });
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "pg",
        database: "db",
        migrations: m,
      }),
    ).toThrow();
  });

  it("accepts a 1-migration batch with safe filename + sql at 1 MB", () => {
    expect(() =>
      RunMigrationsInput.parse({
        target_service: "pg",
        database: "db",
        migrations: [
          { filename: "001_init.sql", sql: "a".repeat(1024 * 1024) },
        ],
      }),
    ).not.toThrow();
  });
});

describe("MigrationReportEntry", () => {
  it("accepts ok/noop/error result enums", () => {
    for (const r of ["ok", "noop", "error"] as const) {
      expect(() =>
        MigrationReportEntry.parse({ filename: "x.sql", result: r }),
      ).not.toThrow();
    }
  });
  it("rejects unknown result", () => {
    expect(() =>
      MigrationReportEntry.parse({ filename: "x.sql", result: "skipped" }),
    ).toThrow();
  });
  it("accepts the 6 error_code enum values", () => {
    for (const c of [
      "syntax",
      "constraint",
      "timeout",
      "container_exited",
      "permission",
      "unknown",
    ] as const) {
      expect(() =>
        MigrationReportEntry.parse({
          filename: "x.sql",
          result: "error",
          error_code: c,
        }),
      ).not.toThrow();
    }
  });
  it("rejects sql/error_message fields (NEVER part of the report)", () => {
    expect(() =>
      MigrationReportEntry.parse({
        filename: "x.sql",
        result: "ok",
        sql: "SELECT 1",
      } as unknown),
    ).toThrow();
    expect(() =>
      MigrationReportEntry.parse({
        filename: "x.sql",
        result: "error",
        error_message: "boom",
      } as unknown),
    ).toThrow();
  });
});

describe("MigrationReport", () => {
  it("wraps applied[]", () => {
    const r = MigrationReport.parse({
      applied: [
        { filename: "1.sql", result: "ok", duration_ms: 5 },
        { filename: "2.sql", result: "noop" },
      ],
    });
    expect(r.applied).toHaveLength(2);
  });
});
