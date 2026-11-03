---
name: fail-safe
glob: "core/src/providers/**/*.ts"
priority: 1
---

# Rule: fail-safe

Authoritative reference: `CONTRIBUTING.md` §"Ground rules" #3
("Fail-safe, never fail-deleting"), plus `CLAUDE.md` invariants
("fail-safe, nunca fail-deleting … sem rollback automático destrutivo;
drift reportado, nunca corrigido em silêncio").

## Invariant

No error path in any Provider may **DELETE** or **REMOVE** (or shut down,
detach, unmount, deregister, drop, truncate) a resource that the operator did
not explicitly request to remove via desired state.

- **Drift is reported, never silently corrected.** If observed state disagrees
  with desired state in a way that would imply a destroy/recreate, the
  Provider records a drift `StateEvent` and surfaces a finding via
  `get_state` / drift reports. The reconciler does **not** auto-destroy to
  reconcile.
- **No automatic destructive rollback.** A failed `apply()` does not "undo"
  partial work by deleting resources that were created. Partial state is left
  in place, recorded, and reconverged on the next idempotent cycle (which may
  reuse what already exists). Recovery is by re-running the reconciler.
- **Approval Gate gates destruction.** Any genuine destructive action
  requested via desired state still passes through the Approval Gate (see
  `.claude/skills/approval-gate-protocol/`). A Provider never bypasses the
  gate to "clean up" on its own initiative.

## Correct error handling

```ts
// Provider.apply() — Hetzner Cloud server creation fails midway.
async function apply(desired: Desired, ctx: ApplyContext): Promise<Applied> {
  const server = await hcloud.servers.create(desired.spec); // succeeds
  try {
    await hcloud.volumes.attach(server.id, desired.volumeId); // throws
  } catch (err) {
    // ✅ Record the failure. Do NOT delete the server.
    // The next reconcile cycle will observe { server: present, volume: detached }
    // and idempotently re-attempt the attach.
    throw new ProviderError("volume.attach failed; server left in place", {
      cause: err,
      observed: { serverId: server.id, attached: false },
    });
  }
  return { server };
}
```

```ts
// Drift detection — observed state has an extra server tag the operator did
// not declare.
function reconcileTags(desired: Tag[], observed: Tag[]): Plan {
  const extras = observed.filter(t => !desired.includes(t));
  if (extras.length > 0) {
    // ✅ Report drift. Do not silently delete the tags.
    return { driftReport: { kind: "extra-tags", values: extras } };
  }
  return { ops: [] };
}
```

## Forbidden patterns

```ts
// ❌ Destructive rollback inside catch{}.
try {
  await hcloud.volumes.attach(server.id, vol);
} catch (err) {
  await hcloud.servers.delete(server.id); // ❌ removes a resource the operator wanted.
  throw err;
}

// ❌ Silent drift correction.
const extras = observed.filter(t => !desired.includes(t));
for (const t of extras) await hcloud.tags.delete(t); // ❌ no Approval Gate, no event.

// ❌ "Cleanup" of resources that look unused.
if (server.attachedVolumes.length === 0) {
  await hcloud.servers.delete(server.id); // ❌ heuristic deletion is never allowed.
}

// ❌ Try/finally that destroys on any failure.
try { await applyChanges(); }
finally { if (!success) await rollbackByDeleting(); } // ❌
```

## Decision rule

When writing or reviewing a Provider error path, ask:

1. **Does this code path call a `delete` / `remove` / `destroy` / `detach`
   API?** If yes, is it because the desired state explicitly said so AND the
   Approval Gate has approved it? If not — remove the call.
2. **Is this code "fixing" observed state to look like desired state by
   removing something?** That is drift correction. Report it; do not act.
3. **Is this code "undoing" a partial apply by deleting what was just
   created?** That is destructive rollback. Do not do it. Record the partial
   state and let the next reconcile cycle converge.

## Enforcement

- Idempotency property tests (`core/src/reconciler/idempotency*.property.test.ts`)
  re-run the reconciler against partial-failure scenarios and assert that no
  resource the operator declared is destroyed by an error path.
- Code review: any new `delete` / `destroy` / `remove` call site in
  `core/src/providers/**` must be justified inline (the desired state asked
  for it AND the Approval Gate guards it).
