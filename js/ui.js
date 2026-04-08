export class UI {
  constructor() {
    this.els = {};
    this._cacheElements();
  }

  _cacheElements() {
    const ids = [
      'menu', 'btn-play', 'btn-multi',
      'hud', 'hud-hp', 'hud-hp-bar', 'hud-weapon-name', 'hud-ammo', 'hud-ammo-total',
      'crosshair', 'ch-top', 'ch-bot', 'ch-left', 'ch-right',
      'hitmarker',
      'killfeed',
      'death-screen',
      'pause-screen', 'btn-resume', 'btn-quit',
      'loading', 'load-txt', 'prog-fill',
      'reload-bar', 'reload-fill',
      'lobby-screen', 'lobby-code', 'lobby-players', 'lobby-start', 'lobby-status-msg',
      'lobby-code-display', 'lobby-join-section', 'lobby-create-section',
      'lobby-ingame-actions', 'lobby-player-count', 'lobby-ready',
      'weapon-select', 'ws-list-1', 'ws-list-2',
      'spawn-editor', 'se-count', 'se-code',
      'scope-overlay',
    ];
    for (const id of ids) {
      this.els[id] = document.getElementById(id);
    }
  }

  showMenu() {
    this._showV('menu');
    this._hideV('hud');
    this._hideV('crosshair');
    this._hideV('death-screen');
    this._hideV('pause-screen');
    this._hideV('lobby-screen');
    this._hideV('weapon-select');
    this._hideV('scope-overlay');
  }

  showGame() {
    this._hideV('menu');
    this._hideV('lobby-screen');
    this._hideV('weapon-select');
    this._showV('hud');
    this._showV('crosshair');
    this._hideV('death-screen');
    this._hideV('pause-screen');
  }

  showWeaponSelectScreen() {
    this._hideV('menu');
    this._hideV('hud');
    this._hideV('crosshair');
    this._hideV('death-screen');
    this._hideV('pause-screen');
    this._hideV('lobby-screen');
    this._showV('weapon-select');
  }

  buildWeaponSelect(defs, sel1, sel2) {
    const list1 = this.els['ws-list-1'];
    const list2 = this.els['ws-list-2'];
    if (!list1 || !list2) return;

    const makeCards = (selected) => defs.map((d, i) => {
      const cls = i === selected ? 'ws-card selected' : 'ws-card';
      return `<div class="${cls}" data-idx="${i}">
        <div class="ws-name">${d.name}</div>
        <div class="ws-stat">
          <b>DMG</b> ${d.bodyDmg} | <b>HS</b> ${d.headDmg}<br>
          <b>MAG</b> ${d.magSize} | <b>RPM</b> ${Math.round(60 / d.fireRate)}
        </div>
      </div>`;
    }).join('');

    list1.innerHTML = makeCards(sel1);
    list2.innerHTML = makeCards(sel2);
  }

  showPause() { this._showV('pause-screen'); }
  hidePause() { this._hideV('pause-screen'); }
  showDeath() { this._showV('death-screen'); }
  hideDeath() { this._hideV('death-screen'); }

  showLobbyScreen() {
    this._hideV('menu');
    this._hideV('hud');
    this._hideV('crosshair');
    this._hideV('death-screen');
    this._hideV('pause-screen');
    this._hideV('weapon-select');
    this._showV('lobby-screen');
  }

  hideLobbyScreen() {
    this._hideV('lobby-screen');
  }

  updateLobby(state, myId) {
    const inLobby = !!state.code;

    const codeDisplay = this.els['lobby-code-display'];
    const joinSection = this.els['lobby-join-section'];
    const createSection = this.els['lobby-create-section'];
    const ingameActions = this.els['lobby-ingame-actions'];

    if (inLobby) {
      if (codeDisplay) codeDisplay.style.display = '';
      if (joinSection) joinSection.style.display = 'none';
      if (createSection) createSection.style.display = 'none';
      if (ingameActions) ingameActions.style.display = '';
    }

    const codeEl = this.els['lobby-code'];
    if (codeEl) codeEl.textContent = state.code || '------';

    const playersEl = this.els['lobby-players'];
    if (playersEl) {
      playersEl.innerHTML = state.players.map(p => {
        const initial = (p.name || '?')[0].toUpperCase();
        const isHost = p.id === state.hostId;
        const roleTag = isHost ? '<span class="lp-role lp-host-tag">HOTE</span>' : '';
        const statusTag = p.ready
          ? '<span class="lp-status lp-ready-tag">PRET</span>'
          : '<span class="lp-status lp-waiting-tag">EN ATTENTE</span>';
        const meStyle = p.id === myId ? 'border:1px solid rgba(212,165,55,.25);' : '';
        return `<div class="lp-entry" style="${meStyle}">
          <div class="lp-avatar">${initial}</div>
          <div class="lp-info">
            <div class="lp-name">${p.name}${p.id === myId ? ' (toi)' : ''}</div>
            ${roleTag}
          </div>
          ${statusTag}
        </div>`;
      }).join('');
    }

    const countEl = this.els['lobby-player-count'];
    if (countEl) countEl.textContent = `${state.players.length}/10`;

    const startBtn = this.els['lobby-start'];
    if (startBtn) startBtn.style.display = state.hostId === myId ? '' : 'none';

    const readyBtn = this.els['lobby-ready'];
    if (readyBtn) {
      const me = state.players.find(p => p.id === myId);
      if (me && me.ready) {
        readyBtn.classList.add('is-ready');
        readyBtn.textContent = 'PRET !';
      } else {
        readyBtn.classList.remove('is-ready');
        readyBtn.textContent = 'PRET';
      }
    }

    const statusEl = this.els['lobby-status-msg'];
    if (statusEl) {
      const readyCount = state.players.filter(p => p.ready).length;
      statusEl.textContent = `${readyCount}/${state.players.length} pret(s)`;
    }
  }

  resetLobbyUI() {
    const codeDisplay = this.els['lobby-code-display'];
    const joinSection = this.els['lobby-join-section'];
    const createSection = this.els['lobby-create-section'];
    const ingameActions = this.els['lobby-ingame-actions'];
    if (codeDisplay) codeDisplay.style.display = 'none';
    if (joinSection) joinSection.style.display = '';
    if (createSection) createSection.style.display = '';
    if (ingameActions) ingameActions.style.display = 'none';
    const playersEl = this.els['lobby-players'];
    if (playersEl) playersEl.innerHTML = '';
    const countEl = this.els['lobby-player-count'];
    if (countEl) countEl.textContent = '0/10';
  }

  hideLoading() {
    const ld = this.els['loading'];
    if (ld) {
      ld.style.opacity = '0';
      setTimeout(() => { ld.style.display = 'none'; }, 800);
    }
  }

  updateLoadProgress(name, loaded, total) {
    const pct = (loaded / total) * 100;
    if (this.els['prog-fill']) this.els['prog-fill'].style.width = pct + '%';
    if (this.els['load-txt']) this.els['load-txt'].textContent = `${name} (${loaded}/${total})`;
  }

  updateHP(hp) {
    if (this.els['hud-hp']) this.els['hud-hp'].textContent = Math.max(0, hp | 0);
    if (this.els['hud-hp-bar']) this.els['hud-hp-bar'].style.width = Math.max(0, hp) + '%';
  }

  updateAmmo(ammo, magSize) {
    if (this.els['hud-ammo']) this.els['hud-ammo'].textContent = ammo;
    if (this.els['hud-ammo-total']) this.els['hud-ammo-total'].textContent = magSize;
  }

  updateWeaponName(name) {
    if (this.els['hud-weapon-name']) this.els['hud-weapon-name'].textContent = name;
  }

  updateCrosshair(size, reticle, adsAmount) {
    const half = size / 2;
    const ch = this.els['crosshair'];
    const scope = this.els['scope-overlay'];
    if (!ch) return;

    const isScope = reticle === 'scope' && adsAmount > 0.5;
    if (scope) {
      if (isScope) { scope.classList.add('visible'); }
      else { scope.classList.remove('visible'); }
    }

    if (isScope) {
      ch.style.display = 'none';
      return;
    }

    const t = this.els['ch-top'];
    const b = this.els['ch-bot'];
    const l = this.els['ch-left'];
    const r = this.els['ch-right'];
    let dot = ch.querySelector('.ch-dot');
    let chevron = ch.querySelector('.ch-chevron');
    let circle = ch.querySelector('.ch-circle');

    if (!dot) { dot = document.createElement('div'); dot.className = 'ch-dot'; ch.appendChild(dot); }
    if (!chevron) { chevron = document.createElement('div'); chevron.className = 'ch-chevron'; ch.appendChild(chevron); }
    if (!circle) { circle = document.createElement('div'); circle.className = 'ch-circle'; ch.appendChild(circle); }

    const hideAll = () => {
      if (t) t.style.display = 'none';
      if (b) b.style.display = 'none';
      if (l) l.style.display = 'none';
      if (r) r.style.display = 'none';
      dot.style.display = 'none';
      chevron.style.display = 'none';
      circle.style.display = 'none';
    };
    hideAll();

    const lineColor = adsAmount > 0.3 ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.75)';

    if (reticle === 'dot') {
      dot.style.display = '';
      dot.style.width = (3 + adsAmount * 2) + 'px';
      dot.style.height = (3 + adsAmount * 2) + 'px';
      dot.style.background = adsAmount > 0.3 ? '#f44' : 'rgba(255,255,255,.7)';
    } else if (reticle === 'cross') {
      if (t) { t.style.display = ''; t.style.height = '10px'; t.style.bottom = `calc(50% + ${half}px)`; t.style.background = lineColor; }
      if (b) { b.style.display = ''; b.style.height = '10px'; b.style.top = `calc(50% + ${half}px)`; b.style.background = lineColor; }
      if (l) { l.style.display = ''; l.style.width = '10px'; l.style.right = `calc(50% + ${half}px)`; l.style.background = lineColor; }
      if (r) { r.style.display = ''; r.style.width = '10px'; r.style.left = `calc(50% + ${half}px)`; r.style.background = lineColor; }
    } else if (reticle === 'cross-dot') {
      dot.style.display = '';
      dot.style.width = '2px'; dot.style.height = '2px';
      dot.style.background = adsAmount > 0.3 ? '#4f4' : 'rgba(255,255,255,.6)';
      if (t) { t.style.display = ''; t.style.height = '8px'; t.style.bottom = `calc(50% + ${half}px)`; t.style.background = lineColor; }
      if (b) { b.style.display = ''; b.style.height = '8px'; b.style.top = `calc(50% + ${half}px)`; b.style.background = lineColor; }
      if (l) { l.style.display = ''; l.style.width = '8px'; l.style.right = `calc(50% + ${half}px)`; l.style.background = lineColor; }
      if (r) { r.style.display = ''; r.style.width = '8px'; r.style.left = `calc(50% + ${half}px)`; r.style.background = lineColor; }
    } else if (reticle === 'chevron') {
      chevron.style.display = '';
      chevron.style.borderBottomColor = adsAmount > 0.3 ? 'rgba(100,255,100,.9)' : 'rgba(100,255,100,.6)';
    } else if (reticle === 'circle') {
      circle.style.display = '';
      const sz = 18 + half * 0.8;
      circle.style.width = sz + 'px';
      circle.style.height = sz + 'px';
      circle.style.borderColor = adsAmount > 0.3 ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.4)';
      dot.style.display = '';
      dot.style.width = '2px'; dot.style.height = '2px';
      dot.style.background = 'rgba(255,255,255,.5)';
    } else {
      if (t) { t.style.display = ''; t.style.height = '10px'; t.style.bottom = `calc(50% + ${half}px)`; t.style.background = lineColor; }
      if (b) { b.style.display = ''; b.style.height = '10px'; b.style.top = `calc(50% + ${half}px)`; b.style.background = lineColor; }
      if (l) { l.style.display = ''; l.style.width = '10px'; l.style.right = `calc(50% + ${half}px)`; l.style.background = lineColor; }
      if (r) { r.style.display = ''; r.style.width = '10px'; r.style.left = `calc(50% + ${half}px)`; r.style.background = lineColor; }
    }
  }

  showHitmarker(isHead) {
    const hm = this.els['hitmarker'];
    if (!hm) return;
    hm.style.display = 'block';
    hm.style.color = isHead ? '#ff2222' : '#ffffff';
    hm.classList.remove('hm-anim');
    void hm.offsetWidth;
    hm.classList.add('hm-anim');
  }

  hideHitmarker() {
    const hm = this.els['hitmarker'];
    if (hm) hm.style.display = 'none';
  }

  updateKillfeed(entries) {
    const el = this.els['killfeed'];
    if (!el) return;
    el.innerHTML = entries.map(e =>
      `<div class="kf-entry${e.text.includes('HEAD') ? ' kf-head' : ''}">${e.text}</div>`
    ).join('');
  }

  updateReloadBar(progress) {
    const bar = this.els['reload-bar'];
    const fill = this.els['reload-fill'];
    if (!bar || !fill) return;
    if (progress <= 0 || progress >= 1) {
      bar.style.display = 'none';
    } else {
      bar.style.display = 'block';
      fill.style.width = (progress * 100) + '%';
    }
  }

  showSpawnEditor() {
    this._hideV('menu');
    this._hideV('hud');
    this._hideV('crosshair');
    this._hideV('death-screen');
    this._hideV('pause-screen');
    this._hideV('lobby-screen');
    this._hideV('weapon-select');
    this._showV('spawn-editor');
  }

  hideSpawnEditor() {
    this._hideV('spawn-editor');
    const code = this.els['se-code'];
    if (code) { code.classList.remove('visible'); code.value = ''; }
  }

  updateSpawnCount(n) {
    if (this.els['se-count']) this.els['se-count'].textContent = `${n} spawn(s)`;
  }

  showSpawnExport(text) {
    const code = this.els['se-code'];
    if (code) { code.value = text; code.classList.add('visible'); }
  }

  _showV(id) { if (this.els[id]) this.els[id].classList.add('visible'); }
  _hideV(id) { if (this.els[id]) this.els[id].classList.remove('visible'); }
}
