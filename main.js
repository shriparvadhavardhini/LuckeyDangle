/* ============================================================================
   LUCKY DANGLE — desktop/main.js
   ----------------------------------------------------------------------------
   The native shell. It creates one transparent, frameless, always-on-top
   window stretched across the top of your primary monitor and loads the very
   same index.html you open in a browser.

   The window is click-through by default, so it never blocks icons, windows
   or the taskbar underneath. The page asks for mouse input only while the
   cursor is actually over the charm (see the DESKTOP SHELL BRIDGE section in
   script.js), and gives it straight back afterwards.
   ========================================================================== */

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require("electron");
const path = require("path");

const WINDOW_HEIGHT = 560;   // how far down the charm is allowed to swing

let win = null;
let tray = null;

function createWindow() {
  // workArea excludes the taskbar, so the charm hangs from the top of the
  // usable desktop rather than underneath a bar.
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: Math.min(WINDOW_HEIGHT, area.height),

    transparent: true,     // only the charm and rope are painted
    frame: false,          // no title bar
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,     // it is an ornament, not an app window
    focusable: false,      // never steals focus from what you are working in
    alwaysOnTop: true,
    fullscreenable: false,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false   // keep the swing smooth when unfocused
    }
  });

  // "screen-saver" is the highest ordinary level: it stays above normal
  // windows but still below UAC prompts.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // Start fully click-through. `forward: true` still delivers mouse-move
  // events to the page, which is how it knows the cursor is near the charm.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "index.html"));

  win.on("closed", function () { win = null; });
}

/* ---- Tray icon: the only visible way to quit ---------------------------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Lucky Dangle");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Reposition on primary screen",
      click: function () {
        if (!win) return;
        const area = screen.getPrimaryDisplay().workArea;
        win.setBounds({
          x: area.x, y: area.y,
          width: area.width,
          height: Math.min(WINDOW_HEIGHT, area.height)
        });
      }
    },
    { type: "separator" },
    { label: "Quit Lucky Dangle", click: function () { app.quit(); } }
  ]));
}

/* ---- Messages from the page -------------------------------------------- */

// true  = cursor is over the charm, so the window should accept clicks
// false = give the mouse back to whatever is underneath
ipcMain.on("dangle:interactive", function (_event, interactive) {
  if (win) win.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on("dangle:quit", function () { app.quit(); });

/* ---- Lifecycle ---------------------------------------------------------- */

app.whenReady().then(function () {
  createWindow();
  createTray();

  // If the screen resolution or taskbar changes, follow it.
  screen.on("display-metrics-changed", function () {
    if (!win) return;
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: area.x, y: area.y,
      width: area.width,
      height: Math.min(WINDOW_HEIGHT, area.height)
    });
  });
});

// Closing the window should not leave a stray process behind.
app.on("window-all-closed", function () { app.quit(); });
