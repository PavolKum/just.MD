# Install just.MD on this PC - instructions for the AI agent

You are an AI coding agent (Claude Code or similar). The user copied this folder to their PC and asked
you to install just.MD. Follow these steps in order. Keep your messages to the user short and plain.

## What this is

A markdown viewer and editor that runs as an installed browser app (Microsoft Edge or Google Chrome).
Plain static files in `app\`, plus `serve.ps1`, a tiny PowerShell web server that serves them on
`http://localhost:8765/` (this PC only). No Python, no admin rights, no internet needed. Files the
user opens never leave the PC.

## Step 0 - Edge or Chrome?

Ask the user one question: "Which browser do you use day to day: Edge or Chrome?"
If they do not mind, use Edge (it is on every Windows PC). Use that browser for every step below.
The browser exe is `msedge` (Edge) or `chrome` (Chrome).

## Requirements (check first, stop and tell the user if one fails)

1. Windows 10 or 11 with the chosen browser installed. Edge:
   `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Chrome:
   `C:\Program Files\Google\Chrome\Application\chrome.exe` or
   `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`.
2. PowerShell can run a script with `-ExecutionPolicy Bypass` for one process (the normal case on
   corporate machines; no policy change needed).
3. Port 8765 free on localhost (`Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue`
   returns nothing). If it is taken, use 8775 everywhere below instead and tell the user.

## Steps

1. **Copy to a permanent place.** Copy this whole folder to `%LOCALAPPDATA%\just.MD`
   (not OneDrive, not Downloads: the installed app is tied to this location staying put).
2. **Start the server** (hidden window):
   `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"$env:LOCALAPPDATA\just.MD\serve.ps1" -WindowStyle Hidden`
   Check: `Invoke-WebRequest http://localhost:8765/ -UseBasicParsing` returns 200.
3. **Start the server at every login**, so the app always loads and picks up future updates. Create a
   shortcut in the Startup folder (`[Environment]::GetFolderPath('Startup')`) named
   `just.MD server.lnk`, target `powershell.exe`, arguments
   `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\just.MD\serve.ps1"`,
   window style minimised (7). Use `WScript.Shell` `CreateShortcut`.
4. **Open it in the chosen browser:** `Start-Process msedge 'http://localhost:8765/'` or
   `Start-Process chrome 'http://localhost:8765/'`.
5. **Hand over to the user** (they must click; an agent cannot install the app or set a default app
   on Windows 11). Give them the steps for their browser as a short numbered list, one step at a
   time, and wait for them to confirm each before the next.

   **Edge**
   1. "In the address bar, click the 'App available' icon (or `...` > Apps > Install this site as an
      app), then click **Install**."
   2. "Edge shows an 'App installed' box with options. **Tick all of them**: Pin to taskbar, Pin to
      Start, Create desktop shortcut, Auto-start on device login. Then click Allow."
   3. "If Edge asks whether just.MD may open markdown files, choose **Allow**."

   **Chrome**
   1. "In the address bar, click the install icon (a small screen with a down arrow, on the right),
      or the three-dot menu > Cast, save and share > Install page as app. Click **Install**."
   2. "The app opens in its own window. Right-click its icon in the taskbar > **Pin to taskbar**."
   3. "Optional, to start it at login: open `chrome://apps` in Chrome, right-click just.MD >
      **Start app when you sign in**." (Menu wording varies by Chrome version; skip if absent.)
   4. "If Chrome asks whether just.MD may open markdown files, choose **Allow** (tick 'Remember')."

   **Both browsers, then:**
   - "Right-click any `.md` file > **Open with** > **Choose another app** > pick **just.MD** > click
     **Always**." (If just.MD is not in the list, open the app once from the Start menu, close it,
     and try again.)
   - "The first time you save a file, choose **Allow on every visit** if the browser offers it."
6. **Verify with the user:** they double-click a `.md` file; it opens in the just.MD window.

## Updates later

Replace the contents of `%LOCALAPPDATA%\just.MD\app\` with the new `app\` folder. The app picks it
up on its next launch (sometimes the second launch, because it caches itself to work offline).

## Uninstall

In the app window: the browser's menu (top right) > App settings / App info > Uninstall. Delete the
Startup shortcut and the `%LOCALAPPDATA%\just.MD` folder. Stop the server:
`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object CommandLine -like '*just.MD\serve.ps1*' | ForEach-Object { Stop-Process -Id $_.ProcessId }`

## If something fails

- Install icon never appears: a browser policy may block web app installs. The app still works in a
  normal tab at `http://localhost:8765/` (Ctrl+O to open, Ctrl+S saves in place), just no double-click.
- `serve.ps1` says the port is busy: pick another port (`-Port 8775`) in steps 2-4. Keep it fixed
  afterwards; the installed app is tied to the exact address.
- Script blocked outright: ask the user to contact IT; do not change the machine's execution policy.
