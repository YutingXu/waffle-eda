using System;
using System.Text;

namespace Waffle.Windows.Tests
{
    static partial class Program
    {
        static void PromisedDropTests()
        {
            group="Approved Windows file promise descriptors";
            byte[] Descriptor(string name,int length=384,int count=1,int flags=0x40,int attributes=0)
            {
                var descriptor=new byte[PromisedDrop.DescriptorBytes];
                Array.Copy(BitConverter.GetBytes(count),0,descriptor,0,4);
                Array.Copy(BitConverter.GetBytes(flags),0,descriptor,4,4);
                Array.Copy(BitConverter.GetBytes(attributes),0,descriptor,40,4);
                Array.Copy(BitConverter.GetBytes(length),0,descriptor,72,4);
                Encoding.Unicode.GetBytes(name).CopyTo(descriptor,76);
                return descriptor;
            }
            bool Accepted(byte[] packet) => PromisedDrop.TryDescribe(packet,out _,out _);
            Check(PromisedDrop.TryDescribe(Descriptor("Données.pdf"),out var name,out var bytes) &&
                name=="Données.pdf" && bytes==384,"one regular Unicode PDF and its exact byte limit");
            Check(PromisedDrop.TryDescribe(Descriptor("Photo.heic",flags:0),out name,out bytes) &&
                name=="Photo.heic" && bytes==null,"an image with an unspecified size remains bounded by the receiver");
            Check(!Accepted(Descriptor(@"..\secret.pdf")) && !Accepted(Descriptor("C:secret.pdf")) &&
                !Accepted(Descriptor("external/name.pdf")),"names can never address local paths");
            Check(!Accepted(Descriptor("Directory.pdf",flags:0x44,attributes:0x10)) &&
                !Accepted(Descriptor("image.pdf",count:2)),"directory and multi-item promises are refused");
            Check(!Accepted(Descriptor("oversize.pdf",length:Int32.MaxValue)) &&
                !Accepted(Descriptor("empty.pdf",length:0)),"invalid expected output sizes are refused");
            Check(!Accepted(Descriptor("unsafe?.pdf")) && !Accepted(Descriptor("command.exe")) &&
                !Accepted(Descriptor(new String('x',260))),"unsafe names, formats and unterminated arrays are refused");
        }
    }
}
