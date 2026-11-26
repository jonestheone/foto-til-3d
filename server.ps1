<#
  Foto til 3D - lille lokal webserver (kræver ingen installation).

  Start:  dobbeltklik på start.cmd
  Stop:   luk vinduet eller tryk Ctrl+C

  Appen skal køres fra en webserver (ikke ved at åbne index.html direkte),
  fordi browseren kun tillader moduler, kamera og AI-cache på "rigtige" adresser.
#>
param(
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'

$mime = @{
  '.html'        = 'text/html; charset=utf-8'
  '.js'          = 'text/javascript; charset=utf-8'
  '.mjs'         = 'text/javascript; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.md'          = 'text/plain; charset=utf-8'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.jpeg'        = 'image/jpeg'
  '.webp'        = 'image/webp'
  '.ico'         = 'image/x-icon'
  '.wasm'        = 'application/wasm'
  '.glb'         = 'model/gltf-binary'
}

# Find en ledig port (8080, 8081, ...)
$listener = $null
foreach ($p in $Port..($Port + 20)) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$p/")
  try {
    $candidate.Start()
    $listener = $candidate
    $Port = $p
    break
  } catch {
    $candidate.Close()
  }
}
if (-not $listener) {
  Write-Host 'Kunne ikke starte serveren - ingen ledig port fundet.' -ForegroundColor Red
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  Foto til 3D kører på: $url" -ForegroundColor Green
Write-Host '  Luk dette vindue (eller tryk Ctrl+C) for at stoppe serveren.'
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    # Vent på næste forespørgsel (i små bidder, så Ctrl+C virker)
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $task.GetAwaiter().GetResult()
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
      $file = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))

      if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($file)) {
        $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($file)
        $res.StatusCode = 200
      } else {
        $res.StatusCode = 404
        $res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes('404 - filen findes ikke')
      }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch { }
    } finally {
      try { $res.Close() } catch { }
    }
  }
} finally {
  $listener.Close()
}
