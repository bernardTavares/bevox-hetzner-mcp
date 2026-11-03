/**
 * console/src/hooks/useDryRunApply.ts
 *
 * Encapsulates the shared mutation mechanics for any dry-run → apply flow:
 *   - Wraps useWrite()
 *   - Exhaustively dispatches WriteEnvelope status to caller-provided callbacks
 *   - Formats errors consistently via lib/errors.ts
 *   - Exposes isPending so screens can disable buttons uniformly
 *
 * Screens KEEP their own phase useState and all JSX/render logic.
 * This hook only owns the mutation + envelope dispatch mechanics.
 */

import { useWrite } from "../api/query";
import { errorMessage, errorCode } from "../lib/errors";
import type { PlanItem } from "../api/contract";

export interface DryRunApplyOpts {
  path: string;
  body: Record<string, unknown>;
  onPlanned: (plan: PlanItem[]) => void;
  onPending: (approvalId: string) => void;
  onApplied: () => void;
  onError: (msg: string, code?: string) => void;
}

export interface UseDryRunApplyResult {
  isPending: boolean;
  run(opts: DryRunApplyOpts): void;
}

export function useDryRunApply(): UseDryRunApplyResult {
  const write = useWrite();

  function run(opts: DryRunApplyOpts): void {
    const { path, body, onPlanned, onPending, onApplied, onError } = opts;

    write.mutate(
      { path, body },
      {
        onSuccess: (env) => {
          switch (env.status) {
            case "planned":
              onPlanned(env.plan ?? []);
              break;
            case "pending_approval":
              onPending(env.approval_id ?? "(sem ID)");
              break;
            case "applied":
              onApplied();
              break;
            case "error":
              onError(
                env.error
                  ? `[${env.error.code}] ${env.error.message}`
                  : "Erro desconhecido",
                env.error?.code,
              );
              break;
            default: {
              // Exhaustive check — TypeScript narrows never here
              const _exhaustive: never = env.status;
              onError(`Status inesperado: ${String(_exhaustive)}`);
            }
          }
        },
        onError: (err) => {
          const code = errorCode(err);
          const msg = errorMessage(err);
          onError(code ? `[${code}] ${msg}` : msg, code);
        },
      },
    );
  }

  return { isPending: write.isPending, run };
}
