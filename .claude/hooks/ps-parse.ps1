# Analiza (NO ejecuta) un comando PowerShell con el parser nativo y devuelve JSON por stdout.
# Entrada: el texto del comando por stdin (UTF-8). Lo invoca lib/powershell.mjs.
# Sólo usa System.Management.Automation.Language.Parser::ParseInput: no evalúa nada del comando.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = [Console]::In.ReadToEnd()

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
$L = 'System.Management.Automation.Language'

function Lit($e) {
  if ($null -eq $e) { return $null }
  $raw = $e.Extent.Text
  if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return @{ text = [string]$e.Value; raw = $raw; approx = [string]$e.Value; quoted = ($e.StringConstantType.ToString() -ne 'BareWord') }
  }
  if ($e -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    $t = $null
    if ($e.NestedExpressions.Count -eq 0) { $t = [string]$e.Value }
    return @{ text = $t; raw = $raw; approx = [string]$e.Value; quoted = $true }
  }
  if ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return @{ text = [string]$e.Value; raw = $raw; approx = [string]$e.Value; quoted = $false }
  }
  if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
    $t = '-' + $e.ParameterName
    $r = @{ text = $t; raw = $raw; approx = $raw; quoted = $false; param = $true }
    if ($null -ne $e.Argument) {
      $a = Lit $e.Argument
      $r.argument = $a
      if ($null -eq $a.text) { $r.text = $null }
    }
    return $r
  }
  if ($e -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $items = New-Object System.Collections.ArrayList
    $allLit = $true
    foreach ($x in $e.Elements) { $li = Lit $x; [void]$items.Add($li); if ($null -eq $li.text) { $allLit = $false } }
    $t = $null
    if ($allLit) { $t = ($items | ForEach-Object { $_.text }) -join ' ' }
    return @{ text = $t; raw = $raw; approx = $raw; quoted = $true; items = $items }
  }
  return @{ text = $null; raw = $raw; approx = $raw; quoted = $false; kind = $e.GetType().Name }
}

function HasAncestor($node, [string]$typeName) {
  $p = $node.Parent
  while ($null -ne $p) { if ($p.GetType().Name -eq $typeName) { return $true }; $p = $p.Parent }
  return $false
}

$commands = New-Object System.Collections.ArrayList
foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  $els = New-Object System.Collections.ArrayList
  foreach ($e in $c.CommandElements) { [void]$els.Add((Lit $e)) }
  $reds = New-Object System.Collections.ArrayList
  foreach ($r in $c.Redirections) {
    if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) {
      $op = '>'
      if ($r.Append) { $op = '>>' }
      [void]$reds.Add(@{ op = $op; target = (Lit $r.Location); write = $true })
    }
  }
  $stdin = @{ kind = 'none'; text = '' }
  $pl = $c.Parent
  if ($pl -is [System.Management.Automation.Language.PipelineAst]) {
    $idx = $pl.PipelineElements.IndexOf($c)
    if ($idx -gt 0) {
      $prev = $pl.PipelineElements[$idx - 1]
      $stdin = @{ kind = 'dynamic'; text = $prev.Extent.Text }
      if ($prev -is [System.Management.Automation.Language.CommandExpressionAst]) {
        $pv = Lit $prev.Expression
        if ($null -ne $pv.text) { $stdin = @{ kind = 'literal'; text = $pv.text } }
      } elseif ($prev -is [System.Management.Automation.Language.CommandAst]) {
        $pn = $prev.GetCommandName()
        if ($pn -in @('echo', 'Write-Output', 'write')) {
          $parts = @()
          $ok = $true
          for ($i = 1; $i -lt $prev.CommandElements.Count; $i++) {
            $li = Lit $prev.CommandElements[$i]
            if ($null -eq $li.text) { $ok = $false } else { $parts += $li.text }
          }
          if ($ok) { $stdin = @{ kind = 'literal'; text = ($parts -join ' ') } }
        }
      }
    }
  }
  [void]$commands.Add(@{
      elements    = $els
      invocation  = $c.InvocationOperator.ToString()
      redirects   = $reds
      inFunction  = (HasAncestor $c 'FunctionDefinitionAst')
      inScriptBlock = (HasAncestor $c 'ScriptBlockExpressionAst')
      stdin       = $stdin
      source      = $c.Extent.Text
    })
}

$opaque = New-Object System.Collections.ArrayList
foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
  $name = $m.Member.Extent.Text
  [void]$opaque.Add(@{ member = $name; target = $m.Expression.Extent.Text; static = $m.Static })
}

$assigns = New-Object System.Collections.ArrayList
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
  if ($a.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
    $vp = $a.Left.VariablePath
    $val = $null
    if ($a.Right -is [System.Management.Automation.Language.CommandExpressionAst]) { $val = Lit $a.Right.Expression }
    [void]$assigns.Add(@{ name = $vp.UserPath; drive = $vp.DriveName; value = $val })
  }
}

# Cadenas literales fuera de los elementos de un comando (p. ej. argumentos de métodos .NET).
$strings = New-Object System.Collections.ArrayList
foreach ($s in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true)) {
  if ($s.Parent -is [System.Management.Automation.Language.CommandAst]) { continue }
  if ($s.Parent -is [System.Management.Automation.Language.CommandParameterAst]) { continue }
  [void]$strings.Add([string]$s.Value)
}

$out = @{
  errors   = $errors.Count
  commands = $commands
  opaque   = $opaque
  assigns  = $assigns
  strings  = $strings
}
[Console]::Out.Write(($out | ConvertTo-Json -Depth 12 -Compress))
