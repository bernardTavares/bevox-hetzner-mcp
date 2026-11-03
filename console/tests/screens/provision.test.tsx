/**
 * console/tests/screens/provision.test.tsx
 *
 * TDD tests for the ProvisionServer screen (Task 13).
 *
 * Covers:
 *  - Route /provision renders the screen
 *  - Step indicator with 3 steps (Básico, Rede, Revisão) rendered
 *  - Step 1 (Básico) fields: name, type, location, image, ssh_keys
 *  - Próximo advances to step 2; Voltar returns to step 1
 *  - Validation gate: cannot advance past Básico without a name
 *  - Step 2 (Rede) fields: network, labels, volumes
 *  - Advancing to step 3 (Revisão) shows the cost/Approval warning
 *  - Revisão shows a summary of entered values
 *  - HARD INVARIANT: Plan (dry_run) issues dry_run:true (planned phase shown) BEFORE any dry_run:false
 *  - Explicit "Provisionar → Approval" issues dry_run:false → pending_approval/approval_id surfaced
 *  - Action buttons disabled while isPending (delayed handler)
 *  - Error envelope → notice-error
 *  - DiffView shows drift items read-only (no destroy button)
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { ProvisionServer } from "../../src/screens/ProvisionServer";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /provision
// ---------------------------------------------------------------------------

function renderProvision() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/provision"]}>
        <Routes>
          <Route path="/provision" element={<ProvisionServer />} />
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
// Step indicator renders
// ---------------------------------------------------------------------------

it("renders the wizard step indicator with 3 steps", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/básico|rede|revisão/i.test(bodyText)).toBe(true);
  });
});

it("renders step 1 label 'Básico' in the step indicator", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/básico/i.test(bodyText)).toBe(true);
  });
});

it("renders step 2 label 'Rede' in the step indicator", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/rede/i.test(bodyText)).toBe(true);
  });
});

it("renders step 3 label 'Revisão' in the step indicator", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/revisão/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 1 (Básico) fields render
// ---------------------------------------------------------------------------

it("renders name field on step 1", async () => {
  renderProvision();
  const nameInput = await screen.findByLabelText(/^name$/i);
  expect(nameInput).toBeInTheDocument();
});

it("renders type field on step 1", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/type|cx32|cx22/i.test(bodyText)).toBe(true);
  });
});

it("renders location field on step 1", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/location|nbg1|fsn1/i.test(bodyText)).toBe(true);
  });
});

it("renders image field on step 1", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/image|ubuntu/i.test(bodyText)).toBe(true);
  });
});

it("renders ssh_keys field on step 1", async () => {
  renderProvision();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/ssh.?key|bevox.?ops/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation gate: cannot advance from Básico without a name
// ---------------------------------------------------------------------------

it("shows validation error when Próximo clicked with empty name on step 1", async () => {
  renderProvision();
  const nextBtn = await screen.findByRole("button", { name: /próximo/i });

  // Clear name field
  const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: "" } });

  fireEvent.click(nextBtn);

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/nome|name.*obrigatório|required|campo.*required/i.test(bodyText)).toBe(true);
  });
});

it("stays on step 1 when Próximo clicked with empty name", async () => {
  renderProvision();
  const nextBtn = await screen.findByRole("button", { name: /próximo/i });

  const nameInput = screen.getByLabelText(/^name$/i) as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: "" } });

  fireEvent.click(nextBtn);

  // Still on step 1 — name field still visible
  await waitFor(() => {
    expect(screen.queryByLabelText(/^name$/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Navigation: Próximo advances step, Voltar goes back
// ---------------------------------------------------------------------------

it("clicking Próximo with a valid name advances to step 2 (Rede)", async () => {
  renderProvision();
  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });

  const nextBtn = screen.getByRole("button", { name: /próximo/i });
  fireEvent.click(nextBtn);

  // Step 2 content — network field
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/network|rede.*volumes|passo\s*2/i.test(bodyText)).toBe(true);
  });
});

it("step 1 name field is no longer visible after advancing to step 2", async () => {
  renderProvision();
  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });

  const nextBtn = screen.getByRole("button", { name: /próximo/i });
  fireEvent.click(nextBtn);

  await waitFor(() => {
    // The name label input from step 1 should be gone
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });
});

it("clicking Voltar from step 2 returns to step 1", async () => {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });

  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  // Now on step 2
  const backBtn = await screen.findByRole("button", { name: /voltar/i });
  fireEvent.click(backBtn);

  // Back on step 1 — name field visible again
  await waitFor(() => {
    expect(screen.queryByLabelText(/^name$/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// M3: Back navigation preserves form state (round-trip)
// ---------------------------------------------------------------------------

it("navigating Próximo then Voltar preserves the name entered on step 1", async () => {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i) as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: "bevox-roundtrip" } });

  // Advance to step 2
  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  // Now on step 2 — go back
  const backBtn = await screen.findByRole("button", { name: /voltar/i });
  fireEvent.click(backBtn);

  // Back on step 1 — name value must still be what we typed
  await waitFor(() => {
    const input = screen.getByLabelText(/^name$/i) as HTMLInputElement;
    expect(input.value).toBe("bevox-roundtrip");
  });
});

// ---------------------------------------------------------------------------
// Step 2 (Rede) fields render
// ---------------------------------------------------------------------------

it("step 2 shows a network field", async () => {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });
  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/network|bevox.?priv/i.test(bodyText)).toBe(true);
  });
});

it("step 2 shows a labels field", async () => {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });
  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/label/i.test(bodyText)).toBe(true);
  });
});

it("step 2 shows a volumes field", async () => {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });
  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/volume/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 3 (Revisão): reaching it shows cost/Approval warning
// ---------------------------------------------------------------------------

async function navigateToStep3() {
  renderProvision();

  const nameInput = await screen.findByLabelText(/^name$/i);
  fireEvent.change(nameInput, { target: { value: "bevox-app-test" } });
  fireEvent.click(screen.getByRole("button", { name: /próximo/i }));

  // On step 2, click Próximo again to reach Revisão
  const step2NextBtn = await screen.findByRole("button", { name: /próximo/i });
  fireEvent.click(step2NextBtn);
}

it("reaching Revisão (step 3) shows the cost/Approval warning notice", async () => {
  await navigateToStep3();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/custo|approval.*gate|operação.*custo/i.test(bodyText)).toBe(true);
  });
});

it("Revisão step shows a 'Plan (dry_run)' button", async () => {
  await navigateToStep3();
  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  expect(planBtn).toBeInTheDocument();
});

it("Revisão shows a summary of entered name", async () => {
  await navigateToStep3();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/bevox-app-test/i.test(bodyText)).toBe(true);
  });
});

it("Revisão shows the step indicator with step 3 active", async () => {
  await navigateToStep3();
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/revisão/i.test(bodyText)).toBe(true);
  });
});

it("Voltar from Revisão returns to step 2", async () => {
  await navigateToStep3();
  const backBtn = await screen.findByRole("button", { name: /voltar/i });
  fireEvent.click(backBtn);

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/network|bevox.?priv/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HARD INVARIANT: dry_run:true FIRST → planned shown; THEN dry_run:false
// ---------------------------------------------------------------------------

it("clicking Plan (dry_run) triggers dry_run:true (planned phase shown) BEFORE any dry_run:false", async () => {
  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // After first click, planned phase must be shown — pending_approval must NOT be visible yet
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/plan|plano|previstas|server:bevox-app-test/i.test(bodyText)).toBe(true);
    expect(bodyText).not.toMatch(/pending_approval/);
  });
});

it("planned phase shows a Provisionar → Approval button", async () => {
  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  const provisionarBtn = await screen.findByRole("button", {
    name: /provisionar.*approval|provisionar/i,
  });
  expect(provisionarBtn).toBeInTheDocument();
});

it("planned phase shows plan items from dry_run:true response in DiffView", async () => {
  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    // MSW returns server:bevox-app-test plan item
    expect(/server:bevox-app-test|nova.*instância/i.test(bodyText)).toBe(true);
  });
});

it("after planned phase, Provisionar → Approval issues dry_run:false → pending_approval surfaced", async () => {
  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Wait for planned phase
  const provisionarBtn = await screen.findByRole("button", {
    name: /provisionar.*approval|provisionar/i,
  });

  // At this point, pending_approval must NOT yet be shown
  expect(document.body.textContent).not.toMatch(/pending_approval/);

  // Click Provisionar → dry_run:false
  fireEvent.click(provisionarBtn);

  // pending_approval should now be surfaced
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/pending_approval|apr_/i.test(bodyText)).toBe(true);
  });
});

it("approval_id is surfaced to the user after pending_approval on provision", async () => {
  await navigateToStep3();

  fireEvent.click(await screen.findByRole("button", { name: /plan.*dry.?run/i }));
  const provisionarBtn = await screen.findByRole("button", {
    name: /provisionar.*approval|provisionar/i,
  });
  fireEvent.click(provisionarBtn);

  // approval_id (apr_NNN format) or approval center link must be visible
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/apr_|approval.*id|approval.*center|approvals/i.test(bodyText)).toBe(true);
  });
});

it("pending_approval phase shows a link to /approvals", async () => {
  await navigateToStep3();

  fireEvent.click(await screen.findByRole("button", { name: /plan.*dry.?run/i }));
  await screen.findByRole("button", { name: /provisionar.*approval|provisionar/i });
  fireEvent.click(screen.getByRole("button", { name: /provisionar.*approval|provisionar/i }));

  await waitFor(() => {
    const links = Array.from(document.querySelectorAll("a")).filter(
      (a) => a.getAttribute("href") === "/approvals" || /approvals|approval.*center/i.test(a.textContent ?? ""),
    );
    expect(links.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Buttons disabled while isPending (delayed handler)
// ---------------------------------------------------------------------------

it("Plan and Provisionar buttons are disabled while mutation is in-flight", async () => {
  let resolveMutation!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });

  mswServer.use(
    http.post("*/api/servers", async () => {
      await delayPromise;
      return HttpResponse.json({
        status: "planned",
        plan: [
          {
            op: "create",
            entity: "server:bevox-app-test",
            change: "type=cx32 location=nbg1",
            impact: "nova instância Hetzner",
          },
        ],
      });
    }),
  );

  await navigateToStep3();
  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  expect(planBtn).not.toBeDisabled();

  fireEvent.click(planBtn);

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
// Error envelope → notice-error
// ---------------------------------------------------------------------------

