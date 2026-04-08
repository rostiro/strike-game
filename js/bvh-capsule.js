/**
 * Capsule vs MeshBVH — modular FPS collision.
 *
 * ## Blender / glTF preparation (export collision.glb)
 * - One mesh per logical object (wall, floor slab, stair flight, crate, …).
 * - Apply all transforms before export: Object → Apply (Location, Rotation, Scale).
 * - Optional: disable rendering on the collision collection; only load it for physics.
 *
 * ## Per-mesh labels (Custom Properties → exported as userData)
 * Set `type` (string) on each collision mesh:
 *   - 'floor'  → walkable: vertical ground rays snap here; excluded from horizontal BVH
 *                (no “invisible wall” on flat ground).
 *   - 'stair'  → same as floor for snapping; excluded from horizontal BVH (use separate
 *                'wall' meshes for stringers/risers if the player must not pass through sides).
 *   - 'wall'   → blocks movement; full X/Z slide; never used as ground snap target.
 *   - 'object' → small props (tables, crates): block X/Z only; never used as ground snap.
 *
 * If **any** mesh in the file has `userData.type` set, unknown/missing types are treated as **'wall'**
 * (conservative: never lose a collider). If **no** mesh is typed, legacy heuristics apply
 * (name + bounding box) for walkable vs blocker split.
 *
 * Performance: BVH builds run once at load; nothing is recomputed per frame.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

/** When using a merged “everything” BVH for horizontal, skip nearly-horizontal triangles (floors). */
export const HORIZONTAL_COLLISION_MAX_UP_NORMAL = 0.45;

export const WALKABLE_MIN_FOOTPRINT_XZ = 2.0;
export const WALKABLE_MAX_VERTICAL_EXTENT = 0.55;
export const PROP_MAX_FOOTPRINT_XZ = 1.4;
export const PROP_MAX_VERTICAL_EXTENT = 2.25;

const RE_WALKABLE_NAME =
  /floor|ground|sol|terrain|nav|walkmesh|stair|stairs|step|marche|escalier|ramp|rampe|pavement|trottoir|route|road|dalle|deck|platform|sol_|_sol|concrete_slab|asphalt|walk|piso|suelo/i;

const RE_PROP_NAME =
  /table|chair|chaise|crate|caisse|box|meuble|furniture|desk|bureau|lamp|lampe|barrel|baril|bush|pot|plant|vase|prop_|_prop|detail|decor|bench|bed|canap|sofa|locker|cabinet|shelf|etagere|counter|comptoir|stool|tabouret|crate_|_crate|small_/i;

/** Read Blender custom property `type` (or optional `collisionType`). */
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

/** Legacy / overrides (still supported). */
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

/**
 * Walkable BVH membership (ground rays only).
 */
export function meshIsWalkableForGround(mesh, sx, sy, sz, explicitTypeMode) {
  const t = getCollisionMeshType(mesh);
  if (t === 'floor' || t === 'stair') return true;
  if (t === 'object' || t === 'wall') return false;
  if (explicitTypeMode) return false;
  return classifyMeshWalkable(mesh, sx, sy, sz);
}

/**
 * Horizontal blocker BVH membership (walls + props + unknown when typed).
 */
export function meshIsHorizontalBlocker(mesh, sx, sy, sz, explicitTypeMode) {
  const t = getCollisionMeshType(mesh);
  if (t === 'object' || t === 'wall') return true;
  if (t === 'floor' || t === 'stair') return false;
  if (explicitTypeMode) return true;
  return !classifyMeshWalkable(mesh, sx, sy, sz);
}

/** Visual mesh raycast: skip props / walls for ground snap. */
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

/**
 * @returns {{
 *   fullGeometry: THREE.BufferGeometry | null,
 *   walkableGeometry: THREE.BufferGeometry | null,
 *   blockerGeometry: THREE.BufferGeometry | null,
 *   collisionMeshes: THREE.Mesh[],
 *   stats: object,
 *   explicitTypeMode: boolean,
 *   horizontalUsesBlockerOnly: boolean,
 * }}
 */
