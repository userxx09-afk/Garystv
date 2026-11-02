// TV side of GarysTV (Samsung/Tizen and Fire TV). Loaded before the shared screens.
//  1. Finds the GarysTV PC or home server on the home network (or asks for its address)
//     and sets window.GTV_SERVER; the screens wait on window.GTV_READY before starting.
//  2. Turns the TV remote's buttons into the keys the screens already understand.
//     The Fire TV app (firetv/) passes its remote buttons in as Samsung codes via GTV_REMOTE.
/* global tizen, GTVAndroid, Player, GuideView, App, setHints:writable */
(function () {
  const PORT = 5480;
  const SAVED = 'gtv.server';
  const isTizen = typeof tizen !== 'undefined';
  const isAndroid = typeof GTVAndroid !== 'undefined';
  let resolveReady;
  window.GTV_READY = new Promise((r) => { resolveReady = r; });
  window.GTV_EXIT = () => {
    try {
      if (isAndroid) GTVAndroid.exit();
      else tizen.application.getCurrentApplication().exit();
    } catch (_) { /* not on a TV */ }
  };

  const store = {
    get() { try { return localStorage.getItem(SAVED); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(SAVED, v); } catch (_) { /* private mode */ } },
  };

  // ---------- remote buttons ----------
  const REGISTER = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown',
    'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'Info', 'Guide',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  if (isTizen) {
    try { tizen.tvinputdevice.registerKeyBatch(REGISTER); } catch (_) {
      REGISTER.forEach((k) => { try { tizen.tvinputdevice.registerKey(k); } catch (__) { /* key not on this model */ } });
    }
  }

  const watching = () => typeof Player !== 'undefined' && Player.mode === 'full';
  // keyCode -> key the screens understand (a function picks by what's on screen)
  const KEYS = {
    10009: 'Escape', // Back
    13: 'Enter', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    403: 'r', // red: record
    404: 'd', // green: My Recordings
    405: 't', // yellow: Timers
    406: 's', // blue: Search
    458: 'g', // Guide
    457: 'i', // Info
    10252: ' ', 415: ' ', 19: ' ', // play/pause
    413: 'Escape', // stop
    417: () => (watching() ? 'ArrowRight' : ']'), // fast-forward: skip 30s, or next day in the guide
    412: () => (watching() ? 'ArrowLeft' : '['), // rewind: back 10s, or previous day
    427: () => (watching() ? 'ChannelUp' : 'PageUp'), // CH ▲
    428: () => (watching() ? 'ChannelDown' : 'PageDown'), // CH ▼
  };
  for (let d = 0; d <= 9; d++) KEYS[48 + d] = String(d);

  function onRemote(e) {
    if (!e.isTrusted && !e.gtvRemote) return; // our own re-sent key (gtvRemote: a simulated remote press, for testing)
    if (connect.open) {
      e.stopImmediatePropagation(); // the screens aren't running yet
      if (connect.onKey(e)) e.preventDefault();
      return;
    }
    let key = KEYS[e.keyCode];
    if (typeof key === 'function') key = key();
    if (!key || key === e.key) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (key === 'ChannelUp' || key === 'ChannelDown') { Player.surf(key === 'ChannelUp' ? 1 : -1); return; }
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  window.addEventListener('keydown', onRemote, true);
  // Fire TV: buttons the Android side catches (Back, ≡, play/pause, rewind...), as Samsung codes.
  window.GTV_REMOTE = (keyCode) => onRemote({ keyCode, key: '', gtvRemote: true, preventDefault() {}, stopImmediatePropagation() {} });

  // Show remote buttons in the hint bar instead of keyboard keys.
  const HINT = isAndroid
    // Fire TV remotes: no colored or guide buttons (Home has My Recordings, Timers, Search and the Guide); ≡ records.
    ? { R: ['≡'], D: null, T: null, S: null, G: null, Esc: ['BACK'], 'PgUp/PgDn': ['CH ▲▼'], '[ ]': ['⏪ ⏩'], Tab: null, Del: null, Type: ['OK', '', 'Type'] }
    : { R: ['●', 'k-red'], D: ['●', 'k-green'], T: ['●', 'k-yellow'], S: ['●', 'k-blue'], G: ['GUIDE'], Esc: ['BACK'],
      'PgUp/PgDn': ['CH ▲▼'], '[ ]': ['⏪ ⏩'], Tab: null, Del: null, Type: ['OK', '', 'Type'] };
  function tvHints(list) {
    return list.flatMap(([k, label, cls]) => {
      if (!(k in HINT)) return [[k, label, cls]];
      if (!HINT[k]) return [];
      const [nk, ncls, nlabel] = HINT[k];
      return [[nk, nlabel || label, ncls || cls]];
    });
  }

  // ---------- finding the GarysTV server ----------
  async function ping(base, ms = 1500) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(`${base}/api/ping`, { signal: ac.signal, cache: 'no-store' });
      const j = await res.json();
      return j && j.app === 'GarysTV' ? { base, name: j.name } : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function myAddress() {
    return new Promise((resolve) => {
      if (isAndroid) {
        try { return resolve(GTVAndroid.ipAddress() || null); } catch (_) { return resolve(null); }
      }
      if (!isTizen) {
        // Testing in a normal browser: use the address this page came from.
        const h = location.hostname;
        return resolve(/^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : null);
      }
      const tryProp = (props) => {
        if (!props.length) return resolve(null);
        try {
          tizen.systeminfo.getPropertyValue(props[0], (n) => (n && n.ipAddress ? resolve(n.ipAddress) : tryProp(props.slice(1))), () => tryProp(props.slice(1)));
        } catch (_) { tryProp(props.slice(1)); }
      };
      tryProp(['ETHERNET_NETWORK', 'WIFI_NETWORK']);
    });
  }

  // Ask every address on the TV's network (x.x.x.1-254) whether it is running GarysTV.
  async function scan(onFound) {
    const ip = await myAddress();
    if (!ip) return [];
    const prefix = ip.split('.').slice(0, 3).join('.');
    const hosts = ip.startsWith('127.') ? ['127.0.0.1'] : Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    const found = [];
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (next < hosts.length) {
        const hit = await ping(`http://${hosts[next++]}:${PORT}`);
        if (hit) { found.push(hit); onFound(hit); }
      }
    }));
    return found;
  }

  function normalize(addr) {
    let a = String(addr || '').trim().replace(/\/+$/, '');
    if (!a) return null;
    if (!/^https?:\/\//.test(a)) a = `http://${a}`;
    if (!/:\d+$/.test(a.replace(/^https?:\/\//, ''))) a += `:${PORT}`;
    return a;
  }

  // ---------- connect screen ----------
  const connect = {
    open: false, el: null, found: [], focus: 0,

    show(message) {
      this.open = true;
      this.found = [];
      const saved = store.get();
      this.el = document.createElement('div');
      this.el.id = 'connect';
      this.el.innerHTML = `
        <div class="cx">
          <img src="logo.jpg" alt="" class="cx-logo">
          <h1>Garys<span>TV</span></h1>
          <p class="cx-msg">${message || 'Looking for GarysTV on your home network...'}</p>
          <div class="cx-list" id="cxList"></div>
          <div class="cx-row">
            <input id="cxAddr" class="cx-f" placeholder="GarysTV address, e.g. 192.168.1.20" value="${saved ? saved.replace(/^https?:\/\//, '').replace(`:${PORT}`, '') : ''}">
            <button class="cx-f" id="cxGo">Connect</button>
          </div>
          <button class="cx-f" id="cxScan">Search again</button>
          <p class="cx-help">Make sure the computer running GarysTV (the home server or the PC) is on, and on the same home network as this TV. On a Windows PC, when Windows asks whether GarysTV may use the network, choose <b>Allow</b>. The address is shown in GarysTV &gt; Settings &gt; Recording.</p>
        </div>`;
      document.body.appendChild(this.el);
      this.el.querySelector('#cxGo').onclick = () => this.tryAddress(this.el.querySelector('#cxAddr').value);
      this.el.querySelector('#cxScan').onclick = () => this.search();
      this.setFocus(0);
      this.search();
    },

    fields() { return [...this.el.querySelectorAll('.cx-f')]; },
    setFocus(i) {
      const f = this.fields();
      this.focus = Math.max(0, Math.min(f.length - 1, i));
      f.forEach((el, n) => el.classList.toggle('focus', n === this.focus));
      f[this.focus].focus();
    },

    // Returns true when it handled the key; otherwise the key types into the address box.
    onKey(e) {
      let k = KEYS[e.keyCode] || e.key;
      if (typeof k === 'function') k = '';
      const f = this.fields();
      const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
      if (k === 'ArrowDown' || (k === 'ArrowRight' && !typing)) this.setFocus(this.focus + 1);
      else if (k === 'ArrowUp' || (k === 'ArrowLeft' && !typing)) this.setFocus(this.focus - 1);
      else if (k === 'Enter') { if (f[this.focus].tagName === 'INPUT') this.tryAddress(f[this.focus].value); else f[this.focus].click(); }
      else if (k === 'Escape' && e.keyCode === 10009 && typing && document.activeElement.value) document.activeElement.value = document.activeElement.value.slice(0, -1); // remote Back deletes a character
      else if (k === 'Escape') window.GTV_EXIT();
      else return false;
      return true;
    },

    async search() {
      const msg = this.el.querySelector('.cx-msg');
      const list = this.el.querySelector('#cxList');
      msg.textContent = 'Looking for GarysTV on your home network...';
      list.innerHTML = '';
      this.found = [];
      const found = await scan((hit) => {
        if (this.found.some((f) => f.base === hit.base)) return;
        this.found.push(hit);
        const b = document.createElement('button');
        b.className = 'cx-f cx-pc';
        b.innerHTML = `<b>${hit.name.replace(/[<>&]/g, '')}</b><small>${hit.base.replace(/^https?:\/\//, '')}</small>`;
        b.onclick = () => this.done(hit.base);
        list.appendChild(b);
        if (this.found.length === 1) this.setFocus(0);
      });
      if (!this.open) return;
      if (found.length === 1) { msg.textContent = `Found ${found[0].name}. Connecting...`; return this.done(found[0].base); } // the usual home: one PC, no question to ask
      msg.textContent = found.length ? 'Pick your GarysTV:' : "GarysTV wasn't found. Type its address below, or check the steps at the bottom.";
      if (!found.length) this.setFocus(0);
    },

    async tryAddress(value) {
      const base = normalize(value);
      if (!base) return;
      const msg = this.el.querySelector('.cx-msg');
      msg.textContent = `Connecting to ${base.replace(/^https?:\/\//, '')}...`;
      const hit = await ping(base, 4000);
      if (hit) this.done(hit.base);
      else msg.textContent = `Couldn't reach GarysTV at ${base.replace(/^https?:\/\//, '')}. Check the address and that GarysTV is running.`;
    },

    done(base) {
      store.set(base);
      this.open = false;
      this.el.remove();
      start(base);
    },
  };

  function start(base) {
    window.GTV_SERVER = base;
    if (typeof setHints === 'function') {
      const orig = setHints;
      setHints = (list) => orig(tvHints(list)); // eslint-disable-line no-global-assign
    }
    resolveReady();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.documentElement.classList.add('tv');
    const saved = store.get();
    if (saved && await ping(saved, 3000)) return start(saved);
    connect.show(saved ? `Can't reach GarysTV at ${saved.replace(/^https?:\/\//, '')}. Is it turned on?` : null);
  });
})();
