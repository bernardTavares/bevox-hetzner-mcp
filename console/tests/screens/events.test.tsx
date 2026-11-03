/**
 * console/tests/screens/events.test.tsx
 *
 * TDD tests for the Events screen (Task 11).
 *
 * Covers:
 *  - All fixture events appear from MSW /api/events (actor vox + entity service:bevox-harness;
 *    actor system + entity server:bevox-x-9 + result reported)
 *  - Filter controls present: actor, entity, result inputs
 *  - Applying actor filter re-queries and narrows the list (non-matching event disappears)
 *  - Applying entity filter re-queries and narrows the list
 *  - Applying result filter re-queries and narrows the list
 *  - No write/destroy/remove controls anywhere (read-only screen)
 *  - Loading state while data is in-flight
 *  - Error state when GET /api/events fails
 *  - Empty state when no events returned
 *  - Columns: Hora, Ator, Ação, Entidade, Detalhe, Result
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Events } from "../../src/screens/Events";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /events
// ---------------------------------------------------------------------------

function renderEvents() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/events"]}>
        <Routes>
          <Route path="/events" element={<Events />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Events appear from MSW
// ---------------------------------------------------------------------------

it("shows the vox/service:bevox-harness update event from MSW", async () => {
  renderEvents();
  expect(await screen.findByText("vox")).toBeInTheDocument();
  expect(await screen.findByText("service:bevox-harness")).toBeInTheDocument();
});

it("shows the system drift event (server:bevox-x-9 / reported)", async () => {
  renderEvents();
  expect(await screen.findByText("system")).toBeInTheDocument();
  expect(await screen.findByText("server:bevox-x-9")).toBeInTheDocument();
});

it("shows the runner-3 deploy event (service:bevox-backend)", async () => {
  renderEvents();
  expect(await screen.findByText("runner-3")).toBeInTheDocument();
  expect(await screen.findByText("service:bevox-backend")).toBeInTheDocument();
});

it("shows the bernard approve event (server:bevox-db-old)", async () => {
  renderEvents();
  expect(await screen.findByText("bernard")).toBeInTheDocument();
  expect(await screen.findByText("server:bevox-db-old")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Columns faithful to prototype
// ---------------------------------------------------------------------------

it("renders column headers: Hora, Ator, Ação, Entidade, Detalhe, Result", async () => {
  renderEvents();
  await screen.findByText("vox");
  expect(screen.getByText("Hora")).toBeInTheDocument();
  expect(screen.getByText("Ator")).toBeInTheDocument();
  expect(screen.getByText("Ação")).toBeInTheDocument();
  expect(screen.getByText("Entidade")).toBeInTheDocument();
  expect(screen.getByText("Detalhe")).toBeInTheDocument();
  expect(screen.getByText("Result")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Filter controls present (using aria-label)
// ---------------------------------------------------------------------------

it("has a filter input for actor with aria-label 'ator'", async () => {
  renderEvents();
  await screen.findByText("vox");
  const actorInput = screen.getByLabelText(/ator/i);
  expect(actorInput).toBeInTheDocument();
});

it("has a filter input for entity with aria-label 'entidade'", async () => {
  renderEvents();
  await screen.findByText("vox");
  const entityInput = screen.getByLabelText(/entidade/i);
  expect(entityInput).toBeInTheDocument();
});

it("has a filter input for result with aria-label 'result'", async () => {
  renderEvents();
  await screen.findByText("vox");
  const resultInput = screen.getByLabelText(/result/i);
  expect(resultInput).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Actor filter narrows the list
// ---------------------------------------------------------------------------

it("filtering by actor=vox shows only vox events and hides system events", async () => {
  renderEvents();
  // All events appear initially
  await screen.findByText("vox");
  await screen.findByText("system");

  // Apply actor filter
  const actorInput = screen.getByLabelText(/ator/i) as HTMLInputElement;
  fireEvent.change(actorInput, { target: { value: "vox" } });

  // MSW handler filters by actor=vox → system event disappears; wait for new data
  await waitFor(() => {
    expect(screen.queryByText("system")).toBeNull();
    expect(screen.queryByText("Carregando")).toBeNull();
  });
  // vox event still present
  expect(await screen.findByText("vox")).toBeInTheDocument();
});

it("filtering by actor=system shows system events and hides runner-3 events", async () => {
  renderEvents();
  await screen.findByText("vox");
  await screen.findByText("runner-3");

  const actorInput = screen.getByLabelText(/ator/i) as HTMLInputElement;
  fireEvent.change(actorInput, { target: { value: "system" } });

  await waitFor(() => {
    expect(screen.queryByText("runner-3")).toBeNull();
    expect(screen.queryByText("Carregando")).toBeNull();
  });
  expect(await screen.findByText("system")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Entity filter narrows the list
// ---------------------------------------------------------------------------

it("filtering by entity=service:bevox-harness hides server:bevox-x-9 event", async () => {
  renderEvents();
  await screen.findByText("server:bevox-x-9");

  const entityInput = screen.getByLabelText(/entidade/i) as HTMLInputElement;
  fireEvent.change(entityInput, { target: { value: "service:bevox-harness" } });

  await waitFor(() => {
    expect(screen.queryByText("server:bevox-x-9")).toBeNull();
    expect(screen.queryByText("Carregando")).toBeNull();
  });
  expect(await screen.findByText("service:bevox-harness")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Result filter narrows the list
// ---------------------------------------------------------------------------

it("filtering by result=reported shows only reported events and hides runner-3", async () => {
  renderEvents();
  await screen.findByText("vox");
  await screen.findByText("runner-3");

  const resultInput = screen.getByLabelText(/result/i) as HTMLInputElement;
  fireEvent.change(resultInput, { target: { value: "reported" } });

  await waitFor(() => {
    expect(screen.queryByText("runner-3")).toBeNull();
    expect(screen.queryByText("Carregando")).toBeNull();
  });
  // system/reported event still present
  expect(await screen.findByText("system")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// READ-ONLY: no write/destroy/remove controls
// ---------------------------------------------------------------------------

it("has no buttons with destructive labels (destroy, remove, delete, rejeitar, aprovar)", async () => {
  renderEvents();
  await screen.findByText("vox");

  const destructiveBtn = screen.queryByRole("button", { name: /destroy|remove|delete|rejeitar|aprovar/i });
  expect(destructiveBtn).toBeNull();
});

it("has no submit/apply/save buttons (read-only screen)", async () => {
  renderEvents();
  await screen.findByText("vox");

  const submitButtons = screen.queryAllByRole("button", { name: /submit|apply|enviar|salvar/i });
  expect(submitButtons).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows a loading indicator while /api/events is in-flight", async () => {
  let resolveEvents!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveEvents = resolve;
  });

  mswServer.use(
    http.get("*/api/events", async () => {
      await delayPromise;
      return HttpResponse.json([]);
    }),
  );

  renderEvents();

  const loadingEl = screen.queryByText(/carregando|loading/i);
  expect(loadingEl).not.toBeNull();

  await act(async () => {
    resolveEvents();
    await delayPromise;
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

it("shows an error notice when GET /api/events fails", async () => {
  mswServer.use(
    http.get("*/api/events", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderEvents();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/erro|error/i.test(bodyText)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

it("shows an empty state message when no events are returned", async () => {
  mswServer.use(
    http.get("*/api/events", () => {
      return HttpResponse.json([]);
    }),
  );

  renderEvents();

  await waitFor(() => {
    const bodyText = document.body.textContent ?? "";
    expect(/sem eventos|nenhum|no events/i.test(bodyText)).toBe(true);
  });
});
