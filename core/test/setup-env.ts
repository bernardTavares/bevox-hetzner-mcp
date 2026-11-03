/**
 * core/test/setup-env.ts
 *
 * Vitest setup file: loads core/.env into process.env before tests run.
 * Hand-rolled parser — no dotenv dependency (YAGNI).
 * - Reads the file if it exists; strips a leading UTF-8 BOM if present.
 * - Skips comments (#) and blank lines.
 * - Splits each line on the FIRST `=` only.
 * - Strips a matching pair of surrounding single/double quotes from values.
 * - Does NOT overwrite already-set process.env keys (allows CI to override).
 * NOTE: Do not quote values in core/.env (quotes are stripped but unquoted is cleaner).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// core/.env is one directory up from core/test/
const envPath = join(__dirname, "..", ".env");

let raw: string;
try {
  raw = readFileSync(envPath, "utf8");
} catch {
  // .env absent — nothing to load (CI sets vars directly)
  raw = "";
}

// Strip leading UTF-8 BOM (U+FEFF) if present (some editors/tools emit it).
raw = raw.replace(/^﻿/, "");

for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;

  const key = trimmed.slice(0, eqIdx).trim();
  // Strip a matching pair of surrounding single/double quotes from the value.
  let value = trimmed.slice(eqIdx + 1).trim();
  value = value.replace(/^(['"])(.*)\1$/, "$2");

  if (key && !(key in process.env)) {
    process.env[key] = value;
  }
}
