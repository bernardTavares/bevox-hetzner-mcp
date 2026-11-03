/**
 * core/test/fakes/wireguard-control.ts
 *
 * In-memory, per-instance fake of a WireGuard device control surface. Its
 * sole job is to be a deterministic `WireGuardController` seam for
 * WireGuardProvider (3.4) so the mesh-peer convergence logic can be exercised
 * in-process with ZERO network, SSH, netlink, `wg` binary, DB or filesystem.
 *
 * ⚠ THIS IS NOT A TEST OF WIREGUARD and is NOT a spec-faithful `wg`
 * emulator. It models only the MINIMAL peer surface Fase 3 needs
 * (list / set(upsert) / remove) plus one deterministic device-fault toggle.
 * No real crypto, no key generation, no handshakes, no rx/tx accounting, no
 * routing — those are out of scope (YAGNI; key rotation is a spec
 * NON-objective).
 *
 * Design principles (mirrors core/test/fakes/docker-http.ts isolation
 * philosophy):
 *
 *   - PER-INSTANCE, RESETTABLE. `createWireGuardControlFake()` returns a
 *     fresh isolated instance; the peer map lives in a closure (no
 *     global/static state). `reset()` returns it to pristine.
 *
 *   - UPSERT-BY-PUBLICKEY. `setPeer` keys on `publicKey` exactly like
 *     `wg set peer`: setting an existing peer replaces its config; setting a
 *     new one adds it. This exposes the device truth so 3.4 can implement
 *     observe-before-write as a no-op. The fake does NOT implement provider
 *     logic and never auto-removes anything.
 *
 *   - DETERMINISTIC FAULT. `setDeviceFault(on)` makes every controller call
 *     reject with a device error until toggled off, so 3.4 can test error
 *     mapping. Per-instance; minimal (YAGNI).
 *
 *   - NO SECRET CHANNEL. The seam is public-only by construction; the fake
 *     therefore cannot hold or surface any private key.
 *
 * SEAM OWNERSHIP: `WireGuardController` / `WgPeer` are OWNED by the
 * production tree (core/src/providers/wireguard-transport.ts) — port-
 * ownership discipline: src/ must not import from test/. This fake
 * IMPLEMENTS that seam (type-only import below); it does not declare it.
 *
 * Exported API (minimal — only what Fase 3 needs):
 *   createWireGuardControlFake(): WireGuardControlFake
 *   interface WireGuardControlFake { controller; reset(); setDeviceFault(on);
 *                                    seedPeer(p); peers() }
 */

import type {
  WgPeer,
  WireGuardController,
} from "../../src/providers/wireguard-transport.js";

export interface WireGuardControlFake {
  /** Drop-in `WireGuardController` for WireGuardProvider — never touches net/SSH. */
  readonly controller: WireGuardController;
  /** Clear all peers and the device-fault toggle. */
  reset(): void;
  /** While true, every controller call rejects with a device error. */
  setDeviceFault(on: boolean): void;
  /**
   * Test-only: inject a peer directly (e.g. an unmanaged ORPHAN) so tests can
   * assert the provider never deletes it. Bypasses the controller surface.
   */
  seedPeer(peer: WgPeer): void;
  /** Test-only snapshot of the current device peers (deep copies). */
  peers(): WgPeer[];
}

export function createWireGuardControlFake(): WireGuardControlFake {
  // --- per-instance state (closure; no global/static) ---------------------
  const peers = new Map<string, WgPeer>(); // by publicKey
  let deviceFault = false;

  function fresh(): void {
    peers.clear();
    deviceFault = false;
  }

  function copy(p: WgPeer): WgPeer {
    return {
      publicKey: p.publicKey,
      allowedIps: [...p.allowedIps],
      ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
      ...(p.tags !== undefined ? { tags: { ...p.tags } } : {}),
    };
  }

  function faultOr<T>(fn: () => T): Promise<T> {
    if (deviceFault) {
      // A device control failure — shaped so errors.ts classify() treats it
      // as transient (mirrors a `wg`/netlink blip). Message is key-free.
      return Promise.reject(
        Object.assign(new Error("wg device control unavailable"), {
          code: "ETIMEDOUT",
        }),
      );
    }
    return Promise.resolve(fn());
  }

  const controller: WireGuardController = {
    listPeers() {
      return faultOr(() => [...peers.values()].map(copy));
    },
    setPeer(peer) {
      return faultOr(() => {
        peers.set(peer.publicKey, copy(peer)); // upsert by publicKey
      });
    },
    removePeer(publicKey) {
      return faultOr(() => {
        peers.delete(publicKey);
      });
    },
  };

  fresh();

  return {
    controller,
    reset: fresh,
    setDeviceFault(on) {
      deviceFault = on;
    },
    seedPeer(peer) {
      peers.set(peer.publicKey, copy(peer));
    },
    peers() {
      return [...peers.values()].map(copy);
    },
  };
}
