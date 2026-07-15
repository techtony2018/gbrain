import type { StorageConfig } from './storage.ts';
import { createStorage } from './storage.ts';
import { createHash } from 'crypto';
import { basename } from 'path';

export interface DurableFileEvidence {
  durable_storage_verified: true;
  storage_path: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  disposition: 'uploaded' | 'already_verified' | 'repaired';
}

export async function ensureDurableStorageFile(
  config: StorageConfig | undefined,
  storagePath: string,
  content: Buffer,
  mimeType?: string | null,
  ledgerExists = false,
): Promise<DurableFileEvidence> {
  if (!config) throw new Error('No storage backend configured; refusing ledger-only file upload.');
  const storage = await createStorage(config);
  const expectedHash = createHash('sha256').update(content).digest('hex');
  const existed = await storage.exists(storagePath);
  let disposition: DurableFileEvidence['disposition'] = existed ? 'already_verified' : (ledgerExists ? 'repaired' : 'uploaded');

  if (existed) {
    const stored = await storage.download(storagePath);
    const storedHash = createHash('sha256').update(stored).digest('hex');
    if (stored.length !== content.length || storedHash !== expectedHash) disposition = 'repaired';
  }
  if (!existed || disposition === 'repaired') {
    await storage.upload(storagePath, content, mimeType || undefined);
  }
  // A ledger record is never sufficient: read the backend object back and verify it.
  let verified: Buffer;
  try {
    verified = await storage.download(storagePath);
  } catch (error) {
    throw new Error(`Durable storage readback failed for ${storagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verifiedHash = createHash('sha256').update(verified).digest('hex');
  if (verified.length !== content.length || verifiedHash !== expectedHash) {
    throw new Error(`Durable storage verification mismatch for ${storagePath}.`);
  }
  return {
    durable_storage_verified: true,
    storage_path: storagePath,
    filename: basename(storagePath),
    size_bytes: content.length,
    sha256: expectedHash,
    disposition,
  };
}
