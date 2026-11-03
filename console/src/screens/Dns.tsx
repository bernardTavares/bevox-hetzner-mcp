/**
 * console/src/screens/Dns.tsx
 *
 * DNS Records screen — route /dns
 * Faithful to prototype/dns.html.
 *
 * Data: useStateQuery() → GET /api/state → state.dns (DnsRecord[]).
 * Records are filtered/grouped by zone; zone selector lets user switch zones.
 *
 * Action: set_dns upsert via "+ Record" inline form:
 *   - POST /api/dns with dry_run:false (non-destructive upsert, no approval needed)
 *   - onSuccess MUST be envelope-aware (Task 15 lesson):
 *       "applied"          → refresh list / close form / show success
 *       "error"            → surface notice-error
 *       "planned"          → protocol error (set_dns must never return planned w/o dry_run:true)
 *       "pending_approval" → protocol error (set_dns is non-destructive, no approval gate)
 *
 * Hard invariants:
 *  - NO ConfirmDestructive (set_dns is non-destructive per spec/CONTRACT)
 *  - NO approval gate / NO dry_run gate
 *  - Submit button disabled while write.isPending
 *  - Errors surface via .notice-error
 */

import { useState } from "react";
import { useStateQuery, useWrite } from "../api/query";
import { EntityTable } from "../components/EntityTable";
import { errorMessage } from "../lib/errors";
import type { DnsRecord } from "../api/contract";

// ---------------------------------------------------------------------------
// Module-scope columns (no component-closure deps — stable ref, no re-creation)
// ---------------------------------------------------------------------------

