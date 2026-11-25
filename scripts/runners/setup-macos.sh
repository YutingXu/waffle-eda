#!/bin/sh
# Registers this Mac (Apple Silicon) as a self-hosted GitHub Actions runner for Atrium and installs
# it as a launchd LaunchAgent, so it runs in the logged-in GUI session (the macOS harness needs one).
#   scripts/runners/setup-macos.sh --repo OWNER/REPO            (token from RUNNER_TOKEN or gh)
#   scripts/runners/setup-macos.sh --repo OWNER/REPO --remove   (unregister, remove the service)
# Labels: self-hosted, macOS, ARM64 (added by the runner) plus "atrium". See scripts/runners/README.md.
set -eu
OS_LABEL=macos
. "$(dirname "$0")/common.sh"
parse_args "$@"
[ "$(uname -s)" = Darwin ] || { echo "run this on macOS" >&2; exit 1; }
case $(uname -m) in arm64) platform=osx-arm64 ;; x86_64) platform=osx-x64 ;; *) echo "unsupported CPU" >&2; exit 1 ;; esac

if [ "$REMOVE" = 1 ]; then
  if [ -x "$DIR/svc.sh" ]; then (cd "$DIR" && ./svc.sh stop || true; ./svc.sh uninstall || true); fi
  unregister
  echo "Runner removed from $REPO. Delete $DIR when you no longer need its logs."
  exit 0
fi

for tool in xcrun python3 curl; do command -v $tool >/dev/null || { echo "missing $tool (install the Xcode command-line tools)" >&2; exit 1; }; done
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || [ -x /Applications/Chromium.app/Contents/MacOS/Chromium ] ||
  echo "warning: Google Chrome not found; the click-through, reachability and perf steps need it"
download "$platform"
configure
if [ "$SERVICE" = 1 ]; then
  cd "$DIR"
  ./svc.sh install   # ~/Library/LaunchAgents/actions.runner.<owner>-<repo>.<name>.plist
  ./svc.sh start
  ./svc.sh status
else
  echo "Configured. Start it with: $DIR/run.sh"
fi
