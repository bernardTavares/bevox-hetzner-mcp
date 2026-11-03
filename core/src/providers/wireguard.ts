/**
 * core/src/providers/wireguard.ts
 *
 * Task 3.4 — WireGuardProvider: the concrete `Provider` (provider.ts) for the
 * private WireGuard mesh. It is the ONLY translation seam between a
 * declarative managed Server (entities.ts) and the WireGuard device-control
 * surface, driving every operation through an injected `WireGuardController`
 * (the `wg`-shaped seam from wireguard-transport.ts). The provider is
 * controller-agnostic: it never learns whether it speaks to the in-process
 * fake or a future real `wg`/SSH-backed controller — only peer ops.
 *
 * THE MESH MODEL (spec §"WireGuard mesh"; §"non-objetivos" — no key rotation,
 * no real crypto, no DNS; YAGNI):
 *
 *   The private mesh has ONE peer per managed Server. WireGuard peers are
 *   therefore DERIVED FROM the managed servers/private network already in
 *   desired state — they are NOT a new manifest entity (the manifest schema
 *   has none; inventing one would violate YAGNI). The provider's `desired`
 *   payload is a `Server` (entity key `server:<name>`, scope `server`); each
 *   such Server maps DETERMINISTICALLY to exactly one mesh peer:
 *
 *     - publicKey  : a deterministic stand-in derived from the server name
 *                    (`wgpub:<name>`). NO real crypto / key generation /
 *                    rotation (spec lists secret/key rotation as a
 *                    non-objective). A future real controller swaps this for
 *                    the host's actual public key; the provider contract is
 *                    unchanged. A PRIVATE key NEVER appears here, in the seam,
 *                    in observe(), in errors or in logs (secret discipline,
 *                    mirroring Task 3.3).
 *     - allowedIps : the peer's mesh address as a /32 derived deterministically
 *                    from the server name within the mesh range.
 *     - endpoint   : `<server-name>:51820` (the WireGuard default port) —
 *                    a stable, desired-derived stand-in.
 *
 *   Only these STABLE desired-derived fields define convergence. Volatile
 *   runtime fields (latest handshake, rx/tx bytes) are deliberately NOT
 *   modelled or compared — comparing them would flap convergence and break
 *   the Fase-2 idempotency property (Task 3.5 verifies end-to-end).
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; YAGNI):
 *
 *   - IDEMPOTENCY IS THE CENTRAL INVARIANT (Fase 2 exit criterion, must keep
 *     holding now that the mesh joins — Task 3.5 verifies). apply() OBSERVES
 *     BEFORE IT WRITES: it lists the device peers, and only calls setPeer()
 *     when the desired peer is absent OR its STABLE config differs. Once the
 *     peer is present and converged, apply() performs NO write and returns
 *     `changed:false`. conformanceHarness(makeProvider, action, "server") is
 *     the oracle, wired directly in the test.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. This task only observes / sets /
 *     verifies peers. There is NO peer removal: an unmanaged/orphan peer
 *     present on the device but not desired is the reconciler's drift concern
 *     (Task 2.9), never auto-removed here. The seam's removePeer() is
 *     STRUCTURALLY never called by this provider. A destructive `op`
 *     (remove/destroy) is a deliberate NO-OP returning `changed:false`
 *     (consistent with docker.ts / hetzner-cloud.ts). No destructive rollback
 *     on partial failure.
 *
 *   - PRECONDITION BEFORE WRITE. Malformed Server desired (fails the
 *     entities.ts ServerSchema, or empty name) is a ReconcileError(
 *     "precondition"), never a crash, raised before any device write. An
 *     unknown scope/kind is likewise "precondition".
 *
 *   - MANAGED-SET IS DESIRED-DERIVED (identity = public key). A real `wg`
 *     device (see ssh-transports.ts `parseWgDump`) has NO tag channel — a tag
 *     CANNOT be read back from a real host. So managed/convergence MUST NOT
 *     depend on an observed tag (the old design's real-host break: a tagless
 *     observed peer was never "converged", flapping `setPeer` every cycle and
 *     emptying observe()). Instead, a peer is "the managed peer for a server"
 *     iff its PUBLIC KEY is the deterministic `derivePeer` namespace
 *     (`wgpub:<name>`) — identity is the key, not a tag. observe() recovers
 *     the managed entity set from that desired-derived namespace; convergence
 *     compares only the stable desired-derived fields a real `wg show dump`
 *     CAN report (public key, allowed IPs, endpoint). The provider MAY still
 *     stamp a `bevox.*` tag on apply (harmless on a tag-capable backend), but
 *     NOTHING in observe()/convergence reads it back — so behaviour is
 *     identical on the in-process fake AND a real tagless `wg` host (no flap).
 *
 *   - ERROR MAPPING via domain/errors.ts ONLY. A controller/device failure is
 *     classified through classify() into a ReconcileError (a `wg`/netlink
 *     blip → transient, etc.). No key material or peer secret is ever placed
 *     in a message.
 *
 *   - MINIMAL SURFACE. One factory `createWireGuardProvider(opts)` returning
 *     `Provider`; opts inject the `WireGuardController`. Scope is the server-
 *     derived mesh only — no key rotation, no real crypto, no DNS (YAGNI).
 *
 * Exported API:
 *   createWireGuardProvider(opts: WireGuardProviderOptions): Provider
 *   interface WireGuardProviderOptions
 *   derivePeer(server): WgPeer   — the pure, deterministic mesh derivation
 */

