/**
 * console/src/screens/Overview.tsx
 *
 * Overview / Fleet screen — faithful to prototype/overview.html.
 *
 * Renders:
 *  - Summary counters: Servers, Services, Volumes, DNS, ⚠ Drift
 *  - SERVERS table (EntityTable + StatusBadge). Drift server bevox-x-9 is
 *    read-only — no destroy/remove controls, network cell shows read-only label.
 *    Non-drift rows are clickable → /e/server/:name.
 *  - SERVICES table (EntityTable + StatusBadge). Rows clickable → /e/service/:name.
 *    "+ Deploy service" button is a placeholder (screen wired in Task 8).
 *  - Quick-action links to Plan/Apply diff and Health.
 *
 * Data: useStateQuery(). Loading / error handled minimally.
 * Note: useHealth is NOT needed — drift count is derived from state directly.
 */

import { useNavigate, Link } from "react-router-dom";
import { useStateQuery } from "../api/query";
import { StatusBadge } from "../components/StatusBadge";
import { EntityTable } from "../components/EntityTable";
import { isDriftRow } from "../lib/status";
import type { Server, Service } from "../api/contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Version tag extracted from image string, e.g. "registry/x:v12" → "v12". */
function imageVersion(image: string): string {
  const tag = image.split(":")[1];
  return tag ?? image;
}

/** Replica display "actual/desired". The fake data stores replicas as desired;
 *  a degraded service shows 1/<desired> based on the prototype fixture. */
function replicaDisplay(service: Service): string {
  if (service.status === "degraded") {
    return `1/${service.replicas}`;
  }
  return `${service.replicas}/${service.replicas}`;
}

/** Servers that match a service's server_selector label set. */
function serviceServers(service: Service, allServers: Server[]): string {
  const selector = service.server_selector as Record<string, string> | undefined;
  if (!selector || Object.keys(selector).length === 0) return "—";
  const matched = allServers.filter((s) =>
    Object.entries(selector).every(([k, v]) => s.labels?.[k] === v),
  );
  return matched.length > 0 ? matched.map((s) => s.name).join(", ") : "—";
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const serverColumns = [
  { key: "name" as const, header: "Name" },
  { key: "type" as const, header: "Type" },
  { key: "location" as const, header: "Location" },
  {
    key: "status" as const,
    header: "Status",
    render: (row: Server) => <StatusBadge status={row.status} />,
  },
  {
    key: "network" as const,
    header: "Network",
    render: (row: Server) => {
      if (row.status === "drift") {
        return (
          <span className="diff-readonly-warn">
            não está no manifesto · read-only
          </span>
        );
      }
      if (row.status === "degraded") {
        return (
          <span style={{ color: "var(--muted)", fontSize: "12px" }}>1/2 checks</span>
        );
      }
      return <span>net:{row.network}</span>;
    },
  },
];

function makeServiceColumns(allServers: Server[]) {
  return [
    { key: "name" as const, header: "Name" },
    {
      key: "image" as const,
      header: "Version",
      render: (row: Service) => imageVersion(row.image),
    },
    {
      key: "replicas" as const,
      header: "Replicas",
      render: (row: Service) => replicaDisplay(row),
    },
    {
      key: "status" as const,
      header: "Status",
      render: (row: Service) =>
        row.status ? <StatusBadge status={row.status} /> : "—",
    },
    {
      key: "server_selector" as const,
      header: "Servers",
      render: (row: Service) => serviceServers(row, allServers),
    },
  ];
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function Overview() {
  const navigate = useNavigate();
  const { data: state, isLoading, isError } = useStateQuery();

  if (isLoading) return <div className="page"><p>Carregando…</p></div>;
  if (isError || !state) return <div className="page"><p>Erro ao carregar estado.</p></div>;

  const driftCount = state.servers.filter((s) => s.status === "drift").length;
  const serviceColumns = makeServiceColumns(state.servers);

  return (
    <div className="page">
      <div className="page-title">Overview / Fleet</div>

      {/* ── Summary counters ── */}
      <div className="counters">
        <div className="counter-card">
          <div className="label">Servers</div>
          <div className="value">{state.servers.length}</div>
        </div>
        <div className="counter-card">
          <div className="label">Services</div>
          <div className="value">{state.services.length}</div>
        </div>
        <div className="counter-card">
          <div className="label">Volumes</div>
          <div className="value">{state.volumes.length}</div>
        </div>
        <div className="counter-card">
          <div className="label">DNS</div>
          <div className="value">{state.dns.length}</div>
        </div>
        <div className="counter-card warn">
          <div className="label">⚠ Drift</div>
          <div className="value">{driftCount}</div>
        </div>
      </div>

      {/* ── Servers ── */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Servers</span>
          <Link to="/provision" className="btn btn-secondary btn-sm">
            + Provision server
          </Link>
        </div>
        <EntityTable<Server>
          columns={serverColumns}
          rows={state.servers}
          rowKey="name"
          onRowClick={(row) => {
            // Drift servers are read-only — no navigation on click
            if (!isDriftRow(row)) {
              navigate(`/e/server/${row.name}`);
            }
          }}
        />
      </div>

      {/* ── Services ── */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Services</span>
          {/* Placeholder — Deploy service screen not yet implemented */}
          <button type="button" className="btn btn-secondary btn-sm">
            + Deploy service
          </button>
        </div>
        <EntityTable<Service>
          columns={serviceColumns}
          rows={state.services}
          rowKey="name"
          onRowClick={(row) => navigate(`/e/service/${row.name}`)}
        />
      </div>

      {/* ── Quick links ── */}
      {driftCount > 0 && (
        <div className="btn-group" style={{ marginTop: "8px" }}>
          <Link to="/apply" className="btn btn-warn btn-sm">
            ⚠ {driftCount} drift detectado — ver diff
          </Link>
          <Link to="/health" className="btn btn-ghost btn-sm">
            Ver saúde geral →
          </Link>
        </div>
      )}
    </div>
  );
}
