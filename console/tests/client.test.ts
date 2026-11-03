import { describe, it, expect } from "vitest";
import { getState, postWrite } from "../src/api/client";

describe("client", () => {
  it("getState parseia resposta via Zod", async () => {
    const s = await getState();
    expect(s.servers[0].status).toBeDefined();
  });
  it("postWrite com dry_run retorna envelope planned", async () => {
    const r = await postWrite("/api/services", { name: "x", image: "i:v1", replicas: 1, dry_run: true });
    expect(r.status).toBe("planned");
    expect(r.plan?.length).toBeGreaterThan(0);
  });
  it("erro estruturado é lançado tipado", async () => {
    await expect(postWrite("/api/destroy", { entity: "__force_error__" })).rejects.toMatchObject({ code: expect.any(String) });
  });
});
