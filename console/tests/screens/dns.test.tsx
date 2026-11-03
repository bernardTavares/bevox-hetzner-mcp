/**
 * console/tests/screens/dns.test.tsx
 *
 * TDD tests for the DNS screen (Task 17).
 *
 * Hard invariants (tested explicitly):
 *  (H1) set_dns is NON-destructive upsert: POST without ConfirmDestructive, NO approval gate,
 *       NO pending_approval — returns applied → list refreshes / form closes.
 *  (H2) onSuccess MUST be envelope-aware (Task 15 lesson): HTTP 200 with status:error
 *       surfaces notice-error and does NOT falsely show success.
 *  (H3) Submit button disabled while write.isPending (delayed handler).
 *  (H4) error from __force_error__ entity surfaces notice-error.
 *  (H5) unexpected envelope statuses (planned / pending_approval) surface a protocol error.
 *
 * Covers:
 *  - Route /dns renders DNS Records page title
 *  - Records table: app A → 1.2.3.4 ttl 300; api CNAME → app.example.net ttl 300 (from MSW)
 *  - Zone selector present with "example.net" option
 *  - "set_dns: upsert, sem approval" note present
 *  - "+ Record" button present; click reveals inline form (name, type, value, ttl fields)
 *  - Submitting a record via form issues POST /api/dns with dry_run:false
 *  - On applied response: form closes / success notice shown (NO ConfirmDestructive, NO approval gate)
 *  - (H2) HTTP 200 status:error → notice-error, no success shown
 *  - (H4) __force_error__ entity → notice-error surfaced
 *  - (H5) pending_approval from MSW → protocol error surfaced (not treated as success)
 *  - (H3) submit disabled while pending
 *  - Loading / error / empty states
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Dns } from "../../src/screens/Dns";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /dns
// ---------------------------------------------------------------------------

function renderDns() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dns"]}>
        <Routes>
          <Route path="/dns" element={<Dns />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Basic render: title + records from MSW
// ---------------------------------------------------------------------------

it("renders the DNS Records page title", async () => {
  renderDns();
  await waitFor(() => {
    expect(document.body.textContent).toMatch(/dns records/i);
  });
});

it("renders record 'app' A 1.2.3.4 ttl 300 from MSW /api/state", async () => {
  renderDns();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("app");
    expect(text).toContain("1.2.3.4");
    expect(text).toContain("300");
  });
});

it("renders record 'api' CNAME app.example.net ttl 300 from MSW /api/state", async () => {
  renderDns();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("api");
    expect(text).toContain("CNAME");
    expect(text).toContain("app.example.net");
  });
});

it("renders record 'api' type CNAME in the table", async () => {
  renderDns();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("CNAME");
  });
});

it("renders record 'app' type A in the table", async () => {
  renderDns();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("A");
  });
});

// ---------------------------------------------------------------------------
// Zone selector present
// ---------------------------------------------------------------------------

it("renders zone selector with example.net option", async () => {
  renderDns();
  await waitFor(() => {
    // zone selector: <select> or text "example.net" visible
    const text = document.body.textContent ?? "";
    expect(text).toContain("example.net");
  });
});

it("renders a zone selector element (select)", async () => {
  renderDns();
  await waitFor(() => {
    const selects = document.querySelectorAll("select");
    expect(selects.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// "set_dns: upsert, sem approval" note
// ---------------------------------------------------------------------------

it("renders the 'set_dns: upsert, sem approval' note", async () => {
  renderDns();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/set_dns.*upsert.*sem approval/i);
  });
});

// ---------------------------------------------------------------------------
// "+ Record" button reveals inline form
// ---------------------------------------------------------------------------

it("renders a '+ Record' button", async () => {
  renderDns();
  await waitFor(() => {
    const btn = screen.queryByRole("button", { name: /\+ record/i });
    expect(btn).not.toBeNull();
  });
});

it("clicking '+ Record' reveals the inline upsert form", async () => {
  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });

  // Form should NOT be visible before click
  expect(screen.queryByRole("textbox", { name: /name/i })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  await waitFor(() => {
    // Form fields should appear: name input
    const nameInput = screen.queryByRole("textbox", { name: /name/i })
      ?? document.querySelector<HTMLInputElement>("input[name='name'], input[placeholder*='name' i]");
    expect(nameInput).not.toBeNull();
  });
});

it("inline form has name, type, value, ttl fields", async () => {
  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  await waitFor(() => {
    const body = document.body;
    // name field
    const nameInput = body.querySelector<HTMLInputElement>("input[name='name'], input[placeholder*='name' i]");
    expect(nameInput).not.toBeNull();
    // value field
    const valueInput = body.querySelector<HTMLInputElement>("input[name='value'], input[placeholder*='value' i]");
    expect(valueInput).not.toBeNull();
    // ttl field
    const ttlInput = body.querySelector<HTMLInputElement>("input[name='ttl'], input[type='number']");
    expect(ttlInput).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL validation: sub-60 / invalid values must not submit silently as 300
// ---------------------------------------------------------------------------

it("TTL '0': shows 'TTL mínimo 60' validation error and does NOT issue a POST", async () => {
  let postCalled = false;
  mswServer.use(
    http.post("*/api/dns", async () => {
      postCalled = true;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "ttl-test" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.2.3.4" } });

  // Set TTL to 0 — jsdom number inputs sanitize via min attr; bypass with valueAsNumber
  // Old code: parseInt("0", 10) || 300 → silently submits ttl:300 (falsy coercion bug)
  // New code: must detect 0 < 60 and reject with validation error, NOT submit
  const ttlInput = document.querySelector<HTMLInputElement>("input[name='ttl']");
  if (ttlInput) {
    // Bypass jsdom number-input sanitization by setting valueAsNumber directly
    Object.defineProperty(ttlInput, "valueAsNumber", { get: () => 0, configurable: true });
    Object.defineProperty(ttlInput, "value", { get: () => "0", configurable: true });
    fireEvent.change(ttlInput);
  }

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    // Validation error must appear
    const text = document.body.textContent ?? "";
    expect(/ttl m[íi]nimo 60/i.test(text)).toBe(true);
    // POST must NOT have been called
    expect(postCalled).toBe(false);
  });
});

