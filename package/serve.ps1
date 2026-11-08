# just.MD - tiny local web server. No Python, no admin rights, no internet.
# Serves the app\ folder next to this script at http://localhost:8765/ (localhost only; nothing is reachable from outside this PC).
# Edge needs the app served over http (not opened as a file) to install it and let it open .md files.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File serve.ps1

param([int]$Port = 8765)

$root = (Resolve-Path (Join-Path $PSScriptRoot 'app')).Path
$rootPrefix = $root.TrimEnd('\') + '\'   # trailing separator: a sibling such as app-old\ must not pass the check
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.md' = 'text/markdown; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() }
catch { Write-Host "[ERROR] Port $Port is busy or blocked: $($_.Exception.Message)"; exit 1 }
Write-Host "[OK] just.MD at http://localhost:$Port/  (serving $root)"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $bytes = [IO.File]::ReadAllBytes($path)
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch { $res.StatusCode = 500 }
  finally { $res.Close() }
}
