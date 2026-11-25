# Exercise the real Inno pages on a fresh Windows runner. Stop on Ready to Install.
param([Parameter(Mandatory)][string]$Package, [switch]$PlannedInstall)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'A disposable hosted runner is required' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class WizardWindow {
    private delegate bool Visit(IntPtr hwnd, IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr ctx);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visit cb, IntPtr ctx);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr count, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    public bool Enabled { get { return IsWindowEnabled(Handle); } }
    public IntPtr Handle;
    public string Class, Text;
    public static WizardWindow[] Visible(IntPtr parent) {
        var list = new List<WizardWindow>();
        Visit visit = delegate(IntPtr hwnd, IntPtr ctx) {
            if (IsWindowVisible(hwnd)) {
                var name = new StringBuilder(256);
                GetClassName(hwnd, name, name.Capacity);
                var text = new StringBuilder(4096);
                IntPtr count;
                SendMessageTimeout(hwnd, 13, (IntPtr)text.Capacity, text, 2, 500, out count);
                list.Add(new WizardWindow {Handle=hwnd, Class=name.ToString(), Text=text.ToString().Replace("&", "")});
            }
            return true;
        };
        if (parent == IntPtr.Zero) EnumWindows(visit, IntPtr.Zero);
        else EnumChildWindows(parent, visit, IntPtr.Zero);
        return list.ToArray();
    }
    public void Key(int key) {
        PostMessage(Handle, 0x100, (IntPtr)key, IntPtr.Zero);
        PostMessage(Handle, 0x101, (IntPtr)key, IntPtr.Zero);
    }
    public void Click() { if (!PostMessage(Handle, 0xf5, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Could not click " + Text); }
}
'@
if ($PlannedInstall) {
    $child = Start-Process $Package -PassThru
    function Wait-Page([string]$page) {
        $deadline = [DateTime]::UtcNow.AddMinutes(2)
        do {
            Start-Sleep -Milliseconds 200
            $windows = [WizardWindow]::Visible([IntPtr]::Zero)
            foreach ($dialog in ($windows | Where-Object Text -eq 'Codex Translation Editor Setup')) {
                $message = [WizardWindow]::Visible($dialog.Handle)
                throw "Launcher dialog while waiting for $page. $($message.Text -join ', ')"
            }
            foreach ($window in ($windows | Where-Object Class -eq TWizardForm)) {
                $controls = [WizardWindow]::Visible($window.Handle)
                if ($controls.Text -contains $page) {
                    if ($script:wizardHandle -and $script:wizardHandle -ne $window.Handle) { throw 'Setup replaced the wizard window' }
                    $script:wizardHandle = $window.Handle
                    return $controls
                }
            }
        } until ($child.HasExited -or [DateTime]::UtcNow -ge $deadline)
        throw "Did not reach $page. Windows: $($windows.Text -join ', '). Controls: $($controls.Text -join ', ')"
    }
    function Press($controls, $label) {
        ($controls | Where-Object Text -eq $label | Select-Object -First 1).Click()
    }
    function Next-Page($controls) {
        ($controls | Where-Object { $_.Text -match '^Next(?: >)?$' } | Select-Object -First 1).Click()
    }
    try {
        $controls = Wait-Page 'License Agreement'
        Press $controls 'I accept the agreement'
        Next-Page $controls
        $controls = Wait-Page 'Select Installation Scope'
        $list = $controls | Where-Object Class -eq TNewCheckListBox | Select-Object -First 1
        $list.Key(35); $list.Key(32) # End, Space: All Users
        Start-Sleep -Milliseconds 300
        Next-Page $controls
        Start-Sleep -Seconds 3
        $controls = Wait-Page 'Select Installation Scope'
        $list.Key(36); $list.Key(32) # Home, Space: Current User
        Start-Sleep -Milliseconds 300
        Next-Page $controls
        $controls = Wait-Page 'Select Additional Tasks'
        $defaults = $controls | Where-Object Text -eq 'Restore defaults'
        if (!$defaults -or $defaults.Enabled) { throw 'Restore should start disabled at defaults' }
        $tasks = $controls | Where-Object Class -eq TNewCheckListBox | Select-Object -First 1
        $tasks.Key(35); $tasks.Key(32)
        Start-Sleep -Milliseconds 300
        if (!$defaults.Enabled) { throw 'Changing a task should enable Restore' }
        $defaults.Click()
        Start-Sleep -Milliseconds 300
        if ($defaults.Enabled) { throw 'Restoring defaults should disable Restore' }
        $tasks.Key(35); $tasks.Key(32)
        Start-Sleep -Milliseconds 300
        if (!$defaults.Enabled) { throw 'Expected a non-default task before going back' }
        ($controls | Where-Object { $_.Text -match 'Back$' } | Select-Object -First 1).Click()
        $controls = Wait-Page 'Select Installation Scope'
        Next-Page $controls
        $controls = Wait-Page 'Select Additional Tasks'
        if (($controls | Where-Object Text -eq 'Restore defaults').Enabled) { throw 'Back did not reset tasks' }
        Next-Page $controls
        $controls = Wait-Page 'Ready to Install'
        $window = [WizardWindow]::Visible([IntPtr]::Zero) | Where-Object Handle -eq $script:wizardHandle
        if ($window.Text -ne 'Setup - Codex') { throw "Unexpected setup title: $($window.Text)" }
        $summary = ($controls.Text -join [Environment]::NewLine)
        if (!$summary.Contains("$env:LOCALAPPDATA\Programs\Codex") -or $summary -notmatch 'Start Menu folder:\s+Codex') {
            throw "Missing target or Start Menu folder in summary: $summary"
        }
        Press $controls 'Install'
        $deadline = [DateTime]::UtcNow.AddMinutes(2)
        do {
            Start-Sleep -Milliseconds 100
            $progress = [WizardWindow]::Visible($script:wizardHandle)
            $filename = $progress.Text | Where-Object { $_ -like "$env:LOCALAPPDATA\Programs\Codex\*" }
            if ($filename) { break }
        } while (!$child.HasExited -and $progress.Text -notcontains 'Completing the Codex Setup Wizard' -and [DateTime]::UtcNow -lt $deadline)
        if (!$filename) { throw "Wizard never showed the extraction filename. Last controls: $($progress.Text -join ', ')" }
        $controls = Wait-Page 'Completing the Codex Setup Wizard'
        Press $controls 'Launch Codex' # uncheck
        Press $controls 'Finish'
        if (!$child.WaitForExit(45000)) {
            $windows = [WizardWindow]::Visible([IntPtr]::Zero)
            $visible = foreach ($w in ($windows | Where-Object { $_.Text -match 'Codex|Setup' })) {
                "$($w.Text): $(([WizardWindow]::Visible($w.Handle)).Text -join ', ')"
            }
            throw "Launcher still running: $visible"
        }
        if ($child.ExitCode -ne 0) { throw "Launcher returned $($child.ExitCode)" }
        $manifest = Get-Content "$env:LOCALAPPDATA\Programs\Codex\resources\app\product.json" -Raw | ConvertFrom-Json
        if ($manifest.target -ne 'user') { throw 'Wrong installed scope' }
        # Seed a previous desktop-icon choice in this disposable account.
        $uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
        $registration = @(Get-ChildItem $uninstall | Where-Object {
            ([string]$_.GetValue('InstallLocation')).TrimEnd('\') -eq "$env:LOCALAPPDATA\Programs\Codex"
        })
        if ($registration.Count -ne 1) { throw 'Expected one Current User registration' }
        Set-ItemProperty $registration[0].PSPath 'Inno Setup: Selected Tasks' 'desktopicon,associatewithfiles,addtopath'
        Set-ItemProperty $registration[0].PSPath 'Inno Setup: Deselected Tasks' 'addcontextmenufiles,addcontextmenufolders'
        $script:wizardHandle = $null
        $child = Start-Process $Package -PassThru
        $controls = Wait-Page 'License Agreement'
        Press $controls 'I accept the agreement'
        Next-Page $controls
        $controls = Wait-Page 'Select Installation Scope'
        Next-Page $controls
        foreach ($previous in @('Select Installation Scope','Ready to Install')) {
            $controls = Wait-Page 'Select Additional Tasks'
            $defaults = $controls | Where-Object Text -eq 'Restore defaults'
            if (!$defaults.Enabled) { throw 'Expected saved desktop-icon choice' }
            $defaults.Click()
            Start-Sleep -Milliseconds 300
            if ($defaults.Enabled) { throw 'Expected temporary default choices' }
            if ($previous -eq 'Ready to Install') {
                Next-Page $controls
                $controls = Wait-Page $previous
            }
            ($controls | Where-Object { $_.Text -match 'Back$' } | Select-Object -First 1).Click()
            if ($previous -eq 'Select Installation Scope') {
                $controls = Wait-Page $previous
                Next-Page $controls
            }
        }
        $controls = Wait-Page 'Select Additional Tasks'
        if (!($controls | Where-Object Text -eq 'Restore defaults').Enabled) { throw 'Review lost the saved desktop-icon choice' }
        Write-Output "Verified a denied elevation and a Current User install in one wizard ($script:wizardHandle)"
    } finally {
        if (!$child.HasExited) { & taskkill /PID $child.Id /T /F | Out-Null }
    }
    return
}
$assembly = [Reflection.Assembly]::LoadFile((Resolve-Path $Package).Path)
$setup = $assembly.GetType('Setup')
$methods = [Reflection.BindingFlags]'Static,NonPublic'
$payload = $setup.GetMethod('ExtractPayload', $methods).Invoke($null, @($assembly, $true))
$dest = Join-Path $env:TEMP ("CodexWizardTest-" + [guid]::NewGuid())
$flags = $setup.GetMethod('WizardFlags', $methods).Invoke($null, @($dest.PSObject.BaseObject))
try {
    $child = Start-Process -FilePath $payload -ArgumentList "$flags /LANG=english" -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $license = $false
    $tasks = $false
    do {
        Start-Sleep -Milliseconds 500
        if ($child.HasExited) { throw "Wizard exited early ($($child.ExitCode))" }
        $wizard = [WizardWindow]::Visible([IntPtr]::Zero) | Where-Object Class -eq TWizardForm | Select-Object -First 1
        if (!$wizard) { continue }
        $controls = [WizardWindow]::Visible($wizard.Handle)
        $labels = $controls.Text
        if ($PlannedInstall -and $labels -contains 'Select Destination Location') { throw 'Unexpected destination prompt' }
        if ($labels -contains 'Ready to Install') { break }
        if ($labels -contains 'License Agreement') {
            if ($PlannedInstall) { throw 'Repeated license after handoff' }
            ($controls | Where-Object Text -eq 'I accept the agreement' | Select-Object -First 1).Click()
            $license = $true
        }
        if ($labels -contains 'Select Additional Tasks') {
            if (!$license -or !($controls | Where-Object Class -eq TNewCheckListBox)) { throw 'Missing license or tasks checklist' }
            $tasks = $true
        }
        $next = $controls | Where-Object { $_.Text -match '^Next(?: >)?$' } | Select-Object -First 1
        if ($next) { $next.Click() }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$license -or !$tasks -or $labels -notcontains 'Ready to Install') {
        throw "Expected license, additional tasks and ready pages. Last controls: $($labels -join ', ')"
    }
    ($controls | Where-Object Text -eq Cancel | Select-Object -First 1).Click()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!$child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $dialogs = [WizardWindow]::Visible([IntPtr]::Zero) | Where-Object { $_.Text -match 'Setup' -and $_.Class -ne 'TWizardForm' }
        foreach ($dialog in $dialogs) {
            $yes = [WizardWindow]::Visible($dialog.Handle) | Where-Object Text -eq Yes | Select-Object -First 1
            if ($yes) { $yes.Click() }
        }
    }
    if (!$child.HasExited -or $child.ExitCode -ne 2 -or (Test-Path "$dest\Codex.exe")) { throw 'Wizard did not cancel cleanly' }
    Write-Host 'Verified License Agreement, Select Additional Tasks, Ready to Install and cancellation.'
} finally {
    if ($child -and !$child.HasExited) { & taskkill /PID $child.Id /T /F | Out-Null }
    Remove-Item -LiteralPath $payload
}
