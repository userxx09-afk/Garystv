// Shared helpers: API calls, formatting, remote-style focus navigation, dialogs.
/* global window, document */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The PC running GarysTV. Empty on the PC itself (same origin); the TV app sets
// window.GTV_SERVER (e.g. "http://192.168.1.20:5480") before these scripts run.
// Managing a linked GarysTV at another location (Settings > Other locations): everything for it
// goes through this one, which passes it on (core/peers.js). Until "Back" (or the app is restarted).
const MANAGING = (() => { try { return JSON.parse(sessionStorage.getItem('gtv.manage') || 'null'); } catch (_) { return null; } })();
const server = (p) => (window.GTV_SERVER || '') + (MANAGING ? `/peer/${MANAGING.id}` : '') + p;
function manageGarysTV(peer) {
  try { if (peer) sessionStorage.setItem('gtv.manage', JSON.stringify({ id: peer.id, name: peer.name })); else sessionStorage.removeItem('gtv.manage'); } catch (_) { /* private mode */ }
  location.hash = '';
  location.reload();
}
if (MANAGING) {
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'managing';
    bar.innerHTML = `<span>You're managing <b>${esc(MANAGING.name)}</b> at another location.</span><span class="btn nav" data-key="manage-back">‹ Back to this GarysTV</span>`;
    bar.querySelector('.btn').onclick = () => manageGarysTV(null);
    document.body.prepend(bar);
  });
}

