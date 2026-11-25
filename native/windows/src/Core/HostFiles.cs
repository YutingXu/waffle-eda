// Host-side file state that page JavaScript can use but never name freely, ported from
// native/macos/ProjectWrites.swift and HostState.swift. The file system primitives sit behind
// IHostFs: WinFs (Win32, src/Win) in the app, a portable implementation in the tests.
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Waffle.Windows
{
    /// Volume + file id, size and last write time: a cheap "unchanged since we wrote it" check
    /// (the macOS/Linux hosts use dev, inode, size and mtime).
    public sealed class FileStamp : IEquatable<FileStamp>
    {
        public readonly string Identity;
        public readonly long Size;
        public readonly long Written;

        public FileStamp(string identity, long size, long written) { Identity = identity; Size = size; Written = written; }

        public bool Equals(FileStamp other) => other != null && other.Identity == Identity && other.Size == Size && other.Written == Written;
        public override bool Equals(object obj) => Equals(obj as FileStamp);
        public override int GetHashCode() => (Identity ?? "").GetHashCode() ^ Size.GetHashCode() ^ Written.GetHashCode();
    }

    public sealed class HostError : Exception
    {
        public HostError(string message) : base(message) { }
    }

    public enum EntryKind { None, File, FileLink, Directory, Other }

    public sealed class RegularRead
    {
        public byte[] Bytes;
        public DateTime ModifiedUtc;
        public string Identity;
    }

    /// A file kept open from the moment the user picked it (Altium copy sources).
    public interface IHeldFile : IDisposable
    {
        byte[] ReadAll();
        string Identity { get; }
    }

    public interface IHostFs
    {
        /// Comparer for canonical paths (case-insensitive on Windows).
        StringComparer PathComparer { get; }
        /// Absolute path with every link resolved. A missing final component resolves its parent.
        string Canonical(string path);
        /// Page input checked against the platform's path rules, then canonicalised; null if refused.
        string CheckedPath(object value);
        bool IsAbsolute(string path);
        string Name(string path);
        string Parent(string path);
        string Join(string folder, string name);
        /// Reads a file the user chose in a dialog (links followed), at most cap bytes.
        byte[] ReadFile(string path, long cap);
        /// Reads without following a link at the final component; throws HostError.
        RegularRead ReadRegular(string path, long cap, bool singleLink = false);
        /// Null when the file does not exist.
        byte[] ReadIfExists(string path);
        /// Fresh temporary beside the destination, flushed, then renamed over it (replacing a
        /// link rather than following it). privateFile restricts it to the current user.
        // Collaboration lock temporaries use the reserved lock suffix in the same directory.
        void AtomicWrite(string path, byte[] bytes, bool privateFile, DateTime? modifiedUtc = null, bool collaborationLock = false);
        /// An exclusive save lock on a folder shared by every Waffle process; null when busy.
        IDisposable TryLockFolder(string folder);
        /// What is at the path, without following a final link.
        EntryKind Kind(string path, out long size);
        bool IsFile(string path);
        /// Removes a file or a link to a file at exactly that name.
        void Unlink(string path);
        void EnsurePrivateFolder(string folder);
        IHeldFile OpenHeld(string path);
        /// Volume and file id of what the path points to; null when missing.
        string Identity(string path);
        /// Creates a file that does not exist yet (never through an existing entry or link);
        /// false when something is already at the path. Lock sidecars (CollabLocks).
        bool CreateNew(string path, byte[] bytes);
        /// The names of the files in a folder; empty when it cannot be listed.
        System.Collections.Generic.IList<string> ListNames(string folder);
        /// Last write time of a file, or null.
        DateTime? ModifiedUtc(string path);
        /// Identity, size and last write time of a regular file (not a link or folder), or null.
        FileStamp Stamp(string path);
        /// Like AtomicWrite, but never replaces anything: false when something is already at the
        /// path (MoveFileEx without MOVEFILE_REPLACE_EXISTING; link(2) elsewhere).
        bool AtomicCreate(string path, byte[] bytes);
    }

    static class Digest
    {
        public static byte[] Of(byte[] bytes) { using (var sha = SHA256.Create()) return sha.ComputeHash(bytes); }
        public static bool Same(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }
    }

    public sealed class AltiumCopySource : IDisposable
    {
        readonly IHostFs fs;
        readonly IHeldFile held;
        public readonly string Token = Guid.NewGuid().ToString();
        public readonly string Path;
        readonly string canonical;

        public AltiumCopySource(IHostFs fs, string path)
        {
            this.fs = fs;
            Path = path;
            canonical = fs.Canonical(path);
            held = fs.OpenHeld(path);
        }

        public string ExtensionOf => Policy.Extension(Path);

        public byte[] Read() => held.ReadAll();

        public void SaveCopy(byte[] bytes, string selected)
        {
            var destination = fs.Canonical(selected);
            var existing = fs.Identity(destination);
            var current = fs.Identity(Path);
            bool aliases = existing != null && (existing == held.Identity || existing == current);
            if (fs.PathComparer.Equals(selected, Path) || fs.PathComparer.Equals(destination, canonical) || aliases)
                throw new HostError("Choose a different destination. This is the original Altium source.");
            if (Policy.Extension(selected) != Policy.Extension(Path))
                throw new HostError("The exported copy must have the same extension as its source.");
            fs.AtomicWrite(destination, bytes, false);
        }

        public void Dispose() => held.Dispose();
    }

    /// The host's own lists live in one private folder (%LOCALAPPDATA%\Waffle on Windows).
    public static class HostLists
    {
        public static List<Dictionary<string, object>> Load(IHostFs fs, string folder, string name, long cap = 1024 * 1024)
        {
            var result = new List<Dictionary<string, object>>();
            try
            {
                var read = fs.ReadRegular(fs.Join(folder, name), cap);
                var list = Json.Parse(Encoding.UTF8.GetString(read.Bytes)) as List<object>;
                if (list == null) return result;
                foreach (var item in list) { var d = item as Dictionary<string, object>; if (d != null) result.Add(d); }
            }
            catch (Exception) { /* a missing or damaged list is an empty one */ }
            return result;
        }

        public static void Store(IHostFs fs, string folder, string name, IEnumerable<Dictionary<string, object>> items)
        {
            try
            {
                fs.EnsurePrivateFolder(folder);
                fs.AtomicWrite(fs.Join(folder, name), Encoding.UTF8.GetBytes(Json.Write(items)), true);
            }
            catch (Exception) { /* a list that can't be stored only costs the user a menu entry */ }
        }
    }

    /// Recent projects: canonical paths opened or saved through the host.
    public sealed class RecentProjects
    {
        const string File = "recent-projects.json";
        readonly IHostFs fs;
        readonly string folder;
        public readonly List<KeyValuePair<string, double>> Entries = new List<KeyValuePair<string, double>>(); // path, openedAt

        public RecentProjects(IHostFs fs, string folder)
        {
            this.fs = fs;
            this.folder = folder;
            foreach (var item in HostLists.Load(fs, folder, File))
            {
                var path = item.ContainsKey("path") ? item["path"] as string : null;
                if (path == null || !fs.IsAbsolute(path) || !Policy.IsProject(path)) continue;
                double opened = item.ContainsKey("openedAt") && item["openedAt"] is double ? (double)item["openedAt"] : 0;
                Entries.Add(new KeyValuePair<string, double>(path, opened));
                if (Entries.Count == Policy.RecentLimit) break;
            }
        }

        public void Note(string path, DateTime? when = null)
        {
            string canonical;
            try { canonical = fs.Canonical(path); } catch (HostError) { return; }
            if (!Policy.IsProject(canonical)) return;
            var stamp = Math.Round(((when ?? DateTime.UtcNow).ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
            Entries.RemoveAll(e => fs.PathComparer.Equals(e.Key, canonical));
            Entries.Insert(0, new KeyValuePair<string, double>(canonical, stamp));
            if (Entries.Count > Policy.RecentLimit) Entries.RemoveRange(Policy.RecentLimit, Entries.Count - Policy.RecentLimit);
            Save();
        }

        public void Clear() { Entries.Clear(); Save(); }

        /// Cached Welcome metadata skips filesystem checks. Opening validates the selected path.
        public List<object> Listing(bool checkAvailability = true)
        {
            var list = new List<object>();
            foreach (var e in Entries)
                if (!checkAvailability || fs.IsFile(e.Key))
                    list.Add(new Dictionary<string, object> { { "name", fs.Name(e.Key) }, { "path", e.Key }, { "openedAt", e.Value } });
            return list;
        }

        /// The path for a page-supplied value, only if it is a remembered project that is still a regular file.
        public string Allowed(object value)
        {
            var path = fs.CheckedPath(value);
            if (path == null || !Entries.Exists(e => fs.PathComparer.Equals(e.Key, path)))
                throw new HostError("That project is not in the recent files list.");
            long size;
            if (fs.Kind(path, out size) != EntryKind.File) throw new HostError("That recent project is no longer available.");
            if (size > Policy.ProjectReadCap) throw new HostError("The file is too large.");
            return path;
        }

        void Save()
        {
            var items = new List<Dictionary<string, object>>();
            foreach (var e in Entries)
                items.Add(new Dictionary<string, object> { { "name", fs.Name(e.Key) }, { "path", e.Key }, { "openedAt", e.Value } });
            HostLists.Store(fs, folder, File, items);
        }
    }

    /// Library files (.atrlib, .json) chosen in an open dialog for the library sources, readable again later.
    public sealed class LibraryReads
    {
        const string File = "library-sources.json";
        readonly IHostFs fs;
        readonly string folder;
        readonly List<string> paths = new List<string>();
        readonly object gate = new object();

        public LibraryReads(IHostFs fs, string folder)
        {
            this.fs = fs;
            this.folder = folder;
            foreach (var item in HostLists.Load(fs, folder, File))
            {
                var path = item.ContainsKey("path") ? item["path"] as string : null;
                if (path != null && fs.IsAbsolute(path) && paths.Count < Policy.AllowLimit) paths.Add(path);
            }
        }

        public void Remember(string path)
        {
            string canonical;
            try { canonical = fs.Canonical(path); } catch (HostError) { return; }
            if (!Policy.LibraryTypes.Contains(Policy.Extension(canonical))) return;
            var items = new List<Dictionary<string, object>>();
            lock (gate)
            {
                paths.RemoveAll(p => fs.PathComparer.Equals(p, canonical));
                paths.Insert(0, canonical);
                if (paths.Count > Policy.AllowLimit) paths.RemoveRange(Policy.AllowLimit, paths.Count - Policy.AllowLimit);
                foreach (var p in paths) items.Add(new Dictionary<string, object> { { "path", p } });
            }
            HostLists.Store(fs, folder, File, items);
        }

        /// The file's name and text, if the canonical path was chosen before, has a library
        /// extension, is a regular file under the size cap and holds a JSON object.
        public Dictionary<string, object> Read(object value)
        {
            var path = fs.CheckedPath(value);
            bool known;
            lock (gate) known = path != null && paths.Exists(p => fs.PathComparer.Equals(p, path));
            if (!known) throw new HostError("Open this library file again with Open library file… to allow reloading it.");
            if (!Policy.LibraryTypes.Contains(Policy.Extension(path))) throw new HostError("Only .atrlib and .json library files can be reloaded.");
            var read = fs.ReadRegular(path, Policy.LibraryReadCap);
            string text;
            try { text = new UTF8Encoding(false, true).GetString(read.Bytes); }
            catch (ArgumentException) { throw new HostError("This is not a JSON library file."); }
            object parsed = null;
            try { parsed = Json.Parse(text.TrimStart((char)0xFEFF)); } catch (JsonException) { }
            if (!(parsed is Dictionary<string, object>)) throw new HostError("This is not a JSON library file.");
            return new Dictionary<string, object> { { "name", fs.Name(path) }, { "path", path }, { "text", text } };
        }
    }

    /// The one-time copy of a project file before its first save after a major format migration
    /// (app/compat.js, docs/format-versioning.md): "<file>.v<major.minor>.bak" beside it, holding the
    /// bytes on disk. The page names only the version; the host knows the file. An existing backup
    /// is never replaced.
    /// Runs jobs one at a time, in order, away from the UI thread.
    public sealed class SerialQueue
    {
        Task tail = Task.FromResult(true);
        readonly object gate = new object();

        public void Post(Action job)
        {
            lock (gate) tail = tail.ContinueWith(_ => { try { job(); } catch (Exception) { } }, CancellationToken.None,
                                                 TaskContinuationOptions.None, TaskScheduler.Default);
        }

        public void Wait(int milliseconds = 5000) { Task t; lock (gate) t = tail; t.Wait(milliseconds); }

        /// Runs job on the queue and waits for its result (never call it from a job on this queue).
        public T Sync<T>(Func<T> job)
        {
            var done = new TaskCompletionSource<T>();
            Post(() => { try { done.SetResult(job()); } catch (Exception e) { done.SetException(e); } });
            try { return done.Task.Result; }
            catch (AggregateException e) { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw(); throw; }
        }
    }
}
