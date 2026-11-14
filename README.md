# Lucky Dangle

A charm on a rope, hung from the top edge of the screen. The rope is a Verlet
particle chain simulated in plain JavaScript — no libraries, no build step.

## Files

    index.html         markup
    style.css          styling, plus the CSS fallback charm
    script.js          physics, rendering, input, UI
    assets/            character.png goes here (see assets/README.txt)

    main.js            Electron shell: the desktop version
    preload.js         the page's only bridge to the shell
    package.json       Electron dependency + scripts
    start-desktop.bat  double-click launcher for Windows

## Run it in a browser

Double-click `index.html`. Nothing to install.

## Run it on your desktop

1. Install Node.js (LTS) from nodejs.org, then reopen your terminal.
2. Double-click `start-desktop.bat`.
   It installs Electron on first run — about a minute and ~200 MB — and then
   starts the charm every time after that.

Manual equivalent, from this folder:

    npm install
    npm start

The charm hangs from the top of your primary monitor. The window is
click-through, so your desktop, icons and other apps work normally; it only
takes the mouse while the cursor is over the charm itself.

- Drag the charm to pull it.
- Double-click it for a hard swing.
- Right-click the charm to quit.
- The tray icon has Quit and "Reposition on primary screen".

The control panel and page text are hidden on the desktop. Adjust the physics
in the `CONFIG` object at the top of `script.js` instead, and the drop height
with `WINDOW_HEIGHT` in `main.js`.

## Make a standalone .exe (optional)

    npm install --save-dev electron-packager
    npm run build

The result lands in `dist/LuckyDangle-win32-x64/`. To start it with Windows,
press Win+R, run `shell:startup`, and put a shortcut to `LuckyDangle.exe`
in the folder that opens.
# Dangle7
