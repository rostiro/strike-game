$ErrorActionPreference = 'Stop'
$port = 8080
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$root = [IO.Path]::GetFullPath($root)

function Get-Mime([string]$ext) {
  switch ($ext.ToLower()) {
    '.html' { return 'text/html; charset=utf-8' }
    '.js'   { return 'application/javascript; charset=utf-8' }
    '.mjs'  { return 'application/javascript; charset=utf-8' }
    '.json' { return 'application/json; charset=utf-8' }
    '.css'  { return 'text/css; charset=utf-8' }
    '.png'  { return 'image/png' }
    '.jpg'  { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.gif'  { return 'image/gif' }
    '.webp' { return 'image/webp' }
    '.svg'  { return 'image/svg+xml' }
    '.glb'  { return 'model/gltf-binary' }
    '.gltf' { return 'model/gltf+json' }
    '.bin'  { return 'application/octet-stream' }
    '.ico'  { return 'image/x-icon' }
    default { return 'application/octet-stream' }
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:${port}/")
try {
  $listener.Start()
} catch {
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:${port}/")
  try {
    $listener.Start()
  } catch {
    Write-Host 'Port deja utilise.' -ForegroundColor Red
    Read-Host 'Entree pour quitter'
    exit 1
  }
}

Write-Host ''
Write-Host '  STRIKE ZONE' -ForegroundColor Yellow
Write-Host "  http://127.0.0.1:${port}/" -ForegroundColor Cyan
Write-Host '  HTTP + WebSocket Multi' -ForegroundColor Cyan
Write-Host "  Dossier : $root"
Write-Host '  (Ctrl+C pour arreter)'
Write-Host ''

$script:nextId = 1
$script:lobbies = @{}
$script:wsClients = New-Object System.Collections.ArrayList

function Send-WsText($ws, [string]$text) {
  if ($null -eq $ws -or $ws.State -ne 'Open') { return }
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $seg = New-Object System.ArraySegment[byte](,$bytes)
    $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  } catch {}
}

function Send-WsJson($ws, $obj) {
  $json = $obj | ConvertTo-Json -Depth 10 -Compress
  Send-WsText $ws $json
}

function Broadcast-Lobby($lobby) {
  $plist = @()
  foreach ($k in @($lobby.players.Keys)) {
    $p = $lobby.players[$k]
    $plist += @{ id = [int]$k; name = $p.name; ready = $p.ready }
  }
  $msg = @{ type = 'lobby_state'; code = $lobby.code; players = $plist; hostId = $lobby.hostId; inGame = $lobby.inGame }
  foreach ($k in @($lobby.players.Keys)) {
    Send-WsJson $lobby.players[$k].ws $msg
  }
}

function Remove-ClientFromLobby($client) {
  $code = $client.lobbyCode
  if (-not $code) { return }
  $lobby = $script:lobbies[$code]
  $client.lobbyCode = $null
  if (-not $lobby) { return }
  $idStr = [string]$client.id
  $lobby.players.Remove($idStr)
  $lobby.states.Remove($idStr)
  if ($lobby.players.Count -eq 0) {
    $script:lobbies.Remove($code)
  } else {
    if ($lobby.hostId -eq $client.id) {
      $first = @($lobby.players.Keys) | Select-Object -First 1
      $lobby.hostId = [int]$first
    }
    $leftMsg = @{ type = 'player_left'; id = $client.id }
    foreach ($k in @($lobby.players.Keys)) {
      Send-WsJson $lobby.players[$k].ws $leftMsg
    }
    Broadcast-Lobby $lobby
  }
}

function Handle-Message($client, [string]$raw) {
  try { $msg = $raw | ConvertFrom-Json } catch { return }
  $id = $client.id
  $idStr = [string]$id

  switch ($msg.type) {
    'set_name' {
      $n = [string]$msg.name
      if ($n.Length -gt 20) { $n = $n.Substring(0, 20) }
      if ($n.Length -gt 0) { $client.name = $n }
    }
    'create_lobby' {
      Remove-ClientFromLobby $client
      $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      $code = ''
      for ($i = 0; $i -lt 6; $i++) { $code += $chars[(Get-Random -Maximum $chars.Length)] }
      $lobby = @{
        code = $code
        hostId = $id
        players = @{}
        inGame = $false
        states = @{}
      }
      $client.ready = $false
      $client.lobbyCode = $code
      $lobby.players[$idStr] = $client
      $script:lobbies[$code] = $lobby
      Broadcast-Lobby $lobby
    }
    'join_lobby' {
      Remove-ClientFromLobby $client
      $code = ([string]$msg.code).ToUpper()
      if (-not $script:lobbies.ContainsKey($code)) {
        Send-WsJson $client.ws @{ type = 'error'; message = 'Lobby introuvable' }
        return
      }
      $lobby = $script:lobbies[$code]
      if ($lobby.players.Count -ge 10) {
        Send-WsJson $client.ws @{ type = 'error'; message = 'Lobby plein' }
        return
      }
      $client.ready = $false
      $client.lobbyCode = $code
      $lobby.players[$idStr] = $client
      Broadcast-Lobby $lobby
    }
    'toggle_ready' {
      if (-not $client.lobbyCode) { return }
      $client.ready = -not $client.ready
      $lobby = $script:lobbies[$client.lobbyCode]
      if ($lobby) { Broadcast-Lobby $lobby }
    }
    'start_game' {
      if (-not $client.lobbyCode) { return }
      $lobby = $script:lobbies[$client.lobbyCode]
      if (-not $lobby -or $lobby.hostId -ne $id) { return }
      $lobby.inGame = $true
      $startMsg = @{ type = 'game_start' }
      foreach ($k in @($lobby.players.Keys)) {
        Send-WsJson $lobby.players[$k].ws $startMsg
      }
    }
    'player_state' {
      if (-not $client.lobbyCode) { return }
      $lobby = $script:lobbies[$client.lobbyCode]
      if ($lobby -and $lobby.inGame) {
        $lobby.states[$idStr] = $msg.state
      }
    }
    'player_shoot' {
      if (-not $client.lobbyCode) { return }
      $lobby = $script:lobbies[$client.lobbyCode]
      if (-not $lobby -or -not $lobby.inGame) { return }
      $shootMsg = @{ type = 'player_shoot'; id = $id; origin = $msg.origin; direction = $msg.direction; weapon = $msg.weapon }
      foreach ($k in @($lobby.players.Keys)) {
        if ($k -ne $idStr) { Send-WsJson $lobby.players[$k].ws $shootMsg }
      }
    }
    'player_hit' {
      if (-not $client.lobbyCode) { return }
      $lobby = $script:lobbies[$client.lobbyCode]
      if (-not $lobby -or -not $lobby.inGame) { return }
      $tid = [string]$msg.targetId
      if ($lobby.players.ContainsKey($tid)) {
        $dmgMsg = @{ type = 'take_damage'; damage = $msg.damage; attackerId = $id; headshot = $msg.headshot }
        Send-WsJson $lobby.players[$tid].ws $dmgMsg
      }
      $vn = 'inconnu'
      if ($lobby.players.ContainsKey($tid)) { $vn = $lobby.players[$tid].name }
      $killMsg = @{ type = 'player_killed'; killerId = $id; killerName = $client.name; victimId = $msg.targetId; victimName = $vn; headshot = $msg.headshot }
      foreach ($k in @($lobby.players.Keys)) {
        Send-WsJson $lobby.players[$k].ws $killMsg
      }
    }
    'leave_lobby' {
      Remove-ClientFromLobby $client
    }
  }
}

# World state tick (20 fps)
$tickTimer = New-Object Timers.Timer
$tickTimer.Interval = 50
$tickTimer.AutoReset = $true
Register-ObjectEvent -InputObject $tickTimer -EventName Elapsed -Action {
  foreach ($code in @($script:lobbies.Keys)) {
    $lobby = $script:lobbies[$code]
    if (-not $lobby.inGame -or $lobby.players.Count -eq 0) { continue }
    $ps = @{}
    foreach ($sid in @($lobby.states.Keys)) {
      $s = $lobby.states[$sid]
      if ($lobby.players.ContainsKey($sid)) {
        $ps[$sid] = @{ x=$s.x; y=$s.y; z=$s.z; yaw=$s.yaw; pitch=$s.pitch; hp=$s.hp; alive=$s.alive; name=$lobby.players[$sid].name }
      }
    }
    if ($ps.Count -eq 0) { continue }
    $wsMsg = @{ type='world_state'; players=$ps }
    foreach ($k in @($lobby.players.Keys)) {
      Send-WsJson $lobby.players[$k].ws $wsMsg
    }
  }
} | Out-Null
$tickTimer.Start()

# Open browser
Start-Sleep -Seconds 1
$chrome64 = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
$chrome32 = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
if (Test-Path -LiteralPath $chrome64) { Start-Process -FilePath $chrome64 -ArgumentList "http://127.0.0.1:${port}/" }
elseif (Test-Path -LiteralPath $chrome32) { Start-Process -FilePath $chrome32 -ArgumentList "http://127.0.0.1:${port}/" }
else { Start-Process "http://127.0.0.1:${port}/" }

# Main loop
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  if ($req.IsWebSocketRequest) {
    try {
      $wsCtx = $ctx.AcceptWebSocketAsync($null).Result
      $ws = $wsCtx.WebSocket
      $cid = $script:nextId
      $script:nextId++
      $cname = 'Joueur ' + $cid
      $client = @{
        id = $cid
        ws = $ws
        name = $cname
        lobbyCode = $null
        ready = $false
      }
      $script:wsClients.Add($client) | Out-Null

      Send-WsJson $ws @{ type = 'welcome'; id = $cid }

      [Threading.Tasks.Task]::Run([Action]{
        $buf = New-Object byte[] 8192
        $seg = New-Object System.ArraySegment[byte](,$buf)
        while ($client.ws.State -eq 'Open') {
          try {
            $result = $client.ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).Result
            if ($result.MessageType -eq 'Close') { break }
            $txt = [Text.Encoding]::UTF8.GetString($buf, 0, $result.Count)
            Handle-Message $client $txt
          } catch { break }
        }
        Remove-ClientFromLobby $client
      }.GetNewClosure()) | Out-Null

    } catch {
      try { $res.StatusCode = 500; $res.Close() } catch {}
    }
    continue
  }

  try {
    $urlPath = [Uri]::UnescapeDataString($req.Url.LocalPath)
    if ($urlPath -eq '/' -or $urlPath -eq '') { $rel = 'index.html' }
    else {
      $sep = [IO.Path]::DirectorySeparatorChar
      $rel = $urlPath.TrimStart('/').Replace('/', $sep)
    }
    $filePath = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
    if (-not $filePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
    } elseif (-not [IO.File]::Exists($filePath)) {
      $res.StatusCode = 404
    } else {
      $res.ContentType = Get-Mime ([IO.Path]::GetExtension($filePath))
      $data = [IO.File]::ReadAllBytes($filePath)
      $res.ContentLength64 = $data.LongLength
      $res.OutputStream.Write($data, 0, $data.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.Close() } catch {}
  }
}
