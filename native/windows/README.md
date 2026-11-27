# Windows host

This folder holds the Windows host: a WinForms window, a WebView2 controller and the bridge protocol from `native/bridge.js`. It targets .NET Framework 4.8. User documentation is in [docs/windows.md](../../docs/windows.md).

Packaging from source requires Python 3 and the pinned Rust toolchain with the WASM target. See the [source preparation instructions](../../README.md).

## Why this stack

The project aims to be lighter than every competitor, and the host is about 1 MB. It ships no runtime and no browser engine.

| Option | What ships | Cold start (host part) | Upkeep | Builds in CI |
| --- | --- | --- | --- | --- |
| **C# on .NET Framework 4.8 (chosen)** | `Waffle.exe` 116 KB, `Microsoft.Web.WebView2.Core.dll` 636 KB, `WebView2Loader.dll` 156 KB (x64) + 148 KB (arm64): **about 1.06 MB** | Windows already has the CLR and WinForms native images, so about 0.1–0.2 s to the first window | Memory-safe; easy to read; the official WebView2 .NET API | `dotnet build` on Windows, macOS or Linux |
| C# on .NET 8, self-contained | 60–150 MB, or a separate 55 MB runtime install | Similar or slower | As above | Yes |
| C++ Win32 with the WebView2 SDK | About 0.3–0.5 MB | Fastest | COM by hand; file and path code in C++ | Needs MSVC, or mingw plus SDK headers |
| Rust with wry / webview2-com | 3–6 MB | Fast | Good, but a second language in the repo | Needs cargo-xwin (downloads the MSVC CRT/SDK) or mingw |
| Electron, Tauri bundle | 80–150 MB / 5–10 MB | Slow / fast | — | — |

.NET Framework 4.8 is part of Windows 10 1903+ and Windows 11. The WebView2 Runtime is preinstalled on Windows 11 and serviced on Windows 10. Either way, the browser process starts in about 0.3–0.7 s, and that dominates the cold start whichever stack hosts it. Expect about 0.5–1 s from launch to the editor; this has not been measured on hardware yet.

The host uses `CoreWebView2Controller` directly. It does not use the WebView2 WinForms control, so `Microsoft.Web.WebView2.WinForms.dll` is not shipped. It has no JSON or other third-party libraries: `src/Core/Json.cs` is about 250 lines.

## Layout

```
Waffle.Windows.csproj   net48 WinExe; WafflePackage target stages and zips dist/
app.manifest            per-monitor v2 DPI, long paths, Windows 10/11, common controls 6
App.config              .NET 4.8, WinForms PerMonitorV2, no legacy path handling
../../brand/windows/waffle.ico  Stack artwork embedded in Waffle.exe
build.ps1               runs scripts/build-windows.ps1
src/Core/               platform-independent, shared with the tests
  Policy.cs             navigation policy, accepted file types, Windows path rules (WinPath)
  Host.cs               the bridge protocol, action by action, as in native/macos/main.swift
  LanRelay.cs           same-network sessions: the relay protocol in lan mode on TcpListener, which adapters count
  HostFiles.cs          Native file handles, Altium source copies, recent projects and library reads
  FolderProject.cs      Durable format-2 folder transaction and staged assets
  WindowState.cs        remembered window frame and the off-screen rules
  Json.cs               a small JSON reader and writer
src/Win/                Windows only
  Program.cs            entry point: Waffle.exe [Design.waffle]
  MainWindow.cs         window, WebView2 settings and events, accelerators, system menu, own title bar, theme, IHostUi
  WinFs.cs              IHostFs on Win32: GetFinalPathNameByHandle, reparse tags, MoveFileEx, owner-only ACLs, named mutex
  GitRunner.cs          python -I -B native/git_head.py (py launcher; skips the Store alias)
  Dialogs.cs            alert / confirm / prompt and the close confirmation
  DnsSdDiscovery.cs     _waffle._tcp announcements and searches with dnsapi (Windows 10 1903+)
  Native.cs             P/Invoke declarations
window-caption.js       Waffle's title bar in the page: window controls, moving, resizing (staged beside bridge.js)
packaging/              AppxManifest.xml and logo assets for the MSIX
tests/                  net8.0 console tests for src/Core (PortableFs stands in for WinFs); FolderWorker.cs
                        also holds the --folder-worker mode that native/tests/project_journal.py drives
```

## Build and test

```sh
dotnet run --project native/windows/tests -c Release                    # shared-core tests, any OS
DOTNET=/path/to/dotnet python3 native/tests/project_journal.py          # format-2 cross-replay and stale writes with the Windows core
dotnet build native/windows/Waffle.Windows.csproj -c Release -t:WafflePackage   # dist/Waffle-<version>-windows.zip
scripts/build-windows.sh                                                # both, from macOS or Linux
```

On Windows, `scripts\build-windows.ps1 [-Msix] [-CertificateThumbprint <sha1>]` runs the same steps. It can also pack an MSIX (`makeappx.exe` from the Windows SDK) and sign it (`signtool.exe`).

The bridge's WebView2 branch has a JavaScript test, `native/tests/bridge-webview2.cjs`, beside the existing `bridge.cjs`. Both need Node, or the JSC shim with `File` and `vm.runInNewContext` polyfills.

## Rules to keep in step with macOS and Linux

- **Navigation.**
  - The main frame shows only `Policy.PageUri`.
  - Subframes may load only `about:srcdoc` and `about:blank`.
  - New windows, downloads, external URI schemes, permissions, screen capture and basic-auth prompts are refused.
- **Bridge messages.** They are accepted only from `Policy.PageUri` (`WebMessageReceived.Source`), and `bridge.js` installs `AtriumHost` only in the top-level document.
- **Title bar.** `WM_NCCALCSIZE` removes the system caption and keeps Windows' resizing frame on the other edges; `window-caption.js` draws the caption in the page. WebView2 covers the client area, so the page sends `windowCaption` messages (`drag`, `resize` with an edge, `minimize`, `maximize`, `close`, `menu`) and the host starts Windows' own move or size loop from the press. Without `window-caption.js` beside `bridge.js`, the window keeps the system title bar. `scripts/ci/windows-title-bar.ps1` checks it in the packaged app on the runner's desktop with real mouse input (`.github/workflows/windows-title-bar.yml`, on a push to a `windows-test/` branch).
- **Paths.** Page-supplied paths pass `WinPath.Acceptable` and are then canonicalised. They must match a list that only native dialogs or the host's own menus add to.
- **Format 2 folder saves.** Opening a folder or its manifest grants access to that project. The Windows host uses the shared transaction descriptor, a stable range lock, saved read leases and write-through replacement. The persistent `--folder-mcp` entry point uses the same coordinator. [Durable folder format](../../docs/format-2.md)
- **File Open.** File Open, recent projects and drops recognize a folder manifest or a supported source design. A pre-release project displays the re-import message before opening any journal or recovery draft.
- **Private files.** The host protects its preferences, library grants and saved editor state with owner-only permissions.
- **Links.** A name-surrogate reparse point (a symlink or junction) at the final component is refused when reading. Cloud-file placeholders are not name surrogates, so they open normally.

## Code signing slots

Signing is not used yet. `scripts/build-windows.ps1` signs `Waffle.exe` (before zipping) and the `.msix` when it is given `-CertificateThumbprint`; `-TimestampUrl` defaults to DigiCert's RFC 3161 server. Before you sign an MSIX, change `Publisher` in `packaging/AppxManifest.xml` to the certificate subject. Until then, the Publisher carries the "unsigned package" OID that `Add-AppxPackage -AllowUnsigned` requires.
