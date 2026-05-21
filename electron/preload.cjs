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

contextBridge.exposeInMainWorld('electron', {
  /** Show the OS folder picker. Returns the picked absolute path or
   *  null if the user cancelled. The dialog has the OS-native "New
   *  Folder" affordance built in. */
  openFolderDialog: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  /** Hand an http(s) URL to the OS default browser. Replaces an earlier
   *  in-app webview overlay; too many sites block iframing for it to
   *  be reliable, and the system browser already has user cookies. */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  /** Configure StashBase as an MCP server for one explicit client.
   *  This is only run from the user's MCP Settings click path; app
   *  launch and package install no longer modify client configs. */
  configureMcp: (client) => ipcRenderer.invoke('mcp:configure', client),
  /** Subscribe to fullscreen-state pushes. macOS green-button fullscreen
   *  hides traffic lights; the renderer uses this to toggle the body
   *  class that controls the chrome-strip left padding. */
  onFullscreenChange: (handler) => {
    const wrapped = (_event, isFullScreen) => {
      if (typeof isFullScreen === 'boolean') handler(isFullScreen);
    };
    ipcRenderer.on('fullscreen-change', wrapped);
    return () => ipcRenderer.removeListener('fullscreen-change', wrapped);
  },
});
