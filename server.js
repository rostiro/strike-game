const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

// --- MIME types ---
const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ico': 'image/x-icon',
};

// --- HTTP static server ---
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIMES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket Game Server ---
const wss = new WebSocketServer({ server: httpServer });

const lobbies = new Map();
let nextPlayerId = 1;

function genLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return lobbies.has(code) ? genLobbyCode() : code;
}

function broadcast(lobby, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const p of lobby.players.values()) {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function broadcastAll(lobby, msg) {
  const data = JSON.stringify(msg);
  for (const p of lobby.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendLobbyState(lobby) {
  const players = [];
  for (const [id, p] of lobby.players) {
    players.push({ id, name: p.name, ready: p.ready });
  }
  broadcastAll(lobby, { type: 'lobby_state', code: lobby.code, players, hostId: lobby.hostId, inGame: lobby.inGame });
}

wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  let currentLobby = null;
  let playerName = `Joueur ${playerId}`;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'set_name': {
        playerName = (msg.name || '').slice(0, 20) || playerName;
        break;
      }

      case 'create_lobby': {
        if (currentLobby) leaveLobby();
        const code = genLobbyCode();
        const lobby = {
          code,
          hostId: playerId,
          players: new Map(),
          inGame: false,
          tickInterval: null,
        };
        lobby.players.set(playerId, { ws, name: playerName, ready: false, state: null });
        lobbies.set(code, lobby);
        currentLobby = lobby;
        sendLobbyState(lobby);
        break;
      }

      case 'join_lobby': {
        if (currentLobby) leaveLobby();
        const code = (msg.code || '').toUpperCase();
        const lobby = lobbies.get(code);
        if (!lobby) {
          ws.send(JSON.stringify({ type: 'error', message: 'Lobby introuvable' }));
          break;
        }
        if (lobby.players.size >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Lobby plein' }));
          break;
        }
        lobby.players.set(playerId, { ws, name: playerName, ready: false, state: null });
        currentLobby = lobby;
        sendLobbyState(lobby);
        break;
      }

      case 'toggle_ready': {
        if (!currentLobby) break;
        const me = currentLobby.players.get(playerId);
        if (me) { me.ready = !me.ready; sendLobbyState(currentLobby); }
        break;
      }

      case 'start_game': {
        if (!currentLobby || currentLobby.hostId !== playerId) break;
        const allReady = [...currentLobby.players.values()].every(p => p.ready || currentLobby.hostId === playerId);
        if (currentLobby.players.size < 1) break;
        currentLobby.inGame = true;
        broadcastAll(currentLobby, { type: 'game_start' });
        startGameTick(currentLobby);
        break;
      }

      case 'player_state': {
        if (!currentLobby || !currentLobby.inGame) break;
        const me = currentLobby.players.get(playerId);
        if (me) me.state = msg.state;
        break;
      }

      case 'player_shoot': {
        if (!currentLobby || !currentLobby.inGame) break;
        broadcast(currentLobby, {
          type: 'player_shoot',
          id: playerId,
          origin: msg.origin,
          direction: msg.direction,
          weapon: msg.weapon,
        }, ws);
        break;
      }

      case 'player_hit': {
        if (!currentLobby || !currentLobby.inGame) break;
        const targetP = currentLobby.players.get(msg.targetId);
        if (targetP && targetP.ws.readyState === 1) {
          targetP.ws.send(JSON.stringify({
            type: 'take_damage',
            damage: msg.damage,
            attackerId: playerId,
            headshot: msg.headshot,
          }));
        }
        broadcast(currentLobby, {
          type: 'player_killed',
          killerId: playerId,
          killerName: playerName,
          victimId: msg.targetId,
          victimName: targetP ? targetP.name : '?',
          headshot: msg.headshot,
        }, null);
        break;
      }

      case 'leave_lobby': {
        leaveLobby();
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveLobby();
  });

  function leaveLobby() {
    if (!currentLobby) return;
    currentLobby.players.delete(playerId);
    if (currentLobby.players.size === 0) {
      if (currentLobby.tickInterval) clearInterval(currentLobby.tickInterval);
      lobbies.delete(currentLobby.code);
    } else {
      if (currentLobby.hostId === playerId) {
        currentLobby.hostId = currentLobby.players.keys().next().value;
      }
      broadcast(currentLobby, { type: 'player_left', id: playerId }, null);
      sendLobbyState(currentLobby);
    }
    currentLobby = null;
  }

  ws.send(JSON.stringify({ type: 'welcome', id: playerId }));
});

function startGameTick(lobby) {
  if (lobby.tickInterval) clearInterval(lobby.tickInterval);
  lobby.tickInterval = setInterval(() => {
    if (!lobby.inGame || lobby.players.size === 0) {
      clearInterval(lobby.tickInterval);
      lobby.tickInterval = null;
      return;
    }
    const states = {};
    for (const [id, p] of lobby.players) {
      if (p.state) states[id] = { ...p.state, name: p.name };
    }
    broadcastAll(lobby, { type: 'world_state', players: states });
  }, 50);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  STRIKE ZONE — port ${PORT}`);
  console.log(`  HTTP + WebSocket sur le meme port`);
  console.log(`  (Ctrl+C pour arreter)\n`);
});
