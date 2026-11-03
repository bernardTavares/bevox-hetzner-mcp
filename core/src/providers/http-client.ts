/**
 * core/src/providers/http-client.ts
 *
 * The resilient HTTP client every Hetzner provider (HetznerCloud 2.4,
 * HetznerDNS Fase 5) calls through. It is the ONLY place retry/backoff,
 * Retry-After handling, error classification and Hetzner cursor pagination
 * live — providers stay declarative.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; YAGNI):
 *
 *   - SINGLE RETRY TAXONOMY. Every non-2xx response is turned into a
 *     ReconcileError via domain/errors.ts `classify`. We retry IFF the
 *     resulting error is retryable (transient/partial) — never invent a
 *     parallel rule set, never retry fatal (401/403) / precondition /
 *     conflict. Network failures are reported as kind:"network-error"
 *     (→ transient) exactly as errors.ts documents.
 *
 *   - BOUNDED, JITTERED BACKOFF. Full jitter: delay ∈ [0, base·2^attempt],
 *     capped at `maxRetries` total retries. A server `Retry-After`
 *     (integer seconds OR HTTP-date) OVERRIDES the computed backoff — we
 *     obey the server's explicit pacing, BUT it is clamped to `maxDelayMs`
 *     so a hostile/buggy server cannot stall the shared client for hours.
 *
 *   - NO SECRET LEAKAGE. Error messages carry method + status + a short
 *     body excerpt only; request headers (incl. Authorization) are NEVER
 *     interpolated into a message.
 *
 *   - PER-CALL TIMEOUT (Task 6.3). Every fetch attempt is bounded by
 *     `timeoutMs`: an AbortController whose signal is passed into fetchImpl,
 *     so on deadline the in-flight request is ACTUALLY aborted (no hang, no
 *     leaked socket). The deadline elapsing is measured via the SAME injectable
 *     `sleep` seam (NOT a real timer) so tests advance it deterministically. A
 *     timeout is classified as `transient` (kind:"network-error") — exactly
 *     like any other pre-HTTP failure — so the existing retry loop may retry
 *     it and the Task-6.2 circuit breaker counts it; after retries are
 *     exhausted it surfaces `transient` (retryable). It is NEVER `fatal` and
 *     NEVER a delete/destructive outcome (fail-safe; spec §"fail-safe, nunca
 *     fail-deleting"). The default is generous (DEFAULT_TIMEOUT_MS) so a
 *     normal healthy request is unaffected (no flap / no regression).
 *
 *   - DETERMINISM SEAMS. `fetchImpl`, `sleep` and `random` are injectable so
 *     tests are pure, in-process and non-flaky (no real network/timers). The
 *     per-call timeout reuses the SAME `sleep` seam as its deadline clock.
 *
 *   - TERMINATING PAGINATION. getAllPages follows Hetzner
 *     `meta.pagination.next_page` until exhausted, with a defensive page cap
 *     so a missing/cyclic cursor cannot loop forever, and never retry-storms.
 *
 * Exported API (minimal — only what Fase 2 needs):
 *   class HttpClient
 *     constructor(options: HttpClientOptions)
 *     get(url, init?)            → Promise<Response>
 *     request(url, init?)        → Promise<Response>
 *     getAllPages<T>(url, key)   → Promise<T[]>
 *     readonly attempts: number   — fetch attempts of the LAST get/request call
 *   interface HttpClientOptions
 */

import { ReconcileError, classify } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default per-call timeout (ms). A NAMED constant (not a magic literal) so the
 * value is one source of truth. 30s is deliberately GENEROUS: a normal Hetzner
 * API call completes in well under a second, so this never trips a healthy
 * request (no flap, no Fase-2/3.5/6.x regression) — it only bounds a genuinely
 * stuck/hung connection so the cycle stays recoverable instead of hanging.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Options — the determinism seams are all here
// ---------------------------------------------------------------------------

