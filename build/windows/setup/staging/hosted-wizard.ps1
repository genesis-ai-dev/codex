param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'A disposable hosted runner is required' }
$root = (New-Item -ItemType Directory "$env:PUBLIC\CodexWizard-$([guid]::NewGuid())").FullName
Copy-Item $Package "$root\Setup.exe"
Copy-Item "$PSScriptRoot\test-wizard.ps1" $root
$user = 'CodexWizardQA'
$password = ConvertTo-SecureString (([guid]::NewGuid()).ToString() + 'xY!') -AsPlainText -Force
New-LocalUser $user -Password $password | Out-Null
$log = New-Item -ItemType File "$root\result.log"
$script = "$root\run.ps1"
@"
`$ErrorActionPreference = 'Stop'
`$env:RUNNER_ENVIRONMENT = 'github-hosted'
try { & '$root\test-wizard.ps1' -PlannedInstall -Package '$root\Setup.exe' *> '$log' }
catch { `$_.ToString() | Out-File '$log' -Append; exit 1 }
"@ | Set-Content $script
& icacls $root /grant ("${user}:(OI)(CI)(RX)") /T | Out-Null
& icacls $log.FullName /grant ("${user}:(M)") | Out-Null
# A secure desktop cannot be clicked by the test. Configure Windows to deny all
# standard-user elevation requests and exercise the real runas failure instead.
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$previous = (Get-ItemProperty $key).ConsentPromptBehaviorUser
try {
    Set-ItemProperty $key ConsentPromptBehaviorUser 0
    Start-Service seclogon
    $cred = [PSCredential]::new("$env:COMPUTERNAME\$user", $password)
    $p = Start-Process powershell.exe -Credential $cred -LoadUserProfile -WorkingDirectory $root -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
    if (!$p.WaitForExit(300000)) { throw 'Timed out exercising setup' }
    Get-Content $log
    if (!(Select-String -Quiet 'Verified a denied elevation' $log)) { throw 'Setup flow failed' }
} finally { Set-ItemProperty $key ConsentPromptBehaviorUser $previous }
