// Locates the helper programs used for playback and some IPTV recordings.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function onPath(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch (_) {
    return null;
  }
}

const exists = (p) => p && fs.existsSync(p) ? p : null;

// `winget install Gyan.FFmpeg` unpacks to %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin.
// Apps started before the install don't see the PATH change, so look there directly.
function wingetFfmpeg() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(root).filter((d) => /^Gyan\.FFmpeg/i.test(d))) {
      for (const build of fs.readdirSync(path.join(root, pkg)).filter((d) => /^ffmpeg/i.test(d)).sort().reverse()) {
        const exe = exists(path.join(root, pkg, build, 'bin', 'ffmpeg.exe'));
        if (exe) return exe;
      }
    }
  } catch (_) {}
  return null;
}

function findFfmpeg(settings = {}) {
  return exists(settings.ffmpegPath) || onPath('ffmpeg') || wingetFfmpeg() ||
    exists('C:\\ffmpeg\\bin\\ffmpeg.exe') || exists('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
}

function findVlc(settings = {}) {
  return exists(settings.vlcPath) || exists('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe') ||
    exists('C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe') || onPath('vlc');
}

module.exports = { findFfmpeg, findVlc };
