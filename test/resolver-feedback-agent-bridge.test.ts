import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bridge = join(import.meta.dir, '..', 'scripts', 'resolver-feedback-agent.py');

async function run(args: string[], input: unknown, env: Record<string, string>) {
  const proc = Bun.spawn(['python3', bridge, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return stdout;
}

describe('resolver feedback agent bridge', () => {
  test('hooks persist only classified task data and correlate before/after events', async () => {
    const state = await mkdtemp(join(tmpdir(), 'resolver-agent-'));
    const env = {
      GBRAIN_RESOLVER_STATE_DIR: state,
      GBRAIN_BIN: '/missing/gbrain',
      GBRAIN_RESOLVER_DISABLE_BACKGROUND: '1',
    };
    const payload = {
      session_id: 'session-1',
      turn_id: 'turn-1',
      prompt: 'Fix the GBrain backup automation. token=private-value and password=hunter2',
    };

    await run(['hook', '--producer', 'codex', '--phase', 'before'], payload, env);
    await run(['hook', '--producer', 'codex', '--phase', 'after'], { ...payload, success: true }, env);

    const files = await readdir(join(state, 'outbox'));
    expect(files).toHaveLength(2);
    const events = await Promise.all(files.map(async file => JSON.parse(await readFile(join(state, 'outbox', file), 'utf8'))));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Fix the GBrain');
    expect(events.map(event => event.outcome).sort()).toEqual(['success', 'unknown']);
    expect(events.every(event => event.intent_summary.startsWith('task action=fix domains='))).toBe(true);
    expect(events.every(event => ['gbrain', 'automation'].every(domain => event.intent_summary.includes(domain)))).toBe(true);
  });

  test('offline outbox drains idempotent event files through gbrain call', async () => {
    const state = await mkdtemp(join(tmpdir(), 'resolver-agent-drain-'));
    const log = join(state, 'calls.jsonl');
    const fake = join(state, 'gbrain');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$3" >> "$GBRAIN_FAKE_LOG"\nprintf '{"ok":true}\\n'\n`);
    await chmod(fake, 0o755);
    const env = {
      GBRAIN_RESOLVER_STATE_DIR: state,
      GBRAIN_BIN: fake,
      GBRAIN_FAKE_LOG: log,
      GBRAIN_RESOLVER_DISABLE_BACKGROUND: '1',
    };
    await run(['hook', '--producer', 'openclaw', '--phase', 'before'], {
      runId: 'openclaw-run-1',
      prompt: 'Research the GBrain resolver behavior',
    }, env);

    const stdout = await run(['drain'], {}, env);

    expect(JSON.parse(stdout)).toEqual({ failed: 0, remaining: 0, sent: 1 });
    const submitted = JSON.parse((await readFile(log, 'utf8')).trim());
    expect(submitted.producer).toBe('openclaw');
    expect(submitted.event_id).toContain('openclaw-run-1');
  });
});
