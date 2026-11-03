/**
 * console/src/screens/Secrets.tsx
 *
 * Secrets screen — route /secrets
 * Faithful to prototype/secrets.html.
 *
 * SECURITY INVARIANT: This screen NEVER renders secret values.
 * It only displays reference names, key counts, and which services use each secret.
 * Secret values are resolved by the reconciler at apply time and are never
 * transmitted to the Console in any form.
 *
 * Data: useSecrets() → GET /api/secrets
 *
 * "+ Novo secret" and "Rotacionar = recriar service" are NON-FUNCTIONAL
 * placeholders for v1. Creating or rotating secrets is out of v1 scope and
 * would require transmitting secret values — which violates the invariant above.
 * These are rendered as clearly-disabled buttons with an honest "v1: indisponível"
 * affordance so operators know they are placeholders, not broken features.
 */

import { useSecrets } from "../api/query";
import type { Secret } from "../api/contract";
import { EntityTable } from "../components/EntityTable";

// ---------------------------------------------------------------------------
// Column definitions — no value column, ever
// ---------------------------------------------------------------------------

const secretColumns = [
  {
    key: "name" as const,
    header: "Referência",
    render: (secret: Secret) => (
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
        secret:{secret.name}
      </span>
    ),
  },
  {
    key: "keys" as const,
    header: "Chaves",
    render: (secret: Secret) => (
      <span style={{ fontFamily: "var(--font-mono)" }}>
        {secret.keys} chave{secret.keys !== 1 ? "s" : ""}
      </span>
    ),
  },
  {
    key: "used_by" as const,
    header: "Usado por",
    render: (secret: Secret) => {
      if (secret.used_by.length === 0) {
        return <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>;
      }
      const count = secret.used_by.length;
      const label = count === 1 ? "service" : "services";
      return (
        <>
          {secret.used_by.map((svc) => (
            <span key={svc} style={{ display: "block" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{svc}</span>
              <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 4 }}>
                ({count} {label})
              </span>
            </span>
          ))}
        </>
      );
    },
  },
  {
    key: "name" as const,
    id: "acoes",
    header: "Ações",
    render: (secret: Secret) => (
      /* Rotacionar = recriar service — NON-FUNCTIONAL placeholder (v1: indisponível) */
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled
        aria-label={`Rotacionar secret:${secret.name} (v1: indisponível)`}
        title="v1: indisponível — rotação de secrets está fora do escopo v1"
      >
        [Rotacionar = recriar service]
      </button>
    ),
  },
];

// ---------------------------------------------------------------------------
// Secrets screen
// ---------------------------------------------------------------------------

export function Secrets() {
  const { data: secrets, isLoading, isError } = useSecrets();

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">Secrets</div>

      {/* Store note — faithful to prototype */}
      <div className="notice notice-info" style={{ marginBottom: 20 }}>
        <span>ℹ</span>
        <span>
          store:{" "}
          <strong style={{ fontFamily: "var(--font-mono)" }}>age/sops (v1)</strong>{" "}
          — secrets encriptados em repouso. Chaves resolvidas pelo reconciler no momento do apply.
        </span>
      </div>

      {/* Security warning — "Valores nunca exibidos" */}
      <div className="notice notice-warn" style={{ marginBottom: 20 }}>
        <span>⚠</span>
        <span>
          <strong>Valores nunca exibidos</strong> — esta tela exibe apenas referências, nomes e
          contagem de chaves. Os valores são resolvidos no apply (reconciler) e nunca expostos na
          interface.
        </span>
      </div>

      {/* Secrets list */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Secrets</span>
          {/* "+ Novo secret" — NON-FUNCTIONAL placeholder (v1: indisponível) */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled
            aria-label="Novo secret (v1: indisponível)"
            title="v1: indisponível — criação de secrets está fora do escopo v1"
          >
            + Novo secret
          </button>
        </div>

        {/* Loading state */}
        {isLoading && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Carregando secrets…</p>
        )}

        {/* Error state */}
        {isError && !isLoading && (
          <div className="notice notice-error">
            <span>✕</span>
            <span>Erro ao carregar secrets. Tente recarregar a página.</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && secrets && secrets.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Nenhum secret registrado no manifesto.
          </p>
        )}

        {/* Secret table via EntityTable — no value column, ever */}
        {!isLoading && !isError && secrets && secrets.length > 0 && (
          <EntityTable
            columns={secretColumns}
            rows={secrets}
            rowKey="name"
          />
        )}
      </div>

      {/* Footer safety notice — faithful to prototype */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--muted)",
          padding: "12px 0",
          borderTop: "1px solid var(--border)",
        }}
      >
        ⚠ valores nunca exibidos · resolvidos no apply (reconciler) · armazenados encriptados com
        age/sops
      </div>
    </div>
  );
}
