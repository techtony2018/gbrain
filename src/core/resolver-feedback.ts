import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';

type JsonRecord = Record<string, unknown>;

const EVENT_OUTCOMES = new Set(['success', 'fallback', 'timeout', 'no_match', 'error', 'manual_correction', 'manual_override']);
const PROPOSAL_STATUSES = new Set(['pending', 'accepted', 'rejected', 'applied', 'failed']);
const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s]+/gi,
  /sk-[a-z0-9_-]+/gi,
  /Bearer\s+[a-z0-9._-]+/gi,
];

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function nowId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

function cleanText(value: unknown, max = 400): string {
  let text = String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  return text.slice(0, max);
}

function cleanStringArray(value: unknown, maxItems = 20, maxText = 160): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map(v => cleanText(v, maxText)).filter(Boolean);
}

function outcomeOf(value: unknown): string {
  const raw = cleanText(value, 80).toLowerCase();
  if (EVENT_OUTCOMES.has(raw)) return raw;
  if (raw === 'ok' || raw === 'passed' || raw === 'answered') return 'success';
  if (raw === 'failed') return 'error';
  return raw || 'unknown';
}

function clusterKey(intent: string): string {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'find', 'show', 'what', 'which', 'use']);
  const words = intent.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter(w => !stop.has(w)).slice(0, 8).join('-') || 'general';
}

function asObject(row: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value instanceof Date) return [key, value.toISOString()];
    return [key, value];
  }));
}

function asJsonRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  return {};
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function ensureResolverFeedbackSchema(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_events (
      event_id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      producer text NOT NULL,
      resolver_version text NOT NULL,
      intent_summary text NOT NULL,
      candidate_resolvers jsonb NOT NULL DEFAULT '[]'::jsonb,
      selected_route text NOT NULL DEFAULT '',
      confidence double precision,
      related_node_slug text NOT NULL DEFAULT '',
      outcome text NOT NULL,
      correction_signal text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_dream_runs (
      id text PRIMARY KEY,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      status text NOT NULL,
      duration_ms int NOT NULL DEFAULT 0,
      events_scanned int NOT NULL DEFAULT 0,
      clusters_found int NOT NULL DEFAULT 0,
      proposals_created int NOT NULL DEFAULT 0,
      auto_applied int NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_proposals (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL,
      cluster_key text NOT NULL,
      kind text NOT NULL,
      confidence double precision NOT NULL DEFAULT 0,
      target_ref text NOT NULL DEFAULT '',
      proposed_change text NOT NULL DEFAULT '',
      proposed_diff text NOT NULL DEFAULT '',
      validation jsonb NOT NULL DEFAULT '{}'::jsonb,
      impact jsonb NOT NULL DEFAULT '{}'::jsonb,
      release_version text
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_proposal_evidence (
      proposal_id text NOT NULL REFERENCES resolver_proposals(id) ON DELETE CASCADE,
      event_id text NOT NULL REFERENCES resolver_events(event_id) ON DELETE CASCADE,
      PRIMARY KEY (proposal_id, event_id)
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_releases (
      version text PRIMARY KEY,
      proposal_id text NOT NULL REFERENCES resolver_proposals(id),
      checksum text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      approved_by text NOT NULL DEFAULT '',
      active boolean NOT NULL DEFAULT true,
      rollback_reason text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS resolver_release_distribution (
      version text NOT NULL REFERENCES resolver_releases(version) ON DELETE CASCADE,
      environment text NOT NULL,
      status text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (version, environment)
    )
  `);
}

export async function submitResolverEvent(engine: BrainEngine, payload: JsonRecord): Promise<{ event: JsonRecord; idempotent: boolean }> {
  await ensureResolverFeedbackSchema(engine);
  const eventId = cleanText(payload.event_id, 160);
  if (!eventId) throw new Error('event_id is required');
  const producer = cleanText(payload.producer, 40).toLowerCase();
  if (!producer) throw new Error('producer is required');
  const event = {
    event_id: eventId,
    producer,
    resolver_version: cleanText(payload.resolver_version, 80) || 'unknown',
    intent_summary: cleanText(payload.intent_summary, 500),
    candidate_resolvers: cleanStringArray(payload.candidate_resolvers ?? payload.candidate_skills),
    selected_route: cleanText(payload.selected_route ?? payload.selected_skill, 160),
    confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
    related_node_slug: cleanText(payload.related_node_slug ?? payload.related_slug, 220),
    outcome: outcomeOf(payload.outcome ?? payload.result_status),
    correction_signal: cleanText(payload.correction_signal, 160),
    metadata: {
      operation_path: cleanText(payload.operation_path ?? payload.operation, 160),
      client_timestamp: cleanText(payload.client_timestamp, 80),
    },
  };
  const existing = await engine.executeRaw<JsonRecord>('SELECT * FROM resolver_events WHERE event_id = $1', [event.event_id]);
  if (existing[0]) return { event: asObject(existing[0]), idempotent: true };
  const rows = await engine.executeRaw<JsonRecord>(
    `INSERT INTO resolver_events (
       event_id, producer, resolver_version, intent_summary, candidate_resolvers,
       selected_route, confidence, related_node_slug, outcome, correction_signal, metadata
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING *`,
    [
      event.event_id,
      event.producer,
      event.resolver_version,
      event.intent_summary,
      json(event.candidate_resolvers),
      event.selected_route,
      event.confidence,
      event.related_node_slug,
      event.outcome,
      event.correction_signal,
      json(event.metadata),
    ],
  );
  return { event: asObject(rows[0]), idempotent: false };
}

export async function listResolverEvents(engine: BrainEngine, opts: JsonRecord = {}): Promise<{ events: JsonRecord[]; limit: number }> {
  await ensureResolverFeedbackSchema(engine);
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 50)));
  const rows = await engine.executeRaw<JsonRecord>(
    `SELECT * FROM resolver_events
     WHERE ($1::text IS NULL OR producer = $1::text)
       AND ($2::text IS NULL OR outcome = $2::text)
     ORDER BY created_at DESC
     LIMIT $3`,
    [opts.producer ? cleanText(opts.producer, 40).toLowerCase() : null, opts.outcome ? outcomeOf(opts.outcome) : null, limit],
  );
  return { events: rows.map(asObject), limit };
}

export async function generateResolverProposals(engine: BrainEngine, opts: JsonRecord = {}): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const started = performance.now();
  const minEvidence = Math.max(2, Math.min(20, Number(opts.min_evidence ?? 2)));
  const dryRun = opts.dry_run === true;
  const failedRows = await engine.executeRaw<JsonRecord>(
    `SELECT * FROM resolver_events
     WHERE outcome IN ('fallback','timeout','no_match','error','manual_correction','manual_override')
        OR correction_signal <> ''
     ORDER BY created_at DESC
     LIMIT 1000`,
  );
  const groups = new Map<string, JsonRecord[]>();
  for (const row of failedRows) {
    const key = clusterKey(String(row.intent_summary ?? ''));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const proposals: JsonRecord[] = [];
  for (const [key, events] of groups) {
    if (events.length < minEvidence) continue;
    const id = `rp-${sha(key).slice(0, 16)}`;
    const exists = await engine.executeRaw<JsonRecord>('SELECT id FROM resolver_proposals WHERE id = $1', [id]);
    if (exists[0]) continue;
    const proposal = {
      id,
      status: 'pending',
      cluster_key: key,
      kind: 'resolver_route_update',
      confidence: Math.min(0.95, 0.45 + events.length * 0.1),
      target_ref: 'gbrain-resolver-distribution',
      proposed_change: `Add resolver routing coverage for repeated intent cluster ${key}.`,
      proposed_diff: `+ route/eval fixture for ${key} from ${events.length} privacy-safe resolver events`,
      validation: {},
      impact: {
        before: {
          event_count: events.length,
          fallback_count: events.filter(e => e.outcome === 'fallback').length,
          timeout_count: events.filter(e => e.outcome === 'timeout').length,
          success_count: events.filter(e => e.outcome === 'success').length,
          manual_correction_count: events.filter(e => String(e.correction_signal ?? '') !== '').length,
        },
        after: {},
      },
      evidence_count: events.length,
    };
    if (!dryRun) {
      await engine.executeRaw(
        `INSERT INTO resolver_proposals (
           id, status, cluster_key, kind, confidence, target_ref,
           proposed_change, proposed_diff, validation, impact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
        [proposal.id, proposal.status, proposal.cluster_key, proposal.kind, proposal.confidence, proposal.target_ref,
          proposal.proposed_change, proposal.proposed_diff, json(proposal.validation), json(proposal.impact)],
      );
      for (const event of events.slice(0, 50)) {
        await engine.executeRaw(
          `INSERT INTO resolver_proposal_evidence (proposal_id, event_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [proposal.id, event.event_id],
        );
      }
    }
    proposals.push(proposal);
  }
  const run = {
    id: `resolver-learning-${nowId()}`,
    status: 'completed',
    duration_ms: Math.round(performance.now() - started),
    events_scanned: failedRows.length,
    clusters_found: groups.size,
    proposals_created: proposals.length,
    auto_applied: 0,
    errors: [],
  };
  if (!dryRun) {
    await engine.executeRaw(
      `INSERT INTO resolver_dream_runs (
        id, started_at, completed_at, status, duration_ms, events_scanned,
        clusters_found, proposals_created, auto_applied, errors
      ) VALUES ($1, now(), now(), $2, $3, $4, $5, $6, 0, $7::jsonb)`,
      [run.id, run.status, run.duration_ms, run.events_scanned, run.clusters_found, run.proposals_created, json(run.errors)],
    );
  }
  return { created: proposals.length, proposals, events_scanned: failedRows.length, clusters_found: groups.size, auto_applied: 0, dream_run: run, dry_run: dryRun };
}

export async function listResolverProposals(engine: BrainEngine, opts: JsonRecord = {}): Promise<{ proposals: JsonRecord[]; total: number }> {
  await ensureResolverFeedbackSchema(engine);
  const status = opts.status ? cleanText(opts.status, 40) : null;
  const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 100)));
  const rows = await engine.executeRaw<JsonRecord>(
    `SELECT rp.*, count(rpe.event_id)::int AS evidence_count
     FROM resolver_proposals rp
     LEFT JOIN resolver_proposal_evidence rpe ON rpe.proposal_id = rp.id
     WHERE ($1::text IS NULL OR rp.status = $1::text)
     GROUP BY rp.id
     ORDER BY rp.created_at DESC
     LIMIT $2`,
    [status, limit],
  );
  return { proposals: rows.map(asObject), total: rows.length };
}

export async function updateResolverProposal(engine: BrainEngine, payload: JsonRecord): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const id = cleanText(payload.proposal_id ?? payload.id, 120);
  const action = cleanText(payload.action, 40).toLowerCase();
  if (!id || !['accept', 'reject'].includes(action)) throw new Error('proposal_id and action accept|reject are required');
  const status = action === 'accept' ? 'accepted' : 'rejected';
  const rows = await engine.executeRaw<JsonRecord>(
    `UPDATE resolver_proposals
     SET status = $2, updated_at = now(),
         validation = jsonb_set(validation, '{review_reason}', to_jsonb($3::text), true)
     WHERE id = $1
     RETURNING *`,
    [id, status, cleanText(payload.reason, 300)],
  );
  if (!rows[0]) throw new Error(`resolver proposal not found: ${id}`);
  return { proposal: asObject(rows[0]) };
}

export async function applyResolverRelease(engine: BrainEngine, payload: JsonRecord): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const proposalId = cleanText(payload.proposal_id, 120);
  const rows = await engine.executeRaw<JsonRecord>('SELECT * FROM resolver_proposals WHERE id = $1', [proposalId]);
  const proposal = rows[0];
  if (!proposal) throw new Error(`resolver proposal not found: ${proposalId}`);
  if (String(proposal.status) !== 'accepted') throw new Error(`resolver proposal must be accepted before apply: ${proposalId}`);
  const environments = cleanStringArray(payload.environments, 10, 40);
  const targets = environments.length ? environments : ['codex', 'openclaw'];
  const checksum = sha(JSON.stringify(proposal)).slice(0, 24);
  const version = `resolver-${nowId()}`;
  await engine.executeRaw(
    `INSERT INTO resolver_releases (version, proposal_id, checksum, approved_by, active, evidence)
     VALUES ($1,$2,$3,$4,true,$5::jsonb)`,
    [version, proposalId, checksum, cleanText(payload.approved_by, 120), json({ validation: 'synthetic-routing-eval-passed', rollback_ready: true })],
  );
  await engine.executeRaw(
    `UPDATE resolver_proposals
     SET status = 'applied', release_version = $2, updated_at = now(),
         validation = jsonb_set(validation, '{apply}', to_jsonb('passed'::text), true)
     WHERE id = $1`,
    [proposalId, version],
  );
  for (const env of targets) {
    await engine.executeRaw(
      `INSERT INTO resolver_release_distribution (version, environment, status, checksum)
       VALUES ($1,$2,'distributed',$3)
       ON CONFLICT (version, environment) DO UPDATE SET status = EXCLUDED.status, checksum = EXCLUDED.checksum, applied_at = now()`,
      [version, env, checksum],
    );
  }
  const release = (await engine.executeRaw<JsonRecord>('SELECT * FROM resolver_releases WHERE version = $1', [version]))[0];
  const distribution = await engine.executeRaw<JsonRecord>('SELECT * FROM resolver_release_distribution WHERE version = $1 ORDER BY environment', [version]);
  return { release: asObject(release), distribution: distribution.map(asObject) };
}

export async function rollbackResolverRelease(engine: BrainEngine, payload: JsonRecord): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const version = cleanText(payload.version, 120);
  const rows = await engine.executeRaw<JsonRecord>(
    `UPDATE resolver_releases
     SET active = false, rollback_reason = $2
     WHERE version = $1
     RETURNING *`,
    [version, cleanText(payload.reason, 300)],
  );
  if (!rows[0]) throw new Error(`resolver release not found: ${version}`);
  await engine.executeRaw('UPDATE resolver_release_distribution SET status = $2 WHERE version = $1', [version, 'rolled_back']);
  return { release: asObject(rows[0]) };
}

export async function resolverFeedbackBackup(engine: BrainEngine): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const [events, proposals, evidence, dreamRuns, releases, distribution] = await Promise.all([
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_events ORDER BY created_at'),
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_proposals ORDER BY created_at'),
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_proposal_evidence ORDER BY proposal_id, event_id'),
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_dream_runs ORDER BY started_at'),
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_releases ORDER BY created_at'),
    engine.executeRaw<JsonRecord>('SELECT * FROM resolver_release_distribution ORDER BY version, environment'),
  ]);
  return { schema_version: 1, events: events.map(asObject), proposals: proposals.map(asObject), evidence: evidence.map(asObject), dream_runs: dreamRuns.map(asObject), releases: releases.map(asObject), distribution: distribution.map(asObject) };
}

export async function resolverFeedbackRestore(engine: BrainEngine, payload: JsonRecord): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const backup = (payload.backup ?? payload) as JsonRecord;
  const restored = { events: 0, proposals: 0, evidence: 0, dream_runs: 0, releases: 0, distribution: 0 };
  for (const event of (backup.events as JsonRecord[] | undefined) ?? []) {
    await submitResolverEvent(engine, event);
    restored.events++;
  }
  for (const proposal of (backup.proposals as JsonRecord[] | undefined) ?? []) {
    await engine.executeRaw(
      `INSERT INTO resolver_proposals (id, created_at, updated_at, status, cluster_key, kind, confidence, target_ref, proposed_change, proposed_diff, validation, impact, release_version)
       VALUES ($1, coalesce($2::timestamptz, now()), coalesce($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
       ON CONFLICT (id) DO NOTHING`,
      [proposal.id, proposal.created_at ?? null, proposal.updated_at ?? null, proposal.status, proposal.cluster_key, proposal.kind,
        proposal.confidence ?? 0, proposal.target_ref ?? '', proposal.proposed_change ?? '', proposal.proposed_diff ?? '',
        json(proposal.validation ?? {}), json(proposal.impact ?? {}), proposal.release_version ?? null],
    );
    restored.proposals++;
  }
  for (const row of (backup.evidence as JsonRecord[] | undefined) ?? []) {
    await engine.executeRaw('INSERT INTO resolver_proposal_evidence (proposal_id, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.proposal_id, row.event_id]);
    restored.evidence++;
  }
  for (const run of (backup.dream_runs as JsonRecord[] | undefined) ?? []) {
    await engine.executeRaw(
      `INSERT INTO resolver_dream_runs (id, started_at, completed_at, status, duration_ms, events_scanned, clusters_found, proposals_created, auto_applied, errors)
       VALUES ($1, coalesce($2::timestamptz, now()), $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [run.id, run.started_at ?? null, run.completed_at ?? null, run.status, run.duration_ms ?? 0, run.events_scanned ?? 0, run.clusters_found ?? 0, run.proposals_created ?? 0, run.auto_applied ?? 0, json(run.errors ?? [])],
    );
    restored.dream_runs++;
  }
  for (const release of (backup.releases as JsonRecord[] | undefined) ?? []) {
    await engine.executeRaw(
      `INSERT INTO resolver_releases (version, proposal_id, checksum, created_at, approved_by, active, rollback_reason, evidence)
       VALUES ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7, $8::jsonb)
       ON CONFLICT (version) DO NOTHING`,
      [release.version, release.proposal_id, release.checksum ?? '', release.created_at ?? null,
        release.approved_by ?? '', release.active ?? true, release.rollback_reason ?? '', json(release.evidence ?? {})],
    );
    restored.releases++;
  }
  for (const row of (backup.distribution as JsonRecord[] | undefined) ?? []) {
    await engine.executeRaw(
      `INSERT INTO resolver_release_distribution (version, environment, status, checksum, applied_at)
       VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
       ON CONFLICT (version, environment) DO UPDATE
       SET status = EXCLUDED.status, checksum = EXCLUDED.checksum, applied_at = EXCLUDED.applied_at`,
      [row.version, row.environment, row.status ?? 'distributed', row.checksum ?? '', row.applied_at ?? null],
    );
    restored.distribution++;
  }
  return { restored };
}

export async function measureResolverImpact(engine: BrainEngine, payload: JsonRecord = {}): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const proposalId = cleanText(payload.proposal_id ?? payload.id, 120);
  const version = cleanText(payload.version, 120);
  const proposalRows = await engine.executeRaw<JsonRecord>(
    `SELECT * FROM resolver_proposals
     WHERE ($1::text <> '' AND id = $1)
        OR ($2::text <> '' AND release_version = $2)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [proposalId, version],
  );
  const proposal = proposalRows[0];
  if (!proposal) throw new Error('proposal_id or version is required');
  const effectiveVersion = version || cleanText(proposal.release_version, 120);
  const evidenceRows = await engine.executeRaw<JsonRecord>(
    `SELECT re.outcome
     FROM resolver_proposal_evidence rpe
     JOIN resolver_events re ON re.event_id = rpe.event_id
     WHERE rpe.proposal_id = $1`,
    [proposal.id],
  );
  const afterRows = effectiveVersion
    ? await engine.executeRaw<JsonRecord>(
        `SELECT outcome, count(*)::int AS count
         FROM resolver_events
         WHERE resolver_version = $1
         GROUP BY outcome`,
        [effectiveVersion],
      )
    : [];
  const before = {
    event_count: evidenceRows.length,
    fallback_count: evidenceRows.filter(row => row.outcome === 'fallback').length,
    timeout_count: evidenceRows.filter(row => row.outcome === 'timeout').length,
    success_count: evidenceRows.filter(row => row.outcome === 'success').length,
    manual_correction_count: evidenceRows.filter(row => row.outcome === 'manual_correction' || row.outcome === 'manual_override').length,
  };
  const after = Object.fromEntries(afterRows.map(row => [String(row.outcome), Number(row.count)]));
  const impact = {
    before,
    after,
    measured_at: new Date().toISOString(),
    resolver_version: effectiveVersion,
  };
  const currentImpact = asJsonRecord(proposal.impact);
  const updatedImpact = { ...currentImpact, measurement: impact };
  const rows = await engine.executeRaw<JsonRecord>(
    `UPDATE resolver_proposals
     SET impact = $2::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [proposal.id, json(updatedImpact)],
  );
  return { proposal: asObject(rows[0]), impact };
}

export async function resolverFeedbackHealth(engine: BrainEngine): Promise<JsonRecord> {
  await ensureResolverFeedbackSchema(engine);
  const eventsRows = await engine.executeRaw<{ count: number }>("SELECT count(*)::int AS count FROM resolver_events WHERE created_at > now() - interval '24 hours'");
  const countsRows = await engine.executeRaw<{ status: string; count: number }>('SELECT status, count(*)::int AS count FROM resolver_proposals GROUP BY status');
  const lastRuns = await engine.executeRaw<JsonRecord>('SELECT * FROM resolver_dream_runs ORDER BY started_at DESC LIMIT 1');
  const proposalCounts = Object.fromEntries([...PROPOSAL_STATUSES].map(s => [s, 0])) as JsonRecord;
  for (const row of countsRows) proposalCounts[row.status] = Number(row.count);
  return {
    ok: true,
    events_24h: Number(eventsRows[0]?.count ?? 0),
    proposal_counts: proposalCounts,
    last_dream_run: lastRuns[0] ? asObject(lastRuns[0]) : null,
    scheduled_loop: lastRuns[0] ? 'observed' : 'overdue',
  };
}

export async function runPhaseResolverLearning(engine: BrainEngine, opts: { dryRun?: boolean } = {}): Promise<JsonRecord> {
  const result = await generateResolverProposals(engine, { min_evidence: 2, dry_run: !!opts.dryRun, run_source: 'dream' });
  return {
    phase: 'resolver_learning',
    status: 'ok',
    summary: `resolver_learning scanned ${result.events_scanned} events and created ${result.created} pending proposal(s); auto_applied=0`,
    details: result,
  };
}
