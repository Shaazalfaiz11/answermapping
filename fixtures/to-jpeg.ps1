# Converts the fixture PNG pages to JPEG so they can be embedded in a PDF.
Add-Type -AssemblyName System.Drawing

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 88)

foreach ($name in @("question_paper_p1", "answer_sheet_p1", "answer_sheet_p2", "answer_sheet_p3")) {
    $srcPath = Join-Path $PSScriptRoot "$name.png"
    if (-not (Test-Path $srcPath)) { continue }

    $src = [System.Drawing.Image]::FromFile($srcPath)
    # Flatten to 24bpp RGB: PDF /DeviceRGB has no alpha channel.
    $bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)

    $out = Join-Path $PSScriptRoot "$name.jpg"
    $bmp.Save($out, $codec, $params)
    $g.Dispose(); $bmp.Dispose(); $src.Dispose()
    Write-Output "$name.jpg"
}
