/**
 * core/src/providers/v2/hetzner-cloud-v2-http.ts
 *
 * Task 0.1 — Hetzner v2 HTTP adapter. A thin layer over the shared v1
 * `HttpClient` that exposes the four new Hetzner Cloud resource families v2
 * needs: firewalls, load_balancers, certificates, primary_ips.
 *
 * Why not the official SDK? Hetzner publishes only Go/Python SDKs — there is
 * no `@hetznercloud/hcloud` on npm. v1 already proves the pattern: compose
 * `baseUrl + "/" + collection` and call `http.request(...)`. We reuse the
 * SAME `HttpClient` (retry/backoff, Retry-After, single error taxonomy,
 * per-call timeout, no secret leakage) so this adapter inherits all of it for
 * free and adds ZERO new npm deps.
 *
 * Design principles (mirror hetzner-cloud.ts v1):
 *
 *   - NO IMPLICIT PROD DEFAULT. Both `token` and `baseUrl` must be supplied
 *     explicitly. Tests must NEVER accidentally hit the live Hetzner API.
 *   - NO SECRET LEAKAGE. The token is held ONLY to build the Authorization
 *     header (forwarded via HttpClient.defaultHeaders, which never logs).
 *   - YAGNI. Just list/get/create/update/delete per collection. Per-resource
 *     action endpoints (e.g. firewalls `apply_to_resources`) are added in the
 *     individual provider tasks (F1.3 onward), not here.
 *   - NO ZOD HERE. Each provider parses its own shapes. Returning `Response`
 *     keeps this layer 1:1 with HttpClient.
 *
 * Exported API:
 *   createHetznerV2HttpClient(opts: HetznerV2HttpOptions): HetznerV2HttpClient
 */

import { HttpClient } from "../http-client.js";

export interface HetznerV2HttpOptions {
  /** Hetzner API token. Required (non-empty). Used ONLY for Authorization. */
  readonly token: string;
  /**
   * API root, e.g. "https://api.hetzner.cloud/v1". Required (non-empty) —
   * there is no implicit production default so tests cannot accidentally hit
   * the live API. Trailing slashes are stripped (parity with v1).
   */
  readonly baseUrl: string;
  /** Injectable fetch (test seam). Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Thin resource client — `Response` is returned untouched (no Zod here). */
export interface V2ResourceClient {
  list(): Promise<Response>;
  get(id: string | number): Promise<Response>;
  create(body: unknown): Promise<Response>;
  update(id: string | number, body: unknown): Promise<Response>;
  delete(id: string | number): Promise<Response>;
}

/**
 * Firewall resource client — extends the basic CRUD with the two
 * action endpoints F1.3+ providers need (`set_rules`, `apply_to_resources`).
 * Kept on the firewalls resource ONLY (LB/Cert/PrimaryIP will grow their own
 * action helpers in their own tasks; YAGNI here).
 */
export interface V2FirewallResourceClient extends V2ResourceClient {
  setRules(id: string | number, body: unknown): Promise<Response>;
  applyToResources(id: string | number, body: unknown): Promise<Response>;
}

/**
 * PrimaryIP resource client — extends CRUD with the two action endpoints F2.3+
 * providers need (`assign`, `unassign`). Mirrors the firewall pattern: action
 * helpers live on the resource client they belong to, never widened to other
 * resources (YAGNI; LB/Cert grow their own action helpers in their own tasks).
 */
export interface V2PrimaryIpResourceClient extends V2ResourceClient {
  assign(id: string | number, body: unknown): Promise<Response>;
  unassign(id: string | number): Promise<Response>;
}

/**
 * LoadBalancer resource client — extends CRUD with the action endpoints F4.3+
 * providers need. Same YAGNI stance as firewall/primary_ip: only the endpoints
 * actually consumed by F4.3 live here (add_target/remove_target/
 * change_algorithm/update_service). add_service/delete_service/change_type
 * land in their own task when first needed (F5 ingress / recreate-tool).
 */
export interface V2LoadBalancerResourceClient extends V2ResourceClient {
  addTarget(id: string | number, body: unknown): Promise<Response>;
  removeTarget(id: string | number, body: unknown): Promise<Response>;
  changeAlgorithm(id: string | number, body: unknown): Promise<Response>;
  updateService(id: string | number, body: unknown): Promise<Response>;
  addService(id: string | number, body: unknown): Promise<Response>;
  deleteService(id: string | number, body: unknown): Promise<Response>;
}

export interface HetznerV2HttpClient {
  readonly firewalls: V2FirewallResourceClient;
  readonly loadBalancers: V2LoadBalancerResourceClient;
  readonly certificates: V2ResourceClient;
  readonly primaryIps: V2PrimaryIpResourceClient;
}

function makeResource(
  http: HttpClient,
  baseUrl: string,
  collection: string,
): V2ResourceClient {
  return {
    list: () => http.request(`${baseUrl}/${collection}`, { method: "GET" }),
    get: (id) =>
      http.request(`${baseUrl}/${collection}/${id}`, { method: "GET" }),
    create: (body) =>
      http.request(`${baseUrl}/${collection}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    update: (id, body) =>
      http.request(`${baseUrl}/${collection}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    delete: (id) =>
      http.request(`${baseUrl}/${collection}/${id}`, { method: "DELETE" }),
  };
}

export function createHetznerV2HttpClient(
  opts: HetznerV2HttpOptions,
): HetznerV2HttpClient {
  if (!opts.token) {
    throw new Error("createHetznerV2HttpClient: token is required");
  }
  if (!opts.baseUrl) {
    throw new Error(
      "createHetznerV2HttpClient: baseUrl is required (no implicit prod default)",
    );
  }
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const http = new HttpClient({
    defaultHeaders: { Authorization: `Bearer ${opts.token}` },
    fetchImpl: opts.fetchImpl,
  });
  const firewallsBase = makeResource(http, baseUrl, "firewalls");
  const firewalls: V2FirewallResourceClient = {
    ...firewallsBase,
    setRules: (id, body) =>
      http.request(`${baseUrl}/firewalls/${id}/actions/set_rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    applyToResources: (id, body) =>
      http.request(`${baseUrl}/firewalls/${id}/actions/apply_to_resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
  const primaryIpsBase = makeResource(http, baseUrl, "primary_ips");
  const primaryIps: V2PrimaryIpResourceClient = {
    ...primaryIpsBase,
    assign: (id, body) =>
      http.request(`${baseUrl}/primary_ips/${id}/actions/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    unassign: (id) =>
      http.request(`${baseUrl}/primary_ips/${id}/actions/unassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
  };
  const loadBalancersBase = makeResource(http, baseUrl, "load_balancers");
  const lbAction = (id: string | number, name: string, body: unknown) =>
    http.request(`${baseUrl}/load_balancers/${id}/actions/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const loadBalancers: V2LoadBalancerResourceClient = {
    ...loadBalancersBase,
    addTarget: (id, body) => lbAction(id, "add_target", body),
    removeTarget: (id, body) => lbAction(id, "remove_target", body),
    changeAlgorithm: (id, body) => lbAction(id, "change_algorithm", body),
    updateService: (id, body) => lbAction(id, "update_service", body),
    addService: (id, body) => lbAction(id, "add_service", body),
    deleteService: (id, body) => lbAction(id, "delete_service", body),
  };
  return {
    firewalls,
    loadBalancers,
    certificates: makeResource(http, baseUrl, "certificates"),
    primaryIps,
  };
}
