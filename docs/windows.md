# Waffle EDA on Windows

Waffle EDA runs on Windows 10 (version 1903 or later) and Windows 11, on x64 and Arm64 PCs. The Windows host is a small C# program, about 1 MB. It shows the same editor as the macOS and Linux apps in **WebView2**, the Microsoft Edge engine that Windows keeps up to date. Waffle ships no browser engine and no runtime of its own: .NET Framework 4.8 and the WebView2 Runtime are part of current Windows.

## Install

**Zip (portable).** Extract the Windows portable ZIP listed in the [release notes](release-notes.md) anywhere you can write to, for example `%LOCALAPPDATA%\Programs\Waffle`, and run `Waffle.exe`. To open a project or document directly, pass the file to `Waffle.exe` or drag it onto the executable. Quote names with spaces, as in `Waffle.exe "Power board.wpcb"`.

For double-click from Explorer with the portable build, run `Register-WaffleDocumentTypes.ps1` from the extracted app folder. Then choose **Waffle EDA** under **Open with** as the default for each type you want to associate. The script adds Waffle as a choice for your Windows account. Run it with `-Unregister` before deleting this copy to remove its entries.

The build is not code-signed yet, so the first time you run it SmartScreen shows **Windows protected your PC**. Choose **More info → Run anyway**.

**Optional MSIX build.** The MSIX produced by the source build installs Waffle EDA in the Start menu and registers `.waffle`, `.wpcb`, `.wsch`, `.wlib`, `.wdraw`, and `.wpanel` for opening from Explorer. It is unsigned, so Windows 11 installs it only from an administrator PowerShell:

```powershell
Add-AppxPackage -AllowUnsigned .\Waffle-0.8.0.msix
```

**WebView2 Runtime.** It is preinstalled on Windows 11 and on Windows 10 with current updates. If Waffle says it is missing, install the *Evergreen WebView2 Runtime* from Microsoft, then start Waffle again.

**Uninstall.** Delete the folder, or remove the MSIX in **Settings → Apps**. Waffle keeps its own data in `%LOCALAPPDATA%\Waffle`: the recent-projects list, remembered library files, the window position and the WebView2 profile, which holds editor preferences and autosaves. Delete that folder too to remove everything.

## Keys

- `Mod` is **Ctrl** on Windows, as on Linux. Every shortcut in [shortcuts.md](shortcuts.md) that says `Mod` uses Ctrl.
- The browser shortcuts that would reload or zoom the page (F5, Ctrl+R, Ctrl+plus/minus) are turned off, so Ctrl+F, Ctrl+P, Ctrl+S and the other editor keys reach Waffle.
- **Ctrl+Shift+O** follows the active keymap. It opens Jump to Object with the Altium-style profile and Quick Open with Modern. When the editor has no matching shortcut, it opens the native Open Recent menu.
- **Ctrl+Shift+Pause** (or **Ctrl+Shift+F12**, for keyboards without a Pause key) pauses every extension, even while an extension dialog is open. Pressing **Esc three times** quickly does the same. macOS and Linux use Ctrl+Shift+Esc, but Windows reserves that for Task Manager.
- **F11** zooms in with the Allegro-like profile and toggles full screen when the editor has no matching shortcut.
- **Alt+Space** opens the window menu, which also offers Open Recent, Pause All Extensions and Full Screen.

The editor's menus are in the window itself, as on Linux. There is no separate Windows menu bar.

## What the Windows host does

The Windows host follows the macOS host action by action (`native/macos/main.swift`). The shared rules are in `native/windows/src/Core` and are tested on every platform.

- **Files.** Open and Save use the Windows file dialogs.
  - A native 2.0 save stages the changed project members together. Waffle can finish installing a committed save after a restart.
  - The save is refused if the file changed on disk since you opened it.
  - Two Waffle windows cannot save into the same folder at the same moment.
  - Exports accept only the listed manufacturing and exchange types.
  - An Altium copy can never overwrite its source.
