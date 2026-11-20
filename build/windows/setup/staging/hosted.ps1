# Intended only for a fresh, ephemeral GitHub Windows x64 runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable GitHub-hosted runner required' }
$root = Join-Path $env:PUBLIC ('CodexStage-' + [Guid]::NewGuid())
& "$PSScriptRoot\prepare.ps1" $root
$offer = Join-Path $root 'offer'
Set-Content $offer 1.108.12734 -Encoding Ascii
$server = Start-Process python -ArgumentList "-u `"$PSScriptRoot\serve.py`" `"$root`"" -PassThru -RedirectStandardError "$root\feed.log"
try {
    # Keep a genuine all-users installation alongside the user copy. It must survive both transitions.
    $version = '1.108.12374'
    $machineRoot = "$env:ProgramFiles\Codex"
    if (Test-Path $machineRoot) { throw 'Machine destination already exists' }
    $system = Start-Process "$root\$version\CodexSetup-x64-$version.exe" -ArgumentList '/SP- /VERYSILENT /NORESTART /MERGETASKS="!runcode,!addtopath"' -PassThru -Wait
    if ($system.ExitCode) { throw 'System seed installation failed' }
    $machineManifest = "$machineRoot\resources\app\product.json"
    $before = (Get-FileHash $machineManifest).Hash
    $account = 'CodexStagingQA'
    $secret = [guid]::NewGuid().ToString() + 'aA!1'
    New-LocalUser $account -Password (ConvertTo-SecureString $secret -AsPlainText -Force) | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account -ErrorAction SilentlyContinue
    $log = Join-Path $root 'client.log'
    New-Item -ItemType File $log | Out-Null
    foreach ($file in $log,$offer) {
        & icacls $file /grant ("${account}:(M)") | Out-Null
        if ($LASTEXITCODE) { throw 'Could not grant fixture access' }
    }
    # The checkout ACL belongs to the runner; give the test account read-only access to a copy.
    $scripts = New-Item -ItemType Directory -Path "$root\scripts"
    Copy-Item "$PSScriptRoot\client.ps1","$PSScriptRoot\driver.js" $scripts
    $principal = "$env:COMPUTERNAME\$account"
    & icacls $root /grant ("${principal}:(OI)(CI)(RX)") /T | Out-Null
    if ($LASTEXITCODE) { throw 'Could not grant staging read access' }
    $script = "$scripts\client.ps1"
    $runner = Join-Path $root 'run.ps1'
    @"
`$ErrorActionPreference = 'Stop'
`$env:CODEX_DISPOSABLE_UPDATE_TEST = '1'
try {
    Write-Output 'Starting standard-user update test' | Out-File '$log' -Encoding unicode
    & '$script' -Directory '$root' *>> '$log'
    exit 0
} catch { (`$_.Exception.ToString() + `$_.ScriptStackTrace) | Out-File '$log' -Append -Encoding unicode; exit 1 }
"@ | Set-Content $runner
    & icacls $runner /grant ("${principal}:(RX)") | Out-Null
    Start-Service seclogon
    $credential = [PSCredential]::new($principal, (ConvertTo-SecureString $secret -AsPlainText -Force))
    $testProcess = Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WorkingDirectory $root -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
    if (!$testProcess.WaitForExit(840000)) { throw 'Standard-user staging client timed out' }
    Get-Content $log
    if (($null -ne $testProcess.ExitCode -and $testProcess.ExitCode -ne 0) -or !(Select-String -Quiet -SimpleMatch 'Verified user installation 1.108.13184' $log)) {
        throw "Live update test failed (client exit $($testProcess.ExitCode))"
    }
    if ((Get-FileHash $machineManifest).Hash -ne $before) { throw 'User update changed the system installation' }
} finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    Get-Content "$root\feed.log" -ErrorAction SilentlyContinue
}
