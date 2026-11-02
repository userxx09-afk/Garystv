// Practice channels so the app can be tried without a tuner. Recordings from
// these are simulated (a placeholder file), and the guide is made up.
const CHANNELS = [
  ['2.1', 'KDEM', 'CBS'], ['4.1', 'KDNB', 'NBC'], ['5.1', 'KDAB', 'ABC'], ['7.1', 'KDPB', 'PBS'],
  ['9.1', 'KDFX', 'FOX'], ['11.1', 'KDCW', 'CW'], ['13.1', 'KDMN', 'MeTV'], ['20.1', 'KDIO', 'ION'],
  ['24.1', 'KDAN', 'Antenna TV'], ['30.1', 'KDWX', 'Weather'],
];

module.exports = {
  type: 'demo',
  label: 'Practice channels (no tuner needed)',
  fields: [],
  CHANNELS,
  async scan(config) {
    return {
      config,
      tunerCount: 2,
      info: 'Practice channels',
      channels: CHANNELS.map(([number, callsign, net]) => ({
        key: number, number, name: `${callsign} ${net}`, callsign, hd: true, streamUrl: null,
      })),
    };
  },
};
