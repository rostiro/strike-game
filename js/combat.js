import * as THREE from 'three';
import { PLAYER_BODY_SCALE } from './player.js';

const _ray = new THREE.Raycaster();
_ray.far = 500;

const IMPACT_LIFETIME = 4.0;
const MAX_IMPACTS = 60;
const _impactGeo = new THREE.CircleGeometry(0.04, 6);
const _impactMat = new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide, depthWrite: false });
const _sparkGeo = new THREE.SphereGeometry(0.015, 4, 4);
const _sparkMat = new THREE.MeshBasicMaterial({ color: 0xffcc44 });

export class CombatSystem {
  constructor(scene) {
    this.scene = scene;
    this.targets = [];
    this.targetMeshes = [];
    this.killfeed = [];
    this.hitmarkerTimer = 0;
    this.lastHitWasHead = false;
    this._bloodParticles = [];
    this._impacts = [];
    this._sparks = [];
    this._worldMeshes = [];
  }

  setWorldMeshes(meshes) {
    this._worldMeshes = meshes;
  }

  spawnDummies(collisionWorld, count = 8) {
    for (let i = 0; i < count; i++) {
      const pos = collisionWorld.getRandomSpawnPoint();
      const dummy = this._createDummy();
      dummy.position.copy(pos);
      this.scene.add(dummy);
      const data = {
        mesh: dummy,
        hp: 100,
        maxHp: 100,
        headY: pos.y + 0.52 * PLAYER_BODY_SCALE,
        respawnTimer: 0,
        alive: true,
      };
      this.targets.push(data);
      this.targetMeshes.push(dummy);
    }
  }