export interface HttpClientOptions {
  /** Max RETRIES (in addition to the initial attempt). Default 3. */
  maxRetries?: number;
  /** Base backoff in ms; delay ∈ [0, baseDelayMs·2^attempt]. Default 250. */
  baseDelayMs?: number;
  /** Hard ceiling on a single backoff delay (ms). Default 30000. */
  maxDelayMs?: number;
  /**
   * Per-call timeout in ms (Task 6.3). Each fetch attempt is aborted (via an
   * AbortController) and classified `transient` if it exceeds this. Measured
   * via the injectable `sleep` seam. Default DEFAULT_TIMEOUT_MS (generous —
   * a healthy request is never affected).
   */
  timeoutMs?: number;
  /** Defensive cap on pages getAllPages will follow. Default 1000. */
  maxPages?: number;
  /** Headers sent on every request (e.g. Authorization). Never logged. */
  defaultHeaders?: Record<string, string>;
  /** Injectable fetch (test seam). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (test seam). Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable per-call timeout timer (Task 6.3 test seam). Schedules
   * `onElapsed` after `ms` and returns a cancel fn (idempotent). It is a
   * SEPARATE seam from `sleep` ON PURPOSE: `sleep` is the BACKOFF clock and
   * existing tests assert exact backoff-sleep call sequences via their `sleep`
   * spy — reusing it for the timeout would pollute that observation and break
   * backward-compat. Default = a real (unref'd) setTimeout. Tests inject a
   * deterministic controllable timer (no real timers).
   */
  startTimeout?: (ms: number, onElapsed: () => void) => () => void;
  /** Injectable RNG in [0,1) for full jitter (test seam). Default Math.random. */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

export class HttpClient {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startTimeout: (
    ms: number,
    onElapsed: () => void,
  ) => () => void;
  private readonly random: () => number;

  /** Fetch attempts performed by the most recent get()/request() call. */
  attempts = 0;

  constructor(options: HttpClientOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPages = options.maxPages ?? 1000;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.startTimeout =
      options.startTimeout ??
      ((ms: number, onElapsed: () => void) => {
        const t = setTimeout(onElapsed, ms);
        // Do not keep the event loop alive solely for the timeout timer.
        (t as { unref?: () => void }).unref?.();
        return () => clearTimeout(t);
      });
    this.random = options.random ?? Math.random;
  }

  /** GET `url`. Thin alias over request() (Fase 2 only needs GET). */
  get(url: string, init?: RequestInit): Promise<Response> {
    return this.request(url, { ...init, method: "GET" });
  }

  /**
   * Perform a request with bounded jittered retry. Resolves with the first
   * 2xx Response. A non-2xx response or a network failure is classified via
   * errors.ts; retryable classes are retried up to `maxRetries` (honouring
   * Retry-After), then the classified ReconcileError is thrown.
   */
  async request(url: string, init?: RequestInit): Promise<Response> {
    this.attempts = 0;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = { ...this.defaultHeaders, ...(init?.headers ?? {}) };

    // attempt index 0 = initial try; 1..maxRetries = retries
    for (let attempt = 0; ; attempt++) {
      this.attempts = attempt + 1;

      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { ...init, method, headers });
      } catch (cause) {
        // Pre-HTTP failure (connection reset, DNS, OR a per-call timeout that
        // aborted the in-flight request) → transient. Whether the socket died
        // or our deadline fired, the classification is the SAME single
        // taxonomy: kind:"network-error" ⇒ transient (retryable) — NEVER
        // fatal, NEVER a destructive/delete outcome (fail-safe). The retry
        // loop may retry it; the Task-6.2 breaker counts it.
        //
        // If the cause is ALREADY a fully-classified ReconcileError (e.g. the
        // per-call timeout fetchWithTimeout throws), rethrow it UNCHANGED — it
        // already carries its class (transient stays transient, fatal stays
        // fatal) and its SPECIFIC message (the precise timeout text). Wrapping
        // it again would bury that message under the generic outer one and
        // 6.4 /api/health would surface the vague text instead of the precise
        // cause. The retry/backoff decision below is unaffected: it keys off
        // the SAME single taxonomy this error already encodes.
        if (cause instanceof ReconcileError) {
          if (!cause.retryable || attempt >= this.maxRetries) throw cause;
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        const err = new ReconcileError(
          classify({ kind: "network-error" }),
          `HTTP ${method} failed before a response was received`,
          { cause },
        );
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const err = await this.toReconcileError(res, method);
      if (!err.retryable || attempt >= this.maxRetries) throw err;

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const delay =
        retryAfter !== undefined
          ? Math.min(retryAfter, this.maxDelayMs)
          : this.backoffMs(attempt);
      await this.sleep(delay);
    }
  }

