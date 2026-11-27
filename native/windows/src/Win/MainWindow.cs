// The Waffle window: a WinForms Form hosting a WebView2 controller directly (no WebView2
// WinForms control), with the same navigation policy, bridge and file rules as the macOS host.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Com = System.Runtime.InteropServices.ComTypes;

namespace Waffle.Windows
{
    sealed class MainWindow : Form, IHostUi, IExternalUi, IFolderUi, IFolderStartUi, INotebookClipboard, IImportSaveUi, INativeDocumentClipboard, IAICredentialUi
    {
        const int MenuOpenRecent = 0x1A10, MenuPause = 0x1A20, MenuFullScreen = 0x1A30;
        const int VK_CANCEL = 0x03, VK_PAUSE = 0x13, VK_F11 = 0x7A, VK_F12 = 0x7B, VK_O = 0x4F;

        readonly string root;
        readonly string support;
        readonly bool openingAtStartup;
        readonly Action<IList<string>> openProjectWindow;
        readonly bool qualification;
        readonly TranslatorFiles translators;
        readonly WinFs fs = new WinFs();
        readonly Host host;
        readonly Timer launchFallback = new Timer { Interval = 2000 };
        CoreWebView2Controller controller;
        CoreWebView2 core;
        bool dark;
        bool showingProcessFailure;
        bool launchFailed;
        bool fullScreen;
        bool active = true;
        // Waffle draws its own title bar (window-caption.js): the system caption is removed and the page's
        // app bar takes its place. Without the script the window keeps the system title bar.
        readonly string captionScript;
        string lastCaptionState;
        FormBorderStyle savedBorder;
        FormWindowState savedState;
        Rectangle savedBounds;

        string startupLink;
        WorkspaceWindows workspace;
        Func<WorkspaceWindows,string,string,MainWindow> spawnWorkspace;
        bool OpeningDetached => workspace != null && !workspace.IsWriter(this);
        internal string WorkspaceId { get; private set; } = Guid.NewGuid().ToString("D");
        internal string WorkspaceTab { get; set; }

        internal void ConfigureWorkspace(Func<WorkspaceWindows,string,string,MainWindow> spawn, WorkspaceWindows group, string id, string tab)
        {
            spawnWorkspace = spawn;
            if (group != null) { workspace = group; WorkspaceId = id; WorkspaceTab = tab; group.Register(this); }
            host.WorkspaceMessage = (request,reply) =>
            {
                if (workspace == null || workspace.IsWriter(this) && !workspace.IsCurrent)
                {
                    if (!request.TryGetValue("operation",out var op) || op as string != "describe" ||
                        !request.TryGetValue("project",out var project) || !request.TryGetValue("grant",out var grant) ||
                        !HasWorkspaceFolder(project as string,grant as string))
                        throw new HostError("Open a native Waffle project to manage its windows.");
                    if (workspace?.AdoptLease(project as string,grant as string) != true) {
                        workspace?.RetirePeers();
                        workspace = new WorkspaceWindows(this,project as string,grant as string,spawnWorkspace);
                    }
                }
                workspace.Receive(this,request,reply);
            };
        }

        internal bool HasWorkspaceFolder(string project, string grant) => host.IsWorkspaceFolder(project,grant);
        internal string WorkspacePath => host.DesignPath;
        internal void PostWorkspace(Dictionary<string,object> data) => Post(Json.Write(new Dictionary<string,object> {
            ["type"]="workspaceWindow", ["event"]=data }));
        internal void WorkspaceBounds(Dictionary<string,object> data)
        {
            if (data == null) return;
            int? Number(string key) => data.TryGetValue(key,out var raw) && raw is double value && value >= Int32.MinValue && value <= Int32.MaxValue ? (int?)value : null;
            var x = Number("left"); var y = Number("top"); var w = Number("width"); var h = Number("height");
            if (!x.HasValue || !y.HasValue || !(w > 0) || !(h > 0)) return;
            var candidate = new Rectangle(x.Value,y.Value,w.Value,h.Value);
            foreach (var screen in Screen.AllScreens) if (screen.WorkingArea.IntersectsWith(candidate)) { Bounds = candidate; break; }
        }
        internal Dictionary<string,object> CaptureWorkspaceBounds() => new Dictionary<string,object> {
            ["display"]=Screen.FromControl(this).DeviceName, ["left"]=Bounds.Left, ["top"]=Bounds.Top,
            ["width"]=Bounds.Width, ["height"]=Bounds.Height };

        public MainWindow(string root, string support, IList<string> startup, Action<IList<string>> openProjectWindow, TranslatorFiles translators, RecentProjects recent, string startupLink = null, bool qualification = false)
        {
            this.root = root;
            this.support = support;
            this.openProjectWindow = openProjectWindow;
            this.translators = translators;
            this.startupLink = startupLink;
            this.qualification = qualification;
            openingAtStartup = startup.Count > 0;
            host = new Host(fs, this, new GitRunner(root), support, translators, recent, supportArchitecture: Native.SupportArchitecture);
            host.ExternalUi = this;
            host.Lan = new LanRelay(new DnsSdDiscovery(), () => LanNetworks.Inventory(Native.HardwareInterface));
            try { captionScript = File.ReadAllText(Path.Combine(root, "window-caption.js"), Encoding.UTF8); } catch (Exception) { captionScript = null; }
            Text = "Waffle";
            Opacity = 0;
            launchFallback.Tick += (sender, e) => {
                if (OpeningDetached) FailWorkspaceLaunch();
                else Reveal();
            };
            AutoScaleMode = AutoScaleMode.None;
            KeyPreview = false;
            AllowDrop = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            StartPosition = FormStartPosition.Manual;
            double scale = DeviceDpi / 96.0;
            MinimumSize = new Size((int)(770 * scale), (int)(500 * scale));
            RestoreFrame(scale);
            ApplyTheme();
            if (openingAtStartup) host.OpenAtStartup(startup);
            DpiChanged += (s, e) => { double k = e.DeviceDpiNew / 96.0; MinimumSize = new Size((int)(770 * k), (int)(500 * k)); };
        }

