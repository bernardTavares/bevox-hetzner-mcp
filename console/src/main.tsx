import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

/**
 * Dev-only: start the MSW browser worker so the console is interactive
 * against the fake server (faithful to CONTRACT.md). The dynamic import is
 * tree-shaken out of production builds — wiring to the real core REST is
 * Fase 4 (out of scope here).
 */
async function bootstrap(): Promise<void> {
  if (import.meta.env.DEV) {
    const { worker } = await import("./api/__fakes__/browser.js");
    await worker.start({ onUnhandledRequest: "bypass" });
  }
  createRoot(rootElement as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
