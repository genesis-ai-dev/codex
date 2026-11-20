$ErrorActionPreference = 'Stop'
$test = Join-Path ([IO.Path]::GetTempPath()) ("codex-setup-test-" + [guid]::NewGuid() + ".exe")
try {
    & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe /main:SetupTests /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/out:$test" "$PSScriptRoot\Setup.cs" "$PSScriptRoot\SetupTests.cs"
    if ($LASTEXITCODE) { throw 'Test compilation failed' }
    & $test
    if ($LASTEXITCODE) { throw 'Installer checks failed' }
} finally { if (Test-Path $test) { Remove-Item -LiteralPath $test } }
