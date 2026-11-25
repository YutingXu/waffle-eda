#!/bin/sh
# Linux CI: the same steps .github/workflows/ci.yml runs on the self-hosted Linux runner, each in a
# throwaway container (scripts/ci/linux.Dockerfile). The host needs Docker, Git and Python 3 (no sudo or Node).
# Containers run as the calling user with no network, all capabilities dropped, the checkout
# mounted read-only and a tmpfs work folder. The deb and optional soak reports use /out.
#
# Usage: scripts/ci-linux.sh [step ...]       (no steps = all, in this order)
#   images rust node mcp static native webkitgtk deb browser
#   soak (separate five-minute editing job; opt in explicitly)
#   (rust: cargo test and the reproducible build check of app/engine-core.js in the pinned rust image)
#   (deb also runs deb-install: dpkg -i as root in a fresh, network-less container)
# Env: OUT=folder for the .deb or optional soak measurements (the default .deb folder is temporary)
#      CI_IMAGE_PREFIX=atrium-ci (image names: <prefix>-ubuntu:<hash>, <prefix>-browser:<hash>)
set -u
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ci=$root/scripts/ci
prefix=${CI_IMAGE_PREFIX:-atrium-ci}
command -v docker >/dev/null || { echo "docker not found" >&2; exit 2; }
[ $# -gt 0 ] || set -- images rust node mcp static native webkitgtk deb browser

# Image tags follow the content of scripts/ci, so a changed Dockerfile, lockfile or Node pin rebuilds.
hash=$(cd "$ci" && cat linux.Dockerfile install-node.sh package.json package-lock.json | sha256sum | cut -c1-12)
ubuntu=$prefix-ubuntu:$hash
browser=$prefix-browser:$hash
rust=$prefix-rust:$hash

images() {
  for target in ubuntu browser rust; do
    tag=$prefix-$target:$hash
    if docker image inspect "$tag" >/dev/null 2>&1; then echo "image $tag is up to date"; continue; fi
    docker build --pull=false --target "$target" -t "$tag" -f "$ci/linux.Dockerfile" "$ci" || return 1
    # Drop older builds of this image so the runner's disk does not fill up.
    docker images --format '{{.Repository}}:{{.Tag}}' "$prefix-$target" | grep -vx "$tag" | xargs -r docker rmi >/dev/null 2>&1
  done
  return 0
}

out_tmp=
cleanup() { [ -n "$out_tmp" ] && rm -rf "$out_tmp"; }
trap cleanup EXIT HUP INT TERM

in_container() { # in_container IMAGE STEP [extra docker args...]
  image=$1 step=$2; shift 2
  docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --pids-limit 4096 --memory 16g --shm-size 1g \
    --tmpfs /work:rw,exec,mode=1777,size=8g \
    -v "$root:/src:ro" -e CI="${CI:-}" -e GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" \
    "$@" "$image" sh /src/scripts/ci/linux-steps.sh "$step"
}

fail=0
for step in "$@"; do
  echo "=== linux: $step"
  case $step in
    images) images ;;
    static)
      python3 -B "$root/tests/maintenance/public-tree.py" || { fail=1; continue; }
      if [ -e "$root/.git" ]; then
        python3 -B "$root/scripts/check-source-roots.py" &&
          python3 -B "$root/tests/maintenance/retired-doc-links.py" &&
          python3 -B "$root/scripts/prepare-assets.py" --check-untracked && in_container "$ubuntu" static
      else
        echo "SKIP tracked source roots: source archive"
        in_container "$ubuntu" static
      fi ;;
    node|mcp|native|webkitgtk) in_container "$ubuntu" "$step" ;;
    browser) in_container "$browser" "$step" ;;
    soak)
      if [ -n "${OUT:-}" ]; then
        mkdir -p "$OUT" && soak_out=$(cd "$OUT" && pwd) && in_container "$browser" soak -v "$soak_out:/out"
      else
        in_container "$browser" soak
      fi ;;
    rust) in_container "$rust" rust ;;
    deb)
      if [ -z "${OUT:-}" ]; then out_tmp=$(mktemp -d); OUT=$out_tmp; fi
      mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
      in_container "$ubuntu" deb -v "$OUT:/out" &&
      # dpkg needs root; this container is fresh, network-less and sees the package read-only.
      docker run --rm --init --network none --security-opt no-new-privileges --tmpfs /work:rw,exec,mode=1777 \
        -v "$root:/src:ro" -v "$OUT:/out:ro" "$ubuntu" sh /src/scripts/ci/linux-steps.sh deb-install ;;
    *) echo "unknown step $step" >&2; exit 2 ;;
  esac
  rc=$?
  if [ $rc -eq 0 ]; then echo "=== linux: $step passed"; else echo "=== linux: $step FAILED (exit $rc)"; fail=1; fi
done
exit $fail