        // ------------------------------------------------------------------ window frame

        string FramePath => Path.Combine(support, "window.json");

        void RestoreFrame(double scale)
        {
            WindowFrame saved = null;
            try { saved = WindowFrame.Parse(Encoding.UTF8.GetString(fs.ReadRegular(FramePath, 4096).Bytes)); } catch (Exception) { }
            var areas = new List<Rect>();
            foreach (var screen in Screen.AllScreens) areas.Add(ToRect(screen.WorkingArea));
            var bounds = WindowFrame.Restore(saved, areas, ToRect(Screen.PrimaryScreen.WorkingArea), scale, MinimumSize.Width, MinimumSize.Height);
            Bounds = new Rectangle(bounds.X, bounds.Y, bounds.Width, bounds.Height);
            if (saved != null && saved.Maximized) WindowState = FormWindowState.Maximized;
        }

        static Rect ToRect(Rectangle r) => new Rect(r.X, r.Y, r.Width, r.Height);

        void StoreFrame()
        {
            var r = fullScreen ? savedBounds : (WindowState == FormWindowState.Normal ? Bounds : RestoreBounds);
            var frame = new WindowFrame { Bounds = ToRect(r), Maximized = fullScreen ? savedState == FormWindowState.Maximized : WindowState == FormWindowState.Maximized };
            try { fs.EnsurePrivateFolder(support); fs.AtomicWrite(FramePath, Encoding.UTF8.GetBytes(frame.Serialize()), true); } catch (Exception) { }
        }

        // ------------------------------------------------------------------ theme

