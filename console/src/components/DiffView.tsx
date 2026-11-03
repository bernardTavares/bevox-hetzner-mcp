/**
 * console/src/components/DiffView.tsx
 *
 * Renders a list of PlanItems (op/entity/change/impact) in the prototype diff style.
 *
 * Hard spec invariant — fail-safe:
 *   A drift item (op === "drift") is rendered as a read-only violet warning
 *   with NO remove/destroy control.
 *   This is enforced here and asserted by tests.
 */

import type { PlanItem, PlanOp } from "../api/contract.js";

interface DiffViewProps {
  items: PlanItem[];
}

function isDriftItem(item: PlanItem): boolean {
  return item.op === "drift";
}

function opSymbol(op: PlanOp): { symbol: string; className: string } {
  switch (op) {
    case "create":
    case "add":
      return { symbol: "+", className: "diff-op add" };
    case "drift":
      return { symbol: "~", className: "diff-op warn" };
    case "update":
    case "scale":
    case "upsert":
      return { symbol: "~", className: "diff-op change" };
    case "remove":
    case "destroy":
      return { symbol: "-", className: "diff-op remove" };
    case "snapshot":
    case "restore":
      return { symbol: "~", className: "diff-op change" };
    case "noop":
      return { symbol: " ", className: "diff-op noop" };
    default: {
      // exhaustiveness check — TypeScript will error here if PlanOpEnum grows
      const _exhaustive: never = op;
      void _exhaustive;
      return { symbol: "~", className: "diff-op change" };
    }
  }
}

export function DiffView({ items }: DiffViewProps) {
  return (
    <div className="table-wrap">
      <ul className="diff-list">
        {items.map((item, idx) => {
          const drift = isDriftItem(item);
          const { symbol, className } = opSymbol(item.op);

          return (
            <li
              key={`${item.op}:${item.entity}:${idx}`}
              className={drift ? "drift-row" : undefined}
            >
              <span className={className} aria-label={`op: ${item.op}`}>
                {symbol}
              </span>
              <div className="diff-detail">
                <div className="diff-entity">{item.entity}</div>
                <div className="diff-desc">
                  {item.change}
                  {item.impact && item.impact !== "none" && (
                    <span style={{ marginLeft: 8, color: "var(--muted)" }}>
                      impact: {item.impact}
                    </span>
                  )}
                </div>
                {drift && (
                  <span className="diff-readonly-warn" style={{ marginTop: 4 }}>
                    não destruído (fail-safe)
                  </span>
                )}
              </div>
              {/* No remove/destroy control for any item — especially drift */}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
