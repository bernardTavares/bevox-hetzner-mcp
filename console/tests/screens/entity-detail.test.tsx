/**
 * console/tests/screens/entity-detail.test.tsx
 *
 * TDD tests for the EntityDetail screen (Task 8).
 *
 * Covers:
 *  - Title + StatusBadge renders for bevox-harness
 *  - Action buttons present (Edit/Scale/Restart/Destroy)
 *  - Hard invariant: Destroy → dry_run:true FIRST, then dry_run:false → pending_approval
 *  - Hard invariant: drift entity (bevox-x-9) has NO destroy/remove control
 *  - Not-found state for unknown entities
 *  - [NEW] Action buttons disabled while mutation in-flight (Fix 1)
 *  - [NEW] Error envelope surfaces visible error message (Fix 3)
 *  - [NEW] Invalid kind route renders "Parâmetros inválidos" (Fix 4)
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { EntityDetail } from "../../src/screens/EntityDetail";

// ---------------------------------------------------------------------------
// Inline test helper: fresh QueryClient per test to avoid cache bleed
// ---------------------------------------------------------------------------

function renderEntityDetail(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/e/:kind/:name" element={<EntityDetail />} />
          {/* Also handle the invalid-kind route for Fix 4 tests */}
          <Route path="/e/:kind/:name" element={<EntityDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// We also need a route that matches /e/badkind/x for Fix 4 testing
function renderEntityDetailWithBadKind(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/e/:kind/:name" element={<EntityDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Helper: wait for page to load (non-loading state)
async function waitForLoad() {
  // Wait until loading text is gone
  await waitFor(() => {
    const loading = screen.queryByText(/Carregando…/);
    expect(loading).not.toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Basic rendering — service bevox-harness
// ---------------------------------------------------------------------------

it("shows the service name bevox-harness in the page-title", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  // Wait for data, then check page-title specifically
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/bevox-harness/);
  });
});

it("shows the title with kind prefix Service: in the page-title div", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/Service:/);
  });
});

it("shows the StatusBadge for the service status (healthy) — badge-healthy class", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  const healthyBadges = document.querySelectorAll(".badge-healthy");
  expect(healthyBadges.length).toBeGreaterThan(0);
});

it("shows image field value", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  expect(await screen.findByText("registry/bevox-harness:v12")).toBeInTheDocument();
});

it("shows Replicas section label", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  // Multiple Replicas labels may exist (detail field + section title); at least one
  expect(screen.getAllByText(/Replicas/i).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Action buttons present for non-drift service
// ---------------------------------------------------------------------------

it("shows Edit (preview) button for non-drift service", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
});

it("shows Scale button for non-drift service", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  expect(screen.getByRole("button", { name: /scale/i })).toBeInTheDocument();
});

it("shows Restart button for non-drift service", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
});

it("shows Destroy button for non-drift service", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  expect(screen.getByRole("button", { name: /destroy/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Hard invariant: Destroy flow — dry_run:true FIRST, then dry_run:false → pending_approval
// ---------------------------------------------------------------------------

it("clicking Destroy shows ConfirmDestructive dialog (Approval Gate text)", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));

  // ConfirmDestructive always shows Approval Gate
  expect(await screen.findByText(/Approval Gate/i)).toBeInTheDocument();
});

it("after confirming Destroy, shows the dry-run plan (planned/Plano) BEFORE applying", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  // Click Destroy to open ConfirmDestructive
  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));
  await screen.findByText(/Approval Gate/i);

  // Type the entity name to enable the Confirm button
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "bevox-harness" } });

  // Click Confirm — this triggers dry_run:true first
  fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

  // The plan from dry_run:true should show — MSW returns status:"planned"
  // and the screen renders "Plano de destruição" or the plan item "destroy entity"
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    // Either the plan label or the plan item text from the MSW fake
    expect(
      /Plano|destroy entity/i.test(bodyText),
    ).toBe(true);
  });
});

