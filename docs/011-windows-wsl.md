# 011 Windows + WSL2 operations

Use this guide to run dsh-superagent on a Windows workstation whose work happens inside WSL2. It assumes [006 Deployment](006-deployment.md) for accounts, settings and upgrades, and covers only what differs: where the process runs, how the two filesystems meet, and how to keep a fork current.

The fork's own specification is [009 Issue autopilot](009-issue-autopilot-fork.md); this guide covers running any dsh-superagent checkout on Windows, whether or not that feature is in use.

## Why the process belongs in WSL2

dsh-superagent runs shell commands, `git`, `gh` and `lark-cli` as the operator's user, and its workers expect POSIX behaviour: `sh`, `tmux`, `sleep`, symlinks and LF line endings. Running it on Windows directly fails on all of these. Run the service inside WSL2 and keep Windows for the browser.

| Concern | Where it lives |
| --- | --- |
| The dsh-superagent process, its state directory, its checkouts | Inside WSL2, on the Linux filesystem (`~/…`), never under `/mnt/c` |
| The panel | A Windows browser at `http://127.0.0.1:<port>` |
| The agent's `gh` and `lark-cli` credentials | Inside WSL2, under the WSL user's home |

### Keep the state directory off `/mnt/c`

A state directory under `/mnt/c` is a Windows filesystem seen through a translation layer. SQLite writes, `proper-lockfile`'s `utimes`, and the many small files a checkout creates are all slow there, and file modes and symlinks behave differently. Put `stateDir` and the repository checkouts under the WSL home:

```sh
mkdir -p ~/dsh-superagent-state ~/src
```

## Install inside WSL2

Follow [006 Deployment](006-deployment.md) unchanged, inside a WSL2 shell. Two details matter:

- Install Node.js and pnpm inside WSL2, not on Windows. A Windows `node` on `PATH` through interop runs with Windows path semantics and breaks the build.
- Install `gh`, `git`, `tmux` and `python3` from the distribution's packages, and sign `gh` in as the agent account inside WSL2.

```sh
sudo apt-get install -y git tmux python3
# Node.js 22.19+ or 24+, then:
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> ~/dsh-superagent && cd ~/dsh-superagent
pnpm install && pnpm build
```

## Reach the panel from Windows

The panel binds `127.0.0.1` inside WSL2. WSL2 forwards a loopback port to Windows, so `http://127.0.0.1:<port>` in a Windows browser reaches it without any extra configuration. If it does not, the service is not running: check `scripts/dsh-superagent status` inside WSL2 rather than changing the bind address, which the management API requires to stay on loopback.

## Line endings

A Windows checkout with `core.autocrlf=true` rewrites text files to CRLF, which breaks the documentation tests and any script that expects LF. Either clone inside WSL2, where the default is LF, or set the repository's own configuration:

```sh
git -C ~/dsh-superagent config core.autocrlf false
```

Do not normalise an existing Windows checkout in place while it has uncommitted work; clone again inside WSL2 instead.

## Verify a change before committing

`pnpm check` runs the type check, the tests and the build. Run it inside WSL2, where the tests' POSIX assumptions hold:

```sh
cd ~/dsh-superagent && pnpm check
```

Two environment details decide whether a run is meaningful:

- **Locale.** Some tests compare collated Chinese names, and a `ja-JP` or `C` locale orders them differently from the `en-US` order the tests expect. Run with `LANG=C.UTF-8 LC_ALL=C.UTF-8`.
- **Load.** The suite starts many Sessions and subprocesses. Running it beside another heavy job produces timeouts that do not reproduce alone; re-run a failing file by itself before treating a failure as real.

```sh
LANG=C.UTF-8 LC_ALL=C.UTF-8 pnpm check
```

## Keep a fork current

A fork diverges from upstream in two ways: commits of its own, and upstream commits it has not taken. Keep them separate.

```sh
git remote add upstream <upstream repository>
git fetch upstream
git log --oneline main..upstream/main   # what upstream has that this fork does not
git log --oneline upstream/main..main   # what this fork adds
```

To take upstream's changes, merge or rebase onto `upstream/main` on a branch, run `pnpm check`, and open a pull request as for any other change. Do not push directly to `main`, and do not force-push a branch others may have based work on.

### After a DeepSeek Harness upgrade

The bundle declares the DeepSeek Harness versions it supports in `engines.dsh`. After upgrading DeepSeek Harness itself:

1. Run `pnpm install && pnpm build` inside WSL2.
2. Run `scripts/dsh-superagent restart`.
3. Reload the panel; a "Failed to load plugins" message means the running instance still holds the previous artifacts.

If the installed DeepSeek Harness falls outside `engines.dsh`, the plugin refuses to load. Install a supported version rather than editing the range.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `spawn sh ENOENT`, `spawn sleep ENOENT`, `symlink … EPERM` in tests | The suite ran on Windows instead of WSL2; run it inside WSL2 |
| Documentation tests fail on headings or line endings | The checkout is CRLF; clone inside WSL2 or set `core.autocrlf false` |
| A collation test fails only on this machine | The locale orders names differently; run with `LANG=C.UTF-8 LC_ALL=C.UTF-8` |
| Tests time out in a full run but pass alone | The machine is loaded; re-run the file by itself |
| The panel does not answer from Windows | The service is not running in WSL2; check `scripts/dsh-superagent status` there |
| SQLite or lock errors under `/mnt/c` | The state directory is on a Windows filesystem; move it under the WSL home |
