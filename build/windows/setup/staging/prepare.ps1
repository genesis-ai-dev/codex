param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
$versions = '1.108.12374','1.108.12734','1.108.13184'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $Directory -ErrorAction Stop | Out-Null
foreach ($version in $versions) {
    $release = Invoke-RestMethod "https://api.github.com/repos/genesis-ai-dev/codex/releases/tags/$version"
    $dir = New-Item -ItemType Directory -Path (Join-Path $Directory $version)
    foreach ($prefix in 'CodexSetup','CodexUserSetup') {
        $name = "$prefix-x64-$version.exe"
        $asset = @($release.assets | Where-Object name -eq $name)
        if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw "No verified release asset for $name" }
        $path = Join-Path $dir $name
        & curl.exe --fail --silent --show-error --location --retry 3 --output $path $asset[0].browser_download_url
        if ($LASTEXITCODE -or "sha256:$((Get-FileHash $path).Hash)" -ne $asset[0].digest) { throw "Invalid download for $name" }
    }
    if ($version -eq $versions[0]) { continue }
    # Pull the config from the corresponding released archive, including its actual commit.
    $zip = $release.assets | Where-Object name -eq "Codex-win32-x64-$version.zip"
    $archive = Join-Path $dir 'release.zip'
    & curl.exe --fail --silent --show-error --location --retry 3 --output $archive $zip.browser_download_url
    if ($LASTEXITCODE -or "sha256:$((Get-FileHash $archive).Hash)" -ne $zip.digest) { throw 'Archive digest mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $manifest = @($stream.Entries | Where-Object { $_.FullName -match '^(?:[^/]+/)?resources/app/product\.json$' })
        if ($manifest.Count -ne 1) { throw 'Expected one release product manifest' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($manifest[0], (Join-Path $dir 'product.json'))
    } finally { $stream.Dispose() }
    $product = Get-Content (Join-Path $dir 'product.json') -Raw | ConvertFrom-Json
    if ($product.version -ne $version -or $product.commit -notmatch '^[a-f0-9]{40}$') { throw 'Incorrect release identity' }
    & "$PSScriptRoot\..\bundle.ps1" -Arch x64 -Version $version -ProductPath (Join-Path $dir 'product.json') -Assets $dir.FullName
    $name = "CodexInstall-x64-$version.exe"
    $feed = @{name=$version; productVersion=$version; version=$product.commit; url="http://127.0.0.1:18763/$version/$name"; sha256hash=(Get-FileHash (Join-Path $dir $name)).Hash.ToLowerInvariant()}
    [IO.File]::WriteAllText((Join-Path $dir 'feed.json'), ($feed | ConvertTo-Json), $utf8)
}