it("after dry-run plan is shown, an Apply button triggers pending_approval surfaced to user", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  // Step 1: Click Destroy
  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));
  await screen.findByText(/Approval Gate/i);

  // Step 2: Type confirm text
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "bevox-harness" } });

  // Step 3: Click Confirm → triggers dry_run:true, shows plan
  fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

  // Wait for the dry_run plan to appear (Apply button becomes visible)
  const applyBtn = await screen.findByRole("button", { name: /aplicar|apply/i });

  // Step 4: Click Apply → dry_run:false → pending_approval
  fireEvent.click(applyBtn);

  // Step 5: pending_approval surfaced — body text should contain pending_approval or approval id
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(
      /pending_approval|aprovação|apr_/i.test(bodyText),
    ).toBe(true);
  });
});

// Verify the dry_run:true → dry_run:false ordering via the rendered UI states:
// After confirm → Plan phase (dry_run:true was sent), THEN apply sends dry_run:false.
// This test verifies the Plan phase is visible before the pending_approval phase.
it("dry_run:true plan phase is shown before pending_approval — ordering invariant", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));
  await screen.findByText(/Approval Gate/i);

  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "bevox-harness" } });
  fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

  // Plan phase must appear (dry_run:true was sent and response received)
  const applyBtn = await screen.findByRole("button", { name: /aplicar|apply/i });
  // At this point pending_approval must NOT yet be shown
  expect(document.body.textContent).not.toMatch(/pending_approval/);

  // Now apply → pending_approval
  fireEvent.click(applyBtn);
  await waitFor(() => {
    expect(document.body.textContent).toMatch(/pending_approval|apr_/);
  });
});

// ---------------------------------------------------------------------------
// Hard invariant: drift entity → NO destroy control
// ---------------------------------------------------------------------------

it("does NOT show Destroy button for drift server bevox-x-9", async () => {
  renderEntityDetail("/e/server/bevox-x-9");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/bevox-x-9/);
  });

  const destroyBtns = screen.queryAllByRole("button").filter((btn) =>
    /destroy|remove|delete/i.test(btn.textContent ?? ""),
  );
  expect(destroyBtns).toHaveLength(0);
});

it("shows drift/read-only notice for drift server bevox-x-9", async () => {
  renderEntityDetail("/e/server/bevox-x-9");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/bevox-x-9/);
  });
  // Should show some drift/read-only indicator
  const bodyText = document.body.textContent ?? "";
  expect(/drift|read.?only|fail.?safe/i.test(bodyText)).toBe(true);
});

it("shows drift StatusBadge for bevox-x-9 — badge-drift class", async () => {
  renderEntityDetail("/e/server/bevox-x-9");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/bevox-x-9/);
  });
  const driftBadges = document.querySelectorAll(".badge-drift");
  expect(driftBadges.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Server entity
// ---------------------------------------------------------------------------

it("shows server kind in title (Server:) for bevox-app-1", async () => {
  renderEntityDetail("/e/server/bevox-app-1");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/Server:/);
    expect(title?.textContent).toMatch(/bevox-app-1/);
  });
});

