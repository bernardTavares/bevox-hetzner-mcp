/**
 * console/src/screens/ProvisionServer.tsx
 *
 * ProvisionServer — route /provision
 * Faithful to prototype/provision.html: 3-step wizard (Básico → Rede → Revisão).
 *
 * Hard invariants:
 *  - dry_run:true FIRST (planned phase shown) BEFORE any dry_run:false
 *  - pending_approval surfaced with approval_id + link to /approvals
 *  - Drift items in plan are read-only (enforced by DiffView)
 *  - Buttons disabled while isPending (in-flight mutation)
 *
 * Pattern: CANONICAL WRITE PATTERN via useDryRunApply — discriminated-union
 * phase state machine; in-flight-disable; full-envelope handling; errors via notice-error.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useDryRunApply } from "../hooks/useDryRunApply";
import { DiffView } from "../components/DiffView";
import type { PlanItem } from "../api/contract";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface ProvisionForm {
  name: string;
  type: string;
  location: string;
  image: string;
  ssh_keys: string;
  network: string;
  labels: string;
  volumes: string;
}

const DEFAULT_FORM: ProvisionForm = {
  name: "",
  type: "cx32",
  location: "nbg1",
  image: "ubuntu-24.04",
  ssh_keys: "bevox-ops",
  network: "bevox-priv",
  labels: "app=harness",
  volumes: "",
};

// ---------------------------------------------------------------------------
// I1: Pure helper — parse "key=value,..." labels string into Record<string,string>
// ---------------------------------------------------------------------------

function parseLabels(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw.trim()) return result;
  for (const part of raw.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k && k.trim()) result[k.trim()] = v?.trim() ?? "";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase state machine (canonical write pattern)
//
//  idle      → step 3 shows [Plan (dry_run)] button
//  planned   → dry_run:true sent; plan items shown + [Provisionar → Approval] [Cancelar]
//  pending   → dry_run:false sent; pending_approval + approval_id surfaced
//  applied   → (edge case) status:applied received; show success notice
// ---------------------------------------------------------------------------

type ProvisionPhase =
  | { phase: "idle" }
  | { phase: "planned"; plan: PlanItem[] }
  | { phase: "pending"; approvalId: string }
  | { phase: "applied" };

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

interface StepIndicatorProps {
  currentStep: 1 | 2 | 3;
}

function StepIndicator({ currentStep }: StepIndicatorProps) {
  const steps = [
    { num: 1, label: "Básico" },
    { num: 2, label: "Rede" },
    { num: 3, label: "Revisão" },
  ] as const;

  return (
    <div className="wizard-steps" aria-label="Wizard steps" role="list">
      {steps.map((step, idx) => {
        const isDone = step.num < currentStep;
        const isActive = step.num === currentStep;
        const className = `wizard-step${isDone ? " done" : ""}${isActive ? " active" : ""}`;

        return (
          <div key={step.num} role="listitem" style={{ display: "flex", alignItems: "center" }}>
            <div className={className}>
              <div className="step-num" aria-hidden="true">{isDone ? "✓" : step.num}</div>
              <span>
                {step.num} · {step.label}
              </span>
            </div>
            {idx < steps.length - 1 && <div className="step-sep">›</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Básico
// ---------------------------------------------------------------------------

interface Step1Props {
  form: ProvisionForm;
  nameError: string | null;
  onChange: (field: keyof ProvisionForm, value: string) => void;
  onNext: () => void;
  isPending: boolean;
}

function Step1Basico({ form, nameError, onChange, onNext, isPending }: Step1Props) {
  return (
    <div className="detail-card">
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: ".08em",
          marginBottom: 16,
        }}
      >
        Passo 1 · Básico
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="provision-name">Name</label>
          <input
            id="provision-name"
            className="form-input"
            type="text"
            value={form.name}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="ex: bevox-app-3"
            aria-label="Name"
            aria-required="true"
          />
          {nameError && (
            <span
              style={{ color: "var(--error)", fontSize: 12, marginTop: 4, display: "block" }}
              role="alert"
            >
              {nameError}
            </span>
          )}
        </div>

        <div className="form-field">
          <label htmlFor="provision-type">Type</label>
          <select
            id="provision-type"
            className="form-select"
            value={form.type}
            onChange={(e) => onChange("type", e.target.value)}
            aria-label="Type"
          >
            <option value="cx22">cx22 (2 vCPU, 4 GB)</option>
            <option value="cx32">cx32 (4 vCPU, 8 GB)</option>
            <option value="cx42">cx42 (8 vCPU, 16 GB)</option>
            <option value="cx52">cx52 (16 vCPU, 32 GB)</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="provision-location">Location</label>
          <select
            id="provision-location"
            className="form-select"
            value={form.location}
            onChange={(e) => onChange("location", e.target.value)}
            aria-label="Location"
          >
            <option value="nbg1">nbg1 (Nuremberg)</option>
            <option value="fsn1">fsn1 (Falkenstein)</option>
            <option value="hel1">hel1 (Helsinki)</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="provision-image">Image</label>
          <select
            id="provision-image"
            className="form-select"
            value={form.image}
            onChange={(e) => onChange("image", e.target.value)}
            aria-label="Image"
          >
            <option value="ubuntu-24.04">ubuntu-24.04</option>
            <option value="ubuntu-22.04">ubuntu-22.04</option>
            <option value="debian-12">debian-12</option>
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="provision-ssh-keys">SSH Keys</label>
          <input
            id="provision-ssh-keys"
            className="form-input"
            type="text"
            value={form.ssh_keys}
            onChange={(e) => onChange("ssh_keys", e.target.value)}
            placeholder="ex: bevox-ops"
            aria-label="SSH Keys"
          />
        </div>
      </div>

      <div className="btn-group" style={{ marginTop: 20 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNext}
          disabled={isPending}
          aria-label="Próximo"
        >
          Próximo
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Rede & Volumes
// ---------------------------------------------------------------------------

interface Step2Props {
  form: ProvisionForm;
  onChange: (field: keyof ProvisionForm, value: string) => void;
  onNext: () => void;
  onBack: () => void;
  isPending: boolean;
  step1Summary: string;
}

function Step2Rede({ form, onChange, onNext, onBack, isPending, step1Summary }: Step2Props) {
  return (
    <>
      {/* Step 1 summary */}
      <div className="notice notice-info" style={{ marginBottom: 20 }}>
        <span>ℹ</span>
        <span>
          Passo 1 concluído:{" "}
          <strong style={{ fontFamily: "var(--font-mono)" }}>{step1Summary}</strong>
        </span>
      </div>

      <div className="detail-card">
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: ".08em",
            marginBottom: 16,
          }}
        >
          Passo 2 · Rede &amp; Volumes
        </div>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="provision-network">Network</label>
            <select
              id="provision-network"
              className="form-select"
              value={form.network}
              onChange={(e) => onChange("network", e.target.value)}
              aria-label="Network"
            >
              <option value="bevox-priv">bevox-priv</option>
              <option value="bevox-internal">bevox-internal</option>
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="provision-labels">Labels</label>
            <input
              id="provision-labels"
              className="form-input"
              type="text"
              value={form.labels}
              onChange={(e) => onChange("labels", e.target.value)}
              placeholder="ex: app=harness"
              aria-label="Labels"
            />
          </div>

          <div className="form-field">
            <label htmlFor="provision-volumes">Volumes a anexar</label>
            <select
              id="provision-volumes"
              className="form-select"
              value={form.volumes}
              onChange={(e) => onChange("volumes", e.target.value)}
              aria-label="Volumes"
            >
              <option value="">sem volumes</option>
              <option value="pg-data">pg-data (50Gi)</option>
              <option value="pg-data-2">pg-data-2 (50Gi)</option>
            </select>
          </div>
        </div>

        <div className="btn-group" style={{ marginTop: 20 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onBack}
            disabled={isPending}
            aria-label="Voltar"
          >
            [Voltar]
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNext}
            disabled={isPending}
            aria-label="Próximo"
          >
            Próximo
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Revisão — idle + planned + pending phases
// ---------------------------------------------------------------------------

