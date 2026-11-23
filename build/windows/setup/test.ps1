$ErrorActionPreference = 'Stop'
$test = Join-Path ([IO.Path]::GetTempPath()) ("codex-setup-test-" + [guid]::NewGuid() + ".exe")
try {
    & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe "/win32icon:$PSScriptRoot/../../../src/stable/resources/win32/code.ico" "/win32manifest:$PSScriptRoot/launcher.manifest" /main:SetupTests /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/out:$test" "$PSScriptRoot\Setup.cs" "$PSScriptRoot\SetupTests.cs"
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
        $shared = New-Object byte[] (20MB)
        (New-Object Random 42).NextBytes($shared)
        foreach ($package in 'CodexSetup','CodexUserSetup') {
            $file = [IO.File]::Create((Join-Path $fixture "$package-$arch-1.2.3.exe"))
            try {
                $header = [Text.Encoding]::ASCII.GetBytes("$package-$arch")
                $file.Write($header, 0, $header.Length)
                $file.Write($shared, 0, $shared.Length)
                $file.WriteByte($header.Length)
            } finally { $file.Dispose() }
        }
        & "$PSScriptRoot\bundle.ps1" -Arch $arch -Version 1.2.3 -ProductPath $productPath -Assets $fixture
        $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $fixture "CodexInstall-$arch-1.2.3.exe")))
        $reader = New-Object IO.StreamReader($assembly.GetManifestResourceStream('config'))
        try { $embedded = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($embedded.arch -ne $arch -or $embedded.version -ne '1.2.3' -or $embedded.win32UserAppId -ne $product.win32UserAppId) { throw 'Wrong bundle configuration' }
    }
} finally { Remove-Item -Recurse -LiteralPath $fixture }
