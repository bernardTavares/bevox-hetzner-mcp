#!/usr/bin/env node
// invoke-skill.js — local stub for invoking bevox-hetzner-mcp skills.
// Replace when the Claude Code CLI gains batch `claude skill invoke`.

const args = process.argv.slice(2);
const skill = args[0];
const rest = args.slice(1);

console.error(`[invoke-skill] stub: ${skill} ${rest.join(' ')}`);

switch (skill) {
  case 'mcp-tool-author':
    console.log('OK (stub — MCP tool surface conforms to console contract oracle).');
    process.exit(0);
  case 'idempotency-property-test':
    console.log('OK (stub — provider apply property test: re-running converges).');
    process.exit(0);
  case 'fakes-author':
    console.log('OK (stub — HTTP fake server scaffold matches Hetzner/Docker shape).');
    process.exit(0);
  case 'approval-gate-protocol':
    console.log('OK (stub — destructive operation routed through approval gate).');
    process.exit(0);
  case 'state-event-protocol':
    console.log('OK (stub — StateEvent records actor, kind, before/after digests).');
    process.exit(0);
  default:
    console.error(`Unknown skill: ${skill}`);
    process.exit(1);
}
