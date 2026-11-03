/**
 * console/src/lib/errors.ts
 *
 * Shared error-formatting helpers for screens that handle WriteEnvelope errors
 * and raw mutation errors.
 */

import type { ApiError } from "../api/contract";

/**
 * Extract a human-readable message from an unknown error value.
 * Handles ApiError objects, plain Error objects, and strings.
 */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    if ("message" in err) return String((err as ApiError).message);
    if ("code" in err) return String((err as ApiError).code);
  }
  if (typeof err === "string") return err;
  return "Erro desconhecido";
}

/**
 * Extract the error code from an unknown error value, if present.
 */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as ApiError).code);
  }
  return undefined;
}
