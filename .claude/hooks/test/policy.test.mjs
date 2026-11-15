// P-U: corpus de política sobre decide() con un repo fixture temporal.
import './env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../lib/decide.mjs';
import { BASH, PS, TOOLS } from './corpus.mjs';
import { makeFixture } from './fixture.mjs';

const root = makeFixture();

function check(r, expected, rule, label) {
  assert.equal(r.decision, expected, `${label} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
  if (rule) assert.equal(r.rule, rule, `${label} -> regla ${r.rule} (${r.msg})`);
}

for (const [cmd, expected, rule] of BASH) {
  test(`bash: ${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await decide({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: root }, { root });
    check(r, expected, rule, cmd);
  });
}

for (const [cmd, expected, rule] of PS) {
  test(`powershell: ${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await decide({ tool_name: 'PowerShell', tool_input: { command: cmd }, cwd: root }, { root });
    check(r, expected, rule, cmd);
  });
}

for (const [input, expected, rule] of TOOLS) {
  test(`tool: ${input.tool_name} ${JSON.stringify(input.tool_input).slice(0, 80)}${input.agent_id ? ' (subagente)' : ''} => ${expected}`, async () => {
    const r = await decide({ ...input, cwd: root }, { root });
    check(r, expected, rule, input.tool_name);
  });
}

test('el monitor (Monitor tool) se analiza como Bash', async () => {
  const r = await decide({ tool_name: 'Monitor', tool_input: { command: 'git push -f' }, cwd: root }, { root });
  check(r, 'deny', 'H-01', 'Monitor');
});
