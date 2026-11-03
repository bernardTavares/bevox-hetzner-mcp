/**
 * console/src/components/StatusBadge.tsx
 *
 * Renders a soft-colored status pill matching the prototype design.
 * Text is always visible — not color-only — for accessibility.
 */

import type { Status } from "../api/contract.js";

interface StatusBadgeProps {
  status: Status;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge-${status}`} aria-label={`Status: ${status}`}>
      {status}
    </span>
  );
}
