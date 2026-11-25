# Self-hosted runners for Waffle EDA

Waffle EDA’s CI (`.github/workflows/ci.yml`) and release builds (`release.yml`) run on self-hosted
GitHub Actions runners. Read [`docs/ci.md`](../../docs/ci.md) first, especially the security
section, before you register a runner for a public repository.

| Machine | Script | Labels | Service |
|---|---|---|---|
| macOS, Apple Silicon | `setup-macos.sh` | `self-hosted, macOS, ARM64, atrium` | launchd LaunchAgent (runs in the logged-in session; the macOS harness needs a GUI session) |
| Linux, arm64 or x64, with Docker | `setup-linux.sh` | `self-hosted, Linux, ARM64` (or `X64`), `atrium` | system service through `svc.sh` with passwordless sudo, else a systemd **user** service |
| Windows x64 | `setup-windows.ps1` | `self-hosted, Windows, X64, atrium` | Windows service (elevated PowerShell) |

The runner adds `self-hosted`, the OS and the architecture itself; the scripts add `atrium`.

Each script:

1. downloads the official `actions/runner` release for its OS and CPU (pinned to v2.338.2);
2. checks its SHA-256 against the value published in that release's notes (pinned in the script;
   with `RUNNER_VERSION=x.y.z` it reads the checksum from that release's notes instead) and stops on a mismatch;
3. unpacks it into `~/actions-runner-atrium` (`C:\actions-runner-atrium` on Windows; `--dir`/`-Dir` to change);
4. configures it with `--unattended`, the labels, the work folder `_work` and `--disableupdate`;
5. installs and starts it as a service (`--no-service`/`-NoService` to skip).

The registration token is never written to the repository or printed. It comes from the
`RUNNER_TOKEN` environment variable, `--token`, or, if neither is given and `gh` is logged in
as a repository admin, from `gh` directly.

## 1. Get a registration token

Tokens expire after one hour. You need admin rights on the repository.

```sh
gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token
```

(Web: Settings › Actions › Runners › New self-hosted runner shows the same token.)

## 2. Register

Run each command on the machine that becomes the runner. `OWNER/REPO` is, for example, `YutingXu/waffle-eda`.

**macOS** (in a checkout of the repository):

```sh
scripts/runners/setup-macos.sh --repo OWNER/REPO          # token from gh
RUNNER_TOKEN=... scripts/runners/setup-macos.sh --repo OWNER/REPO
```

**Linux.** The host needs Docker (the user in the `docker` group); everything else runs in
containers. Without passwordless sudo the runner becomes a systemd user service, which needs
lingering (`loginctl enable-linger $USER`, once, by an admin) to keep running after logout.
From a machine with `gh`, without a checkout on the Linux host, and without the token
appearing in any command line:

```sh
rsync -a scripts/runners/ LINUX_HOST:atrium-runner-setup/
gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token |
  ssh LINUX_HOST 'read -r RUNNER_TOKEN && export RUNNER_TOKEN && sh ~/atrium-runner-setup/setup-linux.sh --repo OWNER/REPO'
```

**Windows** (elevated PowerShell, in a checkout):

```powershell
$env:RUNNER_TOKEN = (gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token)
.\scripts\runners\setup-windows.ps1 -Repo OWNER/REPO
Remove-Item Env:RUNNER_TOKEN
gh variable set WINDOWS_RUNNER --body true --repo OWNER/REPO   # turns the Windows jobs on
```

Check: `gh api repos/OWNER/REPO/actions/runners --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv'`

## 3. Remove a runner

The scripts stop and remove the service, then unregister with a removal token (from
`RUNNER_TOKEN`, `--token` or `gh`):

```sh
scripts/runners/setup-macos.sh --repo OWNER/REPO --remove
gh api -X POST repos/OWNER/REPO/actions/runners/remove-token --jq .token |
  ssh LINUX_HOST 'read -r RUNNER_TOKEN && export RUNNER_TOKEN && sh ~/atrium-runner-setup/setup-linux.sh --repo OWNER/REPO --remove'
```

```powershell
.\scripts\runners\setup-windows.ps1 -Repo OWNER/REPO -Remove
gh variable delete WINDOWS_RUNNER --repo OWNER/REPO
```

Then delete the install folder. If the machine is gone, remove the runner from GitHub instead:

```sh
gh api repos/OWNER/REPO/actions/runners --jq '.runners[] | [.id, .name] | @tsv'
gh api -X DELETE repos/OWNER/REPO/actions/runners/RUNNER_ID
```

On Linux, the CI images can be removed with `docker rmi $(docker images -q 'atrium-ci-*')`.

## Notes

- **Updates.** `--disableupdate` stops the runner from updating itself. GitHub refuses runners
  that fall too far behind, so bump `PINNED_VERSION` and the checksums in `common.sh` and
  `setup-windows.ps1` (copy them from the release notes), then remove and re-register.
- **One job at a time.** Each runner takes one job at a time. The macOS job's harness and browser
  timings expect an otherwise idle machine.
- **Ephemeral runners.** `config.sh --ephemeral` takes one job and then unregisters. That gives a clean
  runner per job, but it needs a token per job, so it pairs with an autoscaler. The Linux job gets most
  of that isolation from its containers instead.