        static bool SystemDark()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
            }
            catch (Exception) { return false; }
        }

        static string SystemAccent() => Native.DwmGetColorizationColor(out var color, out _) == 0
            ? "#" + (color & 0xffffff).ToString("x6") : null;

        void ApplyTheme()
        {
            dark = SystemDark();
            var background = dark ? Color.FromArgb(0x1e, 0x1e, 0x1e) : Color.White;
            BackColor = background;
            if (IsHandleCreated)
            {
                int on = dark ? 1 : 0;
                Native.DwmSetWindowAttribute(Handle, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
            }
            if (controller != null) controller.DefaultBackgroundColor = background;
            if (core != null && Policy.AllowMainFrame(core.Source))
                _ = core.ExecuteScriptAsync("window.__waffleSystemAccent?.(" + Json.Write(SystemAccent()) + ")");
            // The page follows prefers-color-scheme, which WebView2 takes from the system (Auto).
        }

        // ------------------------------------------------------------------ startup

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyTheme();
            var menu = Native.GetSystemMenu(Handle, false);
            Native.AppendMenuW(menu, Native.MF_SEPARATOR, UIntPtr.Zero, null);
            Native.AppendMenuW(menu, Native.MF_STRING, (UIntPtr)MenuOpenRecent, "Open Recent…");
            Native.AppendMenuW(menu, Native.MF_STRING, (UIntPtr)MenuPause, "Pause All Extensions\tCtrl+Shift+Pause");
            Native.AppendMenuW(menu, Native.MF_STRING, (UIntPtr)MenuFullScreen, "Full Screen");
            // Recompute the frame so WM_NCCALCSIZE removes the system caption before the window is shown.
            if (captionScript != null)
                Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, Native.SWP_FRAMECHANGED | Native.SWP_NOMOVE | Native.SWP_NOSIZE |
                                    Native.SWP_NOZORDER | Native.SWP_NOOWNERZORDER | Native.SWP_NOACTIVATE);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (OpeningDetached) launchFallback.Interval = 15000;
            launchFallback.Start();
            try { await StartWebView(); }
            catch (WebView2RuntimeNotFoundException)
            {
                if (IsDisposed) return;
                if (!OpeningDetached) Reveal();
                MessageBox.Show(this, "Waffle needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and current Windows 10. " +
                    "Install the Evergreen WebView2 Runtime from Microsoft, then open Waffle again.", "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
            catch (Exception error)
            {
                if (IsDisposed) return;
                if (!OpeningDetached) Reveal();
                MessageBox.Show(this, "Waffle could not start its editor: " + error.Message, "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        void Reveal()
        {
            launchFallback.Stop();
            if (!launchFailed && Opacity < 1) Opacity = 1;
        }

        void FailWorkspaceLaunch()
        {
            if (launchFailed || !OpeningDetached || Opacity == 1) return;
            launchFailed = true;
            showingProcessFailure = true;
            launchFallback.Stop();
            MessageBox.Show(this, "Close this window and try opening the tab again from the main project window.",
                            "This project window could not open.", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
        }

        async Task StartWebView()
        {
            var options = new CoreWebView2EnvironmentOptions
            {
                // No browser extensions, no background fetches, no pings, no crash uploads.
                AdditionalBrowserArguments = "--disable-background-networking --no-pings --disable-features=msSmartScreenProtection",
                AreBrowserExtensionsEnabled = false,
                IsCustomCrashReportingEnabled = true,
            };
            var userData = Path.Combine(support, "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
            var window = Handle;
            controller = await WindowedInputController.Create(() =>
            {
                // Keep the native window in the WebView2 input path so it preserves wheel detents.
                var controllerOptions = environment.CreateCoreWebView2ControllerOptions();
                controllerOptions.AllowHostInputProcessing = true;
                return environment.CreateCoreWebView2ControllerAsync(window, controllerOptions);
            }, () => environment.CreateCoreWebView2ControllerAsync(window));
            controller.DefaultBackgroundColor = BackColor;
            controller.Bounds = ClientRectangle;
            controller.AcceleratorKeyPressed += OnAcceleratorKey;
            try { controller.AllowExternalDrop = false; } catch (Exception) { }
            core = controller.CoreWebView2;

            var s = core.Settings;
#if ATRIUM_DEVTOOLS
            s.AreDevToolsEnabled = true;
            s.AreBrowserAcceleratorKeysEnabled = true;
#else
            s.AreDevToolsEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false; // the page receives Ctrl+F, Ctrl+P, F5…
#endif
            s.AreHostObjectsAllowed = false;
            s.IsWebMessageEnabled = true;
            s.IsScriptEnabled = true;
            s.AreDefaultContextMenusEnabled = true; // filtered in OnContextMenu
            s.AreDefaultScriptDialogsEnabled = false; // shown natively in OnScriptDialog
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsBuiltInErrorPageEnabled = false;
            Try(() => s.IsPinchZoomEnabled = false);
            Try(() => s.IsSwipeNavigationEnabled = false);
            Try(() => s.IsGeneralAutofillEnabled = false);
            Try(() => s.IsPasswordAutosaveEnabled = false);
            Try(() => s.IsReputationCheckingRequired = false);
            Try(() => core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Auto);
            Try(() => core.Profile.IsGeneralAutofillEnabled = false);
            Try(() => core.Profile.IsPasswordAutosaveEnabled = false);

            core.NavigationStarting += (o, a) =>
            {
                if (!Policy.AllowMainFrame(a.Uri)) { a.Cancel = true; return; }
                host.PageGone();
            };
            core.FrameNavigationStarting += (o, a) => { if (!Policy.AllowSubframe(a.Uri)) a.Cancel = true; };
            Try(() => core.FrameCreated += (o, a) =>
            {
                a.Frame.NavigationStarting += (f, n) => { if (!Policy.AllowSubframe(n.Uri)) n.Cancel = true; };
                Try(() => a.Frame.PermissionRequested += (f, p) => { p.State = CoreWebView2PermissionState.Deny; });
            });
            core.NewWindowRequested += (o, a) => { a.Handled = true; }; // no NewWindow: the request is blocked
            core.DownloadStarting += (o, a) => { a.Cancel = true; a.Handled = true; };
            core.PermissionRequested += (o, a) => { a.State = CoreWebView2PermissionState.Deny; };
            Try(() => core.LaunchingExternalUriScheme += (o, a) => { a.Cancel = true; });
            Try(() => core.BasicAuthenticationRequested += (o, a) => { a.Cancel = true; });
            Try(() => core.ScreenCaptureStarting += (o, a) => { a.Cancel = true; });
            Try(() => core.SaveAsUIShowing += (o, a) => { a.Cancel = true; });
            Try(() => core.NotificationReceived += (o, a) => { a.Handled = true; });
            core.ContextMenuRequested += OnContextMenu;
            core.ScriptDialogOpening += OnScriptDialog;
            core.WebMessageReceived += (o, a) =>
            {
                string text;
                try { text = a.TryGetWebMessageAsString(); } catch (ArgumentException) { return; }
                if (text == "{\"action\":\"launchReady\"}" && Policy.TrustedSource(a.Source))
                {
                    Reveal();
                    return;
                }
                if (text == "{\"action\":\"workspaceLaunchFailed\"}" && Policy.TrustedSource(a.Source))
                {
                    FailWorkspaceLaunch();
                    return;
                }
                if (captionScript != null && text.StartsWith("{\"action\":\"windowCaption\",", StringComparison.Ordinal))
                {
                    if (Policy.TrustedSource(a.Source)) CaptionCommand(text);
                    return;
                }
                host.Receive(a.Source, text);
            };
            core.NavigationCompleted += (o, a) =>
            {
                if (!Policy.AllowMainFrame(core.Source)) return;
                if (!a.IsSuccess) { FailWorkspaceLaunch(); return; }
                // The state injected at document creation is the one from the first navigation.
                lastCaptionState = null; PublishCaption();
                host.PageReady();
                if (workspace != null && !workspace.IsWriter(this))
                    PostWorkspace(new Dictionary<string,object> { ["type"]="arrival", ["tab"]=WorkspaceTab });
                if (startupLink != null)
                {
                    var link = startupLink;
                    startupLink = null;
                    FollowSystemLink(link);
                }
            };
            core.ProcessFailed += OnProcessFailed;

            core.SetVirtualHostNameToFolderMapping(Policy.VirtualHost, Path.Combine(root, "app"), CoreWebView2HostResourceAccessKind.Deny);
            var bridge = "if(window.top===window){window.__waffleLaunchSettle=true;window.__atriumHostAccent=" + Json.Write(SystemAccent()) + ";}\n" +
                         File.ReadAllText(Path.Combine(root, "bridge.js"), Encoding.UTF8);
            if (OpeningDetached)
                bridge = "if(window.top===window)window.__waffleWorkspaceLaunch=true;\n" + bridge;
            if (openingAtStartup || OpeningDetached)
                bridge = "if(window.top===window)window.__atriumOpeningProject=true;\n" + bridge;
            if (captionScript != null)
            {
                lastCaptionState = CaptionState();
                bridge += "\nif(window.top===window)window.__waffleWindowCaptionState=" + lastCaptionState + ";\n" + captionScript;
            }
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            core.Navigate(Policy.PageUri);
            controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
        }

        static void Try(Action set) { try { set(); } catch (Exception) { /* an older WebView2 runtime lacks this setting */ } }

        // ------------------------------------------------------------------ WebView2 events

        static readonly HashSet<string> EditingItems = new HashSet<string>(StringComparer.Ordinal) {
            "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "spellCheck", "emoji" };

        void OnContextMenu(object sender, CoreWebView2ContextMenuRequestedEventArgs a)
        {
            // The editor shows its own menus (it cancels the DOM event). Text fields keep a
            // native editing menu; everything else (Inspect, Save image, Back, Print…) is removed.
            if (!a.ContextMenuTarget.IsEditable) { a.Handled = true; return; }
            var items = a.MenuItems;
            for (int i = items.Count - 1; i >= 0; i--)
                if (items[i].Kind != CoreWebView2ContextMenuItemKind.Separator && !EditingItems.Contains(items[i].Name)) items.RemoveAt(i);
            for (int i = items.Count - 1; i >= 0; i--)
                if (items[i].Kind == CoreWebView2ContextMenuItemKind.Separator && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator))
                    items.RemoveAt(i);
            if (items.Count == 0) a.Handled = true;
        }

        void OnScriptDialog(object sender, CoreWebView2ScriptDialogOpeningEventArgs a)
        {
            if (!Policy.AllowMainFrame(a.Uri) && a.Kind != CoreWebView2ScriptDialogKind.Beforeunload) return; // left unanswered: cancelled
            var deferral = a.GetDeferral();
            BeginInvoke((Action)(() =>
            {
                try
                {
                    switch (a.Kind)
                    {
                        case CoreWebView2ScriptDialogKind.Alert:
                            Dialogs.Ask(this, a.Message, null, "OK", null);
                            a.Accept();
                            break;
                        case CoreWebView2ScriptDialogKind.Confirm:
                            if (Dialogs.Ask(this, a.Message, null, "Continue", "Cancel")) a.Accept();
                            break;
                        case CoreWebView2ScriptDialogKind.Prompt:
                            var answer = Dialogs.Prompt(this, a.Message, a.DefaultText);
                            if (answer != null) { a.ResultText = answer; a.Accept(); }
                            break;
                        default:
                            a.Accept();
                            break;
                    }
                }
                finally { deferral.Complete(); }
            }));
        }

        void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs a)
        {
            if (showingProcessFailure) return;
            switch (a.ProcessFailedKind)
            {
                case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                    // WebView2 reports a page that stopped answering input. Wait, or close the window:
                    // the recovery sidecar is kept and reopening Waffle offers the autosaved work.
                    showingProcessFailure = true;
                    if (!OpeningDetached) Reveal();
                    host.RecordProcessFailure("unresponsive");
                    var wait = MessageBox.Show(this, "The editor is not responding. It may be busy with a long task.\n\n" +
                        "Choose Retry to wait for it, or Cancel to close this window. Reopening Waffle offers your autosaved work; nothing is written to your files without asking.",
                        "Waffle", MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning) == DialogResult.Retry;
                    if (wait) { showingProcessFailure = false; return; }
                    host.EditorFailed();
                    workspace?.RendererFailed(this);
                    try { controller?.Close(); } catch (Exception) { }
                    controller = null; core = null;
                    Close();
                    return;
                case CoreWebView2ProcessFailedKind.BrowserProcessExited: host.RecordProcessFailure("browser-exited"); break;
                case CoreWebView2ProcessFailedKind.RenderProcessExited: host.RecordProcessFailure("exited"); break;
                default: return;
            }
            showingProcessFailure = true;
            if (!OpeningDetached) Reveal();
            host.EditorFailed();
            workspace?.RendererFailed(this);
            MessageBox.Show(this, "Waffle's editor closed unexpectedly. Reopen Waffle and choose File › Recover to review your autosaved work.",
                            "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Error);
            try { controller?.Close(); } catch (Exception) { }
            controller = null; core = null;
            Close();
        }

        void OnAcceleratorKey(object sender, CoreWebView2AcceleratorKeyPressedEventArgs a)
        {
            if (a.KeyEventKind != CoreWebView2KeyEventKind.KeyDown && a.KeyEventKind != CoreWebView2KeyEventKind.SystemKeyDown) return;
            bool ctrl = Native.Down(Native.VK_CONTROL), shift = Native.Down(Native.VK_SHIFT), alt = Native.Down(Native.VK_MENU);
            uint key = a.VirtualKey;
            // Ctrl+Shift+Pause (or Ctrl+Shift+F12): pause every extension, even while an extension dialog
            // is open. Windows keeps Ctrl+Shift+Esc for Task Manager, so the macOS/Linux chord cannot be used.
            if (ctrl && shift && !alt && (key == VK_PAUSE || key == VK_CANCEL || key == VK_F12)) { a.Handled = true; host.PauseExtensions(); return; }
            if (ctrl && shift && !alt && key == VK_O)
                OfferEditorShortcut(a, "key:'O',code:'KeyO',ctrlKey:true,shiftKey:true", ShowRecentMenu);
            if (!ctrl && !shift && !alt && key == VK_F11)
                OfferEditorShortcut(a, "key:'F11',code:'F11'", ToggleFullScreen);
        }

        // WebView2 asks whether to consume the accelerator synchronously. Forward it after that callback.
        void OfferEditorShortcut(CoreWebView2AcceleratorKeyPressedEventArgs key, string fields, Action fallback)
        {
            key.Handled = true;
            bool repeat = key.PhysicalKeyStatus.WasKeyDown != 0;
            BeginInvoke((Action)(async () =>
            {
                bool handled = false;
                try
                {
                    if (core != null) handled = await core.ExecuteScriptAsync(
                        "(() => { const target = document.activeElement || document.body; "
                        + "return !!target && !target.dispatchEvent(new KeyboardEvent('keydown',{"
                        + fields + ",repeat:" + (repeat ? "true" : "false") + ",bubbles:true,cancelable:true})); })()") == "true";
                }
                catch (Exception e) when (e is InvalidOperationException || e is COMException) { } // The controller can close while dispatch is pending.
                if (!handled && !repeat && !IsDisposed) fallback();
            }));
        }

        // ------------------------------------------------------------------ menus

        void ShowRecentMenu()
        {
            var entries = host.Recent.Listing();
            var menu = Native.CreatePopupMenu();
            try
            {
                var paths = new List<string>();
                foreach (Dictionary<string, object> entry in entries)
                {
                    paths.Add((string)entry["path"]);
                    Native.AppendMenuW(menu, Native.MF_STRING, (UIntPtr)paths.Count, ((string)entry["name"]).Replace("&", "&&"));
                }
                if (paths.Count > 0) Native.AppendMenuW(menu, Native.MF_SEPARATOR, UIntPtr.Zero, null);
                Native.AppendMenuW(menu, paths.Count > 0 ? Native.MF_STRING : Native.MF_GRAYED, (UIntPtr)1000, paths.Count > 0 ? "Clear Menu" : "No Recent Projects");
                var at = PointToScreen(new Point(12, 12));
                int chosen = Native.TrackPopupMenuEx(menu, Native.TPM_RETURNCMD | Native.TPM_NONOTIFY, at.X, at.Y, Handle, IntPtr.Zero);
                if (chosen == 1000) host.ClearRecent();
                else if (chosen >= 1 && chosen <= paths.Count && !host.OpenRecent(paths[chosen - 1])) Native.MessageBeep(0);
            }
            finally { Native.DestroyMenu(menu); }
        }

        void ToggleFullScreen()
        {
            if (!fullScreen)
            {
                savedBorder = FormBorderStyle; savedState = WindowState; savedBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                fullScreen = true;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                fullScreen = false;
                FormBorderStyle = savedBorder;
                Bounds = savedBounds;
                WindowState = savedState;
            }
            PublishCaption();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_NCCALCSIZE && m.WParam != IntPtr.Zero && OwnCaption)
            {
                CalcClientWithoutCaption(ref m);
                return;
            }
            if (m.Msg == Native.WM_SYSCOMMAND)
            {
                int id = (int)((long)m.WParam & 0xFFF0);
                if (id == MenuOpenRecent) { ShowRecentMenu(); return; }
                if (id == MenuPause) { host.PauseExtensions(); return; }
                if (id == MenuFullScreen) { ToggleFullScreen(); return; }
            }
            else if (m.Msg == Native.WM_DWMCOLORIZATIONCOLORCHANGED ||
                     (m.Msg == Native.WM_SETTINGCHANGE && m.LParam != IntPtr.Zero && Marshal.PtrToStringUni(m.LParam) == "ImmersiveColorSet"))
                ApplyTheme();
            base.WndProc(ref m);
            if (m.Msg == Native.WM_MOVE || m.Msg == Native.WM_MOVING) controller?.NotifyParentWindowPositionChanged();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (controller == null) return;
            controller.IsVisible = WindowState != FormWindowState.Minimized;
            controller.Bounds = ClientRectangle;
            PublishCaption();
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            active = true;
            PublishCaption();
            host?.SetNotebookWindowActive(true);
            try { controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch (Exception) { }
        }

        protected override void OnDeactivate(EventArgs e)
        {
            active = false;
            PublishCaption();
            host?.SetNotebookWindowActive(false);
            base.OnDeactivate(e);
        }

        // ------------------------------------------------------------------ Waffle's own title bar
        // The page draws the title bar (native/windows/window-caption.js, app/style.css). The host keeps
        // the resizing frame on the left, right and bottom and removes the caption, so the page starts at
        // the top edge. WebView2 covers the whole client area and receives the mouse there, so the page
        // hands a press on the blank caption or on the top edge back to Windows (drag, resize), and asks
        // for minimise, maximise, close and the window menu by message.

        bool OwnCaption => captionScript != null && !fullScreen && FormBorderStyle == FormBorderStyle.Sizable;

        void CalcClientWithoutCaption(ref Message m)
        {
            var p = Marshal.PtrToStructure<Native.NCCALCSIZE_PARAMS>(m.LParam);
            int top = p.Proposed.Top;
            base.WndProc(ref m); // the default frame on every side, the caption included
            p = Marshal.PtrToStructure<Native.NCCALCSIZE_PARAMS>(m.LParam);
            p.Proposed.Top = top;
            if (Native.IsZoomed(Handle))
            {
                // A maximised window overhangs the monitor by its resizing frame; keep the page on screen.
                uint dpi = Native.GetDpiForWindow(Handle);
                p.Proposed.Top += Native.GetSystemMetricsForDpi(Native.SM_CYFRAME, dpi) + Native.GetSystemMetricsForDpi(Native.SM_CXPADDEDBORDER, dpi);
                LeaveRoomForHiddenTaskbar(ref p.Proposed);
            }
            Marshal.StructureToPtr(p, m.LParam, false);
            m.Result = IntPtr.Zero;
        }

        // A window that covers a monitor entirely hides an auto-hiding taskbar there for good; keep a 2 px edge free.
        void LeaveRoomForHiddenTaskbar(ref Native.RECT client)
        {
            var info = new Native.MONITORINFO { Size = Marshal.SizeOf<Native.MONITORINFO>() };
            if (!Native.GetMonitorInfoW(Native.MonitorFromWindow(Handle, Native.MONITOR_DEFAULTTONEAREST), ref info)) return;
            bool Hidden(uint edge)
            {
                var bar = new Native.APPBARDATA { Size = Marshal.SizeOf<Native.APPBARDATA>(), Edge = edge, Rect = info.Monitor };
                return Native.SHAppBarMessage(Native.ABM_GETAUTOHIDEBAREX, ref bar) != IntPtr.Zero;
            }
            if (Hidden(Native.ABE_TOP)) client.Top += 2;
            else if (Hidden(Native.ABE_BOTTOM)) client.Bottom -= 2;
            else if (Hidden(Native.ABE_LEFT)) client.Left += 2;
            else if (Hidden(Native.ABE_RIGHT)) client.Right -= 2;
        }

        string CaptionState() => Json.Write(new Dictionary<string, object> {
            ["maximized"] = WindowState == FormWindowState.Maximized, ["active"] = active, ["fullScreen"] = fullScreen });

        void PublishCaption()
        {
            if (captionScript == null || core == null) return;
            var state = CaptionState();
            if (state == lastCaptionState) return;
            lastCaptionState = state;
            if (!Policy.AllowMainFrame(core.Source)) return;
            try { _ = core.ExecuteScriptAsync("window.__waffleWindowCaption?.(" + state + ")"); }
            catch (Exception e) when (e is InvalidOperationException || e is COMException) { } // the controller is closing
        }

        void CaptionCommand(string text)
        {
            string command = null, edge = null;
            try
            {
                if (Json.Parse(text) is Dictionary<string, object> message)
                {
                    command = message.TryGetValue("command", out var c) ? c as string : null;
                    edge = message.TryGetValue("edge", out var e) ? e as string : null;
                }
            }
            catch (JsonException) { return; }
            // After WebView2's event returns: a move or size loop must not run inside its callback.
            BeginInvoke((Action)(() =>
            {
                if (IsDisposed) return;
                bool zoomed = WindowState == FormWindowState.Maximized;
                switch (command)
                {
                    case "minimize": WindowState = FormWindowState.Minimized; break;
                    case "maximize": if (!fullScreen) WindowState = zoomed ? FormWindowState.Normal : FormWindowState.Maximized; break;
                    case "close": Close(); break;
                    case "menu": ShowWindowMenu(Cursor.Position); break;
                    // Windows moves the window, snaps it and restores a maximised one, as on its own caption.
                    case "drag": if (OwnCaption) StartFrameLoop(Native.HTCAPTION); break;
                    case "resize":
                        int hit = edge == "top" ? Native.HTTOP : edge == "top-left" ? Native.HTTOPLEFT : edge == "top-right" ? Native.HTTOPRIGHT : 0;
                        if (hit != 0 && OwnCaption && !zoomed) StartFrameLoop(hit);
                        break;
                }
            }));
        }

        void StartFrameLoop(int hit)
        {
            // Only while the press that asked for it is still down; otherwise Windows starts a keyboard move.
            if ((MouseButtons & MouseButtons.Left) == 0) return;
            var at = Cursor.Position;
            Native.ReleaseCapture(); // the WebView2 window holds the mouse for the press
            Native.PostMessageW(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)hit, Native.PointParam(at.X, at.Y));
        }

        // The window menu (Alt+Space, or a right click on the blank caption), with the items that apply now.
        void ShowWindowMenu(Point at)
        {
            var menu = Native.GetSystemMenu(Handle, false);
            bool zoomed = WindowState == FormWindowState.Maximized, normal = WindowState == FormWindowState.Normal && !fullScreen;
            void Enable(int id, bool on) => Native.EnableMenuItem(menu, (uint)id, Native.MF_BYCOMMAND | (on ? Native.MF_ENABLED : Native.MF_GRAYED));
            Enable(Native.SC_RESTORE, zoomed || fullScreen);
            Enable(Native.SC_MOVE, normal);
            Enable(Native.SC_SIZE, normal);
            Enable(Native.SC_MINIMIZE, true);
            Enable(Native.SC_MAXIMIZE, !zoomed && !fullScreen);
            Enable(Native.SC_CLOSE, true);
            int chosen = Native.TrackPopupMenuEx(menu, Native.TPM_RETURNCMD | Native.TPM_NONOTIFY, at.X, at.Y, Handle, IntPtr.Zero);
            if (chosen != 0) Native.PostMessageW(Handle, Native.WM_SYSCOMMAND, (IntPtr)chosen, IntPtr.Zero);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!showingProcessFailure && e.CloseReason == CloseReason.UserClosing && workspace?.KeepWriter(this) == true)
            { Hide(); e.Cancel = true; return; }
            // Unsaved changes: Save / Don't Save / Cancel. After Save the window closes once the page reports it saved.
            if (core != null && !host.OkayToClose(() => Dialogs.AskToSave(this, host.ProjectName),
                    () => BeginInvoke((Action)(() => { if (!IsDisposed) Close(); }))))
            { e.Cancel = true; return; }
            StoreFrame();
            host.Closing();
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            launchFallback.Dispose();
            workspace?.Close(this);
            try { controller?.Close(); } catch (Exception) { }
            base.OnFormClosed(e);
        }

        // ------------------------------------------------------------------ IHostUi

        static string Filter(IList<string> extensions, string label)
        {
            var patterns = new List<string>();
            foreach (var x in extensions) patterns.Add("*." + x);
            var joined = string.Join(";", patterns);
            return label + " (" + joined + ")|" + joined;
        }

        internal string LinkProjectIdentity => host.AdoptedProjectIdentity;
        internal bool LinkProjectWriter => workspace == null || workspace.IsWriter(this);

        internal void FollowSystemLink(string url)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            Post(Json.Write(new Dictionary<string, object> { ["type"] = "waffleLink", ["url"] = url }));
        }

        public bool OwnsProject(string path)
        {
            try { return host.DesignPath != null && fs.PathComparer.Equals(host.DesignPath, fs.Canonical(path)); }
            catch (HostError) { return false; }
        }

        List<string> DroppedFiles(DragEventArgs e)
        {
            var paths = e.Data?.GetData(DataFormats.FileDrop, false) as string[];
            return paths == null ? new List<string>() :
                new List<string>(paths).FindAll(path => translators.AcceptsExisting(fs, path));
        }

        string NotebookDropPath(DragEventArgs e)
        {
            var paths = e.Data?.GetData(DataFormats.FileDrop, false) as string[];
            return paths?.Length == 1 && host.AcceptsNotebookDrop(paths[0]) ? paths[0] : null;
        }

        string TypedDropPath(DragEventArgs e)
        {
            var paths = e.Data?.GetData(DataFormats.FileDrop,false) as string[];
            return paths?.Length == 1 && host.TypedDropMime(paths[0]) != null ? paths[0] : null;
        }

        static Com.FORMATETC OLEFormat(string name,Com.TYMED medium,int index=-1) =>
            new Com.FORMATETC {cfFormat=unchecked((short)DataFormats.GetFormat(name).Id),lindex=index,
                dwAspect=Com.DVASPECT.DVASPECT_CONTENT,tymed=medium};

        static bool HasOLEFormat(DragEventArgs e,Com.FORMATETC format)
        {
            if (!(e.Data is Com.IDataObject source)) return false;
            try {return source.QueryGetData(ref format)==0;}
            catch (COMException) {return false;}
        }

        static Com.FORMATETC? PdfFormat(DragEventArgs e)
        {
            foreach (var name in new[] {"application/pdf","Portable Document Format"})
            {
                var format=OLEFormat(name,Com.TYMED.TYMED_HGLOBAL);
                if (HasOLEFormat(e,format)) return format;
            }
            return null;
        }

        static Com.FORMATETC PromiseFormat() => OLEFormat("FileGroupDescriptorW",Com.TYMED.TYMED_HGLOBAL);

        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref Com.STGMEDIUM medium);

        static byte[] DropData(Com.IDataObject source,Com.FORMATETC format,int cap,int? expected,
                               System.Threading.CancellationToken cancellation=default)
        {
            // Consume raw OLE media directly. WinForms clipboard object
            // deserialization is unnecessary for a file transfer.
            cancellation.ThrowIfCancellationRequested();
            source.GetData(ref format,out var medium);
            try
            {
                if (medium.tymed==Com.TYMED.TYMED_ISTREAM)
                    return ReadDropStream(medium.unionmember,cap,expected,cancellation);
                if (medium.tymed!=Com.TYMED.TYMED_HGLOBAL) return null;
                ulong size=GlobalSize(medium.unionmember).ToUInt64();
                // A global memory block can include allocator rounding.
                if (size<1 || size>(ulong)cap || expected.HasValue && size<(ulong)expected.Value) return null;
                var pointer=GlobalLock(medium.unionmember);
                if (pointer==IntPtr.Zero) return null;
                try
                {
                    var data=new byte[expected ?? (int)size];
                    Marshal.Copy(pointer,data,0,data.Length);
                    return data;
                }
                finally {GlobalUnlock(medium.unionmember);}
            }
            finally {ReleaseStgMedium(ref medium);}
        }

        static byte[] ReadDropStream(IntPtr pointer,int cap,int? expected,System.Threading.CancellationToken cancellation)
        {
            if (pointer==IntPtr.Zero) return null;
            var stream=(Com.IStream)Marshal.GetObjectForIUnknown(pointer);
            var received=Marshal.AllocCoTaskMem(sizeof(int));
            try
            {
                using (var data=new MemoryStream())
                {
                    var buffer=new byte[65536];
                    int limit=expected ?? cap;
                    while (true)
                    {
                        cancellation.ThrowIfCancellationRequested();
                        int count=Math.Min(buffer.Length, limit-(int)data.Length+1);
                        Marshal.WriteInt32(received,0);
                        stream.Read(buffer,count,received);
                        int read=Marshal.ReadInt32(received);
                        if (read<0 || read>count || data.Length+read>limit) return null;
                        if (read==0) return expected.HasValue && data.Length!=expected.Value ? null : data.ToArray();
                        data.Write(buffer,0,read);
                    }
                }
            }
            finally {Marshal.FreeCoTaskMem(received); Marshal.ReleaseComObject(stream);}
        }

        bool OfferOLEDrop(DragEventArgs e,double x,double y)
        {
            if (!(e.Data is Com.IDataObject source)) return false;
            var pdf=PdfFormat(e);
            if (pdf.HasValue) return host.OfferTypedDrop(null,cancel=>DropData(source,pdf.Value,NotebookInput.MaxBytes,null,cancel),x,y);
            var promise=PromiseFormat();
            if (!HasOLEFormat(e,promise)) return false;
            var descriptor=DropData(source,promise,4096,PromisedDrop.DescriptorBytes);
            if (!PromisedDrop.TryDescribe(descriptor,out var name,out var length)) return false;
            var content=OLEFormat("FileContents",Com.TYMED.TYMED_ISTREAM|Com.TYMED.TYMED_HGLOBAL,0);
            return host.OfferTypedDrop(null,cancel=>DropData(source,content,NotebookInput.MaxBytes,length,cancel),x,y,name,length);
        }

        protected override void OnDragEnter(DragEventArgs e)
        {
            base.OnDragEnter(e);
            e.Effect = (e.AllowedEffect & DragDropEffects.Copy) != 0 && (NotebookDropPath(e) != null || DroppedFiles(e).Count > 0 ||
                host.ButterDropEnabled && (TypedDropPath(e) != null || PdfFormat(e) != null || HasOLEFormat(e,PromiseFormat()))) ? DragDropEffects.Copy : DragDropEffects.None;
        }

        protected override void OnDragDrop(DragEventArgs e)
        {
            base.OnDragDrop(e);
            if ((e.AllowedEffect & DragDropEffects.Copy) == 0) return;
            var path = NotebookDropPath(e);
            var files = DroppedFiles(e);
            var point = PointToClient(new Point(e.X,e.Y));
            double x = point.X / (double)Math.Max(1,ClientSize.Width), y = point.Y / (double)Math.Max(1,ClientSize.Height);
            void Fallback()
            {
                if (path != null)
                {
                    Activate();
                    if (host.OfferNotebookDrop(path,x,y)) return;
                }
                host.DropDesignFiles(files);
            }
            if (host.ButterDropEnabled)
            {
                var typed = TypedDropPath(e);
                try
                {
                    Activate();
                    if (typed!=null ? host.OfferTypedDrop(typed,null,x,y,fallback:Fallback) : OfferOLEDrop(e,x,y)) return;
                }
                catch (Exception) { /* An unfulfilled OLE data source cannot change the project. */ }
            }
            Fallback();
        }

        public void OpenProjectWindow(IList<string> paths) => openProjectWindow(paths);

        Form importChoice;
        bool importPickerVisible;
        [DllImport("user32.dll")] static extern IntPtr GetLastActivePopup(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint relation);
        [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
        public void ChooseImportSave(string title,string detail,string save,string export,string cancel,Action<string> done)
        {
            var labels=export==null ? new[]{save,cancel} : new[]{save,export,cancel};
            try {
                int picked=Dialogs.Show(this,title,detail,labels,0,labels.Length-1,null,out _,shown=>importChoice=shown);
                done(picked==0?"waffle":picked==1 && export!=null?"export":"cancel");
            } finally {importChoice=null;}
        }
        public void CancelImportChoice()
        {
            if(importChoice!=null){importChoice.Close();return;}
            if(!importPickerVisible||!IsHandleCreated)return;
            var popup=GetLastActivePopup(Handle);
            if(popup==IntPtr.Zero||popup==Handle)return;
            // A nested overwrite prompt belongs to the same file chooser. Only a popup owned
            // by this Waffle window can be closed when its operation is retired.
            for(var owner=GetWindow(popup,4);owner!=IntPtr.Zero;owner=GetWindow(owner,4))
                if(owner==Handle){PostMessageW(popup,0x0010,IntPtr.Zero,IntPtr.Zero);break;}
        }
        DialogResult ShowImportPicker(CommonDialog dialog,Func<bool> current)
        {
            if(!current())return DialogResult.Cancel;
            importPickerVisible=true;
            try{return dialog.ShowDialog(this);}
            finally{importPickerVisible=false;}
        }
        public void PickImportFiles(IList<string> extensions,Func<bool> current,Action<IList<string>> done)
        {
            BeginInvoke((Action)(()=>{
                using(var panel=new OpenFileDialog{Title="Choose the original design to reconnect this draft",
                      Multiselect=true,CheckFileExists=true,RestoreDirectory=true,Filter=Filter(extensions,"Design files")})
                    done(ShowImportPicker(panel,current)==DialogResult.OK?panel.FileNames:null);
            }));
        }
        public void PickImportDestination(string name,bool single,string title,Func<bool> current,Action<string> done)
        {
            BeginInvoke((Action)(()=>{
                if(single) {
                    string ext=Policy.Extension(name);
                    using(var panel=new SaveFileDialog{Title=title,FileName=name,DefaultExt=ext,AddExtension=true,
                          OverwritePrompt=false,CheckPathExists=true,RestoreDirectory=true,Filter=Filter(new[]{ext},ext.ToUpperInvariant()+" file")})
                        done(ShowImportPicker(panel,current)==DialogResult.OK?panel.FileName:null);
                }else{
                    using(var panel=new FolderBrowserDialog{Description=title,ShowNewFolderButton=true})
                        done(ShowImportPicker(panel,current)==DialogResult.OK?panel.SelectedPath:null);
                }
            }));
        }

        public void PickFolder(bool create, Action<string> done)
        {
            BeginInvoke((Action)(() => {
                using (var dialog = new FolderBrowserDialog {
                    Description = create ? "Choose an empty folder for the new Waffle project" : "Choose a Waffle project folder",
                    ShowNewFolderButton = create
                }) done(dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null);
            }));
        }

        public void PickFolderFrom(string start, string title, Action<string> done)
        {
            BeginInvoke((Action)(() => {
                using (var dialog = new FolderBrowserDialog { Description = title, ShowNewFolderButton = true })
                {
                    if (start != null && Directory.Exists(start)) dialog.SelectedPath = start;
                    done(dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null);
                }
            }));
        }

        public void PickOpen(OpenRequest request, Action<IList<string>> done)
        {
            BeginInvoke((Action)(() =>
            {
                using (var panel = new OpenFileDialog { Title = request.Title, Multiselect = request.Multiple, CheckFileExists = true,
                                                        RestoreDirectory = true, Filter = Filter(request.Extensions, request.Multiple ? "Waffle and design files" : "Supported files") })
                    done(panel.ShowDialog(this) == DialogResult.OK ? panel.FileNames : null);
            }));
        }

        // run:external dialogs (ExternalTools.cs). Not yet tested on Windows.
        public void Confirm(string message, string detail, string accept, Action<bool> done) =>
            BeginInvoke((Action)(() => done(Dialogs.Ask(this, message, detail, accept, "Cancel"))));

        public void PickProgram(string title, Action<string> done)
        {
            BeginInvoke((Action)(() =>
            {
                using (var panel = new OpenFileDialog { Title = title, Multiselect = false, CheckFileExists = true, RestoreDirectory = true, Filter = "Programs (*.exe)|*.exe" })
                    done(panel.ShowDialog(this) == DialogResult.OK ? panel.FileName : null);
            }));
        }

        public void PickSave(SaveRequest request, Action<string> done)
        {
            BeginInvoke((Action)(() =>
            {
                using (var panel = new SaveFileDialog { Title = request.Title, FileName = request.FileName, DefaultExt = request.Extension,
                                                        AddExtension = true, OverwritePrompt = true, CheckPathExists = true, RestoreDirectory = true,
                                                        Filter = Filter(new[] { request.Extension }, request.Extension.ToUpperInvariant() + " file") })
                    done(panel.ShowDialog(this) == DialogResult.OK ? panel.FileName : null);
            }));
        }

        public void Post(string json)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => Post(json))); return; }
            try { core?.PostWebMessageAsJson(json); } catch (Exception) { /* the page is reloading */ }
        }

        public void SetDirty(bool dirty) { Text = dirty ? "Waffle •" : "Waffle"; }

        NotebookClipboardItem INotebookClipboard.ReadNotebookClipboard() => WinNotebookClipboard.Read(Handle);

        public bool WriteClipboard(string custom, string text)
        {
            try
            {
                var data = new DataObject();
                data.SetData(Policy.SelectionFormat, false, new MemoryStream(Encoding.UTF8.GetBytes(custom)));
                data.SetData(DataFormats.UnicodeText, false, text);
                Clipboard.SetDataObject(data, true, 5, 100);
                return true;
            }
            catch (ExternalException) { return false; }
        }

        public void ReadClipboard(out string custom, out string text)
        {
            custom = null; text = null;
            try
            {
                var data = Clipboard.GetDataObject();
                if (data == null) return;
                if (data.GetData(Policy.SelectionFormat) is MemoryStream stream && stream.Length <= Policy.SelectionCap + 16)
                    custom = Encoding.UTF8.GetString(stream.ToArray()).TrimEnd('\0');
                text = data.GetData(DataFormats.UnicodeText) as string;
            }
            catch (ExternalException) { }
        }

        IList<string> INativeDocumentClipboard.ReadDocumentPaths()
        {
            try
            {
                if (!Clipboard.ContainsFileDropList()) return Array.Empty<string>();
                var paths = new List<string>();
                foreach (string path in Clipboard.GetFileDropList())
                {
                    paths.Add(path);
                    if (paths.Count == 32) break;
                }
                return paths;
            }
            catch (ExternalException) { return Array.Empty<string>(); }
        }

        public void Background(Action work) => Task.Run(work);

        public void Main(Action work)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke(work); } catch (InvalidOperationException) { } }
            else work();
        }

        public void NoteShellRecent(string path)
        {
            if (qualification) return;
            try { Native.SHAddToRecentDocs(Native.SHARD_PATHW, path); } catch (Exception) { }
        }
        public object ProviderCredential(string operation, string provider) => AICredentials.Request(this, operation, provider);
    }
}
