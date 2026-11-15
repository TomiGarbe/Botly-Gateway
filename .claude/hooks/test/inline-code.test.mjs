// P0.2 (auditoría 2.2.2): código inline y por stdin frente a las rutas protegidas.
// Valida la DECISIÓN de decide() y, en una muestra, el proceso real de guard.mjs (exit code).
// Ningún comando analizado se ejecuta: sólo se pasa su texto al hook.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../lib/decide.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();
const BSL = String.fromCharCode(92);
const WROOT = root.split('/').join(BSL).split(path.posix.sep).join(BSL);
const sub = (c) => c.replaceAll('<ROOT>', root.split(BSL).join('/')).replaceAll('<WROOT>', WROOT);
const run = (tool, command) => decide({ tool_name: tool, tool_input: { command: sub(command) }, cwd: root }, { root });

// [herramienta, comando, decisión, regla (opcional)]
const CASES = [
  // --- CLAUDE.md
  ['Bash', `node -e "require('fs').writeFileSync('CLAUDE.md','x')"`, 'deny', 'H-12'],
  ['Bash', `php -r 'file_put_contents("CLAUDE.md", "x");'`, 'deny', 'H-12'],
  ['Bash', `python -c "open('./CLAUDE.md','a').write('x')"`, 'deny', 'H-12'],
  // --- settings
  ['Bash', `node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`, 'deny', 'H-12'],
  ['Bash', `deno eval "Deno.writeTextFileSync('.claude/settings.local.json','{}')"`, 'deny', 'H-12'],
  ['Bash', `perl -e 'open(my $f, ">", ".claude/settings.json"); print $f "{}"'`, 'deny', 'H-12'],
  ['Bash', `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')"`, 'deny', 'H-12'],
  // --- hooks
  ['Bash', `ruby -e 'File.write(".claude/hooks/guard.mjs", "")'`, 'deny', 'H-12'],
  ['Bash', `python - <<'PY'\nimport shutil\nshutil.rmtree('.claude/hooks')\nPY`, 'deny', 'H-12'],
  ['Bash', `node -e "require('fs').rmSync(require('path').join('.claude','hooks'),{recursive:true})"`, 'deny', 'H-12'],
  // --- rules
  ['Bash', `python -c "open('.claude/rules/governance.md','w').write('x')"`, 'deny', 'H-12'],
  ['Bash', `python -c "import os; os.rename('.claude/rules','/tmp/r')"`, 'deny', 'H-12'],
  // --- rutas absolutas y separadores Windows
  ['Bash', `node -e "require('fs').writeFileSync('<ROOT>/.claude/settings.local.json','{}')"`, 'deny', 'H-12'],
  ['Bash', `node -e "require('fs').writeFileSync('<WROOT>${BSL}${BSL}.claude${BSL}${BSL}settings.json','{}')"`, 'deny', 'H-12'],
  ['Bash', `python -c "open(r'<WROOT>${BSL}CLAUDE.md','w')"`, 'deny', 'H-12'],
  ['PowerShell', `node -e "require('fs').unlinkSync('.claude${BSL}hooks${BSL}guard.mjs')"`, 'deny', 'H-12'],
  ['PowerShell', `node -e "require('fs').unlinkSync('.claude${BSL}${BSL}hooks${BSL}${BSL}guard.mjs')"`, 'deny', 'H-12'],
  ['PowerShell', `python -c "open('<WROOT>${BSL}.claude${BSL}rules${BSL}governance.md','w')"`, 'deny', 'H-12'],
  // --- rutas construidas dinámicamente
  ['Bash', `python -c "import pathlib; (pathlib.Path('.claude')/'settings.json').write_text('{}')"`, 'deny', 'H-12'],
  ['Bash', `python -c "p='.claude'; open(f'{p}/settings.json','w').write('{}')"`, 'deny', 'H-12'],
  ['Bash', `python -c "import os; os.remove(os.path.join('.cl'+'aude','hooks','guard.mjs'))"`, 'deny', 'H-12'],
  ['Bash', `perl -e 'my $p = ".cl" . "aude/settings.json"; unlink $p'`, 'deny', 'H-12'],
  ['Bash', `python -c "import os; os.chdir('.claude'); open('settings.json','w').write('{}')"`, 'deny', 'H-12'],
  ['Bash', `node -e "const fs=require('fs'); fs['write'+'FileSync']('CLAUDE.md','x')"`, 'deny', 'H-12'],
  ['Bash', `node -e "require('fs').rmSync('.',{recursive:true,force:true})"`, 'deny', 'H-12'],
  ['Bash', `cd "$X" && node -e "require('fs').writeFileSync('./notas.md','x')"`, 'deny', 'H-12'],
  // --- archivos con skip-worktree (misma clasificación de paths.mjs)
  ['Bash', `node -e "require('fs').writeFileSync('docs/MODULO_02_HANDOFF.md','x')"`, 'deny', 'H-10'],
  // --- stdin (heredoc, pipe literal, here-string de PowerShell)
  ['Bash', `node <<'JS'\nrequire('fs').appendFileSync('.claude/rules/governance.md','x')\nJS`, 'deny'],
  ['Bash', `echo "require('fs').writeFileSync('CLAUDE.md','x')" | node`, 'deny'],
  ['Bash', `python3 <<'PY'\nopen('.claude/settings.json','w').write('{}')\nPY`, 'deny', 'H-12'],
  ['Bash', `ruby <<'RB'\nFile.write('.claude/hooks/guard.mjs', '')\nRB`, 'deny'],
  ['PowerShell', `@'\nrequire('fs').writeFileSync('.claude/settings.json','{}')\n'@ | node`, 'deny'],
  ['Bash', `cat payload.js | node`, 'deny', 'H-13'],
  ['Bash', `cat payload.py | python`, 'deny', 'H-13'],
  // --- casos opacos
  ['Bash', `node -e "$CODE"`, 'deny', 'H-13'],
  ['Bash', `node -e "require('fs').writeFileSync('$F','x')"`, 'deny', 'H-13'],
  ['Bash', `python -c "$(cat x.py)"`, 'deny', 'H-13'],
  ['Bash', `node -e "eval(Buffer.from('ZnM=','base64').toString())"`, 'deny', 'H-13'],
  ['Bash', `python -c "exec(open('x.py').read())"`, 'deny', 'H-13'],
  ['Bash', `python -c "import base64; exec(base64.b64decode('cHJpbnQoMSk='))"`, 'deny', 'H-13'],
  ['Bash', `node -e "new Function(process.argv[1])()" x`, 'deny', 'H-13'],
  ['Bash', `node -e "require('child_process').execSync('touch CLAUDE.md')"`, 'deny', 'H-13'],
  // --- falsos positivos: lectura o código ajeno a los controles
  ['Bash', `node -e "console.log(require('fs').readFileSync('CLAUDE.md','utf8'))"`, 'allow'],
  ['Bash', `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('.claude/hooks/guard.mjs')).digest('hex'))"`, 'allow'],
  ['Bash', `python -c "print(open('.claude/settings.json').read())"`, 'allow'],
  ['Bash', `python -c "import re; print(re.compile('x').findall(open('CLAUDE.md').read()))"`, 'allow'],
  ['Bash', `node -e "console.log(1+1)"`, 'allow'],
  ['Bash', `node -e "require('fs').writeFileSync('out.txt','x')"`, 'allow'],
  ['Bash', `node -e "require('fs').writeFileSync('.claude/agents/x.md','x')"`, 'allow'],
  ['Bash', `node -e "require('fs').writeFileSync(require('path').join('.','settings.json'),'{}')"`, 'allow'],
  ['Bash', `python -c "import json; json.dump({}, open('backend/out.json','w'))"`, 'allow'],
  ['Bash', `python - <<'PY'\nprint('hola')\nPY`, 'allow'],
  ['Bash', `node -e "console.log('$HOME')"`, 'allow'],
  ['Bash', `node -e "eval('1+1')"`, 'allow'],
  ['Bash', `node -e "console.log(/a/.exec('a'))"`, 'allow'],
  ['Bash', `cat data.json | node script.js`, 'allow'],
  ['PowerShell', `node -e "console.log(require('fs').readFileSync('CLAUDE.md','utf8'))"`, 'allow'],
  // --- bloqueos previos que se mantienen
  ['Bash', `python -c "import scripts.sync_evolution_channel"`, 'deny', 'H-06'],
  ['Bash', `node -e "require('child_process').execSync('git push -f')"`, 'deny', 'H-13'],
  ['Bash', `python -c "print(open('.env').read())"`, 'deny', 'SEC'],
];

