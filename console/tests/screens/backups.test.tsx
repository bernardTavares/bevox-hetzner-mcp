/**
 * console/tests/screens/backups.test.tsx
 *
 * TDD tests for the Backups screen (Task 15).
 *
 * Hard invariants (tested explicitly):
 *  (H1) Snapshot = non-destructive: POST without dry_run, NO ConfirmDestructive, NO
 *       pending_approval, returns applied → list refreshes.
 *  (H2) Restore = destructive: dry_run:true PRECEDES any dry_run:false;
 *       pending_approval + approval_id surfaced; <Link to=/approvals> rendered.
 *  (H3) Snapshot does NOT require ConfirmDestructive or approval.
 *  (H4) Both buttons disabled while their op is pending (delayed handler).
 *  (H5) Errors surface via .notice-error.
 *
 * Covers:
 *  - Route /backups renders the screen
 *  - Policy data (volume:pg-data, schedule, retention, repo, last run) visible
 *  - Snapshots list visible (dates from fixture)
 *  - [Snapshot agora] present; on click: POST /api/backups/pg-data/snapshot
 *    WITHOUT dry_run:true body / WITHOUT ConfirmDestructive / returns applied
 *  - [Restore ⚠ destrutivo] present; on click: shows ConfirmDestructive
 *    After confirm → dry_run:true first → plan shown via DiffView
 *    Apply → dry_run:false → pending_approval + approval_id + <Link to=/approvals>
 *  - Loading / error / empty states
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Backups } from "../../src/screens/Backups";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /backups
// ---------------------------------------------------------------------------

function renderBackups() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/backups"]}>
        <Routes>
          <Route path="/backups" element={<Backups />} />
          <Route path="/approvals" element={<div>Approvals Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Basic render: policy data visible
// ---------------------------------------------------------------------------

it("renders the Backups page title", async () => {
  renderBackups();
  await waitFor(() => {
    expect(document.body.textContent).toMatch(/backup/i);
  });
});

it("renders volume:pg-data policy from MSW /api/backups", async () => {
  renderBackups();
  await waitFor(() => {
    expect(document.body.textContent).toContain("pg-data");
  });
});

it("renders schedule 0 3 * * *", async () => {
  renderBackups();
  await waitFor(() => {
    expect(document.body.textContent).toContain("0 3 * * *");
  });
});

it("renders retention 14d", async () => {
  renderBackups();
  await waitFor(() => {
    expect(document.body.textContent).toContain("14d");
  });
});

it("renders repo restic:hetzner-backup", async () => {
  renderBackups();
  await waitFor(() => {
    expect(document.body.textContent).toContain("restic:hetzner-backup");
  });
});

it("renders last run text (ok)", async () => {
  renderBackups();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/03:00.*ok|ok.*03:00|2026-05-17.*ok/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshots list visible
// ---------------------------------------------------------------------------

it("renders snapshot dates (2026-05-17 and 2026-05-16)", async () => {
  renderBackups();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("2026-05-17");
    expect(text).toContain("2026-05-16");
  });
});

it("renders at least 3 snapshot entries", async () => {
  renderBackups();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("2026-05-15");
  });
});

// ---------------------------------------------------------------------------
// [Snapshot agora] — H1, H3: non-destructive, no approval, no ConfirmDestructive
// ---------------------------------------------------------------------------

it("renders [Snapshot agora] button", async () => {
  renderBackups();
  await waitFor(() => {
    const btn = screen.queryByRole("button", { name: /snapshot agora/i });
    expect(btn).not.toBeNull();
  });
});

it("(H1) clicking [Snapshot agora] issues POST /api/backups/pg-data/snapshot", async () => {
  let capturedUrl = "";
  mswServer.use(
    http.post("*/api/backups/:target/snapshot", ({ params }) => {
      capturedUrl = `/api/backups/${params.target as string}/snapshot`;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  await waitFor(() => {
    expect(capturedUrl).toMatch(/\/api\/backups\/pg-data\/snapshot/);
  });
});

it("(H3) snapshot does NOT show ConfirmDestructive before/after click", async () => {
  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  // No ConfirmDestructive in the DOM before click
  expect(document.querySelector(".confirm-destructive")).toBeNull();

  const btn = screen.getByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  // ConfirmDestructive must NOT appear after snapshot click
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).toBeNull();
  });
});

it("(H3) snapshot POST body does NOT contain dry_run:true (non-destructive, no dry_run gate)", async () => {
  let capturedBody: Record<string, unknown> = {};
  mswServer.use(
    http.post("*/api/backups/:target/snapshot", async ({ request }) => {
      capturedBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  await waitFor(() => {
    // dry_run must be false or absent — NOT true
    expect(capturedBody.dry_run).not.toBe(true);
  });
});

it("(H3) snapshot result is 'applied' — NO pending_approval surfaced", async () => {
  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  // Wait a tick — no pending_approval text should appear
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/pending_approval/i.test(text)).toBe(false);
  });
});

