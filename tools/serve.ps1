# Dev-only static server for the 3D engine (wwwroot), so it can be tested in a
# regular browser with DevTools. The desktop app does not use this.
param([int]$Port = 5173)

$root = Resolve-Path (Join-Path $PSScriptRoot '..\src\ImageTo3D\wwwroot')
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'
  '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'
}
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = Join-Path $root $path
  $res = $ctx.Response
  $res.Headers.Add('Cache-Control', 'no-store')
  # POST /__save/<name> writes the request body to tools/out (renders and exports during testing).
  if ($ctx.Request.HttpMethod -eq 'POST' -and $path.StartsWith('__save/')) {
    $outDir = Join-Path $PSScriptRoot 'out'
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $name = [IO.Path]::GetFileName($path.Substring(7))
    $fs = [IO.File]::Create((Join-Path $outDir $name))
    $ctx.Request.InputStream.CopyTo($fs)
    $fs.Close()
    $res.StatusCode = 204
    $res.Close()
    continue
  }
  if ((Test-Path $file -PathType Leaf) -and ([IO.Path]::GetFullPath($file).StartsWith($root.Path))) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
}
