# Autopilot Findings API

Autopilot findings are durable operational follow-ups. They are deliberately
separate from Takes, which represent proposed knowledge claims.

## States

- `open`: detected and eligible for repair
- `queued`: repair job submitted
- `repairing`: repair job active
- `blocked`: prerequisite or configuration prevents automatic repair
- `awaiting_approval`: operator judgment is required
- `escalated`: two repair attempts completed but the fresh detector still fails
- `resolved`: a fresh detector no longer observes the condition

## List

Operation: `autopilot_findings_list`

Scope: `admin`

Parameters:

- `state` optional lifecycle state
- `limit` optional, default 50 and maximum 200
- `offset` optional, default 0

The response contains `{ findings, total }`. Findings are ordered with
escalated and human-owned work first.

## Acknowledge

Operation: `autopilot_findings_acknowledge`

Scope: `admin`

Parameter: `id`

Acknowledgement records `acknowledged_at` and `acknowledged_by`. It never marks
the finding resolved. Resolution is reserved for a fresh detector pass.

## Thin-client behavior

Memory Stargraph and other thin clients should display the server-provided
state instead of inferring success from Minion job status. Clients may list and
acknowledge findings through the normal MCP/HTTP operation endpoint; they do
not need direct database access.
