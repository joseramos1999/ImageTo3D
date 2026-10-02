# Genera src/ImageTo3D/app.ico: un "3D" extruido en lima sobre fondo oscuro redondeado.
# Cada tamaño se dibuja por separado (no se escala uno grande) para que el de 16 px se lea.
Add-Type -AssemblyName System.Drawing

$sizes = 16, 24, 32, 48, 64, 128, 256
$out = Join-Path $PSScriptRoot '..\src\ImageTo3D\app.ico'

function Draw-Icon([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)

    # Fondo redondeado
    $r = [math]::Max(3, $s * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc($s - $r - 1, 0, $r, $r, 270, 90)
    $path.AddArc($s - $r - 1, $s - $r - 1, $r, $r, 0, 90)
    $path.AddArc(0, $s - $r - 1, $r, $r, 90, 90)
    $path.CloseFigure()
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $s, $s), ([System.Drawing.Color]::FromArgb(255, 38, 39, 50)), ([System.Drawing.Color]::FromArgb(255, 11, 11, 15))
    $g.FillPath($bg, $path)

    # "3D" con extrusión: copias desplazadas en verde oscuro y la cara frontal en lima
    $font = New-Object System.Drawing.Font 'Arial Black', ([float]($s * 0.44)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $depth = [math]::Max(1, [int]($s * 0.07))
    $cx = $s / 2 - $depth / 2; $cy = $s / 2 - $depth / 2 + $s * 0.02
    $side = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 92, 122, 24))
    for ($i = $depth; $i -ge 1; $i--) {
        $g.DrawString('3D', $font, $side, (New-Object System.Drawing.RectangleF ($cx - $s / 2 + $i), ($cy - $s / 2 + $i), $s, $s), $fmt)
    }
    $front = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 245, 90))
    $g.DrawString('3D', $font, $front, (New-Object System.Drawing.RectangleF ($cx - $s / 2), ($cy - $s / 2), $s, $s), $fmt)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

# ICO con entradas PNG (válido desde Windows Vista)
$images = $sizes | ForEach-Object { , (Draw-Icon $_) }
$fs = [System.IO.File]::Create((Resolve-Path -LiteralPath (Split-Path $out)).Path + '\app.ico')
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $images[$i].Length
    $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256))   # 256 se escribe como 0
    $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
$images | ForEach-Object { $w.Write($_) }
$w.Close()
Write-Host "Icono generado: $out"
