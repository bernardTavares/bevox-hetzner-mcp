/**
 * console/src/components/ConfirmDestructive.tsx
 *
 * Destructive-action confirmation dialog component.
 *
 * Invariants:
 *   - Always shows "→ Approval Gate" warning — visible, prominent.
 *   - Confirm button is disabled until the user types the requireText
 *     (defaults to entity name).
 *   - onConfirm is called only when input matches requireText.
 */

import { useState } from "react";

interface ConfirmDestructiveProps {
  entity: string;
  action: string;
  onConfirm: () => void;
  requireText?: string;
  /** When true, the Confirm button is also disabled (mutation in-flight). */
  pending?: boolean;
}

export function ConfirmDestructive({
  entity,
  action,
  onConfirm,
  requireText,
  pending = false,
}: ConfirmDestructiveProps) {
  const [inputValue, setInputValue] = useState("");
  const confirmText = requireText ?? entity;
  const isConfirmed = inputValue === confirmText;

  function handleConfirm() {
    if (isConfirmed && !pending) {
      onConfirm();
    }
  }

  return (
    <div className="confirm-destructive">
      <div className="confirm-destructive-title">
        {action}: <span style={{ fontFamily: "var(--font-mono)" }}>{entity}</span>
      </div>

      {/* Approval Gate warning — hard invariant, always visible */}
      <div className="approval-hint" style={{ marginBottom: 16 }}>
        → Approval Gate
      </div>

      <label
        htmlFor="confirm-destructive-input"
        style={{ fontSize: 13, color: "var(--text-sec)", marginBottom: 12, display: "block" }}
      >
        To confirm, type <strong style={{ fontFamily: "var(--font-mono)" }}>{confirmText}</strong> below:
      </label>

      <input
        id="confirm-destructive-input"
        type="text"
        className="confirm-destructive-input"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        aria-label={`Type ${confirmText} to confirm`}
        placeholder={confirmText}
      />

      <div className="btn-group">
        <button
          className="btn btn-danger"
          onClick={handleConfirm}
          disabled={!isConfirmed || pending}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}
