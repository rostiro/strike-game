import * as THREE from 'three';
import {
  bvhGroundYBelow,
  bvhHorizontalMoveAndResolveSplitAxes,
  bvhResolveCapsuleFeet,
  bvhSpawnGroundY,
  buildPartitionedCollisionBVH,
  meshShouldSkipGroundSnap,
} from './bvh-capsule.js';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _n = new THREE.Vector3();
const _spawnTry = new THREE.Vector3();

/** Distance (m) sous le point le plus bas de la bbox du GLB visuel : plancher infini pour éviter la chute. */
const SAFETY_FLOOR_OFFSET = 12;

/** Meshes dont le nom indique qu’on ne doit pas générer de murs (décor, LOD, etc.) */
const RE_SKIP_WALL_BY_NAME = /no_?collide|nocol|decal|ignore_?mesh|trigger|volume|helper|proxy|lod\d|_lod|sky(box)?|emissive_only|glass_|nav_?mesh|blockout|occluder|occlusion|cull|invis|hidden|backdrop|debug|wire|bounds_?only|editor_|__preview|collisionpreview|stair|stairs|step|marche|escalier|ramp|rampe|balustr|banister|handrail/i;
/** Si au moins un mesh porte ce motif, seuls eux servent de murs (précision Blender / GLB dédié) */
const RE_COLLIDER_ONLY = /collider|_collision|collision_|^col_|blocking|hitbox|phys_/i;

