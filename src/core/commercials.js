// Finds commercial breaks in a recording. US broadcasters put a moment of black
// picture and silence between a show and each ad, and between ads. A run of those
// moments spaced like ads (15, 30, 60 seconds apart) is a commercial break.
const os = require('os');
const { spawn } = require('child_process');

const MIN_AD_S = 8;
const MAX_AD_S = 125;
const MIN_BREAK_S = 40;
const MAX_BREAK_S = 480;

// ffmpeg's blackdetect / silencedetect log lines -> [[start, end], ...] for each.
function parseDetect(log) {
  const black = [], silence = [];
  for (const m of log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) black.push([+m[1], +m[2]]);
  let open = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') open = Math.max(0, +m[2]);
    else if (open != null) { silence.push([open, +m[2]]); open = null; }
  }
  return { black, silence };
}

// Moments that are black and silent at once (or just black, if the sound never goes quiet).
function breakpoints({ black, silence }) {
  const near = (b) => silence.some(([s, e]) => s - 0.4 < b[1] && b[0] < e + 0.4);
  const marks = (silence.length ? black.filter(near) : black).map(([s, e]) => (s + e) / 2).sort((a, b) => a - b);
  return marks.filter((t, i) => i === 0 || t - marks[i - 1] > 1);
}

// Ads run 15/30/60 seconds (sometimes 10 or 20): within a couple of seconds of that.
const adLength = (g) => g >= MIN_AD_S && g <= MAX_AD_S && (Math.abs(g - Math.round(g / 15) * 15) <= 2 || Math.abs(g - Math.round(g / 10) * 10) <= 1);

// Chains of breakpoints a few ads apart; a chain that looks like ads is a break.
function findBreaks(points) {
  const chains = [];
  let chain = [];
  for (const t of points) {
    const gap = chain.length ? t - chain[chain.length - 1] : 0;
    if (chain.length && gap < 5) continue; // a second fade right after the first: same moment
    if (gap > MAX_AD_S) { chains.push(chain); chain = []; }
    chain.push(t);
  }
  if (chain.length) chains.push(chain);
  // A fade in the show just before or after the break isn't part of it: trim ends that aren't ad-length.
  const trim = (c) => {
    while (c.length > 1 && !adLength(c[1] - c[0])) c = c.slice(1);
    while (c.length > 1 && !adLength(c[c.length - 1] - c[c.length - 2])) c = c.slice(0, -1);
    return c;
  };
  return chains.map(trim).filter((c) => {
    if (c.length < 3) return false; // at least two ads
    const span = c[c.length - 1] - c[0];
    const gaps = c.slice(1).map((t, i) => t - c[i]);
    return span >= MIN_BREAK_S && span <= MAX_BREAK_S && gaps.filter(adLength).length / gaps.length >= 0.6;
  }).map((c) => ({ start: Math.round(c[0] * 10) / 10, end: Math.round(c[c.length - 1] * 10) / 10 }));
}

// Scans a recording file. Resolves to [{ start, end }] in seconds from the start of the file.
function analyze(file, ffmpeg, onStart = () => {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', file,
      '-vf', 'scale=320:-2,blackdetect=d=0.1:pix_th=0.10', '-af', 'silencedetect=noise=-45dB:d=0.1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    onStart(proc);
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch (_) { /* keep going at normal priority */ }
    let log = '';
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code && !/black_start|silence_start/.test(log)) return reject(new Error(log.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      resolve(findBreaks(breakpoints(parseDetect(log))));
    });
  });
}

module.exports = { analyze, parseDetect, breakpoints, findBreaks };
