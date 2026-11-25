#!/bin/sh
# Registers this Linux host as a self-hosted GitHub Actions runner for Atrium and installs it as
# a service: a system service through the runner's svc.sh when passwordless sudo works, otherwise
# a systemd *user* service (no root needed; needs `loginctl enable-linger $USER` once, by an admin,
# so it runs while you are logged out).
#   scripts/runners/setup-linux.sh --repo OWNER/REPO            (token from RUNNER_TOKEN or gh)
#   scripts/runners/setup-linux.sh --repo OWNER/REPO --remove
# The CI jobs need only Docker on the host: the user must be in the docker group.
# Labels: self-hosted, Linux, ARM64/X64 (added by the runner) plus "atrium".
set -eu
OS_LABEL=linux
. "$(dirname "$0")/common.sh"
parse_args "$@"
[ "$(uname -s)" = Linux ] || { echo "run this on Linux" >&2; exit 1; }
case $(uname -m) in aarch64|arm64) platform=linux-arm64 ;; x86_64) platform=linux-x64 ;; *) echo "unsupported CPU" >&2; exit 1 ;; esac
unit=actions-runner-atrium.service
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [ "$REMOVE" = 1 ]; then
  if systemctl --user cat "$unit" >/dev/null 2>&1; then
    systemctl --user disable --now "$unit" || true
    rm -f "$HOME/.config/systemd/user/$unit"; systemctl --user daemon-reload
  elif [ -f "$DIR/.service" ] && sudo -n true 2>/dev/null; then
    (cd "$DIR" && sudo ./svc.sh stop || true; sudo ./svc.sh uninstall || true)
  fi
  unregister
  echo "Runner removed from $REPO. Delete $DIR when you no longer need its logs."
  exit 0
fi

command -v docker >/dev/null && docker info >/dev/null 2>&1 ||
  echo "warning: docker is not usable by $(id -un); the Linux CI job runs its steps in Docker"
download "$platform"
configure
[ "$SERVICE" = 1 ] || { echo "Configured. Start it with: $DIR/run.sh"; exit 0; }
cd "$DIR"
if sudo -n true 2>/dev/null; then
  sudo ./svc.sh install "$(id -un)"
  sudo ./svc.sh start
  sudo ./svc.sh status
else
  # Same settings as the runner's own systemd template (bin/actions.runner.service.template).
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$unit" <<UNIT
[Unit]
Description=GitHub Actions runner for $REPO ($NAME)
After=network-online.target

[Service]
ExecStart=$DIR/runsvc.sh
WorkingDirectory=$DIR
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  [ -x "$DIR/runsvc.sh" ] || cp "$DIR/bin/runsvc.sh" "$DIR/runsvc.sh"
  systemctl --user daemon-reload
  systemctl --user enable --now "$unit"
  systemctl --user --no-pager status "$unit" | head -n 5
  loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes ||
    echo "note: linger is off; the runner stops when you log out (an admin can run: loginctl enable-linger $(id -un))"
fi
