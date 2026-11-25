// Foreign designs share no project transaction directory. Publish full sibling trees and retain
// a private receipt with identities and exact bytes of every entry the user authorized.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Waffle.Windows
{
    using Map=Dictionary<string,object>;
    internal interface IImportExportPlatform
    {
        string ExportIdentity(string path,bool directory);
        void ExchangeExport(string staged,string prior,bool single);
    }

    internal static class ImportExportStore
    {
        internal static bool Handles(string verb) => verb=="writeExport"||verb=="recallExport"||verb=="rememberExport"||verb=="forgetExport";
        static string T(Map r,string key)=>FolderFormat.Text(r,key);
        static bool Single(Map r)=>FolderFormat.Get(r,"single") is bool flag && flag;
        static HostError Changed()=>new HostError("The export destination changed. Choose a new destination.");
        static string Name(string path)
        {
            var value=FolderFormat.PathName(path);
            if(value.Split('/').Any(p=>p.StartsWith(".",StringComparison.Ordinal)))throw new HostError("Choose a visible export name.");
            return value;
        }
        internal static void Guard(Map args)
        {
            var marker=T(args,"guardFile");
            if(marker!=null&&!File.Exists(marker))throw new HostError("The import Save operation was cancelled.");
        }
        static Map Snapshot(IFolderPlatform disk,IImportExportPlatform physical,string path)
        {
            var rows=new Map();long total=0;
            void Visit(string entry,string rel) {
                if(rows.Count>8192)throw Changed();
                var attributes=File.GetAttributes(entry);
                if((attributes&FileAttributes.ReparsePoint)!=0)throw Changed();
                bool dir=(attributes&FileAttributes.Directory)!=0;
                var id=physical.ExportIdentity(entry,dir)??throw Changed();
                if(dir) {
                    rows[rel]="dir "+id;
                    using(disk.PinDirectory(entry)) {
                        foreach(var child in Directory.EnumerateFileSystemEntries(entry).OrderBy(p=>p,StringComparer.Ordinal)) {
                            var leaf=Name(Path.GetFileName(child));Visit(child,rel==""?leaf:rel+"/"+leaf);
                        }
                    }
                } else {
                    using(var original=disk.OpenRegular(entry))
                    using(var hash=SHA256.Create()) {
                        total+=original.Length;
                        if(total>256L*1024*1024)throw Changed();
                        rows[rel]="file "+id+" "+original.Length+" "+BitConverter.ToString(hash.ComputeHash(original)).Replace("-","").ToLowerInvariant();
                    }
                }
                if(physical.ExportIdentity(entry,dir)!=id)throw Changed();
            }
            Visit(path,"");return rows;
        }
        static bool Same(Map a,Map b)=>a!=null&&b!=null&&a.Count==b.Count&&a.All(k=>b.TryGetValue(k.Key,out var value)&&Equals(value,k.Value));
        static Map Existing(IFolderPlatform disk,IImportExportPlatform physical,IHostFs fs,string pref)
        {
            try {
                if(!File.Exists(pref))return null;
                var record=Json.Parse(FolderFormat.Utf8.GetString(fs.ReadRegular(pref,4*1024*1024,true).Bytes)) as Map;
                var path=T(record,"path");
                if(path==null||physical.ExportIdentity(Path.GetDirectoryName(path),true)!=T(record,"parent")||
                    !Same(Snapshot(disk,physical,path),FolderFormat.Get(record,"entries") as Map))return null;
                return record;
            }catch(Exception e) when (e is IOException||e is UnauthorizedAccessException||e is HostError||e is FormatException||e is ArgumentException){return null;}
        }
        static void Remember(IHostFs fs,string pref,Map receipt)
        {
            fs.EnsurePrivateFolder(Path.GetDirectoryName(pref));
            fs.AtomicWrite(pref,FolderFormat.Utf8.GetBytes(Json.Write(receipt)),true);
        }
        internal static object Run(IFolderPlatform disk,string verb,Map args)
        {
            var fs=(IHostFs)disk;var physical=(IImportExportPlatform)disk;
            var key=T(args,"key");if(!FolderFormat.IsDigest(key))throw new HostError("The import grant expired.");
            var pref=Path.Combine(T(args,"support"),"import-exports",key+".json");
            var prior=FolderFormat.Get(args,"receipt") as Map;
            Guard(args);
            if(verb=="recallExport")return new Map{["receipt"]=Existing(disk,physical,fs,pref)};
            if(verb=="forgetExport"){if(File.Exists(pref))fs.Unlink(pref);return new Map{["saved"]=true};}
            if(verb=="rememberExport") {
                if(prior==null||!Same(Snapshot(disk,physical,T(prior,"path")),FolderFormat.Get(prior,"entries") as Map))throw Changed();
                Remember(fs,pref,prior);return new Map{["saved"]=true};
            }
            string selected=prior==null?T(args,"selected"):T(prior,"path");
            if(!Path.IsPathRooted(selected))throw Changed();
            string parent=Path.GetDirectoryName(selected), name=Name(Path.GetFileName(selected));
            bool single=Single(args);
            var sources=((IEnumerable<object>)args["sources"]).Cast<string>().Select(fs.Canonical).ToArray();
            var identities=new HashSet<string>(sources.Where(File.Exists).Select(p=>fs.Identity(p)));
            bool remembered=prior!=null&&Existing(disk,physical,fs,pref) is Map known&&T(known,"path")==T(prior,"path")&&
                Same(FolderFormat.Get(known,"entries") as Map,FolderFormat.Get(prior,"entries") as Map);
            using(var root=new FolderStorage(disk,parent,"export.waffle"))
            using(var locked=fs.TryLockFolder(parent)??throw new HostError("A Save is in progress in this directory.")) {
                string parentId=physical.ExportIdentity(parent,true);
                if(prior!=null&&(T(prior,"parent")!=parentId||Single(prior)!=single))throw Changed();
                var temp=Path.Combine(parent,".waffle-export-"+Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(temp);
                string stage=Path.Combine(temp,"output");
                try {
                    if(!single)Directory.CreateDirectory(stage);
                    var entries=(IEnumerable<object>)args["files"];int count=0;long total=0;
                    var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach(Map row in entries) {
                        string rel=Name(T(row,"name"));int n=++count;
                        if(single&&!Path.GetExtension(rel).Equals(Path.GetExtension(name),StringComparison.OrdinalIgnoreCase))
                            throw new HostError("Use the output file extension supplied by the design writer.");
                        if(n>4096||(single&&n>1)||!names.Add(rel))throw new HostError("Invalid export member set.");
                        string encoded=T(row,"data");
                        if(encoded==null||encoded.Length>(256L*1024*1024-total+2)/3*4)throw new HostError("The export exceeds the size limit.");
                        var bytes=Convert.FromBase64String(encoded);total+=bytes.Length;
                        if(total>256L*1024*1024)throw new HostError("The export exceeds the size limit.");
                        string dest=single?stage:Path.Combine(stage,rel.Replace('/',Path.DirectorySeparatorChar));
                        if(!single) {
                            using(var memberRoot=new FolderStorage(disk,stage,"export.waffle"))
                            using(memberRoot.Parents(rel,true,out _)) {WriteFile(disk,dest,bytes);}
                        }else WriteFile(disk,dest,bytes);
                    }
                    if(count==0)throw new HostError("The export is empty.");
                    var desired=Snapshot(disk,physical,stage);
                    var occupied=new HashSet<string>(Directory.EnumerateFileSystemEntries(parent).Select(Path.GetFileName),StringComparer.OrdinalIgnoreCase);
                    for(int attempt=1;attempt<=10000;attempt++) {
                        string ext=single?Path.GetExtension(name):"";
                        string leaf=attempt==1?name:name.Substring(0,name.Length-ext.Length)+" ("+attempt+")"+ext;
                        string dest=Path.Combine(parent,leaf);
                        bool exists=occupied.Contains(leaf);
                        string canonical=fs.Canonical(dest);
                        if(sources.Any(p=>p.Equals(canonical,StringComparison.OrdinalIgnoreCase)||p.StartsWith(canonical+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))||
                            (File.Exists(dest)&&identities.Contains(fs.Identity(dest)))) {
                            if(single||prior!=null)throw new HostError("Choose an export destination separate from the original design.");
                            continue;
                        }
                        if(prior!=null) {
                            if(!exists||!Same(Snapshot(disk,physical,dest),FolderFormat.Get(prior,"entries") as Map))throw Changed();
                        }else if(exists)continue;
                        Guard(args);
                        if(prior==null) {
                            try {disk.MoveEntry(stage,dest,false);}
                            catch(IOException) when(File.Exists(dest)||Directory.Exists(dest)){continue;}
                        }else{
                            physical.ExchangeExport(stage,dest,single);
                            try {if(!Same(Snapshot(disk,physical,stage),FolderFormat.Get(prior,"entries") as Map))throw Changed();}
                            catch {physical.ExchangeExport(stage,dest,single);throw;}
                        }
                        try {disk.SyncDirectory(parent);}
                        catch {
                            if(prior==null)disk.MoveEntry(dest,stage,false);
                            else physical.ExchangeExport(stage,dest,single);
                            throw;
                        }
                        var record=new Map{["path"]=dest,["name"]=leaf,["single"]=single,["parent"]=parentId,["entries"]=desired};
                        if(remembered) {
                            try{Remember(fs,pref,record);}
                            catch(Exception e) when(e is IOException||e is UnauthorizedAccessException||e is HostError){
                                return new Map{["receipt"]=record,["preferenceError"]="The export was saved. Its private destination preference could not be updated."};
                            }
                        }
                        return new Map{["receipt"]=record};
                    }
                    throw new HostError("Choose a new export destination name.");
                }finally{if(Directory.Exists(temp))Directory.Delete(temp,true);}
            }
        }
        static void WriteFile(IFolderPlatform disk,string dest,byte[] bytes)
        {
            using(var f=disk.NewFile(dest,false)){f.Write(bytes,0,bytes.Length);f.Flush(true);}
            disk.SyncDirectory(Path.GetDirectoryName(dest));
        }
    }
}
