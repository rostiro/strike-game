/**
 * Capsule vs MeshBVH — physics helpers (build once per map load).
 *
 * Blender: see previous docs (userData.type floor|stair|wall|object).
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const NO_GROUND = -9999;

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _triP = new THREE.Vector3();
const _capP = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pre = new THREE.Vector3();
const _ray = new THREE.Ray();
const _down = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

export const HORIZONTAL_COLLISION_MAX_UP_NORMAL = 0.45;
export const WALKABLE_MIN_FOOTPRINT_XZ = 2.0;
export const WALKABLE_MAX_VERTICAL_EXTENT = 0.55;
export const PROP_MAX_FOOTPRINT_XZ = 1.4;
export const PROP_MAX_VERTICAL_EXTENT = 2.25;

const RE_WALKABLE_NAME =
  /floor|ground|sol|terrain|nav|walkmesh|stair|stairs|step|marche|escalier|ramp|rampe|pavement|trottoir|route|road|dalle|deck|platform|sol_|_sol|concrete_slab|asphalt|walk|piso|suelo/i;

const RE_PROP_NAME =
  /table|chair|chaise|crate|caisse|box|meuble|furniture|desk|bureau|lamp|lampe|barrel|baril|bush|pot|plant|vase|prop_|_prop|detail|decor|bench|bed|canap|sofa|locker|cabinet|shelf|etagere|counter|comptoir|stool|tabouret|crate_|_crate|small_/i;

export function getCollisionMeshType(mesh) {
  const raw = mesh.userData?.type ?? mesh.userData?.collisionType;
  if (raw == null || raw === '') return null;
  return String(raw).toLowerCase().trim();
}

function rootHasAnyExplicitType(root) {
  let any = false;
  root.traverse((o) => {
    if (o.isMesh && getCollisionMeshType(o) != null) any = true;
  });
  return any;
}

export function classifyMeshWalkable(mesh, sx, sy, sz) {
  if (mesh.userData?.walkableGround) return true;
  if (mesh.userData?.propOnly) return false;
  const name = mesh.name || '';
  if (RE_PROP_NAME.test(name)) return false;
  if (RE_WALKABLE_NAME.test(name)) return true;
  const foot = Math.max(sx, sz, 1e-6);
  if (foot <= PROP_MAX_FOOTPRINT_XZ && sy <= PROP_MAX_VERTICAL_EXTENT) return false;
  if (foot >= WALKABLE_MIN_FOOTPRINT_XZ && sy <= WALKABLE_MAX_VERTICAL_EXTENT) return true;
  return false;
}

export function meshIsWalkableForGround(mesh, sx, sy, sz, explicitTypeMode) {
  const t = getCollisionMeshType(mesh);
  if (t === 'floor' || t === 'stair') return true;
  if (t === 'object' || t === 'wall') return false;
  if (explicitTypeMode) return false;
  return classifyMeshWalkable(mesh, sx, sy, sz);
}

export function meshIsHorizontalBlocker(mesh, sx, sy, sz, explicitTypeMode) {
  const t = getCollisionMeshType(mesh);
  if (t === 'object' || t === 'wall') return true;
  if (t === 'floor' || t === 'stair') return false;
  if (explicitTypeMode) return true;
  return !classifyMeshWalkable(mesh, sx, sy, sz);
}

export function meshShouldSkipGroundSnap(mesh) {
  if (!mesh) return false;
  if (mesh.userData?.walkableGround) return false;
  if (mesh.userData?.propOnly) return true;
  const t = getCollisionMeshType(mesh);
  if (t === 'object' || t === 'wall') return true;
  if (t === 'floor' || t === 'stair') return false;
  return RE_PROP_NAME.test(mesh.name || '');
}

function _triangleUpNormal(tri, target) {
  if (typeof tri.getNormal === 'function') {
    tri.getNormal(target);
    return;
  }
  const a = tri.a;
  const b = tri.b;
  const c = tri.c;
  _e1.subVectors(b, a);
  _e2.subVectors(c, a);
  target.crossVectors(_e1, _e2).normalize();
}

function _mergeBVH(geoms) {
  if (geoms.length === 0) return null;
  const merged = mergeGeometries(geoms, true);
  merged.computeBoundingSphere();
  merged.boundsTree = new MeshBVH(merged);
  return merged;
}

export function buildPartitionedCollisionBVH(root) {
  const emptyStats = { total: 0, walkable: 0, blocker: 0, floorStair: 0, wallObject: 0 };

  if (!root) {
    return {
      fullGeometry: null,
      walkableGeometry: null,
      blockerGeometry: null,
      collisionMeshes: [],
      stats: emptyStats,
      explicitTypeMode: false,
      horizontalUsesBlockerOnly: false,
    };
  }

  root.updateMatrixWorld(true);
  const explicitTypeMode = rootHasAnyExplicitType(root);
  const entries = [];
  const collisionMeshes = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    collisionMeshes.push(o);
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (!g.attributes.position || g.attributes.position.count < 3) return;
    g.computeBoundingBox();
    const b = g.boundingBox;
    entries.push({ mesh: o, geom: g, sx: b.max.x - b.min.x, sy: b.max.y - b.min.y, sz: b.max.z - b.min.z });
  });

  if (entries.length === 0) {
    return {
      fullGeometry: null,
      walkableGeometry: null,
      blockerGeometry: null,
      collisionMeshes,
      stats: emptyStats,
      explicitTypeMode,
      horizontalUsesBlockerOnly: false,
    };
  }

  const fullParts = entries.map((e) => e.geom);
  const walkParts = [];
  let nWalk = 0;
  let nBlock = 0;
  let nFloorStair = 0;
  let nWallObject = 0;

  for (const e of entries) {
    const t = getCollisionMeshType(e.mesh);
    if (t === 'floor' || t === 'stair') nFloorStair++;
    if (t === 'object' || t === 'wall') nWallObject++;
    if (meshIsWalkableForGround(e.mesh, e.sx, e.sy, e.sz, explicitTypeMode)) {
      walkParts.push(e.geom.clone());
      nWalk++;
    }
    if (meshIsHorizontalBlocker(e.mesh, e.sx, e.sy, e.sz, explicitTypeMode)) nBlock++;
  }

  const mergedFull = _mergeBVH(fullParts);
  const mergedWalk = walkParts.length ? _mergeBVH(walkParts) : null;
  /**
   * Capsule horizontale : toujours le BVH **complet**. Sinon, si tout est typé « floor »,
   * le sous-ensemble « blocker » est vide → on ne testait plus de murs (traverser les bâtiments).
   * Le découpage walkable sert uniquement aux rayons « sol » (évite snap sur tables, etc.).
   */
  const mergedBlock = mergedFull;
  const horizontalUsesBlockerOnly = false;

  return {
    fullGeometry: mergedFull,
    walkableGeometry: mergedWalk,
    blockerGeometry: mergedBlock,
    collisionMeshes,
    stats: {
      total: entries.length,
      walkable: nWalk,
      blocker: nBlock,
      floorStair: nFloorStair,
      wallObject: nWallObject,
    },
    explicitTypeMode,
    horizontalUsesBlockerOnly,
  };
}

