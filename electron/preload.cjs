/**
 * Preload bridge. The renderer is sandboxed (no Node, no Electron
 * globals); this exposes a narrow, auditable surface via
 * `window.electron`. Only what the renderer actually needs goes here —
 * never the raw ipcRenderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Mark the document as running under Electron so CSS can reserve room
// for the traffic-light buttons, opt into the drag region, etc. Done
// pre-DOMContentLoaded by toggling a class once the body exists.
window.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('is-electron');
});

// macOS green-button fullscreen hides the traffic lights, so the chrome
// strip drops its left inset (the `is-fullscreen` body class). Own this in
// the preload, not a renderer React effect: the listener is registered at
// preload top-level — before the page loads — so the initial state push
// (main sends it on did-finish-load) is caught even when the window STARTS
// in fullscreen. A React effect can attach its listener after that push has
// already fired and miss it, leaving the inset stuck on.
function applyFullscreenClass(isFullScreen) {
  const set = () => document.body.classList.toggle('is-fullscreen', isFullScreen === true);
  if (document.body) set();
  else window.addEventListener('DOMContentLoaded', set, { once: true });
}
ipcRenderer.on('fullscreen-change', (_e, isFullScreen) => applyFullscreenClass(isFullScreen));

contextBridge.exposeInMainWorld('electron', {
  /** Show the OS folder picker. Returns the picked absolute path or
   *  null if the user cancelled. Accepts `defaultPath` and
   *  `allowCreateDirectory`. */
  openFolderDialog: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  /** Hand an http(s) URL to the OS default browser. Replaces an earlier
   *  in-app webview overlay; too many sites block iframing for it to
   *  be reliable, and the system browser already has user cookies. */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  /** Configure StashBase as an MCP server for one explicit client.
   *  This is only run from the user's MCP Settings click path; app
   *  launch and package install no longer modify client configs. */
  configureMcp: (client) => ipcRenderer.invoke('mcp:configure', client),
  disconnectMcp: (client) => ipcRenderer.invoke('mcp:disconnect', client),
  openFolderWindow: (name) => ipcRenderer.invoke('window:openFolder', name),
  /** Subscribe to "an image is on the clipboard, offer to import it"
   *  pushes fired when a main window regains focus. The renderer shows a
   *  confirm modal and, on accept, imports via the normal upload path. */
  onClipboardImage: (handler) => {
    const wrapped = (_event, payload) => {
      if (payload && typeof payload === 'object') handler(payload);
    };
    ipcRenderer.on('clipboard:image-available', wrapped);
    return () => ipcRenderer.removeListener('clipboard:image-available', wrapped);
  },
  /** Enable / disable clipboard-image watching (privacy toggle). */
  setClipboardWatch: (enabled) => ipcRenderer.invoke('clipboard:setWatch', enabled),
  /** Tell main an offered clipboard image was handled so it isn't
   *  re-offered on the next focus. */
  markClipboardHandled: (hash) => ipcRenderer.send('clipboard:markHandled', hash),
});
