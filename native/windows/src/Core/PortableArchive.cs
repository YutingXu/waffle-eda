// Portable copies and ordinary ZIP extraction work on a stock Windows desktop. Only
// resolving a repository-backed original delegates to the optional Git/Python helper.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    using Map=Dictionary<string,object>;
    internal static class PortableArchive
    {
        const string Ignore=".waffle/.gitignore", Imports=".waffle/imports/";
        const string Snapshot="application/vnd.waffle.snapshot+jsonl";
        static readonly Regex Index=new Regex(@"^\.waffle/imports/[0-9a-f]{64}/bindings-[a-zA-Z0-9_-]{1,100}\.json\z");
        static string Text(Map o,string key)=>FolderFormat.Text(o,key);
        static HostError Invalid(string detail)=>new HostError("Invalid portable project "+detail+".");
        static string Source(string sha)=>Imports+sha+"/source";
        static byte[] EntryData(Map entry) {
            var encoded=Text(entry,"data");
            if(encoded==null||encoded.Length>(FolderFormat.MaxFile+2)/3*4)throw Invalid("member size");
            var data=Convert.FromBase64String(encoded);
            if(data.Length>FolderFormat.MaxFile)throw Invalid("member size");
            return data;
        }
        static HashSet<string> FutureDocuments(byte[] manifest) {
            var allowed=new HashSet<string>(StringComparer.Ordinal);
            using(var records=FolderFormat.Records(manifest).GetEnumerator()) {
                if(!records.MoveNext())throw Invalid("manifest header");
                var version=Text(records.Current,"formatVersion");
                if(!FolderFormat.IsManifest(records.Current)||!Regex.IsMatch(version,@"^2\.0*[1-9][0-9]*\z"))return allowed;
                while(records.MoveNext()) {
                    var row=records.Current;
                    if(Text(row,"kind")!="document")continue;
                    var kind=Text(row,"docKind");
                    if(kind=="schematic"||kind=="pcb"||kind=="drawing"||kind=="panel")continue;
                    var path=FolderFormat.PathName(Text(row,"path"));
                    var parts=path.Split('/');
                    if(parts.Any(part=>part.StartsWith(".",StringComparison.Ordinal)||Regex.IsMatch(part,@"^git~[1-9]\z",RegexOptions.IgnoreCase))||
                        new[]{"assets","models","libraries"}.Contains(parts[0],StringComparer.OrdinalIgnoreCase))throw Invalid("future document path");
                    allowed.Add(path);
                }
            }
            return allowed;
        }
        static string Repository(string directory) {
            for(var d=new DirectoryInfo(directory);d!=null;d=d.Parent)
                if(File.Exists(Path.Combine(d.FullName,".git"))||Directory.Exists(Path.Combine(d.FullName,".git")))return d.FullName;
            return null;
        }
        static string Fold(string s)=>s.Normalize(NormalizationForm.FormC).ToUpperInvariant();
        static void Visit(object node,Action<string,string,string> add) {
            if(node is Map value) {
                if(value.ContainsKey("mediaType")&&value.ContainsKey("byteLength")&&value.ContainsKey("sha256")) {
                    var sha=Text(value,"sha256");if(!FolderFormat.IsDigest(sha))throw Invalid("asset reference");
                    var media=Text(value,"mediaType");FolderFormat.Number(value["byteLength"],FolderFormat.MaxFile);
                    add(media=="model/step"?"models/"+sha+".step.gz":"assets/"+sha,media==Snapshot?"snapshot":null,null);
                } else foreach(var x in value.Values)Visit(x,add);
            }else if(node is List<object> list)foreach(var item in list)Visit(item,add);
        }
        static byte[] Logical(byte[] bytes) {
            if(Array.IndexOf(bytes,(byte)13)<0)return bytes;
            return FolderFormat.Utf8.GetBytes(FolderFormat.Utf8.GetString(bytes).Replace("\r\n","\n"));
        }
        static void Frame(Stream s,long n,int length){
            for(int i=length-1;i>=0;i--)s.WriteByte((byte)(n>>(i*8)));
        }
        static string Version(FolderStorage store,ICollection<string> paths) {
            var required=new Dictionary<string,(string kind,string id)>(StringComparer.Ordinal);
            var pending=new Queue<string>();
            void Add(string path,string kind,string id) {
                if(path==null||!paths.Contains(path))throw Invalid("missing member "+path);
                if(required.TryGetValue(path,out var old)) {
                    if(old.kind!=kind||old.id!=id)throw Invalid("inconsistent references to "+path);
                    return;
                }
                required[path]=(kind,id);if(kind!=null)pending.Enqueue(path);
            }
            Add(store.Manifest,"project",null);
            while(pending.Count>0) {
                var path=pending.Dequeue();var desc=required[path];bool archived=path.StartsWith("assets/",StringComparison.Ordinal);
                using(var e=FolderFormat.Records(store.Read(path)).GetEnumerator()) {
                    if(!e.MoveNext()||Text(e.Current,"kind")!=desc.kind||desc.id!=null&&Text(e.Current,"id")!=desc.id||
                        !Regex.IsMatch(Text(e.Current,"formatVersion")??"",@"^2\.[0-9]+\z"))throw Invalid("member header "+path);
                    if(desc.kind!="importBindings")Visit(e.Current,Add);
                    while(e.MoveNext()) {
                        var row=e.Current;var tag=Text(row,"kind");
                        if(desc.kind=="importBindings"){
                            if(tag=="input"){
                                var sha=Text(row,"sha256");if(!FolderFormat.IsDigest(sha))throw Invalid("retained source");
                                Add(Source(sha),null,null);
                            }
                        }else if(desc.kind=="snapshot"&&tag=="snapshotMember"){
                            var asset=FolderFormat.Get(row,"asset") as Map;
                            if(asset==null||!FolderFormat.IsDigest(Text(asset,"sha256")))throw Invalid("frozen member");
                            Add("assets/"+Text(asset,"sha256"),Text(row,"fileKind"),Text(row,"ownerId"));
                        }else{
                            if(desc.kind=="project"&&!archived){
                                var kind=tag=="document"?Text(row,"docKind"):tag=="library"?"library":tag=="layoutBlock"?"block":tag=="importIndex"?"importBindings":null;
                                if(kind!=null)Add(Text(row,"path"),kind,Text(row,"id"));
                            }
                            Visit(row,Add);
                        }
                    }
                }
            }
            if(paths.Count!=required.Count+1||!paths.Contains(Ignore))throw Invalid("member set");
            var manifest=Logical(store.Read(store.Manifest));
            using(var frame=new MemoryStream()){
                void Bytes(byte[] b)=>frame.Write(b,0,b.Length);
                Bytes(Encoding.ASCII.GetBytes("WAFFLE-PROJECT-V1\0"));Frame(frame,manifest.Length,8);Bytes(manifest);
                Frame(frame,required.Count-1,8);
                // UTF-8 bytes order by Unicode scalar value. An ordinal UTF-16 sort differs for supplementary characters.
                foreach(var p in required.Keys.Where(x=>x!=store.Manifest).OrderBy(x=>BitConverter.ToString(FolderFormat.Utf8.GetBytes(x)),StringComparer.Ordinal)) {
                    var raw=store.Read(p);var code=FolderFormat.Utf8.GetBytes(p);
                    if(p.StartsWith("models/",StringComparison.Ordinal)){
                        using(var zipped=new MemoryStream(raw))
                        using(var inflated=new GZipStream(zipped,CompressionMode.Decompress))
                        using(var sha=SHA256.Create()){
                            byte[] buffer=new byte[65536];long size=0;int count;
                            while((count=inflated.Read(buffer,0,buffer.Length))>0){
                                size+=count;if(size>FolderFormat.MaxFile)throw Invalid("model length");
                                sha.TransformBlock(buffer,0,count,buffer,0);
                            }
                            sha.TransformFinalBlock(Array.Empty<byte>(),0,0);
                            if(!p.StartsWith("models/"+FolderFormat.Hex(sha.Hash)+".",StringComparison.Ordinal))throw Invalid("model digest");
                        }
                    }else if(p.StartsWith("assets/",StringComparison.Ordinal)||p.EndsWith("/source",StringComparison.Ordinal)){
                        var hash=FolderFormat.Sha(raw);if(p!="assets/"+hash&&p!=Source(hash))throw Invalid("stored content digest");
                    }else raw=Logical(raw);
                    Frame(frame,code.Length,4);Bytes(code);Bytes(Digest.Of(raw));
                }
                return FolderFormat.Sha(frame.ToArray());
            }
        }
        internal static object Run(IFolderPlatform fs,string action,Map q) {
            if(ImportExportStore.Handles(action))return ImportExportStore.Run(fs,action,q);
            if(action=="locate"){
                var destination=Repository(Text(q,"root"));var source=Repository(Path.GetDirectoryName(Text(q,"source")));
                if(source!=null&&string.Equals(source,destination,StringComparison.OrdinalIgnoreCase))
                    throw new HostError("This source is in the project repository. Install Python 3 and Git to verify its immutable source revision.");
                return new Map{["git"]=null};
            }
            if(action=="ignore")return new Map{["notice"]=Repository(Text(q,"root"))==null?null:"Git ignore rules could not be checked. Install Python 3 and Git to verify them."};
            if(action=="original"){
                using(var source=new FolderStorage(fs,Text(q,"root"),Text(q,"manifest"))){
                    var binding=Text(q,"bindingPath");var id=Text(q,"inputId");
                    if(binding==null||!Index.IsMatch(binding)||!Regex.IsMatch(id??"",@"^input-\d{6}\z"))throw Invalid("source binding");
                    var index=FolderFormat.Members(source.Read(source.Manifest)).SingleOrDefault(m=>Text(m,"kind")=="importIndex"&&Text(m,"path")==binding);
                    if(index==null)throw Invalid("unreferenced source");
                    var rows=FolderFormat.Records(source.Read(binding)).ToList();
                    if(rows.Count<2||Text(rows[0],"id")!=Text(index,"id")||Text(rows[0],"kind")!="importBindings")throw Invalid("source index");
                    var row=rows.SingleOrDefault(m=>Text(m,"kind")=="input"&&Text(m,"id")==id);
                    var sha=row!=null?Text(row,"sha256"):null;if(!FolderFormat.IsDigest(sha))throw Invalid("source digest");
                    var data=source.Read(Source(sha));
                    if(data==null)throw new HostError("The portable original is missing. Install Python 3 and Git to read the pinned revision.");
                    if(data.Length!=FolderFormat.Number(row["byteLength"],FolderFormat.MaxFile)||FolderFormat.Sha(data)!=sha)throw Invalid("source identity");
                    return new Map{["data"]=Convert.ToBase64String(data),["length"]=data.Length,["sha256"]=sha};
                }
            }
            if(action!="install"&&action!="convert")throw Invalid("operation");
            string manifest=Text(q,"manifest"),parent=Text(q,"parent");
            if(!FolderFormat.IsDigest(Text(q,"version"))||!(q["files"] is IEnumerable<object> entries))throw Invalid("request");
            using(var anchor=new FolderStorage(fs,parent,manifest)) {
                fs.CheckWritableVolume(parent);
                var stage=Path.Combine(parent,".waffle-extract-"+Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(stage);
                try{
                    using(var store=new FolderStorage(fs,stage,manifest)){
                        var rows=entries.Take(10001).Select(value=>value as Map??throw Invalid("entry")).ToList();
                        if(rows.Count>10000)throw Invalid("archive entry count");
                        var manifestRow=rows.SingleOrDefault(r=>Text(r,"path")==manifest)??throw Invalid("missing manifest");
                        var manifestData=EntryData(manifestRow);
                        var future=FutureDocuments(manifestData);
                        var paths=new HashSet<string>(StringComparer.Ordinal);long total=0;
                        foreach(var row in rows) {
                            var p=Text(row,"path");
                            if(p==null||(!FolderFormat.Authored(p,manifest)&&!future.Contains(p))||!paths.Add(p))throw Invalid("archive member");
                            if(p.StartsWith(Imports,StringComparison.Ordinal)&&!Index.IsMatch(p)&&!Regex.IsMatch(p,@"^\.waffle/imports/[0-9a-f]{64}/source\z"))throw Invalid("retained member");
                            var data=ReferenceEquals(row,manifestRow)?manifestData:EntryData(row);total+=data.Length;
                            if(total>FolderFormat.MaxTotal)throw Invalid("expanded size");
                            using(store.Parents(p,true,out _))
                            using(var file=fs.NewFile(store.Absolute(p),false)){file.Write(data,0,data.Length);file.Flush(true);}
                            fs.SyncDirectory(store.Absolute(FolderStorage.Parent(p)));
                        }
                        if(Version(store,paths)!=Text(q,"version"))throw Invalid("project version");
                    }
                    string stem=Path.GetFileNameWithoutExtension(manifest);
                    var occupied=new HashSet<string>(Directory.EnumerateFileSystemEntries(parent).Select(p=>Fold(Path.GetFileName(p))));
                    for(int i=1;i<=10000;i++){
                        var name=i==1?stem:stem+" ("+i+")";if(occupied.Contains(Fold(name)))continue;
                        var dest=Path.Combine(parent,name);
                        ImportExportStore.Guard(q);
                        try{fs.MoveEntry(stage,dest,false);}catch(IOException) when(Directory.Exists(dest)||File.Exists(dest)){continue;}
                        fs.SyncDirectory(parent);return new Map{["manifest"]=Path.Combine(dest,manifest)};
                    }
                    throw Invalid("destination name");
                }finally{if(Directory.Exists(stage))Directory.Delete(stage,true);}
            }
        }
    }
}
