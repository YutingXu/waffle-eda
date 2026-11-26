#!/bin/sh
# The updater uses real universal Mach-O signatures in an isolated fixture keychain.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/waffle-updater-test.XXXXXX")
keychain="$work/signing.keychain-db"
cleanup() {
    if [ -f "$keychain" ]; then security delete-keychain "$keychain" >/dev/null 2>&1 || true; fi
    rm -rf "$work"
}
trap cleanup EXIT
umask 077
app="$work/Waffle.app"
mkdir -p "$app/Contents/MacOS"
python3 - "$app/Contents/Info.plist" <<'PY'
import plistlib
import sys
with open(sys.argv[1], "wb") as file:
    plistlib.dump({"CFBundleIdentifier": "org.waffle.editor", "CFBundleExecutable": "Waffle",
                   "CFBundleShortVersionString": "1.2.0", "CFBundleVersion": "1", "CFBundlePackageType": "APPL"}, file)
PY
printf 'int main(void) { return 0; }\n' > "$work/app.c"
xcrun clang -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 "$work/app.c" -o "$app/Contents/MacOS/Waffle"
ditto "$app" "$work/AdHoc.app"
codesign --force --sign - --identifier org.waffle.editor "$work/AdHoc.app"

printf '%s\n' '[req]' 'distinguished_name=dn' 'x509_extensions=ext' '[dn]' '[ext]' \
    'basicConstraints=critical,CA:false' 'keyUsage=critical,digitalSignature' 'extendedKeyUsage=critical,codeSigning' > "$work/cert.cnf"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj "/CN=Waffle Updater Test" \
    -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/cert.cnf" 2>"$work/openssl.log"
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/test.p12" -passout pass:fixture \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
security create-keychain -p fixture "$keychain"
security unlock-keychain -p fixture "$keychain"
security import "$work/test.p12" -k "$keychain" -P fixture -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k fixture "$keychain" >/dev/null
codesign --force --sign "Waffle Updater Test" --keychain "$keychain" --timestamp=none --identifier org.waffle.editor "$app"
leaf=$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')
ditto "$app" "$work/OtherRequirement.app"
codesign --force --sign "Waffle Updater Test" --keychain "$keychain" --timestamp=none --identifier org.waffle.editor \
    -r="designated => identifier \"org.waffle.editor\" and certificate leaf = H\"$leaf\" and identifier \"org.waffle.editor\"" "$work/OtherRequirement.app"
# A separate bundle exits immediately before reporting readiness. This one stays alive until
# the updater actually receives its readiness marker and removes the previous bundle.
ditto "$app" "$work/Ready.app"
cat > "$work/ready.c" <<'C'
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--waffle-update-ready")) return 1;
    char applications[PATH_MAX], stage[PATH_MAX], marker[PATH_MAX];
    if (!realpath(argv[0], applications)) return 2;
    for (int i = 0; i < 4; ++i) *strrchr(applications, '/') = 0;
    snprintf(stage, sizeof(stage), "%s/%s", applications, argv[2]);
    snprintf(marker, sizeof(marker), "%s/ready", stage);
    FILE *file = fopen(marker, "w");
    if (!file) return 3;
    fprintf(file, "%d", getpid());
    fclose(file);
    for (int i = 0; i < 200 && !access(stage, F_OK); ++i) usleep(50000);
    return access(stage, F_OK) == 0 ? 4 : 0;
}
C
xcrun clang -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 "$work/ready.c" -o "$work/Ready.app/Contents/MacOS/Waffle"
codesign --force --sign "Waffle Updater Test" --keychain "$keychain" --timestamp=none --identifier org.waffle.editor "$work/Ready.app"
xattr -w com.apple.quarantine '0081;00000000;UpdaterFixture;' "$app"
ditto -c -k --keepParent --norsrc --noextattr --noqtn --noacl "$app" "$work/update.zip"

xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos12.0" -module-cache-path "$work/module-cache" \
    "$root/native/macos/Updater.swift" "$root/native/tests/updater/tests.swift" -o "$work/tests"
"$work/tests" "$work" "$leaf"
