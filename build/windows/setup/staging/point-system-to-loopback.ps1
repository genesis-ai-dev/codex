# Run only in a disposable VM. Only the destination of update checks changes.
param([Parameter(Mandatory)][ValidateSet('1.108.12374','1.108.12734')][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
$path = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Codex\resources\app\product.json'
$product = Get-Content $path -Raw | ConvertFrom-Json
if ($product.win32AppUserModelId -ne 'Codex.Codex' -or $product.target -ne 'system' -or $product.version -ne $ExpectedVersion) {
    throw 'Unexpected staging installation'
}
$product.updateUrl = 'http://127.0.0.1:18763'
[IO.File]::WriteAllText($path, ($product | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
