/**
 * console/src/screens/EntityDetail.tsx
 *
 * Entity Detail screen — route /e/:kind/:name
 * Faithful to prototype/entity-detail.html.
 *
 * Hard invariants:
 *  - Drift entity → NO destroy/remove control (isDriftRow)
 *  - Destroy: dry_run:true FIRST (shows plan), then explicit apply with
 *    dry_run:false → pending_approval surfaced to user
 *
 * Data: useStateQuery() + useEvents(). Write: useDryRunApply().
 * Reuses: StatusBadge, DiffView, ConfirmDestructive.
 */

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useStateQuery, useEvents } from "../api/query";
import { useDryRunApply } from "../hooks/useDryRunApply";
import { StatusBadge } from "../components/StatusBadge";
import { DiffView } from "../components/DiffView";
import { ConfirmDestructive } from "../components/ConfirmDestructive";
import { EntityTable } from "../components/EntityTable";
import { isDriftRow } from "../lib/status";
import { formatDateTime } from "../lib/format";
import type { Server, Service, Volume, PlanItem, StateEvent } from "../api/contract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Kind = "server" | "service" | "volume";

// ---------------------------------------------------------------------------
// Kind validation (Fix 4)
// ---------------------------------------------------------------------------

const VALID_KINDS = ["server", "service", "volume"] as const;