const columns: Array<{
  key: keyof DnsRecord & string;
  header: string;
  render?: (row: DnsRecord) => React.ReactNode;
}> = [
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <span style={{ fontFamily: "var(--font-mono)" }}>{row.name}</span>
    ),
  },
  {
    key: "type",
    header: "Tipo",
    render: (row) => (
      <span className="badge badge-pending" style={{ fontSize: 11 }}>
        {row.type}
      </span>
    ),
  },
  {
    key: "value",
    header: "Valor",
    render: (row) => (
      <span style={{ fontFamily: "var(--font-mono)" }}>→ {row.value}</span>
    ),
  },
  {
    key: "ttl",
    header: "TTL",
    render: (row) => (
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
        {row.ttl}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Dns screen
// ---------------------------------------------------------------------------

export function Dns() {
  const { data: state, isLoading, isError } = useStateQuery();
  const write = useWrite();

  // All zones from current records
  const allZones = Array.from(
    new Set((state?.dns ?? []).map((r) => r.zone)),
  ).sort();

  // Selected zone (default to first zone in data)
  const [selectedZone, setSelectedZone] = useState<string>("");

  // Determine effective zone
  const effectiveZone =
    selectedZone && allZones.includes(selectedZone)
      ? selectedZone
      : allZones[0] ?? "";

  // Records for the selected zone
  const records = (state?.dns ?? []).filter((r) => r.zone === effectiveZone);

  // ---------------------------------------------------------------------------
  // Inline upsert form state
  // ---------------------------------------------------------------------------

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("A");
  const [formValue, setFormValue] = useState("");
  const [formTtl, setFormTtl] = useState("300");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState(false);

  function resetForm() {
    setFormName("");
    setFormType("A");
    setFormValue("");
    setFormTtl("300");
    setFormError(null);
    setFormSuccess(false);
  }

  function handleOpenForm() {
    resetForm();
    setShowForm(true);
  }

  function handleCancelForm() {
    setShowForm(false);
    resetForm();
  }

  // ---------------------------------------------------------------------------
  // set_dns submit handler — envelope-aware onSuccess (Task 15 lesson)
  // ---------------------------------------------------------------------------

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(false);

    // TTL validation: NaN → default 300; valid but < 60 → validation error (do not submit)
    const parsedTtl = parseInt(formTtl, 10);
    const ttl = Number.isNaN(parsedTtl) ? 300 : parsedTtl;
    if (!Number.isNaN(parsedTtl) && ttl < 60) {
      setFormError("TTL mínimo 60");
      return;
    }

    write.mutate(
      {
        path: "/api/dns",
        body: {
          zone: effectiveZone,
          name: formName,
          type: formType,
          value: formValue,
          ttl,
          dry_run: false,
        },
      },
      {
        onSuccess: (env) => {
          if (env.status === "applied") {
            // Non-destructive upsert applied: close form + show success notice briefly
            setShowForm(false);
            resetForm();
            setFormSuccess(true);
          } else if (env.status === "error") {
            // Envelope-aware: HTTP 200 status:error must surface as error
            const msg = env.error
              ? env.error.message || env.error.code
              : "Erro desconhecido";
            setFormError(msg);
          } else {
            // "planned" or "pending_approval" must never occur for set_dns (non-destructive)
            setFormError(
              `[inesperado] set_dns retornou "${env.status}" — erro de protocolo`,
            );
          }
        },
        onError: (err) => {
          setFormError(errorMessage(err));
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="page">
      {/* Page title */}
      <div className="page-title">DNS Records</div>

      {/* Loading state */}
      {isLoading && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Carregando registros DNS…
        </p>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="notice notice-error">
          <span>✕</span>
          <span>Erro ao carregar registros DNS. Tente recarregar a página.</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && state && state.dns.length === 0 && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Nenhum registro DNS configurado.
        </p>
      )}

      {/* DNS records (loaded) */}
      {!isLoading && !isError && state && state.dns.length > 0 && (
        <>
          {/* Zone selector bar — faithful to prototype */}
          <div className="zone-bar" style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>zone:</span>
            <select
              className="filter-select"
              style={{ fontSize: 13, marginLeft: 6 }}
              value={effectiveZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              aria-label="Zone selector"
            >
              {allZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <span
              style={{
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: "var(--muted)",
                marginLeft: 8,
              }}
            >
              {records.length} registros
            </span>
          </div>

          {/* Records section */}
          <div className="section">
            <div className="section-header">
              <span className="section-title">{effectiveZone}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleOpenForm}
                disabled={write.isPending}
              >
                + Record
              </button>
            </div>

            {/* Records table via EntityTable */}
            <EntityTable<DnsRecord>
              columns={columns}
              rows={records}
              rowKeyFn={(row, index) =>
                `${row.zone}-${row.name}-${row.type}-${index}`
              }
            />
          </div>

          {/* Inline upsert form — reveals on "+ Record" click */}
          {showForm && (
            <div
              className="detail-card"
              style={{ marginTop: 16 }}
              aria-label="DNS upsert form"
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 700,
                  marginBottom: 12,
                }}
              >
                Upsert DNS Record — {effectiveZone}
              </div>

              <form onSubmit={handleSubmit}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 100px 1fr 100px",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  {/* Name */}
                  <div>
                    <label
                      htmlFor="dns-name"
                      style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}
                    >
                      Name
                    </label>
                    <input
                      id="dns-name"
                      name="name"
                      type="text"
                      className="filter-input"
                      placeholder="name"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      required
                      style={{ width: "100%", boxSizing: "border-box" }}
                      aria-label="Name"
                    />
                  </div>

                  {/* Type */}
                  <div>
                    <label
                      htmlFor="dns-type"
                      style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}
                    >
                      Type
                    </label>
                    <select
                      id="dns-type"
                      name="type"
                      className="filter-select"
                      value={formType}
                      onChange={(e) => setFormType(e.target.value)}
                      style={{ width: "100%" }}
                      aria-label="Type"
                    >
                      <option value="A">A</option>
                      <option value="AAAA">AAAA</option>
                      <option value="CNAME">CNAME</option>
                      <option value="MX">MX</option>
                      <option value="TXT">TXT</option>
                      <option value="NS">NS</option>
                    </select>
                  </div>

                  {/* Value */}
                  <div>
                    <label
                      htmlFor="dns-value"
                      style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}
                    >
                      Value
                    </label>
                    <input
                      id="dns-value"
                      name="value"
                      type="text"
                      className="filter-input"
                      placeholder="value"
                      value={formValue}
                      onChange={(e) => setFormValue(e.target.value)}
                      required
                      style={{ width: "100%", boxSizing: "border-box" }}
                      aria-label="Value"
                    />
                  </div>

                  {/* TTL */}
                  <div>
                    <label
                      htmlFor="dns-ttl"
                      style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}
                    >
                      TTL
                    </label>
                    <input
                      id="dns-ttl"
                      name="ttl"
                      type="number"
                      className="filter-input"
                      placeholder="300"
                      value={formTtl}
                      onChange={(e) => setFormTtl(e.target.value)}
                      min={60}
                      style={{ width: "100%", boxSizing: "border-box" }}
                      aria-label="TTL"
                    />
                  </div>
                </div>

                {/* Form error notice */}
                {formError && (
                  <div className="notice notice-error" role="alert" style={{ marginBottom: 10 }}>
                    <span>✕</span>
                    <div style={{ flex: 1 }}>{formError}</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setFormError(null)}
                      style={{ alignSelf: "flex-start", padding: "0 6px" }}
                      aria-label="Dismiss error"
                    >
                      ×
                    </button>
                  </div>
                )}

                {/* Buttons */}
                <div className="btn-group">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={write.isPending}
                    aria-label="Submit DNS record"
                  >
                    {write.isPending ? "Salvando…" : "Salvar"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleCancelForm}
                    disabled={write.isPending}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Success notice — shown after applied response */}
          {formSuccess && (
            <div className="notice notice-info" style={{ marginTop: 12 }}>
              <span>✓</span>
              <div style={{ flex: 1 }}>Registro DNS aplicado com sucesso.</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFormSuccess(false)}
                style={{ alignSelf: "flex-start", padding: "0 6px" }}
                aria-label="Dismiss success"
              >
                ×
              </button>
            </div>
          )}
        </>
      )}

      {/* Footer note — faithful to prototype: "set_dns: upsert, sem approval" */}
      <div
        style={{
          fontSize: 12,
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
          marginTop: 16,
        }}
      >
        set_dns: upsert, sem approval — mudanças de DNS aplicadas diretamente sem
        Approval Gate
      </div>
    </div>
  );
}