interface Step3Props {
  form: ProvisionForm;
  phase: ProvisionPhase;
  provisionError: string | null;
  isPending: boolean;
  onBack: () => void;
  onPlan: () => void;
  onProvisionar: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}

function costEstimate(type: string, location: string): string {
  // Rough estimates per Hetzner pricing (illustrative)
  const prices: Record<string, number> = {
    cx22: 4.15,
    cx32: 12.49,
    cx42: 24.49,
    cx52: 49.49,
  };
  const cost = prices[type] ?? 12.49;
  return `~€${cost.toFixed(2)}/mês (${type} ${location})`;
}

function Step3Revisao({
  form,
  phase,
  provisionError,
  isPending,
  onBack,
  onPlan,
  onProvisionar,
  onCancel,
  onDismissError,
}: Step3Props) {
  const cost = costEstimate(form.type, form.location);

  return (
    <>
      {/* Cost / Approval warning — always shown on step 3 */}
      <div className="notice notice-warn" style={{ marginBottom: 20, fontSize: 13 }}>
        <span>⚠</span>
        <div>
          <strong>Operação com custo:</strong>&nbsp;
          <span style={{ fontFamily: "var(--font-mono)" }}>est. custo {cost}</span>
          <br />
          <span style={{ fontSize: 12, marginTop: 4, display: "block" }}>
            Provisionar um servidor cria recurso real na Hetzner e gera custo imediato. Esta ação
            requer <strong>Approval Gate</strong> antes de ser executada.
          </span>
          <span className="approval-hint" style={{ marginTop: 6, display: "inline-block" }}>
            → Approval Gate
          </span>
        </div>
      </div>

      {/* Summary */}
      <div className="detail-card" style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: ".08em",
            marginBottom: 16,
          }}
        >
          Revisão — Resumo
        </div>
        <div className="detail-grid">
          <div>
            <div className="detail-label">Name</div>
            <div className="detail-value">{form.name}</div>
          </div>
          <div>
            <div className="detail-label">Type</div>
            <div className="detail-value">{form.type}</div>
          </div>
          <div>
            <div className="detail-label">Location</div>
            <div className="detail-value">{form.location}</div>
          </div>
          <div>
            <div className="detail-label">Image</div>
            <div className="detail-value">{form.image}</div>
          </div>
          <div>
            <div className="detail-label">SSH Keys</div>
            <div className="detail-value">{form.ssh_keys || "(none)"}</div>
          </div>
          <div>
            <div className="detail-label">Network</div>
            <div className="detail-value">{form.network || "(none)"}</div>
          </div>
          <div>
            <div className="detail-label">Labels</div>
            <div className="detail-value">{form.labels || "(none)"}</div>
          </div>
          <div>
            <div className="detail-label">Volumes</div>
            <div className="detail-value">{form.volumes || "(none)"}</div>
          </div>
        </div>
      </div>

      {/* Error notice */}
      {provisionError && (
        <div className="notice notice-error" style={{ marginBottom: 12 }}>
          <span>✕</span>
          <div style={{ flex: 1 }}>{provisionError}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onDismissError}
            style={{ padding: "0 6px" }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Phase: idle — Plan (dry_run) button */}
      {phase.phase === "idle" && (
        <div className="btn-group">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onBack}
            disabled={isPending}
            aria-label="Voltar"
          >
            [Voltar]
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onPlan}
            disabled={isPending}
            aria-label="Plan (dry_run)"
          >
            Plan (dry_run)
          </button>
        </div>
      )}

      {/* Phase: planned — show plan items + Provisionar → Approval / Cancelar */}
      {phase.phase === "planned" && (
        <div>
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span>
              Plano calculado (dry-run). Revise antes de confirmar. Nenhuma mudança foi aplicada
              ainda.
            </span>
          </div>

          <div className="section" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ marginBottom: 8 }}>
              Mudanças previstas
            </div>
            <DiffView items={phase.plan} />
          </div>

          <div className="btn-group" style={{ marginTop: 12 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="btn btn-warn"
                onClick={onProvisionar}
                disabled={isPending}
                aria-label="Provisionar → Approval"
              >
                Provisionar → Approval
              </button>
              <span className="approval-hint">→ Approval Gate</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
              disabled={isPending}
              aria-label="Cancelar"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Phase: pending — pending_approval surfaced with approval_id */}
      {phase.phase === "pending" && (
        <div className="notice notice-warn">
          <span>⏳</span>
          <div>
            <p>
              <strong>pending_approval</strong> — aguardando aprovação antes de provisionar. Nenhum
              servidor foi criado ainda.
            </p>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              Approval ID: {phase.approvalId}
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
      {phase.phase === "applied" && (
        <div className="notice notice-info">
          <span>✓</span>
          <span>Servidor provisionado com sucesso.</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ProvisionServer — main screen component
// ---------------------------------------------------------------------------

export function ProvisionServer() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<ProvisionForm>(DEFAULT_FORM);
  const [nameError, setNameError] = useState<string | null>(null);
  const [provisionPhase, setProvisionPhase] = useState<ProvisionPhase>({ phase: "idle" });
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const { isPending, run } = useDryRunApply();

  // -------------------------------------------------------------------------
  // Form field change
  // -------------------------------------------------------------------------

  function handleChange(field: keyof ProvisionForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "name" && nameError) {
      setNameError(null);
    }
  }

  // -------------------------------------------------------------------------
  // Step 1 → 2: validate name required
  // -------------------------------------------------------------------------

  function handleStep1Next() {
    if (!form.name.trim()) {
      setNameError("Nome é obrigatório (campo required).");
      return;
    }
    setNameError(null);
    setStep(2);
  }

  // -------------------------------------------------------------------------
  // Step 2 → 3
  // -------------------------------------------------------------------------

  function handleStep2Next() {
    setStep(3);
  }

  // -------------------------------------------------------------------------
  // Back navigation
  // -------------------------------------------------------------------------

  function handleBack() {
    if (step === 2) {
      setStep(1);
    } else if (step === 3) {
      // Going back from step 3 resets the provision phase
      setProvisionPhase({ phase: "idle" });
      setProvisionError(null);
      setStep(2);
    }
  }

  // -------------------------------------------------------------------------
  // Plan (dry_run:true) — first step of canonical write pattern
  // -------------------------------------------------------------------------

  function handlePlan() {
    setProvisionError(null);

    const sshKeysTrimmed = form.ssh_keys.trim();
    const volumesTrimmed = form.volumes.trim();

    run({
      path: "/api/servers",
      body: {
        name: form.name,
        type: form.type,
        location: form.location,
        image: form.image,
        ssh_keys: sshKeysTrimmed ? [sshKeysTrimmed] : [],
        network: form.network,
        labels: parseLabels(form.labels),
        volumes: volumesTrimmed ? [volumesTrimmed] : [],
        dry_run: true,
      },
      onPlanned: (plan) => setProvisionPhase({ phase: "planned", plan }),
      onPending: (approvalId) => setProvisionPhase({ phase: "pending", approvalId }),
      onApplied: () => setProvisionPhase({ phase: "applied" }),
      onError: (msg) => setProvisionError(msg),
    });
  }

  // -------------------------------------------------------------------------
  // Provisionar (dry_run:false) — second step: explicit confirmation → Approval Gate
  // -------------------------------------------------------------------------

  function handleProvisionar() {
    setProvisionError(null);

    const sshKeysTrimmed = form.ssh_keys.trim();
    const volumesTrimmed = form.volumes.trim();

    run({
      path: "/api/servers",
      body: {
        name: form.name,
        type: form.type,
        location: form.location,
        image: form.image,
        ssh_keys: sshKeysTrimmed ? [sshKeysTrimmed] : [],
        network: form.network,
        labels: parseLabels(form.labels),
        volumes: volumesTrimmed ? [volumesTrimmed] : [],
        dry_run: false,
      },
      // I2: unexpected "planned" on dry_run:false is a protocol error — surface it
      onPlanned: (_plan) => {
        setProvisionPhase({ phase: "idle" });
        setProvisionError("[inesperado] Servidor retornou plano em vez de pending_approval.");
      },
      onPending: (approvalId) => setProvisionPhase({ phase: "pending", approvalId }),
      onApplied: () => setProvisionPhase({ phase: "applied" }),
      onError: (msg) => {
        setProvisionPhase({ phase: "idle" });
        setProvisionError(msg);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Cancel planned phase → back to idle
  // -------------------------------------------------------------------------

  function handleCancel() {
    setProvisionPhase({ phase: "idle" });
    setProvisionError(null);
  }

  // -------------------------------------------------------------------------
  // Step 1 summary for step 2 notice
  // -------------------------------------------------------------------------

  const step1Summary = `name=${form.name} · type=${form.type} · location=${form.location} · image=${form.image} · ssh_keys=[${form.ssh_keys}]`;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Provision Server</div>

      {/* Wizard step indicator */}
      <StepIndicator currentStep={step} />

      {/* Step content */}
      {step === 1 && (
        <Step1Basico
          form={form}
          nameError={nameError}
          onChange={handleChange}
          onNext={handleStep1Next}
          isPending={isPending}
        />
      )}

      {step === 2 && (
        <Step2Rede
          form={form}
          onChange={handleChange}
          onNext={handleStep2Next}
          onBack={handleBack}
          isPending={isPending}
          step1Summary={step1Summary}
        />
      )}

      {step === 3 && (
        <Step3Revisao
          form={form}
          phase={provisionPhase}
          provisionError={provisionError}
          isPending={isPending}
          onBack={handleBack}
          onPlan={handlePlan}
          onProvisionar={handleProvisionar}
          onCancel={handleCancel}
          onDismissError={() => setProvisionError(null)}
        />
      )}
    </div>
  );
}
