/**
 * console/src/screens/Events.tsx
 *
 * Events — Audit Trail screen, route /events
 * Faithful to prototype/events.html.
 *
 * Data: useEvents(filters) → GET /api/events?actor=&entity=&result=
 *
 * Filters: controlled inputs (actor, entity, result). Changing a filter
 * drives the hook's filters → TanStack Query re-fetches with new params.
 * Empty filter value = all events (omits the param from the query).
 *
 * READ-ONLY: no write actions, no destroy controls, no mutations.
 *
 * Columns (per prototype): Hora · Ator · Ação · Entidade · Detalhe · Result
 */

import { useState } from "react";
import { useEvents } from "../api/query";
import type { StateEvent } from "../api/contract";
import { EntityTable } from "../components/EntityTable";
import { formatDateTime } from "../lib/format";

// ---------------------------------------------------------------------------
// Badge helper for result values
// ---------------------------------------------------------------------------

function ResultBadge({ result }: { result: string }) {
  const cls =
    result === "ok"
      ? "badge badge-ok"
      : result === "reported"
        ? "badge badge-drift"
        : result === "error"
          ? "badge badge-error"
          : "badge badge-pending";
  return <span className={cls}>{result}</span>;
}

// ---------------------------------------------------------------------------
// Build a compact detail string from before/after if present
// ---------------------------------------------------------------------------

function buildDetail(event: StateEvent): string {
  if (event.before == null && event.after == null) return "";
  if (event.after != null && typeof event.after === "object") {
    const after = event.after as Record<string, unknown>;
    const before =
      event.before != null && typeof event.before === "object"
        ? (event.before as Record<string, unknown>)
        : {};
    // Find differing keys and render "key: before → after"
    const parts: string[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const bv = before[key];
      const av = after[key];
      if (bv !== undefined && av !== undefined && bv !== av) {
        parts.push(`${key}: ${bv} → ${av}`);
      } else if (bv === undefined && av !== undefined) {
        parts.push(`${key}: ${av}`);
      }
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Events screen
// ---------------------------------------------------------------------------

export function Events() {
  const [actorFilter, setActorFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");

  // Build filters object — omit empty strings so hook passes only active filters
  const filters: { actor?: string; entity?: string; result?: string } = {};
  if (actorFilter) filters.actor = actorFilter;
  if (entityFilter) filters.entity = entityFilter;
  if (resultFilter) filters.result = resultFilter;

  const { data: events, isLoading, isError } = useEvents(filters);

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Events — Audit Trail</div>

      {/* Info notice (faithful to prototype) */}
      <div className="notice notice-info">
        <span>ℹ</span>
        <span>
          Registro append-only. Nenhum evento pode ser editado ou removido. Todo
          StateEvent registra o agente ator.
        </span>
      </div>

      {/* Filter row */}
      <div className="filter-row">
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Filtrar:</span>

        <input
          type="text"
          className="filter-select"
          aria-label="ator"
          placeholder="ator"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
        />

        <input
          type="text"
          className="filter-select"
          aria-label="entidade"
          placeholder="entidade"
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
        />

        <input
          type="text"
          className="filter-select"
          aria-label="result"
          placeholder="result"
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value)}
        />
      </div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando eventos…</p>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar eventos. Tente recarregar a página.</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && events && events.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Sem eventos encontrados para os filtros aplicados.
        </p>
      )}

      {/* Events table */}
      {!isLoading && !isError && events && events.length > 0 && (
        <>
          <EntityTable<StateEvent>
            columns={[
              {
                key: "ts",
                header: "Hora",
                render: (row) => (
                  <span
                    style={{
                      color: "var(--muted)",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {formatDateTime(row.ts)}
                  </span>
                ),
              },
              {
                key: "actor",
                header: "Ator",
                render: (row) => (
                  <span
                    className="event-actor"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                  >
                    {row.actor}
                  </span>
                ),
              },
              {
                key: "op",
                header: "Ação",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {row.op}
                  </span>
                ),
              },
              {
                key: "entity",
                header: "Entidade",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {row.entity}
                  </span>
                ),
              },
              {
                key: "before",
                header: "Detalhe",
                render: (row) => (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--muted)",
                    }}
                  >
                    {buildDetail(row)}
                  </span>
                ),
              },
              {
                key: "result",
                header: "Result",
                render: (row) => <ResultBadge result={row.result} />,
              },
            ]}
            rows={events}
            rowKeyFn={(e, i) => `${e.ts}-${e.actor}-${e.entity}-${i}`}
          />

          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Exibindo {events.length} evento{events.length !== 1 ? "s" : ""} · ordenado por hora desc
          </div>
        </>
      )}
    </div>
  );
}