export function mergeWorldCollisionGeometry(root) {
  const { fullGeometry } = buildPartitionedCollisionBVH(root);
  return fullGeometry;
}

export function bvhHorizontalMoveAndResolve(pos, dx, dz, radius, height, geometry, opts = {}) {
  const passes = opts.passes ?? 14;
  /** Par défaut false : tester tous les triangles (murs + dalles). Activer seulement si doublons avec un autre système. */
  const skipFloorLikeTriangles = opts.skipFloorLikeTriangles === true;
  const tree = geometry?.boundsTree;
  if (!tree) {
    pos.x += dx;
    pos.z += dz;
    return;
  }

  pos.x += dx;
  pos.z += dz;
  const endY = pos.y + Math.max(radius * 1.2, height * 0.92);

  for (let p = 0; p < passes; p++) {
    _pre.set(pos.x, pos.y + radius, pos.z);
    _seg.start.copy(_pre);
    _seg.end.set(pos.x, endY, pos.z);
    _box.makeEmpty();
    _box.expandByPoint(_seg.start);
    _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius);
    _box.max.addScalar(radius);

    tree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        _triangleUpNormal(tri, _n);
        if (skipFloorLikeTriangles && _n.y > HORIZONTAL_COLLISION_MAX_UP_NORMAL) return;
        const dist = tri.closestPointToSegment(_seg, _triP, _capP);
        if (dist >= radius) return;
        const depth = radius - dist;
        _dir.subVectors(_capP, _triP);
        _dir.y = 0;
        if (_dir.lengthSq() < 1e-12) {
          _dir.set(_n.x, 0, _n.z);
          if (_dir.lengthSq() < 1e-12) return;
        }
        _dir.normalize();
        _seg.start.addScaledVector(_dir, depth);
        _seg.end.addScaledVector(_dir, depth);
      },
    });

    const ddx = _seg.start.x - _pre.x;
    const ddz = _seg.start.z - _pre.z;
    if (Math.abs(ddx) + Math.abs(ddz) < 1e-9) break;
    pos.x += ddx;
    pos.z += ddz;
  }
}

