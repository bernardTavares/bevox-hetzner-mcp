/**
 * console/src/api/query.ts
 *
 * TanStack Query v5 hooks wrapping the typed REST client.
 *
 * Note: The hook for GET /api/state is exported as `useStateQuery` (not
 * `useState`) to avoid a name collision with React's built-in useState hook.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getState,
  getDiff,
  getEvents,
  getHealth,
  getApprovals,
  getSecrets,
  getBackups,
  postWrite,
} from "./client";
import type { WriteEnvelope } from "./contract";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * Canonical query key factory for all API queries.
 *
 * TanStack Query v5 compares query keys by deep structural equality (not
 * reference equality), so passing inline object literals as filter arguments
 * (e.g. `queryKeys.events({ actor: "vox" })`) is safe and does NOT cause
 * spurious cache misses or duplicate fetches.
 */
export const queryKeys = {
  state: ["state"] as const,
  diff: (source?: "working" | "git") => ["diff", source] as const,
  events: (filters?: { actor?: string; entity?: string; result?: string }) =>
    ["events", filters] as const,
  health: ["health"] as const,
  approvals: ["approvals"] as const,
  secrets: ["secrets"] as const,
  backups: ["backups"] as const,
};

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

/**
 * Hook for GET /api/state.
 * Named useStateQuery (not useState) to avoid collision with React's useState.
 */
export function useStateQuery() {
  return useQuery({
    queryKey: queryKeys.state,
    queryFn: getState,
  });
}

export function useDiff(source?: "working" | "git") {
  return useQuery({
    queryKey: queryKeys.diff(source),
    queryFn: () => getDiff(source),
  });
}

export function useEvents(filters?: { actor?: string; entity?: string; result?: string }) {
  return useQuery({
    queryKey: queryKeys.events(filters),
    queryFn: () => getEvents(filters),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
  });
}

export function useApprovals() {
  return useQuery({
    queryKey: queryKeys.approvals,
    queryFn: getApprovals,
  });
}

/** Hook for GET /api/secrets — returns secret references (name/keys/used_by only; no values). */
export function useSecrets() {
  return useQuery({
    queryKey: queryKeys.secrets,
    queryFn: getSecrets,
  });
}

/** Hook for GET /api/backups — returns enriched backup entries (policy + last_run + snapshots). */
export function useBackups() {
  return useQuery({
    queryKey: queryKeys.backups,
    queryFn: getBackups,
  });
}

// ---------------------------------------------------------------------------
// Write mutation
// ---------------------------------------------------------------------------

export interface WriteVariables {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Mutation hook for any write operation.
 * Invalidates ALL queries only when the write actually mutated server state
 * (status "applied" or "pending_approval"). For dry-run ("planned") or
 * "error" envelopes, no invalidation is triggered — the server state did not
 * change, so a refetch would be a no-op and could mask real state changes.
 */
export function useWrite() {
  const queryClient = useQueryClient();
  return useMutation<WriteEnvelope, unknown, WriteVariables>({
    mutationFn: ({ path, body }) => postWrite(path, body),
    onSuccess: (envelope) => {
      if (
        envelope.status === "applied" ||
        envelope.status === "pending_approval"
      ) {
        queryClient.invalidateQueries();
      }
    },
  });
}
