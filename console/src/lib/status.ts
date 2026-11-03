/**
 * console/src/lib/status.ts
 *
 * Shared status predicates — reused across all screens.
 * Import Status from the canonical contract, not from components.
 */

import type { Status } from "../api/contract";

/** Returns true when the row's status is "drift" (read-only, fail-safe sentinel). */
export function isDriftRow(row: { status?: Status }): boolean {
  return row.status === "drift";
}
