// Entry point: Waffle.exe [design file]
using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;

namespace Waffle.Windows
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if(args.Length>0 && args[0]=="--folder-mcp") {
                if(args.Length!=2) return 2;
                return FolderMcp.Run(new WinFs(),args[1],Console.In,Console.Out);
            }
            try { Native.SetCurrentProcessExplicitAppUserModelID("Atrium.Editor"); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var root = AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(root, "app", "index.html")) || !File.Exists(Path.Combine(root, "bridge.js")))
            {
                MessageBox.Show("Waffle could not find its editor files.", "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            TranslatorFiles translators;
            try { translators = TranslatorFiles.Parse(File.ReadAllText(Path.Combine(root, "app", "translators.json"))); }
            catch (IOException) { translators = new TranslatorFiles(); }
            var fs = new WinFs();
            string startup = null, startupLink = null;
            foreach (var arg in args)
            {
                if (arg == "--version") { MessageBox.Show("Waffle " + Application.ProductVersion, "Waffle"); return 0; }
                if (arg.StartsWith("waffle:", StringComparison.OrdinalIgnoreCase))
                {
                    if (!WaffleLink.Valid(arg)) return 2;
                    startupLink = arg;
                    break;
                }
                if (arg.StartsWith("-", StringComparison.Ordinal)) continue;
                string full;
                try { full = Path.GetFullPath(arg); } catch (Exception) { full = null; }
                if (full == null || !translators.AcceptsExisting(fs, full))
                {
                    MessageBox.Show("Choose a file in a supported import format.\n" + arg, "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    continue;
                }
                startup = full;
                break;
            }
            bool qualification = Environment.GetEnvironmentVariable(NativeSupportPath.QualificationFlag) == "1";
            if (startupLink != null)
            {
                if (qualification) return 2;
                var forwarded = LinkRouting.Forward(startupLink);
                if (forwarded == LinkRouting.Result.Found) return 0;
                if (forwarded == LinkRouting.Result.Ambiguous)
                {
                    MessageBox.Show("More than one open project has this Waffle link's identity.", "Waffle", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 2;
                }
            }
            string support;
            try
            {
                support = NativeSupportPath.Resolve(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    qualification ? Path.GetTempPath() : null, qualification);
            }
            catch (ArgumentException) when (qualification) { return 2; }
            Directory.CreateDirectory(support);
            using (var windows = new ProjectWindows(root, support, startup, translators, startupLink, qualification))
            using (var links = qualification ? null : new LinkRouting(windows.RouteLink))
                Application.Run(windows);
            return 0;
        }
    }

    sealed class ProjectWindows : ApplicationContext
    {
        readonly string root, support;
        readonly RecentProjects recent;
        readonly TranslatorFiles translators;
        readonly bool qualification;
        readonly List<MainWindow> windows = new List<MainWindow>();

        public ProjectWindows(string root, string support, string startup, TranslatorFiles translators, string startupLink = null, bool qualification = false)
        {
            this.root = root;
            this.support = support;
            this.translators = translators;
            this.qualification = qualification;
            recent = new RecentProjects(new WinFs(), support);
            OpenWindow(startup != null ? new[] { startup } : Array.Empty<string>(), startupLink);
        }

        internal LinkRouting.Result RouteLink(string url, bool follow)
        {
            var project = WaffleLink.ProjectIdentity(url);
            if (project == null) return LinkRouting.Result.Missing;
            string path = null;
            MainWindow owner = null;
            foreach (var window in windows)
            {
                if (window.LinkProjectIdentity != project || window.WorkspacePath == null) continue;
                if (path != null && !StringComparer.OrdinalIgnoreCase.Equals(window.WorkspacePath, path))
                    return LinkRouting.Result.Ambiguous;
                path = window.WorkspacePath;
                if (owner == null || window.LinkProjectWriter && !owner.LinkProjectWriter ||
                    window.LinkProjectWriter == owner.LinkProjectWriter && window.ContainsFocus) owner = window;
            }
            if (owner == null) return LinkRouting.Result.Missing;
            if (follow) owner.FollowSystemLink(url);
            return LinkRouting.Result.Found;
        }

        void Open(IList<string> paths) => OpenWindow(paths, null);

        void OpenWindow(IList<string> paths, string link)
        {
            foreach (var window in windows)
                if (paths.Count == 1 && window.OwnsProject(paths[0]))
                {
                    if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
                    window.Activate();
                    return;
                }
            NewWindow(paths, link, null, null, null);
        }

        MainWindow NewWindow(IList<string> paths, string link, WorkspaceWindows group, string id, string tab)
        {
            var next = new MainWindow(root, support, paths, Open, translators, recent, link, qualification);
            next.ConfigureWorkspace((g,key,document) => NewWindow(Array.Empty<string>(), null, g, key, document), group, id, tab);
            windows.Add(next);
            next.FormClosed += (sender, e) => { windows.Remove(next); if (windows.Count == 0) ExitThread(); };
            next.Show();
            return next;
        }
    }
}
