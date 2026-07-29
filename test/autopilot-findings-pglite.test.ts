import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  acknowledgeAutopilotFinding,
  reconcileAutopilotFindings,
  findingFingerprint,
  listAutopilotFindings,
  resolveUnobservedAutopilotFindings,
  upsertAutopilotFinding,
} from '../src/core/autopilot-findings.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
}, 30000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
}, 30000);

describe('autopilot findings ledger', () => {
  test('deduplicates repeat observations and preserves first seen identity', async () => {
    const first = await upsertAutopilotFinding(engine, {
      check: 'sync.repo',
      authority: 'remediable',
      severity: 'high',
      rationale: '4 stale pages',
      evidence: { stale_pages: 4 },
      job: {
        name: 'sync',
        params: { repoPath: '/brain' },
        idempotencyKey: 'default:sync:abc',
      },
    });
    const repeated = await upsertAutopilotFinding(engine, {
      check: 'sync.repo',
      authority: 'remediable',
      severity: 'medium',
      rationale: '2 stale pages',
      evidence: { stale_pages: 2 },
      job: {
        name: 'sync',
        params: { repoPath: '/brain' },
        idempotencyKey: 'default:sync:abc',
      },
    });

    expect(repeated.id).toBe(first.id);
    expect(repeated.rationale).toBe('2 stale pages');
    expect(repeated.evidence).toEqual({ stale_pages: 2 });
    expect((await listAutopilotFindings(engine)).total).toBe(1);
  });

  test('routes blocked and human-owned observations into visible states', async () => {
    await upsertAutopilotFinding(engine, {
      check: 'sync_freshness',
      authority: 'blocked',
      severity: 'high',
      rationale: 'no repo configured',
      owner: 'gbrain-sre',
    });
    await upsertAutopilotFinding(engine, {
      check: 'orphan_pages',
      authority: 'human_only',
      severity: 'medium',
      rationale: 'archive decision requires review',
      owner: 'product-owner',
    });

    expect((await listAutopilotFindings(engine, { state: 'blocked' })).total).toBe(1);
    expect((await listAutopilotFindings(engine, { state: 'awaiting_approval' })).total).toBe(1);
  });

  test('acknowledges human-owned follow-ups without resolving them', async () => {
    const finding = await upsertAutopilotFinding(engine, {
      check: 'orphan_pages',
      authority: 'human_only',
      severity: 'medium',
      rationale: 'review required',
    });

    const acknowledged = await acknowledgeAutopilotFinding(engine, finding.id, 'tony');

    expect(acknowledged?.state).toBe('awaiting_approval');
    expect(acknowledged?.acknowledged_by).toBe('tony');
    expect(acknowledged?.acknowledged_at).not.toBeNull();
  });

  test('resolves only in-scope findings absent from a fresh observation set', async () => {
    await upsertAutopilotFinding(engine, {
      check: 'sync.repo',
      authority: 'remediable',
      severity: 'high',
      rationale: 'stale',
      job: {
        name: 'sync',
        params: { repoPath: '/brain' },
        idempotencyKey: 'default:sync:abc',
      },
    });
    await upsertAutopilotFinding(engine, {
      check: 'orphan_pages',
      authority: 'human_only',
      severity: 'medium',
      rationale: 'review required',
    });

    const observedOrphan = findingFingerprint({
      check: 'orphan_pages',
      sourceId: 'default',
    });
    const resolved = await resolveUnobservedAutopilotFindings(
      engine,
      [observedOrphan],
      ['sync.repo'],
    );

    expect(resolved).toBe(1);
    expect((await listAutopilotFindings(engine, { state: 'resolved' })).total).toBe(1);
    expect((await listAutopilotFindings(engine, { state: 'awaiting_approval' })).total).toBe(1);
  });

  test('retries a completed repair once, then escalates when the detector still fires', async () => {
    const queue = new MinionQueue(engine);
    const observation = {
      check: 'sync.repo',
      authority: 'remediable' as const,
      severity: 'high' as const,
      rationale: 'stale pages',
      job: {
        name: 'sync',
        params: { repoPath: '/brain' },
        idempotencyKey: 'default:sync:abc',
      },
    };

    await reconcileAutopilotFindings(engine, [observation], ['sync.repo'], queue);
    let row = (await listAutopilotFindings(engine)).findings[0];
    expect(row.state).toBe('queued');
    expect(row.repair_attempts).toBe(1);

    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [row.job_id],
    );
    await reconcileAutopilotFindings(engine, [observation], ['sync.repo'], queue);
    row = (await listAutopilotFindings(engine)).findings[0];
    expect(row.state).toBe('queued');
    expect(row.postcondition_failures).toBe(1);
    expect(row.repair_attempts).toBe(2);

    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [row.job_id],
    );
    await reconcileAutopilotFindings(engine, [observation], ['sync.repo'], queue);
    row = (await listAutopilotFindings(engine)).findings[0];
    expect(row.state).toBe('escalated');
    expect(row.postcondition_failures).toBe(2);
    expect(row.repair_attempts).toBe(2);

    await reconcileAutopilotFindings(engine, [], ['sync.repo'], queue);
    row = (await listAutopilotFindings(engine)).findings[0];
    expect(row.state).toBe('resolved');
  });

  test('exposes list and acknowledgement operations to thin clients', async () => {
    const finding = await upsertAutopilotFinding(engine, {
      check: 'sync_freshness',
      authority: 'blocked',
      severity: 'high',
      rationale: 'no repo configured',
    });
    const ctx = {
      engine,
      remote: true,
      sourceId: 'default',
      dryRun: false,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      auth: { clientName: 'stargraph', token: 'test', clientId: 'test', scopes: ['admin'] },
    } as unknown as OperationContext;

    expect(operationsByName.autopilot_findings_list.scope).toBe('admin');
    expect(operationsByName.autopilot_findings_acknowledge.scope).toBe('admin');
    const listed = await operationsByName.autopilot_findings_list.handler(ctx, {});
    expect((listed as { total: number }).total).toBe(1);
    const acknowledged = await operationsByName.autopilot_findings_acknowledge.handler(ctx, {
      id: finding.id,
    });
    expect((acknowledged as { acknowledged_by: string }).acknowledged_by).toBe('stargraph');
  });
});
