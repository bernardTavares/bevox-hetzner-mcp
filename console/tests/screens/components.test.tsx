/**
 * console/tests/screens/components.test.tsx
 *
 * TDD tests for shared components: StatusBadge, EntityTable, DiffView, ConfirmDestructive.
 * Layout is wired with react-router-dom; tests wrap it with MemoryRouter.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StatusBadge } from "../../src/components/StatusBadge";
import { EntityTable } from "../../src/components/EntityTable";
import { DiffView } from "../../src/components/DiffView";
import { ConfirmDestructive } from "../../src/components/ConfirmDestructive";
import { Layout } from "../../src/components/Layout";
import type { Status } from "../../src/api/contract";
import type { PlanItem } from "../../src/api/contract";

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

const ALL_STATUSES: Status[] = [
  "pending",
  "applying",
  "healthy",
  "degraded",
  "drift",
  "error",
];

it("StatusBadge renderiza cada estado do enum da spec", () => {
  render(<StatusBadge status="drift" />);
  expect(screen.getByText(/drift/i)).toBeInTheDocument();
});

it("StatusBadge renders all 6 enum values without crashing", () => {
  for (const status of ALL_STATUSES) {
    const { unmount } = render(<StatusBadge status={status} />);
    expect(screen.getByText(new RegExp(status, "i"))).toBeInTheDocument();
    unmount();
  }
});

it("StatusBadge text is always visible (not hidden, not color-only)", () => {
  render(<StatusBadge status="error" />);
  const el = screen.getByText(/error/i);
  expect(el).toBeVisible();
});

// ---------------------------------------------------------------------------
// EntityTable
// ---------------------------------------------------------------------------

const columns = [
  { key: "name" as const, header: "Name" },
  { key: "status" as const, header: "Status" },
];
const rows = [
  { name: "server-a", status: "healthy" },
  { name: "server-b", status: "degraded" },
];

it("EntityTable renders column headers", () => {
  render(<EntityTable columns={columns} rows={rows} rowKey="name" />);
  expect(screen.getByText("Name")).toBeInTheDocument();
  expect(screen.getByText("Status")).toBeInTheDocument();
});

it("EntityTable renders all rows", () => {
  render(<EntityTable columns={columns} rows={rows} rowKey="name" />);
  expect(screen.getByText("server-a")).toBeInTheDocument();
  expect(screen.getByText("server-b")).toBeInTheDocument();
});

it("EntityTable uses custom render function when provided", () => {
  const customColumns = [
    {
      key: "status" as const,
      header: "Status",
      render: (row: { name: string; status: string }) => (
        <span data-testid="custom-cell">{row.status.toUpperCase()}</span>
      ),
    },
  ];
  render(<EntityTable columns={customColumns} rows={rows} rowKey="name" />);
  const cells = screen.getAllByTestId("custom-cell");
  expect(cells).toHaveLength(2);
  expect(cells[0]).toHaveTextContent("HEALTHY");
});

it("EntityTable supports rowKeyFn for keyless rows", () => {
  // Rows without a natural unique key field — key is computed from index
  const keylessRows = [
    { name: "server-a", status: "healthy" },
    { name: "server-a", status: "degraded" }, // duplicate name — rowKey would collide
  ];
  render(
    <EntityTable
      columns={columns}
      rows={keylessRows}
      rowKeyFn={(_row, i) => `row-${i}`}
    />,
  );
  // Both rows rendered (duplicate name is fine with rowKeyFn)
  const cells = screen.getAllByText("server-a");
  expect(cells).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

const planItems: PlanItem[] = [
  { op: "create", entity: "server/prod-01", change: "Add new server", impact: "low" },
  { op: "update", entity: "service/api", change: "Update image tag", impact: "medium" },
  { op: "drift", entity: "volume/data", change: "DRIFT detected in size", impact: "none" },
];

it("DiffView renders op, entity, change, and impact for each item", () => {
  render(<DiffView items={planItems} />);
  expect(screen.getByText(/server\/prod-01/i)).toBeInTheDocument();
  expect(screen.getByText(/Add new server/i)).toBeInTheDocument();
  expect(screen.getByText(/service\/api/i)).toBeInTheDocument();
  expect(screen.getByText(/Update image tag/i)).toBeInTheDocument();
  expect(screen.getByText(/volume\/data/i)).toBeInTheDocument();
  expect(screen.getByText(/DRIFT detected in size/i)).toBeInTheDocument();
});

it("DiffView drift item shows read-only warning label (fail-safe)", () => {
  render(<DiffView items={planItems} />);
  expect(screen.getByText(/não destruído/i)).toBeInTheDocument();
});

it("DiffView drift item has NO remove/destroy action control", () => {
  render(<DiffView items={planItems} />);
  // Must not render any button/link with destroy/remove semantics for drift rows
  const destroyButtons = screen
    .queryAllByRole("button")
    .filter((btn) => /destroy|remove|delete/i.test(btn.textContent ?? ""));
  expect(destroyButtons).toHaveLength(0);
});

it("DiffView non-drift items do NOT show the drift warning", () => {
  const nonDriftItems: PlanItem[] = [
    { op: "create", entity: "server/x", change: "create server", impact: "low" },
  ];
  render(<DiffView items={nonDriftItems} />);
  expect(screen.queryByText(/não destruído/i)).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// ConfirmDestructive
// ---------------------------------------------------------------------------

it("ConfirmDestructive shows Approval Gate warning", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDestructive
      entity="server-prod"
      action="delete server"
      onConfirm={onConfirm}
    />,
  );
  expect(screen.getByText(/Approval Gate/i)).toBeInTheDocument();
});

it("ConfirmDestructive confirm button is disabled until confirmation text is entered", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDestructive
      entity="server-prod"
      action="delete server"
      onConfirm={onConfirm}
    />,
  );
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  expect(confirmBtn).toBeDisabled();
});

it("ConfirmDestructive confirm button enables after typing entity name", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDestructive
      entity="server-prod"
      action="delete server"
      onConfirm={onConfirm}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "server-prod" } });
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });
  expect(confirmBtn).not.toBeDisabled();
});

it("ConfirmDestructive calls onConfirm only when confirmed", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDestructive
      entity="server-prod"
      action="delete server"
      onConfirm={onConfirm}
    />,
  );
  const input = screen.getByRole("textbox");
  const confirmBtn = screen.getByRole("button", { name: /confirm/i });

  // Should not call before typing
  fireEvent.click(confirmBtn);
  expect(onConfirm).not.toHaveBeenCalled();

  // Should call after typing correct text
  fireEvent.change(input, { target: { value: "server-prod" } });
  fireEvent.click(confirmBtn);
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("ConfirmDestructive uses custom requireText when provided", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDestructive
      entity="server-prod"
      action="delete server"
      onConfirm={onConfirm}
      requireText="delete"
    />,
  );
  const input = screen.getByRole("textbox");
  // Wrong text: button still disabled
  fireEvent.change(input, { target: { value: "server-prod" } });
  expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
  // Correct requireText
  fireEvent.change(input, { target: { value: "delete" } });
  expect(screen.getByRole("button", { name: /confirm/i })).not.toBeDisabled();
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

it("Layout renders nav links for main routes", () => {
  render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  );
  // Check a representative set of nav links
  expect(screen.getByText(/overview/i)).toBeInTheDocument();
  expect(screen.getByText(/approvals/i)).toBeInTheDocument();
  expect(screen.getByText(/events/i)).toBeInTheDocument();
  expect(screen.getByText(/health/i)).toBeInTheDocument();
});

it("Layout shows current agent identifier", () => {
  render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  );
  expect(screen.getByText(/bernard/i)).toBeInTheDocument();
});
