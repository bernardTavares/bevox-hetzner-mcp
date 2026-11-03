/**
 * core/test/fakes/hetzner-http-v2/firewalls.ts
 *
 * Task 1.2 — In-memory Hetzner Cloud `/firewalls/*` sub-fake. Mounted by the
 * parent `hetzner-http.ts` for any URL whose first path segment after the
 * version prefix is `firewalls`. Sufficient for the v2 Firewall provider /
 * reconciler to exercise observe + create + set_rules + apply_to_resources +
 * delete with zero network.
 *
 * Wire-compatible response shapes (Hetzner Cloud API docs):
 *   - POST   /firewalls                                  → 201 { firewall, actions }
 *   - GET    /firewalls                                  → 200 { firewalls, meta.pagination }
 *   - GET    /firewalls/:id                              → 200 { firewall }
 *   - PUT    /firewalls/:id/actions/set_rules            → 200 { actions }
 *   - POST   /firewalls/:id/actions/apply_to_resources   → 200 { actions }
 *   - DELETE /firewalls/:id                              → 204 (no body)
 *
 * Per-instance state lives in a closure created by `createFirewallStore()`;
 * the parent's `reset()` re-creates the store so isolation matches v1's model.
 * Faults (429 / 401) are owned by the parent and applied BEFORE this handler
 * is invoked — this module is purely about routing and state.
 */

interface FirewallRule {
  direction: "in" | "out";
  protocol: string;
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
}

interface AppliedTo {
  type: "server";
  server: { id: number };
}

export interface Firewall {
  id: number;
  name: string;
  labels: Record<string, string>;
  created: string;
  rules: FirewallRule[];
  applied_to: AppliedTo[];
}

interface FirewallAction {
  id: number;
  command: string;
  status: "success";
  progress: 100;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

export interface FirewallStore {
  handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null;
  reset(): void;
  /**
   * Test-only: append an out-of-band rule to an existing firewall by id WITHOUT
   * going through the wire. Models "operator/3rd-party added a rule on the
   * Hetzner side"; the v2 provider must report this as drift on the next plan
   * and never silently remove it on apply (F1.3 invariant). Returns true if
   * the firewall existed, false otherwise — silent no-op on miss keeps tests
   * declarative (the caller can assert after seeding).
   */
  injectExtraRule(id: number, rule: FirewallRule): boolean;
}

/** Build a fresh per-instance store. The parent fake owns its lifecycle. */
export function createFirewallStore(): FirewallStore {
  let firewalls = new Map<number, Firewall>();
  let firewallSeq = 0;
  let actionSeq = 0;

  function reset(): void {
    firewalls = new Map();
    firewallSeq = 0;
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

  function parseBody(init: RequestInit | undefined): Record<string, unknown> | Response {
    try {
      return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      return err(400, "invalid_input", "malformed JSON body");
    }
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function makeAction(command: string, resources: Array<{ id: number; type: string }>): FirewallAction {
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
    const all = [...firewalls.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return json(
      {
        firewalls: slice,
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

  /**
   * Route any `/firewalls...` path. Returns `null` if the path is not a known
   * firewall route so the parent can fall back (it never does today — the
   * parent only delegates known prefixes — but keeping the null return makes
   * the contract clear for future composition).
   */
  function handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null {
    const segs = url.pathname.split("/").filter(Boolean);
    // Find the "firewalls" segment; tolerate any version prefix (e.g. /v1).
    const idx = segs.lastIndexOf("firewalls");
    if (idx < 0) return null;

    const tail = segs.slice(idx + 1); // [] | [":id"] | [":id","actions","set_rules"] etc.

    // Collection-level: /firewalls
    if (tail.length === 0) {
      if (method === "GET") return listResponse(url);
      if (method === "POST") {
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        if (typeof parsed.name !== "string" || parsed.name.length === 0) {
          return err(400, "invalid_input", "missing required field: name");
        }
        const id = (firewallSeq += 1);
        const rules = Array.isArray(parsed.rules) ? (parsed.rules as FirewallRule[]) : [];
        const appliedTo = Array.isArray(parsed.apply_to)
          ? (parsed.apply_to as AppliedTo[])
          : [];
        const firewall: Firewall = {
          id,
          name: parsed.name,
          labels:
            parsed.labels && typeof parsed.labels === "object"
              ? (parsed.labels as Record<string, string>)
              : {},
          created: nowIso(),
          rules,
          applied_to: appliedTo,
        };
        firewalls.set(id, firewall);
        const resources = appliedTo.map((a) => ({ id: a.server.id, type: a.type }));
        return json(
          { firewall, actions: [makeAction("create_firewall", resources)] },
          201,
        );
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // Item-level: /firewalls/:id [...]
    const idRaw = tail[0]!;
    if (!/^\d+$/.test(idRaw)) {
      return err(404, "not_found", `unknown firewall route ${url.pathname}`);
    }
    const id = Number(idRaw);

    // /firewalls/:id (no further segments)
    if (tail.length === 1) {
      if (method === "GET") {
        const found = firewalls.get(id);
        return found
          ? json({ firewall: found }, 200)
          : err(404, "not_found", `firewall ${id} not found`);
      }
      if (method === "DELETE") {
        return firewalls.delete(id)
          ? json(null, 204)
          : err(404, "not_found", `firewall ${id} not found`);
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // /firewalls/:id/actions/<name>
    if (tail.length === 3 && tail[1] === "actions") {
      const existing = firewalls.get(id);
      if (!existing) {
        return err(404, "not_found", `firewall ${id} not found`);
      }
      const action = tail[2]!;
      const parsed = parseBody(init);
      if (parsed instanceof Response) return parsed;

      if (action === "set_rules" && method === "PUT") {
        const rules = Array.isArray(parsed.rules) ? (parsed.rules as FirewallRule[]) : [];
        firewalls.set(id, { ...existing, rules });
        return json(
          { actions: [makeAction("set_firewall_rules", [{ id, type: "firewall" }])] },
          200,
        );
      }

      if (action === "apply_to_resources" && method === "POST") {
        const appliedTo = Array.isArray(parsed.apply_to)
          ? (parsed.apply_to as AppliedTo[])
          : [];
        firewalls.set(id, { ...existing, applied_to: appliedTo });
        const resources = appliedTo.map((a) => ({ id: a.server.id, type: a.type }));
        return json(
          { actions: [makeAction("apply_firewall_to_resources", resources)] },
          200,
        );
      }

      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    return err(404, "not_found", `unknown firewall route ${url.pathname}`);
  }

  function injectExtraRule(id: number, rule: FirewallRule): boolean {
    const found = firewalls.get(id);
    if (!found) return false;
    firewalls.set(id, { ...found, rules: [...found.rules, rule] });
    return true;
  }

  return { handle, reset, injectExtraRule };
}
