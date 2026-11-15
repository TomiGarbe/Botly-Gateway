// P0.1 (hallazgo H-1 de la auditoría 2.2.2): git acepta prefijos no ambiguos de opciones largas.
// Valida DECISIÓN DE POLÍTICA (decide()), no ejecución real: ningún comando se ejecuta.
import './env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../lib/decide.mjs';
import { resolveLongOpt } from '../lib/policy.mjs';
import { makeFixture } from './fixture.mjs';

const root = makeFixture();
const run = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root });

// [comando, decisión esperada, regla esperada (opcional)]
const CASES = [
  // push: force y sus abreviaturas
  ['git push --force origin x', 'deny', 'H-01'],
  ['git push --forc origin x', 'deny', 'H-01'],
  ['git push --for origin x', 'deny', 'H-01'],
  ['git push --f origin x', 'deny', 'H-01'],
  ['git push --force-w origin x', 'deny', 'H-01'],
  ['git push --force-with origin x', 'deny', 'H-01'],
  ['git push --force-with-lease origin x', 'deny', 'H-01'],
  ['git push --force-with-lease=x:abc origin x', 'deny', 'H-01'],
  ['git push --force-i origin x', 'deny', 'H-01'],
  ['git push -f origin x', 'deny', 'H-01'],
  ['git push -uf origin x', 'deny', 'H-01'],
  ['git push -fu origin x', 'deny', 'H-01'],
  ['git push origin +x', 'deny', 'H-01'],
  ['git push origin x --forc', 'deny', 'H-01'],
  ['git push origin x -vf', 'deny', 'H-01'],
  ['git push --frobnicate origin x', 'deny', 'H-01'],
  ['git push --FORCE origin x', 'deny', 'H-01'],
  // push: borrado o reescritura remota
  ['git push --delete origin x', 'deny', 'H-08'],
  ['git push --dele origin x', 'deny', 'H-08'],
  ['git push --del origin x', 'deny', 'H-08'],
  ['git push --d origin x', 'deny', 'H-08'],
  ['git push -d origin x', 'deny', 'H-08'],
  ['git push -vd origin x', 'deny', 'H-08'],
  ['git push origin :x', 'deny', 'H-08'],
  ['git push --mirr origin', 'deny', 'H-08'],
  ['git push --mirror origin', 'deny', 'H-08'],
  ['git push --pru origin', 'deny', 'H-08'],
  ['git push origin x --dele', 'deny', 'H-08'],
  // push permitido por el hook (lo resuelve la regla ask de settings.json)
  ['git push origin x', 'allow'],
  ['git push --dry-run origin x', 'allow'],
  ['git push --dry origin x', 'allow'],
  ['git push --set-upstream origin x', 'allow'],
  ['git push --set-u origin x', 'allow'],
  ['git push --no-verify origin x', 'allow'],
  ['git push --no-force-with-lease origin x', 'allow'],
  ['git push --fol origin x', 'allow'],
  ['git push --push-option ci.skip origin x', 'allow'],
  ['git push -u origin x', 'allow'],
  // reset --hard y abreviaturas
  ['git reset --hard', 'deny', 'H-02'],
  ['git reset --har HEAD', 'deny', 'H-02'],
  ['git reset --ha HEAD', 'deny', 'H-02'],
  ['git reset --h HEAD', 'deny', 'H-02'],
  ['git reset HEAD~1 --hard', 'deny', 'H-02'],
  ['git reset --quiet --har', 'deny', 'H-02'],
  ['git reset --zzz HEAD', 'deny', 'H-02'],
  ['git reset --soft HEAD~1', 'allow'],
  ['git reset --so HEAD~1', 'allow'],
  ['git reset --mixed', 'allow'],
  ['git reset src/app.txt', 'allow'],
  ['git reset -- src/app.txt', 'allow'],
  // clean -x / -X y combinaciones
  ['git clean -x', 'deny', 'H-09'],
  ['git clean -X', 'deny', 'H-09'],
  ['git clean -fx', 'deny', 'H-09'],
  ['git clean -xf', 'deny', 'H-09'],
  ['git clean -fdx', 'deny', 'H-09'],
  ['git clean -fdX', 'deny', 'H-09'],
  ['git clean -f -d -x', 'deny', 'H-09'],
  ['git clean -fxe foo', 'deny', 'H-09'],
  ['git clean -nx', 'deny', 'H-09'],
  ['git clean --frob', 'deny', 'H-09'],
  ['git clean -f -Z', 'deny', 'H-09'],
  ['git clean --f', 'deny', 'H-12'], // --f = --force sobre la raíz: alcanza los controles
  ['git clean -n', 'allow'],
  ['git clean --dry', 'allow'],
  ['git clean --dry-run', 'allow'],
  ['git clean -fd src', 'allow'],
  ['git clean -f -e x src', 'allow'],
  ['git clean -ex -f src', 'allow'], // -ex = excluir el patrón "x", no la opción -x
  ['git clean -f --exclude x src', 'allow'],
];

for (const [cmd, expected, rule] of CASES) {
  test(`P0.1 ${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(cmd);
    assert.equal(r.decision, expected, `${cmd} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
    if (rule) assert.equal(r.rule, rule, `${cmd} -> ${r.rule} (${r.msg})`);
  });
}

test('resolveLongOpt: exacta, prefijo único, ambigua, negada y desconocida', () => {
  const K = ['force', 'force-with-lease', 'follow-tags', 'delete', 'dry-run', 'verify'];
  assert.deepEqual(resolveLongOpt('--force', K).names, ['force']);
  assert.deepEqual(resolveLongOpt('--force-w', K).names, ['force-with-lease']);
  assert.deepEqual(resolveLongOpt('--dele', K).names, ['delete']);
  assert.deepEqual(resolveLongOpt('--f', K).names.sort(), ['follow-tags', 'force', 'force-with-lease']);
  assert.deepEqual(resolveLongOpt('--d', K).names.sort(), ['delete', 'dry-run']);
  const neg = resolveLongOpt('--no-verif', K);
  assert.deepEqual(neg.names, ['verify']);
  assert.equal(neg.negated, true);
  assert.deepEqual(resolveLongOpt('--zz', K).names, []);
  assert.equal(resolveLongOpt('--force-with-lease=a:b', K).value, 'a:b');
});