import { ServerSchema, type Server } from "../domain/entities.js";
import { classify, ReconcileError } from "../domain/errors.js";
import type {
  WgPeer,
  WireGuardController,
} from "./wireguard-transport.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Options — the test injects the WireGuard control fake here.
// ---------------------------------------------------------------------------

export interface WireGuardProviderOptions {
  /**
   * The `wg`-shaped device-control seam. Injected in tests as the in-process
   * fake; a future real `wg`/SSH-backed controller implements the SAME
   * interface unchanged, so the provider stays controller-agnostic.
   */
  readonly controller: WireGuardController;
}

// ---------------------------------------------------------------------------
// Managed-set identity — DESIRED-DERIVED, the PUBLIC KEY is identity.
//
// `derivePeer` mints every managed peer's public key in the deterministic
// `wgpub:<server-name>` namespace. That namespace IS the managed-set marker:
// a peer is "the managed peer for a server" iff its publicKey is in it. This
// channel survives a real tagless `wg show dump` (ssh-transports.ts) — unlike
// the old observed-tag dependency, which a real `wg` cannot report (the 7.2
// real-host break). The `bevox.*` tags below are STILL stamped on apply for
// any tag-capable backend, but observe()/convergence NEVER read them back.
// ---------------------------------------------------------------------------

const TAG_MANAGED = "bevox.managed";
const TAG_SERVER = "bevox.server";

/** The deterministic public-key namespace `derivePeer` mints into. */
const PUBKEY_PREFIX = "wgpub:";

const SCOPE = "server";
const WG_DEFAULT_PORT = 51820;

/**
 * Is this observed peer one this provider manages? Identity is the PUBLIC KEY:
 * a managed peer's key is in the deterministic `derivePeer` namespace. This
 * is desired-derived (no observed tag), so it holds against a real tagless
 * `wg show dump` exactly as against the fake. The recovered server name (the
 * key suffix) must be non-empty (`derivePeer` requires a non-empty name).
 */
function managedServerName(peer: WgPeer): string | undefined {
  if (!peer.publicKey.startsWith(PUBKEY_PREFIX)) return undefined;
  const name = peer.publicKey.slice(PUBKEY_PREFIX.length);
  return name.length > 0 ? name : undefined;
}

// ---------------------------------------------------------------------------
// Mesh derivation — PURE & DETERMINISTIC. One managed Server → one peer.
// No real crypto, no key generation/rotation (spec non-objective): the
// public key is a stable stand-in derived from the server name. A PRIVATE
// key is NEVER produced or referenced anywhere.
// ---------------------------------------------------------------------------

/**
 * A small stable hash → an octet in [2,250], so distinct server names get
 * distinct mesh /32s deterministically without a real allocator (YAGNI; a
 * real IPAM is the reconciler/network layer's concern, not this provider's).
 */
function octet(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return 2 + (h % 249);
}

/**
 * Derive the mesh peer for one managed Server. Exported because it is the
 * pure, deterministic core of the model — tests assert it directly and a
 * future real controller reuses the non-key parts unchanged.
 */
export function derivePeer(server: Server): WgPeer {
  const a = octet(server.name);
  const b = octet(`${server.name}#`);
  return {
    // Deterministic PUBLIC-key stand-in. Never a private key.
    publicKey: `wgpub:${server.name}`,
    allowedIps: [`10.99.${a}.${b}/32`],
    endpoint: `${server.name}:${WG_DEFAULT_PORT}`,
    tags: { [TAG_MANAGED]: "true", [TAG_SERVER]: server.name },
  };
}

/**
 * Whether the device peer matches the desired derived peer on the STABLE
 * desired-derived fields a real `wg show dump` CAN report: public key
 * (IDENTITY — the managed marker is the `wgpub:` namespace, not a tag),
 * allowed IPs, endpoint. NO observed tag is compared: a real `wg` device has
 * no tag channel (ssh-transports.ts `parseWgDump`), so depending on a tag
 * here made a tagless real peer never converge → `setPeer` re-issued every
 * cycle (the 7.2 break). Volatile runtime fields (handshake/rx/tx) are still
 * never compared — comparing them would flap convergence / break Task 3.5.
 */
