"""Check installed GTK codecs, captured file capabilities, PDF crops and atomic folder saves."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading

sys.path.insert(0,"/usr/share/waffle/native/linux")
import folder_project
import notebook_media as media

src=Path(sys.argv[1]); grant="fixture";owner="sheet"
line=lambda o:json.dumps(o,separators=(",",":"),sort_keys=True)+"\n"
sha=lambda raw:hashlib.sha256(raw).hexdigest()
results={}
with tempfile.TemporaryDirectory() as scratch, ThreadPoolExecutor(1) as queue:
    path=Path(scratch)
    manifest="Bench.waffle";sheet="Bench.wsch"
    hdr=line({"kind":"schematic","formatVersion":"2.0","id":owner})
    meta=line({"kind":"project","formatVersion":"2.0","id":"p","name":"Notebook"})+line({"kind":"document","id":owner,"docKind":"schematic","name":"Bench","path":sheet})
    (path/manifest).write_text(meta);(path/sheet).write_text(hdr)
    root=folder_project.RootFolder(path,manifest)
    def resolve(g):
        if g!=grant: raise ValueError("The fixture grant is closed.")
        return root
    bridge=media.Bridge(queue,resolve)
    def call(action,**fields):
        done=threading.Event();result=[]
        def received(value=None,error=None):
            result.extend([value,error]);done.set()
        bridge.run(action,{"grant":grant,"ownerId":owner,**fields},received)
        assert done.wait(20),action+" timed out"
        if result[1]: raise ValueError(result[1])
        return result[0]
    try:
        for suffix,mime in [("png","image/png"),("jpg","image/jpeg"),("heic","image/heic"),("webp","image/webp")]:
            raw=(src/("pattern."+suffix)).read_bytes()
            out=call("notebookMedia",op="decode",mediaType=mime,data=media.encoded(raw),sha256=sha(raw),side=128,png=True)
            assert out["extent"]==[400,200] and [out["width"],out["height"]]==[128,64],out["extent"]
            assert len(base64.b64decode(out["rgba"]))==128*64*4
            results[mime]=[out["width"],out["height"]]
        raw=(src/"pages.pdf").read_bytes()
        cancelled=bridge.offer_drop(grant,owner,src/"pages.pdf");assert cancelled
        assert call("notebookDrop",dropToken=cancelled,discard=True)
        assert not call("notebookDrop",dropToken=cancelled,discard=True)
        token=bridge.offer_drop(grant,owner,src/"pages.pdf");assert token
        try: call("notebookDrop",dropToken=token,ownerId="other-sheet")
        except ValueError: pass
        else: raise AssertionError("A different sheet consumed the dropped file")
        placed=call("notebookDrop",dropToken=token);source=placed["assetRef"]
        assert source["sha256"]==sha(raw) and placed["name"]=="pages.pdf"
        try: call("notebookDrop",dropToken=token)
        except ValueError: pass
        else: raise AssertionError("Drop capability must be single-use")
        positions={"page":2,"region":[100000,100000,400000,400000],"side":120}
        assert call("notebookMedia",op="pdfInfo",data=media.encoded(raw))["pages"]==2
        clip=call("notebookClip",assetRef=source,assetToken=placed["assetToken"],**positions)
        assert [clip["width"],clip["height"]]==[72,120]
        ref=clip["assetRef"]
        owned=line({"kind":"image","id":"clip","asset":ref,"clip":{"source":source,"name":"pages.pdf",**positions}})
        plan=[{"path":"assets/"+a["assetRef"]["sha256"],"expected":None,"assetToken":a["assetToken"]} for a in (placed,clip)]
        plan.append({"path":sheet,"expected":sha(hdr.encode()),"text":hdr+owned})
        acks=[];root.commit("p",manifest,plan,acks.append);assert acks[0]["saved"]
        root.close();root=folder_project.RootFolder(path,manifest)
        png=media.read(root,{"ownerId":owner,"assetRef":ref},True)
        assert sha(png)==ref["sha256"] and media.read(root,{"ownerId":owner,"assetRef":source},True)==raw
        rendered=call("notebookMedia",op="decode",mediaType="image/png",sha256=ref["sha256"],data=media.encoded(png),side=120)
        rgba=base64.b64decode(rendered["rgba"])
        assert all(r>250 and g<5 and b<5 and a==255 for r,g,b,a in zip(*[iter(rgba)]*4))
        assert call("notebookDerivative",op="read",assetRef=ref,side=128)=={}
        assert call("notebookDerivative",op="write",assetRef=ref,side=128,png=media.encoded(png))["saved"]
        assert call("notebookDerivative",op="read",assetRef=ref,side=128)["sha256"]==ref["sha256"]
        results.update(pages=2,clip=[72,120],redPixels=len(rgba)//4,sourceAndSnapshot=True,warmThumb=True,sourceSHA256=sha(raw))
    finally:
        bridge.shutdown();root.close()
print(json.dumps(results,sort_keys=True))
