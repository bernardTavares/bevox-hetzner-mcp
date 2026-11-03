/**
 * core/src/providers/wireguard.test.ts
 *
 * Task 3.4 — drives WireGuardProvider against the in-process WireGuard
 * control fake (core/test/fakes/wireguard-control.ts) through the `wg`-shaped
 * `WireGuardController` seam. ZERO network / SSH / wg / netlink / DB / fs.
 *
 * Central guarantee under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"):
 *
 *   - observe(scope) lists managed mesh peers by the bevox marker, one entity
 *     per managed Server.
 *   - apply(create) converges the server's mesh peer (setPeer), then is a
 *     NO-OP (changed:false) on every repeat — proven by the provider-agnostic
 *     conformanceHarness (incl. its observe(scope) teeth) AND a write-count.
 *   - idempotency holds for single- AND multi-peer meshes; convergence
 *     compares only STABLE desired-derived fields (no flap from volatile
 *     runtime state — the fake models none, asserting the model's stability).
 *   - fail-safe: remove/destroy are no-ops — they NEVER delete a peer; an
 *     unmanaged ORPHAN peer is never removed by the provider.
 *   - error mapping flows strictly through domain/errors.ts: a device fault →
 *     transient; malformed Server desired → precondition (no crash).
 *   - secret discipline: no private key material ever appears in the seam,
 *     observe(), or error messages (the seam is public-only by construction).
 */

import { describe, it, expect } from "vitest";
import { createWireGuardControlFake } from "../../test/fakes/wireguard-control.js";
import { createWireGuardProvider, derivePeer } from "./wireguard.js";
import { conformanceHarness, type PlanAction } from "./provider.js";
import { ReconcileError } from "../domain/errors.js";
import type { Server } from "../domain/entities.js";

// ---------------------------------------------------------------------------
// Rig: a provider wired to a fresh WireGuard control fake.
// ---------------------------------------------------------------------------

function makeRig() {
  const fake = createWireGuardControlFake();
  const makeProvider = () =>
    createWireGuardProvider({ controller: fake.controller });
  return { fake, makeProvider };
}

function server(name: string): Server {
  return {
    name,
    type: "cx22",
    location: "fsn1",
    image: "debian-12",
    ssh_keys: ["k1"],
    labels: {},
    network: "mesh-net",
    status: "pending",
  };
}

const APP1: PlanAction = {
  op: "create",
  entity: "server:app-1",
  desired: server("app-1"),
};

const APP2: PlanAction = {
  op: "create",
  entity: "server:app-2",
  desired: server("app-2"),
};

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

