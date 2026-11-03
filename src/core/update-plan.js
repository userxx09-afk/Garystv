// When updates go in (Settings > Updates), for the Windows app (src/app-updates.js) and the
// home server (server-updates.js) alike:
//   scheduled  at the day and time you picked (Sundays 3:00 AM unless changed), within two hours
//   anytime    as soon as it's downloaded
//   ask        only when you choose Restart and update now
// Either way only while nothing is recording or about to record and nobody is watching.
const QUIET_MS = 15 * 60000; // no recording starting this soon
const WINDOW_MS = 2 * 3600000; // how long after the chosen time an update may still go in
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The plan in Settings; older settings had just autoUpdate on or off.
function plan(s) {
  const when = s.updatePlan || (s.autoUpdate === false ? 'ask' : 'scheduled');
  const [h, m] = String(s.updateTime || '03:00').split(':').map(Number);
  return { when, day: s.updateDay || 'sun', h: h || 0, m: m || 0 };
}

// The most recent chosen moment (this week's Sunday 3:00, or today's for every day), or null if it's not that day.
function lastSlot(p, now = new Date()) {
  const t = new Date(now); t.setHours(p.h, p.m, 0, 0);
  if (t > now) t.setDate(t.getDate() - 1);
  return p.day === 'daily' || DAYS[t.getDay()] === p.day ? t.getTime() : null;
}

// Whether an update may go in on its own now.
function due(settings, now = new Date()) {
  const p = plan(settings);
  if (p.when === 'anytime') return true;
  if (p.when !== 'scheduled') return false;
  const slot = lastSlot(p, now);
  return slot != null && now - slot < WINDOW_MS;
}

// Nothing recording, nothing about to, nobody watching (live TV or a movie).
function quiet(core) {
  return !core.active.size && !(core.timeshift && core.timeshift.sessions.size) && !(core.tuners && core.tuners.uses.size)
    && !core.getSchedule().some((j) => j.status === 'scheduled' && j.start - Date.now() < QUIET_MS);
}

// "0.2.31" is newer than "0.2.9".
function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

module.exports = { plan, lastSlot, due, quiet, newer, WINDOW_MS };
