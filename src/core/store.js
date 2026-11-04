// Tiny JSON-file persistence. One file per collection, written atomically
// (write to .tmp then rename) so a crash mid-save never corrupts the library.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = {};
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name + '.json');
  }

  read(name, fallback) {
    if (name in this.cache) return this.cache[name];
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (_) { /* missing or unreadable: use fallback */ }
    this.cache[name] = value;
    return value;
  }

  write(name, value) {
    this.cache[name] = value;
    const file = this.file(name);
    // Not indented: the guide listings run to 100 MB, and spacing made them slower to save and bigger.
    fs.writeFileSync(file + '.tmp', JSON.stringify(value));
    fs.renameSync(file + '.tmp', file);
  }

  // For the big ones (the guide listings): in use right away, saved to disk without holding up
  // everything else while it's written. Saves of the same file happen in order.
  writeSoon(name, value) {
    this.cache[name] = value;
    const file = this.file(name);
    const text = JSON.stringify(value);
    this.saving ||= {};
    this.saving[name] = (this.saving[name] || Promise.resolve()).catch(() => {})
      .then(() => fs.promises.writeFile(file + '.tmp', text))
      .then(() => fs.promises.rename(file + '.tmp', file));
    return this.saving[name];
  }
}

module.exports = { Store };
