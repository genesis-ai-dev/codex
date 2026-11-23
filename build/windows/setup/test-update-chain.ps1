# Replay the released client's cache names and silent command lines twice per scope.
$ErrorActionPreference = 'Stop'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("codex update test " + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
$env:CODEX_UPDATE_FIXTURE = $fixture
$env:CODEX_UPDATE_ARCH = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$env:CODEX_UPDATE_READY = 'CodexTestReady-' + [guid]::NewGuid()
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    $env:TEMP = $fixture
    $env:TMP = $fixture
    foreach ($scope in 'user','system') {
        & $csc /nologo /codepage:65001 /main:RecordSetup "/out:$fixture\Recorder-$scope.exe" /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Setup.cs" "$PSScriptRoot\UpdateChainTests.cs"
        if ($LASTEXITCODE) { throw 'Recorder compilation failed' }
    }
    & node "$PSScriptRoot/share-payload.js" "$fixture/Recorder-user.exe" "$fixture/Recorder-system.exe" "$fixture/system.delta"
    if ($LASTEXITCODE) { throw 'Recorder packaging failed' }
    & $csc /nologo /codepage:65001 /main:UpdateChainTests "/out:$fixture\launcher.exe" "/resource:$fixture\Recorder-user.exe,user" "/resource:$fixture\system.delta,systemDelta" /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Setup.cs" "$PSScriptRoot\UpdateChainTests.cs"
    if ($LASTEXITCODE) { throw 'Launcher compilation failed' }
    foreach ($scope in 'user','system') {
        $cache = Join-Path $fixture "codex-stable-$scope-$env:CODEX_UPDATE_ARCH"
        New-Item -ItemType Directory -Path $cache | Out-Null
        foreach ($version in 'first','next') {
            $package = Join-Path $cache "CodeSetup-stable-$version.exe"
            Copy-Item "$fixture\launcher.exe" $package
            $tasks = '/mergetasks=runcode,!desktopicon,!quicklaunchicon'
            $flags = "/silent /log $tasks"
            $record = Join-Path $fixture "Recorder-$scope.txt"
            if (Test-Path $record) { Remove-Item -LiteralPath $record }
            if ($scope -eq 'user') {
                $marker = [IO.Path]::ChangeExtension($package, '.flag')
                Set-Content -LiteralPath $marker -Value flag
                $flags = "/verysilent /log /update=`"$marker`" /sessionend=`"$cache\session-ending.flag`" /nocloseapplications $tasks"
            }
            $child = Start-Process -FilePath $package -ArgumentList $flags -PassThru
            if ($scope -eq 'user') {
                $ready = $null
                for ($i = 0; $i -lt 200 -and !$child.HasExited; $i++) {
                    if ([Threading.Mutex]::TryOpenExisting($env:CODEX_UPDATE_READY, [ref]$ready)) { break }
                    Start-Sleep -Milliseconds 100
                }
                if (!$ready) { throw 'Background installation failed to signal readiness' }
                $ready.Dispose()
                Remove-Item -LiteralPath $marker
            }
            if (!$child.WaitForExit(30000) -or $child.ExitCode -ne 0) { throw "Update failed: $scope $version" }
            $received = [IO.File]::ReadAllLines($record)
            $dest = if ($scope -eq 'user') { Join-Path $fixture ('Utilisateur ' + [char]0x65e5 + [char]0x672c + [char]0x8a9e) } else { Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Codex' }
            if ($received -notcontains "/DIR=$dest" -or $received -notcontains $tasks) { throw 'Wrong destination or task arguments' }
            if ($scope -eq 'user' -and ($received -notcontains "/sessionend=$cache\session-ending.flag" -or $received -notcontains '/verysilent')) { throw 'Lost background flags' }
            if ($scope -eq 'system' -and $received -notcontains '/silent') { throw 'Lost silent flag' }
        }
    }
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    Remove-Item -Recurse -LiteralPath $fixture
}
