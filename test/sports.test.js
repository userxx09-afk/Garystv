const test = require('node:test');
const assert = require('node:assert');
const { Sports, parseEvent, matchChannels, networkOf } = require('../src/core/sports');

const T0 = Date.parse('2026-11-15T18:00:00Z'); // Sunday noon in Iowa
const bears = { id: '3', displayName: 'Chicago Bears', shortDisplayName: 'Bears', name: 'Bears', location: 'Chicago', abbreviation: 'CHI', logos: [{ href: 'http://l/chi.png' }] };
const packers = { id: '9', displayName: 'Green Bay Packers', shortDisplayName: 'Packers', name: 'Packers', location: 'Green Bay', abbreviation: 'GB', logos: [{ href: 'http://l/gb.png' }] };

// What a team's /schedule answers (broadcasts as objects, scores as objects).
const scheduleEvent = {
  id: '401', date: new Date(T0).toISOString(), name: 'Chicago Bears at Green Bay Packers', shortName: 'CHI @ GB',
  competitions: [{ date: new Date(T0).toISOString(), status: { type: { state: 'pre', shortDetail: '11/15 - 12:00 PM CST' } },
    competitors: [{ homeAway: 'home', team: packers }, { homeAway: 'away', team: bears }],
    broadcasts: [{ type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'FOX' } }, { type: { shortName: 'Streaming' }, market: { type: 'National' }, media: { shortName: 'NFL+' } }] }],
};
// What the scoreboard answers (broadcast names as lists, scores as strings).
const scoreboardEvent = {
  id: '401', date: new Date(T0).toISOString(), name: 'Chicago Bears at Green Bay Packers', shortName: 'CHI @ GB',
  competitions: [{ date: new Date(T0).toISOString(), status: { type: { state: 'in', shortDetail: '3rd 4:12' } },
    competitors: [{ homeAway: 'home', team: packers, score: '17' }, { homeAway: 'away', team: bears, score: '24' }],
    broadcasts: [{ market: 'national', names: ['FOX'] }] }],
};

test('ESPN games, from a team schedule and from the scoreboard', () => {
  const g = parseEvent(scheduleEvent, 'nfl');
  assert.equal(g.id, 'nfl:401');
  assert.deepEqual([g.away.short, g.home.short, g.start, g.state], ['Bears', 'Packers', T0, 'pre']);
  assert.deepEqual(g.broadcasts.map((b) => [b.name, b.streaming]), [['FOX', false], ['NFL+', true]]);
  const live = parseEvent(scoreboardEvent, 'nfl');
  assert.deepEqual([live.state, live.detail, live.away.score, live.home.score], ['in', '3rd 4:12', '24', '17']);
  assert.deepEqual(live.broadcasts, [{ name: 'FOX', market: 'national', streaming: false }]);
});

test('network names', () => {
  assert.equal(networkOf('ESPN2'), 'ESPN2');
  assert.equal(networkOf('FS1'), 'FS1');
  assert.equal(networkOf('Peacock'), null);
});

test('games are matched to channels by the guide first, then by network', () => {
  const g = parseEvent(scheduleEvent, 'nfl');
  g.broadcasts.push({ name: 'ESPN', market: 'national', streaming: false });
  const channels = [
    { id: 'kljb', number: '18.1', name: 'KLJB-DT' }, // an antenna station named by call sign: only the guide knows
    { id: 'wfld', number: '1032', name: 'WFLD FOX 32 Chicago' }, // carries FOX, nothing in the guide
    { id: 'espn', number: '1100', name: 'ESPN' },
    { id: 'espn2', number: '1101', name: 'ESPN2' },
    { id: 'foxnews', number: '1200', name: 'FOX News' },
    { id: 'kwqc', number: '6.1', name: 'KWQC-DT' },
  ];
  const listings = {
    kljb: [{ start: T0 - 30 * 60000, end: T0, title: 'FOX NFL Kickoff' }, { start: T0, end: T0 + 3.5 * 3600e3, title: 'NFL Football', subtitle: 'Chicago Bears at Green Bay Packers' }],
    kwqc: [{ start: T0, end: T0 + 3600e3, title: 'Packers Today' }], // names a team, but isn't the game
  };
  const m = matchChannels(g, channels, (c) => listings[c.id] || []);
  assert.deepEqual(m.map((c) => c.channelId), ['kljb', 'espn', 'wfld']);
  assert.equal(m[0].score, 100);
  assert.equal(m[0].program.subtitle, 'Chicago Bears at Green Bay Packers');
  assert.match(m[2].why, /may show a different one/);
});

test('my teams: schedules, today\'s scores, and per-team limits', async () => {
  const now = Date.now();
  const at = (h) => new Date(now + h * 3600e3).toISOString();
  const ev = (id, h, state = 'pre') => ({ ...scheduleEvent, id, date: at(h), competitions: [{ ...scheduleEvent.competitions[0], date: at(h), status: { type: { state, shortDetail: '' } } }] });
  const urls = [];
  const answers = {
    '/football/nfl/teams/3/schedule': { events: [ev('1', -48, 'post'), ev('2', 1), ev('3', 24 * 7), ev('4', 24 * 30)] },
    '/football/nfl/scoreboard': { events: [{ ...scoreboardEvent, id: '2', date: at(1), competitions: [{ ...scoreboardEvent.competitions[0], date: at(1) }] }] },
  };
  const fetchImpl = async (url) => {
    urls.push(url);
    const key = Object.keys(answers).find((k) => url.includes(k));
    return { ok: !!key, status: key ? 200 : 404, json: async () => answers[key] };
  };
  const data = {};
  const core = {
    settings: { sportsTeams: [{ league: 'nfl', id: '3', name: 'Chicago Bears' }] },
    store: { read: (k, f) => data[k] || f, writeSoon: async (k, v) => { data[k] = v; } },
    guideData: { channels: [] },
    visibleChannels: () => [{ id: 'fox', number: '1032', name: 'WFLD FOX 32' }],
    programsFor: () => [],
  };
  const s = new Sports(core, { api: 'http://espn', fetchImpl });
  const r = await s.games();
  assert.deepEqual(r.games.map((g) => g.id), ['nfl:2', 'nfl:3']); // old final and a month out are left off
  assert.equal(r.games[0].state, 'in'); // from the scoreboard
  assert.deepEqual(r.games[0].mine, ['3']);
  assert.equal(r.games[0].channels[0].channelId, 'fox');
  await s.games();
  assert.equal(urls.filter((u) => u.includes('/schedule')).length, 1); // the schedule is kept for a while
});
