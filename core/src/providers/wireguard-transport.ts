/**
 * core/src/providers/wireguard-transport.ts
 *
 * The WireGuardController seam — OWNED BY src/, not by a test fake.
 *
 * PORT-OWNERSHIP DISCIPLINE (same rule as provider.ts / docker-transport.ts
 * headers: production code must not import from `test/`). WireGuardProvider
 * (wireguard.ts) is written purely against this seam, so the contract lives
 * here, in the production tree, next to its only consumer. Implementations
 * live elsewhere and depend INWARD on this file:
 *
 *   - core/test/fakes/wireguard-control.ts — the in-process deterministic
 *     fake used by every Fase-3 WireGuard test (implements this interface,
 *     type-only import).
 *   - a future real WG control client (Fase 3+/6) — driving `wg set` /
 *     netlink over the existing SSH tunnel — implements the SAME interface
 *     unchanged, so the provider stays transport-agnostic.
 *
 * WHY A PEER-OP SEAM (not method+path+body): WireGuard is configured via the
 * `wg` device control surface (`wg show` / `wg set`), NOT an HTTP API. The
 * honest seam is therefore the device control operations the provider needs:
 *   - listPeers(): every peer currently programmed on the mesh device.
 *   - setPeer(p):  add-or-update one peer (idempotent at the device — `wg set
 *                  peer …` upserts; re-applying identical config is a no-op
 *                  on the wire).
 *   - removePeer(publicKey): remove one peer. PRESENT IN THE SEAM ONLY for a
 *     future reconciler-driven prune (Task 2.9). The PROVIDER (3.4) NEVER
 *     calls it — fail-safe, never fail-deleting: an orphan/unmanaged peer is
 *     drift the reconciler decides on, not something the provider deletes.
 *
 * SECRET-BOUNDARY CONTRACT (spec §SECRET BOUNDARY; binds every
 * implementation, especially the future real one): a WireGuard PRIVATE key is
 * secret material. It is NEVER part of this seam — neither `WgPeer` nor any
 * method carries a private key. Only PUBLIC keys and non-sensitive peer
 * config (allowed IPs, endpoint) cross this boundary. Implementations MUST
 * NOT include any key material or peer secret in error messages, rejections
 * or logs — surface only the public key / non-sensitive fields on diagnostics.
 *
 * Exported API:
 *   interface WgPeer            — one peer's observable (non-secret) config
 *   interface WireGuardController — the seam WireGuardProvider is written against
 */

/**
 * One WireGuard peer as the device exposes it / as the provider programs it.
 *
 * Deliberately PUBLIC-ONLY: a peer is identified by its `publicKey`; its
 * private key (secret) NEVER appears here. `allowedIps` is the peer's mesh
 * address space; `endpoint` is its reachable host:port (may be absent for a
 * roaming peer). `tags` is a free-form non-secret marker map the provider
 * uses to stamp a managed-marker (mirrors docker.ts's `bevox.*` labels) so
 * managed peers are distinguishable from orphans WITHOUT deleting anything.
 *
 * Volatile runtime fields a real `wg show` also returns (latest handshake,
 * rx/tx bytes) are intentionally NOT modelled: they are not desired-derived,
 * so comparing them would flap convergence and break the Fase-2 idempotency
 * property. The provider compares only the stable fields below.
 */
export interface WgPeer {
  /** The peer's PUBLIC key. Stable identity. Never a private key. */
  readonly publicKey: string;
  /** The peer's mesh address space, e.g. ["10.99.0.3/32"]. Order-stable. */
  readonly allowedIps: readonly string[];
  /** host:port the peer is reachable at; absent for a roaming peer. */
  readonly endpoint?: string;
  /** Non-secret marker map (managed-marker channel — see header). */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * The device-control seam WireGuardProvider (3.4) is written against. The
 * fake and a future real `wg`-backed controller implement this exact
 * interface so the provider stays controller-agnostic.
 *
 * setPeer MUST be an upsert keyed by `publicKey` (matches `wg set peer`):
 * setting a peer whose stable config already matches is a no-op on the wire.
 * removePeer exists for the reconciler's future prune ONLY — the provider
 * never invokes it (fail-safe).
 */
export interface WireGuardController {
  /** Read-only: every peer currently programmed on the mesh device. */
  listPeers(): Promise<readonly WgPeer[]>;
  /** Add-or-update one peer, keyed by publicKey. Upsert (idempotent). */
  setPeer(peer: WgPeer): Promise<void>;
  /**
   * Remove one peer by public key. FOR THE RECONCILER'S FUTURE PRUNE ONLY
   * (Task 2.9). WireGuardProvider (3.4) MUST NOT call this.
   */
  removePeer(publicKey: string): Promise<void>;
}
