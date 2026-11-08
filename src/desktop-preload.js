// Windows app only: what the screens can ask of the PC beyond the HTTP API. Loaded into the
// window by main.js; the screens find it as window.GTVDesktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GTVDesktop', {
  // Windows' Save dialog, then writes the file there. Answers { path } once saved,
  // {} if you cancelled, or { error }.
  saveFile: (name, text, ext) => ipcRenderer.invoke('gtv:save-file', { name: String(name), text: String(text), ext: String(ext || '') }),
});
