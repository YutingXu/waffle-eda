using System;
using System.Collections.Generic;
using System.Linq;
using Map = System.Collections.Generic.Dictionary<string,object>;

namespace Waffle.Windows
{
    // Test adapter for the production router. WinForms and WebView2 run in the Windows app.
    sealed class MainWindow
    {
        internal MainWindow(string id = null) { WorkspaceId = id ?? Guid.NewGuid().ToString("D"); }
        internal string WorkspaceId { get; }
        internal string WorkspacePath { get; } = "fixture.waffle";
        internal string WorkspaceTab { get; set; }
        internal bool IsDisposed { get; private set; }
        internal double Opacity { get; set; }
        internal string Grant;
        internal Action Closed;
        internal readonly List<Map> Events = new List<Map>();
        internal bool HasWorkspaceFolder(string project,string grant) => project == "project" && Grant == grant;
        internal Map CaptureWorkspaceBounds() => new Map();
        internal void WorkspaceBounds(Map _) { }
        internal void PostWorkspace(Map data) => Events.Add(data);
        internal void Show() { }
        internal void Activate() { }
        internal void Close() { IsDisposed = true; Closed?.Invoke(); }
    }
}

namespace Waffle.Windows.Tests
{
    static partial class Program
    {
        static void WorkspaceRoutingTests()
        {
            group = "Windows workspace routing";
            var author = new MainWindow { Grant="initial" };
            MainWindow mirror = null;
            var router = new WorkspaceWindows(author,"project",author.Grant,(group,id,tab) => {
                var peer = new MainWindow(id) { WorkspaceTab=tab };
                peer.Closed = () => group.Close(peer);
                group.Register(peer);
                return mirror = peer;
            });
            Map Row(string id,string tab) => new Map { ["id"]=id, ["active"]=tab };
            string mirrorId = Guid.NewGuid().ToString("D");
            var layout = new Map { ["operation"]="apply-layout", ["focused"]=author.WorkspaceId,
                ["windows"]=new List<object> { Row(author.WorkspaceId,"board"), Row(mirrorId,"sheet") } };
            router.Receive(author,layout,(_,error)=>Check(error == null,"the writer applies the detached layout"));
            Check(!router.KeepWriter(author),"a concealed peer does not keep the writer running without a visible window");
            mirror.Opacity = 1;
            Check(router.KeepWriter(author),"a revealed peer keeps the writer running");

            var replies = new List<(string Kind,object Value,string Error)>();
            string Send(string kind)
            {
                var request = new Map { ["operation"]="command", ["value"]=new Map { ["kind"]=kind } };
                router.Receive(mirror,request,(value,error)=>replies.Add((kind,value,error)));
                var envelope = author.Events.Last();
                var packet = (Map)envelope["packet"];
                Check(Equals(packet["from"],mirror.WorkspaceId) && Equals(((Map)packet["value"])["kind"],kind),"the writer receives the scoped " + kind);
                return (string)envelope["token"];
            }
            void Deliver(string token,object value) => router.Receive(author,
                new Map { ["operation"]="deliver", ["token"]=token, ["value"]=value },(_,_2)=>{});

            Deliver(Send("edit"),true);
            var cancelled = Send("save");
            Deliver(cancelled,false);
            Deliver(cancelled,true);
            Check(replies.Count == 2 && Equals(replies[0].Value,true) && Equals(replies[1].Value,false) && replies[1].Error == null,
                "Save cancellation completes exactly once");

            var abandoned = Send("undo");
            router.RendererFailed(mirror);
            Deliver(abandoned,true);
            Check(replies.Count == 3 && replies[2].Error == "The project window renderer is unavailable.","a failed peer retires its in-flight Undo");
            mirror.Close();
            router.Receive(author,layout,(_,error)=>Check(error == null,"the writer can replace the detached editor"));

            var stale = Send("edit");
            author.Grant = "replacement";
            Check(router.AdoptLease("project",author.Grant),"the same project accepts its replacement grant");
            Deliver(stale,true);
            Check(replies.Count == 4 && replies[3].Error == "The project window writer was replaced.","an old lease's reply cannot affect the replacement");

            Send("edit");
            Send("save");
            router.RendererFailed(author);
            Check(!mirror.IsDisposed && replies.Count == 6 && replies.Skip(4).All(row=>row.Error == "The project window writer is unavailable."),
                "in-flight commands fail before the native crash dialog closes the windows");
            Throws(()=>Send("undo"),"writer is unavailable","a crashed writer refuses new requests");
            router.Close(author);
            Check(mirror.IsDisposed && mirror.Events.Count(row=>Equals(row["type"],"writer-unavailable")) == 1,
                "closing the crashed writer retires its peer without a duplicate failure notice");
        }
    }
}
