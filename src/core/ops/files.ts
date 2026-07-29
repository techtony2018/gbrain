/**
 * File Operations cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `filesOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { validateFilename, validatePageSlug, validateUploadPath } from './context.ts';

// --- File Operations ---

// Both branches need a LIMIT. Without one, the slug-filtered branch materializes
// every file for that slug — an MCP caller can force unbounded memory consumption
// by targeting a page with many attachments.
const FILE_LIST_LIMIT = 100;

const file_list: Operation = {
  name: 'file_list',
  description: 'List stored files',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { sqlQueryForEngine } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    const slug = p.slug as string | undefined;
    const rows = slug
      ? await sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files WHERE page_slug = ${slug} ORDER BY filename LIMIT ${FILE_LIST_LIMIT}`
      : await sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files ORDER BY page_slug, filename LIMIT ${FILE_LIST_LIMIT}`;
    // Postgres returns size_bytes (BIGINT) as native BigInt — JSON.stringify
    // throws on those, breaking MCP callers. PGLite returns Number already.
    // 9 PB ceiling (2^53 bytes) is far above any plausible file size.
    return rows.map((r: Record<string, unknown>) => ({
      ...r,
      size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
    }));
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  description: 'Upload a file to storage',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { readFileSync, statSync } = await import('fs');
    const { basename, extname } = await import('path');
    const { createHash } = await import('crypto');

    const filePath = p.path as string;
    const pageSlug = (p.page_slug as string) || null;

    // Fix 1 / B5 / H5 / M4: validate path, slug, filename before any filesystem read.
    // Remote callers (MCP, agent) are confined to cwd (strict). Local CLI callers
    // can upload from anywhere on the filesystem (loose) — the user owns the machine.
    // Default is strict when ctx.remote is undefined (defense-in-depth).
    const strict = ctx.remote !== false;
    validateUploadPath(filePath, process.cwd(), strict);
    if (pageSlug) validatePageSlug(pageSlug);
    const filename = basename(filePath);
    validateFilename(filename);

    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const MIME_TYPES: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    };
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] || null;

    // #4302 (fail-closed honesty): a files row must never claim bytes that
    // were stored nowhere. With no storage backend configured, the old path
    // inserted the row and returned status:'uploaded' anyway — every later
    // read (file_url, files verify, restore) would trust a phantom object.
    // Typed error BEFORE any insert; git-tracked small files have their own
    // lane (`gbrain files upload-raw --page <slug>`).
    if (!ctx.config.storage) {
      throw new OperationError(
        'storage_error',
        'No storage backend configured — file_upload would record a files row with no stored bytes.',
        'Configure `storage` in your gbrain config (supabase | s3 | local), or use `gbrain files upload-raw --page <slug>` for git-tracked small files.',
      );
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);

    const { sqlQueryForEngine } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      // #4302: only claim already_exists when the BACKEND really holds the
      // object — a DB row whose bytes vanished must re-upload, not lie.
      let inBackend = false;
      try {
        inBackend = await storage.exists(storagePath);
      } catch { /* probe failure → treat as absent, re-upload below */ }
      if (inBackend) {
        return { status: 'already_exists', storage_path: storagePath };
      }
    }

    try {
      await storage.upload(storagePath, content, mimeType || undefined);
    } catch (uploadErr) {
      throw new OperationError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
    }

    try {
      await sql`
        INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
        VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
        ON CONFLICT (storage_path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          size_bytes = EXCLUDED.size_bytes,
          mime_type = EXCLUDED.mime_type
      `;
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      try {
        await storage.delete(storagePath);
      } catch { /* best effort cleanup */ }
      throw dbErr;
    }

    return { status: 'uploaded', storage_path: storagePath, size_bytes: stat.size };
  },
};

const file_url: Operation = {
  name: 'file_url',
  description: 'Get a URL for a stored file',
  params: {
    storage_path: { type: 'string', required: true },
  },
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { sqlQueryForEngine } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    const rows = await sql`SELECT storage_path, mime_type, size_bytes FROM files WHERE storage_path = ${p.storage_path as string}`;
    if (rows.length === 0) {
      throw new OperationError('storage_error', `File not found: ${p.storage_path}`);
    }
    // #4302: resolve a REAL URL from the backend, after confirming the object
    // is actually there — the old `gbrain:files/<path>` placeholder pointed
    // at nothing and hid rows whose bytes had vanished.
    if (!ctx.config.storage) {
      throw new OperationError(
        'storage_error',
        `No storage backend configured — cannot produce a URL for ${p.storage_path}.`,
        'Configure `storage` in your gbrain config (supabase | s3 | local).',
      );
    }
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage(ctx.config.storage as any);
    const present = await storage.exists(rows[0].storage_path as string).catch(() => false);
    if (!present) {
      throw new OperationError(
        'storage_error',
        `File row exists but the storage backend has no object at ${rows[0].storage_path} — re-upload it.`,
      );
    }
    return { storage_path: rows[0].storage_path, url: await storage.getUrl(rows[0].storage_path as string) };
  },
};

