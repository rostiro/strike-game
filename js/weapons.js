import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const WEAPON_DEFS = [
  {
    id: 'pistol',
    name: 'Pistolet',
    glb: 'models/Pistol.glb',
    bodyDmg: 25, headDmg: 75, fireRate: 0.18, auto: false,
    magSize: 12, reloadTime: 1.5,
    recoilUp: 0.014, recoilReset: 0.06,
    crosshairSpread: 2, crosshairShotSpread: 8,
    viewScale: 0.018,
    viewPos: [0.055, -0.04, -0.1],
    adsPos: [0.0, -0.032, -0.08],
    adsFov: 62, reticle: 'dot',
  },
  {
    id: 'assault',
    name: 'Assaut',
    glb: 'models/Assault Rifle.glb',
    bodyDmg: 30, headDmg: 90, fireRate: 0.09, auto: true,
    magSize: 30, reloadTime: 2.2,
    recoilUp: 0.007, recoilReset: 0.03,
    crosshairSpread: 3, crosshairShotSpread: 14,
    viewScale: 0.015,
    viewPos: [0.06, -0.045, -0.13],
    adsPos: [0.0, -0.035, -0.1],
    adsFov: 55, reticle: 'cross',
  },
  {
    id: 'sniper',
    name: 'Sniper',
    glb: 'models/Sniper Rifle.glb',
    bodyDmg: 80, headDmg: 200, fireRate: 1.2, auto: false,
    magSize: 5, reloadTime: 3.0,
    recoilUp: 0.045, recoilReset: 0.015,
    crosshairSpread: 1, crosshairShotSpread: 20,
    viewScale: 0.014,
    viewPos: [0.06, -0.05, -0.16],
    adsPos: [0.0, -0.038, -0.1],
    adsFov: 30, reticle: 'scope',
  },
  {
    id: 'shotgun',
    name: 'Shotgun',
    glb: 'models/Shotgun.glb',
    bodyDmg: 55, headDmg: 120, fireRate: 0.8, auto: false,
    magSize: 6, reloadTime: 2.5,
    recoilUp: 0.035, recoilReset: 0.02,
    crosshairSpread: 6, crosshairShotSpread: 18,
    viewScale: 0.015,
    viewPos: [0.06, -0.045, -0.14],
    adsPos: [0.0, -0.035, -0.1],
    adsFov: 60, reticle: 'circle',
  },
  {
    id: 'smg',
    name: 'SMG',
    glb: 'models/Submachine Gun.glb',
    bodyDmg: 20, headDmg: 55, fireRate: 0.065, auto: true,
    magSize: 35, reloadTime: 1.8,
    recoilUp: 0.005, recoilReset: 0.045,
    crosshairSpread: 4, crosshairShotSpread: 10,
    viewScale: 0.015,
    viewPos: [0.055, -0.04, -0.11],
    adsPos: [0.0, -0.032, -0.08],
    adsFov: 58, reticle: 'cross-dot',
  },
  {
    id: 'revolver',
    name: 'Revolver',
    glb: 'models/Revolver.glb',
    bodyDmg: 50, headDmg: 150, fireRate: 0.5, auto: false,
    magSize: 6, reloadTime: 2.0,
    recoilUp: 0.03, recoilReset: 0.04,
    crosshairSpread: 2, crosshairShotSpread: 12,
    viewScale: 0.018,
    viewPos: [0.055, -0.04, -0.1],
    adsPos: [0.0, -0.032, -0.08],
    adsFov: 55, reticle: 'chevron',
  },
];

export { WEAPON_DEFS };

export class WeaponSystem {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.allDefs = WEAPON_DEFS;

    this.slot = [null, null];
    this.slotIndex = 0;
    this.weapons = [];

    this.recoilAccum = 0;
    this.spreadAccum = 0;
    this._flash = null;
    this._mouseDown = false;
    this._prevMouseDown = false;

    this._viewContainer = new THREE.Group();
    this._viewContainer.renderOrder = 999;
    this.camera.add(this._viewContainer);

