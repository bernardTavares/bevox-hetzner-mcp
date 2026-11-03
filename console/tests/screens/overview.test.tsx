/**
 * console/tests/screens/overview.test.tsx
 *
 * TDD tests for the Overview/Fleet screen.
 *
 * Wraps the screen in minimal providers (QueryClientProvider + MemoryRouter)
 * inline — no shared test-util file (YAGNI; later tasks may extract if needed).
 * MSW fake (started in setup.ts) serves GET /api/state and GET /api/health.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Overview } from "../../src/screens/Overview";

// ---------------------------------------------------------------------------
// Inline test helper: fresh QueryClient per test to avoid cache bleed
// ---------------------------------------------------------------------------

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Servers table
// ---------------------------------------------------------------------------

it("shows a healthy server from fixtures (bevox-app-1)", async () => {
  renderOverview();
  expect(await screen.findByText("bevox-app-1")).toBeInTheDocument();
});

it("shows the drift server bevox-x-9 in the table", async () => {
  renderOverview();
  expect(await screen.findByText("bevox-x-9")).toBeInTheDocument();
});

it("shows a drift status indicator for bevox-x-9", async () => {
  renderOverview();
  // Wait for server data to load
  await screen.findByText("bevox-x-9");
  // StatusBadge renders the status text; drift badge has class badge-drift
  const driftBadges = document.querySelectorAll(".badge-drift");
  expect(driftBadges.length).toBeGreaterThan(0);
});

it("does NOT show a destroy/remove control for the drift server bevox-x-9", async () => {
  renderOverview();
  await screen.findByText("bevox-x-9");
  const destructiveControls = screen
    .queryAllByRole("button")
    .filter((btn) => /destroy|remove|delete/i.test(btn.textContent ?? ""));
  expect(destructiveControls).toHaveLength(0);
  // Also check no link with destroy/remove text
  const destructiveLinks = screen
    .queryAllByRole("link")
    .filter((link) => /destroy|remove|delete/i.test(link.textContent ?? ""));
  expect(destructiveLinks).toHaveLength(0);
});

it("shows read-only indicator for drift server in the network column", async () => {
  renderOverview();
  await screen.findByText("bevox-x-9");
  expect(screen.getByText(/read-only/i)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Services table
// ---------------------------------------------------------------------------

it("shows a service from fixtures (bevox-harness)", async () => {
  renderOverview();
  expect(await screen.findByText("bevox-harness")).toBeInTheDocument();
});

it("shows both services from fixtures", async () => {
  renderOverview();
  expect(await screen.findByText("bevox-harness")).toBeInTheDocument();
  expect(await screen.findByText("bevox-backend")).toBeInTheDocument();
});

it("shows the '+ Deploy service' button", async () => {
  renderOverview();
  // Wait for data to load before checking for the button
  await screen.findByText("bevox-harness");
  expect(screen.getByText(/\+ Deploy service/i)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Summary counters
// ---------------------------------------------------------------------------

it("shows summary counter labels (Servers, Services, Volumes, DNS)", async () => {
  renderOverview();
  await screen.findByText("bevox-app-1"); // wait for data
  // Multiple elements share the same text (counter label + section title + th),
  // so we use getAllByText and assert at least one exists.
  expect(screen.getAllByText(/^Servers$/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/^Services$/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/^Volumes$/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/^DNS$/i).length).toBeGreaterThan(0);
});

it("shows a drift counter warning card", async () => {
  renderOverview();
  await screen.findByText("bevox-app-1");
  expect(screen.getByText(/⚠ Drift/i)).toBeInTheDocument();
});
