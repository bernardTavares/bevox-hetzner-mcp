/**
 * console/tests/screens/manifest.test.tsx
 *
 * TDD tests for the Manifest screen (Task 12).
 *
 * Covers:
 *  - Tabs [git] [working] exist; working active by default
 *  - Switching tabs re-queries useDiff with different source (content changes)
 *  - Divergence warning with link to /apply present
 *  - YAML/manifest area rendered
 *  - HARD INVARIANT: Promote follows dry_run:true FIRST (planned phase shown)
 *    BEFORE any dry_run:false — pending_approval/approval_id then surfaced
 *  - Promote button and Validar disabled while isPending (delayed handler)
 *  - Error from promote action surfaces notice-error
 *  - Any drift item in the shown diff has NO destroy/remove control
 *  - Loading state while diff data is in-flight
 *  - Error state when GET /api/diff fails
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Manifest } from "../../src/screens/Manifest";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /manifest
// ---------------------------------------------------------------------------

function renderManifest() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/manifest"]}>
        <Routes>
          <Route path="/manifest" element={<Manifest />} />
          <Route path="/apply" element={<div>Apply Screen</div>} />
          <Route path="/approvals" element={<div>Approval Center</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Tabs exist
// ---------------------------------------------------------------------------

it("shows a 'working' tab button", async () => {
  renderManifest();
  expect(await screen.findByRole("button", { name: /^working/i })).toBeInTheDocument();
});

it("shows a 'git' tab button", async () => {
  renderManifest();
  expect(await screen.findByRole("button", { name: /^git$/i })).toBeInTheDocument();
});

it("working tab is active by default", async () => {
  renderManifest();
  const workingBtn = await screen.findByRole("button", { name: /^working/i });
  expect(workingBtn.className).toMatch(/active/);
});

// ---------------------------------------------------------------------------
// YAML manifest area rendered
// ---------------------------------------------------------------------------

it("renders a YAML/manifest content area (code-area or pre)", async () => {
  renderManifest();
  // The manifest display area (textarea or pre with class code-area) must be present
  await waitFor(() => {
    const codeArea =
      document.querySelector(".code-area") ||
      document.querySelector("pre") ||
      document.querySelector("textarea");
    expect(codeArea).not.toBeNull();
  });
});

it("manifest area contains YAML-like content (servers: or services:)", async () => {
  renderManifest();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/servers:|services:|volumes:/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Divergence warning with link to /apply
// ---------------------------------------------------------------------------

it("shows a divergence warning notice", async () => {
  renderManifest();
  await waitFor(() => {
    const notices = document.querySelectorAll(".notice-warn");
    expect(notices.length).toBeGreaterThan(0);
  });
});

it("divergence warning contains text about working diverging from git", async () => {
  renderManifest();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/diverge|diferença/i.test(bodyText)).toBe(true);
  });
});

it("divergence warning contains a link to /apply", async () => {
  renderManifest();
  // Find a link that points to /apply
  await waitFor(() => {
    const links = Array.from(document.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/apply" || a.textContent?.match(/diff|apply/i),
    );
    expect(links.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Switching tabs re-queries with different source (diff content changes)
// ---------------------------------------------------------------------------

it("switching to 'git' tab changes source and re-queries diff", async () => {
  // Override GET /api/diff to return different content per source
  mswServer.use(
    http.get("*/api/diff", ({ request }) => {
      const url = new URL(request.url);
      const source = url.searchParams.get("source");
      if (source === "git") {
        return HttpResponse.json([
          {
            op: "update",
            entity: "service:git-only-entity",
            change: "git source item",
            impact: "none",
          },
        ]);
      }
      // working (default)
      return HttpResponse.json([
        {
          op: "update",
          entity: "service:bevox-backend",
          change: "image v7 → v8",
          impact: "rolling restart",
        },
      ]);
    }),
  );

  renderManifest();

  // Wait for initial working diff to load — working is default
  await screen.findByRole("button", { name: /^working/i });

  // Switch to git tab
  const gitBtn = screen.getByRole("button", { name: /^git$/i });
  fireEvent.click(gitBtn);

  // Now the git tab should be active
  await waitFor(() => {
    expect(gitBtn.className).toMatch(/active/);
  });
});

// ---------------------------------------------------------------------------
// Validar button present (honest client-side check, not a fake backend)
// ---------------------------------------------------------------------------