  /**
   * Follow Hetzner cursor pagination from `url`, collecting `listKey`
   * (e.g. "servers") from every page into one flat array. Terminates when
   * `meta.pagination.next_page` is null/absent or the defensive page cap is
   * hit (guards a missing/cyclic cursor). Each page request uses the same
   * retry policy; it does NOT retry-storm.
   */
  async getAllPages<T>(url: string, listKey: string): Promise<T[]> {
    const out: T[] = [];
    let nextPage: number | null = 1;

    for (let page = 0; page < this.maxPages && nextPage !== null; page++) {
      const u = new URL(url);
      if (nextPage > 1) u.searchParams.set("page", String(nextPage));

      const res = await this.request(u.toString());
      let body: {
        meta?: { pagination?: { next_page?: number | null } };
      } & Record<string, unknown>;
      try {
        body = (await res.json()) as {
          meta?: { pagination?: { next_page?: number | null } };
        } & Record<string, unknown>;
      } catch (cause) {
        throw new ReconcileError(
          classify({ kind: "network-error" }),
          `pagination: malformed JSON page body`,
          { cause },
        );
      }

      const items = body[listKey];
      if (Array.isArray(items)) out.push(...(items as T[]));

      const np = body.meta?.pagination?.next_page;
      nextPage = typeof np === "number" && np > nextPage ? np : null;
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One fetch attempt bounded by `timeoutMs`. An AbortController's signal is
   * passed into fetchImpl so on deadline the in-flight request is ACTUALLY
   * aborted (no hang/leaked socket). The deadline is the injectable `sleep`
   * seam — NOT a real timer — so tests advance it deterministically. If the
   * timeout wins the race we throw (rejecting this attempt); request()'s catch
   * then classifies it `transient` exactly like any pre-HTTP failure. If the
   * caller already passed a signal we do NOT override it (additive); we only
   * supply our own when none was given (the production providers pass none).
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit & { signal?: AbortSignal | null },
  ): Promise<Response> {
    const controller = new AbortController();
    const signal = init.signal ?? controller.signal;
    const method = (init.method ?? "GET").toUpperCase();

    let timedOut = false;

    // The timeout is the injected `startTimeout` seam (zero real timers in
    // tests). We deliberately do NOT Promise.race a timer against the fetch:
    // a race would be ORDER-FRAGILE (a fake timer/sleep that resolves
    // immediately would always beat an equally-immediate fake fetch and "time
    // out" a healthy request — a false positive / flap). Instead the deadline
    // ONLY arms the AbortController: if it fires before the fetch settles we
    // abort the in-flight request (releasing the socket — never hung) and mark
    // `timedOut`. A healthy fast fetch settles first and the timer is cancelled
    // in `finally` — byte-identical behaviour for every existing healthy-path
    // test (no flap / no regression).
    const cancelTimeout = this.startTimeout(this.timeoutMs, () => {
      timedOut = true;
      controller.abort(); // abort the in-flight request — socket released.
    });

    try {
      const res = await this.fetchImpl(url, { ...init, signal });
      return res;
    } catch (err) {
      // The fetch rejected. If OUR deadline aborted it, it is a TIMEOUT —
      // surface it in the single transient taxonomy (kind:"network-error" ⇒
      // transient, retryable, NEVER fatal/destructive). Otherwise propagate
      // the original pre-HTTP failure unchanged (request() classifies it).
      if (timedOut) {
        throw new ReconcileError(
          classify({ kind: "network-error" }),
          `HTTP ${method} timed out after ${this.timeoutMs}ms ` +
            `(request aborted; no rollback)`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      // Always disarm the timer (cancel is idempotent) so a healthy fast
      // response never leaks a pending timeout — no flap, no leaked handle.
      cancelTimeout();
    }
  }

  /** Full jitter: random in [0, base·2^attempt], capped at maxDelayMs. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(
      this.baseDelayMs * 2 ** attempt,
      this.maxDelayMs,
    );
    return Math.floor(this.random() * ceiling);
  }

  /**
   * Turn a non-2xx Response into a classified ReconcileError. The message
   * carries method + status + a short body excerpt ONLY — request headers
   * (incl. Authorization) are never included.
   */
  private async toReconcileError(
    res: Response,
    method: string,
  ): Promise<ReconcileError> {
    let code: string | undefined;
    let excerpt = "";
    try {
      const text = await res.clone().text();
      excerpt = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as {
          error?: { code?: string };
        };
        if (typeof parsed?.error?.code === "string") {
          code = parsed.error.code;
        }
      } catch {
        /* non-JSON body — excerpt is enough */
      }
    } catch {
      /* unreadable body — status alone classifies */
    }

    const errorClass = classify({ httpStatus: res.status, code });
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    return new ReconcileError(
      errorClass,
      `HTTP ${method} → ${res.status} ${res.statusText}` +
        (excerpt ? `: ${excerpt}` : ""),
      retryAfterMs !== undefined ? { retryAfterMs } : undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Retry-After parsing — integer seconds OR HTTP-date (RFC 7231 §7.1.3)
// ---------------------------------------------------------------------------

/** Parse a Retry-After header into milliseconds; undefined if absent/invalid. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date form
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.max(0, when - Date.now());
  }

  return undefined;
}
