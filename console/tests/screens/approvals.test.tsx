/**
 * console/tests/screens/approvals.test.tsx
 *
 * TDD tests for the Approvals screen (Task 10).
 *
 * Covers:
 *  - Both pending approvals from MSW appear (apr_8f3, apr_8f4)
 *  - Actor, TTL remaining, and impact text are shown per approval
 *  - [Aprovar] and [Rejeitar] buttons present for each approval
 *  - Clicking [Aprovar] issues POST /api/approvals/:id/approve
 *    and the list updates (approval leaves pending list)
 *  - Clicking [Rejeitar] issues POST /api/approvals/:id/reject
 *    and the list updates
 *  - Buttons disabled while write.isPending (delayed MSW handler)
 *  - Error response surfaces .notice-error via lib/errors
 *  - External "↗ abrir no Approval Center" link is an <a> element (not a router Link)
 *  - Loading state shown before data arrives
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Approvals } from "../../src/screens/Approvals";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /approvals
// ---------------------------------------------------------------------------

function renderApprovals() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/approvals"]}>
        <Routes>
          <Route path="/approvals" element={<Approvals />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Reset MSW state before each test so mutations don't bleed across
beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Approvals list appears from MSW
// ---------------------------------------------------------------------------

it("shows apr_8f3 (destroy server:bevox-db-1) from MSW /api/approvals", async () => {
  renderApprovals();
  expect(await screen.findByText(/apr_8f3/)).toBeInTheDocument();
  // Use findAllByText since entity appears in multiple elements (action line + impact)
  const matches = await screen.findAllByText(/server:bevox-db-1/);
  expect(matches.length).toBeGreaterThan(0);
});

it("shows apr_8f4 (restore volume:pg-data) from MSW /api/approvals", async () => {
  renderApprovals();
  expect(await screen.findByText(/apr_8f4/)).toBeInTheDocument();
  // Use findAllByText since entity appears in multiple elements
  const matches = await screen.findAllByText(/volume:pg-data/);
  expect(matches.length).toBeGreaterThan(0);
});

it("shows the action for apr_8f3 (destroy)", async () => {
  renderApprovals();
  // apr_8f3 action is "destroy", entity is "server:bevox-db-1"
  await screen.findByText(/apr_8f3/);
  const bodyText = document.body.textContent ?? "";
  expect(/destroy/i.test(bodyText)).toBe(true);
});

it("shows actor 'vox' for apr_8f3", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);
  // Multiple elements may match /vox/ (e.g. actor span + text node); use findAllByText
  const matches = await screen.findAllByText(/vox/);
  expect(matches.length).toBeGreaterThan(0);
});

it("shows actor 'bernard' for apr_8f4", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f4/);
  expect(await screen.findByText(/bernard/)).toBeInTheDocument();
});

it("shows TTL remaining for apr_8f3 (22h)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);
  expect(await screen.findByText(/22h/)).toBeInTheDocument();
});

it("shows TTL remaining for apr_8f4 (23h)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f4/);
  expect(await screen.findByText(/23h/)).toBeInTheDocument();
});

it("shows impact text for apr_8f3", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);
  // Impact contains "remove server:bevox-db-1" and "bevox-backend"
  const bodyText = document.body.textContent ?? "";
  expect(/bevox-backend/i.test(bodyText)).toBe(true);
});

it("shows impact text for apr_8f4 (potencial perda de dados)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f4/);
  const bodyText = document.body.textContent ?? "";
  expect(/perda de dados|pg-data/i.test(bodyText)).toBe(true);
});

// ---------------------------------------------------------------------------
// Aprovar / Rejeitar buttons present
// ---------------------------------------------------------------------------

it("shows at least two [Aprovar] buttons (one per pending approval)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);
  const approveButtons = await screen.findAllByRole("button", { name: /aprovar/i });
  expect(approveButtons.length).toBeGreaterThanOrEqual(2);
});

it("shows at least two [Rejeitar] buttons (one per pending approval)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);
  const rejectButtons = await screen.findAllByRole("button", { name: /rejeitar/i });
  expect(rejectButtons.length).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Clicking [Aprovar] issues POST .../approve and list updates
// ---------------------------------------------------------------------------

it("clicking [Aprovar] on apr_8f3 issues POST /api/approvals/apr_8f3/approve", async () => {
  let capturedUrl = "";
  mswServer.use(
    http.post("*/api/approvals/:id/approve", ({ params }) => {
      capturedUrl = `/api/approvals/${params.id as string}/approve`;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderApprovals();
  await screen.findByText(/apr_8f3/);

  // The first [Aprovar] button corresponds to apr_8f3 (listed first)
  const approveButtons = screen.getAllByRole("button", { name: /aprovar/i });
  fireEvent.click(approveButtons[0]);

  await waitFor(() => {
    expect(capturedUrl).toMatch(/\/api\/approvals\/apr_8f3\/approve/);
  });
});

it("after approving apr_8f3, the list re-fetches and apr_8f3 leaves pending", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);

  // Click the first Aprovar button (apr_8f3)
  const approveButtons = screen.getAllByRole("button", { name: /aprovar/i });
  fireEvent.click(approveButtons[0]);

  // After the mutation succeeds and queries are invalidated, apr_8f3 should be gone
  // (handler returns status:"applied" which triggers invalidateQueries)
  await waitFor(() => {
    expect(screen.queryByText(/apr_8f3/)).toBeNull();
  });
});

