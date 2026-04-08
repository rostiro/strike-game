/**
 * capsule-fps-system.js
 * Mouvement FPS + capsule vs mesh (BVH) avec glissement le long des murs.
 * Dépendances : three (importmap), three-mesh-bvh (importmap).
 *
 * Place map.glb et collision.glb dans le même dossier que index.html,
 * ou modifie MAP_URL / COLLISION_URL ci-dessous.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

// ---------------------------------------------------------------------------
// Config chemins (relatifs à cette page)
// ---------------------------------------------------------------------------
const MAP_URL = './map.glb';
const COLLISION_URL = './collision.glb';

/** Hauteur totale capsule (m), rayon (m) — comme demandé ~2 et ~0.5 */
export const CAPSULE_HEIGHT = 2.0;
export const CAPSULE_RADIUS = 0.5;

const GRAVITY = -28;
const JUMP_SPEED = 9;
const MAX_SPEED = 9;
const SPRINT_MULT = 1.45;
const ACCEL_GROUND = 26;
const ACCEL_AIR = 6;
const FRICTION_GROUND = 18;
const MOUSE_SENS = 0.002;
const PHYSICS_SUBSTEPS = 6;
const EYE_HEIGHT = 1.65;

// ---------------------------------------------------------------------------
// État global (module)
// ---------------------------------------------------------------------------
let scene, camera, renderer, clock;
let colliderMesh = null; // Mesh avec geometry.boundsTree (MeshBVH)
let visualMap = null;
let player = null;
let playerVelocity = new THREE.Vector3();
let yaw = 0;
let pitch = 0;
let onGround = false;
const keys = Object.create(null);

const _tempVec = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _tempBox = new THREE.Box3();
const _tempMat = new THREE.Matrix4();
const _tempSegment = new THREE.Line3();
const _triPoint = new THREE.Vector3();
const _capPoint = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// 1) Scene Setup
// ---------------------------------------------------------------------------
export function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d9);
  scene.fog = new THREE.Fog(0x87b5d9, 35, 220);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 500);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  clock = new THREE.Clock();

  const hemi = new THREE.HemisphereLight(0xffffff, 0x334422, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff5e6, 1.1);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -80;
  sun.shadow.camera.right = sun.shadow.camera.top = 80;
  scene.add(sun);

  window.addEventListener('resize', onResize);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ---------------------------------------------------------------------------
// 2) Chargement map visible + collision (BVH)
// ---------------------------------------------------------------------------
export async function loadModels() {
  const loader = new GLTFLoader();

  const [mapGltf, colGltf] = await Promise.all([
    loadGLB(loader, MAP_URL),
    loadGLB(loader, COLLISION_URL),
  ]);

  visualMap = mapGltf.scene;
  visualMap.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  scene.add(visualMap);

  const colliderGeometry = mergeCollisionGeometries(colGltf.scene);
  colliderGeometry.boundsTree = new MeshBVH(colliderGeometry);

  colliderMesh = new THREE.Mesh(
    colliderGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    })
  );
  colliderMesh.visible = false;
  colliderMesh.matrixAutoUpdate = false;
  scene.add(colliderMesh);

  const box = new THREE.Box3().setFromObject(visualMap);
  const c = new THREE.Vector3();
  box.getCenter(c);
  return { spawn: new THREE.Vector3(c.x, box.max.y + 2, c.z) };
}

function loadGLB(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (e) => reject(new Error(`${url}: ${e?.message || e}`)));
  });
}

/**
 * Fusionne tous les meshes du GLB de collision en une seule géométrie monde (BVH).
 * Les volumes statiques ne sont recalculés qu’ici (une fois).
 */
function mergeCollisionGeometries(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    parts.push(g);
  });
  if (parts.length === 0) {
    throw new Error('collision.glb : aucun mesh trouvé.');
  }
  const merged = mergeGeometries(parts, true);
  merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// 3) Joueur + capsule (segment central cylindre)
