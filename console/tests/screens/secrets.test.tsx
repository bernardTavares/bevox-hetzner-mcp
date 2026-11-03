/**
 * console/tests/screens/secrets.test.tsx
 *
 * TDD tests for the Secrets screen (Task 14).
 *
 * HARD INVARIANT: Secret values must NEVER appear in the DOM, fixtures, or
 * contract types. This file explicitly asserts that invariant.
 *
 * Covers:
 *  - Route /secrets renders the screen
 *  - Secret list from MSW fixture appears (bevox-harness 5 chaves, bevox-backend 8 chaves)
 *  - Store note (age/sops) rendered
 *  - "Valores nunca exibidos" warning rendered
 *  - Footer safety notice rendered
 *  - CRITICAL: No secret values in DOM — the Secret contract type/fixture has NO value field
 *  - "+ Novo secret" button is a non-functional placeholder (disabled AND no POST issued)
 *  - "Rotacionar = recriar service" buttons are non-functional placeholders (disabled AND no POST)
 *  - Loading state
 *  - Error state
 *  - Empty state
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server as mswServer } from "../../src/api/__fakes__/server";
import { secrets as fixtureSecrets } from "../../src/api/__fakes__/fixtures";
import { Secrets } from "../../src/screens/Secrets";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function renderSecrets() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/secrets"]}>
        <Routes>
          <Route path="/secrets" element={<Secrets />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// CRITICAL: Contract/fixture integrity — Secret type has NO value field
// ---------------------------------------------------------------------------

it("fixture objects only have name, keys, used_by keys — NO value field", () => {
  for (const secret of fixtureSecrets) {
    // Only allowed keys
    const keys = Object.keys(secret);
    expect(keys).toContain("name");
    expect(keys).toContain("keys");
    expect(keys).toContain("used_by");
    // Value field must be absent
    expect(keys).not.toContain("value");
    expect(keys).not.toContain("values");
    expect(keys).not.toContain("data");
    expect(keys).not.toContain("secret_value");
    expect(keys).not.toContain("raw");
  }
});

it("fixture data matches prototype: bevox-harness has 5 keys used by 1 service", () => {
  const harness = fixtureSecrets.find((s) => s.name === "bevox-harness");
  expect(harness).toBeDefined();
  expect(harness?.keys).toBe(5);
  expect(harness?.used_by).toHaveLength(1);
});

it("fixture data matches prototype: bevox-backend has 8 keys used by 1 service", () => {
  const backend = fixtureSecrets.find((s) => s.name === "bevox-backend");
  expect(backend).toBeDefined();
  expect(backend?.keys).toBe(8);
  expect(backend?.used_by).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Screen renders secret list
// ---------------------------------------------------------------------------

it("renders the Secrets page title", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/secrets/i.test(text)).toBe(true);
  });
});

it("renders secret:bevox-harness reference name", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    expect(container.textContent).toContain("bevox-harness");
  });
});

it("renders bevox-harness with 5 chaves", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/5.*(chave|key)/i.test(text)).toBe(true);
  });
});

it("renders bevox-harness used by 1 service", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(text).toMatch(/bevox-harness/);
    // used by info shown
    expect(/1.*service|service.*1|\(1\)/i.test(text)).toBe(true);
  });
});

it("renders secret:bevox-backend reference name", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    expect(container.textContent).toContain("bevox-backend");
  });
});

it("renders bevox-backend with 8 chaves", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/8.*(chave|key)/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Store note and warnings
// ---------------------------------------------------------------------------

it("renders the store note mentioning age/sops", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/age\/sops|age.sops/i.test(text)).toBe(true);
  });
});

it("renders the 'Valores nunca exibidos' warning", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/valores.*nunca.*exibidos|nunca.*exibidos/i.test(text)).toBe(true);
  });
});

it("renders the footer safety notice about valores nunca exibidos", async () => {
  const { container } = renderSecrets();
  await waitFor(() => {
    const text = container.textContent ?? "";
    // Footer note: "⚠ valores nunca exibidos · resolvidos no apply (reconciler)"
    expect(/resolvidos.*apply|apply.*reconciler|valores.*nunca/i.test(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL INVARIANT (C1): No secret value anywhere in the rendered component
// Two-part assertion: (a) strict negative set + (b) whitelist positive check
// ---------------------------------------------------------------------------

it("CRITICAL (C1): rendered component contains no secret value — strict negative + whitelist check", async () => {
  const { container } = renderSecrets();

  // Wait for data to load — scoped to the component container, not document.body
  await waitFor(() => {
    expect(container.textContent).toContain("bevox-harness");
  });

  const text = container.textContent ?? "";

  // --- Part (a): Strict negative set ---
  // Assert NONE of these credential-shaped patterns appear in the rendered text.

  // Long tokens including -, _, base64 variants (20+ chars)
  const longTokenPattern = /[A-Za-z0-9_\-+/]{20,}={0,2}/g;
  const longTokenMatches = text.match(longTokenPattern) ?? [];
  expect(longTokenMatches).toHaveLength(0);

  // Hex strings (16+ hex chars)
  const hexPattern = /\b[a-f0-9]{16,}\b/g;
  const hexMatches = text.match(hexPattern) ?? [];
  expect(hexMatches).toHaveLength(0);

  // Bearer tokens
  const bearerPattern = /Bearer\s+\S+/g;
  const bearerMatches = text.match(bearerPattern) ?? [];
  expect(bearerMatches).toHaveLength(0);

  // API key patterns
  const skPattern = /sk_[a-z]+_[A-Za-z0-9]/g;
  const skMatches = text.match(skPattern) ?? [];
  expect(skMatches).toHaveLength(0);

  // PEM blocks
  const pemPattern = /-----BEGIN [A-Z ]+-----/g;
  const pemMatches = text.match(pemPattern) ?? [];
  expect(pemMatches).toHaveLength(0);

  // Literal scan: no value-like field names rendered as data values
  // These labels must not appear as data content (case-insensitive)
  const forbiddenDataLabels = ["secret_value", "raw"];
  for (const label of forbiddenDataLabels) {
    expect(text.toLowerCase()).not.toContain(label);
  }
  // "valor" as a standalone data label (not part of "valores nunca exibidos" notice)
  // The notice text IS expected; a raw "valor:" pattern is not
  expect(/\bvalor\s*:/i.test(text)).toBe(false);
  // "data:" as a data prefix (e.g. "data: abc123") is not expected
  expect(/\bdata\s*:\s*[A-Za-z0-9]{10}/i.test(text)).toBe(false);

  // --- Part (b): Whitelist positive check ---
  // The ONLY data tokens we expect from fixtures are the enumerable set below.
  // Collect data cells from the rendered table rows.
  const dataCells = Array.from(container.querySelectorAll("td"));
  const renderedDataTokens = dataCells.map((td) => td.textContent?.trim() ?? "");

  // Expected whitelist: reference names, key counts, used_by strings, action button label
  const expectedDataTokenSet = new Set([
    // Reference column (rendered as "secret:<name>")
    "secret:bevox-harness",
    "secret:bevox-backend",
    // Keys column
    "5 chaves",
    "8 chaves",
    // Used by column — each used_by entry + count annotation
    "service:bevox-harness(1 service)",
    "service:bevox-backend(1 service)",
    // Ações column — disabled Rotacionar button text
    "[Rotacionar = recriar service]",
  ]);

  for (const cellText of renderedDataTokens) {
    // Normalize whitespace for comparison
    const normalized = cellText.replace(/\s+/g, " ").trim();
    if (normalized === "") continue;
    expect(expectedDataTokenSet.has(normalized)).toBe(true);
  }

  // Positive assertions: expected data is present
  expect(text).toContain("bevox-harness");
  expect(text).toContain("bevox-backend");
  expect(text).toContain("5 chaves");
  expect(text).toContain("8 chaves");
  expect(text).toContain("service:bevox-harness");
  expect(text).toContain("service:bevox-backend");
});

// ---------------------------------------------------------------------------
// Placeholder buttons — HARD assertions (m2)
// ---------------------------------------------------------------------------

it("'+ Novo secret' button exists, is disabled, and fires no POST (m2 hard assertion)", async () => {
  renderSecrets();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/novo.*secret|new.*secret/i.test(text)).toBe(true);
  });

  // Track any POST calls to /api/secrets
  let postCalled = false;
  mswServer.use(
    http.post("*/api/secrets", () => {
      postCalled = true;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  // HARD assertion: button MUST exist
  const novoBtn = screen.queryAllByRole("button").find((btn) =>
    /novo.*secret|new.*secret/i.test(btn.textContent ?? ""),
  );
  expect(novoBtn).toBeDefined();

  // HARD assertion: button MUST be disabled
  expect(novoBtn).toBeDisabled();

  // Even if we force-click the disabled button, no POST must be issued
  fireEvent.click(novoBtn!);
  await waitFor(() => {
    expect(postCalled).toBe(false);
  });
});

