import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CollisionWorld } from './collisions.js';
import { Player, PLAYER_RADIUS, PLAYER_HEIGHT } from './player.js';
import { WeaponSystem, WEAPON_DEFS } from './weapons.js';
import { CombatSystem } from './combat.js';
import { UI } from './ui.js';
import { NetworkClient, RemotePlayerManager } from './network.js';

/**
 * Carte visuelle + collision dédiée.
 *
 * Blender → collision.glb : un mesh par objet ; appliquer les transforms avant export.
 * Custom Property `type` (→ userData.type) : floor | stair | wall | object
 * (voir js/bvh-capsule.js en tête de fichier pour le détail).
 */
const MODELS = {
  /** GLB visuel (équivalent map.glb). */
  ville: 'models/ville.glb',
  /** GLB collision ; optionnel — sinon physique sur le visuel + AABB. */
  collision: 'models/collision.glb',
};
/** true = 4 murs invisibles sur la bbox du GLB visuel (recommandé avec collision.glb / BVH si la mesh n’inclut pas les bords). */
const MAP_BOUNDARY_COLLISION = true;
/**
 * 'auto' = murs générés depuis le GLB (souvent bloquant sur map 2+ étages).
 * 'ground' = aucun mur automatique : tu restes au sol (raycast), zéro blocage horizontal.
 * Si tu ajoutes des meshes nommés collision_* / hitbox_ dans Blender, ils deviennent les seuls murs (même en 'ground').
 */
const COLLISION_WALL_MODE = 'ground';
/**
 * Spawns fixes (optionnel). [] = placement auto depuis la bbox + sol.
 */
const CUSTOM_SPAWNS = [
  { x: 49.452, y: 1.085, z: -52.199 },
  { x: -44.848, y: 1.037, z: 15.86 },
];
const STATE = { MENU: 0, PLAYING: 1, PAUSED: 2, LOBBY: 3, WEAPON_SELECT: 4, SPAWN_EDIT: 5 };
const LS_SPAWNS = 'sz_custom_spawns';

let gameState = STATE.MENU;
let isMultiplayer = false;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x87ceeb, 200, 4500);
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 8000);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Lighting ---
scene.add(new THREE.AmbientLight(0xfff0d0, 0.5));
scene.add(new THREE.HemisphereLight(0x87ceeb, 0x446633, 0.45));
const sun = new THREE.DirectionalLight(0xfff8e0, 1.3);
sun.position.set(80, 120, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 4000;
sun.shadow.camera.left = sun.shadow.camera.bottom = -2000;
sun.shadow.camera.right = sun.shadow.camera.top = 2000;
sun.shadow.bias = -0.0003;
scene.add(sun);

// --- Systems ---
const collisionWorld = new CollisionWorld();
const player = new Player(camera);
const weapons = new WeaponSystem(scene, camera);
const combat = new CombatSystem(scene);
const ui = new UI();
const net = new NetworkClient();
const remotePlayers = new RemotePlayerManager(scene);
const mixers = [];
let time = 0;

// --- Weapon selection state ---
let selectedSlot1 = 1;
let selectedSlot2 = 0;

// --- Loading ---
const loader = new GLTFLoader();

function fallbackEmptyCity() {
  const g = new THREE.Group();
  const pl = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: 0x3a4538, roughness: 1 })
  );
  pl.rotation.x = -Math.PI / 2;
  pl.receiveShadow = true;
  g.add(pl);
  return g;
}

function loadMap() {
  ui.updateLoadProgress('Carte', 0, 3);
  loader.load(
    MODELS.ville,
    (gltf) => {
      const model = gltf.scene;
      model.traverse(n => {
        if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
      });
      scene.add(model);
      onMapLoaded(model, gltf.animations);
    },
    (xhr) => {
      if (xhr.total > 0) {
        const pct = xhr.loaded / xhr.total;
        if (ui.els['prog-fill']) ui.els['prog-fill'].style.width = (pct * (100 / 3)) + '%';
      }
    },
    (err) => {
      console.warn('[GLB] Echec chargement, fallback', err?.message || '');
      const fb = fallbackEmptyCity();
      scene.add(fb);
      onMapLoaded(fb, []);
    }
  );
}

