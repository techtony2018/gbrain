import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { MinionJobStatus } from './minions/types.ts';
import type { MinionJob, MinionJobInput } from './minions/types.ts';
import { canonicalJson } from './remediation-step.ts';
import type { RemediationStep } from './remediation-step.ts';

export type AutopilotFindingAuthority = 'remediable' | 'blocked' | 'human_only';
export type AutopilotFindingState =
  | 'open'
  | 'queued'
  | 'repairing'
  | 'blocked'
  | 'awaiting_approval'
  | 'escalated'
  | 'resolved';

export interface AutopilotFindingObservation {
  check: string;
  sourceId?: string;
  authority: AutopilotFindingAuthority;
  severity: 'critical' | 'high' | 'medium' | 'low';
  rationale: string;
  evidence?: Record<string, unknown>;
  recommendedAction?: string;
  owner?: string;
  job?: {
    name: string;
    params: Record<string, unknown>;
    idempotencyKey: string;
    protected?: boolean;
  };
}

export const AUTOPILOT_FINDING_CHECKS_IN_SCOPE = [
  'sync.repo',
  'embed.stale',
  'backlinks.fix',
  'extract.all',
  'onboard.embed_catch_up',
  'onboard.extract_ner_links',
  'onboard.extract_timeline_from_meetings',
  'onboard.takes_bootstrap',
  'brain_score',
  'sync_freshness',
  'missing_embeddings',
  'dead_links',
  'orphan_pages',
] as const;

export function buildAutopilotFindingObservations(input: {
  recommendations: RemediationStep[];
  blocked: Array<{ check: string; reason: string }>;
  orphanPages: number;
}): AutopilotFindingObservation[] {
  const observations: AutopilotFindingObservation[] = input.recommendations.map((step) => ({
    check: step.id,
    authority: 'remediable',
    severity: step.severity,
    rationale: step.rationale,
    evidence: {
      est_seconds: step.est_seconds,
      est_usd_cost: step.est_usd_cost ?? 0,
      depends_on: step.depends_on ?? [],
    },
    recommendedAction: `${step.job} ${canonicalJson(step.params)}`,
    owner: 'gbrain-autopilot',
    job: {
      name: step.job,
      params: step.params,
      idempotencyKey: step.idempotency_key,
      protected: step.protected,
    },
  }));

  for (const blocked of input.blocked) {
    observations.push({
      check: blocked.check,
      authority: 'blocked',
      severity: 'high',
      rationale: blocked.reason,
      evidence: { blocked_reason: blocked.reason },
      recommendedAction: blocked.reason,
      owner: 'gbrain-sre',
    });
  }

  if (input.orphanPages > 0) {
    observations.push({
      check: 'orphan_pages',
      authority: 'human_only',
      severity: 'medium',
      rationale: `${input.orphanPages} linkable page${input.orphanPages === 1 ? '' : 's'} require archive or relationship judgment`,
      evidence: { orphan_pages: input.orphanPages },
      recommendedAction: 'Review each orphan before archiving or linking it',
      owner: 'product-owner',
    });
  }

  return observations;
}

export interface AutopilotFindingRow {
  id: number;
  fingerprint: string;
  check_name: string;
  source_id: string;
  authority: AutopilotFindingAuthority;
  state: AutopilotFindingState;
  severity: string;
  rationale: string;
  evidence: Record<string, unknown>;
  recommended_action: string | null;
  owner: string | null;
  job_id: number | null;
  repair_attempts: number;
  postcondition_failures: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  updated_at: string;
}

export function findingFingerprint(input: {
  check: string;
  sourceId?: string;
  identity?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}): string {
  const stableIdentity = {
    check: input.check,
    source_id: input.sourceId ?? 'default',
    identity: input.identity ?? {},
  };
  return createHash('sha256').update(canonicalJson(stableIdentity)).digest('hex');
}

export function initialFindingState(authority: AutopilotFindingAuthority): AutopilotFindingState {
  if (authority === 'blocked') return 'blocked';
  if (authority === 'human_only') return 'awaiting_approval';
  return 'open';
}

