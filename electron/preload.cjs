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
   *  `allowCreateDirectory`; import-folder passes false so the dialog
   *  only selects existing directories. */
  openFolderDialog: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  /** Hand an http(s) URL to the OS default browser. Replaces an earlier
   *  in-app webview overlay; too many sites block iframing for it to
   *  be reliable, and the system browser already has user cookies. */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  /** Configure StashBase as an MCP server for one explicit client.
   *  This is only run from the user's MCP Settings click path; app
   *  launch and package install no longer modify client configs. */
  configureMcp: (client) => ipcRenderer.invoke('mcp:configure', client),
  openSpaceWindow: (name) => ipcRenderer.invoke('window:openSpace', name),
  listCaptureWindows: () => ipcRenderer.invoke('capture:listWindows'),
  getCaptureSettings: () => ipcRenderer.invoke('capture:getSettings'),
  primeScreenRecordingPermission: async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return { ok: false, error: 'Screen capture is not available in this renderer.' };
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && typeof err.message === 'string' ? err.message : String(err) };
    } finally {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
    }
  },
  openScreenPermissionSettings: () => ipcRenderer.invoke('capture:openScreenPermissionSettings'),
  onCaptureCreated: (handler) => {
    const wrapped = (_event, capture) => {
      if (capture && typeof capture === 'object') handler(capture);
    };
    ipcRenderer.on('capture:created', wrapped);
    return () => ipcRenderer.removeListener('capture:created', wrapped);
  },
  onCaptureError: (handler) => {
    const wrapped = (_event, error) => {
      if (typeof error === 'string' && error) handler({ kind: 'capture-failed', message: error, detail: error });
      else if (error && typeof error === 'object') handler(error);
    };
    ipcRenderer.on('capture:error', wrapped);
    return () => ipcRenderer.removeListener('capture:error', wrapped);
  },
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
  /** Rail "record" button: start recording (raises the source picker). */
  startRecording: () => ipcRenderer.send('capture:startRecording'),
  /** Picker hands the chosen window id over to start recording it. */
  recordWindow: (sourceId) => ipcRenderer.invoke('recorder:recordWindow', sourceId),
  /** Stop an in-progress screen recording (the rail button toggles to a
   *  stop control while recording). */
  stopRecording: () => ipcRenderer.send('capture:stopRecording'),
  /** Rail record button subscribes to recording-state pushes so it can
   *  swap the record icon for a red stop square. */
  onRecordingState: (handler) => {
    const wrapped = (_event, recording) => handler(Boolean(recording));
    ipcRenderer.on('recording:state', wrapped);
    return () => ipcRenderer.removeListener('recording:state', wrapped);
  },
  // --- Recorder window only (electron/recorder.html) ------------------
  /** Main hands the recorder window a desktop source id to start on. */
  onRecorderStart: (handler) => {
    const wrapped = (_event, sourceId) => handler(sourceId);
    ipcRenderer.on('recorder:start', wrapped);
    return () => ipcRenderer.removeListener('recorder:start', wrapped);
  },
  /** Main asks the recorder window to stop and package the clip. */
  onRecorderStop: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on('recorder:stop', wrapped);
    return () => ipcRenderer.removeListener('recorder:stop', wrapped);
  },
  /** Recorder window (macOS 15+): a source was picked, recording began. */
  recorderStarted: () => ipcRenderer.send('recorder:started'),
  /** Recorder window (macOS 15+): the user dismissed the system picker. */
  recorderCanceled: () => ipcRenderer.send('recorder:canceled'),
  /** Recorder window reports the capture target (screen vs window + pixel
   *  size) so main can label the floating indicator with which display is
   *  being recorded. */
  recorderMeta: (meta) => ipcRenderer.send('recorder:meta', meta),
  /** Recorder window hands the finished clip (data URL) back to main. */
  recorderResult: (payload) => ipcRenderer.send('recorder:result', payload),
  /** Recorder window reports a getUserMedia / getDisplayMedia / MediaRecorder failure. */
  recorderError: (message) => ipcRenderer.send('recorder:error', message),
  /** Recording-indicator pill reports its measured content width so main can
   *  shrink the window to fit (no truncated label, no oversized click-catcher). */
  setIndicatorSize: (size) => ipcRenderer.send('recording:indicator-size', size),
  /** Recording-indicator pill subscribes to which-display-am-I-recording
   *  label updates (e.g. "right screen", "a window"). */
  onRecordingLabel: (handler) => {
    const wrapped = (_event, label) => handler(typeof label === 'string' ? label : '');
    ipcRenderer.on('recording:label', wrapped);
    return () => ipcRenderer.removeListener('recording:label', wrapped);
  },
});