// ---------------------------------------------------------------------------
export function createPlayerCapsule(spawnPosition) {
  const group = new THREE.Group();
  group.position.copy(spawnPosition);

  // Représentation visuelle optionnelle (capsule légère)
  const visMat = new THREE.MeshStandardMaterial({
    color: 0x4488ff,
    metalness: 0.1,
    roughness: 0.6,
    transparent: true,
    opacity: 0.25,
  });
  const capGeo = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2 * CAPSULE_RADIUS, 6, 12);
  const vis = new THREE.Mesh(capGeo, visMat);
  vis.position.y = CAPSULE_HEIGHT * 0.5;
  vis.castShadow = true;
  group.add(vis);

  // Segment : des pieds + rayon jusqu’à hauteur - rayon (axe Y monde local joueur)
  const segA = new THREE.Vector3(0, CAPSULE_RADIUS, 0);
  const segB = new THREE.Vector3(0, CAPSULE_HEIGHT - CAPSULE_RADIUS, 0);
  group.userData.capsule = {
    radius: CAPSULE_RADIUS,
    segment: new THREE.Line3(segA.clone(), segB.clone()),
  };

  group.userData.visual = vis;
  player = group;
  scene.add(player);
  playerVelocity.set(0, 0, 0);

  yaw = 0;
  pitch = 0;
  return player;
}

// ---------------------------------------------------------------------------
// 4) Gravité
// ---------------------------------------------------------------------------
export function applyGravity(subDt) {
  if (onGround && playerVelocity.y <= 0) {
    playerVelocity.y = GRAVITY * subDt * 0.25;
  } else {
    playerVelocity.y += GRAVITY * subDt;
  }
}

// ---------------------------------------------------------------------------
// 5) Collisions capsule ↔ BVH + glissement
// ---------------------------------------------------------------------------

/**
 * Ajuste la capsule contre les triangles du BVH ; renvoie le déplacement correctif monde.
 * S’appuie sur shapecast + closestPointToSegment (comme l’exemple characterMovement three-mesh-bvh).
 */
export function checkCollisions() {
  const out = new THREE.Vector3();
  if (!colliderMesh?.geometry?.boundsTree) return out;

  const capsule = player.userData.capsule;
  const tree = colliderMesh.geometry.boundsTree;

  _tempMat.copy(colliderMesh.matrixWorld).invert();

  const worldStart = _tempVec.copy(capsule.segment.start).add(player.position);
  const worldEnd = _tempVec2.copy(capsule.segment.end).add(player.position);

  _tempSegment.start.copy(worldStart).applyMatrix4(_tempMat);
  _tempSegment.end.copy(worldEnd).applyMatrix4(_tempMat);

  _tempBox.makeEmpty();
  _tempBox.expandByPoint(_tempSegment.start);
  _tempBox.expandByPoint(_tempSegment.end);
  _tempBox.min.addScalar(-capsule.radius);
  _tempBox.max.addScalar(capsule.radius);

  tree.shapecast({
    intersectsBounds: (box) => box.intersectsBox(_tempBox),

    intersectsTriangle: (tri) => {
      const dist = tri.closestPointToSegment(_tempSegment, _triPoint, _capPoint);
      if (dist < capsule.radius) {
        const depth = capsule.radius - dist;
        const dir = _tempVec3.subVectors(_capPoint, _triPoint);
        if (dir.lengthSq() < 1e-14) dir.set(0, 1, 0);
        else dir.normalize();
        _tempSegment.start.addScaledVector(dir, depth);
        _tempSegment.end.addScaledVector(dir, depth);
      }
    },
  });

  const newWorldStart = _tempVec.copy(_tempSegment.start).applyMatrix4(colliderMesh.matrixWorld);
  const newFeet = _tempVec2.subVectors(newWorldStart, capsule.segment.start);
  out.subVectors(newFeet, player.position);
  return out;
}

/**
 * Retire la composante de vitesse le long de la normale de correction (glisse le long des murs).
 */
export function slideAlongWalls(correction, eps = 1e-6) {
  if (correction.lengthSq() < eps * eps) return;
  const n = _tempVec2.copy(correction).normalize();
  const vn = playerVelocity.dot(n);
  if (vn < 0) {
    playerVelocity.addScaledVector(n, -vn);
  }
}

// ---------------------------------------------------------------------------
// 6) Mouvement WASD + accélération / décélération
// ---------------------------------------------------------------------------
function getWishDir(out) {
  out.set(0, 0, 0);
  if (keys.KeyW || keys.KeyZ) out.z -= 1;
  if (keys.KeyS) out.z += 1;
  if (keys.KeyA || keys.KeyQ) out.x -= 1;
  if (keys.KeyD) out.x += 1;
  if (out.lengthSq() < 1e-8) return out.set(0, 0, 0);
  out.normalize();
  out.applyAxisAngle(_up, yaw);
  return out;
}