export function reconcileFindingState(input: {
  currentState: AutopilotFindingState;
  postconditionFailures: number;
  observed: boolean;
  jobStatus: MinionJobStatus | null;
}): {
  state: AutopilotFindingState;
  postconditionFailures: number;
  shouldRetry: boolean;
} {
  if (!input.observed) {
    return {
      state: 'resolved',
      postconditionFailures: input.postconditionFailures,
      shouldRetry: false,
    };
  }

  if (input.currentState === 'escalated') {
    return {
      state: 'escalated',
      postconditionFailures: input.postconditionFailures,
      shouldRetry: false,
    };
  }

  if (input.jobStatus === 'waiting' || input.jobStatus === 'delayed' || input.jobStatus === 'waiting-children') {
    return {
      state: 'queued',
      postconditionFailures: input.postconditionFailures,
      shouldRetry: false,
    };
  }

  if (input.jobStatus === 'active' || input.jobStatus === 'paused') {
    return {
      state: 'repairing',
      postconditionFailures: input.postconditionFailures,
      shouldRetry: false,
    };
  }

  if (
    input.jobStatus === 'completed' ||
    input.jobStatus === 'failed' ||
    input.jobStatus === 'dead' ||
    input.jobStatus === 'cancelled'
  ) {
    const failures = input.postconditionFailures + 1;
    return {
      state: failures >= 2 ? 'escalated' : 'open',
      postconditionFailures: failures,
      shouldRetry: failures < 2,
    };
  }

  return {
    state: input.currentState,
    postconditionFailures: input.postconditionFailures,
    shouldRetry: false,
  };
}

function rowFromDb(row: Record<string, unknown>): AutopilotFindingRow {
  const evidence = typeof row.evidence === 'string'
    ? JSON.parse(row.evidence)
    : (row.evidence ?? {});
  return {
    ...row,
    id: Number(row.id),
    job_id: row.job_id === null || row.job_id === undefined ? null : Number(row.job_id),
    repair_attempts: Number(row.repair_attempts ?? 0),
    postcondition_failures: Number(row.postcondition_failures ?? 0),
    evidence,
  } as AutopilotFindingRow;
}

export async function listAutopilotFindings(
  engine: BrainEngine,
  opts: { state?: AutopilotFindingState; limit?: number; offset?: number } = {},
): Promise<{ findings: AutopilotFindingRow[]; total: number }> {
  const params: unknown[] = [];
  const where = opts.state ? 'WHERE state = $1' : '';
  if (opts.state) params.push(opts.state);
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  params.push(Math.max(1, Math.min(200, opts.limit ?? 50)), Math.max(0, opts.offset ?? 0));
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT *, count(*) OVER()::int AS total_count
       FROM autopilot_findings
       ${where}
      ORDER BY
        CASE state
          WHEN 'escalated' THEN 0
          WHEN 'awaiting_approval' THEN 1
          WHEN 'blocked' THEN 2
          WHEN 'repairing' THEN 3
          WHEN 'queued' THEN 4
          WHEN 'open' THEN 5
          ELSE 6
        END,
        updated_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );
  return {
    findings: rows.map(rowFromDb),
    total: Number(rows[0]?.total_count ?? 0),
  };
}

export async function acknowledgeAutopilotFinding(
  engine: BrainEngine,
  id: number,
  actor: string,
): Promise<AutopilotFindingRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE autopilot_findings
        SET acknowledged_at = now(), acknowledged_by = $2, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, actor],
  );
  return rows[0] ? rowFromDb(rows[0]) : null;
}

export async function upsertAutopilotFinding(
  engine: BrainEngine,
  observation: AutopilotFindingObservation,
): Promise<AutopilotFindingRow> {
  const sourceId = observation.sourceId ?? 'default';
  const fingerprint = findingFingerprint({
    check: observation.check,
    sourceId,
    identity: observation.job
      ? { name: observation.job.name, params: observation.job.params }
      : undefined,
  });
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO autopilot_findings (
        fingerprint, check_name, source_id, authority, state, severity,
        rationale, evidence, recommended_action, owner
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      ON CONFLICT (fingerprint) DO UPDATE SET
        authority = EXCLUDED.authority,
        state = CASE
          WHEN autopilot_findings.state = 'resolved' THEN EXCLUDED.state
          ELSE autopilot_findings.state
        END,
        severity = EXCLUDED.severity,
        rationale = EXCLUDED.rationale,
        evidence = EXCLUDED.evidence,
        recommended_action = EXCLUDED.recommended_action,
        owner = COALESCE(EXCLUDED.owner, autopilot_findings.owner),
        last_seen_at = now(),
        resolved_at = NULL,
        updated_at = now()
      RETURNING *`,
    [
      fingerprint,
      observation.check,
      sourceId,
      observation.authority,
      initialFindingState(observation.authority),
      observation.severity,
      observation.rationale,
      JSON.stringify(observation.evidence ?? {}),
      observation.recommendedAction ?? null,
      observation.owner ?? null,
    ],
  );
  return rowFromDb(rows[0]);
}

export async function resolveUnobservedAutopilotFindings(
  engine: BrainEngine,
  observedFingerprints: string[],
  checksInScope: string[],
): Promise<number> {
  if (checksInScope.length === 0) return 0;
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE autopilot_findings
        SET state = 'resolved', resolved_at = now(), job_id = NULL, updated_at = now()
      WHERE state <> 'resolved'
        AND check_name = ANY($1::text[])
        AND NOT (fingerprint = ANY($2::text[]))
      RETURNING id`,
    [checksInScope, observedFingerprints],
  );
  return rows.length;
}