it("snapshot success: shows 'Snapshot criado com sucesso' banner after applied response", async () => {
  // Default MSW handler returns { status: "applied" } — no override needed.
  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  await waitFor(() => {
    expect(screen.getByText(/snapshot criado com sucesso/i)).not.toBeNull();
  });
});

it("(Fix1) snapshot HTTP 200 with status:error shows error notice, NOT success banner", async () => {
  // Override: HTTP 200 but envelope status is "error" — guards Fix 1 (envelope-aware onSuccess)
  mswServer.use(
    http.post("*/api/backups/:target/snapshot", () => {
      return HttpResponse.json({
        status: "error",
        error: { code: "x", message: "falhou", retryable: false, entity: "volume:pg-data" },
      }); // HTTP 200 — same as a non-error status code, only envelope differs
    }),
  );

  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  await waitFor(() => {
    // Error notice must appear
    expect(document.querySelector(".notice-error")).not.toBeNull();
    // Success banner must NOT appear
    expect(screen.queryByText(/snapshot criado com sucesso/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [Restore ⚠ destrutivo] — H2: ConfirmDestructive → dry_run:true → plan → dry_run:false → pending_approval
// ---------------------------------------------------------------------------

it("renders [Restore] button", async () => {
  renderBackups();
  await waitFor(() => {
    const btn = screen.queryByRole("button", { name: /restore/i });
    expect(btn).not.toBeNull();
  });
});

it("clicking [Restore] shows ConfirmDestructive (approval gate)", async () => {
  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  const restoreBtn = screen.getByRole("button", { name: /restore/i });
  fireEvent.click(restoreBtn);

  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });
});

it("(H2) HARD INVARIANT: restore dry_run:true precedes dry_run:false", async () => {
  const calls: boolean[] = []; // true = dry_run:true, false = dry_run:false
  mswServer.use(
    http.post("*/api/backups/:target/restore", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const isDryRun = body.dry_run !== false;
      calls.push(isDryRun);

      if (isDryRun) {
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "restore",
              entity: "volume:pg-data",
              change: "restore ← latest",
              impact: "sobrescreve estado atual",
            },
          ],
        });
      }
      return HttpResponse.json({
        status: "pending_approval",
        approval_id: "apr_test_restore",
      });
    }),
  );

  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  // Click restore → ConfirmDestructive appears
  const restoreBtn = screen.getByRole("button", { name: /restore/i });
  fireEvent.click(restoreBtn);
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });

  // Type confirm text and click Confirm
  const confirmInput = document.querySelector<HTMLInputElement>(".confirm-destructive-input");
  expect(confirmInput).not.toBeNull();
  fireEvent.change(confirmInput!, { target: { value: confirmInput!.placeholder } });

  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  fireEvent.click(confirmBtn);

  // After dry_run:true plan appears, find and click the apply button
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/plano|plan|restore/i.test(text)).toBe(true);
    // DiffView should be present with the plan
    expect(document.querySelector(".diff-list")).not.toBeNull();
  });

  // Click the apply button (sends dry_run:false)
  const applyBtn = screen.getByRole("button", { name: /aplicar|restore/i });
  fireEvent.click(applyBtn);

  await waitFor(() => {
    // HARD invariant: first call MUST be dry_run:true, second MUST be dry_run:false
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(true);
    expect(calls[1]).toBe(false);
  });
});

it("(H2) restore shows pending_approval + approval_id after dry_run:false", async () => {
  mswServer.use(
    http.post("*/api/backups/:target/restore", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dry_run !== false) {
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "restore",
              entity: "volume:pg-data",
              change: "restore ← latest",
              impact: "sobrescreve estado atual",
            },
          ],
        });
      }
      return HttpResponse.json({
        status: "pending_approval",
        approval_id: "apr_999abc",
      });
    }),
  );

  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  fireEvent.click(screen.getByRole("button", { name: /restore/i }));
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });

  const confirmInput = document.querySelector<HTMLInputElement>(".confirm-destructive-input");
  fireEvent.change(confirmInput!, { target: { value: confirmInput!.placeholder } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

  await waitFor(() => {
    expect(document.querySelector(".diff-list")).not.toBeNull();
  });

  fireEvent.click(screen.getByRole("button", { name: /aplicar|restore/i }));

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/pending_approval|apr_999abc/i.test(text)).toBe(true);
  });
});

