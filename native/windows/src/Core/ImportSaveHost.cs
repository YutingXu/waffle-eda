// Window-owned import and export capabilities. Only native dialogs contribute physical paths.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Waffle.Windows
{
    using Map = Dictionary<string,object>;

    public interface IImportSaveUi
    {
        void ChooseImportSave(string title,string detail,string save,string export,string cancel,Action<string> done);
        void CancelImportChoice();
        void PickImportFiles(IList<string> extensions,Func<bool> current,Action<IList<string>> done);
        void PickImportDestination(string name,bool single,string title,Func<bool> current,Action<string> done);
    }

    public sealed partial class Host
    {
        HashSet<string> pendingImportTokens = new HashSet<string>();
        string importSession, importSource, importKey, reportedImportId;
        Map restoredImport;
        string[] importSources;
        readonly Dictionary<string,Map> importTargets = new Dictionary<string,Map>();
        readonly Dictionary<string,Action> importOperations = new Dictionary<string,Action>();
        readonly object importWriter = new object();

        string ImportKey(OriginalGrant input) => FolderFormat.Sha(Encoding.UTF8.GetBytes(fs.Canonical(input.Path).ToLowerInvariant()+"\0"+input.Sha));
        void CancelImported(string operation)
        {
            if (operation!=null && importOperations.TryGetValue(operation,out var stop)) {
                importOperations.Remove(operation);
                stop();
            }
        }
        void ResetImportedSave()
        {
            foreach (string op in importOperations.Keys.ToList()) CancelImported(op);
            importSession=importSource=importKey=null;restoredImport=null;
            importSources=null;
            importTargets.Clear();
        }
        void BindImportedSave(Map r)
        {
            ResetImportedSave();
            var primary=Str(r,"sourceToken");var session=Str(r,"session");
            if (!Guid.TryParse(session,out _) || primary==null || !pendingImportTokens.Contains(primary) ||
                !(FolderFormat.Get(r,"tokens") is List<object> group) || group.Any(t=>!(t is string s)||!pendingImportTokens.Contains(s)) ||
                pendingImportTokens.Any(t=>!retainedInputs.ContainsKey(t)))return;
            importSources=pendingImportTokens.Select(t=>retainedInputs[t].Path).ToArray();
            importSession=session;importSource=primary;importKey=ImportKey(retainedInputs[primary]);
            pendingImportTokens.Clear();
        }
        void BindRestoredChoice(Map r)
        {
            ResetImportedSave();
            var draft=Str(r,"draftId");var key=Str(r,"sourceKey");var format=Str(r,"format");var session=Str(r,"session");
            if(string.IsNullOrEmpty(draft)||draft.Length>160||key==null||!System.Text.RegularExpressions.Regex.IsMatch(key,@"^(?:[a-z0-9_-]+:)?[a-f0-9]{64}\z")||
               !new[]{"altium","kicad","eagle","easyeda"}.Contains(format)||!Guid.TryParse(session,out _))return;
            restoredImport=new Map{["draftId"]=draft,["sourceKey"]=key,["format"]=format,["session"]=session};
        }
        void CheckImported(Map r)
        {
            if (importSession==null || Str(r,"session")!=importSession || Str(r,"sourceToken")!=importSource)
                throw new HostError("The imported design changed. Open it again.");
        }
        static string ImportLabel(Map labels,string field,int limit)
        {
            var label=Str(labels,field);
            return string.IsNullOrEmpty(label)?null:label.Substring(0,Math.Min(label.Length,limit));
        }
        void ImportedSaveAction(int id,string action,Map r)
        {
            string op=Str(r,"operation");
            if (!Guid.TryParse(op,out _) || importOperations.ContainsKey(op))throw new HostError("Invalid import Save operation.");
            if (action=="reselectImportSave") {
                var key=Str(r,"sourceKey");
                if (!FolderFormat.IsDigest(key)){Reply(id,null);return;}
                if(!(ui is IImportSaveUi picker))throw new HostError("The native source chooser is unavailable.");
                importOperations[op]=picker.CancelImportChoice;
                picker.PickImportFiles(translators.OpenTypes(null),()=>importOperations.ContainsKey(op), paths=>{
                    if (!importOperations.ContainsKey(op)||paths==null||paths.Count==0||paths.Any(p=>Policy.ProjectName(p)||!translators.Accepts(p))) {
                        CancelImported(op);Reply(id,null);return;
                    }
                    ReadFiles(paths,id,false,false,expectedKey:key,operation:op);
                });
                return;
            }
            bool choiceOnly=action=="importSaveChoice" && restoredImport!=null && reportedImportId==Str(restoredImport,"draftId") &&
                restoredImport.All(p=>Equals(FolderFormat.Get(r,p.Key),p.Value));
            if(!choiceOnly)CheckImported(r);
            if(action=="importSaveChoice") {
                if (!(ui is IImportSaveUi dialogs) || !(FolderFormat.Get(r,"labels") is Map labels))throw new HostError("The native Save dialog is unavailable.");
                var title=ImportLabel(labels,"title",512);var save=ImportLabel(labels,"save",120);var cancel=ImportLabel(labels,"cancel",120);
                if(title==null||save==null||cancel==null)throw new HostError("The Save labels are unavailable.");
                var export=r.ContainsKey("canExport")&&!True(r,"canExport")?null:ImportLabel(labels,"export",120);
                importOperations[op]=dialogs.CancelImportChoice;
                dialogs.ChooseImportSave(title,ImportLabel(labels,"detail",1024),save,export,cancel,result=>
                    Reply(id,importOperations.Remove(op)?result:"cancel"));
                return;
            }
            var target=Str(r,"destination");
            Map receipt=null;
            if((target!=null&&!importTargets.TryGetValue(target,out receipt))||(action=="rememberImportExport"&&receipt==null))
                throw new HostError("The export destination grant expired. Choose a new destination.");
            bool single=True(r,"single");
            var name=Str(r,"name");
            if (action=="writeImportExport"&&(string.IsNullOrEmpty(name)||FolderFormat.PathName(name).Contains("/")||name.StartsWith(".",StringComparison.Ordinal)))
                throw new HostError("Choose a visible export name.");
            var runner=git as IArchiveRunner;
            if(runner==null)throw new HostError("The native export service is unavailable.");
            var session=importSession;
            var args=new Map{["key"]=importKey,["support"]=supportFolder,["receipt"]=receipt};
            var verb=action=="writeImportExport"?"writeExport":action=="rememberImportExport"?"rememberExport":action=="recalledImportExport"?"recallExport":"forgetExport";
            if(verb=="writeExport"){args["files"]=r["files"];args["single"]=single;args["sources"]=importSources;}
            importOperations[op]=()=>{};
            void Perform(string selected) {
                if(!importOperations.ContainsKey(op)||session!=importSession){Reply(id,false);return;}
                if(selected!=null)args["selected"]=selected;
                var marker=Path.Combine(Path.GetTempPath(),"waffle-export-"+Guid.NewGuid().ToString("N"));
                using(new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){}
                importOperations[op]=()=>File.Delete(marker);
                args["guardFile"]=marker;
                ui.Background(()=>{
                    try {
                        Map result;
                        lock(importWriter)result=runner.Archive(verb,args) as Map;
                        ui.Main(()=>{
                            bool live=importOperations.ContainsKey(op)&&session==importSession;
                            CancelImported(op);
                            if(!live){Reply(id,error:"The imported design changed.");return;}
                            if(verb=="writeExport"||verb=="recallExport") {
                                var value=result==null?null:FolderFormat.Get(result,"receipt") as Map;
                                if(value==null){Reply(id,null);return;}
                                string token=target??Guid.NewGuid().ToString();
                                importTargets[token]=value;
                                var visible=new Map{["destination"]=token,["name"]=Str(value,"name")};
                                if(Str(result,"preferenceError") is string notice)visible["preferenceError"]=notice;
                                Reply(id,visible);
                            }else Reply(id,true);
                        });
                    }catch(Exception error){ui.Main(()=>{CancelImported(op);Reply(id,error:error.Message);});}
                });
            }
            if(verb!="writeExport"||receipt!=null){Perform(null);return;}
            void Selected(string path) {
                if(path==null){CancelImported(op);Reply(id,false);return;}
                Perform(single?path:Path.Combine(path,name));
            }
            if(!(ui is IImportSaveUi chooser)){CancelImported(op);throw new HostError("The native export chooser is unavailable.");}
            importOperations[op]=chooser.CancelImportChoice;
            chooser.PickImportDestination(name,single,single?"Export design":"Choose the parent folder for the exported design",
                ()=>importOperations.ContainsKey(op)&&session==importSession,Selected);
        }
    }
}
