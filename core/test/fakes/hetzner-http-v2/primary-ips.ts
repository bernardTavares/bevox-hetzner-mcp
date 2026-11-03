/**
 * core/test/fakes/hetzner-http-v2/primary-ips.ts
 *
 * Task 2.2 — In-memory Hetzner Cloud `/primary_ips/*` sub-fake. Mounted by the
 * parent `hetzner-http.ts` for any URL containing a `primary_ips` segment.
 * Sufficient for the v2 PrimaryIP provider / reconciler to exercise observe +
 * create + update + assign + unassign + delete with zero network.
 *
 * Wire-compatible response shapes (Hetzner Cloud API docs):
 *   - POST   /primary_ips                                  → 201 { primary_ip, action }
 *   - GET    /primary_ips                                  → 200 { primary_ips, meta.pagination }
 *   - GET    /primary_ips/:id                              → 200 { primary_ip }
 *   - PUT    /primary_ips/:id                              → 200 { primary_ip }
 *   - DELETE /primary_ips/:id                              → 204 (no body)
 *   - POST   /primary_ips/:id/actions/assign               → 200 { action }
 *   - POST   /primary_ips/:id/actions/unassign             → 200 { action }
 *
 * Per-instance state lives in a closure created by `createPrimaryIpStore()`;
 * the parent's `reset()` re-creates the store so isolation matches the v1
 * model. Faults (429 / 401) are owned by the parent and applied BEFORE this
 * handler is invoked — this module is purely about routing and state.
 */

export interface PrimaryIp {
  id: number;
  name: string;
  type: string;
  ip: string;
  datacenter: { name: string };
  assignee_type: string | null;
  assignee_id: number | null;
  labels: Record<string, string>;
  auto_delete: boolean;
  created: string;
}

interface PrimaryIpAction {
  id: number;
  command: string;
  status: "success";
  progress: 100;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

export interface PrimaryIpStore {
  handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null;
  reset(): void;
}

/** Build a fresh per-instance store. The parent fake owns its lifecycle. */
export function createPrimaryIpStore(): PrimaryIpStore {
  let primaryIps = new Map<number, PrimaryIp>();
  let primaryIpSeq = 0;
  let actionSeq = 0;

  function reset(): void {
    primaryIps = new Map();
    primaryIpSeq = 0;
    actionSeq = 0;
  }

  function json(body: unknown, status: number): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function err(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
  }

  function parseBody(
    init: RequestInit | undefined,
  ): Record<string, unknown> | Response {
    try {
      return init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
    } catch {
      return err(400, "invalid_input", "malformed JSON body");
    }
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function makeAction(
    command: string,
    resources: Array<{ id: number; type: string }>,
  ): PrimaryIpAction {
    actionSeq += 1;
    const ts = nowIso();
    return {
      id: actionSeq,
      command,
      status: "success",
      progress: 100,
      started: ts,
      finished: ts,
      resources,
      error: null,
    };
  }

  function clampInt(raw: string | null, fallback: number): number {
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  function listResponse(url: URL): Response {
    const all = [...primaryIps.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return json(
      {
        primary_ips: slice,
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: page < lastPage ? page + 1 : null,
            last_page: lastPage,
            total_entries: all.length,
          },
        },
      },
      200,
    );
  }

  /** Synthesise a deterministic IP for the given monotonic id. */
  function synthIp(id: number, type: string): string {
    if (type === "ipv6") return `2001:db8::${id.toString(16)}`;
    // Wrap inside 203.0.113.0/24 (RFC 5737 doc range) for ipv4.
    const last = ((id - 1) % 254) + 1;
    return `203.0.113.${last}`;
  }

  function readLabels(raw: unknown): Record<string, string> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, string>;
    }
    return {};
  }

  function readAssigneeType(raw: unknown): string | null {
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  }

  function readAssigneeId(raw: unknown): number | null {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }

