/**
 * Proposal-review backend for Memory Stargraph Take Review.
 *
 * Covers the engine methods directly on PGLite so the hosted MCP operations
 * have a real persistence substrate: list/count/filter, idempotent accept,
 * reject/defer metadata, and bounded bulk actions.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let alicePageId: number;

async function insertProposal(row: {
  page_slug?: string;
  content_hash: string;
  claim_text: string;
  holder?: string;
  status?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, wave_version,
       proposal_run_id, status, claim_text, kind, holder, weight, domain,
       model_id
     ) VALUES (
       'default', $1, $2, 'test-prompt', 'test-wave',
       'run-1', $3, $4, 'take', $5, 0.72, 'founder',
       'test-model'
     )
     RETURNING id`,
    [
      row.page_slug ?? 'people/alice-example',
      row.content_hash,
      row.status ?? 'pending',
      row.claim_text,
      row.holder ?? 'world',
    ],
  );
  return Number(rows[0].id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person',
    compiled_truth: 'Alice is building Acme.\n',
  });
  alicePageId = alice.id;
});

afterAll(async () => {
  await engine.disconnect();
});

describe('take proposal review engine', () => {
  test('lists pending proposals with counts and holder allow-list filtering', async () => {
    const worldId = await insertProposal({ content_hash: 'proposal-list-world', claim_text: 'Alice has strong founder-market fit.', holder: 'world' });
    await insertProposal({ content_hash: 'proposal-list-private', claim_text: 'Alice looked tired in office hours.', holder: 'brain' });
    await insertProposal({ content_hash: 'proposal-list-rejected', claim_text: 'Old rejected claim.', holder: 'world', status: 'rejected' });

    const result = await engine.listTakeProposals({
      status: 'pending',
      page_slug: 'people/alice-example',
      takesHoldersAllowList: ['world'],
      limit: 10,
    });

    expect(result.proposals.map(p => p.id)).toContain(worldId);
    expect(result.proposals.every(p => p.holder === 'world')).toBe(true);
    expect(result.proposals.every(p => p.source_exists === true)).toBe(true);
    expect(result.counts.pending).toBeGreaterThanOrEqual(1);
    expect(result.counts.rejected).toBeGreaterThanOrEqual(1);
  });

  test('accept promotes one durable take and is idempotent on retry', async () => {
    const proposalId = await insertProposal({
      content_hash: 'proposal-accept',
      claim_text: 'Alice has unusually high customer urgency.',
      holder: 'world',
    });

    const first = await engine.acceptTakeProposal({ id: proposalId, actedBy: 'memory-stargraph-test' });
    const second = await engine.acceptTakeProposal({ id: proposalId, actedBy: 'memory-stargraph-test' });

    expect(first.proposal.status).toBe('accepted');
    expect(first.proposal.promoted_row_num).toBeGreaterThan(0);
    expect(second.proposal.promoted_row_num).toBe(first.proposal.promoted_row_num);

    const promoted = await engine.listTakes({ page_id: alicePageId, active: true, limit: 500 });
    const matches = promoted.filter(t => t.claim === 'Alice has unusually high customer urgency.');
    expect(matches).toHaveLength(1);
    expect(first.proposal.promoted_row_num).not.toBeNull();
    expect(matches[0].row_num).toBe(first.proposal.promoted_row_num!);
  });

  test('reject and defer update acted metadata without creating takes', async () => {
    const rejectId = await insertProposal({ content_hash: 'proposal-reject', claim_text: 'Reject this claim.', holder: 'world' });
    const deferId = await insertProposal({ content_hash: 'proposal-defer', claim_text: 'Defer this claim.', holder: 'world' });

    const rejected = await engine.rejectTakeProposal({ id: rejectId, actedBy: 'reviewer-a' });
    const deferred = await engine.deferTakeProposal({ id: deferId, actedBy: 'reviewer-b' });

    expect(rejected.proposal.status).toBe('rejected');
    expect(rejected.proposal.acted_by).toBe('reviewer-a');
    expect(rejected.take).toBeNull();
    expect(deferred.proposal.status).toBe('deferred');
    expect(deferred.proposal.acted_by).toBe('reviewer-b');
    expect(deferred.take).toBeNull();
  });

  test('bulk actions are bounded and return per-id results', async () => {
    const a = await insertProposal({ content_hash: 'proposal-bulk-a', claim_text: 'Bulk reject A.', holder: 'world' });
    const b = await insertProposal({ content_hash: 'proposal-bulk-b', claim_text: 'Bulk reject B.', holder: 'world' });

    const bulk = await engine.bulkTakeProposalAction({
      ids: [a, b],
      action: 'reject',
      actedBy: 'bulk-reviewer',
      limit: 10,
    });

    expect(bulk.results).toHaveLength(2);
    expect(bulk.results.every(r => r.ok && r.proposal?.status === 'rejected')).toBe(true);
  });
});
