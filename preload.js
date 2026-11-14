/* ============================================================================
   LUCKY DANGLE — desktop/preload.js
   ----------------------------------------------------------------------------
   The only bridge between the page and the native shell. The page gets three
   things and nothing else: a flag telling it that it is running on the
   desktop, a way to ask for mouse input, and a way to quit.
   ========================================================================== */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dangle", {
  isDesktop: true,

  // Called when the cursor moves over or away from the charm.
  setInteractive: function (interactive) {
    ipcRenderer.send("dangle:interactive", !!interactive);
  },

  quit: function () {
    ipcRenderer.send("dangle:quit");
  }
});
