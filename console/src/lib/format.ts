/**
 * console/src/lib/format.ts
 *
 * Shared formatting utilities for the Console UI.
 * All datetime output is in UTC — audit-correct and prototype-matching.
 */

/**
 * Format an ISO 8601 timestamp to "YYYY-MM-DD HH:MM" in UTC.
 * Falls back to the original string if parsing fails.
 */
export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}