describe("WireGuardProvider — observe", () => {
  it("lists only bevox-managed peers by marker, one entity per server", async () => {
    const { makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(APP1);
    await p.apply(APP2);

    const obs = await p.observe("server");
    expect(obs.scope).toBe("server");
    expect(obs.entities.map((e) => e.key).sort()).toEqual([
      "server:app-1",
      "server:app-2",
    ]);
  });

  it("returns empty when nothing managed exists", async () => {
    const { makeProvider } = makeRig();
    expect((await makeProvider().observe("server")).entities).toEqual([]);
  });

  it("ignores unmanaged orphan peers (not in the desired-derived `wgpub:` namespace)", async () => {
    const { fake, makeProvider } = makeRig();
    // A genuinely unmanaged peer has a real base64 WireGuard public key — it
    // is NOT in this provider's deterministic `wgpub:<name>` namespace, so
    // observe() (managed-set = desired-derived, identity = public key) must
    // not surface it. (Using a `wgpub:` key here would, correctly, BE a
    // managed peer under the fixed identity model — that is not an orphan.)
    fake.seedPeer({
      publicKey: "Qk9HVVNfRk9SRUlHTl9QRUVSX0tFWV9OT1RfQkVWT1g=",
      allowedIps: ["10.0.0.9/32"],
    });
    const p = makeProvider();
    await p.apply(APP1);
    expect((await p.observe("server")).entities.map((e) => e.key)).toEqual([
      "server:app-1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// idempotency — conformanceHarness is the oracle
// ---------------------------------------------------------------------------

describe("WireGuardProvider — idempotency (conformanceHarness oracle)", () => {
  it("passes the conformance harness for a single peer (observe teeth)", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, APP1, "server");
  });

  it("passes the conformance harness for a second, distinct peer", async () => {
    const { makeProvider } = makeRig();
    await conformanceHarness(makeProvider, APP2, "server");
  });

  it("create then apply again = no-op the 2nd time (zero extra writes)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    const first = await p.apply(APP1);
    expect(first.changed).toBe(true);
    expect(await p.verify(APP1)).toBe(true);

    const second = await p.apply(APP1);
    expect(second.changed).toBe(false);
    expect(await p.verify(APP1)).toBe(true);

    // Exactly one peer for this server — no duplicate.
    const mine = fake.peers().filter((x) => x.publicKey === "wgpub:app-1");
    expect(mine).toHaveLength(1);
  });

  it("multi-peer mesh: each server converges independently, all no-op on re-apply", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    expect((await p.apply(APP1)).changed).toBe(true);
    expect((await p.apply(APP2)).changed).toBe(true);
    expect((await p.apply(APP1)).changed).toBe(false);
    expect((await p.apply(APP2)).changed).toBe(false);

    expect(await p.verify(APP1)).toBe(true);
    expect(await p.verify(APP2)).toBe(true);
    expect(fake.peers().map((x) => x.publicKey).sort()).toEqual([
      "wgpub:app-1",
      "wgpub:app-2",
    ]);
  });

  it("re-converges a stable-drifted peer without flapping afterwards", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();

    await p.apply(APP1);
    // Simulate the device peer's stable config drifting (e.g. endpoint).
    fake.seedPeer({
      ...derivePeer(server("app-1")),
      endpoint: "stale-host:1",
    });
    expect(await p.verify(APP1)).toBe(false);

    const fix = await p.apply(APP1);
    expect(fix.changed).toBe(true); // re-set to desired
    expect(await p.verify(APP1)).toBe(true);

    // Flap pin: a subsequent apply is a no-op again.
    expect((await p.apply(APP1)).changed).toBe(false);
    expect(await p.verify(APP1)).toBe(true);
  });

  it("convergence is desired-derived: a tagless observed peer (right key/ips/endpoint, NO tags) is converged & re-apply is a no-op", async () => {
    // Real-host shape: a `wg show dump` carries NO tag channel. Seed the
    // managed peer's STABLE desired-derived config but WITHOUT any tags. The
    // old observed-tag isConverged would treat this as not-converged and
    // re-issue setPeer forever (the 7.2 break). Desired-derived convergence
    // (identity = the `wgpub:` public key) must accept it as converged.
    const { fake, makeProvider } = makeRig();
    const want = derivePeer(server("app-1"));
    fake.seedPeer({
      publicKey: want.publicKey,
      allowedIps: [...want.allowedIps],
      ...(want.endpoint ? { endpoint: want.endpoint } : {}),
      // deliberately NO `tags` — exactly what a real `wg` reports.
    });
    const p = makeProvider();

    expect(await p.verify(APP1)).toBe(true); // converged WITHOUT a tag
    expect((await p.apply(APP1)).changed).toBe(false); // no flap
    expect((await p.observe("server")).entities.map((e) => e.key)).toEqual([
      "server:app-1",
    ]);
    // Exactly one peer for this server — no duplicate written.
    expect(
      fake.peers().filter((x) => x.publicKey === want.publicKey),
    ).toHaveLength(1);
  });

  it("derivePeer is pure & deterministic and exposes NO private key", () => {
    const a = derivePeer(server("app-1"));
    const b = derivePeer(server("app-1"));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/private/i);
    expect(a.publicKey).toBe("wgpub:app-1");
  });
});

// ---------------------------------------------------------------------------
// fail-safe — never fail-deleting
// ---------------------------------------------------------------------------

describe("WireGuardProvider — fail-safe (never fail-deleting)", () => {
  it("remove/destroy ops are no-ops and delete no peer", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    await p.apply(APP1);

    for (const op of ["remove", "destroy"] as const) {
      const res = await p.apply({ ...APP1, op });
      expect(res.changed).toBe(false);
    }
    // Fail-safe: the managed peer is still present.
    expect((await p.observe("server")).entities.map((e) => e.key)).toEqual([
      "server:app-1",
    ]);
    expect(fake.peers().map((x) => x.publicKey)).toContain("wgpub:app-1");
  });

  it("never removes an unmanaged orphan peer while converging managed ones", async () => {
    const { fake, makeProvider } = makeRig();
    fake.seedPeer({
      publicKey: "wgpub:orphan",
      allowedIps: ["10.99.7.7/32"],
    });
    const p = makeProvider();

    await p.apply(APP1);
    await p.apply({ ...APP1, op: "destroy" });

    // Orphan untouched — drift is the reconciler's job (Task 2.9), not ours.
    expect(fake.peers().map((x) => x.publicKey).sort()).toEqual([
      "wgpub:app-1",
      "wgpub:orphan",
    ]);
  });
});

// ---------------------------------------------------------------------------
// error mapping (via domain/errors.ts)
// ---------------------------------------------------------------------------

describe("WireGuardProvider — error mapping (via domain/errors.ts)", () => {
  it("device fault → transient ReconcileError (no key leak)", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setDeviceFault(true);

    await expect(p.observe("server")).rejects.toMatchObject({
      errorClass: "transient",
    });
    // STRONG assertion (mirrors the observe form above): apply() MUST reject
    // — a soft .catch() would silently skip the key-leak guard if apply ever
    // resolved. Then assert the thrown message carries NO key-ish material.
    await expect(p.apply(APP1)).rejects.toMatchObject({
      errorClass: "transient",
    });
    const err = await p.apply(APP1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcileError);
    expect((err as ReconcileError).message).not.toMatch(/wgpub|private|10\.99/);
  });

  it("malformed Server desired → precondition (no crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(
      makeProvider().apply({
        op: "create",
        entity: "server:bad",
        desired: { name: "bad" },
      }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });

  it("unknown scope → precondition (no silent crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(makeProvider().observe("dragon")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("missing controller at construction → fatal", () => {
    expect(() =>
      // @ts-expect-error — intentionally omitting the required controller
      createWireGuardProvider({}),
    ).toThrowError(ReconcileError);
  });
});
