import * as THREE from 'three';
import { NO_GROUND } from './bvh-capsule.js';

/**
 * Échelle du corps dans le monde (ancienne capsule ~42 cm → ×4 ≈ 1,7 m).
 * À garder aligné avec mannequins / joueurs réseau dans combat.js et network.js.
 */
export const PLAYER_BODY_SCALE = 4;

export const PLAYER_HEIGHT = 0.42 * PLAYER_BODY_SCALE;
export const PLAYER_RADIUS = 0.075 * PLAYER_BODY_SCALE;
const EYE_OFFSET = 0.36 * PLAYER_BODY_SCALE;
const WALK_SPEED = 5.0;
const SPRINT_MULT = 1.7;
const GRAVITY = 14.0;
const JUMP_VEL = 6.0;
const MOUSE_SENS = 0.002;
/** Marge verticale pour snap au sol (marches / légers dénivelés sans coller au plafond). */
const GROUND_SNAP_UP = 0.22 * PLAYER_BODY_SCALE;
const GROUND_PROBE_ABOVE_FEET = 0.18 * PLAYER_BODY_SCALE;
/** Seuil « au-dessus des pieds » pour considérer qu’on n’est plus au sol (proportionnel à la taille). */
const AIRBORNE_ABOVE_FEET = 0.27 * PLAYER_BODY_SCALE;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.position = new THREE.Vector3(0, 5, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.hp = 100;
    this.maxHp = 100;
    this.alive = true;
    this.respawnTimer = 0;

    this.keys = {};
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._moveDir = new THREE.Vector3();
  }

  bindInput(domElement) {
    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (e.code === 'Space') e.preventDefault();
    });
    document.addEventListener('keyup', e => {
      this.keys[e.code] = false;
    });
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== domElement) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, this.pitch));
    });
  }

  get isMoving() {
    const k = this.keys;
    return !!(k['KeyW'] || k['KeyZ'] || k['KeyS'] || k['KeyA'] || k['KeyQ'] || k['KeyD']);
  }

  get isSprinting() {
    return !!this.keys['ShiftLeft'] || !!this.keys['ShiftRight'];
  }

  get forward() {
    this._fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).negate().normalize();
    return this._fwd;
  }

  get right() {
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
    return this._right;
  }

  update(dt, collisionWorld) {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(collisionWorld);
      this._syncCamera();
      return;
    }

    const speed = WALK_SPEED * (this.isSprinting ? SPRINT_MULT : 1.0);
    const k = this.keys;

    this._moveDir.set(0, 0, 0);
    if (k['KeyW'] || k['KeyZ']) this._moveDir.add(this.forward);
    if (k['KeyS']) this._moveDir.sub(this.forward);
    if (k['KeyA'] || k['KeyQ']) this._moveDir.sub(this.right);
    if (k['KeyD']) this._moveDir.add(this.right);

    if (this._moveDir.lengthSq() > 0) {
      this._moveDir.normalize();
    }

    const dx = this._moveDir.x * speed * dt;
    const dz = this._moveDir.z * speed * dt;

    if (collisionWorld) {
      const step = Math.min(0.05, Math.max(0.03, PLAYER_RADIUS * 0.48));
      const dist = Math.hypot(dx, dz);
      const n = Math.min(48, Math.max(1, Math.ceil(dist / step)));
      const sx = dx / n;
      const sz = dz / n;
      for (let i = 0; i < n; i++) {
        collisionWorld.testMove(this.position, sx, sz, PLAYER_RADIUS, PLAYER_HEIGHT);
      }
    } else {
      this.position.x += dx;
      this.position.z += dz;
    }

    if (k['Space'] && this.onGround) {
      this.velocity.y = JUMP_VEL;
      this.onGround = false;
    }

    this.velocity.y -= GRAVITY * dt;
    this.position.y += this.velocity.y * dt;

    if (collisionWorld) {
      const groundY = collisionWorld.getGroundBelow(
        this.position.x,
        this.position.y,
        this.position.z,
        PLAYER_RADIUS
      );

      if (groundY > NO_GROUND) {
        const snapY = groundY + 0.02;
        if (this.velocity.y <= 0 && this.position.y <= snapY + GROUND_SNAP_UP) {
          this.position.y = snapY;
          this.velocity.y = 0;
          this.onGround = true;
        } else if (this.position.y > groundY + GROUND_PROBE_ABOVE_FEET + AIRBORNE_ABOVE_FEET) {
          this.onGround = false;
        }
      }

      const safetyY = collisionWorld.getSafetyFloorY?.();
      if (safetyY != null && this.position.y < safetyY + 0.02) {
        this.position.y = safetyY + 0.02;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.onGround = true;
      }
    }

    // Secours si bug sous le monde (très en dessous du plancher de secours)
    const mb = collisionWorld?.mapBounds;
    const safety = collisionWorld?.getSafetyFloorY?.();
    const voidY =
      safety != null ? safety - 500 : mb && !mb.isEmpty() ? mb.min.y - 200 : -500;
    if (this.position.y < voidY) {
      this.position.set(0, 20, 0);
      this.velocity.set(0, 0, 0);
    }

    this._syncCamera();
  }

  _syncCamera() {
    this.camera.position.set(
      this.position.x,
      this.position.y + EYE_OFFSET,
      this.position.z
    );
    // YXZ FPS : pas de roulis. Sinon après camera.lookAt (menu / éditeur) rotation.z peut rester ≠ 0 → horizon penché.
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.z = 0;
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) this.die();
  }

  die() {
    this.alive = false;
    this.respawnTimer = 3.0;
  }

  respawn(collisionWorld) {
    this.alive = true;
    this.hp = this.maxHp;
    this.velocity.set(0, 0, 0);
    if (collisionWorld) {
      const raw = collisionWorld.getRandomSpawnPoint();
      this.position.copy(collisionWorld.pickValidatedSpawn(raw, PLAYER_RADIUS, PLAYER_HEIGHT));
    } else {
      this.position.set(0, 5, 0);
    }
  }

  getLookDirection() {
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    return dir;
  }
}
