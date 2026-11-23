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
internal static partial class Setup {
    internal static int TestMachineWorker(string[] args) {
        if (args.Length > 0) return Main(args);
        ReadConfig();
        using (var worker = new Elevation(true, IntPtr.Zero)) {
            if (Directory.Exists(Destination(Inventory(true),true))) throw new Exception("Approval installed files before Install.");
            worker.Run("install", "associatewithfiles");
            worker.Run("cleanup");
        }
        VerifyProduct(Destination(Inventory(true),true),true,config["version"]);
        string previous = Destination(Inventory(true), true);
        using (var migration = new Elevation(false, IntPtr.Zero)) {
            if (!File.Exists(Path.Combine(previous, "Codex.exe"))) throw new Exception("Original was removed before migration.");
            InstallScope(false, "associatewithfiles");
            VerifyProduct(Destination(Inventory(),false),false,config["version"]);
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
} finally { Remove-Item -Recurse -Force $dir }
