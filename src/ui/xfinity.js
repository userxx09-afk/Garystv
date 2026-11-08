// Xfinity first: picking a live channel that Xfinity carries opens the Xfinity app on this
// device (Fire TV, Samsung TV) or Xfinity's website (Windows). If Xfinity can't be opened, the
// channel plays in GarysTV as usual. The Xfinity login stays in Xfinity's own app; GarysTV never
// sees it. Set up in Settings > Xfinity (saved on the engine, so every TV shares it).
//
// Xfinity doesn't document a way to open its app straight to a channel. Each device's "link"
// can hold one once it's found on that device; {channel} becomes the Xfinity channel number.
// With no link, the app just opens.
/* global GTVAndroid, tizen */
const XFINITY_DEFAULTS = {
  enabled: false,
  channels: {}, // GarysTV channel id -> Xfinity channel number ('' = Xfinity has it, number unknown)
  firetvPackage: 'com.xfinity.cloudtvr.tenfoot',
  firetvLink: '', // e.g. a URI the app accepts; blank = just open the app
  tizenAppId: '', // the Xfinity app's ID on the Samsung TV
  webLink: 'https://www.xfinity.com/stream/live', // Windows and other browsers
};

const Xfinity = {
  failed: false, // opening failed this session: play here without trying again each channel change

  settings() { return { ...XFINITY_DEFAULTS, ...((App.state.settings || {}).xfinity || {}) }; },

  device() {
    if (window.GTVAndroid && GTVAndroid.openApp) return 'firetv';
    if (typeof tizen !== 'undefined' && tizen.application) return 'tizen';
    return 'web';
  },

  // Whether this channel should go to Xfinity (on, carried by Xfinity, and this device can).
  wants(channel) {
    const s = this.settings();
    if (!s.enabled || this.failed || !channel) return false;
    if (!Object.prototype.hasOwnProperty.call(s.channels, channel.id)) return false;
    const d = this.device();
    if (d === 'tizen') return !!s.tizenAppId;
    if (d === 'firetv') return !!s.firetvPackage;
    return !!s.webLink;
  },

  fill(link, channel) {
    const num = String(this.settings().channels[channel.id] || '');
    return link.replace(/\{channel\}/g, encodeURIComponent(num)).replace(/\{name\}/g, encodeURIComponent(channel.name || ''));
  },

  // Opens Xfinity for this channel. Answers true if it opened.
  async open(channel) {
    const s = this.settings();
    try {
      const d = this.device();
      if (d === 'firetv') return !!GTVAndroid.openApp(s.firetvPackage, s.firetvLink ? this.fill(s.firetvLink, channel) : '');
      if (d === 'tizen') {
        return await new Promise((resolve) => tizen.application.launch(s.tizenAppId, () => resolve(true), () => resolve(false)));
      }
      const url = this.fill(s.webLink, channel);
      if (window.GTVDesktop && window.GTVDesktop.openXfinity) return !!(await window.GTVDesktop.openXfinity(url));
      return !!window.open(url, '_blank', 'noopener');
    } catch (_) {
      return false;
    }
  },

  // Used by Player.play for live TV. Answers true when Xfinity took the channel.
  async tryChannel(channel) {
    if (!this.wants(channel)) return false;
    if (await this.open(channel)) {
      const num = this.settings().channels[channel.id];
      toast(`Opened Xfinity for ${channel.name}${num ? ` (Xfinity ${num})` : ''}`, 4000);
      return true;
    }
    this.failed = true;
    toast(`Couldn't open Xfinity on this ${this.device() === 'web' ? 'PC' : 'TV'}, so ${channel.name} plays in GarysTV. Check Settings > Xfinity.`, 7000);
    return false;
  },

  // For Settings: whether the Xfinity app is on this device (null = can't tell here).
  installed() {
    const d = this.device();
    if (d === 'firetv' && GTVAndroid.hasApp) return !!GTVAndroid.hasApp(this.settings().firetvPackage);
    return null;
  },
};