export function bvhHorizontalMoveAndResolveSplitAxes(pos, dx, dz, radius, height, geometry, opts = {}) {
  if (Math.abs(dx) < 1e-12 && Math.abs(dz) < 1e-12) return;
  bvhHorizontalMoveAndResolve(pos, dx, 0, radius, height, geometry, opts);
  bvhHorizontalMoveAndResolve(pos, 0, dz, radius, height, geometry, opts);
}

export function bvhResolveCapsuleFeet(pos, radius, height, geometry, iterations = 14) {
  const tree = geometry?.boundsTree;
  if (!tree) return;
  const endY = pos.y + Math.max(radius * 1.2, height * 0.92);
  for (let p = 0; p < iterations; p++) {
    _pre.set(pos.x, pos.y + radius, pos.z);
    _seg.start.copy(_pre);
    _seg.end.set(pos.x, endY, pos.z);
    _box.makeEmpty();
    _box.expandByPoint(_seg.start);
    _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius);
    _box.max.addScalar(radius);
    let moved = false;
    tree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(_seg, _triP, _capP);
        if (dist < radius) {
          moved = true;
          const depth = radius - dist;
          _dir.subVectors(_capP, _triP);
          if (_dir.lengthSq() < 1e-14) _dir.set(0, 1, 0);
          else _dir.normalize();
          _seg.start.addScaledVector(_dir, depth);
          _seg.end.addScaledVector(_dir, depth);
        }
      },
    });
    if (!moved) break;
    pos.x += _seg.start.x - _pre.x;
    pos.y += _seg.start.y - _pre.y;
    pos.z += _seg.start.z - _pre.z;
  }
}

/**
 * Single vertical ray on BVH. Options adapt probe depth to map height.
 * @param {{ probeAboveFeet?: number; maxStepUp?: number; maxDropBelowFeet?: number }} [opts]
 */
export function bvhGroundYBelow(geometry, x, feetY, z, opts = {}) {
  const tree = geometry?.boundsTree;
  if (!tree) return NO_GROUND;

  const probeAbove = opts.probeAboveFeet ?? 2.45;
  const maxStepUp = opts.maxStepUp ?? 0.48;
  const maxDrop = opts.maxDropBelowFeet ?? 60;

  _ray.origin.set(x, feetY + probeAbove, z);
  _ray.direction.copy(_down);
  const hit = tree.raycastFirst(_ray, THREE.DoubleSide);
  if (!hit || hit.point === undefined) return NO_GROUND;

  const py = hit.point.y;
  if (py > feetY + maxStepUp) return NO_GROUND;
  if (py < feetY - maxDrop) return NO_GROUND;

  if (hit.face && hit.object) {
    _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    if (_n.y <= 0.05) return NO_GROUND;
  }
  return py;
}

/** Several rays around (x,z) — stable on uneven meshes / edges. */
export function bvhGroundYBelowMulti(geometry, x, feetY, z, sampleRadius, opts = {}) {
  if (!geometry?.boundsTree) return NO_GROUND;
  const pat = [
    [0, 0],
    [0.85, 0],
    [-0.85, 0],
    [0, 0.85],
    [0, -0.85],
    [0.6, 0.6],
    [-0.6, 0.6],
    [0.6, -0.6],
    [-0.6, -0.6],
  ];
  let best = NO_GROUND;
  const r = Math.max(0.001, sampleRadius);
  for (const [kx, kz] of pat) {
    const y = bvhGroundYBelow(geometry, x + kx * r, feetY, z + kz * r, opts);
    if (y > best) best = y;
  }
  return best;
}

export function bvhSpawnGroundY(geometry, x, z, preferY, mapMaxY, opts = {}) {
  const tree = geometry?.boundsTree;
  if (!tree) return NO_GROUND;
  const extra = opts.spawnExtraAboveMax ?? 120;
  const originY = Math.max((mapMaxY ?? preferY + 200) + extra, preferY + 80);
  _ray.origin.set(x, originY, z);
  _ray.direction.copy(_down);
  const hit = tree.raycastFirst(_ray, THREE.DoubleSide);
  if (!hit?.point) return NO_GROUND;
  return hit.point.y;
}
