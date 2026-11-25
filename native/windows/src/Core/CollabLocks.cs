// Document lock and presence sidecars beside the open project (docs/collaboration.md,
// app/project/collab-lock.js), ported from CollabLocks in native/macos/HostState.swift and native/linux/waffle.py.
// Names: "<name>.waffle.<key>.waffle-lock", key 1-64 letters, digits, "-" or "_" starting with a
// letter or digit; the only names written, always in the project's own folder, never through a
// link at the final component. The host fills in a random machine id (made once, in the support
// folder), its session id, process id and write time; the page supplies a small JSON object.
// Created exclusively, replaced only by the owning session (or an explicit take-over) and
// removed only by the owning session.
using System;
using System.Collections.Generic;
using System.Text;

namespace Waffle.Windows
{
    public sealed class CollabLocks
    {
        static string SuffixFor(string project) => ".waffle-lock";
        internal static string PendingName(string nonce) => ".waffle.pending-" + nonce + ".waffle-lock";
        public const int TextCap = 16 * 1024, DataCap = 8 * 1024, ListCap = 256;
        readonly IHostFs fs;
        readonly string supportFolder;
        string machine;
        public readonly string Session = Guid.NewGuid().ToString();

        public CollabLocks(IHostFs fs, string supportFolder) { this.fs = fs; this.supportFolder = supportFolder; }

        public static string ValidKey(object value)
        {
            var key = value as string;
            if (key == null || key.Length < 1 || key.Length > 64) return null;
            Func<char, bool> alnum = c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            if (!alnum(key[0])) return null;
            foreach (var c in key) if (!alnum(c) && c != '-' && c != '_') return null;
            return key;
        }

        public string PathFor(string project, string key)
        {
            var canonical = fs.Canonical(project);
            return fs.Join(fs.Parent(canonical), fs.Name(canonical) + "." + key + SuffixFor(canonical));
        }

        public string Machine
        {
            get
            {
                if (machine != null) return machine;
                var file = fs.Join(supportFolder, "machine-id");
                try
                {
                    var text = Encoding.ASCII.GetString(fs.ReadRegular(file, 128).Bytes).Trim();
                    if (text.Length >= 16 && text.Length <= 64 && ValidKey(text) != null) machine = text;
                }
                catch (Exception) { }
                if (machine == null)
                {
                    machine = Guid.NewGuid().ToString();
                    try { fs.EnsurePrivateFolder(supportFolder); fs.AtomicWrite(file, Encoding.ASCII.GetBytes(machine), true); } catch (Exception) { }
                }
                return machine;
            }
        }

