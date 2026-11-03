/**
 * console/src/api/client.ts
 *
 * Typed REST client for the bevox-hetzner-mcp API.
 * All responses are validated through Zod schemas from contract.ts.
 * postWrite throws the typed ApiError object on error envelopes or HTTP errors.
 */

import { z } from "zod";
import {
  StateSchema,
  type State,
  WriteEnvelopeSchema,
  type WriteEnvelope,
  type ApiError,
  PlanItemSchema,
  type PlanItem,
  StateEventSchema,
  type StateEvent,
  ApprovalSchema,
  type Approval,
  HealthReportSchema,
  type HealthReport,
  SecretSchema,
  type Secret,
  BackupEntrySchema,
  type BackupEntry,
} from "./contract";

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) {
    // Try to parse as error envelope
    const json = await res.json().catch(() => null);
    if (json && typeof json === "object" && "status" in json && json.status === "error" && "error" in json) {
      throw (json as WriteEnvelope).error as ApiError;
    }
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** GET /api/state — returns the full observed state, Zod-validated. */
export async function getState(): Promise<State> {
  const json = await apiFetch("/api/state");
  return StateSchema.parse(json);
}

/** GET /api/diff?source=working|git — returns the plan items for drift/diff. */
export async function getDiff(source?: "working" | "git"): Promise<PlanItem[]> {
  const qs = source ? `?source=${source}` : "";
  const json = await apiFetch(`/api/diff${qs}`);
  return z.array(PlanItemSchema).parse(json);
}

/** GET /api/events — returns state events, optionally filtered. */
export async function getEvents(filters?: {
  actor?: string;
  entity?: string;
  result?: string;
}): Promise<StateEvent[]> {
  const params = new URLSearchParams();
  if (filters?.actor) params.set("actor", filters.actor);
  if (filters?.entity) params.set("entity", filters.entity);
  if (filters?.result) params.set("result", filters.result);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const json = await apiFetch(`/api/events${qs}`);
  return z.array(StateEventSchema).parse(json);
}

/** GET /api/health — returns the health/circuit-breaker status, Zod-validated. */
export async function getHealth(): Promise<HealthReport> {
  const json = await apiFetch("/api/health");
  return HealthReportSchema.parse(json);
}

/** GET /api/approvals — returns pending approvals, Zod-validated. */
export async function getApprovals(): Promise<Approval[]> {
  const json = await apiFetch("/api/approvals");
  return z.array(ApprovalSchema).parse(json);
}

/**
 * GET /api/secrets — returns the list of secret references (name + key count +
 * used_by services). Secret VALUES are intentionally never returned by this
 * endpoint; only reference metadata is transmitted.
 */
export async function getSecrets(): Promise<Secret[]> {
  const json = await apiFetch("/api/secrets");
  return z.array(SecretSchema).parse(json);
}

/**
 * GET /api/backups — returns enriched backup entries (policy + last_run + snapshots).
 * No secret values are ever returned.
 */
export async function getBackups(): Promise<BackupEntry[]> {
  const json = await apiFetch("/api/backups");
  return z.array(BackupEntrySchema).parse(json);
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

/**
 * POST to any write endpoint.
 * - On !res.ok: attempts to parse as WriteEnvelopeSchema; if it parses with
 *   status "error", throws the typed ApiError. Otherwise throws `HTTP <status>`.
 * - On res.ok: parses via WriteEnvelopeSchema; if status "error", throws typed
 *   ApiError; else returns the typed WriteEnvelope.
 * Net effect: well-formed error envelopes (any HTTP status) throw typed ApiError;
 * non-envelope non-2xx responses throw an actionable HTTP error instead of a ZodError.
 */
export async function postWrite(
  path: string,
  body: Record<string, unknown>,
): Promise<WriteEnvelope> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => null);
    let envelope: WriteEnvelope | null = null;
    try {
      if (json !== null) envelope = WriteEnvelopeSchema.parse(json);
    } catch {
      // not a valid envelope — fall through to generic HTTP error
    }
    if (envelope && envelope.status === "error") {
      throw envelope.error as ApiError;
    }
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const envelope = WriteEnvelopeSchema.parse(json);

  if (envelope.status === "error") {
    throw envelope.error as ApiError;
  }

  return envelope;
}
