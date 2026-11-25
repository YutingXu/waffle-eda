#!/bin/sh
# Cross-builds Waffle for Windows from macOS or Linux with the .NET SDK (8 or later) and
# packages dist/Waffle-<version>-windows.zip. The host targets .NET Framework 4.8, which ships
# with Windows; reference assemblies come from NuGet, so no Windows machine is needed to build.
# Packaging also needs Python 3 and the pinned Rust toolchain with the WASM target.
# Run the built app on Windows (native/windows/README.md lists what to check).
#   scripts/build-windows.sh [out-dir]        DOTNET=/path/to/dotnet to pick the SDK
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:-"$root/dist"}
out=$(mkdir -p "$out" && cd "$out" && pwd)
dotnet=${DOTNET:-dotnet}
command -v "$dotnet" >/dev/null 2>&1 || { echo "The .NET SDK is missing; install it or set DOTNET=/path/to/dotnet" >&2; exit 2; }
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
win="$root/native/windows"
"$dotnet" run --project "$win/tests" -c Release
"$dotnet" build "$win/Waffle.Windows.csproj" -c Release -t:WafflePackage -p:EnableWindowsTargeting=true -p:WaffleDist="$out" -nologo -v:minimal
