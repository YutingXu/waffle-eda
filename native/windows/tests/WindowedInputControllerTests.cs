using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace Waffle.Windows.Tests
{
    static partial class Program
    {
        static void WindowedInputControllerTests()
        {
            group = "WebView2 windowed input";
            int defaults = 0;
            var preferred = new object();
            var fallback = new object();
            Task<object> DefaultWindowed() { defaults++; return Task.FromResult(fallback); }
            object Create(Func<Task<object>> withHostInput) =>
                WindowedInputController.Create(withHostInput, DefaultWindowed).GetAwaiter().GetResult();

            Check(ReferenceEquals(Create(() => Task.FromResult(preferred)), preferred) && defaults == 0,
                "a compatible runtime creates one controller using host input processing");
            Check(ReferenceEquals(Create(() => throw new NotImplementedException()), fallback) && defaults == 1,
                "an older runtime can reject setting the option synchronously");
            var unsupported = new Exception[] {
                new InvalidCastException(), new NotSupportedException(),
                new COMException("Unsupported option", unchecked((int)0x80070032))
            };
            foreach (var error in unsupported)
            {
                int before = defaults;
                Check(ReferenceEquals(Create(() => Task.FromException<object>(error)), fallback) && defaults == before + 1,
                    "an unavailable controller option falls back exactly once after async failure");
            }
            var failure = new IOException("Broken startup");
            int count = defaults;
            try { Create(() => Task.FromException<object>(failure)); Check(false, "real startup failure propagates"); }
            catch (IOException error) { Check(ReferenceEquals(error, failure) && defaults == count, "real startup failure propagates"); }
        }
    }
}
