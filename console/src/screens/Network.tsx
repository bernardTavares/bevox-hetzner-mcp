/**
 * console/src/screens/Network.tsx
 *
 * Network / WireGuard screen — route /network
 * Faithful to prototype/network.html.
 *
 * Data: useStateQuery() → GET /api/state (networks + servers).
 *
 * READ-ONLY screen. No write/destroy controls.
 *
 * Members are derived from servers whose server.network field matches the
 * network name. WireGuard mesh summary is derived from member server statuses:
 *   - total peers = count of member servers
 *   - "up" peers = members whose status is not "degraded"/"error"/"drift"
 *   - degraded peers = members with status "degraded"
 *
 * "+ Network" is a disabled, non-functional placeholder. Network membership
 * is declarative via server label — creation is not a v1 action.
 */

import { Link } from "react-router-dom";
import { useStateQuery } from "../api/query";
import type { Network as NetworkType, Server } from "../api/contract";
import { EntityTable } from "../components/EntityTable";

// ---------------------------------------------------------------------------
// Derive members for a network from the servers list
// ---------------------------------------------------------------------------

function getMembersForNetwork(network: NetworkType, servers: Server[]): Server[] {
  return servers.filter((s) => s.network === network.name);
}

// ---------------------------------------------------------------------------
// Derive WireGuard mesh summary from members
// ---------------------------------------------------------------------------

interface MeshSummary {
  total: number;
  up: number;
  degraded: Server[];
}

function getMeshSummary(members: Server[]): MeshSummary {
  const degraded = members.filter((s) => s.status === "degraded" || s.status === "error");
  const up = members.filter((s) => s.status !== "degraded" && s.status !== "error" && s.status !== "drift");
  return { total: members.length, up: up.length, degraded };
}

// ---------------------------------------------------------------------------
// PeerDot — status indicator chip dot
// ---------------------------------------------------------------------------

function peerDotClass(server: Server): string {
  if (server.status === "degraded" || server.status === "error") return "warn";
  // defensive: drift servers are excluded from members upstream; kept for safety
  if (server.status === "drift") return "down";
  return "up";
}

// ---------------------------------------------------------------------------
// NetworkCard — one card per network
// ---------------------------------------------------------------------------

interface NetworkCardProps {
  network: NetworkType;
  members: Server[];
}

function NetworkCard({ network, members }: NetworkCardProps) {
  const mesh = getMeshSummary(members);
  const allUp = members.length > 0 && mesh.up === mesh.total;

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      {/* Header: name + ip_range + subnets */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700 }}>
            {network.name}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--muted)",
              marginTop: 4,
            }}
          >
            {network.ip_range}
            {network.subnets.length > 0 && (
              <>
                {"  ·  subnets: "}
                {network.subnets.join(", ")}
              </>
            )}
          </div>
        </div>
        <span className={`badge badge-${allUp ? "healthy" : "degraded"}`}>
          {allUp ? "healthy" : "degraded"}
        </span>
      </div>

      {/* Members */}
      <div style={{ marginBottom: 14 }}>
        <div className="detail-label" style={{ marginBottom: 8 }}>
          Members
        </div>
        {members.length === 0 ? (
          <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
            —
          </span>
        ) : (
          <div>
            {members.map((server) => (
              <span key={server.name} className="peer-chip">
                <span className={`peer-dot ${peerDotClass(server)}`} />
                <span>{server.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* WireGuard mesh summary */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          marginBottom: 10,
        }}
      >
        <span style={{ color: "var(--muted)" }}>WireGuard mesh:</span>
        <span
          style={{
            color: allUp ? "var(--healthy)" : "var(--degraded)",
            marginLeft: 8,
          }}
        >
          {mesh.up}/{mesh.total} peers up
        </span>
      </div>

      {/* Degraded peer warnings */}
      {mesh.degraded.map((server) => (
        <div key={server.name} className="notice notice-warn" style={{ marginBottom: 8 }}>
          <span>⚠</span>
          <span>
            peer{" "}
            <strong style={{ fontFamily: "var(--font-mono)" }}>{server.name}</strong>{" "}
            — server.status{" "}
            <strong>{server.status}</strong>
            {" (derivado do estado observado do servidor; WireGuard pode estar afetado) · verifique a saúde do servidor"}
          </span>
        </div>
      ))}

      {/* Subnets table */}
      {network.subnets.length > 0 && (
        <div className="section" style={{ marginTop: 16 }}>
          <div className="section-title" style={{ marginBottom: 10 }}>
            Subnets
          </div>
          <EntityTable
            columns={[
              {
                key: "subnet",
                header: "Subnet",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)" }}>{row.subnet}</span>
                ),
              },
              {
                key: "members",
                header: "Membros",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)" }}>{row.members}</span>
                ),
              },
            ]}
            rows={network.subnets.map((subnet) => ({
              subnet,
              members: members.length > 0 ? members.map((s) => s.name).join(", ") : "—",
            }))}
            rowKey="subnet"
          />
        </div>
      )}

      {/* Declarative membership note */}
      <div
        style={{
          marginTop: 14,
          fontSize: 12,
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        membership = label do server, declarativo — altere no manifesto para adicionar/remover members
        <Link to="/manifest" style={{ marginLeft: 8 }}>
          → editar manifesto
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network screen
// ---------------------------------------------------------------------------

export function Network() {
  const { data: state, isLoading, isError } = useStateQuery();

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Network / WireGuard</div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando redes…</p>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar redes. Tente recarregar a página.</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && state && state.networks.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Nenhuma rede configurada no manifesto.
        </p>
      )}

      {/* Network cards */}
      {!isLoading && !isError && state && state.networks.length > 0 && (
        <>
          {state.networks.map((network) => {
            const members = getMembersForNetwork(network, state.servers);
            return (
              <NetworkCard key={network.name} network={network} members={members} />
            );
          })}
        </>
      )}

      {/* "+ Network" placeholder + declarative note */}
      <div className="btn-group" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled
          aria-label="+ Network (v1: indisponível — membership é declarativa via label do server)"
          title="v1: indisponível — membership é declarativa via label do server no manifesto"
        >
          + Network
        </button>
        <span
          style={{
            fontSize: 12,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          (membership = label do server, declarativo)
        </span>
      </div>
    </div>
  );
}
