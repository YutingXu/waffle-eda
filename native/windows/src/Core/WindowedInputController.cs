using System;
using System.Threading.Tasks;

namespace Waffle.Windows
{
    static class WindowedInputController
    {
        const int NoInterface = unchecked((int)0x80004002);
        const int NotImplemented = unchecked((int)0x80004001);
        const int NotSupported = unchecked((int)0x80070032);

        internal static async Task<T> Create<T>(Func<Task<T>> withHostInput, Func<Task<T>> defaultWindowed)
        {
            try { return await withHostInput(); }
            catch (Exception error) when (error is NotSupportedException ||
                error.HResult == NoInterface || error.HResult == NotImplemented || error.HResult == NotSupported)
            {
                // The SDK can expose options that an installed older runtime lacks.
                return await defaultWindowed();
            }
        }
    }
}
