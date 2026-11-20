$ErrorActionPreference = 'Stop'
$test = Join-Path ([IO.Path]::GetTempPath()) ("codex-setup-test-" + [guid]::NewGuid() + ".exe")
try {
    & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe /main:SetupTests /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/out:$test" "$PSScriptRoot\Setup.cs" "$PSScriptRoot\SetupTests.cs"
    if ($LASTEXITCODE) { throw 'Test compilation failed' }
    & $test
    if ($LASTEXITCODE) { throw 'Installer checks failed' }
} finally { if (Test-Path $test) { Remove-Item -LiteralPath $test } }

# Exercise the shipping packaging entry point without running either setup payload.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("codex-bundle-" + [guid]::NewGuid())
New-Item -Path $fixture -ItemType Directory | Out-Null
try {
    $product = @{ win32AppUserModelId = 'Codex.Codex' }
    foreach ($prefix in 'win32','win32x64','win32arm64') {
        foreach ($suffix in 'UserAppId','AppId') { $product[$prefix+$suffix] = '{{' + [guid]::NewGuid() + '}' }
    }
    $productPath = Join-Path $fixture 'product.json'
    $product | ConvertTo-Json | Set-Content -LiteralPath $productPath -Encoding UTF8
    foreach ($arch in 'x64','arm64') {
        foreach ($package in 'CodexSetup','CodexUserSetup') {
            [IO.File]::WriteAllText((Join-Path $fixture "$package-$arch-1.2.3.exe"), "$package-$arch")
        }
        & "$PSScriptRoot\bundle.ps1" -Arch $arch -Version 1.2.3 -ProductPath $productPath -Assets $fixture
        $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $fixture "CodexInstall-$arch-1.2.3.exe")))
        foreach ($payload in 'user','system','config') {
            $reader = New-Object IO.StreamReader($assembly.GetManifestResourceStream($payload))
            try { $contents = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($payload -eq 'config') {
                $embedded = $contents | ConvertFrom-Json
                if ($embedded.arch -ne $arch -or $embedded.version -ne '1.2.3' -or $embedded.win32UserAppId -ne $product.win32UserAppId) { throw 'Wrong bundle configuration' }
            } else {
                $expected = if ($payload -eq 'user') { "CodexUserSetup-$arch" } else { "CodexSetup-$arch" }
                if ($contents -ne $expected) { throw "Wrong $payload package for $arch" }
            }
        }
    }
} finally { Remove-Item -Recurse -LiteralPath $fixture }
