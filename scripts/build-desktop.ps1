[CmdletBinding()]
param([switch]$Launch, [switch]$Force)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$Sources = @(Get-ChildItem -LiteralPath (Join-Path $Root 'desktop') -Filter '*.cs' -File | Sort-Object Name | Select-Object -ExpandProperty FullName)
$Manifest = Join-Path $Root 'desktop\app.manifest'
$Target = Join-Path $Root '梨花下载器.exe'
$Staged = Join-Path $Root '梨花下载器.new.exe'
foreach ($candidate in @($Target, $Staged)) {
    if ((Split-Path ([IO.Path]::GetFullPath($candidate)) -Parent) -ne $Root) { throw 'Unexpected desktop build path.' }
}
$latestSource = @($Sources) + @($Manifest, $PSCommandPath) | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object -Descending | Select-Object -First 1
if ($Force -or -not (Test-Path -LiteralPath $Target) -or (Get-Item -LiteralPath $Target).LastWriteTimeUtc -lt $latestSource) {
    $Compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $Compiler)) { throw 'The Windows .NET Framework desktop compiler is unavailable.' }
    $Bin = Join-Path $Root 'bin'
    New-Item -ItemType Directory -Path $Bin -Force | Out-Null
    $Icon = Join-Path $Bin 'desktop-icon.ico'
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object Drawing.Bitmap 64,64
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $shape = New-Object Drawing.Drawing2D.GraphicsPath
    $fill = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(0,113,227))
    $pen = New-Object Drawing.Pen ([Drawing.Color]::White),6
    $stream = New-Object IO.MemoryStream
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $shape.AddArc(1,1,20,20,180,90); $shape.AddArc(43,1,20,20,270,90)
        $shape.AddArc(43,43,20,20,0,90); $shape.AddArc(1,43,20,20,90,90); $shape.CloseFigure()
        $graphics.FillPath($fill,$shape)
        $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawLine($pen,32,15,32,41)
        $graphics.DrawLine($pen,21,31,32,42)
        $graphics.DrawLine($pen,32,42,43,31)
        $graphics.DrawLine($pen,19,51,45,51)
        $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
        $png = $stream.ToArray()
        $file = [IO.File]::Create($Icon)
        $writer = New-Object IO.BinaryWriter $file
        try {
            $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
            $writer.Write([byte]64); $writer.Write([byte]64); $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22)
            $writer.Write($png)
        } finally { $writer.Dispose() }
    } finally { $stream.Dispose(); $pen.Dispose(); $fill.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    if (Test-Path -LiteralPath $Staged) { Remove-Item -LiteralPath $Staged -Force }
    & $Compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/out:$Staged" "/win32icon:$Icon" "/win32manifest:$Manifest" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll @Sources
    if ($LASTEXITCODE -ne 0) { throw 'Desktop application build failed.' }
    try { Move-Item -LiteralPath $Staged -Destination $Target -Force }
    catch { throw 'Please close the existing desktop application before rebuilding it.' }
}
$RevealSource = Join-Path $Root 'scripts\reveal-file.cs'
$RevealExe = Join-Path $Root 'bin\reveal-file.exe'
if (-not (Test-Path -LiteralPath $RevealExe) -or (Get-Item -LiteralPath $RevealExe).LastWriteTimeUtc -lt (Get-Item -LiteralPath $RevealSource).LastWriteTimeUtc) {
    New-Item -ItemType Directory -Path (Join-Path $Root 'bin') -Force | Out-Null
    $Compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $Compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/out:$RevealExe" $RevealSource
    if ($LASTEXITCODE -ne 0) { throw 'Explorer helper build failed.' }
}
Write-Host "Desktop application ready: $Target"
if ($Launch) { Start-Process -FilePath $Target -WorkingDirectory $Root -WindowStyle Normal }
