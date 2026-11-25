using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Map = System.Collections.Generic.Dictionary<string,object>;

namespace Waffle.Windows
{
    // Window commands stay in the app's own process and the adopted writer's grant.
    sealed class WorkspaceWindows
    {
        readonly MainWindow writer;
        readonly string project, path;
        string grant;
        bool writerAvailable = true;
        readonly Func<WorkspaceWindows,string,string,MainWindow> spawn;
        readonly Dictionary<string,MainWindow> members = new Dictionary<string,MainWindow>();
        readonly Dictionary<string,Tuple<MainWindow,Action<object,string>>> waiting = new Dictionary<string,Tuple<MainWindow,Action<object,string>>>();

        internal WorkspaceWindows(MainWindow writer, string project, string grant, Func<WorkspaceWindows,string,string,MainWindow> spawn)
        {
            this.writer = writer; this.project = project; this.grant = grant; this.spawn = spawn; path = writer.WorkspacePath;
            Register(writer);
        }
        static object Value(Map request, string key) => request.TryGetValue(key,out var value) ? value : null;
        static string Text(Map request, string key) => Value(request,key) as string;
        internal void Register(MainWindow window) => members[window.WorkspaceId] = window;
        internal bool IsWriter(MainWindow window) => writer == window;
        internal bool IsCurrent => writer.HasWorkspaceFolder(project,grant);
        internal bool AdoptLease(string nextProject, string nextGrant) {
            if (nextProject != project || !String.Equals(path,writer.WorkspacePath,StringComparison.OrdinalIgnoreCase)) return false;
            if (grant != nextGrant) FailWaiting("The project window writer was replaced.");
            grant = nextGrant;
            return true;
        }
        void FailWaiting(string error, MainWindow window = null)
        {
            foreach (var row in waiting.Where(row => window == null || row.Value.Item1 == window).ToArray()) {
                waiting.Remove(row.Key);
                row.Value.Item2(null,error);
            }
        }
        bool Retire(MainWindow window)
        {
            if (!members.Remove(window.WorkspaceId)) return false;
            FailWaiting("The project window closed.",window);
            return true;
        }
        void StopWriter(string error)
        {
            if (!writerAvailable) return;
            writerAvailable = false;
            foreach (var target in members.Values.Where(member => member != writer).ToArray())
                target.PostWorkspace(new Map { ["type"]="writer-unavailable" });
            FailWaiting(error);
        }
        internal void RendererFailed(MainWindow window)
        {
            if (!members.TryGetValue(window.WorkspaceId,out var member) || member != window) return;
            if (window == writer) StopWriter("The project window writer is unavailable.");
            else FailWaiting("The project window renderer is unavailable.",window);
        }
        internal void RetirePeers() {
            foreach (var target in members.Values.Where(member=>member != writer).ToArray()) {
                if (Retire(target)) target.Close();
            }
        }
        internal bool KeepWriter(MainWindow window) => writer == window &&
            members.Values.Any(peer => peer != writer && !peer.IsDisposed && peer.Opacity == 1);

        internal void Receive(MainWindow window, Map request, Action<object,string> reply)
        {
            string operation = Text(request,"operation");
            if (!writerAvailable || !writer.HasWorkspaceFolder(project,grant) || !members.TryGetValue(window.WorkspaceId,out var peer) || peer != window)
                throw new HostError("The project window writer is unavailable.");
            if (Encoding.UTF8.GetByteCount(Json.Write(request)) > (operation == "deliver" ? 32 << 20 : 1 << 20))
                throw new HostError("The project window operation exceeds its size limit.");
            if (operation == "describe")
                reply(new Map { ["project"]=project, ["window"]=window.WorkspaceId, ["tab"]=window.WorkspaceTab, ["writer"]=window == writer,
                    ["frames"] = window == writer ? members.Values.Select(member=>new Map {
                        ["id"]=member.WorkspaceId, ["bounds"]=member.CaptureWorkspaceBounds() }).ToArray() : Array.Empty<Map>() }, null);
            else if (operation == "apply-layout" && window == writer)
            {
                var rows = (Value(request,"windows") as List<object>)?.Select(x => x as Map).ToArray();
                string focused = Text(request,"focused");
                if (rows == null || rows.Length == 0 || rows.Any(row => row == null || !Guid.TryParseExact(Text(row,"id"),"D",out _) || String.IsNullOrEmpty(Text(row,"active"))))
                    throw new HostError("The project window layout is invalid.");
                var ids = new HashSet<string>(rows.Select(row => Text(row,"id")));
                if (ids.Count != rows.Length || !ids.Contains(focused) || !ids.Contains(writer.WorkspaceId))
                    throw new HostError("The project window layout is invalid.");
                foreach (var row in rows)
                {
                    string id = Text(row,"id"), tab = Text(row,"active");
                    var target = members.TryGetValue(id,out var member) ? member : spawn(this,id,tab);
                    target.WorkspaceTab = tab;
                    if (target != writer) target.PostWorkspace(new Map { ["type"]="view", ["tab"]=tab });
                    target.WorkspaceBounds(Value(row,"bounds") as Map);
                    if (id == focused) { target.Show(); target.Activate(); }
                }
                foreach (var target in members.Values.Where(member => !ids.Contains(member.WorkspaceId)).ToArray())
                    if (Retire(target)) target.Close();
                reply(true,null);
            }
            else if (operation == "snapshot" || operation == "command")
            {
                if (waiting.Count >= 32) throw new HostError("The project writer is busy.");
                string token = Guid.NewGuid().ToString("N");
                waiting[token] = Tuple.Create(window,reply);
                writer.PostWorkspace(new Map { ["type"]="rpc", ["token"]=token, ["packet"]=new Map {
                    ["operation"]=operation, ["from"]=window.WorkspaceId, ["value"]=Value(request,"value") } });
            }
            else if (operation == "deliver" && window == writer)
            {
                var token = Text(request,"token");
                if (token != null && waiting.TryGetValue(token,out var pending))
                { waiting.Remove(token); pending.Item2(Value(request,"value"),Text(request,"error")); }
                reply(true,null);
            }
            else if (operation == "broadcast" && window == writer && Value(request,"value") is Map data)
            {
                foreach (var target in members.Values.Where(member => member != writer)) target.PostWorkspace(data);
                reply(true,null);
            }
            else throw new HostError("The project window operation is unavailable.");
        }

        internal void Close(MainWindow window)
        {
            if (!Retire(window)) return;
            if (window == writer)
            {
                StopWriter("The project window writer closed.");
                RetirePeers();
            }
            else
                writer.PostWorkspace(new Map { ["type"]="closed", ["window"]=window.WorkspaceId });
        }
    }
}
