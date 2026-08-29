# Recreates the browser's annotated answer-sheet image in the test harness:
# the page scaled to the model's max edge, with a numbered gutter down the left.
# Reads fixtures/bands.json produced by scripts/detect-bands.mjs.

Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$bands = Get-Content (Join-Path $PSScriptRoot "bands.json") -Raw | ConvertFrom-Json

$GUTTER = 78
$MAX_EDGE = 1100

foreach ($page in $bands) {
    $srcPath = Join-Path $root $page.file
    $src = [System.Drawing.Image]::FromFile($srcPath)

    $scale = [Math]::Min(1.0, $MAX_EDGE / [Math]::Max($src.Width, $src.Height))
    $pageW = [int][Math]::Round($src.Width * $scale)
    $pageH = [int][Math]::Round($src.Height * $scale)

    $bmp = New-Object System.Drawing.Bitmap(($pageW + $GUTTER), $pageH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, $GUTTER, 0, $pageW, $pageH)

    $gutterBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238, 242, 247))
    $g.FillRectangle($gutterBrush, 0, 0, $GUTTER, $pageH)

    $fontSize = [Math]::Max(15, [int][Math]::Round($pageH * 0.016))
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 23, 42))
    $tick = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(148, 163, 184)), 1

    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center

    foreach ($b in $page.bands) {
        $top = $b.y0 * $pageH
        $bottom = $b.y1 * $pageH
        $mid = ($top + $bottom) / 2

        $g.DrawLine($tick, ($GUTTER - 6), $top, ($GUTTER - 1), $top)
        $g.DrawLine($tick, ($GUTTER - 6), $bottom, ($GUTTER - 1), $bottom)

        $rect = New-Object System.Drawing.RectangleF(0, ($mid - 12), $GUTTER, 24)
        $g.DrawString("L$($b.index)", $font, $ink, $rect, $fmt)
    }

    $name = [System.IO.Path]::GetFileNameWithoutExtension($srcPath)
    $outPath = Join-Path $PSScriptRoot "$name.annotated.jpg"

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85)
    $bmp.Save($outPath, $codec, $params)

    $g.Dispose(); $bmp.Dispose(); $src.Dispose()
    Write-Output "$outPath  ($($page.bands.Count) bands, $($pageW + $GUTTER)x$pageH)"
}