async function onMapLoaded(model, animations) {
  collisionWorld.buildFromGLB(model, {
    boundaryWalls: MAP_BOUNDARY_COLLISION,
    wallMode: COLLISION_WALL_MODE,
  });

  ui.updateLoadProgress('Collisions', 1, 3);
  await new Promise((resolve) => {
    loader.load(
      MODELS.collision,
      (cgltf) => {
        const ok = collisionWorld.attachBVHFromGLTFScene(cgltf.scene);
        if (!ok) {
          console.warn('[Collisions] collision.glb invalide — BVH auto sur le GLB visuel (si assez léger).');
          collisionWorld.tryAttachBVHFromVisualMap(model);
        }
        resolve();
      },
      undefined,
      (err) => {
        console.warn('[GLB] collision.glb introuvable —', err?.message || err);
        collisionWorld.tryAttachBVHFromVisualMap(model);
        resolve();
      }
    );
  });

  combat.setWorldMeshes(collisionWorld.allMeshesForRaycast);

  ui.updateLoadProgress('Armes', 2, 3);
  await weapons.loadAllModels();
  ui.updateLoadProgress('Pret', 3, 3);

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 30);
  const mapCenter = box.getCenter(new THREE.Vector3());

  camera.far = Math.max(8000, maxDim * 25);
  camera.updateProjectionMatrix();
  scene.fog.near = Math.max(40, maxDim * 0.12);
  scene.fog.far = Math.min(camera.far * 0.92, Math.max(500, maxDim * 10));

  const ext = maxDim * 4;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -ext;
  sun.shadow.camera.right = sun.shadow.camera.top = ext;
  sun.shadow.camera.far = Math.min(camera.far, ext * 2);
  // Lumière directionnelle suivant grossièrement la taille / centre de la carte (nouveau GLB).
  sun.position.set(
    mapCenter.x + maxDim * 0.35,
    mapCenter.y + maxDim * 1.1,
    mapCenter.z + maxDim * 0.28
  );
  sun.target.position.copy(mapCenter);
  if (!sun.target.parent) scene.add(sun.target);
  sun.target.updateMatrixWorld();

  if (animations && animations.length) {
    const mx = new THREE.AnimationMixer(model);
    animations.forEach(clip => mx.clipAction(clip).play());
    mixers.push(mx);
  }

  if (CUSTOM_SPAWNS.length > 0) {
    collisionWorld.setCustomSpawns(CUSTOM_SPAWNS);
    console.log(`[Spawns] ${CUSTOM_SPAWNS.length} spawn(s) hardcodes utilises`);
  } else {
    const savedSpawns = loadSavedSpawns();
    if (savedSpawns.length > 0) {
      collisionWorld.setCustomSpawns(savedSpawns);
      console.log(`[Spawns] ${savedSpawns.length} spawn(s) charges depuis le navigateur`);
    }
  }

  const rawSpawn = collisionWorld.getRandomSpawnPoint();
  player.position.copy(collisionWorld.pickValidatedSpawn(rawSpawn, PLAYER_RADIUS, PLAYER_HEIGHT));
  ui.hideLoading();
  ui.showMenu();
  ui.buildWeaponSelect(WEAPON_DEFS, selectedSlot1, selectedSlot2);
}

// --- Game State ---
function showWeaponSelect() {
  gameState = STATE.WEAPON_SELECT;
  ui.showWeaponSelectScreen();
  ui.buildWeaponSelect(WEAPON_DEFS, selectedSlot1, selectedSlot2);
}

function confirmWeaponSelect() {
  weapons.equipSlots(selectedSlot1, selectedSlot2);
  startSoloGame();
}

function startSoloGame() {
  isMultiplayer = false;
  gameState = STATE.PLAYING;
  combat.spawnDummies(collisionWorld, 10);
  ui.showGame();
  renderer.domElement.requestPointerLock();
  player.respawn(collisionWorld);
}

