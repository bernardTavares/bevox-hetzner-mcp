/**
 * console/src/components/Layout.tsx
 *
 * Top-level app shell: sticky topbar + navbar linking all 12 screen routes,
 * plus an Outlet for child screens.
 *
 * Routes wired:
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
 *   /dns            → DNS
 *   /health         → Health
 *
 * Visual: matches prototype topbar + navbar look (see styles.css).
 */

import { NavLink, Outlet, Link } from "react-router-dom";

const NAV_LINKS = [
  { to: "/", label: "Overview", end: true },
  { to: "/apply", label: "Plan/Apply" },
  { to: "/approvals", label: "Approvals" },
  { to: "/events", label: "Events" },
  { to: "/manifest", label: "Manifest" },
  { to: "/provision", label: "Provision" },
  { to: "/secrets", label: "Secrets" },
  { to: "/backups", label: "Backups" },
  { to: "/network", label: "Network" },
  { to: "/dns", label: "DNS" },
  { to: "/health", label: "Health" },
];

interface LayoutProps {
  agentName?: string;
}

export function Layout({ agentName = "bernard" }: LayoutProps) {
  return (
    <>
      {/* ── Topbar ── */}
      <header className="topbar">
        <Link to="/" className="topbar-brand">
          bevox-hetzner-mcp
        </Link>
        <span className="topbar-agent">agent: {agentName}</span>
      </header>

      {/* ── Navbar ── */}
      <nav className="navbar" aria-label="Main navigation">
        {NAV_LINKS.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {/* ── Page content ── */}
      <main>
        <Outlet />
      </main>
    </>
  );
}
