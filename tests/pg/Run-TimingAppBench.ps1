# Runs the PostgreSQL bench tests as timing_app - the Pi's own login - so its exact
# grants and the ONE PLACE trigger contract are proven, not just bench_app's.
#
# timing_app's password file is admin-only, so run this from an ELEVATED
# Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\tests\pg\Run-TimingAppBench.ps1" -Database whpp_bench_s26wpi -SqliteSnapshot "<sqlite file the clone was loaded from>"
#
# The password is never read here or printed: the test config only NAMES the file,
# and the pg client reads it. Refuses anything but a whpp_bench_* clone.
param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$SqliteSnapshot,
    [string]$PasswordFile = "C:\ProgramData\RT Technologies\pg\timing_app.txt",
    [string]$PgHost = "localhost",
    [int]$Port = 5432
)
$ErrorActionPreference = "Stop"
if ($Database -notmatch '^whpp_bench_[a-z0-9_]+$') { throw "Bench clones (whpp_bench_*) only - refusing '$Database'." }
if (-not (Test-Path -LiteralPath $SqliteSnapshot)) { throw "SQLite snapshot not found: $SqliteSnapshot" }
if (-not (Test-Path -LiteralPath $PasswordFile)) { throw "timing_app password file not found (run elevated?): $PasswordFile" }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outDir = Join-Path $repo "tests\pg\out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$config = Join-Path $outDir "timing_app.db-config.json"
$log = Join-Path $outDir ("timing_app-bench-" + (Get-Date -Format "yyyyMMdd-HHmm") + ".log")

@{
    engine = "pg"
    pg     = @{
        host = $PgHost; port = $Port; database = $Database; user = "timing_app"
        passwordFile = $PasswordFile
        keyFile = (Join-Path $outDir "no-rtmcs-key-for-tests")
    }
} | ConvertTo-Json -Depth 4 | Out-File -FilePath $config -Encoding ascii

Write-Host "*** Running the PostgreSQL bench tests as timing_app on $Database (about a minute)..."
$env:PG_BENCH_CONFIG = $config
$env:SQLITE_SCRATCH = $SqliteSnapshot
Push-Location $repo
try {
    $npx = (Get-Command npx.cmd).Source
    & $npx tsx --test --test-force-exit --test-timeout=240000 --test-concurrency=1 --test-reporter=spec tests/pg/bench.test.ts *> $log
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:PG_BENCH_CONFIG, Env:SQLITE_SCRATCH -ErrorAction SilentlyContinue
}
Get-Content -LiteralPath $log | Select-String -Pattern '^(\u2714|\u2716|\u2139 (pass|fail))' | ForEach-Object { $_.Line }
Write-Host "*** Done (exit $code). Full log: $log"
