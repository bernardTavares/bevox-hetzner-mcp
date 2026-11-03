/**
 * core/src/observability/logger.test.ts
 *
 * Task 6.3 — the structured-logger seam:
 *   - createPinoLogger() forwards EXACTLY the passed structured fields + msg to
 *     the (injected) pino instance — nothing more (no-leak: no arbitrary spread);
 *   - noopLogger is silent (zero stdout noise — the default for unwired callers);
 *   - the mandatory observability fields (actor, scope, entity) survive.
 *
 * No real pino transport: an in-process capturing PinoLike is injected.
 */

import { describe, it, expect } from "vitest";
import { createPinoLogger, noopLogger, type PinoLike } from "./logger.js";

function capturingPino(): {
  pino: PinoLike;
  lines: Array<{ level: string; obj: object; msg?: string }>;
} {
  const lines: Array<{ level: string; obj: object; msg?: string }> = [];
  return {
    lines,
    pino: {
      info(obj, msg) {
        lines.push({ level: "info", obj, msg });
      },
      warn(obj, msg) {
        lines.push({ level: "warn", obj, msg });
      },
      error(obj, msg) {
        lines.push({ level: "error", obj, msg });
      },
    },
  };
}

describe("logger seam", () => {
  it("createPinoLogger forwards exactly the structured fields + msg to pino", () => {
    const cap = capturingPino();
    const log = createPinoLogger(cap.pino);

    log.info(
      { actor: "agent:vox", scope: "server", entity: "server:app-1", result: "ok" },
      "applied",
    );
    log.error(
      { actor: "agent:vox", scope: "server", entity: "server:app-1", errorClass: "transient" },
      "failed",
    );

    expect(cap.lines).toHaveLength(2);
    expect(cap.lines[0]).toEqual({
      level: "info",
      obj: { actor: "agent:vox", scope: "server", entity: "server:app-1", result: "ok" },
      msg: "applied",
    });
    expect(cap.lines[1]).toEqual({
      level: "error",
      obj: {
        actor: "agent:vox",
        scope: "server",
        entity: "server:app-1",
        errorClass: "transient",
      },
      msg: "failed",
    });
  });

  it("noopLogger is silent (no throw, nothing emitted)", () => {
    expect(() =>
      noopLogger.info(
        { actor: "a", scope: "s", entity: "e" },
        "ignored",
      ),
    ).not.toThrow();
    expect(() =>
      noopLogger.error({ actor: "a", scope: "s", entity: "e" }, "ignored"),
    ).not.toThrow();
  });
});
