// Turns timers ("rules") + guide listings into a concrete list of upcoming
// recordings ("jobs"), then decides which ones fit the available tuners.
//
// Rule types (rules are kept in priority order; first = most important):
//   once    - one specific airing             { channelId, start, end, title, ... }
//   series  - every airing of a title         { title, channelId|null, newOnly, keep }
//   manual  - a channel at a clock time       { channelId, title, time:'20:00', minutes, days:[0-6] | date:'2026-10-27' }

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function episodeKey(p) {
  const t = normTitle(p.title);
  if (p.season != null && p.episode != null) return `${t}|s${p.season}e${p.episode}`;
  if (p.programId) return `${t}|${p.programId}`;
  if (p.subtitle) return `${t}|${normTitle(p.subtitle)}`;
  return ''; // can't tell episodes apart (news etc.) - never treated as a duplicate
}

function makeJob(rule, priority, channel, p, settings) {
  const pre = (rule.prePad ?? settings.prePadMin ?? 1) * 60000;
  const post = (rule.postPad ?? settings.postPadMin ?? 2) * 60000;
  return {
    id: `${channel.id}@${p.start}`,
    ruleId: rule.id,
    ruleType: rule.type,
    channelId: channel.id,
    sourceId: channel.sourceId,
    channelNumber: channel.number,
    channelName: channel.name,
    start: p.start,
    end: p.end,
    recStart: p.start - pre,
    recEnd: p.end + post,
    title: p.title,
    subtitle: p.subtitle || '',
    desc: p.desc || '',
    season: p.season ?? null,
    episode: p.episode ?? null,
    categories: p.categories || [],
    isNew: !!p.isNew,
    episodeKey: episodeKey(p),
    priority,
    status: 'scheduled',
    reason: '',
  };
}

function manualAirings(rule, now, horizonEnd) {
  const out = [];
  const [hh, mm] = String(rule.time || '20:00').split(':').map(Number);
  const minutes = rule.minutes || 60;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1); // include an airing that started yesterday and is still running
  while (day.getTime() < horizonEnd) {
    const start = new Date(day);
    start.setHours(hh, mm, 0, 0);
    const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const wanted = rule.date ? rule.date === iso : (rule.days || []).includes(start.getDay());
    if (wanted) out.push({ start: start.getTime(), end: start.getTime() + minutes * 60000, title: rule.title || 'Manual recording', categories: [] });
    day.setDate(day.getDate() + 1);
  }
  return out;
}

// ctx: { rules, channels, programsFor(channel)->[], tunerCount(sourceId)->n,
//        recordedKeys:Set, skipped:Set, active:Set(jobId), settings, now, horizonMs }
function buildSchedule(ctx) {
  const { rules, channels, programsFor, now, settings = {} } = ctx;
  const horizonEnd = now + (ctx.horizonMs || 8 * 86400000);
  const chById = new Map(channels.map((c) => [c.id, c]));
  const jobs = new Map();
  const seenEpisodes = new Set();

  rules.forEach((rule, priority) => {
    if (rule.enabled === false) return;
    const candidates = [];
    if (rule.type === 'once') {
      const ch = chById.get(rule.channelId);
      if (ch) candidates.push([ch, rule]);
    } else if (rule.type === 'manual') {
      const ch = chById.get(rule.channelId);
      if (ch) for (const p of manualAirings(rule, now, horizonEnd)) candidates.push([ch, p]);
    } else if (rule.type === 'series') {
      const want = normTitle(rule.title);
      for (const ch of channels) {
        if (ch.hidden || (rule.channelId && rule.channelId !== ch.id)) continue;
        for (const p of programsFor(ch)) if (normTitle(p.title) === want) candidates.push([ch, p]);
      }
      candidates.sort((a, b) => a[1].start - b[1].start);
    }

    for (const [ch, p] of candidates) {
      const job = makeJob(rule, priority, ch, p, settings);
      if (job.recEnd <= now || job.start > horizonEnd || jobs.has(job.id)) continue;
      if (ctx.skipped && ctx.skipped.has(job.id)) {
        job.status = 'skipped'; job.reason = 'Cancelled by you';
      } else if (rule.type === 'series' && rule.newOnly && !p.isNew) {
        continue; // reruns aren't even listed for "new episodes only"
      } else if (rule.type === 'series' && job.episodeKey) {
        if (ctx.recordedKeys && ctx.recordedKeys.has(job.episodeKey) && !(ctx.active && ctx.active.has(job.id))) {
          job.status = 'skipped'; job.reason = 'Already recorded';
        } else if (seenEpisodes.has(job.episodeKey)) {
          job.status = 'skipped'; job.reason = 'Recording an earlier airing';
        } else {
          seenEpisodes.add(job.episodeKey);
        }
      }
      jobs.set(job.id, job);
    }
  });

  resolveConflicts([...jobs.values()], ctx);
  return [...jobs.values()].sort((a, b) => a.start - b.start || a.priority - b.priority);
}

// Greedy by priority: a job gets a tuner if, during its whole recording window, fewer than
// tunerCount already-accepted jobs on that source overlap it. When its own plan is full, the
// same channel on another plan with room is used (ctx.choices; job.viaChannelId says which).
function resolveConflicts(jobs, ctx) {
  const active = ctx.active || new Set();
  const order = jobs
    .filter((j) => j.status === 'scheduled')
    .sort((a, b) => (active.has(b.id) - active.has(a.id)) || a.priority - b.priority || a.start - b.start);
  const accepted = {};
  const fits = (job, sourceId) => {
    const list = (accepted[sourceId] ||= [...(ctx.reserved ? ctx.reserved(sourceId) : [])]);
    const cap = ctx.tunerCount ? ctx.tunerCount(sourceId) : 2;
    const overlapping = list.filter((o) => o.recStart < job.recEnd && job.recStart < o.recEnd);
    // Peak concurrency within the overlap: check at each start point.
    const points = [job.recStart, ...overlapping.map((o) => o.recStart).filter((t) => t > job.recStart && t < job.recEnd)];
    const peak = Math.max(0, ...points.map((t) => overlapping.filter((o) => o.recStart <= t && t < o.recEnd).length));
    return peak < cap ? list : null;
  };
  for (const job of order) {
    const options = (ctx.choices && ctx.choices(job)) || [{ id: job.channelId, sourceId: job.sourceId }];
    const pick = options.find((c) => fits(job, c.sourceId)) || null;
    if (pick) {
      accepted[pick.sourceId].push(job);
      if (pick.id !== job.channelId) Object.assign(job, { viaChannelId: pick.id, viaSourceId: pick.sourceId });
    } else {
      const cap = ctx.tunerCount ? ctx.tunerCount(job.sourceId) : 2;
      job.status = 'conflict';
      job.reason = options.length > 1 ? 'Every plan with this channel is busy' : `All ${cap} tuner${cap === 1 ? '' : 's'} busy`;
    }
  }
}

module.exports = { buildSchedule, episodeKey, normTitle };