it("clicking [Rejeitar] on apr_8f4 issues POST /api/approvals/apr_8f4/reject", async () => {
  let capturedUrl = "";
  mswServer.use(
    http.post("*/api/approvals/:id/reject", ({ params }) => {
      capturedUrl = `/api/approvals/${params.id as string}/reject`;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderApprovals();
  await screen.findByText(/apr_8f4/);

  // The second [Rejeitar] button corresponds to apr_8f4 (listed second)
  const rejectButtons = screen.getAllByRole("button", { name: /rejeitar/i });
  fireEvent.click(rejectButtons[1]);

  await waitFor(() => {
    expect(capturedUrl).toMatch(/\/api\/approvals\/apr_8f4\/reject/);
  });
});

it("after rejecting apr_8f4, the list re-fetches and apr_8f4 leaves pending", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f4/);

  // Click the second Rejeitar button (apr_8f4)
  const rejectButtons = screen.getAllByRole("button", { name: /rejeitar/i });
  fireEvent.click(rejectButtons[1]);

  await waitFor(() => {
    expect(screen.queryByText(/apr_8f4/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Buttons disabled while write.isPending (delayed handler) — per-card isolation
// ---------------------------------------------------------------------------

it("acting on apr_8f3 only disables apr_8f3's buttons; apr_8f4's buttons stay enabled", async () => {
  let resolveMutation!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });

  mswServer.use(
    http.post("*/api/approvals/:id/approve", async () => {
      await delayPromise;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderApprovals();
  await screen.findByText(/apr_8f3/);
  await screen.findByText(/apr_8f4/);

  // Click Aprovar on apr_8f3 (first card) via its aria-label
  const approveApr8f3 = screen.getByRole("button", { name: /Aprovar apr_8f3/i });
  expect(approveApr8f3).not.toBeDisabled();

  fireEvent.click(approveApr8f3);

  // While apr_8f3's mutation is in-flight:
  //   - apr_8f3's Aprovar button must be disabled
  //   - apr_8f4's Aprovar button must NOT be disabled (per-card isolation)
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /Aprovar apr_8f3/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Aprovar apr_8f4/i })).not.toBeDisabled();
  });

  await act(async () => {
    resolveMutation();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Error response surfaces .notice-error
// ---------------------------------------------------------------------------

it("error response from approve surfaces notice-error with error message", async () => {
  mswServer.use(
    http.post("*/api/approvals/:id/approve", ({ params }) => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "not_found",
            message: `approval ${params.id as string} not found`,
            retryable: false,
            entity: `approval:${params.id as string}`,
          },
        },
        { status: 404 },
      );
    }),
  );

  renderApprovals();
  await screen.findByText(/apr_8f3/);

  const approveButtons = screen.getAllByRole("button", { name: /aprovar/i });
  fireEvent.click(approveButtons[0]);

  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/not found|not_found/i.test(bodyText)).toBe(true);
  });
});

it("error response from reject surfaces notice-error with error message", async () => {
  mswServer.use(
    http.post("*/api/approvals/:id/reject", ({ params }) => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "not_found",
            message: `approval ${params.id as string} not found`,
            retryable: false,
            entity: `approval:${params.id as string}`,
          },
        },
        { status: 404 },
      );
    }),
  );

  renderApprovals();
  await screen.findByText(/apr_8f3/);

  const rejectButtons = screen.getAllByRole("button", { name: /rejeitar/i });
  fireEvent.click(rejectButtons[0]);

  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// External "↗ abrir no Approval Center" link is an <a>, NOT a router Link
// ---------------------------------------------------------------------------

it("shows external 'Approval Center' anchor links (not router Links)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);

  // findAllByRole("link", ...) matches <a> elements
  const approvalCenterLinks = await screen.findAllByRole("link", {
    name: /approval center/i,
  });
  // There should be one per approval card (2 pending approvals)
  expect(approvalCenterLinks.length).toBeGreaterThanOrEqual(2);

  // Each must be a plain <a> element — check tagName
  approvalCenterLinks.forEach((link) => {
    expect(link.tagName.toLowerCase()).toBe("a");
    // Must have href attribute (placeholder "#" or any value)
    expect(link).toHaveAttribute("href");
  });
});

it("Approval Center links open in a new tab (target=_blank)", async () => {
  renderApprovals();
  await screen.findByText(/apr_8f3/);

  const approvalCenterLinks = await screen.findAllByRole("link", {
    name: /approval center/i,
  });
  approvalCenterLinks.forEach((link) => {
    expect(link).toHaveAttribute("target", "_blank");
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows a loading indicator while /api/approvals is in-flight", async () => {
  let resolveApprovals!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveApprovals = resolve;
  });

  mswServer.use(
    http.get("*/api/approvals", async () => {
      await delayPromise;
      return HttpResponse.json([]);
    }),
  );

  renderApprovals();

  // Loading text should be visible before the request resolves
  const loadingEl = screen.queryByText(/carregando|loading/i);
  expect(loadingEl).not.toBeNull();

  await act(async () => {
    resolveApprovals();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Error state for GET /api/approvals
// ---------------------------------------------------------------------------

it("shows an error notice when GET /api/approvals fails", async () => {
  mswServer.use(
    http.get("*/api/approvals", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderApprovals();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/erro|error/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state — no pending approvals
// ---------------------------------------------------------------------------

it("shows an empty state message when there are no pending approvals", async () => {
  mswServer.use(
    http.get("*/api/approvals", () => {
      return HttpResponse.json([]);
    }),
  );

  renderApprovals();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/sem aprovações|nenhuma|no pending|pendentes/i.test(bodyText)).toBe(true);
  });
});
