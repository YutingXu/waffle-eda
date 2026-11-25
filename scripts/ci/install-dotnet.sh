#!/bin/sh
# Installs a pinned .NET SDK in user space (no sudo) after checking its SHA-512 against the value
# from Microsoft's release metadata (https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json),
# and prints the path of the dotnet executable. Re-runs reuse the verified install.
# Used by scripts/ci-local.sh to cross-build and test the Windows host (native/windows) on macOS.
#   DOTNET=$(scripts/ci/install-dotnet.sh)   Env: DOTNET_ROOT_DIR (default ~/.cache/atrium-ci/dotnet-<version>)
set -eu
SDK_VERSION=8.0.428
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  rid=osx-arm64;   sha=c2930ce6363417165142e5610992df1430b1cf93f4b5ac31027da611a6bc089a73e7062eed0200be3e4a32db893a92c86fc27816a53521e5b041aafba0aa1215 ;;
  Darwin-x86_64) rid=osx-x64;     sha=273bfca1f5b5019d4dbec47dce3543ebe825510934e2fb86f5433ca32e0690a824261d1e561a9d3140b8f806048dc1a280c979058de0a966c1acc672abf7c0bb ;;
  Linux-aarch64) rid=linux-arm64; sha=bcc10091e404baaec01d538be8bd7125a33a8338594a6a795b1036128ace747a450d3f1482f16210b6a7ee937b911488676109156ec2c905ce31030badb1b0f2 ;;
  Linux-x86_64)  rid=linux-x64;   sha=33212bb99a2bf003973d41106c7e8fe94208a12958ff601d4a476be379403c85a7dc9183a6ec64dfb44ded7102965be09f35add1758e68e9251bae7891d7b7bf ;;
  *) echo "install-dotnet: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
dir=${DOTNET_ROOT_DIR:-$HOME/.cache/atrium-ci/dotnet-$SDK_VERSION}
if [ -x "$dir/dotnet" ] && [ "$(cat "$dir/.verified" 2>/dev/null)" = "$sha" ]; then echo "$dir/dotnet"; exit 0; fi
file=dotnet-sdk-$SDK_VERSION-$rid.tar.gz
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL --proto '=https' -o "$tmp/$file" "https://builds.dotnet.microsoft.com/dotnet/Sdk/$SDK_VERSION/$file"
if command -v sha512sum >/dev/null; then actual=$(sha512sum "$tmp/$file" | cut -d' ' -f1); else actual=$(shasum -a 512 "$tmp/$file" | cut -d' ' -f1); fi
[ "$actual" = "$sha" ] || { echo "install-dotnet: SHA-512 mismatch for $file" >&2; exit 1; }
rm -rf "$dir"; mkdir -p "$dir"
tar -xzf "$tmp/$file" -C "$dir"
echo "$sha" > "$dir/.verified"
echo "$dir/dotnet"
