import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const bridge = process.env.GBRAIN_RESOLVER_BRIDGE || join(homedir(), '.gbrain', 'resolver-feedback-agent.py');

function payload(event, ctx) {
  return JSON.stringify({
    ...event,
    sessionId: ctx?.sessionId,
    sessionKey: ctx?.sessionKey,
    runId: event?.runId || ctx?.runId,
    agentId: ctx?.agentId,
    modelId: ctx?.modelId,
  });
}

function before(event, ctx) {
  const result = spawnSync('python3', [bridge, 'hook', '--producer', 'openclaw', '--phase', 'before'], {
    input: payload(event, ctx),
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  });
  const context = result.status === 0 ? result.stdout.trim() : '';
  return context ? { prependContext: context } : undefined;
}

function after(event, ctx) {
  try {
    const child = spawn('python3', [bridge, 'hook', '--producer', 'openclaw', '--phase', 'after'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.stdin.end(payload(event, ctx));
    child.unref();
  } catch {
    // Telemetry must never affect the agent response path.
  }
}

export default {
  id: 'gbrain-resolver-feedback',
  name: 'GBrain Resolver Feedback',
  version: '1.0.0',
  register(api) {
    api.on('before_prompt_build', before, { priority: -100, timeoutMs: 2000 });
    api.on('agent_end', after, { priority: -100, timeoutMs: 500 });
  },
};
