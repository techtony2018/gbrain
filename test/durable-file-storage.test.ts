import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureDurableStorageFile } from '../src/core/durable-file-storage.ts';

describe('ensureDurableStorageFile', () => {
  test('rejects uploads when no storage backend is configured', async () => {
    await expect(
      ensureDurableStorageFile(undefined, 'people/example/photo.png', Buffer.from('bytes'), 'image/png'),
    ).rejects.toThrow('No storage backend configured');
  });

  test('writes and verifies exact bytes in local durable storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-durable-'));
    try {
      const evidence = await ensureDurableStorageFile(
        { backend: 'local', bucket: 'brain-files', localPath: root },
        'people/example/photo.png',
        Buffer.from('exact bytes'),
        'image/png',
      );

      expect(evidence.durable_storage_verified).toBe(true);
      expect(evidence.storage_path).toBe('people/example/photo.png');
      expect(evidence.filename).toBe('photo.png');
      expect(evidence.size_bytes).toBe(11);
      expect(evidence.sha256).toHaveLength(64);
      expect(evidence.disposition).toBe('uploaded');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is idempotent and repairs a ledger-present blob-missing path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-durable-'));
    const config = { backend: 'local' as const, bucket: 'brain-files', localPath: root };
    try {
      const first = await ensureDurableStorageFile(config, 'people/example/photo.png', Buffer.from('same'), 'image/png');
      const second = await ensureDurableStorageFile(config, 'people/example/photo.png', Buffer.from('same'), 'image/png');
      expect(first.disposition).toBe('uploaded');
      expect(second.disposition).toBe('already_verified');

      unlinkSync(join(root, 'people/example/photo.png'));
      const repaired = await ensureDurableStorageFile(config, 'people/example/photo.png', Buffer.from('same'), 'image/png', true);
      expect(repaired.disposition).toBe('repaired');
      expect(repaired.durable_storage_verified).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
