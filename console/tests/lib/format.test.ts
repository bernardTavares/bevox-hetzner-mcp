/**
 * console/tests/lib/format.test.ts
 *
 * Unit tests for console/src/lib/format.ts
 */

import { describe, it, expect } from "vitest";
import { formatDateTime } from "../../src/lib/format";

describe("formatDateTime", () => {
  it("formats a Z (UTC) timestamp to YYYY-MM-DD HH:MM in UTC", () => {
    expect(formatDateTime("2026-05-17T14:02:00Z")).toBe("2026-05-17 14:02");
  });

  it("formats a +00:00 offset timestamp correctly in UTC", () => {
    // +00:00 is UTC; result must equal Z equivalent
    expect(formatDateTime("2026-05-17T14:02:00+00:00")).toBe("2026-05-17 14:02");
  });

  it("formats a positive UTC offset timestamp in UTC (not local)", () => {
    // 2026-05-17T16:02:00+02:00 == 2026-05-17T14:02:00Z in UTC
    expect(formatDateTime("2026-05-17T16:02:00+02:00")).toBe("2026-05-17 14:02");
  });

  it("pads single-digit month, day, hour, minute with leading zeros", () => {
    expect(formatDateTime("2026-01-05T03:07:00Z")).toBe("2026-01-05 03:07");
  });

  it("returns original string for invalid ISO input", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("returns original string for empty string", () => {
    expect(formatDateTime("")).toBe("");
  });
});
