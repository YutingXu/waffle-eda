// Read-only original grants and exclusive portable-project publication. The ordinary
// project-folder transaction service owns the root and the active read lease.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
namespace Waffle.Windows
{
    using Map=Dictionary<string,object>;

    public interface IArchiveRunner { object Archive(string action, Map request); }
    /// Optional: a folder chooser that starts in a suggested folder.
    public interface IFolderStartUi { void PickFolderFrom(string start, string title, Action<string> done); }

    public sealed partial class Host
    {
        sealed class OriginalGrant { internal string Path, Sha; }
        readonly Dictionary<string,OriginalGrant> retainedInputs=new Dictionary<string,OriginalGrant>();
        static string RetainInput(Dictionary<string,OriginalGrant> incoming,string path,byte[] bytes)
        {
            string id=Guid.NewGuid().ToString();
            incoming.Add(id,new OriginalGrant{Path=path,Sha=FolderFormat.Sha(bytes)});return id;
        }
        string SelectedOrigin(string token)
        {
            if(token==null)return null;
            return retainedInputs.TryGetValue(token,out var r)?r.Path:null;
        }
        void SelectArchiveParent(Action<string> use)
        {
            if(!(ui is IFolderUi chooser))throw new HostError("A native project folder chooser is unavailable.");
            chooser.PickFolder(true,use);
        }
        // First Save of an import always asks where the project goes. It starts in the folder holding
        // the most recent Waffle project, else beside the source project folder, never inside it.
        // The chosen folder receives "Name/", or "Name (2)/" when taken (the first-save convention).
        void SelectConversionParent(string source,Action<string> use)
        {
            string projectFolder=fs.Parent(source), folder=projectFolder.TrimEnd('\\','/');
            bool Inside(string path)=>fs.PathComparer.Equals(path.TrimEnd('\\','/'),folder) ||
                path.StartsWith(folder+"\\",StringComparison.OrdinalIgnoreCase) || path.StartsWith(folder+"/",StringComparison.OrdinalIgnoreCase);
            string start=null;
            foreach(var entry in Recent.Entries){
                if(!entry.Key.EndsWith(".waffle",StringComparison.OrdinalIgnoreCase))continue;
                var candidate=fs.Parent(fs.Parent(entry.Key));
                if(candidate==null||!System.IO.Directory.Exists(candidate))continue;
                start=candidate;break;
            }
            if(start==null||Inside(start))start=fs.Parent(projectFolder);
            if(ui is IFolderStartUi picker)picker.PickFolderFrom(start,"Choose where to create the Waffle project folder",use);
            else SelectArchiveParent(use);
        }
        partial void ArchiveAction(int id,string action,Map request,ref bool handled)
        {
            if(action!="installProjectArchive" && action!="folderConvertSibling" && action!="folderReadImportSource")return;
            handled=true;
            var runner=git as IArchiveRunner;
            if(runner==null)throw new HostError("The portable project helper is unavailable.");
            var token=Str(request,"sourceToken");string picked=SelectedOrigin(token);
            if(action=="installProjectArchive" || action=="folderConvertSibling"){
                bool convert=action=="folderConvertSibling";
                if(convert)CheckImported(request);
                if(convert&&picked==null)throw new HostError("Choose the original file again before converting it.");
                var op=convert?Str(request,"operation"):Guid.NewGuid().ToString();
                if(!Guid.TryParse(op,out _) || importOperations.ContainsKey(op))throw new HostError("Invalid import Save operation.");
                importOperations[op]=()=>{};
                void Publish(string parent,bool offerAnother){
                    if(parent==null||!importOperations.ContainsKey(op)){CancelImported(op);Reply(id,false);return;}
                    var marker=Path.Combine(Path.GetTempPath(),"waffle-convert-"+Guid.NewGuid().ToString("N"));
                    using(new FileStream(marker,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){}
                    importOperations[op]=()=>File.Delete(marker);
                    ui.Background(()=>{
                        try{
                            var args=new Map{["parent"]=parent,["manifest"]=Str(request,"manifest"),["version"]=Str(request,"version"),["files"]=request["files"],["guardFile"]=marker};
                            if(convert){var stem=Str(request,"folderName");if(stem!=null)args["folderStem"]=stem;}
                            var result=runner.Archive(convert?"convert":"install",args) as Map;
                            var path=result==null?null:Str(result,"manifest");
                            if(path==null)throw new HostError("The extracted project manifest is unavailable.");
                            ui.Main(()=>{bool live=importOperations.ContainsKey(op);CancelImported(op);if(live)OfferFolder(path,id,false);else Reply(id,false);});
                        }catch(Exception e) when(offerAnother && (e is UnauthorizedAccessException || e.Message=="WAFFLE-PARENT-READ-ONLY")){
                            ui.Main(()=>{
                                if(!importOperations.ContainsKey(op)){Reply(id,false);return;}
                                CancelImported(op);importOperations[op]=()=>{};
                                SelectArchiveParent(next=>Publish(next,false));
                            });
                        }catch(Exception e){ui.Main(()=>{CancelImported(op);Reply(id,error:e.Message);});}
                    });
                }
                if(convert)SelectConversionParent(picked,parent=>Publish(parent,true));else SelectArchiveParent(parent=>Publish(parent,false));
                return;
            }
            var grant=Str(request,"grant");
            if(grant==null)throw new HostError("The saved project grant has expired.");
            var project=FolderService(grant);
            ui.Background(()=>{
                try{
                    var result=project.WithLease<object>(Str(request,"lease"),(directory,manifest)=>runner.Archive("original",new Map{
                        ["root"]=directory,["manifest"]=manifest,["bindingPath"]=Str(request,"bindingPath"),["inputId"]=Str(request,"inputId")}));
                    ReplyLater(id,result);
                }catch(Exception e){ReplyLater(id,error:e.Message);}
            });
        }
    }
}
