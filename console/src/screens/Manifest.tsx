/**
 * console/src/screens/Manifest.tsx
 *
 * Manifest / Estado Desejado screen — route /manifest
 * Faithful to prototype/manifest.html.
 *
 * Hard invariants:
 *  - Drift item → shown read-only, NO destroy/remove control (enforced by DiffView)
 *  - Promote: dry_run:true FIRST (planned phase shown) BEFORE any dry_run:false
 *    → pending_approval surfaced (approval_id + Approval Center routing)
 *
 * Data: useDiff(source) with tab toggle (working|git). Write: useDryRunApply().
 * Reuses: DiffView, Link.
 * Pattern: CANONICAL WRITE PATTERN — discriminated-union phase state machine;
 * in-flight-disable; full-envelope handling; errors via notice-error.
 *
 * YAGNI: Editing the manifest is not persisted to a backend in v1.
 * "Validar" is a coarse client-side check (non-empty YAML area).
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

type ManifestSource = "working" | "git";

/**
 * Discriminated-union phase state machine (canonical write pattern).
 *
 *  idle       → user sees the manifest YAML + [Validar] [Promover working→git] buttons
 *  planned    → dry_run:true was sent; plan result shown + [Confirmar Promoção → Approval Gate] [Cancelar]
 *  pending    → dry_run:false was sent; pending_approval + approval_id surfaced
 *  applied    → (edge case) status:applied received; show success notice
 */
type PromotePhase =
  | { phase: "idle" }
  | { phase: "planned"; plan: PlanItem[] }
  | { phase: "pending"; approvalId: string }
  | { phase: "applied" };

// ---------------------------------------------------------------------------
// Canonical desired-state manifest (displayed per prototype)
// Faithfully reproduced from prototype/manifest.html.
// YAGNI: not editable/persistable to backend in v1.
// ---------------------------------------------------------------------------

const WORKING_MANIFEST = `# bevox-hetzner-mcp — manifest (working)
# editado por: vox  |  2026-05-17 13:45  |  diverge de git em 2 entidades (inert — badge calculado da API)

servers:
  - name: bevox-app-1
    type: cx32
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    labels:
      app: harness

  - name: bevox-app-2
    type: cx32
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    labels:
      app: harness

  - name: bevox-db-1
    type: cx42
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    volumes: [pg-data]

services:
  - name: bevox-harness
    image: registry/bevox-harness:v12
    replicas: 2
    ports:
      - "8080:80"
    env_from:
      - secret: bevox-harness
    servers: [bevox-app-1, bevox-app-2]

  - name: bevox-backend
    image: registry/bevox-backend:v8   # working: v7→v8 (diverge de git)
    replicas: 2                          # working: 1→2  (diverge de git)
    ports:
      - "3000:3000"
    env_from:
      - secret: bevox-backend
    servers: [bevox-app-1, bevox-app-2]

volumes:
  - name: pg-data
    size: 50Gi
    server: bevox-db-1

  - name: pg-data-2    # novo — não existe em git
    size: 50Gi
    server: bevox-db-1

backups:
  - volume: pg-data
    schedule: "0 3 * * *"
    retention: 14d
    repo: restic:hetzner-backup`;

const GIT_MANIFEST = `# bevox-hetzner-mcp — manifest (git / canônico)
# último commit: 2026-05-16 20:00  |  commit: abc1234

servers:
  - name: bevox-app-1
    type: cx32
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    labels:
      app: harness

  - name: bevox-app-2
    type: cx32
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    labels:
      app: harness

  - name: bevox-db-1
    type: cx42
    location: nbg1
    image: ubuntu-24.04
    ssh_keys: [bevox-ops]
    networks: [bevox-priv]
    volumes: [pg-data]

services:
  - name: bevox-harness
    image: registry/bevox-harness:v12
    replicas: 2
    ports:
      - "8080:80"
    env_from:
      - secret: bevox-harness
    servers: [bevox-app-1, bevox-app-2]

  - name: bevox-backend
    image: registry/bevox-backend:v7   # git: versão canônica
    replicas: 1
    ports:
      - "3000:3000"
    env_from:
      - secret: bevox-backend
    servers: [bevox-app-1, bevox-app-2]

volumes:
  - name: pg-data
    size: 50Gi
    server: bevox-db-1

backups:
  - volume: pg-data
    schedule: "0 3 * * *"
    retention: 14d
    repo: restic:hetzner-backup`;