export function buildPartitionedCollisionBVH(root) {
  const emptyStats = {
    total: 0,
    walkable: 0,
    blocker: 0,
    floorStair: 0,
    wallObject: 0,
  };

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
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    entries.push({ mesh: o, geom: g, sx, sy, sz });
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
  const blockParts = [];

  let nWalk = 0;
  let nBlock = 0;
  let nFloorStair = 0;
  let nWallObject = 0;

  for (const e of entries) {
    const t = getCollisionMeshType(e.mesh);
    if (t === 'floor' || t === 'stair') nFloorStair++;
    if (t === 'object' || t === 'wall') nWallObject++;

    const walk = meshIsWalkableForGround(e.mesh, e.sx, e.sy, e.sz, explicitTypeMode);
    const block = meshIsHorizontalBlocker(e.mesh, e.sx, e.sy, e.sz, explicitTypeMode);

    if (walk) {
      walkParts.push(e.geom.clone());
      nWalk++;
    }
    if (block) {
      blockParts.push(e.geom.clone());
      nBlock++;
    }
  }

  const mergedFull = _mergeBVH(fullParts);
  const mergedWalk = walkParts.length ? _mergeBVH(walkParts) : null;
  let mergedBlock = blockParts.length ? _mergeBVH(blockParts) : null;
  const horizontalUsesBlockerOnly = mergedBlock != null && blockParts.length > 0;

  if (!mergedBlock && mergedFull) {
    mergedBlock = mergedFull;
  }

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

/**
 * Horizontal capsule resolve (X/Z only on player Y).
 * @param {{ passes?: number, skipFloorLikeTriangles?: boolean }} [opts]
 */
export function bvhHorizontalMoveAndResolve(pos, dx, dz, radius, height, geometry, opts = {}) {
  const passes = opts.passes ?? 10;
  const skipFloorLikeTriangles = opts.skipFloorLikeTriangles !== false;

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

/**
 * Resolve horizontal move in two axis steps (reduces corner snagging vs one diagonal push).
 */
export function bvhHorizontalMoveAndResolveSplitAxes(pos, dx, dz, radius, height, geometry, opts = {}) {
  if (Math.abs(dx) < 1e-12 && Math.abs(dz) < 1e-12) return;
  bvhHorizontalMoveAndResolve(pos, dx, 0, radius, height, geometry, opts);
  bvhHorizontalMoveAndResolve(pos, 0, dz, radius, height, geometry, opts);
}

/** Full geometry 3D ejection — spawn / respawn inside colliders. */
export function bvhResolveCapsuleFeet(pos, radius, height, geometry, iterations = 12) {
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

export function bvhGroundYBelow(geometry, x, feetY, z) {
  const tree = geometry?.boundsTree;
  if (!tree) return -9999;

  _ray.origin.set(x, feetY + 2.2, z);
  _ray.direction.copy(_down);
  const hit = tree.raycastFirst(_ray, THREE.DoubleSide);
  if (!hit || hit.point === undefined) return -9999;

  const py = hit.point.y;
  if (py > feetY + 0.35) return -9999;
  if (py < feetY - 15) return -9999;

  if (hit.face && hit.object) {
    _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    if (_n.y <= 0.06) return -9999;
  }

  return py;
}

export function bvhSpawnGroundY(geometry, x, z, preferY, mapMaxY) {
  const tree = geometry?.boundsTree;
  if (!tree) return -9999;

  const originY = Math.max((mapMaxY ?? preferY + 200) + 80, preferY + 80);
  _ray.origin.set(x, originY, z);
  _ray.direction.copy(_down);
  const hit = tree.raycastFirst(_ray, THREE.DoubleSide);
  if (!hit?.point) return -9999;
  return hit.point.y;
}
