/**
 * console/src/screens/Backups.tsx
 *
 * Backup Policies screen — route /backups
 * Faithful to prototype/backups.html.
 *
 * Data: useBackups() → GET /api/backups (BackupEntry[]: policy + last_run + snapshots).
 *
 * Per-policy actions:
 *  [Snapshot agora] — NON-destructive:
 *    useWrite() POST /api/backups/:target/snapshot with dry_run:false (default)
 *    → status "applied" (refreshes list). NO ConfirmDestructive. NO approval.
 *    Button disabled while pending. Errors → .notice-error.
 *
 *  [Restore ⚠ destrutivo] — DESTRUCTIVE:
 *    useDryRunApply() canonical flow:
 *      1. Click → ConfirmDestructive (explicit confirm, type entity name)
 *      2. Confirm → POST dry_run:true → plan (DiffView, read-only)
 *      3. Aplicar → POST dry_run:false → pending_approval + approval_id
 *      4. Surface approval_id + <Link to=/approvals>
 *    Button disabled while isPending. Errors → .notice-error.
 *
 * Hard invariants enforced here:
 *  - Restore dry_run:true ALWAYS precedes dry_run:false (via useDryRunApply)
 *  - Snapshot NEVER goes through ConfirmDestructive or approval gate
 *  - pending_approval is surfaced with a Link to /approvals
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useBackups, useWrite } from "../api/query";
import { useDryRunApply } from "../hooks/useDryRunApply";
import { DiffView } from "../components/DiffView";
import { ConfirmDestructive } from "../components/ConfirmDestructive";
import { errorMessage } from "../lib/errors";
import type { BackupEntry, PlanItem } from "../api/contract";

// ---------------------------------------------------------------------------
// Restore phase state machine
// ---------------------------------------------------------------------------

type RestorePhase =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "plan"; plan: PlanItem[] }
  | { phase: "pending"; approvalId: string }
  | { phase: "applied" };

// ---------------------------------------------------------------------------
// BackupPolicyCard — one card per BackupEntry
// ---------------------------------------------------------------------------

interface BackupPolicyCardProps {
  entry: BackupEntry;
}

function BackupPolicyCard({ entry }: BackupPolicyCardProps) {
  // Snapshot: useWrite (non-destructive, no dry_run gate)
  const snapshotWrite = useWrite();
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotDone, setSnapshotDone] = useState(false);

  // Restore: useDryRunApply (destructive, canonical dry_run flow)
  const { isPending: restoreIsPending, run: restoreRun } = useDryRunApply();
  const [restorePhase, setRestorePhase] = useState<RestorePhase>({ phase: "idle" });
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Target label: "volume:pg-data" → strip "volume:" prefix if present for the API path
  const targetLabel = entry.target; // e.g. "volume:pg-data"
  // API path uses the part after ":" if target has the "volume:" prefix
  const targetSlug = entry.target.includes(":")
    ? entry.target.split(":").slice(1).join(":")
    : entry.target;

  // ---------------------------------------------------------------------------
  // Snapshot handler — non-destructive, direct POST, no dry_run
  // ---------------------------------------------------------------------------

  function handleSnapshot() {
    setSnapshotError(null);
    setSnapshotDone(false);
    snapshotWrite.mutate(
      {
        path: `/api/backups/${targetSlug}/snapshot`,
        body: { dry_run: false },
      },
      {
        onSuccess: (env) => {
          if (env.status === "applied") {
            setSnapshotDone(true);
          } else if (env.status === "error") {
            const msg = env.error
              ? env.error.message || env.error.code
              : "Erro desconhecido";
            setSnapshotError(msg);
          } else {
            // "planned" or "pending_approval" must not occur for snapshot (non-destructive)
            setSnapshotError(`[inesperado] snapshot retornou ${env.status}`);
          }
        },
        onError: (err) => {
          setSnapshotError(errorMessage(err));
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Restore phase handlers — destructive, canonical dry_run flow
  // ---------------------------------------------------------------------------

  function handleRestoreClick() {
    setRestoreError(null);
    setSnapshotDone(false);
    setSnapshotError(null);
    setRestorePhase({ phase: "confirm" });
  }

  function handleRestoreConfirmed() {
    // Phase 2: dry_run:true first → show plan
    restoreRun({
      path: `/api/backups/${targetSlug}/restore`,
      body: { dry_run: true },
      onPlanned: (plan) => {
        setRestoreError(null);
        setRestorePhase({ phase: "plan", plan });
      },
      onPending: (approvalId) => {
        setRestoreError(null);
        setRestorePhase({ phase: "pending", approvalId });
      },
      onApplied: () => {
        setRestoreError(null);
        setRestorePhase({ phase: "applied" });
      },
      onError: (msg) => {
        setRestorePhase({ phase: "idle" });
        setRestoreError(msg);
      },
    });
  }

  function handleRestoreApply() {
    // Phase 3: dry_run:false → pending_approval
    restoreRun({
      path: `/api/backups/${targetSlug}/restore`,
      body: { dry_run: false },
      onPlanned: (plan) => {
        setRestoreError(null);
        setRestorePhase({ phase: "plan", plan });
      },
      onPending: (approvalId) => {
        setRestoreError(null);
        setRestorePhase({ phase: "pending", approvalId });
      },
      onApplied: () => {
        setRestoreError(null);
        setRestorePhase({ phase: "applied" });
      },
      onError: (msg) => {
        setRestoreError(msg);
      },
    });
  }

  const snapshotIsPending = snapshotWrite.isPending;

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      {/* Policy header: target name + meta fields */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 15,
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            {targetLabel}
          </div>
          <div
            className="detail-grid"
            style={{ gridTemplateColumns: "repeat(4, auto)", gap: "12px 28px" }}
          >
            <div className="detail-field">
              <div className="detail-label">Schedule</div>
              <div className="detail-value">{entry.schedule}</div>
            </div>
            <div className="detail-field">
              <div className="detail-label">Retention</div>
              <div className="detail-value">{entry.retention}</div>
            </div>
            <div className="detail-field">
              <div className="detail-label">Repo</div>
              <div className="detail-value">{entry.repo}</div>
            </div>
            {entry.last_run && (
              <div className="detail-field">
                <div className="detail-label">Último backup</div>
                <div className="detail-value" style={{ color: "var(--healthy)" }}>
                  {entry.last_run}
                </div>
              </div>
            )}
          </div>
        </div>
        {/* TODO(fase4): derive badge from entry.status when BackupEntry gains a status field */}
        <span className="badge badge-healthy" style={{ alignSelf: "flex-start" }}>
          ok
        </span>
      </div>

      {/* Snapshots list */}
      {entry.snapshots.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="detail-label" style={{ marginBottom: 8 }}>
            Snapshots disponíveis
          </div>
          <div className="snapshot-list">
            {entry.snapshots.map((snap) => (
              <div key={snap.id} className="snap-chip">
                {snap.timestamp} · {snap.size}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Snapshot error notice */}
      {snapshotError && (
        <div className="notice notice-error" style={{ marginTop: 12 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{snapshotError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSnapshotError(null)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss snapshot error"
          >
            ×
          </button>
        </div>
      )}

      {/* Snapshot done notice */}
      {snapshotDone && (
        <div className="notice notice-info" style={{ marginTop: 12 }}>
          <span>✓</span>
          <div style={{ flex: 1 }}>Snapshot criado com sucesso.</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSnapshotDone(false)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss snapshot success"
          >
            ×
          </button>
        </div>
      )}

      {/* Restore error notice */}
      {restoreError && (
        <div className="notice notice-error" style={{ marginTop: 12 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{restoreError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setRestoreError(null)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss restore error"
          >
            ×
          </button>
        </div>
      )}

      {/* Action buttons (idle phase) */}
      {restorePhase.phase === "idle" && (
        <div className="btn-group" style={{ marginTop: 18 }}>
          {/* Snapshot — non-destructive, no approval */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleSnapshot}
            disabled={snapshotIsPending}
            aria-label={`Snapshot agora ${targetLabel}`}
          >
            [Snapshot agora]
          </button>

          {/* Restore — destructive, approval gate */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleRestoreClick}
              disabled={restoreIsPending}
              aria-label={`Restore ${targetLabel}`}
            >
              [Restore ⚠ destrutivo]
            </button>
            <span className="approval-hint">→ Approval Gate</span>
          </span>
        </div>
      )}

      {/* ConfirmDestructive dialog */}
      {restorePhase.phase === "confirm" && (
        <div style={{ marginTop: 18 }}>
          <ConfirmDestructive
            entity={targetLabel}
            action="Restore"
            onConfirm={handleRestoreConfirmed}
            pending={restoreIsPending}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => setRestorePhase({ phase: "idle" })}
            disabled={restoreIsPending}
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Plan shown after dry_run:true */}
      {restorePhase.phase === "plan" && (
        <div style={{ marginTop: 18 }}>
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span>
              Plano de restore (dry-run). Revise antes de aplicar — esta operação é destrutiva.
            </span>
          </div>
          <DiffView items={restorePhase.plan} />
          <div className="btn-group" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleRestoreApply}
              disabled={restoreIsPending}
              aria-label={`Aplicar restore ${targetLabel}`}
            >
              [Aplicar restore]
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRestorePhase({ phase: "idle" })}
              disabled={restoreIsPending}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* pending_approval — surface approval_id + Link to /approvals */}
      {restorePhase.phase === "pending" && (
        <div className="notice notice-warn" style={{ marginTop: 18 }}>
          <span>⏳</span>
          <div>
            <p>
              <strong>pending_approval</strong> — aguardando aprovação antes de executar o restore.
            </p>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              Approval ID: {restorePhase.approvalId}
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

      {/* Applied terminal state */}
      {restorePhase.phase === "applied" && (
        <div className="notice notice-info" style={{ marginTop: 18 }}>
          <span>✓</span>
          <span>Restore aplicado com sucesso.</span>
        </div>
      )}

      {/* Destructive warning (idle only) */}
      {restorePhase.phase === "idle" && (
        <div className="notice notice-warn" style={{ marginTop: 14 }}>
          <span>⚠</span>
          <span>
            <strong>Restore é destrutivo:</strong> sobrescreve o estado atual do volume com o
            snapshot selecionado. Potencial perda de dados. Requer{" "}
            <strong>Approval Gate</strong> antes de executar.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backups screen
// ---------------------------------------------------------------------------

export function Backups() {
  const { data: backups, isLoading, isError } = useBackups();

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Backup Policies (restic)</div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando políticas de backup…</p>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar políticas de backup. Tente recarregar a página.</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && backups && backups.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Nenhuma política de backup configurada.{" "}
          <Link to="/manifest">Configurar no manifesto →</Link>
        </p>
      )}

      {/* Policy cards */}
      {!isLoading && !isError && backups && backups.length > 0 && (
        <>
          {backups.map((entry) => (
            <BackupPolicyCard key={entry.target} entry={entry} />
          ))}
        </>
      )}

      {/* Footer: volumes without backup policy */}
      {!isLoading && !isError && backups && backups.length > 0 && (
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            padding: "12px 0",
            borderTop: "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
          }}
        >
          pg-data-2 — sem política de backup configurada ·{" "}
          <Link to="/manifest">configurar no manifesto →</Link>
        </div>
      )}
    </div>
  );
}
