# Guard: refuse if code.gs is missing/deleted (EZPage sync once wiped it)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$codeGs = Join-Path $root 'code.gs'
if (-not (Test-Path -LiteralPath $codeGs)) {
  Write-Error 'FATAL: code.gs missing. Restore with: git restore code.gs'
  exit 1
}
$size = (Get-Item -LiteralPath $codeGs).Length
if ($size -lt 10000) {
  Write-Error ("FATAL: code.gs too small ({0} bytes). Restore before push." -f $size)
  exit 1
}
$st = & git -C $root status --porcelain -- code.gs 2>$null
if ($st -match '(?m)^D\s+code\.gs' -or $st -match '(?m)^ D\s+code\.gs') {
  Write-Error 'FATAL: code.gs is deleted in this change. Run: git restore --staged code.gs; git restore code.gs'
  exit 1
}
Write-Host ("OK: code.gs present ({0} bytes)" -f $size)
exit 0
