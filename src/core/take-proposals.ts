import type {
  BrainEngine,
  Take,
  TakeProposal,
  TakeProposalActionOpts,
  TakeProposalActionResult,
  TakeProposalBulkActionOpts,
  TakeProposalBulkActionResult,
  TakeProposalCounts,
  TakeProposalListOpts,
  TakeProposalStatus,
} from './engine.ts';

const STATUSES: TakeProposalStatus[] = ['pending', 'accepted', 'rejected', 'superseded', 'deferred'];

function clampLimit(limit: number | undefined, fallback = 50, cap = 200): number {
  if (!Number.isFinite(limit as number)) return fallback;
  return Math.max(1, Math.min(cap, Math.floor(limit as number)));
}

function offsetOf(offset: number | undefined): number {
  if (!Number.isFinite(offset as number)) return 0;
  return Math.max(0, Math.floor(offset as number));
}

function rowToProposal(row: Record<string, unknown>): TakeProposal {
  return {
    id: Number(row.id),
    source_id: String(row.source_id),
    page_slug: String(row.page_slug),
    content_hash: String(row.content_hash),
    prompt_version: String(row.prompt_version),
    wave_version: String(row.wave_version),
    proposed_at: row.proposed_at instanceof Date ? row.proposed_at.toISOString() : String(row.proposed_at),
    proposal_run_id: String(row.proposal_run_id),
    status: String(row.status) as TakeProposalStatus,
    claim_text: String(row.claim_text),
    kind: String(row.kind),
    holder: String(row.holder),
    weight: Number(row.weight),
    domain: row.domain == null ? null : String(row.domain),
    dedup_against_fence_rows: row.dedup_against_fence_rows ?? null,
    model_id: String(row.model_id),
    acted_at: row.acted_at == null ? null : row.acted_at instanceof Date ? row.acted_at.toISOString() : String(row.acted_at),
    acted_by: row.acted_by == null ? null : String(row.acted_by),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
    predicted_brier: row.predicted_brier == null ? null : Number(row.predicted_brier),
    predicted_brier_bucket_n: row.predicted_brier_bucket_n == null ? null : Number(row.predicted_brier_bucket_n),
    source_exists: row.source_exists === true || row.source_exists === 'true' || row.source_exists === 1,
    source_preview: row.source_preview == null ? null : String(row.source_preview),
  };
}

