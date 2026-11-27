# Exercise the real privileged operations inside a disposable already-elevated runner.
param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Test-Path "$env:ProgramFiles\Codex")) { throw 'Fresh hosted runner required' }
$dir = (New-Item -ItemType Directory "$env:TEMP\CodexWorkerTest-$([guid]::NewGuid())").FullName
try {
    $assembly = [Reflection.Assembly]::LoadFile((Resolve-Path $Package).Path)
    foreach ($name in 'config','user','systemDelta') {
        $inputStream = $assembly.GetManifestResourceStream($name)
        $output = [IO.File]::Create("$dir\$name")
        try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose(); $output.Dispose() }
    }
    @'
using System;
using System.IO;
using System.Linq;
internal static partial class Setup {
    internal static int TestMachineWorker(string[] args) {
        const string tasks = "desktopicon,addtopath,associatewithfiles,addcontextmenufiles,addcontextmenufolders";
        if (args.Length == 1 && args[0] == "reverse") {
            ReadConfig();
            var original = Inventory().Single(i => !i.Machine);
            using (var worker = new Elevation(true, IntPtr.Zero)) {
                worker.Run("install", tasks);
                RemoveOld(original);
                worker.Run("cleanup");
            }
            if (Inventory().Count != 1 || File.Exists(Path.Combine(original.Root, "Codex.exe")))
                throw new Exception("Current User installation survived migration.");
            return 0;
        }
        if (args.Length > 0 && args[0] != "forward") return Main(args);
        ReadConfig();
        if (args.Length == 0) using (var worker = new Elevation(true, IntPtr.Zero)) {
            if (Directory.Exists(Destination(Inventory(true),true))) throw new Exception("Approval installed files before Install.");
            worker.Run("install", tasks);
            worker.Run("cleanup");
        }
        VerifyProduct(Destination(Inventory(true),true),true,config["version"]);
        string previous = Destination(Inventory(true), true);
        using (var migration = new Elevation(false, IntPtr.Zero)) {
            if (!File.Exists(Path.Combine(previous, "Codex.exe"))) throw new Exception("Original was removed before migration.");
            InstallScope(false, tasks);
            VerifyProduct(Destination(Inventory(),false),false,config["version"]);
            string guard = Path.Combine(previous, "data");
            Directory.CreateDirectory(guard);
            bool refused = false;
            try { migration.Run("cleanup"); } catch (IOException) { refused = true; }
            if (!refused || !File.Exists(Path.Combine(previous, "Codex.exe")))
                throw new Exception("Unsafe cleanup was not refused.");
            VerifyProduct(Destination(Inventory(),false),false,config["version"]);
            Directory.Delete(guard);
            migration.Run("cleanup");
        }
        if (Inventory(true).Count != 0 || File.Exists(Path.Combine(previous, "Codex.exe")))
            throw new Exception("All Users installation survived migration.");
        return 0;
    }
}
internal static class WorkerTest {
    static int Main(string[] args) { return Setup.TestMachineWorker(args); }
}
'@ | Set-Content "$dir\WorkerTest.cs"
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /main:WorkerTest /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/resource:$dir\config,config" "/resource:$dir\user,user" "/resource:$dir\systemDelta,systemDelta" "/out:$dir\WorkerTest.exe" "$dir\WorkerTest.cs" "$PSScriptRoot\..\Setup.cs" "$PSScriptRoot\..\Interactive.cs"
    if ($LASTEXITCODE) { throw 'Worker test compilation failed' }
    & "$dir\WorkerTest.exe"
    if ($LASTEXITCODE) { throw 'Machine worker failed' }
    function Assert-Integrations([bool]$machine) {
        $hive = if ($machine) { 'HKLM:' } else { 'HKCU:' }
        $base = if ($machine) { $env:ProgramFiles } else { "$env:LOCALAPPDATA\Programs" }
        $dest = Join-Path $base Codex
        $product = Get-Content "$dest\resources\app\product.json" -Raw | ConvertFrom-Json
        $exe = Join-Path $dest 'Codex.exe'
        $scope = if ($machine) { 'Machine' } else { 'User' }
        if (([Environment]::GetEnvironmentVariable('Path', $scope) -split ';') -notcontains "$dest\bin") { throw "Missing $scope PATH entry" }
        $desktop = if ($machine) { 'CommonDesktopDirectory' } else { 'DesktopDirectory' }
        $menu = if ($machine) { 'CommonPrograms' } else { 'Programs' }
        $name = $product.nameLong
        $shell = New-Object -ComObject WScript.Shell
        foreach ($link in @("$( [Environment]::GetFolderPath($desktop) )\$name.lnk", "$( [Environment]::GetFolderPath($menu) )\$name\$name.lnk")) {
            if (!(Test-Path -LiteralPath $link) -or $shell.CreateShortcut($link).TargetPath -ne $exe) { throw "Wrong shortcut: $link" }
        }
        $id = $product.win32RegValueName
        foreach ($key in @("$id.ascx\shell\open", "*\shell\$id", "directory\shell\$id")) {
            $command = (Get-Item -LiteralPath "$hive\Software\Classes\$key\command").GetValue('')
            if (!$command.StartsWith('"' + $exe + '"', [StringComparison]::OrdinalIgnoreCase)) { throw "Wrong $scope association: $key" }
        }
    }
    foreach ($round in 1..5) {
        if ($round -gt 1) {
            & "$dir\WorkerTest.exe" forward
            if ($LASTEXITCODE) { throw "All Users to Current User failed in round $round" }
        }
        Assert-Integrations $false
        & "$dir\WorkerTest.exe" reverse
        if ($LASTEXITCODE) { throw "Current User to All Users failed in round $round" }
        Assert-Integrations $true
        Write-Host "Verified both migration directions in round $round"
    }
} finally { Remove-Item -Recurse -Force $dir }