    this._glbCache = {};
    this._loader = new GLTFLoader();
    this._currentViewModel = null;

    this._switchAnim = 0;
    this._kickZ = 0;
    this._kickRot = 0;

    this.aiming = false;
    this.adsAmount = 0;
    this._rightDown = false;
    this.defaultFov = 72;
  }

  get current() {
    return this.slot[this.slotIndex];
  }

  equipSlots(idx1, idx2) {
    const def1 = this.allDefs[idx1];
    const def2 = this.allDefs[idx2];
    this.slot[0] = this._makeWeapon(def1);
    this.slot[1] = this._makeWeapon(def2);
    this.slotIndex = 0;
    this._showViewModel(this.slot[0]);
  }

  _makeWeapon(def) {
    return {
      ...def,
      ammo: def.magSize,
      fireCooldown: 0,
      reloading: false,
      reloadTimer: 0,
    };
  }

  async loadAllModels() {
    const promises = this.allDefs.map(def => this._loadGLB(def.glb));
    await Promise.allSettled(promises);
  }

  _loadGLB(url) {
    if (this._glbCache[url]) return Promise.resolve(this._glbCache[url]);
    return new Promise((resolve) => {
      this._loader.load(url, (gltf) => {
        const model = gltf.scene;
        model.traverse(n => { if (n.isMesh) n.castShadow = false; });
        this._glbCache[url] = model;
        resolve(model);
      }, null, () => {
        this._glbCache[url] = null;
        resolve(null);
      });
    });
  }

  _showViewModel(weapon) {
    if (this._currentViewModel) {
      this._viewContainer.remove(this._currentViewModel);
      this._currentViewModel = null;
    }
    if (!weapon) return;

    const cached = this._glbCache[weapon.glb];
    if (!cached) return;

    const model = cached.clone();
    const s = weapon.viewScale;
    model.scale.set(s, s, s);
    model.position.set(...weapon.viewPos);
    model.rotation.set(0, 0, 0);
    model.traverse(n => {
      if (n.isMesh) {
        n.renderOrder = 999;
        n.material = n.material.clone();
        n.material.depthTest = false;
      }
    });
    this._viewContainer.add(model);
    this._currentViewModel = model;
    this._switchAnim = 0.25;
    this._kickZ = 0;
    this._kickRot = 0;
  }

  bindInput(domElement) {
    document.addEventListener('keydown', e => {
      if (e.code === 'Digit1') this.switchSlot(0);
      if (e.code === 'Digit2') this.switchSlot(1);
      if (e.code === 'KeyR') this.startReload();
    });
    domElement.addEventListener('mousedown', e => {
      if (e.button === 0) this._mouseDown = true;
      if (e.button === 2) this._rightDown = true;
    });
    document.addEventListener('mouseup', e => {
      if (e.button === 0) this._mouseDown = false;
      if (e.button === 2) this._rightDown = false;
    });
    domElement.addEventListener('contextmenu', e => e.preventDefault());
    domElement.addEventListener('wheel', e => {
      e.preventDefault();
      this.switchSlot(this.slotIndex === 0 ? 1 : 0);
    }, { passive: false });
  }

  switchSlot(idx) {
    if (idx === this.slotIndex) return;
    if (!this.slot[idx]) return;
    if (this.current && this.current.reloading) return;
    this.slotIndex = idx;
    this.recoilAccum = 0;
    this.spreadAccum = 0;
    this._showViewModel(this.slot[idx]);
  }

  startReload() {
    const w = this.current;
    if (!w || w.reloading || w.ammo === w.magSize) return;
    w.reloading = true;
    w.reloadTimer = w.reloadTime;
  }

  update(dt, player, canFire) {
    const w = this.current;
    if (!w) return false;

    if (w.reloading) {
      w.reloadTimer -= dt;
      if (w.reloadTimer <= 0) {
        w.reloading = false;
        w.ammo = w.magSize;
      }
    }

    w.fireCooldown = Math.max(0, w.fireCooldown - dt);
    this.recoilAccum = Math.max(0, this.recoilAccum - w.recoilReset * dt * 60);
    this.spreadAccum = Math.max(0, this.spreadAccum - 30 * dt);

    if (player.isMoving) {
      this.spreadAccum = Math.min(this.spreadAccum + 8 * dt, w.crosshairSpread * 1.5);
    }

    let fired = false;
    if (this._mouseDown && canFire && player.alive && !w.reloading && w.fireCooldown <= 0 && w.ammo > 0) {
      if (w.auto || !this._prevMouseDown) {
        fired = true;
        w.ammo--;
        w.fireCooldown = w.fireRate;
        this.recoilAccum += w.recoilUp;
        this.spreadAccum = Math.min(this.spreadAccum + w.crosshairShotSpread, 40);
        player.pitch += w.recoilUp;
        this._spawnFlash(player);
        this._kickZ = 0.02;
        this._kickRot = -0.04;
      }
    }

    if (w.ammo <= 0 && !w.reloading) {
      this.startReload();
    }

    this._prevMouseDown = this._mouseDown;

    if (this._flash) {
      this._flash.life -= dt;
      if (this._flash.life <= 0) {
        this.scene.remove(this._flash.light);
        this._flash = null;
      }
    }

    this.aiming = this._rightDown && !w.reloading && player.alive;
    const adsSpeed = 8;
    if (this.aiming) {
      this.adsAmount = Math.min(1, this.adsAmount + dt * adsSpeed);
    } else {
      this.adsAmount = Math.max(0, this.adsAmount - dt * adsSpeed);
    }

    const targetFov = w.adsFov || 55;
    this.camera.fov = this.defaultFov + (targetFov - this.defaultFov) * this.adsAmount;
    this.camera.updateProjectionMatrix();

    this._updateViewModelAnim(dt);

    return fired;
  }

  _updateViewModelAnim(dt) {
    if (!this._currentViewModel) return;
    const w = this.current;
    if (!w) return;

    this._kickZ *= 0.85;
    this._kickRot *= 0.85;

    const hip = w.viewPos;
    const ads = w.adsPos || [0, hip[1], hip[2]];
    const t = this.adsAmount;

    let tx = hip[0] + (ads[0] - hip[0]) * t;
    let ty = hip[1] + (ads[1] - hip[1]) * t;
    let tz = hip[2] + (ads[2] - hip[2]) * t + this._kickZ;

    if (this._switchAnim > 0) {
      this._switchAnim -= dt * 4;
      ty -= Math.max(0, this._switchAnim) * 0.15;
    }

    const lerpSpeed = 14;
    this._currentViewModel.position.x += (tx - this._currentViewModel.position.x) * dt * lerpSpeed;
    this._currentViewModel.position.y += (ty - this._currentViewModel.position.y) * dt * lerpSpeed;
    this._currentViewModel.position.z += (tz - this._currentViewModel.position.z) * dt * lerpSpeed;

    this._currentViewModel.rotation.x += (this._kickRot - this._currentViewModel.rotation.x) * dt * 12;
    this._currentViewModel.rotation.y += (0 - this._currentViewModel.rotation.y) * dt * 12;
    this._currentViewModel.rotation.z += (0 - this._currentViewModel.rotation.z) * dt * 12;
  }

  _spawnFlash(player) {
    if (this._flash) {
      this.scene.remove(this._flash.light);
    }
    const light = new THREE.PointLight(0xffaa22, 15, 5);
    const dir = player.getLookDirection();
    light.position.copy(player.camera.position).addScaledVector(dir, 0.8);
    this.scene.add(light);
    this._flash = { light, life: 0.04 };
  }

  getCrosshairSize() {
    const base = 16 + this.spreadAccum;
    return base * (1 - this.adsAmount * 0.6);
  }

  getReticleType() {
    const w = this.current;
    return w ? (w.reticle || 'cross') : 'cross';
  }
}
