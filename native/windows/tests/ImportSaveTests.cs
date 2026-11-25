using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Waffle.Windows.Tests
{
    using Map=Dictionary<string,object>;
    static partial class Program
    {
        static void ImportSaveTests(string scratch)
        {
            group="first Save of an imported design";
            var work=Directory.CreateDirectory(Path.Combine(scratch,"import-save")).FullName;
            var source=Path.Combine(work,"Board.kicad_pcb");
            File.WriteAllText(source,"original design");
            var support=Path.Combine(work,"private");
            var ui=new FakeUi();var host=new Host(new PortableFs(),ui,new FakeGit(),support,testTranslators);
            var sequence=0;
            Map Call(string action,params object[] inputs) {
                var data=new List<object>{"id",++sequence,"action",action};data.AddRange(inputs);
                host.Receive(Policy.PageUri,Msg(data.ToArray()));return ui.Last;
            }
            var labels=new Map{["title"]="保存项目？",["detail"]="原始 KiCad 文件将保持不变。",["save"]="保存",["export"]="导出…",["cancel"]="取消"};
            host.OpenAtStartup(source);
            var opened=(List<object>)Call("open")["result"];
            var primary=(Map)opened[0];string token=(string)primary["retainedInputToken"],key=(string)primary["importSaveKey"];
            Check(FolderFormat.IsDigest(key)&&ui.ImportPrompts==0&&Directory.GetFileSystemEntries(work).Length==1,"normal Open keeps source unmodified and presents no Save dialog");
            string session=Guid.NewGuid().ToString();
            host.Receive(Policy.PageUri,Msg("action","bindImportSave","sourceToken",token,"tokens",new[]{token},"session",session));
            Map Apply(string action,params object[] inputs) {
                var data=new List<object>{"sourceToken",token,"session",session,"operation",Guid.NewGuid().ToString()};data.AddRange(inputs);return Call(action,data.ToArray());
            }
            foreach(string choice in new[]{"waffle","cancel","export"}) {
                ui.ImportAnswer=choice;
                Check(Equals(Apply("importSaveChoice","labels",labels,"canExport",true)["result"],choice),"localized native choice "+choice);
            }
            Check(Equals(ui.OfferedDetail,labels["detail"]),"native choice receives the localized body");
            ui.ImportAnswer="waffle";
            Apply("importSaveChoice","labels",labels,"canExport",false);
            Check(ui.OfferedExport==null,"omit Export when source translator has no writer");
            string encoded(string data)=>Convert.ToBase64String(Encoding.UTF8.GetBytes(data));
            List<object> Rows(string data)=>new List<object>{new Map{["name"]="Main.kicad_pro",["data"]=encoded("project")},new Map{["name"]="sheets/Child.kicad_sch",["data"]=encoded(data)}};
            ui.Saves.Enqueue(work);
            Map wrote=Apply("writeImportExport","name","Board export","single",false,"files",Rows("first"));
            var dest=wrote["result"] as Map;
            Check(dest!=null&&!dest.ContainsKey("path")&&Equals(dest["name"],"Board export"),"native export capabilities hide the destination path");
            var target=(string)dest["destination"];var member=Path.Combine(work,"Board export","sheets","Child.kicad_sch");
            Check(File.ReadAllText(member)=="first"&&File.ReadAllText(source)=="original design","fresh nested complete output and original preserved");
            Check(Equals(Apply("rememberImportExport","destination",target)["result"],true),"explicitly remember a successful destination");
            Check(Apply("writeImportExport","name","Board export","single",false,"files",Rows("next"),"destination",target)["result"] is Map &&
                  File.ReadAllText(member)=="next","repeat with same opaque grant swaps complete output");
            Check(Apply("recalledImportExport")["result"] is Map,"private receipt follows last successful export");
            File.WriteAllText(member,"outside");
            Check(Apply("writeImportExport","name","Board export","single",false,"files",Rows("again"),"destination",target)["error"] is string &&
                  File.ReadAllText(member)=="outside","externally edited destination is preserved");
            host.Receive(Policy.PageUri,Msg("action","clearGitProject"));
            Check(Apply("writeImportExport","destination",target)["error"] is string,"previous window project grant retired");
            string restored=Guid.NewGuid().ToString(), draft=Guid.NewGuid().ToString();
            host.Receive(Policy.PageUri,Msg("action","bindRestoredImportSave","session",restored,"draftId",draft,"sourceKey",key,"format","kicad"));
            Map Restored(string action)=>Call(action,"session",restored,"draftId",draft,"sourceKey",key,"format","kicad","operation",Guid.NewGuid().ToString(),"labels",labels);
            int before=ui.ImportPrompts;
            Check(Restored("importSaveChoice")["error"] is string&&ui.ImportPrompts==before,"unreported restoration cannot present a modal");
            host.Receive(Policy.PageUri,Msg("action","dirty","importId",draft,"projectName","Recovered","dirty",true));
            Check(Equals(Restored("importSaveChoice")["result"],"waffle")&&ui.ImportPrompts==before+1,"verified active recovered edit can present its native first Save without a source");
            Check(Restored("writeImportExport")["error"] is string,"restored choice cannot write or export without a chosen path");
            host.Receive(Policy.PageUri,Msg("action","dirty","importId","some-other-project","dirty",true));
            Check(Restored("importSaveChoice")["error"] is string,"restored choice is revoked if another project is active");
            ui.Opens.Enqueue(new[]{source});
            var selected=Call("reselectImportSave","sourceKey",key,"operation",Guid.NewGuid().ToString())["result"] as List<object>;
            Check(selected!=null&&Equals(((Map)selected[0])["importSaveKey"],key),"explicit draft reselect recovers exact original bytes and stable key");
            File.WriteAllText(source,"different");
            ui.Opens.Enqueue(new[]{source});
            Check(Call("reselectImportSave","sourceKey",key,"operation",Guid.NewGuid().ToString())["result"]==null,"draft rejects a changed original");
            host.Closing();
        }
    }
}
