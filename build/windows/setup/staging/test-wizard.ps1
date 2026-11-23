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
    public void Click() { if (!PostMessage(Handle, 0xf5, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Could not click " + Text); }
}
'@
$assembly = [Reflection.Assembly]::LoadFile((Resolve-Path $Package).Path)
$setup = $assembly.GetType('Setup')
$methods = [Reflection.BindingFlags]'Static,NonPublic'
$payload = $setup.GetMethod('ExtractPayload', $methods).Invoke($null, @($assembly, $true))
$dest = Join-Path $env:TEMP ("CodexWizardTest-" + [guid]::NewGuid())
$flags = $setup.GetMethod('WizardFlags', $methods).Invoke($null, @($dest.PSObject.BaseObject))
try {
    if ($PlannedInstall) {
        $planner = $setup.GetMethod('ExtractPayload', $methods).Invoke($null, @($assembly, $false))
        $plan = [IO.Path]::GetTempFileName()
        try {
            [IO.File]::WriteAllLines($plan, @('[setup]', 'default=1', "system=$dest", "user=$dest-user"), [Text.Encoding]::Unicode)
            $child = Start-Process $planner -ArgumentList "/SP- /CodexPlan=`"$plan`" /LANG=english" -PassThru
            $pages = @('License Agreement','Select Installation Scope','Select Destination Location')
            foreach ($page in $pages) {
                $deadline = [DateTime]::UtcNow.AddSeconds(30)
                do {
                    Start-Sleep -Milliseconds 250
                    if ($child.HasExited) { throw "Planner exited before $page" }
                    $windows = [WizardWindow]::Visible([IntPtr]::Zero)
                    # A per-user Inno payload warns when launched by the elevated CI account.
                    foreach ($dialog in $windows | Where-Object { $_.Text -match 'Setup' -and $_.Class -ne 'TWizardForm' }) {
                        $controls = [WizardWindow]::Visible($dialog.Handle)
                        if ($controls.Text -match 'Administrator') {
                            ($controls | Where-Object Text -eq OK | Select-Object -First 1).Click()
                        }
                    }
                    $wizard = $windows | Where-Object Class -eq TWizardForm | Select-Object -First 1
                    if ($wizard) { $controls = [WizardWindow]::Visible($wizard.Handle) }
                } until (($wizard -and $controls.Text -contains $page) -or [DateTime]::UtcNow -gt $deadline)
                if (!$wizard -or $controls.Text -notcontains $page) { throw "Missing $page. Visible: $($controls.Text -join ', ')" }
                if ($page -eq 'License Agreement') {
                    ($controls | Where-Object Text -eq 'I accept the agreement' | Select-Object -First 1).Click()
                }
                ($controls | Where-Object { $_.Text -match '^Next(?: >)?$' } | Select-Object -First 1).Click()
            }
            if (!$child.WaitForExit(15000) -or $child.ExitCode -ne 2 -or
                ([IO.File]::ReadAllLines($plan) -join '|') -ne "system|$dest") { throw 'Wrong installation plan' }
            $flags += ' /CodexAcceptedLicense=1'
        } finally {
            if ($child -and !$child.HasExited) { & taskkill /PID $child.Id /T /F | Out-Null }
            Remove-Item -LiteralPath $planner,$plan
        }
    }
    $child = Start-Process -FilePath $payload -ArgumentList "$flags /LANG=english" -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $license = [bool]$PlannedInstall
    $tasks = $false
    do {
        Start-Sleep -Milliseconds 500
        if ($child.HasExited) { throw "Wizard exited early ($($child.ExitCode))" }
        $wizard = [WizardWindow]::Visible([IntPtr]::Zero) | Where-Object Class -eq TWizardForm | Select-Object -First 1
        if (!$wizard) { continue }
        $controls = [WizardWindow]::Visible($wizard.Handle)
        $labels = $controls.Text
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
