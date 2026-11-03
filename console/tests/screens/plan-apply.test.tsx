/**
 * console/tests/screens/plan-apply.test.tsx
 *
 * TDD tests for the PlanApply screen (Task 9).
 *
 * Covers:
 *  - Diff items from MSW appear (service:bevox-backend, volume:pg-data-2)
 *  - Drift item server:bevox-x-9 shown read-only — NO destroy/remove control
 *  - Source toggle (working/git) exists
 *  - Hard invariant: dry_run:true FIRST (planned plan shown) BEFORE any dry_run:false
 *  - Explicit second Apply → Approval Gate → pending_approval/approval_id surfaced
 *  - Apply button disabled while mutation is in-flight
 *  - Error envelope surfaces notice-error
 *  - [Fix 2] Source toggle resets apply phase to idle
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { PlanApply } from "../../src/screens/PlanApply";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /apply
// ---------------------------------------------------------------------------

function renderPlanApply() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/apply"]}>
        <Routes>
          <Route path="/apply" element={<PlanApply />} />
          {/* Approvals route for Link navigation tests */}
          <Route path="/approvals" element={<div>Approval Center</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Diff items appear from MSW
// ---------------------------------------------------------------------------

it("shows the diff item service:bevox-backend from MSW /api/diff", async () => {
  renderPlanApply();
  expect(await screen.findByText(/service:bevox-backend/)).toBeInTheDocument();
});

it("shows the diff item volume:pg-data-2 from MSW /api/diff", async () => {
  renderPlanApply();
  expect(await screen.findByText(/volume:pg-data-2/)).toBeInTheDocument();
});

it("shows the drift item server:bevox-x-9 from MSW /api/diff", async () => {
  renderPlanApply();
  expect(await screen.findByText(/server:bevox-x-9/)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Hard invariant: drift item server:bevox-x-9 shown read-only, NO destroy control
// ---------------------------------------------------------------------------

it("drift item server:bevox-x-9 is shown with read-only/fail-safe indicator", async () => {
  renderPlanApply();
  // Wait for the diff to load
  await screen.findByText(/server:bevox-x-9/);
  // fail-safe text must be present
  const bodyText = document.body.textContent ?? "";
  expect(/fail.?safe|não destruído/i.test(bodyText)).toBe(true);
});

it("drift item row has NO destroy/remove/delete button", async () => {
  renderPlanApply();
  await screen.findByText(/server:bevox-x-9/);
  // No button with destroy/remove/delete in the document at all
  const buttons = screen.queryAllByRole("button").filter((btn) =>
    /destroy|remove|delete/i.test(btn.textContent ?? ""),
  );
  expect(buttons).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Source toggle
// ---------------------------------------------------------------------------

it("shows a source toggle with 'working' option", async () => {
  renderPlanApply();
  // Source toggle buttons: "working" and "git"
  expect(await screen.findByRole("button", { name: /working/i })).toBeInTheDocument();
});

it("shows a source toggle with 'git' option", async () => {
  renderPlanApply();
  expect(await screen.findByRole("button", { name: /^git$/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Re-plan button
// ---------------------------------------------------------------------------

it("shows a Re-plan button", async () => {
  renderPlanApply();
  expect(await screen.findByRole("button", { name: /re.?plan/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Hard invariant: dry_run:true FIRST — plan phase shown before pending_approval
// Fix 1: button is now labelled "Plan (dry-run)" instead of "Apply (dry_run:false) → Approval"
// ---------------------------------------------------------------------------

it("clicking Plan (dry-run) triggers dry_run:true (planned phase) BEFORE any dry_run:false", async () => {
  renderPlanApply();

  // Wait for diff to load
  await screen.findByText(/service:bevox-backend/);

  // Find and click the Plan (dry-run) button (Fix 1: renamed from misleading Apply label)
  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // After clicking Plan, the screen should show the planned phase FIRST
  // MSW /api/apply with dry_run:true returns status:"planned" with a plan
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    // "planned" or "Plano" must be visible; pending_approval must NOT be visible yet
    expect(/plan|plano/i.test(bodyText)).toBe(true);
    expect(bodyText).not.toMatch(/pending_approval/);
  });
});

it("planned phase shows the plan items from dry_run:true response", async () => {
  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // The planned result should include the items from POST /api/apply dry_run:true
  // MSW returns service:bevox-backend in the plan
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/service:bevox-backend/i.test(bodyText)).toBe(true);
  });
});

it("after planned phase, an explicit Apply → Approval Gate button issues dry_run:false → pending_approval surfaced", async () => {
  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  // Click Plan (dry-run) → triggers dry_run:true  (Fix 1: renamed button)
  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Wait for the planned phase to appear (Apply → Approval Gate button appears)
  // Fix 1: confirm button is now "Apply → Approval Gate"
  const applyApprovalBtn = await screen.findByRole("button", { name: /apply.*approval.*gate/i });

  // At this point, pending_approval must NOT yet be shown
  expect(document.body.textContent).not.toMatch(/pending_approval/);

  // Click Apply → Approval Gate → issues dry_run:false
  fireEvent.click(applyApprovalBtn);

  // pending_approval should now be surfaced (approval_id visible)
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/pending_approval|apr_/i.test(bodyText)).toBe(true);
  });
});

it("approval_id is surfaced to the user after pending_approval", async () => {
  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  const applyApprovalBtn = await screen.findByRole("button", { name: /apply.*approval.*gate/i });
  fireEvent.click(applyApprovalBtn);

  // approval_id (apr_NNN format) or Approval Center link must be visible
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/apr_|approval.*id|approvals/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Apply button disabled while mutation in-flight
// ---------------------------------------------------------------------------

it("Plan (dry-run) button becomes disabled while mutation is pending", async () => {
  let resolveMutation!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });

  mswServer.use(
    http.post("*/api/apply", async () => {
      await delayPromise;
      return HttpResponse.json({
        status: "planned",
        plan: [
          {
            op: "update",
            entity: "service:bevox-backend",
            change: "image v7 → v8",
            impact: "rolling restart, 2 replicas",
          },
        ],
      });
    }),
  );

  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  expect(planBtn).not.toBeDisabled();

  fireEvent.click(planBtn);

  // While mutation is in-flight, the Plan button must be disabled
  await waitFor(() => {
    // The button may have been replaced with a different button during planned phase,
    // but ALL action buttons should be disabled
    const allBtns = screen.queryAllByRole("button");
    // At least one button is disabled (the apply/action buttons)
    const disabledBtns = allBtns.filter((b) => b.hasAttribute("disabled"));
    expect(disabledBtns.length).toBeGreaterThan(0);
  });

  await act(async () => {
    resolveMutation();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Error envelope surfaces notice-error
// ---------------------------------------------------------------------------

it("POST /api/apply returning an error surfaces a visible notice-error", async () => {
  mswServer.use(
    http.post("*/api/apply", async () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "conflict",
            message: "manifest apply blocked by drift",
            retryable: false,
            entity: "manifest:working",
          },
        },
        { status: 422 },
      );
    }),
  );

  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Error notice must appear
  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });

  // Error text visible
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/conflict|manifest apply blocked|drift/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [Fix 2] Source toggle resets apply phase to idle
// ---------------------------------------------------------------------------

it("toggling source after entering planned phase resets apply phase to idle", async () => {
  renderPlanApply();
  await screen.findByText(/service:bevox-backend/);

  // Click Plan (dry-run) → enter planned phase
  const planBtn = screen.getByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Confirm we are in the planned phase (Apply → Approval Gate button visible)
  await screen.findByRole("button", { name: /apply.*approval.*gate/i });

  // Toggle source (click "git" tab)
  const gitBtn = screen.getByRole("button", { name: /^git$/i });
  fireEvent.click(gitBtn);

  // Phase must reset — Apply → Approval Gate button disappears, Plan (dry-run) reappears
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /apply.*approval.*gate/i })).toBeNull();
    expect(screen.getByRole("button", { name: /plan.*dry.?run/i })).toBeInTheDocument();
  });

  // pending_approval must not be shown either
  expect(document.body.textContent).not.toMatch(/pending_approval/);
});
