/**
 * Central resolver feedback loop persistence.
 *
 * These tests cover the hosted-GBrain contract Memory Stargraph proxies:
 * privacy-safe idempotent event ingestion, proposal learning, human-controlled
 * apply/distribution, backup/restore, and the dream-cycle phase.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;

function parseResult(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

async function call(name: string, params: Record<string, unknown> = {}): Promise<any> {
  return parseResult(await dispatchToolCall(engine, name, params, { remote: true }));
}

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterEach(async () => {
  await engine.disconnect();
});

describe('resolver feedback MCP operations', () => {
  test('operation catalog exposes the central resolver feedback contract', () => {
    const names = operations.map(op => op.name);
    expect(names).toContain('resolver_events_submit');
    expect(names).toContain('resolver_events_list');
    expect(names).toContain('resolver_proposals_generate');
    expect(names).toContain('resolver_proposals_update');
    expect(names).toContain('resolver_releases_apply');
    expect(names).toContain('resolver_releases_rollback');
    expect(names).toContain('resolver_impact_measure');
    expect(names).toContain('resolver_feedback_backup');
    expect(names).toContain('resolver_feedback_restore');
    expect(names).toContain('resolver_feedback_health');
  });

  test('event submission is idempotent and strips secrets and raw prompts', async () => {
    const first = await call('resolver_events_submit', {
      event_id: 'codex-test-001',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'Use the tax filing skill for an ERFA Form 8872 question. api_key=secret',
      raw_prompt: 'This private prompt must never be stored.',
      hidden_reasoning: 'do not store this',
      candidate_resolvers: ['file-irs-form-8872', 'general-search'],
      selected_route: 'file-irs-form-8872',
      outcome: 'fallback',
      correction_signal: 'manual_override',
      related_node_slug: 'organizations/erfapac/reporting-and-tax-filing-requirements',
    });
    const second = await call('resolver_events_submit', {
      event_id: 'codex-test-001',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'retry should deduplicate',
      selected_route: 'general-search',
      outcome: 'success',
    });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.event.intent_summary).toBe(first.event.intent_summary);

    const listed = await call('resolver_events_list', { producer: 'codex', limit: 10 });
    expect(listed.events).toHaveLength(1);
    expect(JSON.stringify(listed.events[0])).not.toContain('private prompt');
    expect(JSON.stringify(listed.events[0])).not.toContain('hidden_reasoning');
    expect(JSON.stringify(listed.events[0])).not.toContain('secret');
  });

  test('resolver learning creates evidence-backed pending proposals but never applies them', async () => {
    for (const producer of ['codex', 'openclaw']) {
      await call('resolver_events_submit', {
        event_id: `${producer}-manual-skill-${Date.now()}`,
        producer,
        resolver_version: 'resolver-v1',
        intent_summary: 'manual skill override for taichi practice recommendations',
        candidate_resolvers: ['general-search'],
        selected_route: 'general-search',
        outcome: 'fallback',
        correction_signal: 'manual_override',
      });
    }

    const generated = await call('resolver_proposals_generate', {
      min_evidence: 2,
      dry_run: false,
      run_source: 'unit-test',
    });

    expect(generated.created).toBe(1);
    expect(generated.auto_applied).toBe(0);
    expect(generated.dream_run.status).toBe('completed');

    const listed = await call('resolver_proposals_list', { status: 'pending' });
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0].status).toBe('pending');
    expect(listed.proposals[0].evidence_count).toBe(2);
  });

  test('approved proposal is versioned, distributed, and rollback records evidence', async () => {
    await call('resolver_events_submit', {
      event_id: 'codex-rollback-1',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for rollback fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    await call('resolver_events_submit', {
      event_id: 'openclaw-rollback-1',
      producer: 'openclaw',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for rollback fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    const generated = await call('resolver_proposals_generate', { min_evidence: 2 });
    const proposalId = generated.proposals[0].id;
    await call('resolver_proposals_update', { proposal_id: proposalId, action: 'accept', reason: 'fixture approved' });

    const applied = await call('resolver_releases_apply', {
      proposal_id: proposalId,
      approved_by: 'unit-test',
      environments: ['codex', 'openclaw'],
    });

    expect(applied.release.version).toMatch(/^resolver-\d{8}T/);
    expect(applied.release.active).toBe(true);
    expect(applied.distribution.map((row: { environment: string }) => row.environment).sort()).toEqual(['codex', 'openclaw']);

    const rolledBack = await call('resolver_releases_rollback', {
      version: applied.release.version,
      reason: 'fixture rollback',
    });
    expect(rolledBack.release.active).toBe(false);
    expect(rolledBack.release.rollback_reason).toBe('fixture rollback');
  });

  test('backup and restore preserve events, proposals, dream runs, and releases', async () => {
    await call('resolver_events_submit', {
      event_id: 'backup-event-1',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for backup fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    await call('resolver_events_submit', {
      event_id: 'backup-event-2',
      producer: 'openclaw',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for backup fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    const generated = await call('resolver_proposals_generate', { min_evidence: 2 });
    await call('resolver_proposals_update', { proposal_id: generated.proposals[0].id, action: 'accept', reason: 'backup restore approval' });
    await call('resolver_releases_apply', {
      proposal_id: generated.proposals[0].id,
      approved_by: 'unit-test',
      environments: ['codex', 'openclaw'],
    });
    const backup = await call('resolver_feedback_backup', {});

    await engine.executeRaw('DELETE FROM resolver_release_distribution');
    await engine.executeRaw('DELETE FROM resolver_releases');
    await engine.executeRaw('DELETE FROM resolver_proposal_evidence');
    await engine.executeRaw('DELETE FROM resolver_proposals');
    await engine.executeRaw('DELETE FROM resolver_dream_runs');
    await engine.executeRaw('DELETE FROM resolver_events');

    const restored = await call('resolver_feedback_restore', { backup });
    const health = await call('resolver_feedback_health', {});

    expect(restored.restored.events).toBe(2);
    expect(restored.restored.proposals).toBe(1);
    expect(restored.restored.dream_runs).toBe(1);
    expect(restored.restored.releases).toBe(1);
    expect(restored.restored.distribution).toBe(2);
    expect(health.events_24h).toBe(2);
    expect(health.proposal_counts.applied).toBe(1);
  });

  test('impact measurement records post-release outcome evidence', async () => {
    await call('resolver_events_submit', {
      event_id: 'impact-event-1',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for impact fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    await call('resolver_events_submit', {
      event_id: 'impact-event-2',
      producer: 'openclaw',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for impact fixture',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    const generated = await call('resolver_proposals_generate', { min_evidence: 2 });
    const proposalId = generated.proposals[0].id;
    await call('resolver_proposals_update', { proposal_id: proposalId, action: 'accept', reason: 'impact fixture approval' });
    const applied = await call('resolver_releases_apply', { proposal_id: proposalId, approved_by: 'unit-test' });
    await call('resolver_events_submit', {
      event_id: 'impact-success-1',
      producer: 'codex',
      resolver_version: applied.release.version,
      intent_summary: 'manual skill override for impact fixture',
      selected_route: 'learned-route',
      outcome: 'success',
    });

    const measured = await call('resolver_impact_measure', { proposal_id: proposalId });

    expect(measured.impact.before.event_count).toBe(2);
    expect(measured.impact.after.success).toBe(1);
    expect(measured.proposal.impact.measurement.resolver_version).toBe(applied.release.version);
  });
});

describe('resolver_learning dream phase', () => {
  test('runCycle resolver_learning records a durable non-applying run summary', async () => {
    await call('resolver_events_submit', {
      event_id: 'cycle-codex-1',
      producer: 'codex',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for dream phase',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });
    await call('resolver_events_submit', {
      event_id: 'cycle-openclaw-1',
      producer: 'openclaw',
      resolver_version: 'resolver-v1',
      intent_summary: 'manual skill override for dream phase',
      selected_route: 'general-search',
      outcome: 'fallback',
      correction_signal: 'manual_override',
    });

    const report = await runCycle(engine, {
      brainDir: null,
      dryRun: false,
      pull: false,
      phases: ['resolver_learning' as never],
    });

    expect(report.status).toBe('clean');
    expect(report.phases[0].phase).toBe('resolver_learning');
    expect(report.phases[0].status).toBe('ok');
    expect(report.phases[0].details?.auto_applied).toBe(0);

    const health = await call('resolver_feedback_health', {});
    expect(health.last_dream_run.status).toBe('completed');
    expect(health.proposal_counts.pending).toBe(1);
  });
});
