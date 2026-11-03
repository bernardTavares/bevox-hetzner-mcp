/**
 * console/src/screens/Health.tsx
 *
 * Health screen — route /health
 * Faithful to prototype/health.html.
 *
 * Data: useHealth() → GET /api/health → HealthReport.
 *
 * READ-ONLY screen. No write/destroy controls anywhere.
 * Drift entities are shown with a read-only notice (fail-safe, not destroyed).
 * Cross-screen navigation uses <Link>.
 *
 * Sections:
 *  1. Circuit Breakers — per provider, open vs closed visually distinct
 *  2. Degraded entities — list with detail; Link to entity detail
 *  3. Blocked entities — list with blocking reason (drift dep); read-only
 *  4. Drift detected — read-only notice per drifted entity
 *  5. Reconciler status — state, last cycle + result, next cycle in, total cycles
 */

import { Link } from "react-router-dom";
import { useHealth } from "../api/query";
import type { HealthReport } from "../api/contract";
import { EntityTable } from "../components/EntityTable";
import { formatDateTime } from "../lib/format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format total_cycles with locale separator (e.g. 1,247). */
function formatCycles(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// CircuitBreakers section
// ---------------------------------------------------------------------------

interface CircuitBreakersProps {
  breakers: HealthReport["circuit_breakers"];
}

function CircuitBreakers({ breakers }: CircuitBreakersProps) {
  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 10 }}>
        Circuit Breakers
      </div>
      <div className="detail-card" style={{ padding: "16px 20px" }}>
        {breakers.map((cb) => {
          const isOpen = cb.state === "open";
          return (
            <div
              key={cb.name}
              className="circuit-row"
              style={
                isOpen
                  ? {
                      background: "var(--degraded-bg)",
                      margin: "0 -20px",
                      padding: "12px 20px",
                      borderRadius: 0,
                    }
                  : undefined
              }
            >
              <span
                className="circuit-dot"
                style={{ color: isOpen ? "var(--degraded)" : "var(--healthy)" }}
              >
                ●
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
                circuit: {cb.name}
              </span>
              <span className={`badge badge-${isOpen ? "open" : "closed"}`}>
                {isOpen ? "open ⚠" : "closed"}
              </span>
              {isOpen && cb.failures !== undefined && cb.max_failures !== undefined && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--degraded)",
                    marginLeft: 8,
                  }}
                >
                  falhas recentes: {cb.failures}/{cb.max_failures}
                  {cb.last_failure ? ` · last_failure: ${formatDateTime(cb.last_failure)}` : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DegradedEntities section
// ---------------------------------------------------------------------------

interface DegradedEntitiesProps {
  degraded: HealthReport["degraded"];
}

function DegradedEntities({ degraded }: DegradedEntitiesProps) {
  return (
    <div className="health-group">
      <div className="health-group-title">degraded</div>
      {degraded.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)" }}>
          — nenhuma entidade degradada
        </p>
      ) : (
        <EntityTable
          columns={[
            {
              key: "entity",
              header: "Entidade",
              render: (item) => {
                const parts = item.entity.split(":");
                const kind = parts[0] ?? "";
                const name = parts.slice(1).join(":");
                return (
                  <Link
                    to={`/e/${kind}/${name}`}
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {item.entity}
                  </Link>
                );
              },
            },
            {
              key: "detail",
              header: "Detalhe",
              render: (item) => (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--degraded)",
                  }}
                >
                  {item.detail}
                </span>
              ),
            },
            {
              key: "entity",
              id: "entity-action",
              header: "Ação",
              render: (item) => {
                const parts = item.entity.split(":");
                const kind = parts[0] ?? "";
                const name = parts.slice(1).join(":");
                return (
                  <Link
                    to={`/e/${kind}/${name}`}
                    className="btn btn-ghost btn-sm"
                  >
                    ver detalhe →
                  </Link>
                );
              },
            },
          ]}
          rows={degraded}
          rowKey="entity"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BlockedEntities section
// ---------------------------------------------------------------------------

interface BlockedEntitiesProps {
  blocked: HealthReport["blocked"];
}

function BlockedEntities({ blocked }: BlockedEntitiesProps) {
  return (
    <div className="health-group" style={{ marginTop: 16 }}>
      <div className="health-group-title">blocked</div>
      {blocked.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)" }}>
          — nenhuma entidade bloqueada
        </p>
      ) : (
        <EntityTable
          columns={[
            {
              key: "entity",
              header: "Entidade",
              render: (item) => (
                <span style={{ fontFamily: "var(--font-mono)" }}>{item.entity}</span>
              ),
            },
            {
              key: "reason",
              header: "Motivo",
              render: (item) => (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--drift)",
                  }}
                >
                  {item.reason}
                </span>
              ),
            },
            {
              key: "entity",
              id: "entity-action",
              header: "Ação",
              render: () => (
                <Link to="/apply" className="btn btn-ghost btn-sm">
                  ver diff →
                </Link>
              ),
            },
          ]}
          rows={blocked}
          rowKey="entity"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DriftSection — read-only notice per drifted entity
// ---------------------------------------------------------------------------

interface DriftSectionProps {
  drift: HealthReport["drift"];
}

function DriftSection({ drift }: DriftSectionProps) {
  if (drift.length === 0) return null;

  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 10 }}>
        Drift detectado
      </div>
      {drift.map((item) => (
        <div key={item.entity} className="notice notice-drift" style={{ marginBottom: 12 }}>
          <span>⚠</span>
          <span>
            <strong style={{ fontFamily: "var(--font-mono)" }}>{item.entity}</strong>{" "}
            — {item.detail}
            {" "}
            <strong>não destruído</strong> (fail-safe).{" "}
            <Link to="/apply" style={{ marginLeft: 8 }}>
              → ver diff
            </Link>
            <br />
            <span style={{ fontSize: 12, color: "var(--drift)" }}>
              Nenhuma ação destrutiva disponível para drift nesta tela.
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReconcilerStatus section
// ---------------------------------------------------------------------------

interface ReconcilerStatusProps {
  reconciler: HealthReport["reconciler"];
}

function ReconcilerStatus({ reconciler }: ReconcilerStatusProps) {
  const stateColor =
    reconciler.state === "idle"
      ? "var(--healthy)"
      : reconciler.state === "applying"
        ? "var(--applying)"
        : "var(--pending)";

  const resultBadgeClass =
    reconciler.last_result === "ok"
      ? "badge-ok"
      : reconciler.last_result === "error"
        ? "badge-error"
        : "badge-pending";

  return (
    <div className="section">
      <div className="section-title" style={{ marginBottom: 10 }}>
        Reconciler
      </div>
      <div className="detail-card" style={{ padding: "16px 20px" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            alignItems: "center",
          }}
        >
          <div>
            <span style={{ color: "var(--muted)" }}>estado:</span>
            <span style={{ color: stateColor, marginLeft: 6, fontWeight: 700 }}>
              {reconciler.state}
            </span>
          </div>
          <div>
            <span style={{ color: "var(--muted)" }}>último ciclo:</span>
            <span style={{ marginLeft: 6 }}>{formatDateTime(reconciler.last_cycle)}</span>
            <span className={`badge ${resultBadgeClass}`} style={{ marginLeft: 8 }}>
              {reconciler.last_result}
            </span>
          </div>
          <div>
            <span style={{ color: "var(--muted)" }}>próximo ciclo:</span>
            <span style={{ color: "var(--pending)", marginLeft: 6 }}>
              {reconciler.next_cycle_in}
            </span>
          </div>
          <div>
            <span style={{ color: "var(--muted)" }}>ciclos totais:</span>
            <span style={{ marginLeft: 6 }}>{formatCycles(reconciler.total_cycles)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health screen
// ---------------------------------------------------------------------------

export function Health() {
  const { data: health, isLoading, isError } = useHealth();

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Health</div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando health…</p>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar health report. Tente recarregar a página.</span>
        </div>
      )}

      {/* Main content */}
      {!isLoading && !isError && health && (
        <>
          {/* 1. Circuit Breakers */}
          <CircuitBreakers breakers={health.circuit_breakers} />

          {/* 2. Degraded + Blocked entities */}
          <div className="section">
            <div className="section-title" style={{ marginBottom: 10 }}>
              Entidades Degradadas
            </div>
            <DegradedEntities degraded={health.degraded} />
            <BlockedEntities blocked={health.blocked} />
          </div>

          {/* 3. Drift — read-only */}
          <DriftSection drift={health.drift} />

          {/* 4. Reconciler */}
          <ReconcilerStatus reconciler={health.reconciler} />
        </>
      )}
    </div>
  );
}
