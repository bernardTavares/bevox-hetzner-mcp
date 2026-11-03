/**
 * console/src/screens/PlanApply.tsx
 *
 * Plan / Apply screen — route /apply
 * Faithful to prototype/plan-apply.html.
 *
 * Hard invariants:
 *  - Drift item → shown read-only, NO destroy/remove control (enforced by DiffView)
 *  - dry_run:true FIRST (POST /api/apply with dry_run:true shows planned result),
 *    then explicit Confirm Apply issues dry_run:false → pending_approval surfaced
 *
 * Data: useDiff(source) with source toggle (working|git). Write: useDryRunApply().
 * Reuses: DiffView.
 * Pattern: CANONICAL WRITE PATTERN from EntityDetail — discriminated-union phase
 * state machine; in-flight-disable; full-envelope handling; error surfaced via
 * dismissible notice-error.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useDiff } from "../api/query";
import { useDryRunApply } from "../hooks/useDryRunApply";
import { DiffView } from "../components/DiffView";
import type { PlanItem } from "../api/contract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiffSource = "working" | "git";

/**
 * Discriminated-union phase state machine (canonical write pattern).
 *
 *  idle       → user sees the diff + [Re-plan] [Plan (dry-run)] buttons
 *  planned    → dry_run:true was sent; plan result shown + [Apply → Approval Gate] [Cancel]
 *  pending    → dry_run:false was sent; pending_approval + approval_id surfaced
 *  applied    → (edge case) status:applied received; show success notice
 */
type ApplyPhase =
  | { phase: "idle" }
  | { phase: "planned"; plan: PlanItem[] }
  | { phase: "pending"; approvalId: string }
  | { phase: "applied" };

// ---------------------------------------------------------------------------
// PlanApply screen
// ---------------------------------------------------------------------------