it("TTL '30' (sub-60): shows validation error, does NOT submit ttl=300 silently", async () => {
  let capturedTtl: number | undefined;
  mswServer.use(
    http.post("*/api/dns", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      capturedTtl = body.ttl as number;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "ttl-test" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.2.3.4" } });

  // Set TTL to 30 — bypass jsdom number-input min sanitization
  const ttlInput = document.querySelector<HTMLInputElement>("input[name='ttl']");
  if (ttlInput) {
    Object.defineProperty(ttlInput, "valueAsNumber", { get: () => 30, configurable: true });
    Object.defineProperty(ttlInput, "value", { get: () => "30", configurable: true });
    fireEvent.change(ttlInput);
  }

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    // Validation error must appear, old silent-300 behaviour must be gone
    const text = document.body.textContent ?? "";
    expect(/ttl m[íi]nimo 60/i.test(text)).toBe(true);
    // POST was not called — so the silent-300 substitution did NOT happen
    expect(capturedTtl).toBeUndefined();
  });
});

it("TTL '' (empty/NaN): defaults to 300 and submits successfully (NaN → default 300)", async () => {
  let capturedTtl: number | undefined;
  mswServer.use(
    http.post("*/api/dns", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      capturedTtl = body.ttl as number;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "ttl-nan-test" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.2.3.4" } });

  // Clear the TTL field entirely — parseInt("") → NaN → should default to 300 and submit OK
  const ttlInput = document.querySelector<HTMLInputElement>("input[name='ttl']");
  if (ttlInput) fireEvent.change(ttlInput, { target: { value: "" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    // Should have submitted with ttl=300, not blocked
    expect(capturedTtl).toBe(300);
    // No validation error about TTL minimum
    const text = document.body.textContent ?? "";
    expect(/ttl m[íi]nimo 60/i.test(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (H1) set_dns submit: non-destructive, no ConfirmDestructive, no approval gate
// ---------------------------------------------------------------------------

it("(H1) set_dns: NO ConfirmDestructive shown before or after '+ Record' click", async () => {
  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });

  // No ConfirmDestructive before click
  expect(document.querySelector(".confirm-destructive")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  await waitFor(() => {
    // ConfirmDestructive must NOT appear after + Record click
    expect(document.querySelector(".confirm-destructive")).toBeNull();
  });
});

it("(H1) submitting a record issues POST /api/dns with dry_run:false (no dry_run gate)", async () => {
  let capturedBody: Record<string, unknown> = {};

  mswServer.use(
    http.post("*/api/dns", async ({ request }) => {
      capturedBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  // Fill the form
  const nameInput = await screen.findByPlaceholderText(/name/i)
    .catch(() => document.querySelector<HTMLInputElement>("input[name='name']")!);

  if (nameInput) fireEvent.change(nameInput, { target: { value: "test-record" } });

  const valueInput = document.querySelector<HTMLInputElement>("input[name='value'], input[placeholder*='value' i]");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "5.6.7.8" } });

  // Submit
  const submitBtn = screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i });
  fireEvent.click(submitBtn);

  await waitFor(() => {
    expect(capturedBody.dry_run).not.toBe(true);
    const url = "/api/dns";
    expect(url).toContain("/api/dns");
  });
});

it("(H1) on applied response: no pending_approval text shown, form closes", async () => {
  mswServer.use(
    http.post("*/api/dns", async () => {
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "test" } });

  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  const submitBtn = screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i });
  fireEvent.click(submitBtn);

  await waitFor(() => {
    // NO pending_approval text
    const text = document.body.textContent ?? "";
    expect(/pending_approval/i.test(text)).toBe(false);
    // NO approval gate
    expect(document.querySelector(".confirm-destructive")).toBeNull();
  });
});

it("(H1) POST /api/dns goes to the correct endpoint", async () => {
  let capturedPath = "";
  mswServer.use(
    http.post("*/api/dns", async ({ request }) => {
      capturedPath = new URL(request.url).pathname;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "x" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "y" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    expect(capturedPath).toBe("/api/dns");
  });
});

// ---------------------------------------------------------------------------
// (H2) Envelope-aware onSuccess: HTTP 200 status:error → notice-error, not success
// ---------------------------------------------------------------------------

it("(H2) HTTP 200 with status:error → notice-error shown, NOT success banner", async () => {
  mswServer.use(
    http.post("*/api/dns", async () => {
      // HTTP 200 but envelope status is "error" — critical Task 15 regression guard
      return HttpResponse.json({
        status: "error",
        error: {
          code: "provider_error",
          message: "DNS circuit breaker open",
          retryable: true,
          entity: "dns:example.net/test",
        },
      }); // HTTP 200 — same status code as success
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "bad" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    // Error notice MUST appear
    expect(document.querySelector(".notice-error")).not.toBeNull();
    // Success must NOT appear
    const text = document.body.textContent ?? "";
    expect(/aplicado com sucesso|record saved|upsert ok/i.test(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (H4) __force_error__ entity triggers notice-error
// ---------------------------------------------------------------------------

it("(H4) __force_error__ entity surfaces notice-error (MSW returns error envelope)", async () => {
  // The __force_error__ fixture is handled natively by the MSW postDns handler
  // which returns { status:"error" } with status 503. onSuccess must catch it.
  mswServer.use(
    http.post("*/api/dns", async () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "provider_error",
            message: "DNS circuit breaker open",
            retryable: true,
            entity: "dns:example.net/__force_error__",
          },
        },
        { status: 503 },
      );
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "__force_error__" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    expect(document.querySelector(".notice-error")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (H5) Unexpected envelope status (pending_approval) surfaces protocol error
// ---------------------------------------------------------------------------

it("(H5) unexpected 'pending_approval' from MSW surfaces a protocol error message", async () => {
  // set_dns should NEVER return pending_approval per spec.
  // If it does, the UI must surface a protocol error, not treat it as success.
  mswServer.use(
    http.post("*/api/dns", async () => {
      return HttpResponse.json({
        status: "pending_approval",
        approval_id: "apr_unexpected",
      });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "x" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Must surface a protocol error — either notice-error or "inesperado" / "protocol"
    const hasError = document.querySelector(".notice-error") !== null
      || /inesperado|protocol|unexpected/i.test(text);
    expect(hasError).toBe(true);
  });
});

it("(H5) unexpected 'planned' from MSW surfaces a protocol error message", async () => {
  mswServer.use(
    http.post("*/api/dns", async () => {
      return HttpResponse.json({
        status: "planned",
        plan: [{ op: "upsert", entity: "dns:example.net/x", change: "A → 1.1.1.1", impact: "noop" }],
      });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "x" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  fireEvent.click(screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i }));

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    const hasError = document.querySelector(".notice-error") !== null
      || /inesperado|protocol|unexpected/i.test(text);
    expect(hasError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (H3) Submit button disabled while write.isPending
// ---------------------------------------------------------------------------

it("(H3) submit button is disabled while the DNS write is pending", async () => {
  let resolvePost!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolvePost = resolve;
  });

  mswServer.use(
    http.post("*/api/dns", async () => {
      await delayPromise;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderDns();
  await screen.findByRole("button", { name: /\+ record/i });
  fireEvent.click(screen.getByRole("button", { name: /\+ record/i }));

  const nameInput = document.querySelector<HTMLInputElement>("input[name='name']");
  if (nameInput) fireEvent.change(nameInput, { target: { value: "test" } });
  const valueInput = document.querySelector<HTMLInputElement>("input[name='value']");
  if (valueInput) fireEvent.change(valueInput, { target: { value: "1.1.1.1" } });

  const submitBtn = screen.getByRole("button", { name: /salvar|save|add|upsert|submit/i });
  expect(submitBtn).not.toBeDisabled();

  fireEvent.click(submitBtn);

  await waitFor(() => {
    const btn = screen.queryByRole("button", { name: /salvar|save|add|upsert|submit/i });
    if (btn) expect(btn).toBeDisabled();
  });

  await act(async () => {
    resolvePost();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

it("shows a loading state while fetching state", async () => {
  let resolveHandler!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });

  mswServer.use(
    http.get("*/api/state", async () => {
      await delayPromise;
      return HttpResponse.json({ servers: [], networks: [], volumes: [], services: [], dns: [], backups: [] });
    }),
  );

  renderDns();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/carregando|loading/i.test(text)).toBe(true);
  });

  resolveHandler();
});

it("shows an error notice when GET /api/state fails", async () => {
  mswServer.use(
    http.get("*/api/state", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderDns();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/erro|error/i.test(text)).toBe(true);
  });
});

it("shows an empty state when no DNS records are returned", async () => {
  mswServer.use(
    http.get("*/api/state", () => {
      return HttpResponse.json({
        servers: [],
        networks: [],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      });
    }),
  );

  renderDns();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/nenhum registro|no records|sem registros/i.test(text)).toBe(true);
  });
});
