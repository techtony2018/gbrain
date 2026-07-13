# Take Proposal Review APIs

Memory Stargraph Take Review uses hosted GBrain operations to review rows from
the `take_proposals` table without SSH access to the brain host.

## Operations

- `take_proposals_list`: read-scope list with `id`, `status`, `page_slug`,
  `holder`, `search`, `limit`, and `offset` filters. Returns `{ proposals,
  counts, limit, offset }`.
- `take_proposals_accept`: write-scope action. Promotes a pending proposal into
  one active `takes` row and marks the proposal `accepted`.
- `take_proposals_reject`: write-scope action. Marks a pending proposal
  `rejected` without creating a take.
- `take_proposals_defer`: write-scope action. Marks a pending proposal
  `deferred` without creating a take.
- `take_proposals_bulk`: write-scope bounded batch over `accept`, `reject`, or
  `defer`.

All operations route through `sourceScopeOpts(ctx)` and
`ctx.takesHoldersAllowList`, matching `takes_list`/`takes_search` holder
privacy. `take_proposals_defer` requires schema version 123, which widens the
`take_proposals.status` check to include `deferred`.

## Implementation Diff

- `src/core/engine.ts`: adds `TakeProposal*` types and engine contract methods.
- `src/core/take-proposals.ts`: shared SQL implementation for list/actions/bulk.
- `src/core/pglite-engine.ts` and `src/core/postgres-engine.ts`: delegate to the
  shared implementation for parity.
- `src/core/operations.ts`: exposes the five MCP operations.
- `src/core/migrate.ts`, `src/schema.sql`, `src/core/pglite-schema.ts`, and
  `src/core/schema-embedded.ts`: add schema support for `deferred`.
- `test/take-proposals.test.ts`: PGLite engine coverage for list/counts,
  accept idempotency, reject/defer metadata, and bulk actions.
- `test/take-proposals-mcp.serial.test.ts`: shared operation catalog and MCP
  dispatch coverage.

## Verification Commands

```bash
bun test test/take-proposals.test.ts test/take-proposals-mcp.serial.test.ts
bun run src/cli.ts --tools-json | rg "take_proposals_(list|accept|reject|defer|bulk)"
```

`bun run typecheck` currently fails on pre-existing local branch issues unrelated
to these APIs: `formatResult` is not exported from `src/cli.ts`,
`formatFileSizeKb` is not exported from `src/commands/files.ts`, and
`resolveRequestedScope` / `resolveCodeIntelScope` are not exported from
`src/core/operations.ts`.
