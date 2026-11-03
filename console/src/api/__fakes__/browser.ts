/**
 * console/src/api/__fakes__/browser.ts
 *
 * MSW service worker for browser / Vite dev server.
 * Import and start in main.tsx when VITE_MSW=true.
 */

import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
