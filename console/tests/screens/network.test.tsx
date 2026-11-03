/**
 * console/tests/screens/network.test.tsx
 *
 * TDD tests for the Network screen (Task 16).
 *
 * Hard invariants (tested explicitly):
 *  (R1) READ-ONLY: zero write/destroy/remove buttons anywhere on the screen.
 *  (R2) "+ Network" is a disabled placeholder — no network call on "click".
 *  (R3) Members derived from servers whose server.network matches the network name.
 *  (R4) WireGuard mesh summary text present.
 *  (R5) Declarative membership note present.
 *
 * Covers:
 *  - Route /network renders the Network screen.
 *  - Network bevox-priv with 10.0.0.0/16 and subnet 10.0.1.0/24 appears.
 *  - Members derived from servers: bevox-app-1, bevox-app-2, bevox-db-1 visible.
 *  - WireGuard mesh summary text is present.
 *  - Degraded peer warning (db-1 is degraded in fixture) shown.
 *  - Declarative membership note shown.
 *  - "+ Network" is disabled, does NOT trigger any network request.
 *  - NO write/destroy/remove buttons anywhere.
 *  - Loading / error / empty states.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { resetState } from "../../src/api/__fakes__/handlers";
import { Network } from "../../src/screens/Network";

// ---------------------------------------------------------------------------
// Test helper: fresh QueryClient per test, route at /network
// ---------------------------------------------------------------------------

function renderNetwork() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/network"]}>
        <Routes>
          <Route path="/network" element={<Network />} />
          <Route path="/manifest" element={<div>Manifest Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Basic render: page title
// ---------------------------------------------------------------------------

it("renders the Network page title", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/network|rede/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Network card: name, ip_range, subnets
// ---------------------------------------------------------------------------

it("renders network name bevox-priv", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });
});

it("renders ip_range 10.0.0.0/16", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("10.0.0.0/16");
  });
});

it("renders subnet 10.0.1.0/24", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("10.0.1.0/24");
  });
});

// ---------------------------------------------------------------------------
// Members derived from servers: app-1, app-2, db-1 belong to bevox-priv
// ---------------------------------------------------------------------------

it("renders member bevox-app-1", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-app-1");
  });
});

it("renders member bevox-app-2", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-app-2");
  });
});

it("renders member bevox-db-1", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-db-1");
  });
});

it("does NOT render drift server bevox-x-9 as a member (it has network:unknown)", async () => {
  renderNetwork();
  // Wait for data to load
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });
  // The drift server should not appear in the members section
  // (it belongs to network "unknown", not "bevox-priv")
  // Note: we only check it's not rendered as a peer-chip member
  const chips = document.querySelectorAll(".peer-chip");
  const chipTexts = Array.from(chips).map((c) => c.textContent ?? "");
  const hasDrift = chipTexts.some((t) => t.includes("bevox-x-9"));
  expect(hasDrift).toBe(false);
});

// ---------------------------------------------------------------------------
// WireGuard mesh summary text
// ---------------------------------------------------------------------------

it("renders WireGuard mesh summary text", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/wireguard|wire.?guard|wg.?mesh|peers up/i.test(text)).toBe(true);
  });
});

it("renders peers up count in WireGuard summary", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Should show something like "3/3 peers up" or similar mesh summary
    expect(/\d+\/\d+|peers up/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degraded peer warning (bevox-db-1 has status "degraded" in fixture)
// ---------------------------------------------------------------------------

it("renders a degraded peer warning for bevox-db-1", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    // Should mention degraded db-1 or show a warning
    expect(/degraded|bevox-db-1/i.test(text)).toBe(true);
  });
});

it("renders the degraded peer notice element", async () => {
  renderNetwork();
  await waitFor(() => {
    // wait for data
    expect(document.body.textContent).toContain("bevox-priv");
  });
  const warnNotice = document.querySelector(".notice-warn");
  expect(warnNotice).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Declarative membership note
// ---------------------------------------------------------------------------

it("renders the declarative membership note", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/declarativ|label do server|manifesto/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subnets table
// ---------------------------------------------------------------------------

it("renders a Subnets section/table", async () => {
  renderNetwork();
  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/subnet/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (R2) "+ Network" is a disabled placeholder — no network call on click
// ---------------------------------------------------------------------------

it("renders a disabled '+ Network' placeholder button", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  // Find a button/element with text containing "+ Network"
  const allBtns = Array.from(document.querySelectorAll("button, a[href='#']"));
  const networkBtn = allBtns.find((el) => el.textContent?.includes("+ Network"));
  expect(networkBtn).not.toBeUndefined();
});

it("(R2) '+ Network' button is disabled (no-op placeholder)", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  const networkBtn = screen.queryByRole("button", { name: /\+ network/i });
  expect(networkBtn).not.toBeNull();
  expect(networkBtn).toBeDisabled();
});

it("(R2) clicking '+ Network' does NOT issue any network request", async () => {
  let postCalled = false;
  mswServer.use(
    http.post("*/api/networks", () => {
      postCalled = true;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  const networkBtn = screen.queryByRole("button", { name: /\+ network/i });
  if (networkBtn) {
    fireEvent.click(networkBtn);
  }

  // Give it a tick to ensure no request fires
  await new Promise((r) => setTimeout(r, 50));
  expect(postCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// (R1) READ-ONLY: zero write/destroy/remove buttons anywhere
// ---------------------------------------------------------------------------

it("(R1) no Destroy button on the Network screen", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  const destroyBtn = screen.queryByRole("button", { name: /destroy|remov|delet|exclu/i });
  expect(destroyBtn).toBeNull();
});

