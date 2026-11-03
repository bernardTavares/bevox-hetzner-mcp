/**
 * core/test/fakes/hetzner-http-capture.ts
 *
 * A lightweight, stateless capture-only fake for the Hetzner Cloud HTTP API.
 * Unlike the stateful `hetzner-http.ts`, this fake's sole purpose is to
 * capture {url, method, body} per call so wire shape can be asserted in unit
 * tests without going live.
 *
 * It returns minimally Hetzner-shaped responses — 201 for POST, 200 for GET
 * with the standard `meta.pagination.next_page: null` shape — so `findByName`
 * inside HetznerCloudProvider keeps working.
 *
 * List responses can be pre-seeded at construction time via the `collections`
 * option so `findByName` lookups (GET ?name=<x>) return controlled data.
 *
 * Design:
 *   - createCaptureHetznerHttpFake(opts?) → CaptureHetznerHttpFake
 *   - fetchImpl: (url, init?) => Promise<Response> — drop-in for HttpClient
 *   - requests: ReadonlyArray<CaptureRequest> — captured calls in order
 *   - reset() — clears captured requests and resets the id counter
 *
 * Spec: docs/specs/2026-05-27-hetzner-cloud-wire-translation.md
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CaptureRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown; // JSON-parsed if body was JSON; otherwise raw string
}

export interface CaptureHetznerHttpFake {
  /** Drop-in `fetchImpl` for HttpClient — never touches the network. */
  readonly fetchImpl: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Captured calls in order. */
  readonly requests: ReadonlyArray<CaptureRequest>;
  /** Clear captured requests and reset the id counter. */
  reset(): void;
}

export interface CaptureHetznerHttpFakeOptions {
  /**
   * Pre-seeded list responses keyed by collection (plural, e.g. "networks",
   * "servers", "volumes"). GET /v1/<collection> (with or without ?name=) will
   * return these records wrapped in the Hetzner pagination envelope.
   */
  readonly collections?: Record<
    string,
    ReadonlyArray<{ id: number; name: string } & Record<string, unknown>>
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip trailing 's' to get the singular Hetzner response key. */
function singular(collection: string): string {
  // Handle the common plural forms used by Hetzner Cloud v1 API.
  // All three collections (networks, servers, volumes) just need an 's' strip.
  return collection.endsWith("s") ? collection.slice(0, -1) : collection;
}

/** Parse the collection name from a Hetzner Cloud API pathname. */
function extractCollection(pathname: string): string | null {
  // Matches /v1/<collection> with optional trailing slash
  const match = /^\/v1\/([^/?]+)/.exec(pathname);
  return match?.[1] ?? null;
}

/** Build a minimal Hetzner 200 list response envelope. */
function makeListResponse(
  collection: string,
  records: ReadonlyArray<unknown>,
): string {
  return JSON.stringify({
    [collection]: records,
    meta: { pagination: { next_page: null } },
  });
}

/** Build a minimal Hetzner 201 create response envelope. */
function makeCreateResponse(collection: string, id: number, name: string): string {
  return JSON.stringify({
    [singular(collection)]: { id, name },
  });
}

/** Parse the body from RequestInit. Returns parsed JSON or raw string. */
async function parseBody(init: RequestInit | undefined): Promise<unknown> {
  if (init?.body === undefined || init.body === null) return undefined;
  const raw = init.body;
  if (typeof raw === "string") {
    const ct = (init.headers as Record<string, string> | undefined)?.["Content-Type"]
      ?? (init.headers as Record<string, string> | undefined)?.["content-type"]
      ?? "";
    if (ct.includes("json")) {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    return raw;
  }
  // For other body types (Blob, ArrayBuffer, etc.), try to treat as string
  return String(raw);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCaptureHetznerHttpFake(
  opts?: CaptureHetznerHttpFakeOptions,
): CaptureHetznerHttpFake {
  const seeded = opts?.collections ?? {};
  const captured: CaptureRequest[] = [];
  let counter = 0;

  async function fetchImpl(
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const parsed = new URL(urlStr);
    const method = (init?.method ?? "GET").toUpperCase();
    const collection = extractCollection(parsed.pathname);

    if (!collection) {
      throw new Error(
        `unhandled in capture fake: ${method} ${urlStr} (cannot parse collection from path)`,
      );
    }

    if (method === "GET") {
      // Return seeded records for the collection; filter by ?name= if present
      const nameFilter = parsed.searchParams.get("name");
      const allRecords = seeded[collection] ?? [];
      const records =
        nameFilter !== null
          ? allRecords.filter((r) => r.name === nameFilter)
          : allRecords;

      return new Response(makeListResponse(collection, records), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST") {
      const body = await parseBody(init);
      const name =
        body !== null && typeof body === "object"
          ? ((body as Record<string, unknown>)["name"] as string | undefined) ?? ""
          : "";
      captured.push({ url: urlStr, method: "POST", body });
      counter += 1;
      return new Response(makeCreateResponse(collection, counter, name), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unhandled in capture fake: ${method} ${urlStr}`);
  }

  return {
    fetchImpl,
    get requests(): ReadonlyArray<CaptureRequest> {
      return captured;
    },
    reset() {
      captured.splice(0, captured.length);
      counter = 0;
    },
  };
}