it("'Rotacionar' buttons exist, are all disabled, and fire no POST (m2 hard assertion)", async () => {
  renderSecrets();

  await waitFor(() => {
    const text = document.body.textContent ?? "";
    expect(/rotacionar/i.test(text)).toBe(true);
  });

  // Track any network call that could mean rotation
  let postCalled = false;
  mswServer.use(
    http.post("*/api/secrets/*", () => {
      postCalled = true;
      return HttpResponse.json({ status: "applied" });
    }),
  );

  // HARD assertion: at least one Rotacionar button must exist
  const rotButtons = screen.queryAllByRole("button").filter((btn) =>
    /rotacionar/i.test(btn.textContent ?? ""),
  );
  expect(rotButtons.length).toBeGreaterThan(0);

  // HARD assertion: ALL Rotacionar buttons must be disabled
  for (const btn of rotButtons) {
    expect(btn).toBeDisabled();
  }

  // Even force-clicking disabled buttons, no POST issued
  for (const btn of rotButtons) {
    fireEvent.click(btn);
  }
  await waitFor(() => {
    expect(postCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

it("shows a loading state while fetching", async () => {
  let resolveHandler!: () => void;
  const delayPromise = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });

  mswServer.use(
    http.get("*/api/secrets", async () => {
      await delayPromise;
      return HttpResponse.json([]);
    }),
  );

  const { container } = renderSecrets();

  // Loading indicator must appear before data resolves
  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/carregando|loading/i.test(text)).toBe(true);
  });

  resolveHandler();
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

it("shows an error notice when GET /api/secrets fails", async () => {
  mswServer.use(
    http.get("*/api/secrets", () => {
      return HttpResponse.json({ error: "server error" }, { status: 500 });
    }),
  );

  const { container } = renderSecrets();

  await waitFor(() => {
    const errorNotice = container.querySelector(".notice-error");
    if (!errorNotice) {
      const text = container.textContent ?? "";
      expect(/erro|error/i.test(text)).toBe(true);
    } else {
      expect(errorNotice).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

it("shows an empty state when no secrets are returned", async () => {
  mswServer.use(
    http.get("*/api/secrets", () => {
      return HttpResponse.json([]);
    }),
  );

  const { container } = renderSecrets();

  await waitFor(() => {
    const text = container.textContent ?? "";
    expect(/nenhum secret|sem secrets|no secrets|empty/i.test(text)).toBe(true);
  });
});
