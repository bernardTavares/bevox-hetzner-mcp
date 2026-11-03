/**
 * core/test/fakes/hetzner-http-v2/load-balancers.ts
 *
 * Task 4.2 — In-memory Hetzner Cloud `/load_balancers/*` sub-fake. Mounted by
 * the parent `hetzner-http.ts` for any URL containing a `load_balancers`
 * segment. Sufficient for the v2 LoadBalancer provider / reconciler to
 * exercise observe + create + update + targets + services + algorithm/type
 * changes + delete with zero network.
 *
 * Wire-compatible response shapes (Hetzner Cloud API docs):
 *   - POST   /load_balancers                                     → 201 { load_balancer, action }
 *   - GET    /load_balancers                                     → 200 { load_balancers, meta.pagination }
 *   - GET    /load_balancers/:id                                 → 200 { load_balancer }
 *   - PUT    /load_balancers/:id                                 → 200 { load_balancer } (name, labels only)
 *   - DELETE /load_balancers/:id                                 → 204
 *   - POST   /load_balancers/:id/actions/add_target              → 200 { action }
 *   - POST   /load_balancers/:id/actions/remove_target           → 200 { action }
 *   - POST   /load_balancers/:id/actions/change_algorithm        → 200 { action }
 *   - POST   /load_balancers/:id/actions/add_service             → 200 { action }
 *   - POST   /load_balancers/:id/actions/update_service          → 200 { action }
 *   - POST   /load_balancers/:id/actions/delete_service          → 200 { action }
 *   - POST   /load_balancers/:id/actions/change_type             → 200 { action }
 *
 * Per-instance state lives in a closure created by `createLoadBalancerStore()`;
 * the parent's `reset()` re-creates the store so isolation matches the v1
 * model. Faults (429 / 401) are owned by the parent and applied BEFORE this
 * handler is invoked — this module is purely about routing and state.
 */

export interface LbHealthCheck {
  protocol: string;
  port: number;
  interval: number;
  timeout: number;
  retries: number;
  http?: { path?: string };
}

export interface LbService {
  protocol: string;
  listen_port: number;
  destination_port: number;
  health_check: LbHealthCheck;
}

export interface LbTarget {
  type: string;
  server?: { id: number };
  label_selector?: { selector: string };
  ip?: { ip: string };
}

