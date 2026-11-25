// Platform-independent rules shared by the Windows host and its tests: the navigation
// policy, the file types each bridge action accepts, and Windows path checks for page input.
// These mirror native/macos/main.swift and native/linux/waffle.py; keep them in step.
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    public static class Policy
    {
        /// The editor is served from the app folder under this virtual host (never resolved on
        /// the network: WebView2 maps it to the folder, and .example is reserved by RFC 2606).
        public const string VirtualHost = "app.waffle.example";
        public const string PageUri = "https://" + VirtualHost + "/index.html";

        /// The main frame only ever shows the editor page.
        public static bool AllowMainFrame(string uri) => string.Equals(uri, PageUri, StringComparison.Ordinal);

        /// Subframes may load only inline documents: the extension sandbox (about:srcdoc) and
        /// print previews (about:blank). Everything else, including new windows, is cancelled.
        public static bool AllowSubframe(string uri) =>
            string.Equals(uri, "about:srcdoc", StringComparison.Ordinal) || string.Equals(uri, "about:blank", StringComparison.Ordinal);

        /// Bridge messages are accepted only from the top-level editor page.
        public static bool TrustedSource(string source) => AllowMainFrame(source);

        public const int SelectionCap = 16 * 1024 * 1024;
        public const int SummaryCap = 512;
        public const long ProjectReadCap = 256L * 1024 * 1024;
        public const long LibraryReadCap = 16L * 1024 * 1024;
        public const int RecentLimit = 12;
        public const int AllowLimit = 200;
        public const string SelectionFormat = "org.waffle.selection.v1";
        public const string SelectionMarker = "\nWaffle-Selection/1\n";

        public static readonly HashSet<string> HistoryTypes = Set("prjpcb", "schdoc", "pcbdoc", "kicad_pro", "kicad_sch", "kicad_pcb");
        public static readonly HashSet<string> HistoryQueries = Set("projectLog", "projectBlobs", "sourceRevision", "sourceLog");
        public static readonly HashSet<string> SourceTypes = Set("schdoc", "pcbdoc");
        public static readonly HashSet<string> LibraryTypes = Set("atrlib", "json");
        public const string PreReleaseMessage = "This file is from a pre-release Waffle build; re-import the design from its source EDA";
        static readonly Regex HeaderTokens = new Regex(@"""(?:[^""\\]|\\.)*""|[{}\[\]]");
        static readonly Regex HeaderValue = new Regex(@"^\s*:\s*(?:""([a-zA-Z0-9_.-]{1,48})""|(\[))");
        internal static bool ObsoleteProject(byte[] bytes, int count)
        {
            Encoding encoding = Encoding.UTF8;
            if (count >= 2 && bytes[0] == 255 && bytes[1] == 254) encoding = Encoding.Unicode;
            if (count >= 2 && bytes[0] == 254 && bytes[1] == 255) encoding = Encoding.BigEndianUnicode;
            var text = encoding.GetString(bytes, 0, Math.Min(count,65536)).TrimStart('\ufeff').TrimStart();
            if (Regex.IsMatch(text,@"^ATRIUM-JOURNAL 1(?:\r?\n|$)")) return true;
            if (!text.StartsWith("{", StringComparison.Ordinal)) return false;
            int depth = 0;
            string format = null, kind = null, version = null;
            bool design = false;
            foreach (Match token in HeaderTokens.Matches(text))
            {
                char first = text[token.Index];
                if (first == '{' || first == '[') { depth++; continue; }
                if (first == '}' || first == ']') { if (--depth == 0) break; continue; }
                if (depth != 1 || token.Length > 26) continue;
                string key = text.Substring(token.Index + 1,token.Length - 2);
                if (key != "format" && key != "kind" && key != "formatVersion" && key != "documents" && key != "library" && key != "sheets") continue;
                int offset = token.Index + token.Length;
                var value = HeaderValue.Match(text.Substring(offset,Math.Min(64,text.Length-offset)));
                if (!value.Success) continue;
                if (key == "format") format = value.Groups[1].Value;
                else if (key == "kind") kind = value.Groups[1].Value;
                else if (key == "formatVersion") version = value.Groups[1].Value;
                else if (value.Groups[2].Success) design = true;
            }
            if (format == "atrium" || format == "waffle") return true;
            if (kind == "project") return version != null && (version.StartsWith("0.",StringComparison.Ordinal) || version.StartsWith("1.",StringComparison.Ordinal));
            return string.IsNullOrEmpty(format) && design;
        }
        public static bool IsProjectExtension(string extension) => extension == "waffle";
        public static bool ProjectName(string path) => IsProjectExtension(Extension(path)) || Extension(path) == "atrium";
        public static bool IsProject(string path) => IsProjectExtension(Extension(path)) || Extension(path) == "prjpcb";

        /// Files page code may ask the user to pick (read-only, through an open dialog).
        public static readonly HashSet<string> ExchangeInputs = Set(
            "waffle-block", "waffle-rules", "waffle-eco", "waffle-ai", "atrgroup", "rul", "waffle", "schdoc", "pcbdoc",
            "atrlib", "json", "waffle-keys", "waffle-fab", "csv", "dxf",
            "png", "jpg", "jpeg", "svg", "webp", "bmp", "gif");

        /// Exchange files plus manufacturing outputs: reports, drawings, archives, Gerber layers
        /// (Altium extensions, G1-G30 for inner layers) and Excellon drill files.
        public static readonly HashSet<string> ExchangeOutputs = Outputs();

        static HashSet<string> Outputs()
        {
            var set = Set("waffle-block", "waffle-rules", "waffle-eco", "waffle-ai", "atrgroup", "rul", "kicad_pcb", "kicad_sch", "csv",
                          "txt", "drl", "svg", "html", "zip", "xlsx", "pdf", "step", "stp", "glb",
                          "gtl", "gbl", "gto", "gbo", "gts", "gbs", "gtp", "gbp", "gm1", "gko");
            for (int layer = 1; layer <= 30; layer++) set.Add("g" + layer);
            return set;
        }

        static HashSet<string> Set(params string[] items) => new HashSet<string>(items, StringComparer.Ordinal);

        /// The last path component of a name the page suggests, with either separator.
        public static string BaseName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            int cut = Math.Max(name.LastIndexOf('/'), name.LastIndexOf('\\'));
            return cut >= 0 ? name.Substring(cut + 1) : name;
        }

        /// Lower-case extension without the dot ("" when there is none).
        public static string Extension(string name)
        {
            var b = BaseName(name);
            int dot = b.LastIndexOf('.');
            return dot > 0 && dot < b.Length - 1 ? b.Substring(dot + 1).ToLowerInvariant() : "";
        }

        internal static readonly Dictionary<string, string> NativeDocumentKinds = new Dictionary<string, string>
        {
            ["wpcb"] = "pcb", ["wsch"] = "schematic", ["wlib"] = "library", ["wdraw"] = "drawing", ["wpanel"] = "panel"
        };

        internal static bool NativeDocument(string path) => NativeDocumentKinds.ContainsKey(Extension(path));
        internal static bool NativeDocumentName(string path) =>
            NativeDocument(path) || (BaseName(path).StartsWith(".", StringComparison.Ordinal) &&
                                     NativeDocumentKinds.ContainsKey(BaseName(path).Substring(1).ToLowerInvariant()));

        /// Normalises a page-supplied extension list (".SchDoc" -> "schdoc"); null when malformed.
        public static List<string> Extensions(object value)
        {
            var list = value as IList<object>;
            var result = new List<string>();
            if (value == null) return result;
            if (list == null || list.Count > 64) return null;
            foreach (var item in list)
            {
                var text = item as string;
                if (text == null || text.Length > 32) return null;
                result.Add(text.Trim('.').ToLowerInvariant());
            }
            return result;
        }

        public static int Utf8Length(string s) => Encoding.UTF8.GetByteCount(s);

        public static bool IsFullCommit(string revision)
        {
            if (revision == null || (revision.Length != 40 && revision.Length != 64)) return false;
            foreach (char c in revision) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }
    }

    /// Design selection policy from the bundled app/translators.json.
    public sealed class TranslatorFiles
    {
        readonly HashSet<string> types = new HashSet<string>(Policy.NativeDocumentKinds.Keys), libraries = new HashSet<string>();
        static readonly Regex Dotted = new Regex(@"\A\.[a-zA-Z0-9_-]{1,30}\z", RegexOptions.CultureInvariant);

        static List<string> Extensions(object value)
        {
            var items = value as List<object>;
            if (items == null || items.Count > 64) return null;
            var extensions = new List<string>();
            foreach (var item in items)
            {
                var ext = item as string;
                if (ext == null || !Dotted.IsMatch(ext)) return null;
                extensions.Add(ext.Substring(1).ToLowerInvariant());
            }
            return extensions;
        }

        public static TranslatorFiles Parse(string json)
        {
            var registry = new TranslatorFiles();
            object rows;
            try { rows = Json.Parse(json); }
            catch (JsonException) { return registry; }
            if (!(rows is List<object> entries)) return registry;
            registry.types.UnionWith(new[] { "waffle", "zip" }); // Native folder archive, dispatched before translation.
            foreach (var entry in entries)
            {
                var row = entry as Dictionary<string, object>;
                if (row == null || !row.TryGetValue("import", out var flag) || !Equals(flag, true) ||
                    !row.TryGetValue("extensions", out var values)) continue;
                var extensions = Extensions(values);
                if (extensions == null) continue;
                if (row.TryGetValue("id", out var translator) && Equals(translator, "legacy")) continue;
                extensions.Remove("atrium");
                registry.types.UnionWith(extensions);
                if (row.TryGetValue("libraryExtensions", out var list))
                {
                    var supported = Extensions(list);
                    if (supported != null) foreach (var ext in supported) if (extensions.Contains(ext)) registry.libraries.Add(ext);
                }
            }
            return registry;
        }

        public bool Accepts(string path) => types.Contains(Policy.Extension(path));
        internal bool AcceptsExisting(IHostFs fs, string path)
        {
            if (!fs.IsAbsolute(path)) return false;
            if (Policy.NativeDocumentName(path)) return Policy.NativeDocument(path) && fs.Kind(path, out _) == EntryKind.File;
            return System.IO.Directory.Exists(path) || ((Policy.ProjectName(path) || Accepts(path)) && System.IO.File.Exists(path));
        }
        internal bool Library(string ext) => libraries.Contains(ext);

        internal List<string> OpenTypes(object requested)
        {
            var chosen = requested == null ? new List<string>(types) : Extensions(requested);
            if (chosen == null || (requested != null && (chosen.Count == 0 || !chosen.TrueForAll(types.Contains))))
                throw new HostError("Unrecognised import file type.");
            chosen.Sort(StringComparer.Ordinal);
            return chosen;
        }
    }

    /// Git queries from the page (bridge.js gitQuery): an operation from Ops and arguments with the
    /// keys that operation takes. Strings are short and printable, numbers are whole and small,
    /// "revisions" holds full commit identifiers only. native/git_head.py checks the meaning again;
    /// the macOS and Linux hosts apply the same rules (main.swift gitQueryArguments, waffle.py).
    public static class GitQuery
    {
        public static readonly Dictionary<string, string[]> Ops = new Dictionary<string, string[]>(StringComparer.Ordinal) {
            { "createBranch", new[] { "name", "revision", "confirm" } }, { "refs", new string[0] }, { "status", new string[0] },
            { "log", new[] { "refs", "limit", "skip", "search" } }, { "fileLog", new[] { "limit", "skip" } },
            { "projectLog", new[] { "limit", "skip", "snapshot", "firstParent", "recordLinks" } }, { "projectBlobs", new[] { "revisions" } }, { "folderRevisions", new[] { "revisions", "stage", "stages", "known" } }, { "sourceRevision", new[] { "revision" } }, { "sourceLog", new[] { "limit", "skip" } }, { "read", new[] { "revision" } }, { "mergeBase", new[] { "a", "b" } }, { "blameLog", new[] { "limit" } },
            { "patches", new[] { "head", "revisions" } }, { "installMergeDriver", new[] { "confirm", "plan" } }, { "mergeDriverPlan", new string[0] },
            // Git LFS locks (docs/collaboration.md): status is local; the others contact the LFS server and need confirm.
            { "lfsStatus", new string[0] }, { "lfsLocks", new[] { "confirm" } }, { "lfsLock", new[] { "confirm" } }, { "lfsUnlock", new[] { "confirm" } },
            { "commitPlan", new string[0] }, { "commitStaged", new[] { "confirm", "message", "paths", "plan" } } };

        internal static readonly HashSet<string> FolderOps = new HashSet<string>(StringComparer.Ordinal) {
            "createBranch", "refs", "status", "log", "fileLog", "projectLog", "projectBlobs", "folderRevisions", "mergeBase",
            "lfsStatus", "lfsLocks", "lfsLock", "lfsUnlock", "commitPlan", "commitStaged" };

        /// At most 256 code points (Python's len, which git_head.py applies), none of them C0 or DEL.
        /// A surrogate pair counts once, as on macOS and Linux.
        static bool Text(object v)
        {
            var s = v as string;
            if (s == null) return false;
            int points = 0;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c < 0x20 || c == 0x7f) return false;
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
                if (++points > 256) return false;
            }
            return true;
        }

        /// The arguments as canonical JSON for `--args=`, or null when the query is not allowed.
        public static string Arguments(string op, object raw)
        {
            string[] keys;
            if (op == null || !Ops.TryGetValue(op, out keys)) return null;
            var args = raw == null ? new Dictionary<string, object>() : raw as Dictionary<string, object>;
            if (args == null) return null;
            var clean = new Dictionary<string, object>();
            foreach (var pair in args)
            {
                if (Array.IndexOf(keys, pair.Key) < 0) return null;
                var v = pair.Value;
                if (pair.Key == "confirm" || pair.Key == "firstParent" || pair.Key == "recordLinks")
                {
                    if (!(v is bool)) return null;
                    clean[pair.Key] = v; continue;
                }
                if (pair.Key == "stages")
                {
                    var stages = v as List<object>;
                    if (stages == null || stages.Count < 1 || stages.Count > 3) return null;
                    foreach (var stage in stages)
                        if (!Equals(stage, "base") && !Equals(stage, "ours") && !Equals(stage, "theirs")) return null;
                    clean[pair.Key] = stages; continue;
                }
                if (pair.Key == "paths")
                {
                    var paths = v as List<object>;
                    if (paths == null || paths.Count < 1 || paths.Count > 256) return null;
                    foreach (var path in paths)
                        if (!Text(path)) return null;
                    clean[pair.Key] = paths; continue;
                }
                if (v is double)
                {
                    double d = (double)v;
                    if (d < 0 || d > 10000000 || d != Math.Floor(d)) return null;
                    clean[pair.Key] = (long)d; continue;
                }
                var list = v as List<object>;
                if (list != null)
                {
                    if ((pair.Key != "refs" && pair.Key != "revisions" && pair.Key != "known") || list.Count > 256) return null;
                    foreach (var item in list)
                        if (!Text(item) || (pair.Key != "refs" && !Policy.IsFullCommit((string)item))) return null;
                    clean[pair.Key] = list; continue;
                }
                if (!Text(v)) return null;
                clean[pair.Key] = v;
            }
            return Json.Write(clean);
        }

        /// git_head.py arguments (after the script path) for one query, or null when refused.
        public static List<string> CommandLine(string op, object raw, string project)
        {
            var json = Arguments(op, raw);
            if (json == null) return null;
            var args = new List<string> { "--project", project, "--query", op, "--args=" + json };
            if (op == "read") args.Add("--desktop-stream");
            return args;
        }
    }

    /// Windows path rules for paths that arrive from page code (recent files, library reloads).
    /// The host only ever hands the page canonical paths, so anything else is refused before
    /// the file system sees it: relative, drive-relative ("C:x"), device ("\\?\", "\\.\"),
    /// alternate data streams ("a.waffle:x"), "."/".." or empty components, wildcards,
    /// reserved device names (CON, NUL, COM1…) and components ending in a dot or space.
    public static class WinPath
    {
        static readonly HashSet<string> Reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
            "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM\u00b9", "COM\u00b2", "COM\u00b3",
            "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT\u00b9", "LPT\u00b2", "LPT\u00b3" };

        public static bool Acceptable(object value)
        {
            var p = value as string;
            if (string.IsNullOrEmpty(p) || p.Length > 4096 || Policy.Utf8Length(p) > 4096) return false;
            foreach (char c in p)
                if (c < 0x20 || c == '/' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') return false;
            string rest;
            int minimum = 1;
            if (p.Length >= 3 && IsLetter(p[0]) && p[1] == ':' && p[2] == '\\') rest = p.Substring(3);
            else if (p.StartsWith("\\\\", StringComparison.Ordinal))
            {
                rest = p.Substring(2);
                minimum = 3; // \\server\share\file
            }
            else return false;
            var parts = rest.Split('\\');
            if (parts.Length < minimum) return false;
            foreach (var part in parts)
            {
                if (part.Length == 0 || part == "." || part == ".." || part.IndexOf(':') >= 0) return false;
                if (part[part.Length - 1] == '.' || part[part.Length - 1] == ' ') return false;
                int dot = part.IndexOf('.');
                var stem = (dot >= 0 ? part.Substring(0, dot) : part).TrimEnd(' ');
                if (Reserved.Contains(stem)) return false;
            }
            return true;
        }

        static bool IsLetter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');

        /// Strips the \\?\ and \\?\UNC\ prefixes GetFinalPathNameByHandle returns.
        public static string FromFinalPath(string final)
        {
            if (final == null) return null;
            if (final.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + final.Substring(8);
            if (final.StartsWith("\\\\?\\", StringComparison.Ordinal)) return final.Substring(4);
            return final;
        }
    }
}