function isKind(k: string): k is Kind {
  return (VALID_KINDS as readonly string[]).includes(k);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindLabel(kind: Kind): string {
  switch (kind) {
    case "server": return "Server";
    case "service": return "Service";
    case "volume": return "Volume";
  }
}

function entityStatus(entity: Server | Service | Volume): import("../api/contract").Status | undefined {
  return (entity as { status?: import("../api/contract").Status }).status;
}

// ---------------------------------------------------------------------------
// ActionFeedback sub-component (Fix 3)
// ---------------------------------------------------------------------------

interface ActionFeedbackProps {
  actionLabel: string;
  message: string;
  onDismiss: () => void;
}

function ActionFeedback({ actionLabel, message, onDismiss }: ActionFeedbackProps) {
  return (
    <div className="notice notice-error" style={{ marginBottom: 12 }}>
      <span>✕</span>
      <div style={{ flex: 1 }}>
        <strong>{actionLabel}:</strong> {message}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={onDismiss}
        style={{ alignSelf: "flex-start", padding: "0 6px" }}
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field renderers per kind
// ---------------------------------------------------------------------------

function ServiceFields({ service }: { service: Service }) {
  return (
    <div className="detail-card">
      <div className="detail-grid">
        <div className="detail-field">
          <div className="detail-label">Image</div>
          <div className="detail-value" style={{ fontFamily: "var(--font-mono)" }}>
            {service.image}
          </div>
        </div>
        <div className="detail-field">
          <div className="detail-label">Replicas</div>
          <div className="detail-value">
            {service.status === "degraded"
              ? `1 / ${service.replicas}`
              : `${service.replicas} / ${service.replicas}`}
          </div>
        </div>
        {service.ports && service.ports.length > 0 && (
          <div className="detail-field">
            <div className="detail-label">Ports</div>
            <div className="detail-value">{service.ports.join(", ")}</div>
          </div>
        )}
        {service.server_selector && Object.keys(service.server_selector).length > 0 && (
          <div className="detail-field">
            <div className="detail-label">Server selector</div>
            <div className="detail-value" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {Object.entries(service.server_selector as Record<string, string>)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")}
            </div>
          </div>
        )}
        {service.env && Object.keys(service.env).length > 0 && (
          <div className="detail-field">
            <div className="detail-label">Env from</div>
            <div className="detail-value" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {Object.keys(service.env).join(", ")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ServerFields({ server }: { server: Server }) {
  return (
    <div className="detail-card">
      <div className="detail-grid">
        <div className="detail-field">
          <div className="detail-label">Type</div>
          <div className="detail-value">{server.type}</div>
        </div>
        <div className="detail-field">
          <div className="detail-label">Location</div>
          <div className="detail-value">{server.location}</div>
        </div>
        <div className="detail-field">
          <div className="detail-label">Image</div>
          <div className="detail-value">{server.image}</div>
        </div>
        <div className="detail-field">
          <div className="detail-label">Network</div>
          <div className="detail-value">{server.network}</div>
        </div>
        {server.ssh_keys.length > 0 && (
          <div className="detail-field">
            <div className="detail-label">SSH Keys</div>
            <div className="detail-value">{server.ssh_keys.join(", ")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function VolumeFields({ volume }: { volume: Volume }) {
  return (
    <div className="detail-card">
      <div className="detail-grid">
        <div className="detail-field">
          <div className="detail-label">Size</div>
          <div className="detail-value">{volume.size}</div>
        </div>
        <div className="detail-field">
          <div className="detail-label">Filesystem</div>
          <div className="detail-value">{volume.fs}</div>
        </div>
        {volume.server && (
          <div className="detail-field">
            <div className="detail-label">Server</div>
            <div className="detail-value">{volume.server}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Replicas section (service only)
// ---------------------------------------------------------------------------

function ReplicasSection({ service }: { service: Service }) {
  const count = service.status === "degraded" ? 1 : service.replicas;
  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 12 }}>Replicas</div>
      <div className="replica-list">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="replica-chip">
            <span className="r-name">{service.name}.{i + 1}</span>
            <span className="r-host" style={{ marginLeft: 8 }}>replica-{i + 1}</span>
            <span className="r-uptime">Up</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Destroy flow states
// ---------------------------------------------------------------------------

type DestroyPhase =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "plan"; plan: PlanItem[] }
  | { phase: "pending"; approvalId: string }
  | { phase: "applied" };

// ---------------------------------------------------------------------------
// Actions section
// ---------------------------------------------------------------------------

interface ActionsProps {
  kind: Kind;
  name: string;
  isDrift: boolean;
}

function ActionsSection({ kind, name, isDrift }: ActionsProps) {
  const { isPending, run } = useDryRunApply();

  // State for each action's plan/result
  const [editPlan, setEditPlan] = useState<PlanItem[] | null>(null);
  const [scalePlan, setScalePlan] = useState<PlanItem[] | null>(null);
  const [restartPlan, setRestartPlan] = useState<PlanItem[] | null>(null);
  const [destroyPhase, setDestroyPhase] = useState<DestroyPhase>({ phase: "idle" });

  // Shared error/done feedback state (Fix 3)
  const [actionError, setActionError] = useState<{ label: string; message: string } | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);

  function clearFeedback() {
    setActionError(null);
    setActionDone(null);
  }

  // Edit (dry-run preview) — deploy_service dry_run:true
  function handleEdit() {
    if (kind !== "service") return;
    clearFeedback();
    run({
      path: "/api/services",
      body: { name, dry_run: true },
      onPlanned: (plan) => setEditPlan(plan),
      onPending: (approvalId) =>
        setActionDone(`Edit (preview): pending_approval (${approvalId})`),
      onApplied: () => setActionDone("Edit (preview): aplicado com sucesso."),
      onError: (msg) => setActionError({ label: "Edit (preview)", message: msg }),
    });
  }

  // Scale — POST /api/services/:name/scale dry_run:true
  function handleScale() {
    if (kind !== "service") return;
    clearFeedback();
    run({
      path: `/api/services/${name}/scale`,
      body: { replicas: 3, dry_run: true },
      onPlanned: (plan) => setScalePlan(plan),
      onPending: (approvalId) =>
        setActionDone(`Scale (preview): pending_approval (${approvalId})`),
      onApplied: () => setActionDone("Scale (preview): aplicado com sucesso."),
      onError: (msg) => setActionError({ label: "Scale (preview)", message: msg }),
    });
  }

  // Restart — deploy_service dry_run:true (shows plan)
  function handleRestart() {
    if (kind !== "service") return;
    clearFeedback();
    run({
      path: "/api/services",
      body: { name, dry_run: true },
      onPlanned: (plan) => setRestartPlan(plan),
      onPending: (approvalId) =>
        setActionDone(`Restart (preview): pending_approval (${approvalId})`),
      onApplied: () => setActionDone("Restart (preview): aplicado com sucesso."),
      onError: (msg) => setActionError({ label: "Restart (preview)", message: msg }),
    });
  }

  // Destroy — phase 1: show ConfirmDestructive
  function handleDestroyClick() {
    clearFeedback();
    setDestroyPhase({ phase: "confirm" });
  }

  // Destroy — phase 2: confirmed → send dry_run:true first
  function handleDestroyConfirmed() {
    run({
      path: "/api/destroy",
      body: { entity: `${kind}:${name}`, dry_run: true },
      onPlanned: (plan) => {
        clearFeedback();
        setDestroyPhase({ phase: "plan", plan });
      },
      onPending: (approvalId) => {
        clearFeedback();
        setDestroyPhase({ phase: "pending", approvalId });
      },
      onApplied: () => {
        clearFeedback();
        setDestroyPhase({ phase: "applied" });
        setActionDone("Destroy: aplicado com sucesso.");
      },
      onError: (msg) => {
        setDestroyPhase({ phase: "idle" });
        setActionError({ label: "Destroy (dry-run)", message: msg });
      },
    });
  }

  // Destroy — phase 3: explicit apply → dry_run:false → pending_approval
  function handleDestroyApply() {
    run({
      path: "/api/destroy",
      body: { entity: `${kind}:${name}`, dry_run: false },
      onPlanned: (plan) => {
        clearFeedback();
        setDestroyPhase({ phase: "plan", plan });
      },
      onPending: (approvalId) => {
        clearFeedback();
        setDestroyPhase({ phase: "pending", approvalId });
      },
      onApplied: () => {
        clearFeedback();
        setDestroyPhase({ phase: "applied" });
        setActionDone("Destroy: aplicado com sucesso.");
      },
      onError: (msg) => {
        setDestroyPhase({ phase: "idle" });
        setActionError({ label: "Destroy (aplicar)", message: msg });
      },
    });
  }

  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 12 }}>Ações</div>

      {/* Error feedback (Fix 3) */}
      {actionError && (
        <ActionFeedback
          actionLabel={actionError.label}
          message={actionError.message}
          onDismiss={() => setActionError(null)}
        />
      )}

      {/* Success/done feedback */}
      {actionDone && (
        <div className="notice notice-info" style={{ marginBottom: 12 }}>
          <span>✓</span>
          <div style={{ flex: 1 }}>{actionDone}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setActionDone(null)}
            style={{ alignSelf: "flex-start", padding: "0 6px" }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Drift: read-only, no actions */}
      {isDrift ? (
        <div className="notice notice-warn">
          <span>⚠</span>
          <span>
            Entidade em <strong>drift</strong> — read-only (fail-safe). Nenhuma ação destrutiva
            disponível. Reportado, não destruído.
          </span>
        </div>
      ) : (
        <>
          {/* Normal action buttons — disabled while mutation in-flight (Fix 1) */}
          {destroyPhase.phase === "idle" && (
            <div className="btn-group">
              {kind === "service" && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleEdit}
                    disabled={isPending}
                  >
                    Edit (preview)
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleScale}
                    disabled={isPending}
                  >
                    Scale (preview)
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleRestart}
                    disabled={isPending}
                  >
                    Restart (preview)
                  </button>
                </>
              )}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDestroyClick}
                  disabled={isPending}
                >
                  Destroy ⚠
                </button>
                <span className="approval-hint">→ Approval Gate</span>
              </span>
            </div>
          )}

          {/* ConfirmDestructive dialog — pending passed through (Fix 1) */}
          {destroyPhase.phase === "confirm" && (
            <ConfirmDestructive
              entity={name}
              action={`Destroy ${kind}`}
              onConfirm={handleDestroyConfirmed}
              pending={isPending}
            />
          )}

          {/* Plan shown after dry_run:true */}
          {destroyPhase.phase === "plan" && (
            <div>
              <div className="notice notice-warn" style={{ marginBottom: 12 }}>
                <span>⚠</span>
                <span>Plano de destruição (dry-run). Revise antes de aplicar.</span>
              </div>
              <DiffView items={destroyPhase.plan} />
              <div className="btn-group" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDestroyApply}
                  disabled={isPending}
                >
                  Aplicar (destroy)
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDestroyPhase({ phase: "idle" })}
                  disabled={isPending}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* Pending approval shown after dry_run:false */}
          {destroyPhase.phase === "pending" && (
            <div className="notice notice-warn">
              <span>⏳</span>
              <div>
                <p>
                  <strong>pending_approval</strong> — aguardando aprovação humana ou do agente
                  responsável antes de executar a destruição.
                </p>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 8 }}>
                  Approval ID: {destroyPhase.approvalId}
                </p>
                <Link to="/approvals" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}>
                  Ver Approval Center →
                </Link>
              </div>
            </div>
          )}

          {/* Applied terminal state */}
          {destroyPhase.phase === "applied" && (
            <div className="notice notice-info">
              <span>✓</span>
              <span>Destroy aplicado com sucesso.</span>
            </div>
          )}

          {/* Edit plan — with dry-run notice (Fix 5) */}
          {editPlan && (
            <div className="section" style={{ marginTop: 12 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>Plano (Edit preview)</div>
              <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 12 }}>
                <span>ℹ</span>
                <span>Pré-visualização (dry-run). Aplicação via tela Manifest/Approval.</span>
              </div>
              <DiffView items={editPlan} />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setEditPlan(null)}
              >
                Fechar
              </button>
            </div>
          )}

          {/* Scale plan — with dry-run notice (Fix 5) */}
          {scalePlan && (
            <div className="section" style={{ marginTop: 12 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>Plano (Scale preview)</div>
              <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 12 }}>
                <span>ℹ</span>
                <span>Pré-visualização (dry-run). Aplicação via tela Manifest/Approval.</span>
              </div>
              <DiffView items={scalePlan} />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setScalePlan(null)}
              >
                Fechar
              </button>
            </div>
          )}

          {/* Restart plan — with dry-run notice (Fix 5) */}
          {restartPlan && (
            <div className="section" style={{ marginTop: 12 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>Plano (Restart preview)</div>
              <div className="notice notice-info" style={{ marginBottom: 8, fontSize: 12 }}>
                <span>ℹ</span>
                <span>Pré-visualização (dry-run). Aplicação via tela Manifest/Approval.</span>
              </div>
              <DiffView items={restartPlan} />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setRestartPlan(null)}
              >
                Fechar
              </button>
            </div>
          )}

          {/* Destructive warning */}
          {destroyPhase.phase === "idle" && (
            <div className="notice notice-warn" style={{ marginTop: 14, fontSize: 12 }}>
              <span>⚠</span>
              <span>
                Ações destrutivas (Destroy) requerem aprovação humana ou do agente responsável
                antes de serem executadas. Nenhum recurso é removido sem aprovação explícita.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent events section
// ---------------------------------------------------------------------------

const recentEventColumns = [
  {
    key: "ts" as keyof StateEvent,
    header: "Hora",
    render: (ev: StateEvent) => (
      <span className="event-table" style={{ color: "var(--muted)" }}>
        {formatDateTime(ev.ts)}
      </span>
    ),
  },
  {
    key: "actor" as keyof StateEvent,
    header: "Ator",
    render: (ev: StateEvent) => (
      <span className="event-actor">{ev.actor}</span>
    ),
  },
  {
    key: "op" as keyof StateEvent,
    header: "Ação",
    render: (ev: StateEvent) => (
      <span className="event-entity">
        {ev.op} {ev.entity}
      </span>
    ),
  },
  {
    key: "before" as keyof StateEvent,
    header: "Detalhe",
    render: (_ev: StateEvent) => (
      <span className="event-desc">—</span>
    ),
  },
  {
    key: "result" as keyof StateEvent,
    header: "Result",
    render: (ev: StateEvent) => (
      <span className={`badge badge-${ev.result === "ok" ? "ok" : "error"}`}>
        {ev.result}
      </span>
    ),
  },
];

function RecentEventsSection({ kind, name }: { kind: Kind; name: string }) {
  const entity = `${kind}:${name}`;
  const { data: events, isLoading } = useEvents({ entity });

  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 12 }}>Eventos recentes</div>
      {isLoading ? (
        <p>Carregando eventos…</p>
      ) : events && events.length > 0 ? (
        <>
          <EntityTable<StateEvent>
            columns={recentEventColumns}
            rows={events.slice(0, 5)}
            rowKeyFn={(ev, i) => `${ev.ts}:${ev.actor}:${ev.op}:${i}`}
          />
          <div style={{ marginTop: 10 }}>
            <Link to="/events" className="btn btn-ghost btn-sm">
              Ver todos os eventos →
            </Link>
          </div>
        </>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Nenhum evento recente para {entity}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function EntityDetail() {
  const { kind: kindParam, name } = useParams<{ kind: string; name: string }>();
  const { data: state, isLoading, isError } = useStateQuery();

  if (isLoading) {
    return <div className="page"><p>Carregando…</p></div>;
  }
  if (isError || !state) {
    return <div className="page"><p>Erro ao carregar estado.</p></div>;
  }

  // Fix 4: validate kind before proceeding
  if (!kindParam || !name || !isKind(kindParam)) {
    return <div className="page"><p>Parâmetros inválidos.</p></div>;
  }

  // TypeScript narrows kind to Kind after the guard — no cast needed
  const kind = kindParam;

  // Find entity
  let entity: Server | Service | Volume | undefined;
  if (kind === "server") {
    entity = state.servers.find((s) => s.name === name);
  } else if (kind === "service") {
    entity = state.services.find((s) => s.name === name);
  } else if (kind === "volume") {
    entity = state.volumes.find((v) => v.name === name);
  }

  if (!entity) {
    return (
      <div className="page">
        <div style={{ marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
          <Link to="/">← Overview</Link>
          <span style={{ margin: "0 6px" }}>›</span>
          <span>{kind}:{name}</span>
        </div>
        <p>
          Entity <strong>{kind}:{name}</strong> não encontrado — not found.
        </p>
      </div>
    );
  }

  const status = entityStatus(entity);
  const drift = isDriftRow({ status });
  const label = kindLabel(kind);

  return (
    <div className="page">
      {/* Breadcrumb */}
      <div style={{ marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
        <Link to="/">← Overview</Link>
        <span style={{ margin: "0 6px" }}>›</span>
        <span>{kind}:{name}</span>
      </div>

      {/* Title + StatusBadge */}
      <div className="page-title">
        {label}: {name}
        {status && (
          <span style={{ marginLeft: 12 }}>
            <StatusBadge status={status} />
          </span>
        )}
      </div>

      {/* Drift read-only warning */}
      {drift && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          <span>⚠</span>
          <span>
            <strong>Drift</strong> — esta entidade existe na Hetzner mas não está no manifesto.
            Reportado, não destruído (fail-safe). Read-only.
          </span>
        </div>
      )}

      {/* Entity fields */}
      {kind === "service" && <ServiceFields service={entity as Service} />}
      {kind === "server" && <ServerFields server={entity as Server} />}
      {kind === "volume" && <VolumeFields volume={entity as Volume} />}

      {/* Replicas (service only) */}
      {kind === "service" && <ReplicasSection service={entity as Service} />}

      {/* Actions */}
      <ActionsSection kind={kind} name={name} isDrift={drift} />

      {/* Recent events */}
      <RecentEventsSection kind={kind} name={name} />
    </div>
  );
}