function startMultiplayerGame() {
  isMultiplayer = true;
  weapons.equipSlots(selectedSlot1, selectedSlot2);
  gameState = STATE.PLAYING;
  ui.showGame();
  renderer.domElement.requestPointerLock();
  player.respawn(collisionWorld);
  net.startStateSync(player);
}

function togglePause() {
  if (gameState === STATE.PLAYING) {
    gameState = STATE.PAUSED;
    document.exitPointerLock();
    ui.showPause();
    if (isMultiplayer) net.stopStateSync();
  } else if (gameState === STATE.PAUSED) {
    gameState = STATE.PLAYING;
    ui.hidePause();
    renderer.domElement.requestPointerLock();
    if (isMultiplayer) net.startStateSync(player);
  }
}

function quitToMenu() {
  gameState = STATE.MENU;
  document.exitPointerLock();
  if (isMultiplayer) {
    net.stopStateSync();
    net.leaveLobby();
  }
  isMultiplayer = false;
  ui.showMenu();
}

// --- Network callbacks ---
net.onLobbyUpdate = (state) => ui.updateLobby(state, net.myId);
net.onGameStart = () => startMultiplayerGame();
net.onTakeDamage = (msg) => {
  player.takeDamage(msg.damage);
  if (msg.headshot) ui.showHitmarker(true);
};
net.onPlayerKilled = (msg) => {
  const text = msg.headshot
    ? `${msg.killerName} HS ${msg.victimName}`
    : `${msg.killerName} > ${msg.victimName}`;
  combat.killfeed.unshift({ text, timer: 4.0 });
  if (combat.killfeed.length > 5) combat.killfeed.pop();
};
net.onRemoteShoot = (msg) => {
  const light = new THREE.PointLight(0xffaa22, 12, 6);
  light.position.set(msg.origin.x, msg.origin.y, msg.origin.z);
  scene.add(light);
  setTimeout(() => scene.remove(light), 50);
};

// --- Spawn Editor ---
const spawnEditorCam = { x: 0, y: 5, z: 0 };
let seYaw = 0, sePitch = -0.3;
const seKeys = {};
const spawnPoints = [];
const spawnMarkers = [];

function loadSavedSpawns() {
  try {
    const raw = localStorage.getItem(LS_SPAWNS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch {}
  return [];
}

function saveSpawnsToLS() {
  const data = spawnPoints.map(p => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) }));
  localStorage.setItem(LS_SPAWNS, JSON.stringify(data));
}

function enterSpawnEditor() {
  gameState = STATE.SPAWN_EDIT;
  ui.showSpawnEditor();
  renderer.domElement.requestPointerLock();

  const center = new THREE.Vector3();
  collisionWorld.mapBounds.getCenter(center);
  spawnEditorCam.x = center.x;
  spawnEditorCam.y = center.y + 5;
  spawnEditorCam.z = center.z;
  seYaw = 0;
  sePitch = -0.3;

  const saved = loadSavedSpawns();
  for (const s of saved) addSpawnMarker(new THREE.Vector3(s.x, s.y, s.z));
  ui.updateSpawnCount(spawnPoints.length);
}

function exitSpawnEditor() {
  gameState = STATE.MENU;
  document.exitPointerLock();
  ui.hideSpawnEditor();
  ui.showMenu();
  clearAllMarkers();
}

