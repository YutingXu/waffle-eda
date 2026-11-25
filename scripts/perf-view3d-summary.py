"""Summarize the real Chromium compositor latency spans captured by the 3D probe."""
import bisect
import collections
import json
import math
import statistics
import sys
from pathlib import Path

BUDGET=1000/60

def stat(values):
    values=sorted(values)
    if not values:
        return None
    q=lambda p:round(values[math.ceil(p*len(values))-1],3)
    return {"n":len(values),"p50":q(.5),"p95":q(.95),"worst":q(1),
            "over16.667":round(sum(t>BUDGET for t in values)*100/len(values),2),
            "over33.333":round(sum(t>BUDGET*2 for t in values)*100/len(values),2)}

def report(probe_path):
    source=json.loads(probe_path.read_text())
    probe=source["probe"]
    events=json.loads(probe_path.with_name(probe_path.name.replace("-probe.json","-trace.json")).read_text())["traceEvents"]
    frames,marks={},{}
    started={}
    reported=collections.defaultdict(list)
    pipelines, commits = {}, {}
    submitted=collections.defaultdict(list)
    for t in events:
        name=t.get("name","")
        if name.startswith("3D-event-"):
            marks[int(name.rsplit("-",1)[-1])]=(t["ts"],t["pid"])
        elif name.startswith("3D-frame-"):
            frames[int(name.rsplit("-",1)[-1])]=(t["ts"],t["pid"])
        elif name=="EventLatency":
            key=(t["pid"],t.get("id2",{}).get("local"))
            if t["ph"]=="b":
                started[key]=(t["ts"],t["args"]["event_latency"])
            elif t["ph"]=="e" and key in started:
                begin,data=started.pop(key)
                if "display_trace_id" in data:
                    reported[(data["event_type"],t["pid"])].append((begin,t["ts"],data["display_trace_id"]))
        elif name in ("PipelineReporter","SendBeginMainFrameToCommit") and "devtools.timeline.frame" in t.get("cat",""):
            key=(t["pid"],t.get("id2",{}).get("local"))
            if name=="SendBeginMainFrameToCommit" and t["ph"]=="e":
                commits[key]=t["ts"]
            elif name=="PipelineReporter":
                if t["ph"]=="b":
                    pipelines[key]=t["args"]["frame_reporter"]["state"]
                elif t["ph"]=="e" and key in pipelines:
                    state=pipelines.pop(key)
                    commit=commits.pop(key,None)
                    if commit is not None and state=="STATE_PRESENTED_ALL":
                        submitted[t["pid"]].append((commit,t["ts"]))
    gestures={}
    for name,kind in {"orbit":"MOUSE_DRAGGED","pan":"MOUSE_DRAGGED","zoom":"MOUSE_WHEEL"}.items():
        sample={}
        per_renderer={}
        for i,event in enumerate(probe["events"]):
            if event["stage"]!=name:
                continue
            m,pid=marks[i]
            if pid not in per_renderer:
                refs=sorted(reported[(kind,pid)])
                per_renderer[pid]=([r[0] for r in refs],refs)
            starts,refs=per_renderer[pid]
            j=bisect.bisect_left(starts,m)
            candidates=refs[max(j-5,0):j+5]
            if not candidates:
                continue
            chosen=min(candidates,key=lambda c:abs(c[0]-m))
            if abs(chosen[0]-m)<=200 and chosen[0] not in sample:
                sample[chosen[0]]=chosen
        latencies=[(p-e)/1000 for e,p,_ in sample.values()]
        presented=sorted({tag:p for _,p,tag in sample.values()}.values())
        delta=[(b-a)/1000 for a,b in zip(presented,presented[1:])]
        a=source["result"]["metrics"][name]
        gestures[name]={"sent":a["sent"],"events":a["events"],"sample":stat(latencies),"presentationFrames":len(presented),
                        "fps":round(1000/statistics.mean(delta),2) if delta else None,
                        "gaps":stat(delta),
                        "DOMDelivery":stat([e["t"]-e["time"] for e in probe["events"] if e["stage"]==name])}
    openings={}
    for action in ("cold","reopen"):
        key=next(i for i,e in enumerate(probe["events"]) if e["stage"]==action)
        ready=source["result"]["scene"]["bodies"]
        candidates=[(i,f) for i,f in enumerate(probe["frames"]) if f["stage"]==action and f["draw"]]
        moments={"first":candidates[0][0],"detail":next(i for i,f in candidates if f.get("layers") and f.get("bodies",0)>=ready)}
        for label,i in moments.items():
            time,pid=frames[i]
            commit=[(c,e) for c,e in submitted[pid] if c>=time]
            if commit:
                # The first complete frame commit following the viewer's draw
                # on the renderer process supplies compositor feedback.
                until=min(commit)[1]
                openings[action+"_"+label+"Ms"]=round((until-marks[key][0])/1000,3)
    print(json.dumps({"board":source["result"]["id"],"openPresentation":openings,"gestures":gestures},ensure_ascii=False))
for a in sys.argv[1:]:
    for p in sorted(Path(a).glob("*-probe.json")):
        report(p)
