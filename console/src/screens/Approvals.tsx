/**
 * console/src/screens/Approvals.tsx
 *
 * Pending Approvals screen — route /approvals
 * Faithful to prototype/approvals.html.
 *
 * Data: useApprovals() → GET /api/approvals (pending items only).
 * Write: useWrite() owned per ApprovalCard for approve/reject decisions.
 *   - [Aprovar] → POST /api/approvals/:id/approve
 *   - [Rejeitar] → POST /api/approvals/:id/reject
 *
 * Per-card isolation: each ApprovalCard owns its own useWrite() mutation and
 * cardError state. Acting on one card only disables THAT card's buttons and
 * shows THAT card's error — other cards remain fully interactive.
 *
 * On success (status "applied"), useWrite invalidates all queries → list refetches.
 * Errors surfaced via .notice-error adjacent to the card that failed.
 * Buttons disabled while write.isPending for that specific card.
 *
 * External link "↗ abrir no Approval Center" is a plain <a> (not a router Link)
 * pointing to the Company OS Approval Center (placeholder href="#").
 *
 * This screen is a READ-ONLY MIRROR + decision actions.
 * It does NOT implement Approval Center business logic.
 */

import { useState } from "react";
import { useApprovals, useWrite } from "../api/query";
import { errorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import type { Approval } from "../api/contract";

// ---------------------------------------------------------------------------
// ApprovalCard — renders a single pending approval with its own mutation
// ---------------------------------------------------------------------------

interface ApprovalCardProps {
  approval: Approval;
}

function ApprovalCard({ approval }: ApprovalCardProps) {
  const [cardError, setCardError] = useState<string | null>(null);
  const write = useWrite();

  const requestedAt = formatDateTime(approval.requested_at);

  function handleApprove() {
    setCardError(null);
    write.mutate(
      { path: `/api/approvals/${approval.id}/approve`, body: {} },
      {
        onError: (err) => {
          setCardError(errorMessage(err));
        },
      },
    );
  }

  function handleReject() {
    setCardError(null);
    write.mutate(
      { path: `/api/approvals/${approval.id}/reject`, body: {} },
      {
        onError: (err) => {
          setCardError(errorMessage(err));
        },
      },
    );
  }

  return (
    <div className="approval-card">
      <div className="apr-id">{approval.id}</div>
      <div className="apr-action">
        <span className="badge badge-error" style={{ marginRight: 8 }}>
          destrutivo
        </span>
        {approval.action} {approval.entity}
      </div>
      <div className="apr-meta">
        por:{" "}
        <span style={{ color: "var(--pending)" }}>{approval.actor}</span>
        &nbsp;·&nbsp;
        TTL:{" "}
        <span style={{ color: "var(--degraded)" }}>{approval.ttl_remaining} restantes</span>
        &nbsp;·&nbsp;
        solicitado: {requestedAt}
      </div>
      <div className="apr-impact">impacto: {approval.impact}</div>

      {/* Per-card error notice */}
      {cardError && (
        <div className="notice notice-error" style={{ marginBottom: 8 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{cardError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setCardError(null)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="btn-group">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleApprove}
          disabled={write.isPending}
          aria-label={`Aprovar ${approval.id}`}
        >
          [Aprovar]
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleReject}
          disabled={write.isPending}
          aria-label={`Rejeitar ${approval.id}`}
        >
          [Rejeitar]
        </button>
        <a
          href="#"
          className="apr-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Abrir no Approval Center"
        >
          ↗ abrir no Approval Center
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals screen — owns only query state, no write/writeError
// ---------------------------------------------------------------------------

export function Approvals() {
  const {
    data: approvals,
    isLoading,
    isError: queryError,
  } = useApprovals();

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const pendingCount = approvals?.length ?? 0;

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">
        Pending Approvals
        {approvals !== undefined && (
          <span
            className="badge badge-degraded"
            style={{ fontSize: 13, padding: "4px 10px", marginLeft: 12 }}
          >
            {pendingCount} pendentes
          </span>
        )}
      </div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando aprovações…</p>
      )}

      {/* Query error state */}
      {queryError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar aprovações. Tente recarregar a página.</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !queryError && approvals && approvals.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Sem aprovações pendentes no momento.
        </p>
      )}

      {/* Approval cards */}
      {!isLoading && !queryError && approvals && approvals.length > 0 && (
        <>
          {approvals.map((approval: Approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
            />
          ))}

          {/* TTL warning notice — faithful to prototype */}
          <div className="notice notice-warn" style={{ marginTop: 16 }}>
            <span>⚠</span>
            <span>
              Aprovações com TTL expirado são automaticamente rejeitadas. Operações
              destrutivas nunca são executadas sem aprovação explícita dentro do TTL.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
