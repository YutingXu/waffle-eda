"""Forward one FolderFiles snapshot or commit for a native fixture test."""
import base64, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from folder_files import FolderFiles
folder = FolderFiles(Path(sys.argv[2]))
try:
    request = json.load(sys.stdin)
    if 'plan' in request:
        result = folder.commit(request['projectId'], request['plan'], {})
    else:
        with folder.snapshot() as (read, hashes):
            result = {'files': []}
            for name in request['paths']:
                raw = read(name)
                result['files'].append(dict(path=name, length=len(raw), sha256=hashes[name], data=base64.b64encode(raw).decode('ascii')))
    print(json.dumps(result))
finally:
    folder.close()
