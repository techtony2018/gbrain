# Autopilot Follow-up Loop

Date: 2026-07-29

## Goal

Make every actionable autopilot detection durable and accountable. A Minion
job completing is execution evidence, not proof that the detected condition
was fixed.

## Lifecycle

1. A fresh autopilot detector pass emits remediable, blocked, and human-only
   observations.
2. Observations are deduplicated by a stable fingerprint and upserted into
   `autopilot_findings`.
3. Remediable observations are submitted to Minions and move through
   `open -> queued -> repairing`.
4. On the next detector pass, a completed job whose condition is still present
   is retried once with a new idempotency key.
5. A second completed repair whose condition remains present becomes
   `escalated`.
6. A finding becomes `resolved` only when a fresh in-scope detector pass no
   longer observes it.
7. Blocked findings are assigned to `gbrain-sre`; human-only findings enter
   `awaiting_approval` and are assigned to `product-owner`.
8. Acknowledgement records ownership without changing the finding's state.

## Interfaces

- `autopilot_findings_list`: admin-scoped read operation with state filtering
  and pagination.
- `autopilot_findings_acknowledge`: admin-scoped write operation. It records
  the authenticated client as the acknowledging actor and does not resolve the
  condition.

These operations are transport-neutral and therefore available through the
existing MCP/HTTP operation dispatcher to Memory Stargraph, OpenClaw, and other
thin clients.

## Safety

- The ledger is separate from `take_proposals`; operational incidents are not
  knowledge claims.
- Blocked and human-only findings never auto-dispatch jobs.
- Existing protected-job checks remain in force.
- Follow-up persistence fails open so a ledger problem cannot stop the
  pre-existing maintenance loop.
- Full-cycle fan-out remains the owner of large plans. The ledger records those
  conditions but does not submit duplicate targeted jobs.

## Verification

- Pure lifecycle tests cover stable fingerprinting, authority routing,
  postcondition verification, retry, escalation, and resolution.
- PGLite integration tests cover migration v126, deduplication, acknowledgement,
  pagination, real Minion job rows, one retry, escalation, and MCP operations.
- An autopilot wiring test pins the detector-to-ledger call before the dispatch
  branch.