export interface LoadBalancer {
  id: number;
  name: string;
  load_balancer_type: { name: string };
  location: { name: string };
  algorithm: { type: string };
  services: LbService[];
  targets: LbTarget[];
  labels: Record<string, string>;
  public_net: {
    enabled: boolean;
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
  created: string;
}

interface LbAction {
  id: number;
  command: string;
  status: "success";
  progress: 100;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

export interface LoadBalancerStore {
  handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null;
  reset(): void;
}

/** Build a fresh per-instance store. The parent fake owns its lifecycle. */
export function createLoadBalancerStore(): LoadBalancerStore {
  let lbs = new Map<number, LoadBalancer>();
  let lbSeq = 0;
  let actionSeq = 0;

  function reset(): void {
    lbs = new Map();
    lbSeq = 0;
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
  ): LbAction {
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
    const all = [...lbs.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return json(
      {
        load_balancers: slice,
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

  /** Synthesise deterministic public IPs from the monotonic id. */
  function synthIpv4(id: number): string {
    const last = ((id - 1) % 254) + 1;
    return `203.0.113.${last}`;
  }
  function synthIpv6(id: number): string {
    return `2001:db8::${id.toString(16)}`;
  }

  function readLabels(raw: unknown): Record<string, string> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, string>;
    }
    return {};
  }

  function readLbType(raw: unknown, fallback: string): string {
    if (typeof raw === "string" && raw.length > 0) return raw;
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      typeof (raw as Record<string, unknown>).name === "string"
    ) {
      return (raw as { name: string }).name;
    }
    return fallback;
  }

  function readAlgorithm(raw: unknown): { type: string } {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const t = (raw as Record<string, unknown>).type;
      if (typeof t === "string" && t.length > 0) return { type: t };
    }
    return { type: "round_robin" };
  }

  function readHealthCheck(raw: unknown): LbHealthCheck {
    const fallback: LbHealthCheck = {
      protocol: "tcp",
      port: 80,
      interval: 15,
      timeout: 10,
      retries: 3,
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
    const r = raw as Record<string, unknown>;
    const hc: LbHealthCheck = {
      protocol: typeof r.protocol === "string" ? r.protocol : fallback.protocol,
      port: typeof r.port === "number" ? r.port : fallback.port,
      interval:
        typeof r.interval === "number" ? r.interval : fallback.interval,
      timeout: typeof r.timeout === "number" ? r.timeout : fallback.timeout,
      retries: typeof r.retries === "number" ? r.retries : fallback.retries,
    };
    if (r.http && typeof r.http === "object" && !Array.isArray(r.http)) {
      const h = r.http as Record<string, unknown>;
      hc.http = typeof h.path === "string" ? { path: h.path } : {};
    }
    return hc;
  }

  function readService(raw: Record<string, unknown>): LbService {
    return {
      protocol: typeof raw.protocol === "string" ? raw.protocol : "tcp",
      listen_port:
        typeof raw.listen_port === "number" ? raw.listen_port : 0,
      destination_port:
        typeof raw.destination_port === "number" ? raw.destination_port : 0,
      health_check: readHealthCheck(raw.health_check),
    };
  }

  function readTarget(raw: Record<string, unknown>): LbTarget {
    const t: LbTarget = {
      type: typeof raw.type === "string" ? raw.type : "server",
    };
    if (
      raw.server &&
      typeof raw.server === "object" &&
      !Array.isArray(raw.server) &&
      typeof (raw.server as Record<string, unknown>).id === "number"
    ) {
      t.server = { id: (raw.server as { id: number }).id };
    }
    if (
      raw.label_selector &&
      typeof raw.label_selector === "object" &&
      !Array.isArray(raw.label_selector)
    ) {
      const s = (raw.label_selector as Record<string, unknown>).selector;
      if (typeof s === "string") t.label_selector = { selector: s };
    }
    if (
      raw.ip &&
      typeof raw.ip === "object" &&
      !Array.isArray(raw.ip) &&
      typeof (raw.ip as Record<string, unknown>).ip === "string"
    ) {
      t.ip = { ip: (raw.ip as { ip: string }).ip };
    }
    return t;
  }

  function targetMatches(a: LbTarget, b: LbTarget): boolean {
    if (a.type !== b.type) return false;
    if (a.type === "server") {
      return (a.server?.id ?? -1) === (b.server?.id ?? -2);
    }
    if (a.type === "label_selector") {
      return (
        (a.label_selector?.selector ?? "") ===
        (b.label_selector?.selector ?? "_")
      );
    }
    if (a.type === "ip") {
      return (a.ip?.ip ?? "") === (b.ip?.ip ?? "_");
    }
    return false;
  }

  /**
   * Route any `/load_balancers...` path. Returns `null` if the path is not a
   * known LB route so the parent can fall back.
   */
  function handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null {
    const segs = url.pathname.split("/").filter(Boolean);
    const idx = segs.lastIndexOf("load_balancers");
    if (idx < 0) return null;

    const tail = segs.slice(idx + 1);

    // Collection-level: /load_balancers
    if (tail.length === 0) {
      if (method === "GET") return listResponse(url);
      if (method === "POST") {
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        if (typeof parsed.name !== "string" || parsed.name.length === 0) {
          return err(400, "invalid_input", "missing required field: name");
        }
        const lbType = readLbType(parsed.load_balancer_type, "lb11");
        const location =
          typeof parsed.location === "string" && parsed.location.length > 0
            ? parsed.location
            : "fsn1";
        const id = (lbSeq += 1);
        const services = Array.isArray(parsed.services)
          ? (parsed.services as unknown[])
              .filter(
                (s): s is Record<string, unknown> =>
                  !!s && typeof s === "object" && !Array.isArray(s),
              )
              .map(readService)
          : [];
        const targets = Array.isArray(parsed.targets)
          ? (parsed.targets as unknown[])
              .filter(
                (t): t is Record<string, unknown> =>
                  !!t && typeof t === "object" && !Array.isArray(t),
              )
              .map(readTarget)
          : [];
        const lb: LoadBalancer = {
          id,
          name: parsed.name,
          load_balancer_type: { name: lbType },
          location: { name: location },
          algorithm: readAlgorithm(parsed.algorithm),
          services,
          targets,
          labels: readLabels(parsed.labels),
          public_net: {
            enabled: true,
            ipv4: { ip: synthIpv4(id) },
            ipv6: { ip: synthIpv6(id) },
          },
          created: nowIso(),
        };
        lbs.set(id, lb);
        return json(
          {
            load_balancer: lb,
            action: makeAction("create_load_balancer", [
              { id, type: "load_balancer" },
            ]),
          },
          201,
        );
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // Item-level: /load_balancers/:id [...]
    const idRaw = tail[0]!;
    if (!/^\d+$/.test(idRaw)) {
      return err(404, "not_found", `unknown load_balancer route ${url.pathname}`);
    }
    const id = Number(idRaw);

    // /load_balancers/:id (no further segments)
    if (tail.length === 1) {
      if (method === "GET") {
        const found = lbs.get(id);
        return found
          ? json({ load_balancer: found }, 200)
          : err(404, "not_found", `load_balancer ${id} not found`);
      }
      if (method === "PUT") {
        const existing = lbs.get(id);
        if (!existing) {
          return err(404, "not_found", `load_balancer ${id} not found`);
        }
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        const updated: LoadBalancer = {
          ...existing,
          name:
            typeof parsed.name === "string" && parsed.name.length > 0
              ? parsed.name
              : existing.name,
          labels:
            parsed.labels !== undefined
              ? readLabels(parsed.labels)
              : existing.labels,
        };
        lbs.set(id, updated);
        return json({ load_balancer: updated }, 200);
      }
      if (method === "DELETE") {
        return lbs.delete(id)
          ? json(null, 204)
          : err(404, "not_found", `load_balancer ${id} not found`);
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // /load_balancers/:id/actions/<name>
    if (tail.length === 3 && tail[1] === "actions") {
      const existing = lbs.get(id);
      if (!existing) {
        return err(404, "not_found", `load_balancer ${id} not found`);
      }
      const action = tail[2]!;
      const parsed = parseBody(init);
      if (parsed instanceof Response) return parsed;
      if (method !== "POST") {
        return err(405, "method_not_allowed", `${method} ${url.pathname}`);
      }

      if (action === "add_target") {
        const target = readTarget(parsed);
        const next: LoadBalancer = {
          ...existing,
          targets: [...existing.targets, target],
        };
        lbs.set(id, next);
        const resources =
          target.type === "server" && target.server
            ? [{ id: target.server.id, type: "server" }]
            : [{ id, type: "load_balancer" }];
        return json({ action: makeAction("add_target", resources) }, 200);
      }

      if (action === "remove_target") {
        const target = readTarget(parsed);
        const next: LoadBalancer = {
          ...existing,
          targets: existing.targets.filter((t) => !targetMatches(t, target)),
        };
        lbs.set(id, next);
        const resources =
          target.type === "server" && target.server
            ? [{ id: target.server.id, type: "server" }]
            : [{ id, type: "load_balancer" }];
        return json({ action: makeAction("remove_target", resources) }, 200);
      }

      if (action === "change_algorithm") {
        const algo = readAlgorithm(parsed);
        lbs.set(id, { ...existing, algorithm: algo });
        return json(
          {
            action: makeAction("change_algorithm", [
              { id, type: "load_balancer" },
            ]),
          },
          200,
        );
      }

      if (action === "add_service") {
        const svc = readService(parsed);
        lbs.set(id, { ...existing, services: [...existing.services, svc] });
        return json(
          {
            action: makeAction("add_service", [
              { id, type: "load_balancer" },
            ]),
          },
          200,
        );
      }

      if (action === "update_service") {
        const port =
          typeof parsed.listen_port === "number" ? parsed.listen_port : -1;
        const svc = readService(parsed);
        const services = existing.services.map((s) =>
          s.listen_port === port ? svc : s,
        );
        lbs.set(id, { ...existing, services });
        return json(
          {
            action: makeAction("update_service", [
              { id, type: "load_balancer" },
            ]),
          },
          200,
        );
      }

      if (action === "delete_service") {
        const port =
          typeof parsed.listen_port === "number" ? parsed.listen_port : -1;
        const services = existing.services.filter(
          (s) => s.listen_port !== port,
        );
        lbs.set(id, { ...existing, services });
        return json(
          {
            action: makeAction("delete_service", [
              { id, type: "load_balancer" },
            ]),
          },
          200,
        );
      }

      if (action === "change_type") {
        const newType = readLbType(
          parsed.load_balancer_type,
          existing.load_balancer_type.name,
        );
        lbs.set(id, {
          ...existing,
          load_balancer_type: { name: newType },
        });
        return json(
          {
            action: makeAction("change_type", [
              { id, type: "load_balancer" },
            ]),
          },
          200,
        );
      }

      return err(404, "not_found", `unknown action ${action}`);
    }

    return err(404, "not_found", `unknown load_balancer route ${url.pathname}`);
  }

  return { handle, reset };
}