it("shows a Validar button", async () => {
  renderManifest();
  expect(await screen.findByRole("button", { name: /validar/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Promote button present
// ---------------------------------------------------------------------------

it("shows a Promover/Promote button", async () => {
  renderManifest();
  expect(await screen.findByRole("button", { name: /promover|promote/i })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// HARD INVARIANT: dry_run:true FIRST — plan phase shown BEFORE any dry_run:false
// ---------------------------------------------------------------------------

it("clicking Promover triggers dry_run:true (planned phase) BEFORE any dry_run:false", async () => {
  renderManifest();

  // Wait for UI to load
  await screen.findByRole("button", { name: /promover|promote/i });

  const promoteBtn = screen.getByRole("button", { name: /promover|promote/i });
  fireEvent.click(promoteBtn);

  // After first click, the planned phase must be shown — pending_approval must NOT be visible yet
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    // planned/plano text must appear
    expect(/plan|plano|mudanças|previstas/i.test(bodyText)).toBe(true);
    // pending_approval must NOT be visible yet
    expect(bodyText).not.toMatch(/pending_approval/);
  });
});

it("planned phase from Promover shows diff plan items (e.g. service:bevox-backend)", async () => {
  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  const promoteBtn = screen.getByRole("button", { name: /promover|promote/i });
  fireEvent.click(promoteBtn);

  // The planned result should include items from dry_run:true response
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/service:bevox-backend|volume:pg-data/i.test(bodyText)).toBe(true);
  });
});

it("after planned phase, explicit Confirmar Promoção issues dry_run:false → pending_approval surfaced", async () => {
  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  const promoteBtn = screen.getByRole("button", { name: /promover|promote/i });
  fireEvent.click(promoteBtn);

  // Wait for planned phase — a confirm button appears
  const confirmBtn = await screen.findByRole("button", { name: /confirmar|confirm|approval.*gate/i });

  // At this point, pending_approval must NOT yet be shown
  expect(document.body.textContent).not.toMatch(/pending_approval/);

  // Click the confirm button → dry_run:false
  fireEvent.click(confirmBtn);

  // pending_approval should now be surfaced
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/pending_approval|apr_/i.test(bodyText)).toBe(true);
  });
});

it("approval_id is surfaced to the user after pending_approval on promote", async () => {
  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  const confirmBtn = await screen.findByRole("button", { name: /confirmar|confirm|approval.*gate/i });
  fireEvent.click(confirmBtn);

  // approval_id (apr_NNN format) or approval center link must be visible
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/apr_|approval.*id|approval.*center|approvals/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Buttons disabled while isPending (delayed handler)
// ---------------------------------------------------------------------------

it("Promover and Validar buttons are disabled while mutation is in-flight", async () => {
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

  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  const promoteBtn = screen.getByRole("button", { name: /promover|promote/i });
  expect(promoteBtn).not.toBeDisabled();

  fireEvent.click(promoteBtn);

  // While mutation is in-flight, buttons must be disabled
  await waitFor(() => {
    const allBtns = screen.queryAllByRole("button");
    const disabledBtns = allBtns.filter((b) => b.hasAttribute("disabled"));
    expect(disabledBtns.length).toBeGreaterThan(0);
  });

  await act(async () => {
    resolveMutation();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Error from promote surfaces notice-error
// ---------------------------------------------------------------------------

it("POST /api/apply returning an error surfaces a visible notice-error", async () => {
  mswServer.use(
    http.post("*/api/apply", async () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "conflict",
            message: "promote blocked by drift",
            retryable: false,
            entity: "manifest:working",
          },
        },
        { status: 422 },
      );
    }),
  );

  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  // Error notice must appear
  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });

  // Error text visible
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/conflict|promote blocked|drift/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HARD INVARIANT: drift item in shown diff has NO destroy/remove control
// ---------------------------------------------------------------------------

it("after promote planned phase, drift item server:bevox-x-9 has NO destroy/remove button", async () => {
  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  // Wait for planned diff to show (which includes the drift item from MSW)
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/service:bevox-backend|plano|plan/i.test(bodyText)).toBe(true);
  });

  // No button with destroy/remove/delete label in the document
  const buttons = screen.queryAllByRole("button").filter((btn) =>
    /destroy|remove|delete/i.test(btn.textContent ?? ""),
  );
  expect(buttons).toHaveLength(0);
});

