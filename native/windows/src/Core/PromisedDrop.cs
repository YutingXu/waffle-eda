using System;
using System.IO;
using System.Text;

namespace Waffle.Windows
{
    // An OLE file descriptor names approved bytes. It can never name a path
    // for the receiver to open. Support one Unicode media promise per gesture.
    static class PromisedDrop
    {
        internal const int DescriptorBytes = 4 + 72 + 260 * 2;
        const uint HasAttributes = 0x4, IsDirectory = 0x10, HasFileSize = 0x40;

        internal static string Media(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || name.Length > 255 ||
                Encoding.UTF8.GetByteCount(name) > 255 || name.IndexOfAny(new[]{'/','\\',':','<','>','"','|','?','*'}) >= 0)
                return null;
            foreach (char c in name) if (Char.IsControl(c)) return null;
            switch (Path.GetExtension(name).ToLowerInvariant())
            {
                case ".pdf":return "application/pdf";
                case ".png":return "image/png";
                case ".jpeg":case ".jpg":return "image/jpeg";
                case ".webp":return "image/webp";
                case ".heic":return "image/heic";
                case ".heif":return "image/heif";
                case ".svg":return "image/svg+xml";
                default:return null;
            }
        }

        static uint Dword(byte[] data,int i) => (uint)data[i] | (uint)data[i+1]<<8 |
            (uint)data[i+2]<<16 | (uint)data[i+3]<<24;

        internal static bool TryDescribe(byte[] data,out string name,out int? length)
        {
            name=null; length=null;
            if (data == null || data.Length < DescriptorBytes || Dword(data,0) != 1) return false;
            uint flags = Dword(data,4);
            if ((flags & HasAttributes) != 0 && (Dword(data,40) & IsDirectory) != 0) return false;
            if ((flags & HasFileSize) != 0)
            {
                if (Dword(data,68) != 0 || Dword(data,72) == 0 || Dword(data,72) > NotebookInput.MaxBytes)
                    return false;
                length = (int)Dword(data,72);
            }
            const int start = 76;
            int end=start;
            while (end<DescriptorBytes && (data[end]!=0 || data[end+1]!=0)) end+=2;
            if (end == DescriptorBytes) return false;
            try {name=new UnicodeEncoding(false,false,true).GetString(data,start,end-start);}
            catch (DecoderFallbackException) {return false;}
            return Media(name) != null;
        }
    }
}
