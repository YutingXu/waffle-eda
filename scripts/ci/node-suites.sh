#!/bin/sh
# Runs Node suites and registered Python harness checks, one process per suite, printing
# "ok    name" or "FAIL  name: diagnostic (exit N)" like scripts/test-jsc.sh.
# The inventory exits 1 on any failure. CI filters known failures with scripts/ci/check-results.py node LOG.
# Usage: scripts/ci/node-suites.sh [name ...]   Env: NODE_TEST_TIMEOUT seconds per suite (default 300)
#        SKIP="name ..." suites to leave out (integration-browser runs in the browser image).
#        ATRIUM_TEST_FIXTURES=/directory for the three UI suites using external Altium files.
fixture_dir=${ATRIUM_TEST_FIXTURES:-}
case $fixture_dir in ""|/*) ;; *) fixture_dir="$PWD/$fixture_dir" ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root" || exit 2
command -v node >/dev/null || { echo "node not found" >&2; exit 2; }
python3 -B "$root/scripts/prepare-assets.py" || exit 2
suite_paths=$(python3 -B "$root/tests/support/suite-paths.py" node "$@") || exit 2

# Keep the full Chromium inventory in the test file. Each group gets the normal suite limit.
run_integration_browser() {
  [ -z "${CHROME:-}" ] || set -- "$@" --executable "$CHROME"
  browser_timeout=${NODE_TEST_TIMEOUT:-300}
  browser_groups=$(timeout "$browser_timeout" node "$@" --list-ci-groups) || return $?
  if [ -z "$browser_groups" ]; then
    echo "FAIL Chromium integration has no groups"
    return 1
  fi
  browser_result=0
  for browser_group in $browser_groups; do
    group_start=$(date +%s)
    timeout "$browser_timeout" node "$@" --group "$browser_group"
    group_status=$?
    elapsed=$(($(date +%s) - group_start))
    printf 'Chromium integration %s: %ss (exit %s)\n' "$browser_group" "$elapsed" "$group_status"
    if [ "$group_status" -ne 0 ]; then
      printf 'FAIL Chromium integration %s (exit %s)\n' "$browser_group" "$group_status"
      browser_result=1
    fi
  done
  return "$browser_result"
}

fail=0
while IFS= read -r f <&3; do
  [ -n "$f" ] || continue
  n=${f##*/}
  n=${n%.*}
  case " ${SKIP:-} " in *" $n "*) continue ;; esac
  case $f in native/tests/*) n=native-$n ;; esac
  if [ "$n" = native-palette-extension-detail ] && [ "$(uname -s)" != Darwin ]; then
    echo "SKIP  $n: requires the macOS AppKit/WKWebView harness"
    continue
  fi
  case $n in
    sch-restore-ui|wire-edit-ui) required_fixtures="Level.Shifter.SchDoc" ;;
    source-copy-ui) required_fixtures="Level.Shifter.SchDoc qfsae-0.PcbDoc" ;;
    *) required_fixtures= ;;
  esac
  missing=
  for fixture in $required_fixtures; do
    if [ -z "$fixture_dir" ] || [ ! -f "$fixture_dir/$fixture" ]; then
      missing="${missing:+$missing and }$fixture"
    fi
  done
  if [ -n "$missing" ]; then
    echo "SKIP  $n: set ATRIUM_TEST_FIXTURES to a directory containing $missing"
    continue
  fi
  # integration-browser takes the browser from CHROME (the Linux browser image sets it).
  if [ -n "$required_fixtures" ]; then
    out=$(timeout "${NODE_TEST_TIMEOUT:-300}" node "$f" --fixtures "$fixture_dir" 2>&1); rc=$?
  elif [ "$n" = integration-browser ]; then
    out=$(run_integration_browser "$f" 2>&1); rc=$?
  else
    case $f in
      *.py) set -- python3 -B "$f" ;;
      *) set -- node "$f" ;;
    esac
    out=$(timeout "${NODE_TEST_TIMEOUT:-300}" "$@" 2>&1); rc=$?
  fi
  case $rc in
    0)
      if [ "$n" = integration-browser ]; then
        printf '%s\n' "$out" | awk '/^Chromium integration /'
      fi
      echo "ok    $n"
      continue ;;
    124) detail="timed out after ${NODE_TEST_TIMEOUT:-300}s" ;;
    *)
      detail=$(printf '%s\n' "$out" | awk '
        NF && first == "" {first = $0}
        tolower($0) ~ /^[[:space:]]*((error|[[:alpha:]][[:alnum:]_.]*error)([[:space:]]+\[[^]]+\])?:|fail([[:space:]:]|$)|[[:alnum:]_.]+:[[:space:]]*timeout[[:space:]])/ {
          cause = $0; exit
        }
        END {print substr(cause != "" ? cause : first, 1, 160)}
      ')
      detail=${detail:-no diagnostic output} ;;
  esac
  printf 'FAIL  %s: %s (exit %s)\n' "$n" "$detail" "$rc"
  if [ "$n" = integration-browser ]; then
    # Indent browser diagnostics so the inventory parser reads only the summary.
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
  fail=1
done 3<<SUITE_PATHS
$suite_paths
SUITE_PATHS
exit $fail
