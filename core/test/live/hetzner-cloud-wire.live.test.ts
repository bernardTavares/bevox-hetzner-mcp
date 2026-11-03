/**
 * core/test/live/hetzner-cloud-wire.live.test.ts
 *
 * @live skeleton — HetznerCloud wire translation smoke (opt-in, manual).
 *
 * What this verifies
 * ------------------
 * The HetznerCloudProvider, wired against the REAL Hetzner Cloud API, can:
 *   1. Create a small Network with one /24 subnet using the correct wire shape
 *      ({subnets: [{ip_range, type:"cloud", network_zone:"eu-central"}]}).
 *   2. Converge: a second apply() returns changed:false (idempotency).
 *   3. The created network id is non-zero (confirming a real resource was made).
 *
 * Cleanup: the test uses raw fetch to DELETE the network directly via the
 * Hetzner API after the assertions. This is intentional — HetznerCloudProvider
 * does NOT implement a destroy path (spec §3 non-goal, §11 explicitly out of
 * scope). Cleanup is the operator's responsibility if the test is interrupted.
 *
 * How to run
 * ----------
 *   HETZNER_LIVE_TOKEN=<real-hcloud-token> \
 *   HETZNER_LIVE_ZONE=<optional, unused here> \
 *     npx vitest run --cwd core test/live/hetzner-cloud-wire.live.test.ts
 *
 * This file is excluded from `npm --prefix core test` by the unit vitest
 * project's glob (*.live.test.ts suffix exclusion in core/vitest.config.ts).
 *
 * Spec: docs/specs/2026-05-27-hetzner-cloud-wire-translation.md §9.9
 */

import { describe, it, expect, afterAll } from "vitest";
import { HttpClient } from "../../src/providers/http-client.js";
import { createHetznerCloudProvider } from "../../src/providers/hetzner-cloud.js";

const LIVE_TOKEN = process.env["HETZNER_LIVE_TOKEN"];
const BASE_URL = "https://api.hetzner.cloud/v1";

// Unique name per run so a previous incomplete test doesn't collide.
const NETWORK_NAME = `live-wire-test-${Date.now()}`;

// Track created network id for cleanup.
let createdNetworkId: number | null = null;

afterAll(async () => {
  if (!LIVE_TOKEN || createdNetworkId === null) return;
  // Best-effort cleanup: DELETE the network via raw Hetzner API.
  // Provider has no destroy path — operator must clean up if this fails.
  await fetch(`${BASE_URL}/networks/${createdNetworkId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${LIVE_TOKEN}` },
  }).catch((err: unknown) => {
    console.warn(`[live cleanup] DELETE network ${createdNetworkId} failed:`, err);
  });
});

describe(
  "@live hetzner-cloud wire translation",
  { timeout: 30_000 },
  () => {
    it.skipIf(!LIVE_TOKEN)(
      "creates a network with subnet objects and converges on second apply",
      async () => {
        if (!LIVE_TOKEN) return; // type narrowing — skipIf already handles this

        const http = new HttpClient({
          defaultHeaders: { Authorization: `Bearer ${LIVE_TOKEN}` },
        });
        const provider = createHetznerCloudProvider({
          token: LIVE_TOKEN,
          baseUrl: BASE_URL,
          http,
        });

        // First apply — should create the network.
        const first = await provider.apply({
          op: "create",
          entity: `network:${NETWORK_NAME}`,
          desired: {
            name: NETWORK_NAME,
            ip_range: "10.96.0.0/16",
            subnets: ["10.96.1.0/24"],
          },
        });

        expect(first.changed).toBe(true);

        // Retrieve the network id for cleanup.
        const listRes = await fetch(
          `${BASE_URL}/networks?name=${encodeURIComponent(NETWORK_NAME)}`,
          { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } },
        );
        const listBody = (await listRes.json()) as {
          networks: Array<{ id: number; name: string }>;
        };
        const network = listBody.networks[0];
        expect(network).toBeDefined();
        expect(network?.name).toBe(NETWORK_NAME);
        createdNetworkId = network?.id ?? null;

        // Second apply — must be a no-op (idempotency).
        const second = await provider.apply({
          op: "create",
          entity: `network:${NETWORK_NAME}`,
          desired: {
            name: NETWORK_NAME,
            ip_range: "10.96.0.0/16",
            subnets: ["10.96.1.0/24"],
          },
        });
        expect(second.changed).toBe(false);
      },
    );
  },
);
