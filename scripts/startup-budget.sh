#!/bin/zsh
# Startup budget check: eager JS bytes (static), plus boot time and heap in headless Chrome.
# Usage: scripts/startup-budget.sh [--static] [--runs N] [--idle] [--json] [--measure-only]
#   --static   only the eager-JS byte budget (no browser)
# Budgets (eager JS 1050 KB, heap 3.8 MB, boot 50 ms) and their environment overrides are
# documented in tests/startup-budget.py.
root=${0:A:h:h}
args=("$@")
if (( ${args[(I)--static]} )); then args=(${args:#--static}); exec python3 $root/tests/maintenance/startup-budget.py $args; fi
exec python3 $root/tests/maintenance/startup-budget.py --chrome $args
