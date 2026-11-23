param(
    [Parameter(Mandatory)][ValidateSet('x64','arm64')][string]$Arch,
    [Parameter(Mandatory)][string]$Version,
    [string]$ProductPath = 'vscode/product.json',
    [string]$Assets = 'assets'
)
$ErrorActionPreference = 'Stop'
$product = Get-Content -LiteralPath $ProductPath -Raw | ConvertFrom-Json
if ($product.win32AppUserModelId -ne 'Codex.Codex') { throw 'Expected the stable Codex Translation Editor product.' }
$config = @{ arch = $Arch; version = $Version }
foreach ($prefix in 'win32','win32x64','win32arm64') {
    foreach ($suffix in 'UserAppId','AppId') {
        $field = $prefix + $suffix
        $value = $product.$field
        if ($value -notmatch '^\{\{[0-9A-Fa-f-]{36}\}$') { throw "Missing installer identity: $field" }
        $config[$field] = $value
    }
}
$compiled = Join-Path $Assets "CodexInstall-$Arch-$Version.exe"
$user = (Resolve-Path (Join-Path $Assets "CodexUserSetup-$Arch-$Version.exe")).Path
$system = (Resolve-Path (Join-Path $Assets "CodexSetup-$Arch-$Version.exe")).Path
$temp = [IO.Path]::GetTempFileName()
$delta = [IO.Path]::GetTempFileName()
try {
    & node "$PSScriptRoot/share-payload.js" $user $system $delta
    if ($LASTEXITCODE) { throw 'Could not share the Windows setup payload' }
    [IO.File]::WriteAllText($temp, ($config | ConvertTo-Json))
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /optimize+ /target:winexe /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32icon:$PSScriptRoot/../../../src/stable/resources/win32/code.ico" "/win32manifest:$PSScriptRoot\launcher.manifest" "/out:$compiled" "/resource:$temp,config" "/resource:$user,user" "/resource:$delta,systemDelta" "$PSScriptRoot\Setup.cs" "$PSScriptRoot\Interactive.cs"
    if ($LASTEXITCODE) { throw "Installer compilation failed ($LASTEXITCODE)" }

    $size = (Get-Item -LiteralPath $compiled).Length
    $single = [Math]::Max((Get-Item $system).Length, (Get-Item $user).Length)
    if ($size -gt $single + [Math]::Max(65536, $single * 0.02)) {
        throw "Combined installer is too large: $size bytes vs $single for a single scope."
    }
    # Exercise the shipping reconstruction code on every build, including signed inputs.
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($compiled))
    $write = $assembly.GetType('Setup').GetMethod('WritePayload', [Reflection.BindingFlags]'Static,NonPublic')
    foreach ($machine in $false,$true) {
        $original = if ($machine) { $system } else { $user }
        $hash = [Security.Cryptography.SHA256]::Create()
        $stream = [Security.Cryptography.CryptoStream]::new([IO.Stream]::Null, $hash, [Security.Cryptography.CryptoStreamMode]::Write)
        try {
            $write.Invoke($null, @($assembly, $machine, $stream.PSObject.BaseObject))
            $stream.FlushFinalBlock()
            if ([BitConverter]::ToString($hash.Hash).Replace('-', '') -ne (Get-FileHash $original).Hash) {
                throw "Installer reconstruction failed for $original"
            }
        } finally { $stream.Dispose(); $hash.Dispose() }
    }
    Write-Host "Combined installer: $size bytes. Largest scoped installer: $single bytes."
} finally { Remove-Item -LiteralPath $temp,$delta }
