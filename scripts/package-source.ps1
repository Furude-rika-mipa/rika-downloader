[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$Root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $Root 'dist' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
Push-Location -LiteralPath $Root
try {
    $dirty = git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the reviewed source first. Packaging requires a clean Git worktree.' }
    $commit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Git revision lookup failed.' }
    # Export only this tool when it lives inside a multi-tool repository.
    $repositoryRoot = (git rev-parse --show-toplevel).Trim()
    $prefix = (git rev-parse --show-prefix).Trim().TrimEnd('/')
    $tree = if ($prefix) { $commit + ':' + $prefix } else { $commit }
    $files = @(git -C $repositoryRoot -c core.quotepath=false ls-tree -r --name-only $tree)
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $archive = Join-Path $OutputDirectory 'video-downloader-windows-x64.zip'
    if (Test-Path -LiteralPath $archive) { throw "An archive with this name already exists: $archive" }
    git -C $repositoryRoot archive --format=zip --prefix=video-downloader/ ('--output=' + $archive) $tree
    if ($LASTEXITCODE -ne 0) { throw 'Git source archive failed.' }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($archive + '.sha256', $hash + '  ' + [IO.Path]::GetFileName($archive) + "`n", [Text.Encoding]::ASCII)
    @{ file = $archive; commit = $commit; sha256 = $hash; bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json -Compress
} finally { Pop-Location }
