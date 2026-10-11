# Windows PowerShell 5.1 entry point; preparation is always explicit.
[CmdletBinding()]
param(
    [switch]$Prepare,
    [switch]$PrintRoot,
    [switch]$PrintNode,
    [ValidateSet('auth', 'diagnose', 'register', 'unregister')][string]$RunScript,
    [string]$ScriptArgument
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Keep returned paths and JSON intact when a Windows user folder contains non-ASCII text.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$selected = [int]$Prepare.IsPresent + [int]$PrintRoot.IsPresent + [int]$PrintNode.IsPresent
if ($RunScript) { $selected++ }
if ($selected -gt 1) { throw 'Choose one bootstrap operation.' }
if ($PSBoundParameters.ContainsKey('ScriptArgument') -and $RunScript -ne 'auth') { throw 'Only auth accepts a group argument.' }
$scriptRoot = $PSScriptRoot
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..')).TrimEnd('\', '/')
$base = $env:ZAWAZAWA_HOME_DIR
if ([string]::IsNullOrEmpty($base)) { $base = Join-Path $env:LOCALAPPDATA 'ZAWAZAWA Moderation Review' }
if ($base -notmatch '^[A-Za-z]:[\\/]') { throw 'ZAWAZAWA_HOME_DIR must be an absolute local drive path.' }
$base = [IO.Path]::GetFullPath($base).TrimEnd('\', '/')
if ($base.Length -le 2) { throw 'ZAWAZAWA_HOME_DIR must be a dedicated folder.' }
if ($base.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $base.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $base -match '(?i)(^|[\\/])plugins[\\/]cache([\\/]|$)') {
    throw 'ZAWAZAWA_HOME_DIR must be outside the plugin/cache tree.'
}
# Refuse junctions/symlinks in the dedicated base ancestors before any download.
# This avoids a lexical outside-cache path redirecting into the source tree.
$ancestor = $base
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'ZAWAZAWA_HOME_DIR ancestors must be ordinary local directories.'
        }
    }
    $parent = [IO.Path]::GetDirectoryName($ancestor)
    if ($parent -eq $ancestor) { break }
    $ancestor = $parent
}
$env:ZAWAZAWA_HOME_DIR = $base
$env:ZAWAZAWA_RUNTIME_DIR = Join-Path $base 'runtimes'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $base 'browsers'
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
try { $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
switch ($architecture.ToLowerInvariant()) {
    'arm64' { $arch = 'arm64' }
    'amd64' { $arch = 'x64' }
    'x64' { $arch = 'x64' }
    default { throw 'Unsupported Windows architecture.' }
}
$release = Get-Content -LiteralPath (Join-Path $scriptRoot 'node-release.json') -Raw | ConvertFrom-Json
$version = $release.version
if ($version -ne '24.21.0') { throw 'Unsupported pinned Node version.' }
$checksum = $release."win-$arch"
if ($checksum -notmatch '^[a-f0-9]{64}$') { throw 'Invalid Node checksum.' }
$name = "node-v$version-win-$arch"
$nodeBase = Join-Path $base 'node'
$target = Join-Path $nodeBase "v$version-win-$arch"
$node = Join-Path $target 'node.exe'
$npmCli = Join-Path $target 'node_modules\npm\bin\npm-cli.js'
function Test-Ready {
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { return $false }
    try {
        $result = & $node --version 2>$null
        return ($LASTEXITCODE -eq 0 -and $result -eq "v$version")
    } catch { return $false }
}
if ($Prepare -and -not (Test-Ready)) {
    [IO.Directory]::CreateDirectory($nodeBase) | Out-Null
    $lock = $null
    $staging = $null
    try {
        $lockPath = $target + '.prepare-lock'
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while (-not $lock) {
            try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
            catch [IO.IOException] {
                if (Test-Ready) { break }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'Node preparation is busy; retry after the current preparation finishes.' }
                Start-Sleep -Milliseconds 250
            }
        }
        if ($lock -and -not (Test-Ready)) {
            $staging = Join-Path $nodeBase ('.node-staging.' + [Guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($staging) | Out-Null
            $archive = Join-Path $staging ($name + '.zip')
            [Console]::Error.WriteLine("Downloading official Node.js v$version ($arch).")
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$name.zip" -OutFile $archive
            $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $checksum) { throw 'Official Node archive checksum mismatch.' }
            $extract = Join-Path $staging 'extract'
            Expand-Archive -LiteralPath $archive -DestinationPath $extract
            $content = Join-Path $extract $name
            $preparedNode = Join-Path $content 'node.exe'
            if (-not (Test-Path -LiteralPath (Join-Path $content 'node_modules\npm\bin\npm-cli.js') -PathType Leaf)) { throw 'Bundled npm is missing.' }
            $preparedVersion = & $preparedNode --version
            if ($LASTEXITCODE -ne 0 -or $preparedVersion -ne "v$version") { throw 'Prepared Node version mismatch.' }
            if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $staging 'previous') }
            Move-Item -LiteralPath $content -Destination $target
        }
    } finally {
        if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
        if ($lock) { $lock.Dispose() }
        # Keep the empty lock file: deleting after close would race with the next owner.
    }
}
if (-not (Test-Ready)) { throw 'Dedicated Node is not prepared. Run the setup skill with explicit runtime preparation.' }
$launcher = Join-Path $scriptRoot 'runtime-launcher.mjs'
if ($Prepare) { & $node $launcher --prepare --npm-cli $npmCli }
elseif ($PrintNode) { [Console]::Out.WriteLine($node); exit 0 }
elseif ($PrintRoot) { & $node $launcher --print-root }
elseif ($RunScript) {
    if ($ScriptArgument) { & $node $launcher --run-script $RunScript $ScriptArgument }
    else { & $node $launcher --run-script $RunScript }
}
else { & $node $launcher }
exit $LASTEXITCODE