export function movePlayer(dt) {
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  const maxSp = MAX_SPEED * (sprint ? SPRINT_MULT : 1);
  const wish = _tempVec3;
  getWishDir(wish);
  wish.y = 0;

  const accel = onGround ? ACCEL_GROUND : ACCEL_AIR;
  const hVel = _tempVec.set(playerVelocity.x, 0, playerVelocity.z);
  const target = _tempVec2.copy(wish).multiplyScalar(maxSp);

  hVel.x += (target.x - hVel.x) * Math.min(1, accel * dt);
  hVel.z += (target.z - hVel.z) * Math.min(1, accel * dt);

  if (onGround && wish.lengthSq() < 1e-6) {
    hVel.multiplyScalar(Math.max(0, 1 - FRICTION_GROUND * dt));
  }

  playerVelocity.x = hVel.x;
  playerVelocity.z = hVel.z;

  if (keys.Space && onGround) {
    playerVelocity.y = JUMP_SPEED;
    onGround = false;
  }

  const subDt = dt / PHYSICS_SUBSTEPS;
  const stepMove = new THREE.Vector3();

  for (let s = 0; s < PHYSICS_SUBSTEPS; s++) {
    applyGravity(subDt);

    stepMove.copy(playerVelocity).multiplyScalar(subDt);
    player.position.add(stepMove);

    const corr = checkCollisions();
    if (corr.lengthSq() > 1e-12) {
      slideAlongWalls(corr);
      player.position.add(corr);
      if (corr.y > Math.abs(playerVelocity.y * subDt) * 0.2 && playerVelocity.y <= 0.05) {
        onGround = true;
      }
    }

    if (snapToGround(subDt)) {
      onGround = true;
    }
  }

  if (playerVelocity.y > 0.5) onGround = false;

  syncCamera();
}

/** Raycast BVH vers le bas — escaliers / rampes */
function snapToGround(subDt) {
  const tree = colliderMesh?.geometry?.boundsTree;
  if (!tree) return false;

  if (playerVelocity.y > 0.35) return false;

  const origin = _tempVec.copy(player.position);
  origin.y += CAPSULE_HEIGHT - 0.05;
  const ray = new THREE.Ray(origin, _tempVec2.set(0, -1, 0));
  const hit = tree.raycastFirst(ray, THREE.DoubleSide);
  if (!hit) return false;

  const feetY = player.position.y;
  const wantFeet = hit.point.y + 1e-3;
  const dy = wantFeet - feetY;
  const maxStep = 0.42 + Math.abs(playerVelocity.y) * subDt * 3;

  if (dy > -0.06 && dy < maxStep) {
    player.position.y = wantFeet;
    if (playerVelocity.y < 0) playerVelocity.y = 0;
    return true;
  }
  return false;
}

function syncCamera() {
  camera.position.set(
    player.position.x,
    player.position.y + EYE_HEIGHT,
    player.position.z
  );
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;
}

// ---------------------------------------------------------------------------
// Entrées + boucle
// ---------------------------------------------------------------------------
function bindInput() {
  const blocker = document.getElementById('blocker');
  renderer.domElement.addEventListener('click', () => {
    renderer.domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === renderer.domElement) {
      blocker?.classList.add('hidden');
    } else {
      blocker?.classList.remove('hidden');
    }
  });

  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    yaw -= e.movementX * MOUSE_SENS;
    pitch -= e.movementY * MOUSE_SENS;
    pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, pitch));
  });
}

function hudUpdate() {
  const el = document.getElementById('hud');
  if (!el) return;
  el.innerHTML = [
    `Vitesse XZ : ${Math.hypot(playerVelocity.x, playerVelocity.z).toFixed(2)}`,
    onGround ? 'Sol : oui' : 'Sol : non',
    `Pos : ${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)}`,
  ].join('<br/>');
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (player && colliderMesh) {
    movePlayer(dt);
    hudUpdate();
  }
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main() {
  try {
    initScene();
    bindInput();
    const { spawn } = await loadModels();
    createPlayerCapsule(spawn);
    syncCamera();
    animate();
  } catch (e) {
    console.error(e);
    document.getElementById('blocker')?.classList.remove('hidden');
    document.getElementById('blocker').innerHTML =
      `<div style="max-width:420px;padding:16px">Erreur : ${e.message}<br/><br/>
      Vérifie que <b>map.glb</b> et <b>collision.glb</b> sont dans le dossier <b>capsule-fps/</b>
      (ou change MAP_URL / COLLISION_URL dans capsule-fps-system.js).<br/><br/>
      Lance un serveur HTTP local (pas file://).</div>`;
  }
}

main();
