/**
 * console/tests/setup.ts
 *
 * Vitest global setup: starts the MSW node server before all tests,
 * resets handlers after each test, and closes the server after all tests.
 */

import "@testing-library/jest-dom/vitest";
import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "../src/api/__fakes__/server";
import { resetState } from "../src/api/__fakes__/handlers";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "warn" });
});

afterEach(() => {
  server.resetHandlers();
  resetState();
});

afterAll(() => {
  server.close();
});