        static double Millis(DateTime utc) => Math.Round((utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);

        static void CheckProject(string project)
        {
            if (project == null || !Policy.IsProjectExtension(Policy.Extension(project))) throw new HostError("No project file is open.");
        }

        public Dictionary<string, object> Listing(string project)
        {
            CheckProject(project);
            var canonical = fs.Canonical(project);
            var folder = fs.Parent(canonical);
            var prefix = fs.Name(canonical) + ".";
            var suffix = SuffixFor(canonical);
            var locks = new List<object>();
            var names = new List<string>(fs.ListNames(folder));
            names.Sort(StringComparer.Ordinal);
            foreach (var name in names)
            {
                if (locks.Count >= ListCap) break;
                if (!name.StartsWith(prefix, fs.PathComparer == StringComparer.OrdinalIgnoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)
                    || !name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                var key = name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length);
                if (ValidKey(key) == null) continue;
                try
                {
                    var read = fs.ReadRegular(fs.Join(folder, name), TextCap);
                    locks.Add(new Dictionary<string, object> { { "key", key }, { "text", new UTF8Encoding(false, true).GetString(read.Bytes) }, { "modified", Millis(read.ModifiedUtc) } });
                }
                catch (Exception) { }
            }
            var result = new Dictionary<string, object> { { "session", Session }, { "machine", Machine }, { "now", Millis(DateTime.UtcNow) }, { "locks", locks } };
            long size;
            if (fs.Kind(canonical, out size) == EntryKind.File)
            {
                var modified = fs.ModifiedUtc(canonical);
                if (modified != null) result["project"] = new Dictionary<string, object> { { "size", (double)size }, { "modified", Millis(modified.Value) } };
            }
            return result;
        }

        // Whether a lock exists and the session it names (null when unreadable).
        bool Current(string path, out string session)
        {
            session = null;
            long size;
            var kind = fs.Kind(path, out size);
            if (kind == EntryKind.None) return false;
            if (kind != EntryKind.File) return true;
            try
            {
                var value = Json.Parse(Encoding.UTF8.GetString(fs.ReadRegular(path, TextCap).Bytes)) as Dictionary<string, object>;
                object s;
                if (value != null && value.TryGetValue("session", out s)) session = s as string;
            }
            catch (Exception) { }
            return true;
        }

        public byte[] Record(object data)
        {
            var text = data as string;
            if (text == null || Policy.Utf8Length(text) > DataCap) throw new HostError("Lock data must be a small JSON object.");
            Dictionary<string, object> value;
            try { value = Json.Parse(text) as Dictionary<string, object>; }
            catch (JsonException) { value = null; }
            if (value == null) throw new HostError("Lock data must be a small JSON object.");
            var record = new SortedDictionary<string, object>(StringComparer.Ordinal) {
                { "atrium-lock", 1 }, { "data", value }, { "machine", Machine }, { "pid", (long)System.Diagnostics.Process.GetCurrentProcess().Id },
                { "session", Session }, { "written", Millis(DateTime.UtcNow) } };
            return Encoding.UTF8.GetBytes(Json.Write(new Dictionary<string, object>(record)));
        }

        /// mode "create" (exclusive), "replace" (own lock only) or "takeover" (the user confirmed).
        public Dictionary<string, object> Write(string project, object keyValue, object data, object mode)
        {
            CheckProject(project);
            var key = ValidKey(keyValue);
            if (key == null) throw new HostError("Invalid lock name.");
            var bytes = Record(data);
            var path = PathFor(project, key);
            var m = mode as string;
            if (m == "create")
            {
                if (!fs.CreateNew(path, bytes)) return new Dictionary<string, object> { { "written", false }, { "exists", true } };
                return new Dictionary<string, object> { { "written", true } };
            }
            if (m == "replace" || m == "takeover")
            {
                string session;
                bool exists = Current(path, out session);
                if (m == "replace")
                {
                    if (!exists) return new Dictionary<string, object> { { "written", false }, { "missing", true } };
                    if (session != Session) return new Dictionary<string, object> { { "written", false }, { "owner", false } };
                }
                long size;
                var kind = fs.Kind(path, out size);
                if (kind != EntryKind.None && kind != EntryKind.File && kind != EntryKind.FileLink) throw new HostError("The lock path is not a file.");
                fs.AtomicWrite(path, bytes, false, collaborationLock: true);
                return new Dictionary<string, object> { { "written", true } };
            }
            throw new HostError("Unknown lock mode.");
        }

        public Dictionary<string, object> Remove(string project, object keyValue, bool force)
        {
            CheckProject(project);
            var key = ValidKey(keyValue);
            if (key == null) throw new HostError("Invalid lock name.");
            var path = PathFor(project, key);
            string session;
            if (!Current(path, out session)) return new Dictionary<string, object> { { "removed", false } };
            if (!force && session != Session) return new Dictionary<string, object> { { "removed", false }, { "owner", false } };
            long size;
            var kind = fs.Kind(path, out size);
            if (kind != EntryKind.File && kind != EntryKind.FileLink) return new Dictionary<string, object> { { "removed", false } };
            fs.Unlink(path);
            return new Dictionary<string, object> { { "removed", true } };
        }

        /// Closing the project or the window removes this session's sidecars.
        public void RemoveOwn(string project)
        {
            if (project == null || !Policy.IsProjectExtension(Policy.Extension(project))) return;
            try
            {
                foreach (var item in (List<object>)Listing(project)["locks"])
                {
                    var lockInfo = (Dictionary<string, object>)item;
                    try
                    {
                        var value = Json.Parse((string)lockInfo["text"]) as Dictionary<string, object>;
                        object s;
                        if (value != null && value.TryGetValue("session", out s) && s as string == Session) Remove(project, lockInfo["key"], false);
                    }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
        }
    }
}
