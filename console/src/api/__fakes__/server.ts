/**
 * console/src/api/__fakes__/server.ts
 *
 * MSW node server for use in Vitest (Node.js / jsdom environment).
 */

import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