function isConverged(have: WgPeer, want: WgPeer): boolean {
  if (have.publicKey !== want.publicKey) return false;
  if (have.endpoint !== want.endpoint) return false;
  const a = [...have.allowedIps];
  const b = [...want.allowedIps];
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  // Identity IS the public key (checked above) and it is in the
  // desired-derived `wgpub:` namespace — no observed tag is required or read.
  return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWireGuardProvider(
  opts: WireGuardProviderOptions,
): Provider {
  if (!opts.controller) {
    // Construction-time misconfiguration is fatal, not a reconcile failure.
    throw new ReconcileError(
      "fatal",
      "WireGuardProvider: a WireGuardController is required",
    );
  }
  const ctl = opts.controller;

  /** Narrow a "<kind>:<name>" key / scope to "server"; else precondition. */
  function assertScope(scopeOrEntity: string): void {
    const kind = scopeOrEntity.split(":", 1)[0] ?? "";
    if (kind !== SCOPE) {
      throw new ReconcileError(
        "precondition",
        `WireGuardProvider: unsupported scope/kind "${kind}" ` +
          `(supported: ${SCOPE})`,
        { entity: scopeOrEntity },
      );
    }
  }

  /** Validate desired against ServerSchema → precondition on failure. */
  function parseServer(action: PlanAction): Server {
    const parsed = ServerSchema.safeParse(action.desired);
    if (!parsed.success) {
      throw new ReconcileError(
        "precondition",
        `WireGuardProvider: malformed Server desired for ${action.entity} ` +
          `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        { entity: action.entity },
      );
    }
    if (parsed.data.name.length === 0) {
      throw new ReconcileError(
        "precondition",
        `WireGuardProvider: Server name must be non-empty for ${action.entity}`,
        { entity: action.entity },
      );
    }
    return parsed.data;
  }

  /**
   * Wrap a controller call so any device failure is mapped through
   * domain/errors.ts. The error MESSAGE is key-free by construction (the
   * seam contract forbids key material in rejections) — we never echo the
   * peer config into it.
   */
  async function guarded<T>(
    fn: () => Promise<T>,
    entity: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReconcileError) throw e;
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as { code: unknown }).code)
          : undefined;
      throw new ReconcileError(
        classify({ code, kind: "network-error" }),
        `WireGuardProvider: device control failed for ${entity}`,
        { entity, cause: e },
      );
    }
  }

  /**
   * Managed peers only — recognised by the DESIRED-DERIVED public-key
   * namespace (`wgpub:<name>`), NOT an observed tag a real `wg` cannot
   * report. Never touches/deletes an unmanaged peer (orphan→drift stays the
   * reconciler's job, Task 2.9). Read-only.
   */
  async function managedPeers(entity: string): Promise<WgPeer[]> {
    const all = await guarded(() => ctl.listPeers(), entity);
    return all.filter((p) => managedServerName(p) !== undefined);
  }

  return {
    name: "wireguard",

    async observe(scope: string): Promise<ObservedSlice> {
      assertScope(scope);
      // Managed entity set is DESIRED-DERIVED: each managed peer's server
      // name is recovered from the deterministic `wgpub:<name>` public-key
      // namespace (NOT an observed tag the wire cannot carry). This makes
      // observe() report the managed entities against a real tagless
      // `wg show dump` exactly as against the fake — the reconciler's
      // scoping/orphan handling (Task 2.9) stays correct on real infra.
      const managed = await managedPeers(scope);
      const names = new Set<string>();
      for (const p of managed) {
        const s = managedServerName(p);
        if (s) names.add(s);
      }
      // Desired-derived ⇒ minimal { name } payload (no rich observed object).
      return {
        scope,
        entities: [...names].map((s) => ({ key: `${SCOPE}:${s}`, payload: { name: s } })),
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      assertScope(action.entity);
      const want = derivePeer(parseServer(action));
      const all = await guarded(() => ctl.listPeers(), action.entity);
      const have = all.find((p) => p.publicKey === want.publicKey);
      return have !== undefined && isConverged(have, want);
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      assertScope(action.entity);

      // FAIL-SAFE: destructive intents are NOT handled here. No-op, never
      // remove a peer (orphan→drift is the reconciler's job, Task 2.9).
      // removePeer() is STRUCTURALLY never reached from this provider.
      if (action.op === "remove" || action.op === "destroy") {
        return { entity: action.entity, op: action.op, changed: false };
      }

      const want = derivePeer(parseServer(action));

      // IDEMPOTENCY: observe-before-write. If the peer already exists and its
      // STABLE config matches, this apply() is a NO-OP (no write, changed:
      // false). Only an absent or stable-drifted peer triggers setPeer().
      const all = await guarded(() => ctl.listPeers(), action.entity);
      const have = all.find((p) => p.publicKey === want.publicKey);
      if (have && isConverged(have, want)) {
        return { entity: action.entity, op: action.op, changed: false };
      }

      await guarded(() => ctl.setPeer(want), action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
  };
}
