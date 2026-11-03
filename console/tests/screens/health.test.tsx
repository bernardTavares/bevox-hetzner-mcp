/**
 * console/tests/screens/health.test.tsx
 *
 * TDD tests for the Health screen (Task 18).
 *
 * Hard invariants (tested explicitly):
 *  (R1) READ-ONLY: zero write/destroy/remove buttons anywhere on the screen.
 *  (R2) Circuit breakers: HetznerCloud and Docker shown as "closed"; DNS shown
 *       as "open" with a warning indicator (visually distinct).
 *  (R3) Degraded list shows bevox-backend and bevox-db-1.
 *  (R4) Blocked list shows volume:pg-data-2 with its drift-dependency reason.
 *  (R5) Drift section is read-only — no destroy/remove action for drift entities.
 *  (R6) Reconciler status: idle, último ciclo 14:02 ok, próximo ~5m.
 *  (R7) Loading / error / empty states handled.
 *
 * Pattern: inline fresh QueryClient (retry:false) + MemoryRouter at /health.
 * MSW serves /api/health data faithfully to handlers.ts fixture.
 */

import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { Health } from "../../src/screens/Health";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /health
// ---------------------------------------------------------------------------

function renderHealth() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/health"]}>
        <Routes>
          <Route path="/health" element={<Health />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Basic render: page title
// ---------------------------------------------------------------------------

it("renders the Health page title", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/health/i);
  });
});

// ---------------------------------------------------------------------------
// (R2) Circuit breakers: HetznerCloud closed, Docker closed, DNS open (warning)
// ---------------------------------------------------------------------------

it("renders HetznerCloud circuit breaker as 'closed'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("HetznerCloud");
    expect(text).toContain("closed");
  });
});

it("renders Docker circuit breaker as 'closed'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("Docker");
    expect(text).toContain("closed");
  });
});

it("renders DNS circuit breaker as 'open' with warning indicator", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("DNS");
    expect(text).toContain("open");
    // DNS open should have a warning (⚠ or badge-open visually distinct)
    expect(text).toContain("⚠");
  });
});

it("renders DNS circuit breaker failure info (3/5 failures)", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Failures info from the MSW fixture: 3/5
    expect(text).toMatch(/3.*5|falhas|failures/i);
  });
});

it("circuit breaker badge-closed exists for HetznerCloud and Docker", async () => {
  renderHealth();
  await waitFor(() => {
    const closedBadges = document.querySelectorAll(".badge-closed");
    expect(closedBadges.length).toBeGreaterThanOrEqual(2);
  });
});

it("circuit breaker badge-open exists for DNS (open circuit)", async () => {
  renderHealth();
  await waitFor(() => {
    const openBadge = document.querySelector(".badge-open");
    expect(openBadge).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (R3) Degraded entities list
// ---------------------------------------------------------------------------

it("renders degraded entity bevox-backend", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("bevox-backend");
  });
});

it("renders degraded entity bevox-db-1", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("bevox-db-1");
  });
});

it("renders degraded detail '1/2 réplicas up'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/1\/2/);
  });
});

it("renders the 'degraded' section heading", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/degraded|entidades degradadas/i);
  });
});

// ---------------------------------------------------------------------------
// (R4) Blocked entities list
// ---------------------------------------------------------------------------

it("renders blocked entity volume:pg-data-2", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("pg-data-2");
  });
});

it("renders blocked reason referencing server:bevox-x-9 drift", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("bevox-x-9");
  });
});

it("renders the 'blocked' section heading", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/blocked|bloqueado/i);
  });
});

// ---------------------------------------------------------------------------
// (R5) Drift section: read-only, no destroy action shown
// ---------------------------------------------------------------------------

it("renders drift entity server:bevox-x-9 in a drift notice", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("bevox-x-9");
    // Drift notice content
    expect(text).toMatch(/drift/i);
  });
});

it("renders drift 'fail-safe / não destruído' read-only note", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // The prototype shows "não destruído (fail-safe)" in the drift notice
    expect(text).toMatch(/não destruído|fail-safe/i);
  });
});

it("drift section has 'Nenhuma ação destrutiva disponível' read-only text", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/nenhuma ação destrutiva|no destructive action|read.only/i);
  });
});

// ---------------------------------------------------------------------------
// (R6) Reconciler status
// ---------------------------------------------------------------------------

it("renders reconciler state 'idle'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("idle");
  });
});

it("renders reconciler last_result 'ok'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // last_result: "ok" shown
    expect(text).toContain("ok");
  });
});

it("renders reconciler next_cycle_in '~5m'", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("~5m");
  });
});

it("renders reconciler section heading", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/reconciler/i);
  });
});

it("renders reconciler last cycle timestamp (14:02)", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // MSW fixture last_cycle: "2026-05-17T14:02:00Z" → should show 14:02
    expect(text).toMatch(/14:02/);
  });
});

it("renders reconciler total_cycles (1247)", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/1[,.]?247|1247/);
  });
});

// ---------------------------------------------------------------------------
// (R1) READ-ONLY: zero write/destroy/remove buttons
// ---------------------------------------------------------------------------

it("(R1) no write/destroy buttons present anywhere (read-only screen)", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Ensure data is loaded
    expect(text).toContain("idle");
  });

  // After data loaded: look for any button. Health is fully read-only.
  // Allow only link-styled buttons for navigation (anchor tags via Link).
  const buttons = document.querySelectorAll("button");
  expect(buttons.length).toBe(0);
});

it("(R1) no 'destroy' or 'remove' action text visible", async () => {
  renderHealth();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("idle");
  });

  // "Nenhuma ação destrutiva" is informational; "destroy" as an action should not appear
  // We specifically check no button/link says destroy/remove/deletar
  const buttons = document.querySelectorAll("button");
  buttons.forEach((btn) => {
    expect(btn.textContent ?? "").not.toMatch(/destroy|remove|deletar/i);
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows loading state while fetching /api/health", async () => {
  let resolveHandler!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });

  mswServer.use(
    http.get("*/api/health", async () => {
      await delayPromise;
      return HttpResponse.json({
        circuit_breakers: [],
        degraded: [],
        blocked: [],
        drift: [],
        reconciler: {
          state: "idle",
          last_cycle: "2026-05-17T14:02:00Z",
          last_result: "ok",
          next_cycle_in: "~5m",
          total_cycles: 1247,
        },
      });
    }),
  );

  renderHealth();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/carregando|loading/i.test(text)).toBe(true);
  });

  resolveHandler();
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

it("shows error notice when GET /api/health fails", async () => {
  mswServer.use(
    http.get("*/api/health", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderHealth();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/erro|error/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state: no degraded/blocked/drift
// ---------------------------------------------------------------------------

it("shows 'all healthy' or empty-degraded message when no degraded entities", async () => {
  mswServer.use(
    http.get("*/api/health", () => {
      return HttpResponse.json({
        circuit_breakers: [
          { name: "HetznerCloud", state: "closed" },
          { name: "Docker", state: "closed" },
        ],
        degraded: [],
        blocked: [],
        drift: [],
        reconciler: {
          state: "idle",
          last_cycle: "2026-05-17T14:02:00Z",
          last_result: "ok",
          next_cycle_in: "~5m",
          total_cycles: 100,
        },
      });
    }),
  );

  renderHealth();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Either explicit "all healthy" message or zero degraded entries shown
    // We assert: no bevox-backend or bevox-db-1 in the list (data is empty)
    expect(text).not.toContain("bevox-backend");
    expect(text).not.toContain("bevox-db-1");
  });
});
