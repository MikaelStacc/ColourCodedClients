# Generates the extension's static icons: four colored quadrants on a rounded square.
# The toolbar icon is redrawn at runtime in the environment's own color; these are the
# fallback shown on non-BC tabs and in chrome://extensions.
#
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outputDir = Join-Path $PSScriptRoot '..\icons'
if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir | Out-Null }

$quadrants = @(
    [System.Drawing.ColorTranslator]::FromHtml('#D13438'),
    [System.Drawing.ColorTranslator]::FromHtml('#0078D4'),
    [System.Drawing.ColorTranslator]::FromHtml('#498205'),
    [System.Drawing.ColorTranslator]::FromHtml('#8764B8')
)

function New-RoundedPath {
    param([int]$Size, [int]$Radius)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($size in 16, 32, 48, 128) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $radius = [Math]::Max(2, [int]($size * 0.2))
    $path = New-RoundedPath -Size $size -Radius $radius
    $graphics.SetClip($path)

    $half = [int]($size / 2)
    $cells = @(
        @(0, 0), @($half, 0), @(0, $half), @($half, $half)
    )
    for ($i = 0; $i -lt 4; $i++) {
        $brush = New-Object System.Drawing.SolidBrush($quadrants[$i])
        $graphics.FillRectangle($brush, $cells[$i][0], $cells[$i][1], $size - $half, $size - $half)
        $brush.Dispose()
    }

    $graphics.Dispose()
    $path.Dispose()

    $target = Join-Path $outputDir "icon$size.png"
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Output "wrote $target"
}
