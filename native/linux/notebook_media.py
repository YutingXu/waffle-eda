"""Scoped media producers for the Linux desktop. All codec work is off GTK's main thread."""
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import math
import os
import re
import stat
import struct
import threading
import uuid

import folder_project

MAX_BYTES = 128 << 20
MAX_PIXELS = 8 << 20
TIERS = (128, 256, 512, 1024, 2048, 4096)
RASTER = {"image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"}
MEDIA = RASTER | {"application/pdf", "image/svg+xml"}


def encoded(data):
    return base64.b64encode(data).decode("ascii")


def bytes_of(text, cap):
    if not isinstance(text, str) or not 0 < len(text) <= 4*((cap+2)//3):
        raise ValueError("The selected media exceeds its allowed size.")
    try:
        data = base64.b64decode(text,validate=True)
    except (binascii.Error, TypeError):
        raise ValueError("The selected media transfer is incomplete.") from None
    if not 0 < len(data) <= cap:
        raise ValueError("Invalid media length.")
    return data


def bound(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("Invalid media dimensions or selection.")
    return value


def png_size(data, side):
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("Invalid PNG display data.")
    width,height=struct.unpack(">II",data[16:24])
    if not (0 < width <= side and 0 < height <= side and width*height <= MAX_PIXELS):
        raise ValueError("Invalid PNG display dimensions.")
    return width,height


def pdf(data, request):
    import gi
    gi.require_version("Poppler","0.18")
    from gi.repository import GLib, Poppler
    import cairo
    doc=Poppler.Document.new_from_bytes(GLib.Bytes.new(data),None)
    count=bound(doc.get_n_pages(),1,100000)
    if request["op"] == "pdfInfo":
        return {"pages":count}
    page=doc.get_page(bound(request.get("page"),1,count)-1)
    width,height=page.get_size()
    region=request.get("region")
    if not isinstance(region,list) or len(region)!=4:
        raise ValueError("Choose a datasheet region.")
    left,top,right,bottom=[bound(v,0,1000000)/1000000 for v in region]
    if not (left<right and top<bottom and 0<width<=1e7 and 0<height<=1e7):
        raise ValueError("Choose a nonempty datasheet region.")
    rw,rh=width*(right-left),height*(bottom-top)
    side=bound(request.get("side",1200),1,4096)
    scale=min(side/max(rw,rh),math.sqrt(MAX_PIXELS/(rw*rh)),32)
    w,h=max(1,round(rw*scale)),max(1,round(rh*scale))
    surface=cairo.ImageSurface(cairo.FORMAT_ARGB32,w,h)
    ctx=cairo.Context(surface)
    ctx.set_source_rgb(1,1,1);ctx.paint()
    ctx.scale(w/rw,h/rh);ctx.translate(-width*left,-height*top)
    page.render(ctx)
    output=io.BytesIO();surface.write_to_png(output);surface.finish()
    return {"width":w,"height":h,"physical":[rw,rh],"png":encoded(output.getvalue())}


def raster(data, request, media):
    import gi
    gi.require_version("GdkPixbuf","2.0")
    from gi.repository import GdkPixbuf
    side=bound(request.get("side",1200),1,4096)
    loader=GdkPixbuf.PixbufLoader.new()
    dimensions=[]
    def prepare(_loader,width,height):
        dimensions[:]=[width,height]
        if width<=0 or height<=0 or max(width,height)>100000 or width*height>120000000:
            loader.set_size(1,1)
            return
        scale=min(1,side/max(width,height),math.sqrt(MAX_PIXELS/(width*height)))
        loader.set_size(max(1,round(width*scale)),max(1,round(height*scale)))
    loader.connect("size-prepared",prepare)
    for offset in range(0,len(data),1<<20):
        loader.write(data[offset:offset+(1<<20)])
    loader.close()
    image=loader.get_pixbuf()
    if image is None or len(dimensions)!=2 or max(dimensions)>100000 or min(dimensions)<1 or math.prod(dimensions)>120000000:
        raise ValueError("The system codec could not decode these image dimensions.")
    orientation=int(image.get_option("orientation") or 1)
    extent=list(reversed(dimensions)) if orientation in (5,6,7,8) else dimensions
    if request["op"]=="info":
        return {"extent":extent,"mediaType":media}
    image=image.apply_embedded_orientation()
    w,h=image.get_width(),image.get_height()
    if w*h>MAX_PIXELS or max(w,h)>side:
        shrink=min(side/max(w,h),math.sqrt(MAX_PIXELS/(w*h)))
        w,h=max(1,round(w*shrink)),max(1,round(h*shrink))
        image=image.scale_simple(w,h,GdkPixbuf.InterpType.BILINEAR)
    if not image.get_has_alpha():
        image=image.add_alpha(False,0,0,0)
    stride=image.get_rowstride()
    pixels=image.get_pixels()
    rgba=b"".join(pixels[y*stride:y*stride+4*w] for y in range(h))
    out={"width":w,"height":h,"extent":extent,"rgba":encoded(rgba)}
    if request.get("png"):
        ok, compressed=image.save_to_bufferv("png",[],[])
        if not ok:
            raise ValueError("Failed to encode the display PNG.")
        out["png"]=encoded(compressed)
    return out


def render(data, request):
    media=folder_project.asset_media(data[:8192])
    if request.get("sha256") and hashlib.sha256(data).hexdigest()!=request.get("sha256"):
        raise ValueError("The image bytes have changed.")
    if media=="application/pdf" and request.get("op") in ("pdfPage","pdfInfo"):
        return pdf(data,request)
    if media in RASTER and request.get("mediaType")==media and request.get("op") in ("info","decode"):
        return raster(data,request,media)
    raise ValueError("Unknown media or available codec.")


def read(root, request, all_bytes):
    ref=request.get("assetRef") or {}
    size=bound(ref.get("byteLength"),1,MAX_BYTES)
    args={k:request[k] for k in ("ownerId","assetRef","assetToken") if k in request}
    lease=None
    if not args.get("assetToken"):
        lease=root.acquire()
        args["lease"]=lease
    try:
        data=bytearray()
        while len(data)<size:
            n=min(1<<20,size-len(data)) if all_bytes else 1
            result=root.read_asset({**args,"purpose":"notebook-preview","offset":len(data),"length":n})
            block=bytes_of(result["data"],n)
            data.extend(block)
            if not all_bytes: break
        return bytes(data)
    finally:
        if lease: root.release(lease)


def derivative(root, request):
    read(root,request,False)
    digest=request["assetRef"]["sha256"];side=request.get("side");op=request.get("op")
    if not re.fullmatch(r"[0-9a-f]{64}",digest) or side not in TIERS or op not in ("read","write"):
        raise ValueError("Invalid thumbnail request.")
    name=f"screen-v1-s{side}.png"
    try:
        with root.directory_at([".waffle","cache","images-v1",digest],create=op=="write",private=True) as (directory,verify):
            if op=="read":
                with root._file(directory,name) as (fd,info):
                    limit=8<<20
                    if not 0<info.st_size<=limit:
                        return {}
                    data=os.pread(fd,limit,0);verify()
                png_size(data,side)
                return {"png":encoded(data),"sha256":hashlib.sha256(data).hexdigest()}
            data=bytes_of(request.get("png"),8<<20);png_size(data,side)
            tmp=".media-"+uuid.uuid4().hex
            fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=directory)
            try:
                folder_project.write_all(fd,data);verify()
                os.replace(tmp,name,src_dir_fd=directory,dst_dir_fd=directory)
            finally:
                os.close(fd)
                try: os.unlink(tmp,dir_fd=directory)
                except FileNotFoundError: pass
            return {"saved":True}
    except FileNotFoundError:
        if op=="read": return {}
        raise


class Bridge:
    def __init__(self, folder_queue, resolve):
        self.folder_queue=folder_queue
        self.resolve=resolve
        self.media_queue=ThreadPoolExecutor(max_workers=2,thread_name_prefix="waffle-notebook")
        self.drops={}
        self.closing=threading.Event()

    def close_grant(self, grant):
        for token,(g,owner,fd,*_) in list(self.drops.items()):
            if g==grant:
                os.close(fd);del self.drops[token]

    def offer_drop(self, grant, owner, path):
        if not grant or not isinstance(owner,str) or not 0<len(owner.encode())<=1024 or len(self.drops)>=8: return None
        fd=os.open(path,folder_project.FILE_FLAGS)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or not 0<info.st_size<=MAX_BYTES: return None
            media=folder_project.asset_media(os.pread(fd,8192,0))
            if media not in MEDIA: return None
            self.close_grant(grant)
            token=uuid.uuid4().hex
            self.drops[token]=(grant,owner,fd,media,path.name,folder_project.stamp(info))
            fd=-1
            return token
        finally:
            if fd>=0: os.close(fd)

    def run(self, action, args, complete):
        def work(executor, calculate, success=complete):
            if self.closing.is_set():
                return complete(None,"This window has closed.")
            try:
                future=executor.submit(calculate)
            except RuntimeError:
                return complete(None,"This window has closed.")
            def done(result):
                try: value=result.result()
                except Exception as error:
                    complete(None,str(error) or "The media operation failed.")
                else: success(value)
            future.add_done_callback(done)
        grant,owner=args.get("grant"),args.get("ownerId")
        def stage(data,media,verify=False,name=None):
            def install():
                root=self.resolve(grant)
                if verify: read(root,args,False)
                result=root.stage_asset(owner,media,data=data)
                return {**result,**({"name":name} if name else {})}
            return install
        if action=="notebookMedia":
            work(self.media_queue,lambda:render(bytes_of(args.get("data"),MAX_BYTES),args))
        elif not isinstance(owner,str) or not 0<len(owner.encode())<=1024:
            complete(None,"Choose an editable attachment owner.")
        elif action=="notebookTransfer":
            if (args.get("origin") not in ("drop","paste","camera") or args.get("mediaType") not in MEDIA or
                    not isinstance(args.get("data"),str) or not 0<len(args["data"])<=4*((MAX_BYTES+2)//3)):
                return complete(None,"Choose, drop or paste supported media.")
            work(self.folder_queue,stage(args.get("data"),args["mediaType"],name=args.get("name")))
        elif action=="notebookDrop":
            token=args.get("dropToken")
            offered=self.drops.get(token) if isinstance(token,str) else None
            if not offered or offered[:2]!=(grant,owner):
                if args.get("discard") is True: return complete(False)
                return complete(None,"Drop the attachment again.")
            _,_,fd,media,name,stamp=self.drops.pop(token)
            if args.get("discard") is True:
                os.close(fd)
                return complete(True)
            def captured():
                try:
                    if folder_project.stamp(os.fstat(fd))!=stamp:
                        raise ValueError("The dropped attachment is no longer available.")
                    return {**self.resolve(grant).stage_asset(owner,media,source=fd),"name":name}
                finally: os.close(fd)
            work(self.folder_queue,captured)
        elif action=="notebookDerivative":
            work(self.folder_queue,lambda:derivative(self.resolve(grant),args))
        elif action=="notebookClip":
            if (args.get("assetRef") or {}).get("mediaType")!="application/pdf":
                return complete(None,"Choose a source datasheet.")
            def pixels(raw):
                def install(out):
                    def save():
                        result=stage(out["png"],"image/png",True)()
                        return {**result,"width":out["width"],"height":out["height"]}
                    work(self.folder_queue,save)
                work(self.media_queue,lambda:render(raw,{**args,"op":"pdfPage"}),install)
            work(self.folder_queue,lambda:read(self.resolve(grant),args,True),pixels)
        else: complete(None,"Unknown notebook action.")

    def shutdown(self):
        self.closing.set()
        self.media_queue.shutdown(wait=True)
        for grant,owner,fd,*_ in self.drops.values(): os.close(fd)
        self.drops.clear()
