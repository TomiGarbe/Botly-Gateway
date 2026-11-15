// Análisis de PowerShell con el AST nativo (ps-parse.ps1, sólo ParseInput: no ejecuta el comando).
// Devuelve la misma IR que bash.mjs para que policy.mjs aplique las mismas reglas.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS_PARSE = path.join(HERE, '..', 'ps-parse.ps1');

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function toWord(e) {
  if (!e) return { text: null, raw: '', approx: '', quoted: false, glob: false };
  const text = e.text ?? null;
  return {
    text,
    raw: e.raw ?? '',
    approx: e.approx ?? e.raw ?? '',
    quoted: !!e.quoted,
    glob: !e.quoted && text !== null && /[*?[]/.test(text),
    param: !!e.param,
    argument: e.argument ? toWord(e.argument) : null,
    items: e.items ? arr(e.items).map(toWord) : null,
  };
}

/** Parsea texto PowerShell. Lanza si powershell.exe falla (el hook falla cerrado). */
export function parsePowerShell(text) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', PS_PARSE],
    { input: text, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const j = JSON.parse(out);
  const commands = arr(j.commands).map((c) => ({
    shell: 'ps',
    words: arr(c.elements).map(toWord),
    assigns: [],
    redirects: arr(c.redirects).map((r) => ({ op: r.op, target: toWord(r.target), write: true, heredoc: null, herestring: null })),
    invocation: c.invocation,
    inFunction: !!c.inFunction,
    inScriptBlock: !!c.inScriptBlock,
    stdin: c.stdin && c.stdin.kind ? c.stdin : { kind: 'none', text: '' },
    source: c.source,
  }));
  return {
    hasError: (j.errors ?? 0) > 0,
    commands,
    opaque: arr(j.opaque),
    assigns: arr(j.assigns).map((a) => ({ name: a.name, drive: a.drive, value: a.value ? toWord(a.value) : null })),
    strings: arr(j.strings).map(String),
  };
}
