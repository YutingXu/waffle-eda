/* Test oracle. Link only to the stock zlib 1.2.12 static library from docs/format-2.md. */
#include <stdio.h>
#include "zlib.h"
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

int main(void) {
    z_stream stream = {0};
    gz_header header = {0};
    unsigned char input[32768], output[32768];
    int result;
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) < 0 || _setmode(_fileno(stdout), _O_BINARY) < 0) return 1;
#endif
    if (deflateInit2(&stream, 9, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) return 1;
    header.os = 255;
    if (deflateSetHeader(&stream, &header) != Z_OK) return 2;
    do {
        stream.next_in = input;
        stream.avail_in = (uInt) fread(input, 1, sizeof input, stdin);
        if (ferror(stdin)) return 3;
        const int flush = feof(stdin) ? Z_FINISH : Z_NO_FLUSH;
        do {
            stream.next_out = output;
            stream.avail_out = (uInt) sizeof output;
            result = deflate(&stream, flush);
            if (result != Z_OK && result != Z_STREAM_END) return 4;
            const size_t bytes = sizeof output - stream.avail_out;
            if (fwrite(output, 1, bytes, stdout) != bytes) return 5;
        } while (!stream.avail_out && result != Z_STREAM_END);
    } while (result != Z_STREAM_END);
    return deflateEnd(&stream) != Z_OK || fflush(stdout) != 0;
}