function rowToTake(row: Record<string, unknown>): Take {
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    page_slug: String(row.page_slug),
    row_num: Number(row.row_num),
    claim: String(row.claim),
    kind: String(row.kind),
    holder: String(row.holder),
    weight: Number(row.weight),
    since_date: row.since_date == null ? null : String(row.since_date),
    until_date: row.until_date == null ? null : String(row.until_date),
    source: row.source == null ? null : String(row.source),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    active: row.active === true || row.active === 'true' || row.active === 1,
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    resolved_outcome: row.resolved_outcome == null ? null : Boolean(row.resolved_outcome),
    resolved_quality: row.resolved_quality == null ? null : row.resolved_quality as Take['resolved_quality'],
    resolved_value: row.resolved_value == null ? null : Number(row.resolved_value),
    resolved_unit: row.resolved_unit == null ? null : String(row.resolved_unit),
    resolved_source: row.resolved_source == null ? null : String(row.resolved_source),
    resolved_by: row.resolved_by == null ? null : String(row.resolved_by),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

async function fetchProposal(engine: BrainEngine, opts: TakeProposalActionOpts): Promise<TakeProposal | null> {
  const result = await listTakeProposals(engine, {
    id: opts.id,
    status: 'all',
    sourceId: opts.sourceId,
    sourceIds: opts.sourceIds,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    limit: 1,
  });
  return result.proposals[0] ?? null;
}

async function fetchPromotedTake(engine: BrainEngine, proposal: TakeProposal): Promise<Take | null> {
  if (proposal.promoted_row_num == null) return null;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT t.*, p.slug AS page_slug
     FROM takes t
     JOIN pages p ON p.id = t.page_id
     WHERE p.source_id = $1
       AND p.slug = $2
       AND t.row_num = $3
     LIMIT 1`,
    [proposal.source_id, proposal.page_slug, proposal.promoted_row_num],
  );
  return rows[0] ? rowToTake(rows[0]) : null;
}

export async function listTakeProposals(engine: BrainEngine, opts: TakeProposalListOpts = {}): Promise<{
  proposals: TakeProposal[];
  counts: TakeProposalCounts;
  limit: number;
  offset: number;
}> {
  const limit = clampLimit(opts.limit);
  const offset = offsetOf(opts.offset);
  const status = opts.status ?? 'pending';
  const sourceIds = opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : null);
  const search = opts.search?.trim() || null;
  const params = [
    opts.id ?? null,
    status === 'all' ? null : status,
    opts.page_slug ?? null,
    opts.holder ?? null,
    sourceIds,
    opts.takesHoldersAllowList ?? null,
    search,
    limit,
    offset,
  ];
  const where = `
    ($1::bigint IS NULL OR tp.id = $1::bigint)
    AND ($2::text IS NULL OR tp.status = $2::text)
    AND ($3::text IS NULL OR tp.page_slug = $3::text)
    AND ($4::text IS NULL OR tp.holder = $4::text)
    AND ($5::text[] IS NULL OR tp.source_id = ANY($5::text[]))
    AND ($6::text[] IS NULL OR tp.holder = ANY($6::text[]))
    AND (
      $7::text IS NULL
      OR lower(tp.claim_text) LIKE '%' || lower($7::text) || '%'
      OR lower(tp.page_slug) LIKE '%' || lower($7::text) || '%'
      OR lower(coalesce(tp.domain, '')) LIKE '%' || lower($7::text) || '%'
    )
  `;
  const countParams = [
    opts.id ?? null,
    opts.page_slug ?? null,
    opts.holder ?? null,
    sourceIds,
    opts.takesHoldersAllowList ?? null,
    search,
  ];
  const countWhere = `
    ($1::bigint IS NULL OR tp.id = $1::bigint)
    AND ($2::text IS NULL OR tp.page_slug = $2::text)
    AND ($3::text IS NULL OR tp.holder = $3::text)
    AND ($4::text[] IS NULL OR tp.source_id = ANY($4::text[]))
    AND ($5::text[] IS NULL OR tp.holder = ANY($5::text[]))
    AND (
      $6::text IS NULL
      OR lower(tp.claim_text) LIKE '%' || lower($6::text) || '%'
      OR lower(tp.page_slug) LIKE '%' || lower($6::text) || '%'
      OR lower(coalesce(tp.domain, '')) LIKE '%' || lower($6::text) || '%'
    )
  `;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT tp.*,
            (p.id IS NOT NULL) AS source_exists,
            substring(coalesce(p.compiled_truth, '') from 1 for 240) AS source_preview
     FROM take_proposals tp
     LEFT JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug
     WHERE ${where}
     ORDER BY tp.proposed_at DESC, tp.id DESC
     LIMIT $8 OFFSET $9`,
    params,
  );
  const countRows = await engine.executeRaw<{ status: string; count: number }>(
    `SELECT tp.status, count(*)::int AS count
     FROM take_proposals tp
     WHERE ${countWhere}
     GROUP BY tp.status`,
    countParams,
  );
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0])) as unknown as TakeProposalCounts;
  for (const row of countRows) {
    const rowStatus = String(row.status) as keyof TakeProposalCounts;
    if (rowStatus in counts) counts[rowStatus] = Number(row.count);
  }
  return { proposals: rows.map(rowToProposal), counts, limit, offset };
}