it("shows Destroy button for a non-drift server (bevox-app-1)", async () => {
  renderEntityDetail("/e/server/bevox-app-1");
  await waitFor(() => {
    const title = document.querySelector(".page-title");
    expect(title?.textContent).toMatch(/bevox-app-1/);
  });
  expect(screen.getByRole("button", { name: /destroy/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

it("shows a 'not found' message for unknown entity name", async () => {
  renderEntityDetail("/e/service/does-not-exist");
  expect(await screen.findByText(/not found|não encontrado/i)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Recent events section
// ---------------------------------------------------------------------------

it("shows the 'Eventos recentes' section header", async () => {
  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();
  // Use getAllByText since the label may appear multiple times
  expect(screen.getAllByText(/Eventos recentes|Recent events/i).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// [NEW] Fix 4: Invalid kind route renders "Parâmetros inválidos"
// ---------------------------------------------------------------------------

it("renders 'Parâmetros inválidos' for an invalid kind param like /e/badkind/x", async () => {
  renderEntityDetailWithBadKind("/e/badkind/x");
  // The invalid kind guard fires synchronously after state loads.
  // It may show while loading or after, so we tolerate both.
  expect(await screen.findByText(/Parâmetros inválidos/i)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// [NEW] Fix 1: Action buttons disabled while mutation is in-flight
// ---------------------------------------------------------------------------

it("Destroy button becomes disabled while mutation is pending (ConfirmDestructive confirm btn)", async () => {
  // Install a delayed handler so we can assert disabled state before resolution
  let resolveMutation!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });

  mswServer.use(
    http.post("*/api/destroy", async () => {
      // Block until we explicitly resolve
      await delayPromise;
      return HttpResponse.json({
        status: "planned",
        plan: [{ op: "destroy", entity: "service:bevox-harness", change: "x", impact: "y" }],
      });
    }),
  );

  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  // Open destroy flow
  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));
  await screen.findByText(/Approval Gate/i);

  // Type confirm text to enable Confirm button
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "bevox-harness" } });

  const confirmBtn = screen.getByRole("button", { name: /^Confirm$/i });
  // Ensure it's enabled before clicking
  expect(confirmBtn).not.toBeDisabled();

  // Click Confirm → mutation in-flight
  fireEvent.click(confirmBtn);

  // While the delayed mutation is pending, the Confirm button must be disabled
  await waitFor(() => {
    const confirmBtnNow = screen.getByRole("button", { name: /^Confirm$/i });
    expect(confirmBtnNow).toBeDisabled();
  });

  // Resolve the mutation to clean up
  await act(async () => {
    resolveMutation();
    await delayPromise;
  });
});

it("action buttons (Edit/Scale/Restart/Destroy) become disabled while a mutation is in-flight", async () => {
  let resolveMutation!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });

  mswServer.use(
    http.post("*/api/services", async () => {
      await delayPromise;
      return HttpResponse.json({
        status: "planned",
        plan: [{ op: "update", entity: "service:bevox-harness", change: "x", impact: "y" }],
      });
    }),
  );

  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  // All action buttons should be enabled initially
  const editBtn = screen.getByRole("button", { name: /edit/i });
  const scaleBtn = screen.getByRole("button", { name: /scale/i });
  const restartBtn = screen.getByRole("button", { name: /restart/i });
  const destroyBtn = screen.getByRole("button", { name: /destroy/i });

  expect(editBtn).not.toBeDisabled();
  expect(scaleBtn).not.toBeDisabled();
  expect(restartBtn).not.toBeDisabled();
  expect(destroyBtn).not.toBeDisabled();

  // Click Edit → mutation in-flight
  fireEvent.click(editBtn);

  // While pending, all buttons must be disabled
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /edit/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /scale/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /restart/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /destroy/i })).toBeDisabled();
  });

  // Resolve
  await act(async () => {
    resolveMutation();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// [NEW] Fix 3: Error envelope surfaces a visible error message
// ---------------------------------------------------------------------------

it("destroy returning error envelope surfaces a visible notice-error (Fix 3)", async () => {
  // Override MSW to return an error envelope for /api/destroy on bevox-harness
  mswServer.use(
    http.post("*/api/destroy", async () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "conflict",
            message: "drift detected: cannot destroy drift resource",
            retryable: false,
            entity: "service:bevox-harness",
          },
        },
        { status: 422 },
      );
    }),
  );

  renderEntityDetail("/e/service/bevox-harness");
  await waitForLoad();

  // Open destroy flow
  fireEvent.click(screen.getByRole("button", { name: /destroy/i }));
  await screen.findByText(/Approval Gate/i);

  // Type confirm text to enable Confirm button
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "bevox-harness" } });

  // Click Confirm — the error envelope triggers the onError/error status handler
  // Note: postWrite throws the typed ApiError when status==="error", so onError fires
  fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

  // The notice-error must render with the error message or code
  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });

  // The error text is visible in the body
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(
      /conflict|drift detected|cannot destroy/i.test(bodyText),
    ).toBe(true);
  });
});