export function PlanApply() {
  const [source, setSource] = useState<DiffSource>("working");
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>({ phase: "idle" });
  const [applyError, setApplyError] = useState<string | null>(null);

  const { isPending, run } = useDryRunApply();

  // useDiff — GET /api/diff?source=working|git
  const {
    data: diffItems,
    isLoading: diffLoading,
    isError: diffError,
    refetch: refetchDiff,
  } = useDiff(source);

  // -------------------------------------------------------------------------
  // Re-plan: invalidate/refetch the diff query
  // -------------------------------------------------------------------------

  function handleReplan() {
    setApplyPhase({ phase: "idle" });
    setApplyError(null);
    void refetchDiff();
  }

  // -------------------------------------------------------------------------
  // Source toggle helpers — reset phase + error when switching source
  // -------------------------------------------------------------------------

  function switchSource(next: DiffSource) {
    setSource(next);
    setApplyPhase({ phase: "idle" });
    setApplyError(null);
  }

  // -------------------------------------------------------------------------
  // Plan (dry-run): dry_run:true FIRST — shows planned result
  // Fix 1: button is labelled "Plan (dry-run)" (was misleadingly labelled Apply)
  // -------------------------------------------------------------------------

  function handlePlanClick() {
    setApplyError(null);
    run({
      path: "/api/apply",
      body: { source, dry_run: true },
      onPlanned: (plan) => setApplyPhase({ phase: "planned", plan }),
      onPending: (approvalId) => setApplyPhase({ phase: "pending", approvalId }),
      onApplied: () => setApplyPhase({ phase: "applied" }),
      onError: (msg) => setApplyError(msg),
    });
  }

  // -------------------------------------------------------------------------
  // Apply → Approval Gate: dry_run:false → pending_approval
  // Fix 1: confirm button is labelled "Apply → Approval Gate"
  // -------------------------------------------------------------------------

  function handleConfirmApply() {
    setApplyError(null);
    run({
      path: "/api/apply",
      body: { source, dry_run: false },
      onPlanned: (plan) => setApplyPhase({ phase: "planned", plan }),
      onPending: (approvalId) => setApplyPhase({ phase: "pending", approvalId }),
      onApplied: () => setApplyPhase({ phase: "applied" }),
      onError: (msg) => {
        setApplyPhase({ phase: "idle" });
        setApplyError(msg);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Cancel planned phase → back to idle
  // -------------------------------------------------------------------------

  function handleCancelPlan() {
    setApplyPhase({ phase: "idle" });
    setApplyError(null);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Apply Manifest</div>

      {/* Source toggle + label */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          Diff desejado × observado
        </span>
        <div className="tabs" style={{ marginBottom: 0, borderBottom: "none" }}>
          <button
            type="button"
            className={`tab${source === "git" ? " active" : ""}`}
            onClick={() => switchSource("git")}
            disabled={isPending}
          >
            git
          </button>
          <button
            type="button"
            className={`tab${source === "working" ? " active" : ""}`}
            onClick={() => switchSource("working")}
            disabled={isPending}
          >
            working
          </button>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
          source: {source}
        </span>
      </div>

      {/* Diff section */}
      <div className="section">
        <div className="section-title" style={{ marginBottom: 10 }}>
          Plano de mudanças
        </div>

        {diffLoading && <p>Carregando diff…</p>}

        {diffError && (
          <div className="notice notice-error">
            <span>✕</span>
            <span>Erro ao carregar diff. Tente Re-plan.</span>
          </div>
        )}

        {!diffLoading && !diffError && diffItems && diffItems.length > 0 && (
          <DiffView items={diffItems} />
        )}

        {!diffLoading && !diffError && diffItems && diffItems.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Sem diferenças — manifesto sincronizado com o estado observado.
          </p>
        )}
      </div>

      {/* Error feedback — dismissible notice-error */}
      {applyError && (
        <div className="notice notice-error" style={{ marginBottom: 12 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{applyError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setApplyError(null)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Phase: idle — show action buttons */}
      {applyPhase.phase === "idle" && (
        <>
          <div className="btn-group" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleReplan}
              disabled={isPending || diffLoading}
              aria-label="Re-plan"
            >
              [Re-plan]
            </button>
            {/* Fix 1: first button is now "Plan (dry-run)" — it sends dry_run:true */}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePlanClick}
              disabled={isPending || diffLoading}
              aria-label="Plan (dry-run)"
            >
              Plan (dry-run)
            </button>
          </div>

          <div className="notice notice-warn" style={{ marginTop: 16 }}>
            <span>⚠</span>
            <span>
              O apply requer aprovação antes de executar. Nenhuma operação
              destrutiva ou de custo é executada sem aprovação explícita.
            </span>
          </div>
        </>
      )}

      {/* Phase: planned — show the dry-run plan + Apply → Approval Gate / Cancel */}
      {applyPhase.phase === "planned" && (
        <div>
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span>
              Plano de apply (dry-run). Revise antes de confirmar. Nenhuma
              mudança foi aplicada ainda.
            </span>
          </div>

          <div className="section">
            {/* Fix 4: renamed section title from "Plano de apply (dry-run)" to "Mudanças previstas" */}
            <div className="section-title" style={{ marginBottom: 8 }}>
              Mudanças previstas
            </div>
            <DiffView items={applyPhase.plan} />
          </div>

          <div className="btn-group" style={{ marginTop: 12 }}>
            {/*
              Fix 1: confirm button is now "Apply → Approval Gate" — it sends dry_run:false.
              The approval-hint affordance lives here (on the button that actually reaches the gate).
            */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmApply}
                disabled={isPending}
                aria-label="Apply → Approval Gate"
              >
                Apply → Approval Gate
              </button>
              <span className="approval-hint">→ Approval Gate</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCancelPlan}
              disabled={isPending}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Phase: pending — pending_approval surfaced with approval_id */}
      {applyPhase.phase === "pending" && (
        <div className="notice notice-warn">
          <span>⏳</span>
          <div>
            <p>
              <strong>pending_approval</strong> — aguardando aprovação antes de
              executar o apply. Nenhuma mudança foi aplicada ainda.
            </p>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              Approval ID: {applyPhase.approvalId}
            </p>
            <Link
              to="/approvals"
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
            >
              Ver Approval Center →
            </Link>
          </div>
        </div>
      )}

      {/* Phase: applied — edge case terminal state */}
      {applyPhase.phase === "applied" && (
        <div className="notice notice-info">
          <span>✓</span>
          <span>Apply aplicado com sucesso.</span>
        </div>
      )}
    </div>
  );
}