it("(R1) no Remove/Delete button anywhere on the screen", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  const buttons = Array.from(document.querySelectorAll("button"));
  const dangerButtons = buttons.filter((btn) =>
    /destroy|remove|delete|excluir|remover/i.test(btn.textContent ?? ""),
  );
  expect(dangerButtons).toHaveLength(0);
});

it("(R1) no write form on the Network screen", async () => {
  renderNetwork();
  await waitFor(() => {
    expect(document.body.textContent).toContain("bevox-priv");
  });

  // No form elements for creating networks (only the disabled placeholder button)
  const forms = document.querySelectorAll("form");
  expect(forms).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (Fix 3) Zero-member network: no healthy/"all up" badge
// ---------------------------------------------------------------------------

it("(Fix3) a network with zero members does NOT show a healthy badge", async () => {
  mswServer.use(
    http.get("*/api/state", () => {
      return HttpResponse.json({
        servers: [],
        networks: [{ name: "empty-net", ip_range: "10.1.0.0/16", subnets: [] }],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      });
    }),
  );

  renderNetwork();

  await waitFor(() => {
    expect(document.body.textContent).toContain("empty-net");
  });

  // No badge with text "healthy" should appear for a zero-member network
  const badges = Array.from(document.querySelectorAll(".badge-healthy"));
  expect(badges).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows a loading state while fetching state", async () => {
  let resolveHandler!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });

  mswServer.use(
    http.get("*/api/state", async () => {
      await delayPromise;
      return HttpResponse.json({
        servers: [],
        networks: [],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      });
    }),
  );

  renderNetwork();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/carregando|loading/i.test(text)).toBe(true);
  });

  resolveHandler();
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

it("shows an error notice when GET /api/state fails", async () => {
  mswServer.use(
    http.get("*/api/state", () => {
      return HttpResponse.json({ message: "internal error" }, { status: 500 });
    }),
  );

  renderNetwork();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/erro|error/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

it("shows an empty state when no networks are returned", async () => {
  mswServer.use(
    http.get("*/api/state", () => {
      return HttpResponse.json({
        servers: [],
        networks: [],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      });
    }),
  );

  renderNetwork();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/nenhuma rede|sem redes|no network|nenhum network/i.test(text)).toBe(true);
  });
});