// ---------------------------------------------------------------------------
// Manifest screen
// ---------------------------------------------------------------------------

export function Manifest() {
  const [source, setSource] = useState<ManifestSource>("working");
  const [promotePhase, setPromotePhase] = useState<PromotePhase>({ phase: "idle" });
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

  const { isPending, run } = useDryRunApply();

  // useDiff — GET /api/diff?source=working|git (shows working×git divergence)
  const {
    data: diffItems,
    isLoading: diffLoading,
    isError: diffError,
  } = useDiff(source);

  // Count of divergences (non-drift items, i.e. actual differences)
  const divergenceCount = diffItems
    ? diffItems.filter((item) => item.op !== "drift").length
    : 0;

  // -------------------------------------------------------------------------
  // Source tab switch — reset promote phase + error
  // -------------------------------------------------------------------------

  function switchSource(next: ManifestSource) {
    setSource(next);
    setPromotePhase({ phase: "idle" });
    setPromoteError(null);
    setValidateMsg(null);
  }

  // -------------------------------------------------------------------------
  // Validar — coarse client-side check (YAGNI: no backend validate endpoint)
  // Honest: clearly labeled as client-side preview, not a real backend validate.
  // -------------------------------------------------------------------------

  function handleValidar() {
    const content = source === "working" ? WORKING_MANIFEST : GIT_MANIFEST;
    if (!content.trim()) {
      setValidateMsg("erro: manifesto vazio.");
      return;
    }
    // Coarse structural check: must contain at least one section keyword
    if (!/^(servers|services|volumes|backups|dns):/m.test(content)) {
      setValidateMsg("erro: manifesto inválido — nenhuma seção reconhecida.");
      return;
    }
    setValidateMsg(`Manifesto ${source} válido (verificação client-side: estrutura OK).`);
  }

  // -------------------------------------------------------------------------
  // Promote step 1: dry_run:true → shows promotion plan
  // -------------------------------------------------------------------------

  function handlePromoteClick() {
    setPromoteError(null);
    setValidateMsg(null);
    run({
      path: "/api/apply",
      body: { source: "working", promote: true, dry_run: true },
      onPlanned: (plan) => setPromotePhase({ phase: "planned", plan }),
      onPending: (approvalId) => setPromotePhase({ phase: "pending", approvalId }),
      onApplied: () => setPromotePhase({ phase: "applied" }),
      onError: (msg) => setPromoteError(msg),
    });
  }

  // -------------------------------------------------------------------------
  // Promote step 2: dry_run:false → pending_approval
  // -------------------------------------------------------------------------

  function handleConfirmPromote() {
    setPromoteError(null);
    run({
      path: "/api/apply",
      body: { source: "working", promote: true, dry_run: false },
      onPlanned: (plan) => setPromotePhase({ phase: "planned", plan }),
      onPending: (approvalId) => setPromotePhase({ phase: "pending", approvalId }),
      onApplied: () => setPromotePhase({ phase: "applied" }),
      onError: (msg) => {
        setPromotePhase({ phase: "idle" });
        setPromoteError(msg);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Cancel planned promote → back to idle
  // -------------------------------------------------------------------------

  function handleCancelPromote() {
    setPromotePhase({ phase: "idle" });
    setPromoteError(null);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const manifestContent = source === "working" ? WORKING_MANIFEST : GIT_MANIFEST;

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Manifest — Estado Desejado</div>

      {/* Source tabs */}
      <div className="tabs">
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
          working *
        </button>
      </div>

      {/* Divergence warning — always shown, links to /apply */}
      {diffLoading ? (
        <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Carregando diff…
        </p>
      ) : diffError ? (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <span>✕</span>
          <span>Erro ao carregar diff. Verifique a conexão com a API.</span>
        </div>
      ) : (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          <span>⚠</span>
          <span>
            working diverge de git em{" "}
            <strong>{divergenceCount} entidade{divergenceCount !== 1 ? "s" : ""}</strong>
            {" — "}
            <Link to="/apply">ver diff →</Link>
          </span>
        </div>
      )}

      {/* YAML manifest display area (read-only — YAGNI: no backend persist) */}
      <div className="section" style={{ marginBottom: 16 }}>
        <div className="section-title" style={{ marginBottom: 8 }}>
          Manifesto{" "}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
              fontWeight: 400,
            }}
          >
            ({source})
          </span>
        </div>
        <textarea
          className="code-area"
          readOnly
          rows={28}
          value={manifestContent}
          style={{ width: "100%", resize: "vertical" }}
          aria-label={`Manifesto ${source}`}
        />
      </div>

      {/* Validar feedback */}
      {validateMsg && (
        <div
          className={`notice ${validateMsg.startsWith("erro") ? "notice-error" : "notice-info"}`}
          style={{ marginBottom: 12 }}
        >
          <span>{validateMsg.startsWith("erro") ? "✕" : "✓"}</span>
          <div style={{ flex: 1 }}>{validateMsg}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setValidateMsg(null)}
            style={{ padding: "0 6px" }}
            aria-label="Dismiss validation message"
          >
            ×
          </button>
        </div>
      )}

      {/* Promote error feedback */}
      {promoteError && (
        <div className="notice notice-error" style={{ marginBottom: 12 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{promoteError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPromoteError(null)}
            style={{ padding: "0 6px" }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Phase: idle — main action buttons */}
      {promotePhase.phase === "idle" && (
        <>
          <div className="btn-group" style={{ marginTop: 8 }}>
            {/*
              Validar: coarse client-side check.
              Clearly labeled — not a backend validate (honest, no misleading dead-end).
            */}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleValidar}
              disabled={isPending}
              aria-label="Validar"
            >
              [Validar]
            </button>

            {/*
              Promover working→git: canonical dry_run:true first, then dry_run:false.
              Requires Approval Gate — shown on button.
            */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="btn btn-warn"
                onClick={handlePromoteClick}
                disabled={isPending}
                aria-label="Promover working→git (approval)"
              >
                [Promover working→git (approval)]
              </button>
              <span className="approval-hint">→ Approval Gate</span>
            </span>

            <Link
              to="/apply"
              className="btn btn-ghost btn-sm"
            >
              Ver diff →
            </Link>
          </div>
        </>
      )}

      {/* Phase: planned — show promotion plan + Confirmar Promoção / Cancelar */}
      {promotePhase.phase === "planned" && (
        <div>
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span>
              Plano de promoção (dry-run). Revise antes de confirmar. Nenhuma
              mudança foi aplicada ainda.
            </span>
          </div>

          <div className="section" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ marginBottom: 8 }}>
              Mudanças previstas (working→git)
            </div>
            <DiffView items={promotePhase.plan} />
          </div>

          <div className="btn-group" style={{ marginTop: 12 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmPromote}
                disabled={isPending}
                aria-label="Confirmar Promoção → Approval Gate"
              >
                Confirmar Promoção → Approval Gate
              </button>
              <span className="approval-hint">→ Approval Gate</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCancelPromote}
              disabled={isPending}
              aria-label="Cancelar promoção"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Phase: pending — pending_approval surfaced with approval_id */}
      {promotePhase.phase === "pending" && (
        <div className="notice notice-warn">
          <span>⏳</span>
          <div>
            <p>
              <strong>pending_approval</strong> — aguardando aprovação antes de
              promover working→git. Nenhuma mudança foi aplicada ainda.
            </p>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              Approval ID: {promotePhase.approvalId}
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
      {promotePhase.phase === "applied" && (
        <div className="notice notice-info">
          <span>✓</span>
          <span>Promoção working→git aplicada com sucesso.</span>
        </div>
      )}
    </div>
  );
}