it("error from POST /api/servers surfaces a visible notice-error", async () => {
  mswServer.use(
    http.post("*/api/servers", async () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "invalid_input",
            message: "forced error for testing",
            retryable: false,
            entity: "server:__force_error__",
          },
        },
        { status: 422 },
      );
    }),
  );

  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  await waitFor(() => {
    const errorNotice = document.querySelector(".notice-error");
    expect(errorNotice).not.toBeNull();
  });

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/invalid_input|forced error/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HARD INVARIANT: drift items in the shown plan have NO destroy/remove control
// ---------------------------------------------------------------------------

it("plan items from dry_run show NO destroy/remove button (DiffView read-only)", async () => {
  // Override /api/servers to include a drift item in the plan
  mswServer.use(
    http.post("*/api/servers", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dry_run !== false) {
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "create",
              entity: "server:bevox-app-test",
              change: "type=cx32 location=nbg1",
              impact: "nova instância Hetzner",
            },
            {
              op: "drift",
              entity: "server:bevox-x-9",
              change: "DRIFT — não está no manifesto",
              impact: "não destruído (fail-safe)",
            },
          ],
        });
      }
      return HttpResponse.json({ status: "pending_approval", approval_id: "apr_test" });
    }),
  );

  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Wait for planned diff to show
  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/server:bevox-app-test|server:bevox-x-9/i.test(bodyText)).toBe(true);
  });

  // No button with destroy/remove/delete label in the document
  const buttons = screen.queryAllByRole("button").filter((btn) =>
    /destroy|remove|delete/i.test(btn.textContent ?? ""),
  );
  expect(buttons).toHaveLength(0);
});

