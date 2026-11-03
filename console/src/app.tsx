/**
 * console/src/app.tsx
 *
 * App shell: QueryClientProvider (TanStack Query) + React Router.
 *
 * Router pattern for later tasks
 * ─────────────────────────────
 * All screen routes are children of the Layout route so the topbar/navbar
 * renders on every screen. To add a new screen:
 *   1. Import the screen component.
 *   2. Add a { path: "<route>", element: <ScreenComponent /> } entry to
 *      SCREEN_ROUTES below.
 * That's it — Layout's <Outlet /> renders it automatically.
 *
 * Implemented routes:
 *   /               → Overview
 *   /e/:kind/:name  → EntityDetail
 *   /apply          → PlanApply
 *   /approvals      → Approvals
 *   /events         → Events
 *   /manifest       → Manifest
 *   /provision      → ProvisionServer
 *   /secrets        → Secrets
 *   /backups        → Backups
 *   /network        → Network
 *   /dns            → Dns
 *   /health         → Health
 */

import { createBrowserRouter, RouterProvider, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { Overview } from "./screens/Overview";
import { EntityDetail } from "./screens/EntityDetail";
import { PlanApply } from "./screens/PlanApply";
import { Approvals } from "./screens/Approvals";
import { Events } from "./screens/Events";
import { Manifest } from "./screens/Manifest";
import { ProvisionServer } from "./screens/ProvisionServer";
import { Secrets } from "./screens/Secrets";
import { Backups } from "./screens/Backups";
import { Network } from "./screens/Network";
import { Dns } from "./screens/Dns";
import { Health } from "./screens/Health";

// ---------------------------------------------------------------------------
// SCREEN_ROUTES — single source of truth for all 12 application routes.
//
// Both createAppRouter() (production) and AppRoutes() (tests) derive from
// this array, so adding/removing/reordering a route only requires editing
// this one place.
// ---------------------------------------------------------------------------

const SCREEN_ROUTES = [
  { path: "/", element: <Overview /> },
  { path: "/e/:kind/:name", element: <EntityDetail /> },
  { path: "/apply", element: <PlanApply /> },
  { path: "/approvals", element: <Approvals /> },
  { path: "/events", element: <Events /> },
  { path: "/manifest", element: <Manifest /> },
  { path: "/provision", element: <ProvisionServer /> },
  { path: "/secrets", element: <Secrets /> },
  { path: "/backups", element: <Backups /> },
  { path: "/network", element: <Network /> },
  { path: "/dns", element: <Dns /> },
  { path: "/health", element: <Health /> },
] as const;

// ---------------------------------------------------------------------------
// AppRoutes — the canonical JSX route tree (all 12 screens under Layout).
//
// Exported so tests can embed it inside a MemoryRouter for E2E-style testing
// with real route navigation. Production App() uses createBrowserRouter with
// the equivalent configuration — production behaviour is unchanged.
// ---------------------------------------------------------------------------

/**
 * The full application route tree rendered as JSX Routes + Route elements.
 *
 * Used by:
 *  - E2E tests via MemoryRouter + <AppRoutes /> (test isolation, no data router)
 *
 * Derives from SCREEN_ROUTES — no duplication.
 */
export function AppRoutes() {
  return (
    <Routes>
      {/*
        Layout is the root parent route — renders topbar + navbar + <Outlet />.
        All screen routes are children so the shell is always visible.
      */}
      <Route element={<Layout />}>
        {SCREEN_ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Route>
    </Routes>
  );
}

// ---------------------------------------------------------------------------
// createAppRouter — minimal factory for the production BrowserRouter.
// Retained for consistency; tests use MemoryRouter + AppRoutes directly.
// ---------------------------------------------------------------------------

/** Creates the production BrowserRouter instance. Derives from SCREEN_ROUTES. */
export function createAppRouter() {
  return createBrowserRouter([
    {
      element: <Layout />,
      children: SCREEN_ROUTES.map((r) => ({ path: r.path, element: r.element })),
    },
  ]);
}

// Single QueryClient instance for the whole app.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const router = createAppRouter();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