export async function acceptTakeProposal(engine: BrainEngine, opts: TakeProposalActionOpts): Promise<TakeProposalActionResult> {
  const before = await fetchProposal(engine, opts);
  if (!before) throw new Error(`TAKE_PROPOSAL_NOT_FOUND: ${opts.id}`);
  if (before.status === 'accepted') {
    return { proposal: before, take: await fetchPromotedTake(engine, before), idempotent: true };
  }
  if (before.status !== 'pending') {
    throw new Error(`TAKE_PROPOSAL_NOT_PENDING: ${opts.id} status=${before.status}`);
  }
  const rowRows = await engine.executeRaw<{ row_num: number }>(
    `SELECT coalesce(max(t.row_num), 0)::int + 1 AS row_num
     FROM pages p
     LEFT JOIN takes t ON t.page_id = p.id
     WHERE p.source_id = $1 AND p.slug = $2`,
    [before.source_id, before.page_slug],
  );
  const rowNum = Number(rowRows[0]?.row_num ?? 1);
  const inserted = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO takes (
       page_id, row_num, claim, kind, holder, weight, source, active
     )
     SELECT p.id, $3::int, $4::text, $5::text, $6::text, $7::real, $8::text, true
     FROM pages p
     WHERE p.source_id = $1 AND p.slug = $2
     ON CONFLICT (page_id, row_num) DO UPDATE SET
       claim = EXCLUDED.claim,
       kind = EXCLUDED.kind,
       holder = EXCLUDED.holder,
       weight = EXCLUDED.weight,
       source = EXCLUDED.source,
       active = true,
       updated_at = now()
     RETURNING *, (SELECT slug FROM pages WHERE id = takes.page_id) AS page_slug`,
    [
      before.source_id,
      before.page_slug,
      rowNum,
      before.claim_text,
      before.kind,
      before.holder,
      before.weight,
      `take_proposal:${before.id}`,
    ],
  );
  if (inserted.length === 0) throw new Error(`TAKE_PROPOSAL_SOURCE_MISSING: ${opts.id} page=${before.page_slug}`);
  const updated = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE take_proposals
     SET status = 'accepted',
         acted_at = coalesce(acted_at, now()),
         acted_by = coalesce(acted_by, $2::text),
         promoted_row_num = coalesce(promoted_row_num, $3::int)
     WHERE id = $1::bigint
     RETURNING *, true AS source_exists, null::text AS source_preview`,
    [before.id, opts.actedBy ?? 'memory-stargraph', rowNum],
  );
  const proposal = rowToProposal(updated[0]);
  return { proposal, take: rowToTake(inserted[0]), idempotent: false };
}

async function markTakeProposal(engine: BrainEngine, opts: TakeProposalActionOpts, status: 'rejected' | 'deferred'): Promise<TakeProposalActionResult> {
  const before = await fetchProposal(engine, opts);
  if (!before) throw new Error(`TAKE_PROPOSAL_NOT_FOUND: ${opts.id}`);
  if (before.status === status) {
    return { proposal: before, take: null, idempotent: true };
  }
  if (before.status !== 'pending') {
    throw new Error(`TAKE_PROPOSAL_NOT_PENDING: ${opts.id} status=${before.status}`);
  }
  const updated = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE take_proposals
     SET status = $2::text,
         acted_at = coalesce(acted_at, now()),
         acted_by = coalesce(acted_by, $3::text)
     WHERE id = $1::bigint
     RETURNING *, true AS source_exists, null::text AS source_preview`,
    [before.id, status, opts.actedBy ?? 'memory-stargraph'],
  );
  return { proposal: rowToProposal(updated[0]), take: null, idempotent: false };
}

export function rejectTakeProposal(engine: BrainEngine, opts: TakeProposalActionOpts): Promise<TakeProposalActionResult> {
  return markTakeProposal(engine, opts, 'rejected');
}

export function deferTakeProposal(engine: BrainEngine, opts: TakeProposalActionOpts): Promise<TakeProposalActionResult> {
  return markTakeProposal(engine, opts, 'deferred');
}

export async function bulkTakeProposalAction(engine: BrainEngine, opts: TakeProposalBulkActionOpts): Promise<TakeProposalBulkActionResult> {
  const limit = clampLimit(opts.limit, 25, 100);
  const ids = [...new Set(opts.ids.map(id => Number(id)).filter(Number.isFinite))].slice(0, limit);
  const results: TakeProposalBulkActionResult['results'] = [];
  for (const id of ids) {
    try {
      const actionOpts = {
        id,
        actedBy: opts.actedBy,
        sourceId: opts.sourceId,
        sourceIds: opts.sourceIds,
        takesHoldersAllowList: opts.takesHoldersAllowList,
      };
      const result = opts.action === 'accept'
        ? await acceptTakeProposal(engine, actionOpts)
        : opts.action === 'reject'
          ? await rejectTakeProposal(engine, actionOpts)
          : await deferTakeProposal(engine, actionOpts);
      results.push({ id, ok: true, proposal: result.proposal, take: result.take, idempotent: result.idempotent });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
}
