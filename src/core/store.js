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
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
}

module.exports = { Store };
