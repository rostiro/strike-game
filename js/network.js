import * as THREE from 'three';
import { PLAYER_BODY_SCALE } from './player.js';

const DEFAULT_HEAD_OFFSET = 0.32 * PLAYER_BODY_SCALE;

export class NetworkClient {
  constructor() {
    this.ws = null;
    this.myId = null;
    this.connected = false;
    this.inLobby = false;
    this.lobbyState = null;
    this.inGame = false;
    this.remotePlayers = new Map();
    this.onLobbyUpdate = null;
    this.onGameStart = null;
    this.onRemoteShoot = null;
    this.onTakeDamage = null;
    this.onPlayerKilled = null;
    this.onError = null;
    this._sendInterval = null;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => {
        this.connected = false;
        this.inLobby = false;
        this.inGame = false;
        if (this._sendInterval) { clearInterval(this._sendInterval); this._sendInterval = null; }
      };
      this.ws.onmessage = (e) => this._handleMessage(JSON.parse(e.data));
    });
  }

  disconnect() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.myId = msg.id;
        break;

      case 'lobby_state':
        this.lobbyState = msg;
        this.inLobby = true;
        if (this.onLobbyUpdate) this.onLobbyUpdate(msg);
        break;

      case 'error':
        if (this.onError) this.onError(msg.message);
        break;

      case 'game_start':
        this.inGame = true;
        this.inLobby = false;
        if (this.onGameStart) this.onGameStart();
        break;

      case 'world_state':
        for (const [id, state] of Object.entries(msg.players)) {
          const nid = parseInt(id);
          if (nid === this.myId) continue;
          this.remotePlayers.set(nid, state);
        }
        for (const id of this.remotePlayers.keys()) {
          if (!(id.toString() in msg.players)) this.remotePlayers.delete(id);
        }
        break;

      case 'player_shoot':
        if (this.onRemoteShoot) this.onRemoteShoot(msg);
        break;

      case 'take_damage':
        if (this.onTakeDamage) this.onTakeDamage(msg);
        break;

      case 'player_killed':
        if (this.onPlayerKilled) this.onPlayerKilled(msg);
        break;

      case 'player_left':
        this.remotePlayers.delete(msg.id);
        break;
    }
  }

  setName(name) { this._send({ type: 'set_name', name }); }
  createLobby() { this._send({ type: 'create_lobby' }); }
  joinLobby(code) { this._send({ type: 'join_lobby', code }); }
  toggleReady() { this._send({ type: 'toggle_ready' }); }
  startGame() { this._send({ type: 'start_game' }); }
  leaveLobby() { this._send({ type: 'leave_lobby' }); this.inLobby = false; this.inGame = false; }

  sendPlayerState(player) {
    if (!this.inGame) return;
    this._send({
      type: 'player_state',
      state: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        yaw: player.yaw,
        pitch: player.pitch,
        hp: player.hp,
        alive: player.alive,
      }
    });
  }

  sendShoot(player, weapon) {
    const dir = player.getLookDirection();
    this._send({
      type: 'player_shoot',
      origin: { x: player.camera.position.x, y: player.camera.position.y, z: player.camera.position.z },
      direction: { x: dir.x, y: dir.y, z: dir.z },
      weapon: weapon.name,
    });
  }

  sendHit(targetId, damage, headshot) {
    this._send({ type: 'player_hit', targetId, damage, headshot });
  }

  startStateSync(player, intervalMs = 50) {
    if (this._sendInterval) clearInterval(this._sendInterval);
    this._sendInterval = setInterval(() => {
      this.sendPlayerState(player);
    }, intervalMs);
  }

  stopStateSync() {
    if (this._sendInterval) { clearInterval(this._sendInterval); this._sendInterval = null; }
  }
}

export class RemotePlayerManager {
  constructor(scene) {
    this.scene = scene;
    this.meshes = new Map();
    /** seuil Y local (pieds = 0) au-dessus duquel un hit compte comme tête */
    this._headShotMinOffset = DEFAULT_HEAD_OFFSET;
  }

  update(remotePlayers) {
    for (const [id, state] of remotePlayers) {
      let mesh = this.meshes.get(id);
      if (!mesh) {
        mesh = this._createPlayerMesh(state.name || `P${id}`);
        this.scene.add(mesh);
        this.meshes.set(id, mesh);
      }

      const targetPos = new THREE.Vector3(state.x, state.y, state.z);
      mesh.position.lerp(targetPos, 0.25);
      mesh.rotation.y = state.yaw || 0;
      mesh.visible = state.alive !== false;
    }

    for (const [id, mesh] of this.meshes) {
      if (!remotePlayers.has(id)) {
        this.scene.remove(mesh);
        this.meshes.delete(id);
      }
    }
  }

  _createPlayerMesh(name) {
    const s = PLAYER_BODY_SCALE;
    const group = new THREE.Group();
    group.userData.headShotMinOffset = this._headShotMinOffset;

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x335577, roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xddbb88, roughness: 0.6 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.14 * s, 0.2 * s, 0.09 * s), bodyMat);
    torso.position.y = 0.22 * s;
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.055 * s, 8, 8), headMat);
    head.position.y = 0.38 * s;
    head.castShadow = true;
    head.name = 'head';
    group.add(head);

    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.14 * s, 0.05 * s), bodyMat);
    legL.position.set(-0.04 * s, 0.07 * s, 0);
    group.add(legL);

    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.14 * s, 0.05 * s), bodyMat);
    legR.position.set(0.04 * s, 0.07 * s, 0);
    group.add(legR);

    return group;
  }

  getHittable() {
    const meshes = [];
    for (const [id, mesh] of this.meshes) {
      if (mesh.visible) meshes.push({ id, mesh });
    }
    return meshes;
  }
}