const files_delete: Operation = {
  name: 'files_delete',
  description: 'Delete stored file records and backing storage objects. Admin scope; remote-safe because deletion is resolved and executed on the GBrain host.',
  params: {
    storage_path: { type: 'string', description: 'Stored file path, gbrain:files/... reference, or /media/... path' },
    page_slug: { type: 'string', description: 'Page slug for page+filename deletion' },
    filename: { type: 'string', description: 'Filename for page+filename deletion' },
    dry_run: { type: 'boolean', description: 'List matching records without deleting' },
    yes: { type: 'boolean', description: 'Required for actual deletion' },
    all_matching_hash: { type: 'boolean', description: 'Also delete same-page records with identical content_hash' },
    keep_storage: { type: 'boolean', description: 'Delete DB rows only; keep backing storage objects' },
    cache_root: { type: 'string', description: 'Optional media cache root to clean on the host' },
    cache_roots: { type: 'array', items: { type: 'string' }, description: 'Optional media cache roots to clean on the host' },
  },
  mutating: true,
  scope: 'admin',
  area: 'files',
  localOnly: false,
  handler: async (ctx, p) => {
    const normalize = (value: string): string => {
      let text = String(value || '').trim();
      if (text.startsWith('gbrain:files/')) text = text.slice('gbrain:files/'.length);
      if (text.startsWith('/media/')) text = text.slice('/media/'.length);
      return text.replace(/^\/+/, '');
    };

    const storagePath = typeof p.storage_path === 'string' ? normalize(p.storage_path) : '';
    const pageSlug = typeof p.page_slug === 'string' ? p.page_slug : '';
    const filename = typeof p.filename === 'string' ? p.filename : '';
    if (storagePath && (pageSlug || filename)) {
      throw new OperationError('invalid_params', 'Use either storage_path or page_slug+filename, not both.');
    }
    if (!storagePath && (!pageSlug || !filename)) {
      throw new OperationError('invalid_params', 'Pass storage_path or both page_slug and filename.');
    }
    if (storagePath && !storagePath.includes('/')) {
      throw new OperationError('invalid_params', 'storage_path must include a page/path prefix.');
    }

    const { sqlQueryForEngine } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    let rows: Array<Record<string, unknown>>;
    if (storagePath) {
      rows = await sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash FROM files WHERE storage_path = ${storagePath} ORDER BY filename`;
    } else {
      rows = await sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash FROM files WHERE page_slug = ${pageSlug} AND filename = ${filename} ORDER BY filename`;
    }
    if (rows.length === 0) return { status: 'not_found', matched: 0, rows: [] };

    if (p.all_matching_hash === true) {
      const byId = new Map(rows.map(row => [String(row.id), row]));
      for (const row of rows) {
        if (!row.page_slug || !row.content_hash) continue;
        const matches = await sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash FROM files WHERE page_slug = ${row.page_slug as string} AND content_hash = ${row.content_hash as string} ORDER BY filename`;
        for (const match of matches) byId.set(String(match.id), match);
      }
      rows = [...byId.values()].sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
    }

    const summaryRows = rows.map(row => ({
      id: Number(row.id),
      page_slug: row.page_slug,
      filename: row.filename,
      storage_path: row.storage_path,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
      content_hash: row.content_hash,
    }));

    if (p.dry_run === true) return { dry_run: true, matched: rows.length, rows: summaryRows };
    if (p.yes !== true) {
      throw new OperationError('permission_denied', 'Refusing to delete without yes=true. Re-run with dry_run=true to inspect or yes=true to delete.');
    }

    let storage_deleted = 0;
    const storage_errors: Array<{ storage_path: string; error: string }> = [];
    if (ctx.config.storage && p.keep_storage !== true) {
      const { createStorage } = await import('../storage.ts');
      const storage = await createStorage(ctx.config.storage as any);
      for (const row of rows) {
        try {
          await storage.delete(String(row.storage_path));
          storage_deleted++;
        } catch (err) {
          storage_errors.push({ storage_path: String(row.storage_path), error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (storage_errors.length > 0) {
      throw new OperationError('storage_error', `Aborting DB row deletion because ${storage_errors.length} storage delete(s) failed.`, JSON.stringify(storage_errors));
    }

    let db_deleted = 0;
    for (const row of rows) {
      const deleted = await sql`DELETE FROM files WHERE id = ${row.id as number} RETURNING id`;
      db_deleted += deleted.length;
    }

    const cacheRoots = [
      ...(typeof p.cache_root === 'string' && p.cache_root ? [p.cache_root] : []),
      ...(Array.isArray(p.cache_roots) ? p.cache_roots.filter(root => typeof root === 'string') as string[] : []),
      ...String(process.env.GBRAIN_FILE_CACHE_ROOTS || '').split(',').map(root => root.trim()).filter(Boolean),
    ];
    let cache_deleted = 0;
    if (cacheRoots.length > 0) {
      const { existsSync, unlinkSync } = await import('fs');
      const { resolve } = await import('path');
      for (const rootValue of cacheRoots) {
        const root = resolve(rootValue);
        for (const row of rows) {
          const candidate = resolve(root, normalize(String(row.storage_path)));
          if (candidate !== root && !candidate.startsWith(root + '/')) continue;
          if (existsSync(candidate)) {
            unlinkSync(candidate);
            cache_deleted++;
          }
        }
      }
    }

    return { status: 'deleted', matched: rows.length, db_deleted, storage_deleted, cache_deleted, rows: summaryRows };
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const filesOperations: Operation[] = [file_list, file_upload, file_url, files_delete];
