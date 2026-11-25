#!/usr/bin/env python3
"""Recover first-time native source-token saves, including a newly committed child, at every transition."""
import argparse
import base64
import json
from pathlib import Path

from crash import ASSET, ASSET_PATH, Driver, case, check_namespace, digest, kill_matrix, seed, temporary


def run(driver, scratch):
    out={}
    for name,owner,member in (("asset","s1","Power.wsch"),("child-asset","s2","Child.wsch")):
        state=case(name)
        tx=state.request
        tx.update(ownerId=owner,mediaType="image/png",attachment=base64.b64encode(ASSET).decode("ascii"))
        asset=tx["plan"][0]
        assert asset.pop("data")==tx["attachment"] and asset["path"]==ASSET_PATH
        asset["assetToken"]="test-token"
        events=kill_matrix(driver,state,scratch,"stage-save")
        with temporary(scratch) as name_tmp:
            folder=Path(name_tmp)
            seed(folder,state.before)
            failed,_,_=driver.call(folder,"stage-save",{**tx,"ownerId":"different-owner"})
            assert failed
            check_namespace(folder,state.before)
            success,rows,_=driver.call(folder,"stage-save",tx)
            ack=next(r for r in rows if r.get("saved"))
            assert not success and ack["hashes"][ASSET_PATH]==digest(ASSET)
            check_namespace(folder,state.after)
            read=driver.call(folder,"asset-read",{"ownerId":owner,"assetRef":{
                "sha256":digest(ASSET),"byteLength":len(ASSET),"mediaType":"image/png"},"offset":1,"length":7})
            assert read[0]==0 and base64.b64decode(read[1][0]["data"])==ASSET[1:8]
            # A second asset reference is a normal one-file edit; it never rechunks/replaces the immutable bytes.
            old=(folder/member).read_bytes()
            existing=next(line for line in old.splitlines(keepends=True) if b'"img1"' in line)
            new=old.replace(existing,existing.replace(b'"img1"',b'"img0"')+existing)
            assert old!=new
            ino=(folder/ASSET_PATH).stat().st_ino
            repeat=driver.call(folder,"commit",{"projectId":"p1","manifest":tx["manifest"],
                "plan":[{"path":member,"expected":digest(old),"text":new.decode()}]})
            assert repeat[0]==0 and set(repeat[1][0]["hashes"])=={member}
            assert (folder/ASSET_PATH).stat().st_ino==ino and (folder/ASSET_PATH).read_bytes()==ASSET
        out[name]={"processDeaths":len(events),"checkpoints":events,"wrongOwnerRejected":True,
                   "authoredFilesAtAck":len(ack["hashes"]),"savedRangeVerified":True,"secondReferenceReusedInode":True}
    return out


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--driver",required=True)
    p.add_argument("--scratch",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    a.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)
    a.out.write_text(json.dumps(run(Driver([a.driver]),a.scratch),indent=2)+"\n")


if __name__=="__main__":
    main()