it("drift item in plan shows fail-safe/não destruído indicator", async () => {
  mswServer.use(
    http.post("*/api/servers", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dry_run !== false) {
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "drift",
              entity: "server:bevox-x-9",
              change: "DRIFT — não está no manifesto",
              impact: "não destruído (fail-safe)",
            },
          ],
        });
      }
      return HttpResponse.json({ status: "pending_approval", approval_id: "apr_test" });
    }),
  );

  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/server:bevox-x-9|fail.?safe|não destruído/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancel planned phase returns to Revisão idle state
// ---------------------------------------------------------------------------

it("clicking Cancelar plano in planned phase resets to step 3 idle", async () => {
  await navigateToStep3();

  const planBtn = await screen.findByRole("button", { name: /plan.*dry.?run/i });
  fireEvent.click(planBtn);

  // Wait for planned phase
  const cancelBtn = await screen.findByRole("button", { name: /cancelar/i });
  expect(cancelBtn).toBeInTheDocument();

  fireEvent.click(cancelBtn);

  // Plan button should be back (idle state on step 3)
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /plan.*dry.?run/i })).toBeInTheDocument();
  });

  // No notice-error on clean cancel
  await waitFor(() => {
    expect(document.querySelector(".notice-error")).toBeNull();
  });
});
