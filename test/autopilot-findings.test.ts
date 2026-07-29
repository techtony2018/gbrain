import { describe, expect, test } from 'bun:test';
import {
  buildAutopilotFindingObservations,
  findingFingerprint,
  initialFindingState,
  reconcileFindingState,
} from '../src/core/autopilot-findings.ts';

describe('autopilot finding lifecycle', () => {
  test('fingerprints are stable across evidence key ordering', () => {
    const a = findingFingerprint({
      check: 'sync.repo',
      sourceId: 'default',
      evidence: { stale_pages: 4, repo: '/brain' },
    });
    const b = findingFingerprint({
      check: 'sync.repo',
      sourceId: 'default',
      evidence: { repo: '/brain', stale_pages: 4 },
    });

    expect(a).toBe(b);
  });

  test('routes findings by authority', () => {
    expect(initialFindingState('remediable')).toBe('open');
    expect(initialFindingState('blocked')).toBe('blocked');
    expect(initialFindingState('human_only')).toBe('awaiting_approval');
  });

  test('job completion does not resolve a finding while its postcondition still fails', () => {
    expect(reconcileFindingState({
      currentState: 'repairing',
      postconditionFailures: 0,
      observed: true,
      jobStatus: 'completed',
    })).toEqual({
      state: 'open',
      postconditionFailures: 1,
      shouldRetry: true,
    });
  });

  test('escalates after two completed repairs fail their postcondition', () => {
    expect(reconcileFindingState({
      currentState: 'repairing',
      postconditionFailures: 1,
      observed: true,
      jobStatus: 'completed',
    })).toEqual({
      state: 'escalated',
      postconditionFailures: 2,
      shouldRetry: false,
    });
  });

  test('resolves only after a fresh detector no longer observes the issue', () => {
    expect(reconcileFindingState({
      currentState: 'repairing',
      postconditionFailures: 1,
      observed: false,
      jobStatus: 'completed',
    })).toEqual({
      state: 'resolved',
      postconditionFailures: 1,
      shouldRetry: false,
    });
  });

  test('builds remediable, blocked, and human-owned observations from one detector pass', () => {
    const observations = buildAutopilotFindingObservations({
      recommendations: [{
        id: 'embed.stale',
        job: 'embed',
        params: { stale: true },
        idempotency_key: 'default:embed:abc',
        severity: 'critical',
        est_seconds: 20,
        rationale: 'chunks missing embeddings',
        status: 'remediable',
      }],
      blocked: [{ check: 'sync_freshness', reason: 'no repo configured' }],
      orphanPages: 3,
    });

    expect(observations.map((o) => [o.check, o.authority])).toEqual([
      ['embed.stale', 'remediable'],
      ['sync_freshness', 'blocked'],
      ['orphan_pages', 'human_only'],
    ]);
  });
});
