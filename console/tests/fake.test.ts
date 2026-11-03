// console/tests/fake.test.ts
import { describe, it, expect } from "vitest";

describe("fake MSW server", () => {
  it("fake /api/state responde estado válido", async () => {
    const res = await fetch("http://localhost/api/state");
    const json = await res.json();
    expect(json.servers.length).toBeGreaterThan(0);
  });
});
