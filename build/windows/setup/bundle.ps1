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
try {
    [IO.File]::WriteAllText($temp, ($config | ConvertTo-Json))
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /optimize+ /target:winexe /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32manifest:$PSScriptRoot\launcher.manifest" "/out:$compiled" "/resource:$temp,config" "/resource:$user,user" "/resource:$system,system" "$PSScriptRoot\Setup.cs"
    if ($LASTEXITCODE) { throw "Installer compilation failed ($LASTEXITCODE)" }
} finally { Remove-Item -LiteralPath $temp }