const api = {
  async call(method, url, body) {
    const res = await fetch(server(url), { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  },
  get: (u) => api.call('GET', u),
  post: (u, b = {}) => api.call('POST', u, b),
  put: (u, b = {}) => api.call('PUT', u, b),
  del: (u) => api.call('DELETE', u),
};

// ---------- formatting ----------
const fmt = {
  time: (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  range: (a, b) => `${fmt.time(a)} – ${fmt.time(b)}`,
  day(t) {
    const d = new Date(t), today = new Date();
    const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  },
  when: (t) => `${fmt.day(t)} ${fmt.time(t)}`,
  dur(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
  },
  clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  },
  size(b) {
    if (b == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i > 2 ? 1 : 0)} ${u[i]}`;
  },
  se: (p) => (p.season != null && p.episode != null ? `S${p.season} E${p.episode}` : ''),
};

function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- remote-style navigation ----------
// Any element with class "nav" can be focused with the arrow keys and
// activated with Enter (or clicked with the mouse).
const Nav = {
  current: null,
  scope() { return $('.modal-bg:last-of-type .modal') || $('#view'); },
  // The screen's items, then (with no dialog open) the buttons along the top, reached with ↑.
  items() {
    const modal = $('.modal-bg:last-of-type .modal');
    const list = $$('.nav', modal || $('#view'));
    if (!modal) list.push(...$$('#topnav .nav'));
    return list.filter((el) => el.offsetParent !== null);
  },
  focus(el, { scroll = true } = {}) {
    if (this.current) this.current.classList.remove('focus');
    this.current = el || null;
    if (!el) return;
    el.classList.add('focus');
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (el._onFocus) el._onFocus();
  },
  restore(key) {
    const items = this.items();
    const match = key && items.find((el) => el.dataset.key === key);
    this.focus(match || items.find((el) => !el.closest('#topnav')) || items[0]);
  },
  key() { return this.current && this.current.dataset.key; },
  move(dir) {
    const items = this.items();
    let cur = this.current && items.includes(this.current) ? this.current : null;
    // Redrawn under the highlight (posters arriving, a list refreshing): carry on from its copy.
    if (!cur && this.current && this.current.dataset.key) {
      cur = items.find((el) => el.dataset.key === this.current.dataset.key) || null;
      if (cur) this.focus(cur, { scroll: false });
    }
    if (!cur) { this.focus(items.find((el) => !el.closest('#topnav')) || items[0]); return true; }
    // Like reading: ←→ along the row you're on (at its end, on to the next row's first item in
    // the same group); ↑↓ to the nearest row above or below, in the same column when there's one.
    const a = cur.getBoundingClientRect();
    const others = items.filter((el) => el !== cur).map((el) => ({ el, b: el.getBoundingClientRect() }));
    const cx = (r) => r.left + r.width / 2;
    const sameRow = (b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.height, b.height) / 3;
    const sameCol = (b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
    const pick = (list, score) => list.reduce((best, o) => (!best || score(o) < score(best) ? o : best), null);
    let best = null;
    if (dir === 'left' || dir === 'right') {
      const right = dir === 'right';
      const row = others.filter(({ b }) => sameRow(b) && (right ? b.left >= a.right - 2 : b.right <= a.left + 2));
      best = pick(row, ({ b }) => (right ? b.left - a.right : a.left - b.right));
      if (!best) {
        // Nothing level with it: the nearest thing that way, wherever it is (side menu -> the
        // screen beside it, and back), so the top bar, side menu and screen work alike.
        const cy = (r) => (r.top + r.bottom) / 2;
        const side = others.filter(({ el, b }) => (right ? b.left >= a.right - 2 : b.right <= a.left + 2) && !el.closest('#topnav'));
        best = pick(side, ({ b }) => Math.abs(cy(b) - cy(a)) * 2 + (right ? b.left - a.right : a.left - b.right));
      }
      // Into a side menu from beside it: its picked item (the page you're on), not whichever
      // menu item happens to be level with you.
      const menu = best && best.el.closest('.menu');
      const on = menu && !menu.contains(cur) && menu.querySelector('.nav.on');
      if (on && items.includes(on)) best = { el: on };
      if (!best) { // end of the row: the next row's first item (or the previous row's last) in this group
        const group = (el) => el.closest('.modal, #topnav, .menu, .tabs, .g-bar, .actions, .row, .list, .menu-list, .posters, .cards, .tiles, .seasons, table, .box, .pad');
        const g = group(cur);
        const order = items.filter((el) => group(el) === g).map((el) => ({ el, b: el.getBoundingClientRect() }))
          .sort((p, q) => (Math.abs(p.b.top - q.b.top) < Math.min(p.b.height, q.b.height) / 2 ? p.b.left - q.b.left : p.b.top - q.b.top));
        const i = order.findIndex((o) => o.el === cur);
        best = g && order[i + (right ? 1 : -1)];
      }
    } else {
      const down = dir === 'down';
      const gap = ({ b }) => (down ? b.top - a.bottom : a.top - b.bottom);
      const ahead = others.filter((o) => gap(o) >= -2);
      const pool = ahead.some(({ b }) => sameCol(b)) ? ahead.filter(({ b }) => sameCol(b)) : ahead;
      const nearest = pick(pool, gap);
      if (nearest) best = pick(pool.filter((o) => gap(o) <= gap(nearest) + nearest.b.height / 2), ({ b }) => Math.abs(cx(b) - cx(a)));
    }
    if (best) this.focus(best.el);
    return !!best;
  },
  handle(e) {
    const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (dirs[e.key]) {
      if (this.current && this.current._cycle && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        this.current._cycle(e.key === 'ArrowRight' ? 1 : -1);
        return true;
      }
      return this.move(dirs[e.key]);
    }
    if (e.key === 'Enter' && this.current) { this.current.click(); return true; }
    return false;
  },
};

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('.nav');
  if (el && el !== Nav.current && (Nav.scope().contains(el) || (!Modal.top() && el.closest('#topnav')))) Nav.focus(el, { scroll: false });
});

// ---------- dialogs ----------
// Modal.open(builder) where builder(modalEl, close) fills it in. Returns a
// promise that resolves with whatever close(value) was called with.
const Modal = {
  stack: [],
  open(build) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = '<div class="modal"></div>';
      document.body.appendChild(bg);
      const prevFocus = Nav.current;
      const close = (value) => {
        bg.remove();
        this.stack = this.stack.filter((m) => m !== entry);
        if (prevFocus && document.body.contains(prevFocus)) Nav.focus(prevFocus, { scroll: false });
        else Nav.current = null;
        resolve(value);
      };
      const entry = { bg, close };
      this.stack.push(entry);
      bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
      build($('.modal', bg), close);
      Nav.current = null;
      Nav.focus(Nav.items()[0]);
    });
  },
  top() { return this.stack[this.stack.length - 1]; },
  closeTop() { const t = this.top(); if (t) { t.close(); return true; } return false; },

  // Simple menu: Modal.menu(title, html, [{label, value, cls}]) -> chosen value
  menu(title, bodyHtml, choices) {
    return this.open((m, close) => {
      m.innerHTML = `<div class="title">${esc(title)}</div>${bodyHtml || ''}<div class="menu-list"></div>`;
      const list = $('.menu-list', m);
      for (const c of choices) {
        const b = document.createElement('div');
        b.className = `btn nav ${c.cls || ''}`;
        b.innerHTML = c.html || esc(c.label);
        b.onclick = () => close(c.value);
        list.appendChild(b);
      }
    });
  },
  // Asks for a short piece of text (a name). -> the text, or null if cancelled.
  prompt(title, label, value = '', ok = 'Save') {
    return this.open((m, close) => {
      m.innerHTML = `<div class="title">${esc(title)}</div>
        <div class="field"><label>${esc(label)}</label><input id="p-text" class="nav" maxlength="40" value="${esc(value)}"></div>
        <div class="actions"><div class="btn nav primary" id="p-ok">${esc(ok)}</div><div class="btn nav" id="p-cancel">Cancel</div></div>`;
      const input = $('#p-text', m);
      const done = () => { const v = input.value.trim(); if (v) close(v); else input.focus(); };
      $('#p-ok', m).onclick = done;
      $('#p-cancel', m).onclick = () => close(null);
      // Reachable with the remote's arrows like the buttons; OK on it brings up the TV's keyboard.
      input._onFocus = () => input.focus();
      input.addEventListener('keydown', (e) => {
        // Stopped here: otherwise the same Enter reaches the screen and presses what's highlighted
        // there again (the "New list" card, which asked for a name all over again).
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (input.value.trim()) done(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); input.blur(); Nav.focus($('#p-ok', m)); }
      });
    });
  },
  confirm(title, text, yes = 'Yes', no = 'Cancel') {
    return this.menu(title, `<div class="s">${esc(text)}</div>`, [{ label: yes, value: true, cls: 'danger' }, { label: no, value: false }]);
  },
};

// An option row that cycles values with Left/Right (like a TV menu).
function optionRow(label, values, index, onChange) {
  const el = document.createElement('div');
  el.className = 'opt nav';
  const paint = () => { el.innerHTML = `<span>${esc(label)}</span><span class="v">${esc(values[index].label)}</span>`; };
  el._cycle = (d) => { index = (index + d + values.length) % values.length; paint(); onChange(values[index].value); };
  el.onclick = () => el._cycle(1);
  paint();
  return el;
}

// The hint bar along the bottom. Each hint can be clicked (or tapped) to do the same as its key.
// list: [key, label, class, key it stands for (when the TV shows its own button name instead)]
const HINT_KEYS = { OK: 'Enter', Esc: 'Escape', Del: 'Delete', Space: ' ', Home: 'Home', '#': '#' };
function hintKey(k) { return HINT_KEYS[k] || (/^[A-Za-z]$/.test(k) ? k.toLowerCase() : null); }
function setHints(list) {
  $('#hints').innerHTML = list.map(([k, label, cls, orig]) => {
    const key = hintKey(orig || k);
    return `<span class="${cls || ''}${key ? ' press' : ''}"${key ? ` data-press="${esc(key)}"` : ''}><b>${esc(k)}</b>${esc(label)}</span>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const h = e.target.closest && e.target.closest('[data-press]');
  if (!h || !$('#hints').contains(h)) return;
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: h.dataset.press, bubbles: true, cancelable: true }));
});