  _createDummy() {
    const s = PLAYER_BODY_SCALE;
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x884422, roughness: 0.8 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xddaa77, roughness: 0.7 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.16 * s, 0.24 * s, 0.1 * s), bodyMat);
    torso.position.y = 0.32 * s;
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.06 * s, 8, 8), headMat);
    head.position.y = 0.52 * s;
    head.castShadow = true;
    head.name = 'head';
    group.add(head);

    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.2 * s, 0.06 * s), bodyMat);
    legL.position.set(-0.04 * s, 0.1 * s, 0);
    legL.castShadow = true;
    group.add(legL);

    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.2 * s, 0.06 * s), bodyMat);
    legR.position.set(0.04 * s, 0.1 * s, 0);
    legR.castShadow = true;
    group.add(legR);

    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.045 * s, 0.19 * s, 0.05 * s), bodyMat);
    armL.position.set(-0.12 * s, 0.32 * s, 0);
    armL.castShadow = true;
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.045 * s, 0.19 * s, 0.05 * s), bodyMat);
    armR.position.set(0.12 * s, 0.32 * s, 0);
    armR.castShadow = true;
    group.add(armR);

    return group;
  }

  processShot(player, weapon) {
    const origin = player.camera.position.clone();
    const dir = player.getLookDirection();

    _ray.ray.origin.copy(origin);
    _ray.ray.direction.copy(dir);

    const alive = this.targetMeshes.filter((_, i) => this.targets[i].alive);
    const hits = _ray.intersectObjects(alive, true);

    let hitTarget = false;

    if (hits.length > 0) {
      const hit = hits[0];
      const parentGroup = this._findTargetGroup(hit.object);
      if (parentGroup) {
        const tIdx = this.targetMeshes.indexOf(parentGroup);
        if (tIdx >= 0) {
          const target = this.targets[tIdx];
          const hitY = hit.point.y;
          const isHeadshot = hitY >= target.mesh.position.y + 0.45 * PLAYER_BODY_SCALE;
          const dmg = isHeadshot ? weapon.headDmg : weapon.bodyDmg;
          target.hp -= dmg;

          this.hitmarkerTimer = 0.2;
          this.lastHitWasHead = isHeadshot;
          this._spawnBlood(hit.point);

          if (target.hp <= 0) {
            target.alive = false;
            target.mesh.visible = false;
            target.respawnTimer = 5.0;
            const msg = isHeadshot ? `HEADSHOT` : `Elimination`;
            this.killfeed.unshift({ text: msg, timer: 4.0 });
            if (this.killfeed.length > 5) this.killfeed.pop();
          }
          hitTarget = true;
        }
      }
    }

    if (!hitTarget) {
      this._castWorldImpact(origin, dir);
    }

    return hitTarget;
  }

  _castWorldImpact(origin, dir) {
    _ray.ray.origin.copy(origin);
    _ray.ray.direction.copy(dir);

    if (this._worldMeshes.length === 0) return;

    const hits = _ray.intersectObjects(this._worldMeshes, false);
    if (hits.length > 0) {
      this._spawnImpact(hits[0].point, hits[0].face ? hits[0].face.normal : new THREE.Vector3(0, 1, 0));
      this._spawnSparks(hits[0].point);
    }
  }

  _spawnImpact(pos, normal) {
    const decal = new THREE.Mesh(_impactGeo, _impactMat.clone());
    decal.position.copy(pos).addScaledVector(normal, 0.005);
    decal.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
    decal.userData.life = IMPACT_LIFETIME;
    this.scene.add(decal);
    this._impacts.push(decal);

    while (this._impacts.length > MAX_IMPACTS) {
      const old = this._impacts.shift();
      this.scene.remove(old);
    }
  }

  _spawnSparks(pos) {
    for (let i = 0; i < 4; i++) {
      const spark = new THREE.Mesh(_sparkGeo, _sparkMat);
      spark.position.copy(pos);
      spark.userData = {
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.5,
          Math.random() * 0.4 + 0.1,
          (Math.random() - 0.5) * 0.5
        ),
        life: 0.25 + Math.random() * 0.15,
      };
      this.scene.add(spark);
      this._sparks.push(spark);
    }
  }

  _findTargetGroup(obj) {
    let current = obj;
    while (current) {
      if (this.targetMeshes.includes(current)) return current;
      current = current.parent;
    }
    return null;
  }

  _spawnBlood(pos) {
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(
        new THREE.SphereGeometry(0.02 + Math.random() * 0.03, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0xaa0000 })
      );
      p.position.copy(pos);
      p.userData = {
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.35,
          Math.random() * 0.25 + 0.05,
          (Math.random() - 0.5) * 0.35
        ),
        life: 0.5,
      };
      this.scene.add(p);
      this._bloodParticles.push(p);
    }
  }

  update(dt, collisionWorld) {
    this.hitmarkerTimer = Math.max(0, this.hitmarkerTimer - dt);

    this.killfeed.forEach(k => (k.timer -= dt));
    this.killfeed = this.killfeed.filter(k => k.timer > 0);

    for (const t of this.targets) {
      if (t.alive) continue;
      t.respawnTimer -= dt;
      if (t.respawnTimer <= 0) {
        t.alive = true;
        t.hp = t.maxHp;
        t.mesh.visible = true;
        const pos = collisionWorld.getRandomSpawnPoint();
        t.mesh.position.copy(pos);
        t.headY = pos.y + 0.52 * PLAYER_BODY_SCALE;
      }
    }

    this._bloodParticles = this._bloodParticles.filter(p => {
      p.userData.vel.y -= 0.025;
      p.position.addScaledVector(p.userData.vel, dt * 60);
      p.userData.life -= dt;
      if (p.userData.life <= 0) { this.scene.remove(p); return false; }
      return true;
    });

    this._sparks = this._sparks.filter(s => {
      s.userData.vel.y -= 0.04;
      s.position.addScaledVector(s.userData.vel, dt * 60);
      s.userData.life -= dt;
      if (s.userData.life <= 0) { this.scene.remove(s); return false; }
      return true;
    });

    this._impacts = this._impacts.filter(d => {
      d.userData.life -= dt;
      if (d.userData.life <= 0) { this.scene.remove(d); return false; }
      if (d.userData.life < 1.0) {
        d.material.opacity = d.userData.life;
        d.material.transparent = true;
      }
      return true;
    });
  }
}
