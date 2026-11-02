// Registry of channel sources. To add a new kind of provider, write a module
// with { type, label, fields, scan(config) } and list it here.
const SOURCES = [require('./hdhomerun'), require('./free'), require('./m3u'), require('./demo')];

const byType = Object.fromEntries(SOURCES.map((s) => [s.type, s]));

module.exports = {
  get: (type) => {
    if (!byType[type]) throw new Error(`Unknown source type: ${type}`);
    return byType[type];
  },
  describe: () => SOURCES.map(({ type, label, fields }) => ({ type, label, fields })),
};
