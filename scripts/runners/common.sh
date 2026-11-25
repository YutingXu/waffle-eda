# Shared by setup-macos.sh and setup-linux.sh (sourced, not run). POSIX sh.
# Parses arguments, obtains a registration token without printing it, downloads the official
# actions/runner release and verifies its SHA-256 before anything is unpacked.

# Pinned runner release. The SHA-256 values are copied from the release notes of
# https://github.com/actions/runner/releases/tag/v2.338.2 ("SHA-256 Checksums").
# With RUNNER_VERSION=x.y.z the script instead reads the checksum from that release's notes.
PINNED_VERSION=2.338.2
pinned_sha() {
  case $1 in
    osx-arm64)   echo 25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388 ;;
    osx-x64)     echo 109fff505a34014a7e8d1acb850c33d404811102f572b8fb9788e2fff013cc49 ;;
    linux-arm64) echo 670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 ;;
    linux-x64)   echo baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: $0 --repo OWNER/REPO [options]
  --repo OWNER/REPO   repository to register with (e.g. YutingXu/waffle-eda); or env RUNNER_REPO
  --token TOKEN       registration token; prefer env RUNNER_TOKEN (arguments are visible in ps).
                      Without either, the script asks gh (gh auth login, admin on the repo):
                      gh api -X POST repos/OWNER/REPO/actions/runners/registration-token
  --name NAME         runner name (default: atrium-<os>-<short hostname>)
  --dir DIR           install folder (default: \$HOME/actions-runner-atrium)
  --labels LIST       extra labels, comma-separated (default: atrium). The runner adds
                      self-hosted, the OS (macOS/Linux) and the architecture (ARM64/X64) itself.
  --no-service        configure only; start it yourself with DIR/run.sh
  --remove            unregister the runner in DIR and remove its service (keeps DIR)
EOF
  exit 2
}

parse_args() {
  REPO=${RUNNER_REPO:-} TOKEN=${RUNNER_TOKEN:-} NAME= DIR=$HOME/actions-runner-atrium LABELS=atrium SERVICE=1 REMOVE=0
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) REPO=${2:?}; shift ;;
      --token) TOKEN=${2:?}; shift ;;
      --name) NAME=${2:?}; shift ;;
      --dir) DIR=${2:?}; shift ;;
      --labels) LABELS=${2:?}; shift ;;
      --no-service) SERVICE=0 ;;
      --remove) REMOVE=1 ;;
      -h|--help) usage ;;
      *) echo "unknown argument: $1" >&2; usage ;;
    esac
    shift
  done
  case $REPO in */*) ;; *) echo "--repo OWNER/REPO is required" >&2; usage ;; esac
  [ -n "$NAME" ] || NAME=atrium-$OS_LABEL-$(hostname -s 2>/dev/null || hostname)
}

# token KIND: KIND is registration-token or remove-token. Never echoes the token.
token() {
  if [ -n "$TOKEN" ]; then return 0; fi
  command -v gh >/dev/null || { echo "No token: set RUNNER_TOKEN, pass --token, or install and log in to gh" >&2; exit 1; }
  TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/$1" --jq .token) && [ -n "$TOKEN" ] ||
    { echo "gh could not create a $1 for $REPO (needs admin rights on the repository)" >&2; exit 1; }
}

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# download PLATFORM (osx-arm64, linux-arm64, ...): fetches and verifies into $DIR, then unpacks.
download() {
  platform=$1 version=${RUNNER_VERSION:-$PINNED_VERSION}
  if [ "$version" = "$PINNED_VERSION" ]; then
    expected=$(pinned_sha "$platform") || { echo "no pinned checksum for $platform" >&2; exit 1; }
  else
    # The release notes carry "<!-- BEGIN SHA platform -->hash<!-- END SHA platform -->".
    expected=$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v$version" |
      sed -n "s/.*BEGIN SHA $platform -->\([0-9a-f]\{64\}\)<!-- END SHA.*/\1/p" | head -n1)
    [ -n "$expected" ] || { echo "no SHA-256 for $platform in the v$version release notes" >&2; exit 1; }
  fi
  file=actions-runner-$platform-$version.tar.gz
  mkdir -p "$DIR"
  if [ -x "$DIR/config.sh" ]; then echo "$DIR already holds a runner; use --remove first, or --dir"; exit 1; fi
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  echo "Downloading actions/runner v$version ($platform)"
  curl -fsSL --proto '=https' -o "$tmp/$file" "https://github.com/actions/runner/releases/download/v$version/$file"
  actual=$(sha256_of "$tmp/$file")
  if [ "$actual" != "$expected" ]; then echo "SHA-256 mismatch for $file: got $actual, expected $expected" >&2; exit 1; fi
  echo "SHA-256 verified: $actual"
  tar -xzf "$tmp/$file" -C "$DIR"
}

configure() {
  token registration-token
  cd "$DIR" || exit 1
  # --work is relative to DIR. --replace re-uses the name if a runner of that name is registered.
  ./config.sh --unattended --url "https://github.com/$REPO" --token "$TOKEN" --name "$NAME" \
    --labels "$LABELS" --work _work --replace --disableupdate
  TOKEN=
}

unregister() {
  cd "$DIR" || exit 1
  [ -f .runner ] || { echo "no configured runner in $DIR"; return 0; }
  token remove-token
  ./config.sh remove --token "$TOKEN"
  TOKEN=
}
