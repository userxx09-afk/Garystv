// Made-up listings for the practice channels, so the guide and timers can be tried.
const { CHANNELS } = require('../sources/demo');

const SHOWS = [
  ['Morning Report', 'News', 60], ['Kitchen Table', 'Cooking', 30], ['Price of Luck', 'Game show', 60],
  ['Riverside Medical', 'Drama', 60], ['Evening News', 'News', 30], ['Trivia Night', 'Game show', 30],
  ['Detective Lane', 'Drama', 60], ['Backyard Builders', 'Home', 30], ['Wild Places', 'Nature', 60],
  ['Laugh Track Classics', 'Comedy', 30], ['Late Show Tonight', 'Talk', 60], ['Local Weather Now', 'Weather', 30],
  ['Antiques on the Road', 'Reality', 60], ['Sunday Football', 'Sports', 180], ['The Old West', 'Western', 60],
];

function seeded(n) {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

module.exports = {
  type: 'demo',
  label: 'Practice guide',
  fields: [],
  async fetch(_config, { hours = 48 } = {}) {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() - 2);
    const until = start.getTime() + hours * 3600000;
    const channels = [];
    const programs = {};
    CHANNELS.forEach(([number, callsign, net], ci) => {
      const id = `demo-${callsign}`;
      channels.push({ id, names: [callsign, `${callsign}-DT`, net, number], number, logo: '' });
      const list = (programs[id] = []);
      let t = start.getTime();
      let i = 0;
      while (t < until) {
        const slot = Math.floor(t / 1800000);
        const [title, cat, mins] = SHOWS[Math.floor(seeded(slot * 7 + ci * 13) * SHOWS.length)];
        const ep = 1 + Math.floor(seeded(slot + ci) * 20);
        list.push({
          start: t,
          end: t + mins * 60000,
          title,
          subtitle: cat === 'News' || cat === 'Weather' ? '' : `Episode ${ep}`,
          desc: `A practice listing for ${title} on ${callsign}. Real descriptions appear once a guide is connected.`,
          categories: [cat],
          season: cat === 'News' ? null : 1 + (ep % 4),
          episode: cat === 'News' ? null : ep,
          programId: '',
          seriesId: `demo-${title}`,
          isNew: seeded(slot * 3 + ci) > 0.6,
          rating: 'TV-PG',
          icon: '',
        });
        t += mins * 60000;
        i++;
      }
    });
    return { channels, programs };
  },
};
