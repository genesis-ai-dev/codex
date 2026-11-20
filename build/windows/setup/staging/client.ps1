param([Parameter(Mandatory)][string]$Directory, [ValidateSet('user','system')][string]$Scope='user', [switch]$Manual)
$ErrorActionPreference = 'Stop'
$versions = '1.108.12374','1.108.12734','1.108.13184'
$utf8 = New-Object Text.UTF8Encoding($false)
$app = if ($Scope -eq 'user') { "$env:LOCALAPPDATA\Programs\Codex" } else { "$env:ProgramFiles\Codex" }
if ($env:CODEX_DISPOSABLE_UPDATE_TEST -ne '1' -or (Test-Path $app)) { throw "Use a fresh disposable Windows account and VM. Occupied destination: $app" }
$prefix = if ($Scope -eq 'user') { 'CodexUserSetup' } else { 'CodexSetup' }
$original = Join-Path $Directory "$($versions[0])\$prefix-x64-$($versions[0]).exe"
$install = Start-Process $original -ArgumentList '/SP- /VERYSILENT /NORESTART /MERGETASKS="!runcode,!addtopath"' -PassThru -Wait
if ($install.ExitCode) { throw "Legacy installer failed ($($install.ExitCode))" }
$profile = "$env:LOCALAPPDATA\CodexStageProfile"
$extensions = "$env:LOCALAPPDATA\CodexStageExtensions"
$driver = New-Item -ItemType Directory -Path "$extensions\staging.driver-1.0.0"
New-Item -ItemType Directory -Path "$profile\User" | Out-Null
# The local driver explicitly requests each check. A relaunched original release cannot auto-check production.
# Inno may relaunch without our CLI arguments. Set manual mode in the disposable account's default settings too.
foreach ($settings in "$profile\User","$env:APPDATA\Codex\User") {
    [IO.Directory]::CreateDirectory($settings) | Out-Null
    [IO.File]::WriteAllText("$settings\settings.json", '{"update.mode":"manual","extensions.autoCheckUpdates":false,"extensions.autoUpdate":false}', $utf8)
}
Copy-Item "$PSScriptRoot\driver.js" $driver
[IO.File]::WriteAllText("$driver\package.json", '{"name":"driver","publisher":"staging","version":"1.0.0","engines":{"vscode":"^1.100.0"},"main":"./driver.js","activationEvents":["*"]}', $utf8)
$productPath = "$app\resources\app\product.json"
function Read-Product { Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json }
foreach ($i in 1,2) {
    $product = Read-Product
    if ($product.version -ne $versions[$i-1] -or $product.target -ne $Scope) { throw "Unexpected starting installation $($product.version) $($product.target)" }
    if ($Scope -eq 'system') {
        $redirect = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\point-system-to-loopback.ps1`" -ExpectedVersion $($product.version)"
        if ($redirect.ExitCode) { throw 'Could not configure the VM system installation to use the loopback feed' }
    } else {
        $product.updateUrl = 'http://127.0.0.1:18763'
        [IO.File]::WriteAllText($productPath, ($product | ConvertTo-Json -Depth 100), $utf8)
    }
    if ((Read-Product).updateUrl -ne 'http://127.0.0.1:18763') { throw 'Staging feed was not configured' }
    [IO.File]::WriteAllText("$Directory\offer", $versions[$i], [Text.Encoding]::ASCII)
    $env:CODEX_STAGE_LOG = "$env:TEMP\codex-driver-$i.log"
    $env:CODEX_STAGE_PREVIOUS = $versions[$i-1]
    if ($Manual) {
        $env:CODEX_STAGE_PREVIOUS = 'manual'
        Write-Host "Use Manage > Check for Updates, then Install/Restart to Update for $($versions[$i])."
    }
    Start-Process "$app\Codex.exe" -ArgumentList "--no-sandbox --disable-gpu --user-data-dir=`"$profile`" --extensions-dir=`"$extensions`""
    $started = [DateTime]::UtcNow
    $minutes = if ($Manual) { 15 } else { 5 }
    $deadline = $started.AddMinutes($minutes)
    do {
        Start-Sleep 2
        if (!$Manual) {
            $errors = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'CodexUpdateError-*.log' | Where-Object LastWriteTimeUtc -gt $started)
            if ($errors.Count) { throw (Get-Content $errors[0].FullName -Raw) }
        }
        try { $current = Read-Product } catch { $current = $null }
    } until (($current -and $current.version -eq $versions[$i]) -or [DateTime]::UtcNow -ge $deadline)
    if (!$current -or $current.version -ne $versions[$i] -or $current.target -ne $Scope) {
        if (Test-Path $env:CODEX_STAGE_LOG) { Get-Content $env:CODEX_STAGE_LOG }
        Get-ChildItem "$profile\logs" -Recurse -Filter main.log | ForEach-Object { Get-Content $_.FullName -Tail 30 }
        throw "Client did not apply $($versions[$i]) to $Scope"
    }
    # Wait for the installer to finish, including relaunch, before the next test session.
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
        Start-Sleep 2
        $launcher = Get-Process -Name "CodeSetup-stable-$((Get-Content "$Directory\$($versions[$i])\feed.json" -Raw | ConvertFrom-Json).version)" -ErrorAction SilentlyContinue
    } while ($launcher -and [DateTime]::UtcNow -lt $deadline)
    if ($launcher) { throw 'Update launcher did not exit' }
    Get-Process -Name Codex -ErrorAction SilentlyContinue | Where-Object Path -eq "$app\Codex.exe" | Stop-Process -Force
    Write-Output "Verified $Scope installation $($current.version) at $app"
}
