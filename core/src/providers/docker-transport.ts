/**
 * core/src/providers/docker-transport.ts
 *
 * The DockerTransport seam — OWNED BY src/, not by a test fake.
 *
 * PORT-OWNERSHIP DISCIPLINE (same rule as provider.ts / errors.ts headers:
 * production code must not import from `test/`). DockerProvider (docker.ts)
 * is written purely against this seam. The contract therefore lives here, in
 * the production tree, next to its only consumer. Implementations live
 * elsewhere and depend INWARD on this file:
 *
 *   - core/test/fakes/docker-http.ts  — the in-process deterministic fake
 *     used by every Fase-3 test (implements this interface, type-only import).
 *   - a future `ssh2`-backed live Engine client (Fase 3+/5) — implements the
 *     SAME interface unchanged, so the provider stays transport-agnostic.
 *
 * THE SSH-TUNNEL SHAPE (why method+path+body, not `fetch(url)`):
 *
 *   The real provider reaches the Docker Engine API on a remote host through
 *   an SSH tunnel, NOT a public URL. Over a tunnel the Engine API is
 *   HTTP-over-a-forwarded-stream: there is no DNS host, no TLS, no origin —
 *   you speak to Engine API *paths* (`/containers/create`,
 *   `/containers/{id}/start`, …) through an already-established connection.
 *   Modelling that as a `fetch(url)` seam would smuggle in a URL/origin that
 *   does not exist on a tunnel. So the honest seam is exactly the bytes that
 *   cross the tunnel: method + path + optional JSON body → { status, json }.
 *
 * Exported API:
 *   interface DockerResponse  — one Engine API response over the tunnel
 *   interface DockerTransport — the seam DockerProvider is written against
 */

/** One Engine API response as it would arrive over the tunnel. */
export interface DockerResponse {
  /** HTTP-ish status the Engine API returned (200/201/204/404/409/500). */
  readonly status: number;
  /** Parsed JSON body (`null` for empty 204-style responses). */
  readonly json: unknown;
}

/**
 * The seam DockerProvider (3.2) is written against. `path` is an Engine API
 * path (e.g. `/containers/create`, `/containers/{id}/start`), NOT a URL — the
 * tunnel has no origin. The fake and a future `ssh2`-backed transport
 * implement this exact interface so the provider stays transport-agnostic.
 *
 * SECRET-BOUNDARY CONTRACT (spec §SECRET BOUNDARY; binds every
 * implementation, especially the future real ssh2-backed transport):
 * implementations MUST NOT include the request `body` — in whole or in
 * part — in error messages, promise rejections, retry logs, or debug logs.
 * At apply time the `/containers/create` body may carry RESOLVED secret
 * values in the container `Env`; echoing the body anywhere observable would
 * leak them past the apply-only resolution gate. Surface only
 * method + path + status on any failure or diagnostic path.
 */
export interface DockerTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    /**
     * OPTIONAL sensitive headers (e.g. `X-Registry-Auth`, Bug 11). The
     * secret-boundary contract above extends to these: implementations MUST
     * route them so the value NEVER lands on an argv token / ps-visible
     * command line, and MUST NOT echo them in any error / rejection / retry /
     * debug surface. The SSH impl routes them via `curl --config -` (stdin).
     */
    headers?: Readonly<Record<string, string>>,
  ): Promise<DockerResponse>;
}