  /**
   * Route any `/primary_ips...` path. Returns `null` if the path is not a known
   * primary_ip route so the parent can fall back (keeps the contract clear for
   * future composition).
   */
  function handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null {
    const segs = url.pathname.split("/").filter(Boolean);
    const idx = segs.lastIndexOf("primary_ips");
    if (idx < 0) return null;

    const tail = segs.slice(idx + 1);

    // Collection-level: /primary_ips
    if (tail.length === 0) {
      if (method === "GET") return listResponse(url);
      if (method === "POST") {
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        if (typeof parsed.name !== "string" || parsed.name.length === 0) {
          return err(400, "invalid_input", "missing required field: name");
        }
        const type =
          typeof parsed.type === "string" && parsed.type.length > 0
            ? parsed.type
            : "ipv4";
        const datacenter =
          typeof parsed.datacenter === "string" && parsed.datacenter.length > 0
            ? parsed.datacenter
            : "fsn1-dc14";
        const id = (primaryIpSeq += 1);
        const primary_ip: PrimaryIp = {
          id,
          name: parsed.name,
          type,
          ip: synthIp(id, type),
          datacenter: { name: datacenter },
          assignee_type: readAssigneeType(parsed.assignee_type),
          assignee_id: readAssigneeId(parsed.assignee_id),
          labels: readLabels(parsed.labels),
          auto_delete:
            typeof parsed.auto_delete === "boolean" ? parsed.auto_delete : false,
          created: nowIso(),
        };
        primaryIps.set(id, primary_ip);
        const resources = primary_ip.assignee_id !== null
          ? [{ id: primary_ip.assignee_id, type: primary_ip.assignee_type ?? "server" }]
          : [];
        return json(
          { primary_ip, action: makeAction("create_primary_ip", resources) },
          201,
        );
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // Item-level: /primary_ips/:id [...]
    const idRaw = tail[0]!;
    if (!/^\d+$/.test(idRaw)) {
      return err(404, "not_found", `unknown primary_ip route ${url.pathname}`);
    }
    const id = Number(idRaw);

    // /primary_ips/:id (no further segments)
    if (tail.length === 1) {
      if (method === "GET") {
        const found = primaryIps.get(id);
        return found
          ? json({ primary_ip: found }, 200)
          : err(404, "not_found", `primary_ip ${id} not found`);
      }
      if (method === "PUT") {
        const existing = primaryIps.get(id);
        if (!existing) {
          return err(404, "not_found", `primary_ip ${id} not found`);
        }
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        const updated: PrimaryIp = {
          ...existing,
          name:
            typeof parsed.name === "string" && parsed.name.length > 0
              ? parsed.name
              : existing.name,
          labels:
            parsed.labels !== undefined ? readLabels(parsed.labels) : existing.labels,
          auto_delete:
            typeof parsed.auto_delete === "boolean"
              ? parsed.auto_delete
              : existing.auto_delete,
        };
        primaryIps.set(id, updated);
        return json({ primary_ip: updated }, 200);
      }
      if (method === "DELETE") {
        return primaryIps.delete(id)
          ? json(null, 204)
          : err(404, "not_found", `primary_ip ${id} not found`);
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // /primary_ips/:id/actions/<name>
    if (tail.length === 3 && tail[1] === "actions") {
      const existing = primaryIps.get(id);
      if (!existing) {
        return err(404, "not_found", `primary_ip ${id} not found`);
      }
      const action = tail[2]!;
      const parsed = parseBody(init);
      if (parsed instanceof Response) return parsed;

      if (action === "assign" && method === "POST") {
        const assigneeType = readAssigneeType(parsed.assignee_type) ?? "server";
        const assigneeId = readAssigneeId(parsed.assignee_id);
        if (assigneeId === null) {
          return err(400, "invalid_input", "missing required field: assignee_id");
        }
        primaryIps.set(id, {
          ...existing,
          assignee_type: assigneeType,
          assignee_id: assigneeId,
        });
        return json(
          {
            action: makeAction("assign_primary_ip", [
              { id: assigneeId, type: assigneeType },
            ]),
          },
          200,
        );
      }

      if (action === "unassign" && method === "POST") {
        primaryIps.set(id, {
          ...existing,
          assignee_type: null,
          assignee_id: null,
        });
        return json(
          {
            action: makeAction("unassign_primary_ip", [
              { id, type: "primary_ip" },
            ]),
          },
          200,
        );
      }

      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    return err(404, "not_found", `unknown primary_ip route ${url.pathname}`);
  }

  return { handle, reset };
}
