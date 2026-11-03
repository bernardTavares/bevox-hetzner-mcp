/**
 * console/tests/test-utils.tsx
 *
 * Test-only utilities. Never imported by src/.
 *
 * Exports:
 *  - TestApp: full app tree for E2E-style tests (QueryClientProvider +
 *    MemoryRouter + AppRoutes/Layout + all 12 screens). MemoryRouter is used
 *    instead of createMemoryRouter (data router) to avoid AbortSignal conflicts
 *    with MSW's interceptor when navigate() creates internal fetch requests.
 */

import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "../src/app";

interface TestAppProps {
  initialPath?: string;
  queryClient?: QueryClient;
}

/**
 * Full app tree for E2E-style tests:
 *  - MemoryRouter (no data-router; no AbortSignal conflicts with MSW)
 *  - AppRoutes (real Layout + all 12 screens)
 *  - Caller-supplied QueryClient (fresh per test, retry:false)
 *
 * NavLink clicks via fireEvent.click work correctly with MemoryRouter because
 * React Router's Link/NavLink components attach onClick handlers that call
 * navigate() without creating fetch requests (unlike data router navigation).
 */
export function TestApp({ initialPath = "/", queryClient: qc }: TestAppProps) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