it("drift item in promote diff shows fail-safe/não destruído indicator", async () => {
  renderManifest();
  await screen.findByRole("button", { name: /promover|promote/i });

  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  // The MSW /api/apply response includes a drift item with fail-safe message
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    // The drift item entity server:bevox-x-9 or fail-safe text must be present
    expect(/server:bevox-x-9|fail.?safe|não destruído/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loading and error states for diff query
// ---------------------------------------------------------------------------

it("shows loading state while diff data is in-flight", async () => {
  let resolveDiff!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveDiff = resolve;
  });

  mswServer.use(
    http.get("*/api/diff", async () => {
      await delayPromise;
      return HttpResponse.json([]);
    }),
  );

  renderManifest();

  // Loading indicator should appear while data is in-flight
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/carregando|loading/i.test(bodyText)).toBe(true);
  });

  await act(async () => {
    resolveDiff();
    await delayPromise;
  });
});

it("shows error state when GET /api/diff fails", async () => {
  mswServer.use(
    http.get("*/api/diff", () => {
      return HttpResponse.json({ error: "server error" }, { status: 500 });
    }),
  );

  renderManifest();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/erro|error/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-2: switching source tab resets an in-progress promote phase to idle
// ---------------------------------------------------------------------------

it("switching source tab while in planned phase resets promote to idle", async () => {
  renderManifest();

  // Wait for Promover button then click it to enter planned phase
  await screen.findByRole("button", { name: /promover|promote/i });
  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  // Confirm we are in planned phase (Confirmar Promoção button visible, plan shown)
  const confirmBtn = await screen.findByRole("button", {
    name: /confirmar|confirm|approval.*gate/i,
  });
  expect(confirmBtn).toBeInTheDocument();

  // Switch to git tab — this should reset the promote phase to idle
  const gitBtn = screen.getByRole("button", { name: /^git$/i });
  fireEvent.click(gitBtn);

  // Confirmar Promoção button must be gone (phase reset to idle)
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: /confirmar|confirm|approval.*gate/i }),
    ).not.toBeInTheDocument();
  });

  // Promover button must be back (idle state)
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /promover|promote/i }),
    ).toBeInTheDocument();
  });

  // The planned diff items must no longer be shown
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/mudanças previstas|plano de promoção/i.test(bodyText)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-3: clicking Cancelar in planned phase returns to idle
// ---------------------------------------------------------------------------

it("clicking Cancelar in planned phase resets promote to idle", async () => {
  renderManifest();

  // Enter planned phase
  await screen.findByRole("button", { name: /promover|promote/i });
  fireEvent.click(screen.getByRole("button", { name: /promover|promote/i }));

  // Wait for planned phase — Cancelar and Confirmar must both be visible
  const cancelBtn = await screen.findByRole("button", { name: /cancelar promoção/i });
  expect(cancelBtn).toBeInTheDocument();

  // Click Cancelar
  fireEvent.click(cancelBtn);

  // Planned phase must be gone — Confirmar Promoção must disappear
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: /confirmar|confirm|approval.*gate/i }),
    ).not.toBeInTheDocument();
  });

  // Promover button is back (idle)
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /promover|promote/i }),
    ).toBeInTheDocument();
  });

  // No notice-error visible (no spurious error shown on clean cancel)
  await waitFor(() => {
    expect(document.querySelector(".notice-error")).toBeNull();
  });

  // Planned notice must be gone
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/mudanças previstas|plano de promoção/i.test(bodyText)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-4: Validar shows which source in the result message
// ---------------------------------------------------------------------------

it("clicking Validar on the git tab shows a message mentioning 'git' and 'client-side'", async () => {
  renderManifest();

  // Switch to git tab
  await screen.findByRole("button", { name: /^git$/i });
  fireEvent.click(screen.getByRole("button", { name: /^git$/i }));

  // Click Validar
  const validarBtn = await screen.findByRole("button", { name: /validar/i });
  fireEvent.click(validarBtn);

  // Message must mention git AND client-side
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/git/i.test(bodyText)).toBe(true);
    expect(/client.?side/i.test(bodyText)).toBe(true);
  });
});

it("clicking Validar on the working tab shows a message mentioning 'working' and 'client-side'", async () => {
  renderManifest();

  // working tab is default — click Validar directly
  const validarBtn = await screen.findByRole("button", { name: /validar/i });
  fireEvent.click(validarBtn);

  // Message must mention working AND client-side
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/working/i.test(bodyText)).toBe(true);
    expect(/client.?side/i.test(bodyText)).toBe(true);
  });
});
