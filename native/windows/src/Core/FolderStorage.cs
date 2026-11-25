// A native grant pins its selected directory. Every subsequent operation pins and validates
// each parent and works from exact directory entries rather than case-insensitive aliases.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Waffle.Windows
{
    internal interface IFolderDraftIdentity
    {
        string RecoveryIdentity(string root);
    }

    internal interface IFolderPlatform
    {
        bool ReadHandlesPreventChanges { get; }
        IDisposable PinDirectory(string absolute);
        Stream OpenRegular(string absolute);
        IDisposable TryBarrier(string absolute, bool directory, bool writer);
        void SyncDirectory(string absolute, IDisposable heldDirectory = null);
        void MoveEntry(string from, string to, bool replace);
        void DeleteEntry(string path);
        FileStream NewFile(string absolute, bool isPrivate);
        void CheckWritableVolume(string root);
    }

    internal sealed class FolderHandleSet : IDisposable
    {
        readonly List<IDisposable> items = new List<IDisposable>();
        internal void Add(IDisposable item) => items.Add(item);
        public void Dispose() { for (int i = items.Count - 1; i >= 0; i--) items[i].Dispose(); items.Clear(); }
    }

    internal sealed class FolderConflict : IOException
    {
        internal readonly string Target;
        internal FolderConflict(string target) : base("The project changed on disk at " + target + ".") { Target = target; }
    }

    internal sealed class FolderStorage : IDisposable
    {
        internal readonly string Journal;
        internal string Active => Journal + "/active";
        string Lock => Journal + "/lock";
        internal readonly string Root, Manifest;
        internal readonly IFolderPlatform Platform;
        readonly FolderHandleSet anchor = new FolderHandleSet();
        internal FolderStorage(IFolderPlatform platform, string root, string manifest, bool standalone = false)
        {
            Root = Path.GetFullPath(root); Platform = platform;
            if (FolderFormat.PathName(manifest).Contains("/") || (standalone
                ? manifest.StartsWith(".", StringComparison.Ordinal) || FolderFormat.StandaloneKind(manifest) == null
                : !manifest.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase) || manifest.Equals(".waffle", StringComparison.OrdinalIgnoreCase)))
                throw FolderFormat.Invalid("bound filename");
            Manifest = manifest;
            Journal = ".waffle/journal";
            if (standalone)
            {
                for (string p = Root; p != null; p = Path.GetDirectoryName(p))
                    if (FolderFormat.StandaloneKind(Path.GetFileName(p)) != null)
                        throw FolderFormat.Invalid("document filename used as a directory");
                // Hash the same UTF-8 filename bytes as the other native hosts.
                var leaf = new string(manifest.Select(c => c >= 'A' && c <= 'Z' ? (char)(c + ('a' - 'A')) : c).ToArray());
                Journal += "/member-" + FolderFormat.Sha(FolderFormat.Utf8.GetBytes(leaf));
            }
            var ancestors = new Stack<string>();
            for (string p = Root; p != null; p = Path.GetDirectoryName(p)) ancestors.Push(p);
            try { while (ancestors.Count > 0) anchor.Add(platform.PinDirectory(ancestors.Pop())); }
            catch { anchor.Dispose(); throw; }
        }
        public void Dispose() => anchor.Dispose();
        internal string Absolute(string path) => Path.Combine(Root, path.Replace('/', Path.DirectorySeparatorChar));
        internal static string Parent(string path) { var i = path.LastIndexOf('/'); return i < 0 ? "" : path.Substring(0, i); }
        internal static string Name(string path) => path.Substring(path.LastIndexOf('/') + 1);
        static string Actual(string parent, string name)
        {
            // WIN32_FIND_DATA filtering alone can match DOS short names. Compare the enumerated long name.
            string found = null;
            foreach (var entry in Directory.EnumerateFileSystemEntries(parent))
            {
                var n = Path.GetFileName(entry);
                if (!string.Equals(n.Normalize(NormalizationForm.FormC), name, StringComparison.OrdinalIgnoreCase)) continue;
                if (found != null || !n.IsNormalized(NormalizationForm.FormC)) throw new FolderConflict(name);
                found = n;
            }
            return found;
        }
        internal IDisposable Parents(string path, bool create, out bool present, IDisposable rootWriter = null)
        {
            FolderFormat.PathName(path);
            string current = Root;
            var guards = new FolderHandleSet(); present = true;
            try
            {
                foreach (string name in path.Split('/').Reverse().Skip(1).Reverse())
                {
                    var exact = Actual(current, name); var next = Path.Combine(current, name);
                    if (exact == null)
                    {
                        if (!create) { present = false; break; }
                        Directory.CreateDirectory(next);
                        guards.Add(Platform.PinDirectory(next));
                        Platform.SyncDirectory(current, current == Root ? rootWriter : null);
                    }
                    else
                    {
                        if (exact != name) throw new FolderConflict(path);
                        guards.Add(Platform.PinDirectory(next));
                    }
                    current = next;
                }
                return guards;
            }
            catch { guards.Dispose(); throw; }
        }
        internal string Spelling(string path)
        {
            using (Parents(path, false, out var exists)) return exists ? Actual(Absolute(Parent(path)), Name(path)) : null;
        }
        internal Stream Open(string path)
        {
            using (Parents(path, false, out var exists))
            {
                if (!exists) return null;
                var actual = Actual(Absolute(Parent(path)), Name(path));
                if (actual == null || actual != Name(path)) return null;
                return Platform.OpenRegular(Absolute(path));
            }
        }
        internal static byte[] Bytes(Stream stream, long limit)
        {
            if (stream.Length > limit || stream.Length > int.MaxValue) throw FolderFormat.Invalid("file size");
            var bytes = new byte[(int)stream.Length];
            int done = 0;
            while (done < bytes.Length)
            {
                int n = stream.Read(bytes, done, bytes.Length - done);
                if (n == 0) throw FolderFormat.Invalid("short read");
                done += n;
            }
            if (stream.ReadByte() != -1) throw FolderFormat.Invalid("changed file length");
            return bytes;
        }
        internal byte[] Read(string path, long limit = FolderFormat.MaxFile)
        {
            using (var file = Open(path)) return file == null ? null : Bytes(file, limit);
        }
        internal string Hash(string path, out long length)
        {
            length = 0;
            using (var stream = Open(path))
            {
                if (stream == null) return null;
                length = stream.Length;
                if (length > FolderFormat.MaxFile) throw FolderFormat.Invalid("file size");
                using (var sha = System.Security.Cryptography.SHA256.Create()) return FolderFormat.Hex(sha.ComputeHash(stream));
            }
        }
        IDisposable StableLock(bool writer, IDisposable parents)
        {
            var held = new FolderHandleSet(); held.Add(parents);
            try
            {
                var range = Platform.TryBarrier(Absolute(Lock), false, writer);
                if (range == null) throw new HostError("A project read or save is still in progress.");
                held.Add(range); return held;
            }
            catch { held.Dispose(); throw; }
        }
        internal IDisposable Barrier(bool writer)
        {
            if (writer) Platform.CheckWritableVolume(Root);
            var parents = Parents(Lock, false, out var present);
            try
            {
                if (present && Spelling(Lock) == "lock")
                {
                    var held = parents; parents = null;
                    return StableLock(writer, held);
                }
            }
            finally { parents?.Dispose(); }
            var bootstrap = Platform.TryBarrier(Root, true, writer) ?? throw new HostError("A project read or save is still in progress.");
            try
            {
                parents = Parents(Lock, writer, out present, writer ? bootstrap : null);
                var exact = present ? Spelling(Lock) : null;
                if (exact != null && exact != "lock") throw FolderFormat.Invalid("journal lock");
                if (exact == null && !writer) { var held = bootstrap; bootstrap = null; return held; }
                if (exact == null)
                {
                    using (var file = Platform.NewFile(Absolute(Lock), true)) file.Flush(true);
                    Platform.SyncDirectory(Absolute(Journal));
                }
                var guards = parents; parents = null; return StableLock(writer, guards);
            }
            finally { parents?.Dispose(); bootstrap?.Dispose(); }
        }
        internal void WriteTemp(string path, Action<Stream> write, bool isPrivate, Action afterWrite, Action afterFlush)
        {
            using (Parents(path, true, out _))
            using (var file = Platform.NewFile(Absolute(path), isPrivate))
            {
                write(file); afterWrite?.Invoke(); file.Flush(true); afterFlush?.Invoke();
            }
        }
        internal void Move(string from, string to, bool replace)
        {
            using (Parents(from, false, out var source))
            using (Parents(to, true, out _))
            {
                if (!source || Spelling(from) != Name(from)) throw FolderFormat.Invalid("temporary");
                Platform.MoveEntry(Absolute(from), Absolute(to), replace);
            }
        }
        internal void Delete(string path)
        {
            using (Parents(path, false, out var present))
                if (present && Spelling(path) == Name(path)) Platform.DeleteEntry(Absolute(path));
        }
        internal void SyncParent(string path)
        {
            using (Parents(path, false, out var present))
                if (present) Platform.SyncDirectory(Absolute(Parent(path)));
        }
        internal string[] Orphans()
        {
            using (Parents(Journal + "/member", false, out var present))
            {
                if (!present) return Array.Empty<string>();
                return Directory.EnumerateDirectories(Absolute(Journal)).Select(Path.GetFileName)
                    .Where(n => Guid.TryParseExact(n, "D", out var id) && id.ToString("D") == n).Take(256).ToArray();
            }
        }
        internal void ReclaimOrphans()
        {
            if (Spelling(Active) != null) return;
            foreach (var tx in Orphans())
            {
                try { Clean(tx, true); } catch (Exception e) when (e is IOException || e is HostError || e is UnauthorizedAccessException) { }
            }
        }
        internal void Clean(string transaction, bool orphan = false)
        {
            string dir = Journal + "/" + transaction;
            using (Parents(dir + "/member", false, out var present))
            {
                if (!present) return;
                var entries = Directory.EnumerateFileSystemEntries(Absolute(dir)).Select(Path.GetFileName).ToList();
                foreach (var name in entries)
                {
                    if (!FolderFormat.IsDigest(name) && name != "descriptor" &&
                        !System.Text.RegularExpressions.Regex.IsMatch(name, @"^install-[0-9]+\z")) return;
                    var relative = dir + "/" + name;
                    using (var verified = Open(relative)) if (verified == null) return;
                    if (orphan && FolderFormat.IsDigest(name) && Hash(relative, out _) != name) return;
                }
                foreach (var name in entries) Delete(dir + "/" + name);
            }
            using (Parents(dir, false, out _)) Directory.Delete(Absolute(dir), false);
        }
    }
}
