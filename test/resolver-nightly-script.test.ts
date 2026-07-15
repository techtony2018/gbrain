import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('resolver learning nightly wrapper', () => {
  test('preflights deterministic bun and gbrain paths before running', () => {
    const script = readFileSync(new URL('../scripts/resolver-learning-nightly.sh', import.meta.url), 'utf8');
    expect(script).toContain('PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"');
    expect(script).toContain('command -v bun');
    expect(script).toContain('test -x "$GBRAIN_BIN"');
    expect(script).toContain('preflight failed');
    expect(script).toContain('auto_applied=0');
  });
});