function addSpawnMarker(pos) {
  spawnPoints.push(pos.clone());

  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.4, 6),
    new THREE.MeshBasicMaterial({ color: 0x44ff44 })
  );
  pole.position.y = 0.2;
  group.add(pole);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x44ff44 })
  );
  sphere.position.y = 0.42;
  group.add(sphere);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.12, 16),
    new THREE.MeshBasicMaterial({ color: 0x44ff44, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  group.add(ring);

  group.position.copy(pos);
  scene.add(group);
  spawnMarkers.push(group);
}

function removeLastMarker() {
  if (spawnPoints.length === 0) return;
  spawnPoints.pop();
  const m = spawnMarkers.pop();
  scene.remove(m);
}

function clearAllMarkers() {
  spawnPoints.length = 0;
  for (const m of spawnMarkers) scene.remove(m);
  spawnMarkers.length = 0;
}

function placeSpawnAtCamera() {
  const groundY = collisionWorld.getGroundHeightBelow(spawnEditorCam.x, spawnEditorCam.y, spawnEditorCam.z);
  const pos = new THREE.Vector3(spawnEditorCam.x, groundY + 0.01, spawnEditorCam.z);
  addSpawnMarker(pos);
  ui.updateSpawnCount(spawnPoints.length);
}

function exportSpawnCode() {
  const data = spawnPoints.map(p => `  {x:${p.x.toFixed(3)}, y:${p.y.toFixed(3)}, z:${p.z.toFixed(3)}}`);
  return `const CUSTOM_SPAWNS = [\n${data.join(',\n')}\n];`;
}

// --- Input ---
player.bindInput(renderer.domElement);
weapons.bindInput(renderer.domElement);

renderer.domElement.addEventListener('click', () => {
  if (gameState === STATE.MENU || gameState === STATE.LOBBY || gameState === STATE.WEAPON_SELECT) return;
  if (gameState === STATE.SPAWN_EDIT && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
    return;
  }
  if (gameState === STATE.PLAYING && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
  }
});

document.addEventListener('keydown', e => {
  if (gameState === STATE.SPAWN_EDIT) {
    seKeys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyP') placeSpawnAtCamera();
    if (e.code === 'KeyX') { removeLastMarker(); ui.updateSpawnCount(spawnPoints.length); }
    return;
  }
  if (e.code === 'Escape') {
    if (gameState === STATE.PLAYING || gameState === STATE.PAUSED) {
      e.preventDefault();
      togglePause();
    }
  }
});

document.addEventListener('keyup', e => {
  if (gameState === STATE.SPAWN_EDIT) seKeys[e.code] = false;
});

document.addEventListener('mousemove', e => {
  if (gameState === STATE.SPAWN_EDIT && document.pointerLockElement === renderer.domElement) {
    seYaw -= e.movementX * 0.002;
    sePitch -= e.movementY * 0.002;
    sePitch = Math.max(-1.4, Math.min(1.4, sePitch));
  }
});

document.addEventListener('pointerlockchange', () => {
  if (gameState === STATE.PLAYING && document.pointerLockElement !== renderer.domElement) {
    togglePause();
  }
});

// --- Menu buttons ---
document.getElementById('btn-play')?.addEventListener('click', () => showWeaponSelect());

document.getElementById('btn-multi')?.addEventListener('click', async () => {
  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}`;
    await net.connect(wsUrl);
    const name = prompt('Ton pseudo :', 'Joueur') || 'Joueur';
    net.setName(name);
    gameState = STATE.LOBBY;
    ui.resetLobbyUI();
    ui.showLobbyScreen();
  } catch {
    alert('Impossible de se connecter au serveur WebSocket.\n\nAssure-toi que le serveur tourne :\n  Double-clic sur demarrer-serveur.bat\n\nPuis ouvre le jeu a http://127.0.0.1:8080/');
  }
});

document.getElementById('btn-resume')?.addEventListener('click', () => togglePause());
document.getElementById('btn-quit')?.addEventListener('click', () => quitToMenu());
document.getElementById('lobby-create')?.addEventListener('click', () => net.createLobby());
document.getElementById('lobby-join-btn')?.addEventListener('click', () => {
  const code = document.getElementById('lobby-code-input')?.value || '';
  if (code.length >= 4) net.joinLobby(code);
});
document.getElementById('lobby-ready')?.addEventListener('click', () => net.toggleReady());
document.getElementById('lobby-start')?.addEventListener('click', () => net.startGame());
document.getElementById('lobby-back')?.addEventListener('click', () => {
  net.leaveLobby(); net.disconnect();
  ui.resetLobbyUI();
  gameState = STATE.MENU; ui.showMenu();
});
document.getElementById('lobby-copy-code')?.addEventListener('click', () => {
  const code = document.getElementById('lobby-code')?.textContent;
  if (code && code !== '------') {
    navigator.clipboard.writeText(code).then(() => {
      const el = document.getElementById('lobby-copy-code');
      if (el) { el.textContent = 'Copie !'; setTimeout(() => { el.textContent = 'Cliquer pour copier'; }, 1500); }
    }).catch(() => {});
  }
});

document.getElementById('ws-confirm')?.addEventListener('click', () => confirmWeaponSelect());
document.getElementById('ws-back')?.addEventListener('click', () => {
  gameState = STATE.MENU; ui.showMenu();
});

document.getElementById('btn-spawns')?.addEventListener('click', () => enterSpawnEditor());
document.getElementById('se-save')?.addEventListener('click', () => {
  saveSpawnsToLS();
  collisionWorld.setCustomSpawns(spawnPoints.map(p => ({ x: p.x, y: p.y, z: p.z })));
  alert(`${spawnPoints.length} spawn(s) sauvegardes ! Les joueurs spawneront a ces positions.`);
});
document.getElementById('se-clear')?.addEventListener('click', () => {
  clearAllMarkers();
  ui.updateSpawnCount(0);
});
document.getElementById('se-export')?.addEventListener('click', () => {
  const code = exportSpawnCode();
  ui.showSpawnExport(code);
  navigator.clipboard.writeText(code).catch(() => {});
});
document.getElementById('se-quit')?.addEventListener('click', () => exitSpawnEditor());

document.addEventListener('click', (e) => {
  const card = e.target.closest('.ws-card');
  if (!card || gameState !== STATE.WEAPON_SELECT) return;
  const idx = parseInt(card.dataset.idx);
  if (isNaN(idx)) return;

  const slot = card.closest('#ws-list-1') ? 1 : 2;
  if (slot === 1) {
    selectedSlot1 = idx;
    if (selectedSlot2 === idx) selectedSlot2 = (idx + 1) % WEAPON_DEFS.length;
  } else {
    selectedSlot2 = idx;
    if (selectedSlot1 === idx) selectedSlot1 = (idx + 1) % WEAPON_DEFS.length;
  }
  ui.buildWeaponSelect(WEAPON_DEFS, selectedSlot1, selectedSlot2);
});

// --- Game Loop ---
const clock = new THREE.Clock();
let wasAlive = true;
const _ray = new THREE.Raycaster();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  time++;

  mixers.forEach(m => m.update(dt));

  const st = time * 0.00012;
  sun.position.set(200 * Math.cos(st), 220 * Math.abs(Math.sin(st)) + 40, 160 * Math.sin(st));
  sun.intensity = Math.max(0.25, Math.abs(Math.sin(st)) * 1.4);
  const sky = new THREE.Color(0x87ceeb).lerp(new THREE.Color(0x0a0a25), 1 - Math.abs(Math.sin(st)));
  scene.background = sky;
  scene.fog.color.copy(sky);

  if (gameState === STATE.PLAYING) {
    player.update(dt, collisionWorld);

    const pointerLocked = document.pointerLockElement === renderer.domElement;
    const fired = weapons.update(dt, player, pointerLocked);

    if (fired) {
      let hit = false;

      if (isMultiplayer) {
        net.sendShoot(player, weapons.current);
        const hittable = remotePlayers.getHittable();
        const origin = player.camera.position.clone();
        const dir = player.getLookDirection();
        _ray.ray.origin.copy(origin);
        _ray.ray.direction.copy(dir);
        _ray.far = 500;

        const meshList = hittable.map(h => h.mesh);
        const hits = _ray.intersectObjects(meshList, true);
        if (hits.length > 0) {
          const hitObj = hits[0];
          let targetEntry = null;
          for (const h of hittable) {
            let cur = hitObj.object;
            while (cur) {
              if (cur === h.mesh) { targetEntry = h; break; }
              cur = cur.parent;
            }
            if (targetEntry) break;
          }
          if (targetEntry) {
            const headOff = targetEntry.mesh.userData.headShotMinOffset ?? 0.32;
            const isHead = hitObj.point.y >= targetEntry.mesh.position.y + headOff;
            const dmg = isHead ? weapons.current.headDmg : weapons.current.bodyDmg;
            net.sendHit(targetEntry.id, dmg, isHead);
            ui.showHitmarker(isHead);
            combat.hitmarkerTimer = 0.2;
            combat.lastHitWasHead = isHead;
            hit = true;
          }
        }
        if (!hit) {
          combat._castWorldImpact(player.camera.position.clone(), player.getLookDirection());
        }
      }

      if (!isMultiplayer) {
        hit = combat.processShot(player, weapons.current);
      }

      if (hit) ui.showHitmarker(combat.lastHitWasHead);
    }

    combat.update(dt, collisionWorld);

    if (isMultiplayer) {
      remotePlayers.update(net.remotePlayers);
    }

    ui.updateHP(player.hp);
    const w = weapons.current;
    if (w) {
      ui.updateAmmo(w.ammo, w.magSize);
      ui.updateWeaponName(w.name);
      if (w.reloading) {
        ui.updateReloadBar(1 - w.reloadTimer / w.reloadTime);
      } else {
        ui.updateReloadBar(0);
      }
    }
    ui.updateCrosshair(weapons.getCrosshairSize(), weapons.getReticleType(), weapons.adsAmount);
    ui.updateKillfeed(combat.killfeed);

    if (combat.hitmarkerTimer <= 0) ui.hideHitmarker();

    if (!player.alive && wasAlive) ui.showDeath();
    if (player.alive && !wasAlive) {
      ui.hideDeath();
      weapons.slot.forEach(w => { if (w) { w.ammo = w.magSize; w.reloading = false; } });
    }
    wasAlive = player.alive;
  }

  if (gameState === STATE.SPAWN_EDIT) {
    const mv = (seKeys['ShiftLeft'] || seKeys['ShiftRight'] ? 12 : 5) * dt;
    const fwd = new THREE.Vector3(Math.sin(seYaw), 0, Math.cos(seYaw)).negate();
    const rgt = new THREE.Vector3(Math.cos(seYaw), 0, -Math.sin(seYaw));
    if (seKeys['KeyW'] || seKeys['KeyZ']) { spawnEditorCam.x += fwd.x * mv; spawnEditorCam.z += fwd.z * mv; }
    if (seKeys['KeyS']) { spawnEditorCam.x -= fwd.x * mv; spawnEditorCam.z -= fwd.z * mv; }
    if (seKeys['KeyA'] || seKeys['KeyQ']) { spawnEditorCam.x -= rgt.x * mv; spawnEditorCam.z -= rgt.z * mv; }
    if (seKeys['KeyD']) { spawnEditorCam.x += rgt.x * mv; spawnEditorCam.z += rgt.z * mv; }
    if (seKeys['Space']) spawnEditorCam.y += 6 * dt;
    if (seKeys['ControlLeft'] || seKeys['ControlRight']) spawnEditorCam.y -= 6 * dt;

    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(sePitch, seYaw, 0, 'YXZ'));
    camera.position.set(spawnEditorCam.x, spawnEditorCam.y, spawnEditorCam.z);
    camera.lookAt(
      spawnEditorCam.x + dir.x * 50,
      spawnEditorCam.y + dir.y * 50,
      spawnEditorCam.z + dir.z * 50
    );
  }

  if (gameState === STATE.MENU || gameState === STATE.LOBBY || gameState === STATE.WEAPON_SELECT) {
    const menuYaw = time * 0.0003;
    const center = new THREE.Vector3();
    collisionWorld.mapBounds.getCenter(center);
    const r = 80;
    camera.position.set(center.x + Math.sin(menuYaw) * r, center.y + 40, center.z + Math.cos(menuYaw) * r);
    camera.lookAt(center.x, center.y + 5, center.z);
  }

  renderer.render(scene, camera);
}

loadMap();
animate();
