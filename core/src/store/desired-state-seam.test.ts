// core/src/store/desired-state-seam.test.ts
import { describe, it, expect } from "vitest";
import { createDesiredStateSeam } from "./desired-state-seam.js";

describe("desired-state-seam — service scope merges volume desired (Bug 7)", () => {
  it("loadDesired('service') includes volumes so plan() validates svc.volumes refs", async () => {
    const seam = createDesiredStateSeam();
    await seam.writeDesired("volume", {
      volumes: [{ name: "pg-data", size: "10G", fs: "ext4" }],
    });
    await seam.writeDesired("service", {
      services: [
        { name: "pg", image: "postgres:16", replicas: 1, volumes: ["pg-data"] },
      ],
    });
    const merged = await seam.loadDesired("service");
    expect(merged.services?.map((s) => s.name)).toEqual(["pg"]);
    // The service scope must see the volume it references (cross-kind plan dep).
    expect(merged.volumes?.map((v) => v.name)).toEqual(["pg-data"]);
  });

  it("writeDesired replaces a scope's own slice (not merge)", async () => {
    const seam = createDesiredStateSeam();
    await seam.writeDesired("service", {
      services: [{ name: "a", image: "x", replicas: 1 }],
    });
    await seam.writeDesired("service", {
      services: [{ name: "b", image: "x", replicas: 1 }],
    });
    const own = await seam.loadDesired("service");
    expect(own.services?.map((s) => s.name)).toEqual(["b"]);
  });
});
