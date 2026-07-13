/**
 * MCP dispatch coverage for hosted Take Review proposal operations.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let proposalId: number;

function parseResult(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person',
    compiled_truth: 'Alice is building Acme.\n',
  });
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, wave_version,
       proposal_run_id, status, claim_text, kind, holder, weight, domain,
       model_id
     ) VALUES (
       'default', 'people/alice-example', 'mcp-proposal', 'test-prompt',
       'test-wave', 'run-mcp', 'pending',
       'Alice has a crisp wedge.', 'take', 'world', 0.81, 'founder',
       'test-model'
     )
     RETURNING id`,
  );
  proposalId = Number(rows[0].id);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('take proposal MCP operations', () => {
  test('operations are exposed through the shared operation catalog', () => {
    const names = operations.map(op => op.name);
    expect(names).toContain('take_proposals_list');
    expect(names).toContain('take_proposals_accept');
    expect(names).toContain('take_proposals_reject');
    expect(names).toContain('take_proposals_defer');
    expect(names).toContain('take_proposals_bulk');
  });

  test('take_proposals_list dispatches and returns bounded proposals', async () => {
    const result = await dispatchToolCall(engine, 'take_proposals_list', {
      page_slug: 'people/alice-example',
      status: 'pending',
      limit: 5,
    }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });

    const payload = parseResult(result);
    expect(payload.proposals.some((p: { id: number }) => p.id === proposalId)).toBe(true);
    expect(payload.proposals.every((p: { holder: string }) => p.holder === 'world')).toBe(true);
    expect(payload.counts.pending).toBeGreaterThanOrEqual(1);
  });

  test('take_proposals_accept dispatch promotes the proposal once', async () => {
    const result = await dispatchToolCall(engine, 'take_proposals_accept', {
      id: proposalId,
      acted_by: 'mcp-reviewer',
    }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });

    const payload = parseResult(result);
    expect(payload.proposal.status).toBe('accepted');
    expect(payload.proposal.promoted_row_num).toBeGreaterThan(0);
    expect(payload.take.claim).toBe('Alice has a crisp wedge.');
  });
});
