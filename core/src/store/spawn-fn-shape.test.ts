/**
 * core/src/store/spawn-fn-shape.test.ts
 *
 * Source-level safety net for the three module-internal `SpawnFn` duplicates.
 *
 * Background. The `SpawnFn` type is declared THREE times across the codebase:
 *   - `core/src/store/secrets.ts`              (canonical; module-internal)
 *   - `core/src/entrypoint-wiring.ts`          (boot-validation helper seam)
 *   - `core/test/fakes/sops-cli.ts`            (the fake; aliased as
 *                                               `SpawnFnShape` to emphasise
 *                                               the duplicate)
 *
 * Each block carries a JSDoc note saying "MUST be kept in sync" — but
 * nothing enforces it mechanically. The canonical type cannot be exported
 * (per the secret-resolver-real-v1 spec's "module-internal" decision), so
 * the conventional `Equals<A, B>` compile-time trick is unavailable.
 *
 * Instead, this test extracts the source-level declaration of each
 * duplicate via regex, normalises whitespace + the `SpawnFnShape` alias,
 * and asserts the three strings are identical. If any duplicate drifts,
 * this test fails at the next run.
 *
 * Limits. This is a STRUCTURAL string check, not a type-equality proof.
 * It catches the most common drift (someone edits one copy and forgets
 * the others) but cannot catch e.g. a rename of an imported `NodeJS.Signals`
 * that compiles cleanly in all three files. That class of drift is the
 * compiler's job; this test is for the human-author class.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

describe("SpawnFn shape stays in sync across module-internal duplicates", () => {
  it("source-level identical declaration in 3 files", () => {
    // From core/src/store/, the repo root is three levels up:
    //   core/src/store/ → core/src/ → core/ → <repo root>
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const files = [
      "core/src/store/secrets.ts",
      "core/src/entrypoint-wiring.ts",
      "core/test/fakes/sops-cli.ts",
    ];
    const sigs = files.map((p) =>
      extractSpawnFnSignature(readFileSync(resolve(root, p), "utf8")),
    );
    // All three should produce identical normalised strings.
    expect(new Set(sigs).size).toBe(1);
  });
});

/**
 * Find a block starting with `type SpawnFn` or `type SpawnFnShape` (the
 * fake uses a different name to emphasise the duplicate; secrets.ts and
 * entrypoint-wiring.ts use `SpawnFn`). Normalise by stripping all
 * whitespace and rewriting `SpawnFnShape` → `SpawnFn`, so the alias does
 * not register as drift.
 */
function extractSpawnFnSignature(source: string): string {
  // The type body ends with `};` at the closing of the return-object
  // member of the function type. The lazy `[^]*?\}\s*;` skips over inner
  // `},` (the opts object's closing brace is followed by `,`, not `;`).
  const m = source.match(/type\s+SpawnFn(Shape)?\s*=\s*\([^]*?\}\s*;/);
  if (!m) throw new Error("SpawnFn declaration not found in source");
  return m[0].replace(/\s+/g, "").replace(/SpawnFnShape/g, "SpawnFn");
}