function isObjectWorldVisible(obj) {
  let o = obj;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

/** Matériau quasi invisible → souvent collision de debug / proxy dans le GLB */
function _meshFullyTransparent(mesh) {
  const mats = mesh.material;
  const arr = Array.isArray(mats) ? mats : mats ? [mats] : [];
  if (arr.length === 0) return false;
  return arr.every(m => {
    if (!m) return false;
    if (m.visible === false) return true;
    if (m.opacity !== undefined && m.opacity < 0.04) return true;
    return false;
  });
}

function _meshSkippedForWall(mesh, useColliderOnly) {
  if (mesh.userData?.noWall || mesh.userData?.noCollide) return true;
  if (!isObjectWorldVisible(mesh)) return true;
  if (_meshFullyTransparent(mesh)) return true;
  if (useColliderOnly) return !RE_COLLIDER_ONLY.test(mesh.name);
  if (RE_SKIP_WALL_BY_NAME.test(mesh.name)) return true;
  return false;
}

export class CollisionWorld {
  constructor() {
    this.walls = [];
    this.meshes = [];
    this.mapBounds = new THREE.Box3();
    this.allMeshesForRaycast = [];
    this.customSpawns = [];
    /** true si des meshes “collision_*” existent : murs = eux seuls */
    this._wallsFromCollidersOnly = false;
    /** true si buildFromGLB a été appelé avec wallMode ground sans colliders dédiés */
    this._groundOnlyNoWalls = false;
    /** Mode auto : au-delà de cette hauteur (m), on ne teste le mur qu’autour des pieds du joueur (multi-étages / bbox géante). */
    this._autoTallWallHeight = 3.35;
    /** Demi-fenêtre verticale (m) autour de pos.y pour ce découpage */
    this._autoWallSliceHalfSpan = 3.05;
    /** BVH complet (tous les meshes) — éjection spawn / overlap 3D */
    this._bvhGeometry = null;
    /** BVH murs + props (+ héristique) — capsule slide horizontal (souvent ≠ sol) */
    this._bvhBlockerGeometry = null;
    /** Si false : le BVH horizontal est le merge complet → ignorer les triangles « plancher ». */
    this._bvhHorizontalSkipFloorLike = true;
    /** Meshes du dernier collision.glb (références Three.js, bbox statiques) */
    this.collisionMeshes = [];
    /** BVH « floor / stair » uniquement — rayons verticaux (pas de snap sur props/murs) */
    this._bvhWalkableGeometry = null;
    /** Si true, _addBorders() a été demandé — réappliqué après attach BVH (les bords ne sont pas dans collision.glb). */
    this._wantBoundaryWalls = false;
    /** Y du plancher de secours (sous mapBounds.min.y), ou null si pas de carte chargée */
    this._safetyFloorY = null;
  }

  /** Sol « infini » sous la carte ; null si aucune bbox. */
  getSafetyFloorY() {
    return this._safetyFloorY;
  }

  _fallbackSafetyGroundY() {
    if (this._safetyFloorY != null && !this.mapBounds.isEmpty()) return this._safetyFloorY;
    return -9999;
  }

  _recomputeSafetyFloor() {
    if (this.mapBounds.isEmpty()) {
      this._safetyFloorY = null;
      return;
    }
    this._safetyFloorY = this.mapBounds.min.y - SAFETY_FLOOR_OFFSET;
  }

  get useBVH() {
    return !!this._bvhGeometry?.boundsTree;
  }

  /**
   * Active les collisions précises depuis une scène GLB dédiée (souvent collision.glb).
   * Les murs AABB existants sont vidés pour éviter le double blocage.
   */
  attachBVHFromGLTFScene(collisionRoot) {
    const {
      fullGeometry,
      walkableGeometry,
      blockerGeometry,
      collisionMeshes,
      stats,
      explicitTypeMode,
      horizontalUsesBlockerOnly,
    } = buildPartitionedCollisionBVH(collisionRoot);
    if (!fullGeometry) {
      console.warn('[Collisions] attachBVH : aucune géométrie fusionnable.');
      return false;
    }
    this._bvhGeometry = fullGeometry;
    this._bvhBlockerGeometry = blockerGeometry || fullGeometry;
    this._bvhHorizontalSkipFloorLike = !horizontalUsesBlockerOnly;
    this.collisionMeshes = collisionMeshes;
    this._bvhWalkableGeometry = walkableGeometry;
    this.walls.length = 0;
    if (this._wantBoundaryWalls) this._addBorders();
    const mode = explicitTypeMode ? 'userData.type (floor|stair|wall|object)' : 'heuristique + noms';
    console.log(
      `[Collisions] MeshBVH [${mode}] : ${stats.total} mesh(es) — ` +
        `walkable ${stats.walkable} (rayons Y), blocker ${stats.blocker} (slide XZ)` +
        (this.walls.length ? `, murs périphérie : ${this.walls.length}.` : '.')
    );
    if (!walkableGeometry) {
      console.warn(
        '[Collisions] Aucun mesh « walkable » : rayons verticaux sur BVH complet. ' +
          'Dans Blender, posez userData.type = floor | stair sur les dalles / marches.'
      );
    }
    return true;
  }

  setCustomSpawns(arr) {
    this.customSpawns = arr.map(s => new THREE.Vector3(s.x, s.y, s.z));
  }

  /**
   * Sol / dalles : gros sur XZ et très plat → pas de mur (évite trottoirs qui bloquent).
   * Murs fins : conservés même si bas (murets, rebords).
   */
  _isHorizontalSlab(sx, sy, sz) {
    const horiz = Math.max(sx, sz, 0.01);
    if (sy < 0.1) return true;
    if (sy < 0.22 && horiz > 0.8 && sy / horiz < 0.12) return true;
    // Dalles / routes un peu plus épaisses (souvent encore du sol, pas un mur)
    if (sy < 0.34 && horiz > 1.0 && sy / horiz < 0.15) return true;
    if (sy < 0.48 && horiz > 2.5 && sy / horiz < 0.13) return true;
    return false;
  }

  /**
   * Mode automatique : évite les boîtes qui bloquent sans visuel (poteaux, sol unique géant, etc.).
   * En mode colliders uniquement, non utilisé.
   */
  _automaticModeSkipWall(sx, sy, sz, mapArea) {
    const horiz = Math.max(sx, sz);
    const minxz = Math.min(sx, sz);
    const footprint = sx * sz;

    // Un seul mesh « sol » ou dalle énorme = toute la carte → ne pas en faire un mur vertical
    if (footprint > mapArea * 0.78 && sy < 8.0) return true;

    // Poteaux, lampadaires, troncs étroits, piliers décoratifs
    if (sy >= 0.42) {
      if (horiz < 0.58 && minxz < 0.30) return true;
      if (footprint < 0.18 && horiz < 0.52) return true;
    }

    // Barrières / bordures très basses et longues (souvent du décor au sol)
    if (sy < 0.38 && horiz > 1.2 && minxz < 0.22 && footprint > 0.5) return true;

    return false;
  }

  /**
   * Dalle / plancher d’étage (surface large, pas trop épais) — pas un mur vertical en mode auto.
   */
  _isInterfloorDeck(sx, sy, sz) {
    if (sy < 0.12 || sy > 2.25) return false;
    const horiz = Math.max(sx, sz);
    const minxz = Math.min(sx, sz);
    const footprint = sx * sz;
    if (horiz / Math.max(sy, 0.07) >= 3.8 && footprint >= 0.65) return true;
    if (footprint >= 2.2 && sy < 1.15 && minxz > 0.28) return true;
    return false;
  }

  /**
   * Chevauchement vertical mur / capsule. En mode auto, les murs très hauts sont « découpés » autour du joueur
   * pour éviter qu’une bbox 0→10 m bloque au sol à cause du 2ᵉ étage dans le même mesh.
   */
  _wallYZOverlapsCapsule(w, pos, py, top) {
    const lo = w.min.y;
    const hi = w.max.y;
    if (hi < py || lo > top) return false;
    if (this._wallsFromCollidersOnly) return true;
    const sy = hi - lo;
    if (sy <= this._autoTallWallHeight) return true;
    const feet = pos.y;
    const half = this._autoWallSliceHalfSpan;
    const slo = Math.max(lo, feet - half);
    const shi = Math.min(hi, feet + half);
    if (slo >= shi - 1e-4) return false;
    return shi >= py && slo <= top;
  }

  /** Rétrécit légèrement la boîte en XZ pour coller un peu mieux au visuel du nouveau GLB */
  _insetWallBox(box, inset) {
    const out = box.clone();
    out.min.x += inset;
    out.max.x -= inset;
    out.min.z += inset;
    out.max.z -= inset;
    if (out.min.x >= out.max.x || out.min.z >= out.max.z) return null;
    return out;
  }

  /**
   * @param {THREE.Object3D} root
   * @param {{ boundaryWalls?: boolean; wallMode?: 'auto' | 'ground' }} [options]
   *   boundaryWalls: si true (défaut), ajoute 4 AABB invisibles sur les bords de la bbox du modèle.
   *   wallMode: 'auto' = murs heuristiques depuis les meshes. 'ground' = aucun mur auto (sol / raycast
   *   seulement) — utile si tu restes bloqué (multi-étages, grosse bbox). Les meshes nommés collision_*
   *   sont toujours pris en compte même en 'ground'.
   */
  buildFromGLB(root, options = {}) {
    const boundaryWalls = options.boundaryWalls !== false;
    const wallMode = options.wallMode === 'ground' ? 'ground' : 'auto';

    this._bvhGeometry = null;
    this._bvhBlockerGeometry = null;
    this._bvhHorizontalSkipFloorLike = true;
    this.collisionMeshes = [];
    this._bvhWalkableGeometry = null;
    this._wantBoundaryWalls = false;
    this._safetyFloorY = null;
    this.walls.length = 0;
    this.meshes.length = 0;
    this.allMeshesForRaycast.length = 0;
    this._wallsFromCollidersOnly = false;

    root.traverse(n => {
      if (!n.isMesh) return;
      n.updateWorldMatrix(true, false);
      this.meshes.push(n);
    });

    this.allMeshesForRaycast = this.meshes.slice();
    this.mapBounds.setFromObject(root);

    const mapFootX = Math.max(this.mapBounds.max.x - this.mapBounds.min.x, 1);
    const mapFootZ = Math.max(this.mapBounds.max.z - this.mapBounds.min.z, 1);
    const mapArea = mapFootX * mapFootZ;

    const colliderMeshes = this.meshes.filter(m => RE_COLLIDER_ONLY.test(m.name));
    const useColliderOnly = colliderMeshes.length > 0;
    this._wallsFromCollidersOnly = useColliderOnly;

    const skipAutoWalls = wallMode === 'ground' && !useColliderOnly;
    this._groundOnlyNoWalls = skipAutoWalls;

    const inset = Math.min(0.04, Math.max(0.012, Math.min(mapFootX, mapFootZ) * 0.0008));

    if (!skipAutoWalls) {
      for (const mesh of this.meshes) {
        if (_meshSkippedForWall(mesh, useColliderOnly)) continue;

        _box.setFromObject(mesh);
        _box.getSize(_size);
        if (_size.x < 0.015 && _size.y < 0.015 && _size.z < 0.015) continue;

        if (!useColliderOnly && this._isHorizontalSlab(_size.x, _size.y, _size.z)) continue;
        if (!useColliderOnly && this._isInterfloorDeck(_size.x, _size.y, _size.z)) continue;
        if (!useColliderOnly && this._automaticModeSkipWall(_size.x, _size.y, _size.z, mapArea)) continue;

        const shrunk = this._insetWallBox(_box, inset);
        if (shrunk) this.walls.push(shrunk);
      }
    }

    // Périphérie : indépendante du mode ground (sinon impossible d’avoir bords + BVH + sol uniquement au centre).
    const addBounds = boundaryWalls;
    this._wantBoundaryWalls = addBounds;
    if (addBounds) {
      this._addBorders();
      console.log('[Collisions] Murs périphériques (invisibles) sur la bbox : activés');
    } else if (skipAutoWalls) {
      console.log('[Collisions] Mode ground : pas de cage aux bords de la bbox.');
    } else {
      console.log('[Collisions] Murs périphériques bbox : désactivés');
    }

    if (skipAutoWalls) {
      console.log('[Collisions] Mode wallMode=ground : 0 mur auto — déplacement au sol uniquement (pas de blocage XZ). Ajoute collision_* dans le GLB pour des vrais murs.');
    }

    const mode = useColliderOnly
      ? 'meshes collider uniquement'
      : skipAutoWalls
        ? 'sol uniquement (wallMode ground)'
        : 'heuristique + noms exclus';
    console.log(`[Collisions] ${this.walls.length} murs AABB, ${this.meshes.length} meshes raycast (${mode})`);
    if (!useColliderOnly && !skipAutoWalls) {
      console.log(`[Collisions] Multi-étages (auto) : murs > ${this._autoTallWallHeight}m découpés verticalement sur ±${this._autoWallSliceHalfSpan}m autour des pieds.`);
    }
    if (!useColliderOnly && !skipAutoWalls && this.walls.length > 220) {
      console.warn('[Collisions] Beaucoup de murs en mode auto — pour un résultat fiable, ajoute des meshes nommés collision_* dans le GLB.');
    }
    this._recomputeSafetyFloor();
    if (this._safetyFloorY != null) {
      console.log(
        `[Collisions] Plancher de secours Y≈${this._safetyFloorY.toFixed(2)} (min carte − ${SAFETY_FLOOR_OFFSET} m) — pas de chute infinie.`
      );
    }
    return this;
  }

  _addBorders() {
    const b = this.mapBounds;
    if (b.isEmpty()) return;
    const m = 0.3, h = 200;
    const mn = b.min, mx = b.max;
    this.walls.push(
      new THREE.Box3(new THREE.Vector3(mn.x - m, mn.y, mn.z - m), new THREE.Vector3(mn.x, mn.y + h, mx.z + m)),
      new THREE.Box3(new THREE.Vector3(mx.x, mn.y, mn.z - m), new THREE.Vector3(mx.x + m, mn.y + h, mx.z + m)),
      new THREE.Box3(new THREE.Vector3(mn.x - m, mn.y, mn.z - m), new THREE.Vector3(mx.x + m, mn.y + h, mn.z)),
      new THREE.Box3(new THREE.Vector3(mn.x - m, mn.y, mx.z), new THREE.Vector3(mx.x + m, mn.y + h, mx.z + m)),
    );
  }

  /**
   * Une passe : cercle (pos.x, pos.z, r) vs une AABB en XZ (même tranche Y que la capsule).
   * Sortie le long du vecteur le plus court (coin / bord), pas X puis Z — évite le « toujours à gauche ».
   */
  _separateCircleFromWallXZ(pos, w, py, top, r) {
    if (!this._wallYZOverlapsCapsule(w, pos, py, top)) return false;
    const minx = w.min.x;
    const maxx = w.max.x;
    const minz = w.min.z;
    const maxz = w.max.z;
    const cx = pos.x;
    const cz = pos.z;

    const qx = Math.max(minx, Math.min(cx, maxx));
    const qz = Math.max(minz, Math.min(cz, maxz));
    let dx = cx - qx;
    let dz = cz - qz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= r * r - 1e-14) return false;

    let nx;
    let nz;
    let pen;
    if (distSq > 1e-14) {
      const dist = Math.sqrt(distSq);
      nx = dx / dist;
      nz = dz / dist;
      pen = r - dist;
    } else {
      let best = Infinity;
      nx = 0;
      nz = 0;
      pen = 0;
      const penL = minx - (cx - r);
      if (penL > 0 && penL < best) {
        best = penL;
        nx = 1;
        nz = 0;
        pen = penL;
      }
      const penR = (cx + r) - maxx;
      if (penR > 0 && penR < best) {
        best = penR;
        nx = -1;
        nz = 0;
        pen = penR;
      }
      const penN = minz - (cz - r);
      if (penN > 0 && penN < best) {
        best = penN;
        nx = 0;
        nz = 1;
        pen = penN;
      }
      const penP = (cz + r) - maxz;
      if (penP > 0 && penP < best) {
        best = penP;
        nx = 0;
        nz = -1;
        pen = penP;
      }
      if (best >= Infinity) return false;
    }

    pos.x += nx * pen;
    pos.z += nz * pen;
    return true;
  }

  _resolveCapsuleXZPenetration(pos, py, top, r, wallIters = 10) {
    for (let iter = 0; iter < wallIters; iter++) {
      let changed = false;
      for (const w of this.walls) {
        if (this._separateCircleFromWallXZ(pos, w, py, top, r)) changed = true;
      }
      if (!changed) break;
    }
  }

  testMove(pos, dx, dz, radius, height) {
    if (Math.abs(dx) < 1e-10 && Math.abs(dz) < 1e-10) return;

    if (this.useBVH) {
      const horiz = this._bvhBlockerGeometry || this._bvhGeometry;
      bvhHorizontalMoveAndResolveSplitAxes(pos, dx, dz, radius, height, horiz, {
        skipFloorLikeTriangles: this._bvhHorizontalSkipFloorLike,
      });
      const py = pos.y + 0.04;
      const top = pos.y + height;
      this._resolveCapsuleXZPenetration(pos, py, top, radius);
      return;
    }

    const py = pos.y + 0.04;
    const top = pos.y + height;
    const r = radius;

    pos.x += dx;
    pos.z += dz;
    this._resolveCapsuleXZPenetration(pos, py, top, r);
  }

  /**
   * Éjecte la capsule des murs sans déplacement volontaire (spawn / respawn).
   * Sans ça, un point spawn à l’intérieur d’une AABB reste « coincé » jusqu’au premier
   * testMove, puis un seul pas peut provoquer une grosse correction (ex. téléport à gauche).
   */
  resolveSpawnOverlaps(pos, radius, height, iterations = 12) {
    if (this.useBVH) {
      bvhResolveCapsuleFeet(pos, radius, height, this._bvhGeometry, iterations);
      const py = pos.y + 0.04;
      const top = pos.y + height;
      this._resolveCapsuleXZPenetration(pos, py, top, radius, iterations);
      return;
    }
    const py = pos.y + 0.04;
    const top = pos.y + height;
    const r = radius;
    this._resolveCapsuleXZPenetration(pos, py, top, r, iterations);
  }

  /**
   * Cherche près du point désiré un spawn au sol, puis éjecte des murs.
   * Si l’éjection envoie au-dessus du vide, on essaie d’autres (x,z) au lieu
   * d’accepter une position sans sol (comportement de l’ancien correctif).
   */
  pickValidatedSpawn(desired, radius, height) {
    const baseX = desired.x;
    const baseZ = desired.z;
    const preferY = desired.y;
    const maxRing = 16;
    const step = 0.22;

    const tryCandidate = (x, z) => {
      let gy = this.getSpawnGroundY(x, z, preferY);
      if (gy < -9000) return false;
      _spawnTry.set(x, gy + 0.02, z);
      this.resolveSpawnOverlaps(_spawnTry, radius, height, 12);
      gy = this.getSpawnGroundY(_spawnTry.x, _spawnTry.z, preferY);
      if (gy < -9000) return false;
      _spawnTry.y = gy + 0.02;
      const gBelow = this.getGroundBelow(_spawnTry.x, _spawnTry.y, _spawnTry.z);
      if (gBelow < -9000) return false;
      if (Math.abs(_spawnTry.y - gBelow - 0.02) > 0.35) return false;
      return true;
    };

    for (let ri = 0; ri < maxRing; ri++) {
      const d = ri * step;
      if (ri === 0) {
        if (tryCandidate(baseX, baseZ)) return _spawnTry.clone();
        continue;
      }
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const x = baseX + Math.cos(a) * d;
        const z = baseZ + Math.sin(a) * d;
        if (tryCandidate(x, z)) return _spawnTry.clone();
      }
    }

    const gy = this.getSpawnGroundY(baseX, baseZ, preferY);
    if (gy > -9000) return new THREE.Vector3(baseX, gy + 0.02, baseZ);
    return desired.clone();
  }

  /**
   * Hauteur du sol sous (x,z) pour des pieds à feetY.
   * Prend la surface la plus haute sous les pieds (pas le premier hit aléatoire), pour éviter
   * de « perdre » le sol après un micro décalage ou une chute courte.
   */
  getGroundBelow(x, feetY, z) {
    if (this.useBVH) {
      const groundGeom =
        this._bvhWalkableGeometry?.boundsTree != null ? this._bvhWalkableGeometry : this._bvhGeometry;
      const gy = bvhGroundYBelow(groundGeom, x, feetY, z);
      if (gy > -9000) return gy;
    }

    if (this.meshes.length === 0) return this._fallbackSafetyGroundY();

    const originY = feetY + 1.2;
    _ray.ray.origin.set(x, originY, z);
    _ray.ray.direction.set(0, -1, 0);
    const minY = this.mapBounds.isEmpty() ? feetY - 500 : this.mapBounds.min.y - 250;
    _ray.far = Math.min(9000, Math.max(400, originY - minY));

    const hits = _ray.intersectObjects(this.meshes, false);
    if (hits.length === 0) return this._fallbackSafetyGroundY();

    let best = -9999;

    const considerNormal = (hit) => {
      if (!hit.face || !hit.object) return true;
      _n.set(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z);
      _n.transformDirection(hit.object.matrixWorld);
      return _n.y > 0.08;
    };

    for (const h of hits) {
      if (meshShouldSkipGroundSnap(h.object)) continue;
      const py = h.point.y;
      if (py > feetY + 0.32) continue;
      if (py < feetY - 12) continue;
      if (!considerNormal(h)) continue;
      best = Math.max(best, py);
    }

    if (best > -9000) return best;

    for (const h of hits) {
      if (meshShouldSkipGroundSnap(h.object)) continue;
      const py = h.point.y;
      if (py <= feetY + 1.2 && py >= feetY - 25) best = Math.max(best, py);
    }

    return best > -9000 ? best : this._fallbackSafetyGroundY();
  }

  getGroundHeightBelow(x, y, z) {
    return this.getGroundBelow(x, y, z);
  }

  /**
   * Sol pour un spawn aléatoire (pas les spawns custom) : rayon du haut de la bbox.
   */
  getSpawnGroundY(x, z, preferY = 0) {
    if (this.useBVH) {
      const maxY = this.mapBounds.isEmpty() ? preferY + 500 : this.mapBounds.max.y;
      const groundGeom =
        this._bvhWalkableGeometry?.boundsTree != null ? this._bvhWalkableGeometry : this._bvhGeometry;
      const gy = bvhSpawnGroundY(groundGeom, x, z, preferY, maxY);
      if (gy > -9000) return gy;
    }

    if (this.meshes.length === 0) return this._fallbackSafetyGroundY();
    const b = this.mapBounds;
    const top = (b.isEmpty() ? preferY + 500 : b.max.y) + 120;
    const originY = Math.max(top, preferY + 80);
    _ray.ray.origin.set(x, originY, z);
    _ray.ray.direction.set(0, -1, 0);
    const minY = b.isEmpty() ? originY - 4000 : b.min.y - 50;
    const vSpan = b.isEmpty() ? 800 : Math.max(b.max.y - b.min.y, 80);
    _ray.far = Math.min(20000, Math.max(350, originY - minY + 80, vSpan * 4));

    const hits = _ray.intersectObjects(this.meshes, false).filter(
      (h) => !meshShouldSkipGroundSnap(h.object)
    );
    if (hits.length === 0) return this._fallbackSafetyGroundY();

    const margins = [4, 25, 120, 800];
    for (const m of margins) {
      let best = -9999;
      for (const h of hits) {
        const py = h.point.y;
        if (py <= preferY + m) best = Math.max(best, py);
      }
      if (best > -9000) return best;
    }
    const lastY = hits[hits.length - 1].point.y;
    if (lastY > -9000) return lastY;
    return this._fallbackSafetyGroundY();
  }

  getRandomSpawnPoint() {
    const b = this.mapBounds;

    if (this.customSpawns.length > 0) {
      const c = this.customSpawns[Math.floor(Math.random() * this.customSpawns.length)];
      return c.clone();
    }

    if (b.isEmpty()) return new THREE.Vector3(0, 2, 0);

    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    const edge = Math.min(sx, sz) * 0.035;
    const minX = b.min.x + edge;
    const maxX = b.max.x - edge;
    const minZ = b.min.z + edge;
    const maxZ = b.max.z - edge;
    if (minX >= maxX || minZ >= maxZ) {
      const cx = (b.min.x + b.max.x) * 0.5;
      const cz = (b.min.z + b.max.z) * 0.5;
      const preferY = (b.min.y + b.max.y) * 0.5;
      const gy = this.getSpawnGroundY(cx, cz, preferY);
      if (gy > -9000) return new THREE.Vector3(cx, gy + 0.02, cz);
      return new THREE.Vector3(cx, b.max.y + 1, cz);
    }

    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const halfWx = Math.max((maxX - minX) * 0.22, 1.2);
    const halfWz = Math.max((maxZ - minZ) * 0.22, 1.2);
    const preferY = (b.min.y + b.max.y) * 0.5;

    const tryXZ = (x, z) => {
      const gy = this.getSpawnGroundY(x, z, preferY);
      if (gy > -9000) return new THREE.Vector3(x, gy + 0.02, z);
      return null;
    };

    let p = tryXZ(cx, cz);
    if (p) return p;

    for (let i = 0; i < 140; i++) {
      const x = cx + (Math.random() - 0.5) * 2 * halfWx;
      const z = cz + (Math.random() - 0.5) * 2 * halfWz;
      const xCl = Math.min(maxX, Math.max(minX, x));
      const zCl = Math.min(maxZ, Math.max(minZ, z));
      p = tryXZ(xCl, zCl);
      if (p) return p;
    }

    p = tryXZ(cx, cz);
    if (p) return p;
    return new THREE.Vector3(cx, b.max.y + 1, cz);
  }
}
