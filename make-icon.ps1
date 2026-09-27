# Generate the launcher icon (pure ASCII script; PS 5.1 reads .ps1 as ANSI).
Add-Type -AssemblyName System.Drawing

function New-RoundPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $r, $r, 180, 90)
    $p.AddArc(($x + $w - $r), $y, $r, $r, 270, 90)
    $p.AddArc(($x + $w - $r), ($y + $h - $r), $r, $r, 0, 90)
    $p.AddArc($x, ($y + $h - $r), $r, $r, 90, 90)
    $p.CloseFigure()
    return $p
}

$size = 192
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$bg = [System.Drawing.ColorTranslator]::FromHtml('#1E2A38')
$blue = [System.Drawing.ColorTranslator]::FromHtml('#4A8CF7')
$green = [System.Drawing.ColorTranslator]::FromHtml('#3FB950')
$cell = [System.Drawing.ColorTranslator]::FromHtml('#2E3B4D')
$white = [System.Drawing.ColorTranslator]::FromHtml('#E6EDF3')

# background
$path = New-RoundPath 0 0 $size $size 44
$br = New-Object System.Drawing.SolidBrush $bg
$g.FillPath($br, $path)

# header bar
$hp = New-RoundPath 28 32 136 26 9
$hb = New-Object System.Drawing.SolidBrush $blue
$g.FillPath($hb, $hp)

# 3 x 3 cells
$colors = @($cell, $blue, $cell, $green, $cell, $cell, $cell, $cell, $white)
$idx = 0
for ($row = 0; $row -lt 3; $row++) {
    for ($col = 0; $col -lt 3; $col++) {
        $x = 28 + $col * 48
        $y = 72 + $row * 32
        $cp = New-RoundPath $x $y 40 24 7
        $cb = New-Object System.Drawing.SolidBrush $colors[$idx]
        $g.FillPath($cb, $cp)
        $cb.Dispose()
        $cp.Dispose()
        $idx++
    }
}

$outDir = Join-Path $PSScriptRoot 'res\mipmap-xxhdpi'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir 'ic_launcher.png'
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()

Write-Host ("icon written: " + $outFile + "  (" + (Get-Item $outFile).Length + " bytes)")