for (const [tool, cmd, expected, rule] of CASES) {
  test(`P0.2 ${tool === 'PowerShell' ? '[ps] ' : ''}${JSON.stringify(cmd)} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await run(tool, cmd);
    assert.equal(r.decision, expected, `${cmd} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
    if (rule) assert.equal(r.rule, rule, `${cmd} -> ${r.rule} (${r.msg})`);
  });
}

// Proceso real del hook: mismo veredicto por exit code (2 bloquea, 0 permite).
const guard = path.join(HOOKS, 'guard.mjs');
const ev = (tool, command) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: sub(command) }, cwd: root, permission_mode: 'default' });
const GUARD_CASES = [
  ['Bash', `node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`, 2, 'H-12'],
  ['Bash', `python -c "open('CLAUDE.md','w').write('x')"`, 2, 'H-12'],
  ['Bash', `python - <<'PY'\nimport shutil\nshutil.rmtree('.claude/hooks')\nPY`, 2, 'H-12'],
  ['PowerShell', `node -e "require('fs').unlinkSync('.claude${BSL}rules${BSL}governance.md')"`, 2, 'H-12'],
  ['Bash', `node -e "$CODE"`, 2, 'H-13'],
  ['Bash', `node -e "console.log(require('fs').readFileSync('CLAUDE.md','utf8'))"`, 0],
  ['Bash', `node -e "require('fs').writeFileSync('out.txt','x')"`, 0],
];
for (const [tool, cmd, status, rule] of GUARD_CASES) {
  test(`P0.2 guard.mjs ${tool === 'PowerShell' ? '[ps] ' : ''}${JSON.stringify(cmd)} => exit ${status}`, () => {
    const r = spawnSync(process.execPath, [guard], {
      input: ev(tool, cmd), encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, status, `stderr: ${r.stderr}`);
    if (rule) assert.match(r.stderr, new RegExp(`BLOQUEADO \\[${rule}\\]`));
    else assert.equal(r.stdout, '');
  });
}
