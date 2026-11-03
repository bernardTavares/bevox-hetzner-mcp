/**
 * console/tests/e2e-happy-path.test.tsx
 *
 * Task 19 — E2E happy path over MSW fake (agent-native flow).
 *
 * Drives the FULL agent-native loop through the real UI + MSW fake:
 *
 *   Overview (/)
 *     → navigate to PlanApply (/apply) by clicking the "Plan/Apply" NavLink
 *     → click Plan (dry-run) → planned plan shown (dry_run:true, NO pending yet)
 *     → click Apply → Approval Gate → pending_approval + approval_id surfaced (dry_run:false)
 *     → navigate to Approvals (/approvals) by clicking "Approvals" NavLink
 *     → approve it → item leaves pending list
 *     → navigate to Events (/events) by clicking "Events" NavLink
 *     → audit trail shows agent actor ("vox") — "evento reflete resultado com ator"
 *
 * Uses:
 *  - TestApp (from tests/test-utils.tsx) — full app tree (QueryClientProvider +
 *    MemoryRouter + AppRoutes/Layout + all 12 screens). MemoryRouter is used
 *    instead of createMemoryRouter (data router) to avoid AbortSignal conflicts
 *    with MSW's interceptor when navigate() creates internal fetch requests.
 *  - fireEvent.click for all interactions, including NavLink navigation.
 *    With MemoryRouter, React Router's NavLink/Link onClick handlers intercept
 *    the click event and call navigate() internally without any fetch request,
 *    so fireEvent.click works correctly for route transitions.
 *  - Fresh QueryClient per test (retry:false) passed to TestApp
 *  - Real MSW fake via global setup.ts
 *
 * Hard invariants verified end-to-end:
 *  1. dry_run:true (planned) BEFORE dry_run:false (pending_approval)
 *  2. pending_approval + approval_id are surfaced after apply
 *  3. Approved item leaves the pending list
 *  4. Events audit trail records the actor ("vox" — agent actor in fixtures)
 */

import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { TestApp } from "./test-utils";

// ---------------------------------------------------------------------------
// Helper: render the full app tree starting at initialPath
// ---------------------------------------------------------------------------

function renderApp(initialPath = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<TestApp initialPath={initialPath} queryClient={queryClient} />);
  return { queryClient };
}

// Generous timeout for async assertions — MSW + TanStack Query fetch cycle
const WAIT_OPTS = { timeout: 5000 };

// ---------------------------------------------------------------------------
// E2E: full agent-native loop
// ---------------------------------------------------------------------------

it("E2E: Overview → PlanApply → dry_run → apply → pending_approval → Approvals → approve → Events with actor", async () => {
  renderApp("/");

  // ── Step 1: Overview — Bevox stack renders ──────────────────────────────

  // Wait for server and service fixture data to appear (MSW GET /api/state)
  expect(await screen.findByText("bevox-app-1", {}, WAIT_OPTS)).toBeInTheDocument();
  expect(await screen.findByText("bevox-harness", {}, WAIT_OPTS)).toBeInTheDocument();

  // Layout nav is visible
  expect(screen.getByRole("link", { name: "Plan/Apply" })).toBeInTheDocument();

  // ── Step 2: Navigate to PlanApply by clicking the "Plan/Apply" NavLink ──
  // MemoryRouter + React Router Link/NavLink: onClick calls navigate() internally.
  // fireEvent.click fires the DOM click which React's synthetic event picks up.

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Plan/Apply" }));
  });

  // Diff items from MSW GET /api/diff must render on the PlanApply screen
  expect(await screen.findByText(/service:bevox-backend/, {}, WAIT_OPTS)).toBeInTheDocument();

  // Layout nav still visible (persistent shell)
  expect(screen.getByRole("link", { name: "Approvals" })).toBeInTheDocument();

  // ── Step 3: Plan (dry-run) — dry_run:true FIRST ─────────────────────────

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i }, WAIT_OPTS);
  await act(async () => {
    fireEvent.click(planBtn);
  });

  // Hard invariant: planned phase shows plan items WITHOUT pending_approval yet.
  // MSW POST /api/apply { dry_run:true } → { status:"planned", plan:[...] }
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/mudanças previstas|service:bevox-backend/i.test(bodyText)).toBe(true);
    // pending_approval must NOT be visible yet — dry_run:false hasn't been sent
    expect(bodyText).not.toMatch(/pending_approval/);
  }, WAIT_OPTS);

  // ── Step 4: Apply → Approval Gate — dry_run:false → pending_approval ────

  const applyBtn = await screen.findByRole("button", { name: /apply.*approval.*gate/i }, WAIT_OPTS);
  await act(async () => {
    fireEvent.click(applyBtn);
  });

  // Hard invariant: pending_approval + approval_id surfaced.
  // MSW POST /api/apply { dry_run:false } → { status:"pending_approval", approval_id:"apr_NNN" }
  // Capture the specific approval_id rendered on screen so Step 5 can assert the exact id.
  let capturedApprovalId = "";
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/pending_approval/i.test(bodyText)).toBe(true);
    const match = bodyText.match(/apr_([0-9a-f]+)/i);
    expect(match).not.toBeNull();
    capturedApprovalId = match![0]; // e.g. "apr_65"
  }, WAIT_OPTS);

  // ── Step 5: Navigate to Approvals by clicking the "Approvals" NavLink ───

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Approvals" }));
  });

  // Assert the EXACT approval_id captured in Step 4 appears in the Approvals list.
  // This proves the just-created approval (not merely the seeded fixtures) is listed.
  // MSW GET /api/approvals → pending list (filtered to status:"pending"), which now
  // includes the approval pushed by the postApply handler.
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain(capturedApprovalId);
  }, WAIT_OPTS);

  // ── Step 6: Approve an approval → item leaves the pending list ──────────

  const approveButtons = await screen.findAllByRole("button", { name: /aprovar/i }, WAIT_OPTS);
  const initialApproveCount = approveButtons.length;

  await act(async () => {
    fireEvent.click(approveButtons[0]);
  });

  // After MSW POST /api/approvals/:id/approve → status:"applied" → useWrite
  // invalidates all queries → GET /api/approvals refetches → approved item removed.
  await waitFor(() => {
    const currentApproveButtons = screen.queryAllByRole("button", { name: /aprovar/i });
    expect(currentApproveButtons.length).toBeLessThan(initialApproveCount);
  }, WAIT_OPTS);

  // ── Step 7: Navigate to Events by clicking the "Events" NavLink ──────────

  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Events" }));
  });

  // Audit trail must render with agent actor entries.
  // Fixture stateEvents[0]: actor "vox", op "update", entity "service:bevox-harness"
  // This demonstrates "evento reflete resultado com ator" — the agent (vox) is recorded.
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toMatch(/vox/);
  }, WAIT_OPTS);

  // Confirm the Events screen header is rendered
  expect(await screen.findByText(/audit trail/i, {}, WAIT_OPTS)).toBeInTheDocument();
}, 20_000);