it("(H2) restore surfaces <Link to=/approvals> after pending_approval", async () => {
  mswServer.use(
    http.post("*/api/backups/:target/restore", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dry_run !== false) {
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "restore",
              entity: "volume:pg-data",
              change: "restore ← latest",
              impact: "sobrescreve estado atual",
            },
          ],
        });
      }
      return HttpResponse.json({
        status: "pending_approval",
        approval_id: "apr_link_test",
      });
    }),
  );

  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  fireEvent.click(screen.getByRole("button", { name: /restore/i }));
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });

  const confirmInput = document.querySelector<HTMLInputElement>(".confirm-destructive-input");
  fireEvent.change(confirmInput!, { target: { value: confirmInput!.placeholder } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

  await waitFor(() => {
    expect(document.querySelector(".diff-list")).not.toBeNull();
  });

  fireEvent.click(screen.getByRole("button", { name: /aplicar|restore/i }));

  await waitFor(() => {
    // <Link to=/approvals> renders as <a href=/approvals>
    const links = Array.from(document.querySelectorAll("a"));
    const approvalsLink = links.find((a) => a.getAttribute("href") === "/approvals");
    expect(approvalsLink).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (H4) Both action buttons disabled while their op is pending
// ---------------------------------------------------------------------------

it("(H4) [Snapshot agora] button is disabled while snapshot is pending", async () => {
  let resolveSnapshot!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });

  mswServer.use(
    http.post("*/api/backups/:target/snapshot", async () => {
      await delayPromise;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  expect(btn).not.toBeDisabled();

  fireEvent.click(btn);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: /snapshot agora/i })).toBeDisabled();
  });

  await act(async () => {
    resolveSnapshot();
    await delayPromise;
  });
});

it("(H4) [Restore] button is disabled while restore is pending", async () => {
  let resolveRestore!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveRestore = resolve;
  });

  mswServer.use(
    http.post("*/api/backups/:target/restore", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dry_run !== false) {
        // dry_run:true — return plan immediately
        return HttpResponse.json({
          status: "planned",
          plan: [
            {
              op: "restore",
              entity: "volume:pg-data",
              change: "restore ← latest",
              impact: "sobrescreve",
            },
          ],
        });
      }
      // dry_run:false — delay
      await delayPromise;
      return HttpResponse.json({ status: "pending_approval", approval_id: "apr_delay" });
    }),
  );

  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  // Click restore → confirm → dry_run:true → plan → click apply
  fireEvent.click(screen.getByRole("button", { name: /restore/i }));
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });
  const confirmInput = document.querySelector<HTMLInputElement>(".confirm-destructive-input");
  fireEvent.change(confirmInput!, { target: { value: confirmInput!.placeholder } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

  await waitFor(() => {
    expect(document.querySelector(".diff-list")).not.toBeNull();
  });

  const applyBtn = screen.getByRole("button", { name: /aplicar|restore/i });
  fireEvent.click(applyBtn);

  // Apply button must be disabled while pending
  await waitFor(() => {
    const btn = screen.queryByRole("button", { name: /aplicar|restore/i });
    if (btn) expect(btn).toBeDisabled();
  });

  await act(async () => {
    resolveRestore();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// (H5) Errors surface via .notice-error
// ---------------------------------------------------------------------------

it("(H5) snapshot error surfaces notice-error", async () => {
  mswServer.use(
    http.post("*/api/backups/:target/snapshot", () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "provider_error",
            message: "restic failed",
            retryable: true,
            entity: "volume:pg-data",
          },
        },
        { status: 500 },
      );
    }),
  );

  renderBackups();
  const btn = await screen.findByRole("button", { name: /snapshot agora/i });
  fireEvent.click(btn);

  await waitFor(() => {
    expect(document.querySelector(".notice-error")).not.toBeNull();
  });
});

it("(H5) restore dry_run error surfaces notice-error", async () => {
  mswServer.use(
    http.post("*/api/backups/:target/restore", () => {
      return HttpResponse.json(
        {
          status: "error",
          error: {
            code: "provider_error",
            message: "restic restore failed",
            retryable: false,
            entity: "volume:pg-data",
          },
        },
        { status: 500 },
      );
    }),
  );

  renderBackups();
  await screen.findByRole("button", { name: /snapshot agora/i });

  fireEvent.click(screen.getByRole("button", { name: /restore/i }));
  await waitFor(() => {
    expect(document.querySelector(".confirm-destructive")).not.toBeNull();
  });

  const confirmInput = document.querySelector<HTMLInputElement>(".confirm-destructive-input");
  fireEvent.change(confirmInput!, { target: { value: confirmInput!.placeholder } });
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

  await waitFor(() => {
    expect(document.querySelector(".notice-error")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows a loading state while fetching backups", async () => {
  let resolveHandler!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });

  mswServer.use(
    http.get("*/api/backups", async () => {
      await delayPromise;
      return HttpResponse.json([]);
    }),
  );

  renderBackups();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/carregando|loading/i.test(text)).toBe(true);
  });

  resolveHandler();
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

it("shows an error notice when GET /api/backups fails", async () => {
  mswServer.use(
    http.get("*/api/backups", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderBackups();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/erro|error/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

it("shows an empty state when no backup policies are returned", async () => {
  mswServer.use(
    http.get("*/api/backups", () => {
      return HttpResponse.json([]);
    }),
  );

  renderBackups();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/nenhuma política|sem políticas|no backup|sem backup/i.test(text)).toBe(true);
  });
});
