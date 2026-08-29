# Produces the annotated page at several max-edge sizes, to measure how image
# size maps to Groq prompt tokens on the free tier.
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot "answer_sheet_p1.annotated.jpg"))
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85)

foreach ($edge in @(1100, 950, 800, 700, 600, 500)) {
    $scale = [Math]::Min(1.0, $edge / [Math]::Max($src.Width, $src.Height))
    $w = [int][Math]::Round($src.Width * $scale)
    $h = [int][Math]::Round($src.Height * $scale)

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $w, $h)

    $out = Join-Path $PSScriptRoot "probe_$edge.jpg"
    $bmp.Save($out, $codec, $params)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "probe_$edge.jpg  ${w}x${h}"
}
$src.Dispose()
