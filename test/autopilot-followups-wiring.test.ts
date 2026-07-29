import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('autopilot persists and reconciles findings before dispatch branching', () => {
  const source = readFileSync(resolve(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

  expect(source).toContain("await import('../core/autopilot-findings.ts')");
  expect(source).toContain('buildAutopilotFindingObservations');
  expect(source).toContain('reconcileAutopilotFindings(');
  expect(source).toContain('dispatchRemediable: !shouldFullCycle');
  expect(source).toContain('plan.length === 0 && (');
  expect(source).not.toContain('plan.length > 3');
  expect(source).not.toContain('estTotal >= 300');
  expect(source).not.toContain("logError('dispatch.step'");
});