export interface AutopilotFindingQueue {
  add(
    name: string,
    data?: Record<string, unknown>,
    opts?: Omit<MinionJobInput, 'name' | 'data'>,
    internal?: { allowProtectedSubmit?: boolean },
  ): Promise<MinionJob>;
  getJob(id: number): Promise<MinionJob | null>;
}

async function updateFindingLifecycle(
  engine: BrainEngine,
  id: number,
  patch: {
    state: AutopilotFindingState;
    jobId?: number | null;
    repairAttempts?: number;
    postconditionFailures?: number;
  },
): Promise<void> {
  await engine.executeRaw(
    `UPDATE autopilot_findings
        SET state = $2,
            job_id = COALESCE($3, job_id),
            repair_attempts = COALESCE($4, repair_attempts),
            postcondition_failures = COALESCE($5, postcondition_failures),
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      patch.state,
      patch.jobId ?? null,
      patch.repairAttempts ?? null,
      patch.postconditionFailures ?? null,
    ],
  );
}

async function dispatchFindingRepair(
  engine: BrainEngine,
  row: AutopilotFindingRow,
  observation: AutopilotFindingObservation,
  queue: AutopilotFindingQueue,
  timeoutMs?: number,
): Promise<void> {
  if (!observation.job) return;
  const nextAttempt = row.repair_attempts + 1;
  const retrySuffix = nextAttempt > 1 ? `:followup:${nextAttempt}` : '';
  const job = await queue.add(
    observation.job.name,
    observation.job.params,
    {
      queue: 'default',
      idempotency_key: `${observation.job.idempotencyKey}${retrySuffix}`,
      max_attempts: 2,
      maxWaiting: 1,
      timeout_ms: timeoutMs,
    },
    observation.job.protected ? { allowProtectedSubmit: true } : undefined,
  );
  await updateFindingLifecycle(engine, row.id, {
    state: job.status === 'active' ? 'repairing' : 'queued',
    jobId: job.id,
    repairAttempts: nextAttempt,
  });
}

/**
 * Reconcile one fresh detector pass with the durable follow-up ledger.
 *
 * A completed Minion job is only execution evidence. The fresh observation
 * set is the postcondition: if the finding still appears, retry once and then
 * escalate; if it disappears, resolve it. Blocked and human-only findings are
 * persisted but never auto-dispatched.
 */
export async function reconcileAutopilotFindings(
  engine: BrainEngine,
  observations: AutopilotFindingObservation[],
  checksInScope: string[],
  queue: AutopilotFindingQueue,
  opts: { dispatchRemediable?: boolean; timeoutMs?: number } = {},
): Promise<{ observed: number; resolved: number; dispatched: number; escalated: number }> {
  const dispatchRemediable = opts.dispatchRemediable !== false;
  const observedFingerprints: string[] = [];
  let dispatched = 0;
  let escalated = 0;

  for (const observation of observations) {
    const fingerprint = findingFingerprint({
      check: observation.check,
      sourceId: observation.sourceId,
      identity: observation.job
        ? { name: observation.job.name, params: observation.job.params }
        : undefined,
    });
    observedFingerprints.push(fingerprint);
    let row = await upsertAutopilotFinding(engine, observation);

    if (observation.authority !== 'remediable' || !observation.job) continue;
    if (row.state === 'escalated') {
      escalated++;
      continue;
    }

    if (row.job_id !== null) {
      const job = await queue.getJob(row.job_id);
      const decision = reconcileFindingState({
        currentState: row.state,
        postconditionFailures: row.postcondition_failures,
        observed: true,
        jobStatus: job?.status ?? null,
      });
      await updateFindingLifecycle(engine, row.id, {
        state: decision.state,
        postconditionFailures: decision.postconditionFailures,
      });
      row = {
        ...row,
        state: decision.state,
        postcondition_failures: decision.postconditionFailures,
      };
      if (decision.state === 'escalated') {
        escalated++;
        continue;
      }
      if (!decision.shouldRetry) continue;
    }

    if (dispatchRemediable && (row.job_id === null || row.state === 'open')) {
      await dispatchFindingRepair(engine, row, observation, queue, opts.timeoutMs);
      dispatched++;
    }
  }

  const resolved = await resolveUnobservedAutopilotFindings(
    engine,
    observedFingerprints,
    checksInScope,
  );
  return { observed: observations.length, resolved, dispatched, escalated };
}
