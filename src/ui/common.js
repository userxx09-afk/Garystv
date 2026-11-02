// Shared helpers: API calls, formatting, remote-style focus navigation, dialogs.
/* global window, document */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The PC running GarysTV. Empty on the PC itself (same origin); the TV app sets
// window.GTV_SERVER (e.g. "http://192.168.1.20:5480") before these scripts run.
const server = (p) => (window.GTV_SERVER || '') + p;

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
  items() { return $$('.nav', this.scope()).filter((el) => el.offsetParent !== null); },
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
    this.focus(match || items[0]);
  },
  key() { return this.current && this.current.dataset.key; },
  move(dir) {
    const items = this.items();
    const cur = this.current && items.includes(this.current) ? this.current : null;
    if (!cur) { this.focus(items[0]); return true; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const dx = bx - ax, dy = by - ay;
      let primary, secondary;
      if (dir === 'up') { if (b.bottom > a.top + 2) continue; primary = -dy; secondary = Math.abs(dx); }
      if (dir === 'down') { if (b.top < a.bottom - 2) continue; primary = dy; secondary = Math.abs(dx); }
      if (dir === 'left') { if (b.right > a.left + 2) continue; primary = -dx; secondary = Math.abs(dy); }
      if (dir === 'right') { if (b.left < a.right - 2) continue; primary = dx; secondary = Math.abs(dy); }
      const score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this.focus(best);
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
  if (el && el !== Nav.current && Nav.scope().contains(el)) Nav.focus(el, { scroll: false });
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
        if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); done(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); input.blur(); Nav.focus($('#p-ok', m)); }
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

function setHints(list) {
  $('#hints').innerHTML = list.map(([k, label, cls]) => `<span class="${cls || ''}"><b>${esc(k)}</b>${esc(label)}</span>`).join('');
}