- **Autosave.** While a project has unsaved changes, a `Design.waffle~` recovery file is kept beside it, readable only by you. The start page offers it after a crash.
- **Recent projects, library reloads.** The page can only reopen paths that you chose in a Windows dialog, and the host checks each path before using it. It refuses relative paths, `..`, device paths (`\\?\`, `\\.\`), alternate data streams and names such as `CON`. A file that has become a symbolic link or junction must be chosen again. OneDrive placeholder files still open.
- **Clipboard.** Copy writes a Waffle selection format plus plain text, as on macOS and Linux, so paste works between Waffle windows and on other platforms.
- **Printing** uses the Windows print preview.
- **Title bar.** Waffle draws its own title bar, as on macOS: the app bar is the title bar, with Minimize, Maximize and Close at the top right. Drag its blank space to move the window and snap it to a screen edge; double-click it to maximise or restore; right-click it, or press Alt+Space, for the window menu (Open Recent, Pause All Extensions and Full Screen are there too). The top edge resizes the window, as do the other edges and corners. The window and its controls work while a dialog is open. Snap layouts appear from Win+Z; hovering Maximize does not show them.
- **Theme.** The title bar and the editor follow the Windows light or dark app mode, and update when you switch it.
- **Window.** Size, position and maximised state are remembered per monitor layout. If the remembered position is on a monitor that is no longer connected, the window is centred on the main screen. The host is per-monitor DPI aware (v2), so it stays sharp when moved between screens with different scaling.
- **Compare revisions** runs `native\git_head.py` with Python 3 (the `py` launcher or `python.exe` on `PATH`, never the Microsoft Store alias) and Git. Without them, revision review explains what to install. Nothing else needs Python.

## Security

The Windows host matches the macOS and Linux hosts.

- **Pages.** The window only ever shows the editor page. It is served from the app folder as `https://app.waffle.example/index.html`, a WebView2 virtual host that never reaches the network. Subframes may load only `about:srcdoc` (the extension sandbox) and `about:blank` (print). Any other navigation is cancelled, and so are:
  - new windows;
  - downloads;
  - external protocol links;
  - permission requests (camera, microphone, location, notifications, clipboard reading);
  - screen capture;
  - sign-in prompts.
- **The bridge.** The page talks to the host only through `chrome.webview` messages, and only from the top-level editor page. No host objects are injected.
- **Browser features.** Release builds have no developer tools. The default context menu is reduced to the editing commands inside text fields. Autofill and password saving are off. SmartScreen URL checks, background networking, hyperlink pings, crash-report uploads and browser extensions are off.
- **Network.** Waffle itself makes no network requests. The only ones are the opt-in features listed in the README's privacy section. The WebView2 Runtime is updated by Windows Update, not by Waffle.
- **Other apps.** Waffle writes only inside `%LOCALAPPDATA%\Waffle`, to the files you save or export, and to `.waffle~` recovery files. It never edits another program's settings. The MCP setup card shows text for you to paste. Opening or saving a project also adds it to Explorer's Recent list, as other Windows apps do.

## Build from source

You need the .NET SDK 8 or later. On Windows:

```powershell
scripts\build-windows.ps1            # unit tests, then dist\Waffle-windows\ and dist\Waffle-<version>-windows.zip
scripts\build-windows.ps1 -Msix      # also dist\Waffle-<version>.msix (needs makeappx.exe from the Windows SDK)
```

On macOS or Linux, `scripts/build-windows.sh` builds the same zip. The host targets .NET Framework 4.8, and its reference assemblies come from NuGet, so the build needs no Windows machine. It can't run the app, though.

**Code signing** is ready but not used yet. `scripts\build-windows.ps1 -CertificateThumbprint <sha1>` signs `Waffle.exe` before zipping, and signs the MSIX after packing, with `signtool` and an RFC 3161 timestamp. Before you sign an MSIX, set `Publisher` in `native\windows\packaging\AppxManifest.xml` to the certificate's subject.

## What still needs a Windows PC

### Preview smoke test

Use the portable preview zip on a Windows 10 or 11 desktop. Record the package SHA-256, Windows build, CPU architecture, WebView2 Runtime version and display scaling. Use a temporary local folder and a new test project throughout.

1. Launch the executable and wait for the start page. Create a blank project, place two wires on its schematic, and save it as `Smoke.waffle`. Close the window. Launch again and choose **File › Open**. Confirm the native file chooser loads `Smoke.waffle` and both wires display.
2. Delete the first wire and press **Ctrl+S**. Close and reopen the project. Verify only the second wire remains and record the project's SHA-256 with `Get-FileHash -Algorithm SHA256 .\Smoke.waffle`.
3. Delete the remaining wire and use the window's close button. Choose **Cancel**. Verify the window remains open with the deletion still visible and the file hash unchanged. Close the window again, choose **Don't Save**, then reopen the file. Verify the saved wire returns and the file hash is unchanged. If offered a recovery draft, open the saved file for this check.
4. Delete the wire again. Use the window's close button and choose **Save**. Wait for the window to close, then reopen and verify the saved project has no wires and its file hash changed. Repeat on an untitled project and cancel the native Save As picker. The unsaved project must stay open.
5. Choose **Share**. Verify the Windows note explains that local-network hosting and discovery are unavailable. With a separate Waffle host sharing a synthetic design on a test network, enter its address and session code under **Join a session**, or paste a private invitation to a test relay. Verify the guest receives the project and sees one host edit. Choose **Leave Session** and verify the guest disconnects.
6. In **Preferences › External Tools**, choose a known local ngspice executable. Open **Design › Simulate › Mixed Sim** with a synthetic voltage-source and equal-resistor divider bench. Select the ngspice engine and run an operating-point analysis. Cancel the first command approval and check that no run result appears. Repeat and approve after checking the displayed executable and arguments. A 5 V source with two 1 kΩ resistors should read about 2.5 V at the midpoint. Run the same bench again and verify the approved command completes.

### Additional desktop checks

The host compiles and its shared rules pass their tests. These need a person on real Windows (x64 and Arm64, at 100% and 150–200% scaling, light and dark mode):

1. **Start-up.** Waffle starts, the editor loads with no errors, and a project passed on the command line opens. Measure the cold start.
2. **Files.**
   - Open, Save, Save As and Export, including over an existing file.
   - A project changed by another program is refused on save.
   - OneDrive folders and a mapped network drive both work.
3. **Recent projects.** Alt+Space › Open Recent and the start page's recent list. Verify that Ctrl+Shift+O runs the assigned editor command, or opens Open Recent when unassigned.
4. **Autosave.** The recovery file appears while editing and is offered after killing `Waffle.exe` in Task Manager.
5. **Clipboard.** Copy and paste between two Waffle windows, and paste into Notepad.
6. **Keys and menus.**
   - Ctrl+S, Ctrl+F, Ctrl+P, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and Ctrl+Shift+P reach the editor.
   - F5 and Ctrl+R do not reload the page.
   - Ctrl+Shift+Pause pauses extensions.
   - F11 zooms in with Allegro-like. Switch to the Altium-style profile and verify that F11 toggles full screen.
7. **Navigation policy.** With a debug build, check from DevTools that `location.href = "https://example.com"`, `window.open()`, an `<a target=_blank>` link and an iframe pointing at a web page are all blocked. The extension sandbox still runs an extension.
8. **Printing.** Print a schematic: the preview shows the sheets, not the editor.
9. **Theme and DPI.** Switching dark mode updates the title bar and the editor. Moving the window between monitors with different scaling keeps it sharp. Dialogs are scaled correctly.
10. **Title bar.** There is one bar at the top, Waffle's app bar, and no system caption above it.
    - Dragging the blank space moves the window; dragging to a screen edge snaps it; dragging a maximised window restores it. Double-clicking maximises and restores. Right-clicking and Alt+Space open the window menu, with Restore, Move, Size, Minimize and Maximize enabled to match the window's state.
    - Minimize, Maximize (Restore while maximised) and Close work; Close asks to save unsaved changes. Close turns red on hover. An inactive window dims the controls.
    - The top edge and both top corners resize the window; the other edges and corners resize as before. A maximised window shows the whole app bar and its bottom edge reaches the taskbar, including an auto-hiding taskbar on any screen edge.
    - With the Start Page or another dialog open, the window still moves, minimises and closes from its caption, and the dialog stays open.
    - F11 full screen hides the controls; leaving it brings them back. A detached project window has the same title bar.
11. **Window state.** Position and size are remembered. Unplug the second monitor and the window comes back on screen.
12. **MSIX.** It installs with `-AllowUnsigned`, double-clicking a `.waffle` file opens it, and it uninstalls cleanly.
13. **Revision review.** Works with Python and Git installed. Without them, it shows a clear message.
