# Hydra

Fork a coding agent into N heads in milliseconds. Each head gets its own copy of your repo, its own sandbox and its own strategy. They race. Your test suite judges. One survives, and its diff is the answer.

```
hydra run ./my-repo --task "fix the date parser" --test "npm test" --heads 8 --ui
```

## How it works

1. **Fork.** Hydra clones your repo once (the *body*), commits a base snapshot, and then forks it into N heads with `clonefile(2)`. On APFS a clone shares every data block with its parent until a head writes, so a head costs metadata, not a copy.
2. **Race.** Each head is a Claude agent with two tools, `bash` and a text editor, and a different strategy (surgeon, root-cause, test-driven, skeptic, …). Diversity is the point: eight copies with one strategy fail the same way eight times.
3. **Judge.** When a head stops, Hydra takes its diff against the base, drops any changes to tests or test config, applies what is left to a fresh clone of the body, and runs your test command there. A head is judged by the patch it would ship, so hacks to ignored files (`node_modules`, build output) or planted tests never count. A run where tests went missing doesn't count as a pass either.
4. **Sever.** In `race` mode the first head to pass wins and the rest are cut mid-thought. In `best` mode everyone finishes and the smallest passing diff wins.
5. **Grow.** If nobody passes, the best head's verified state (body + its patch) becomes the parent of the next round's heads, with a note on where it left off.

## Numbers

`hydra bench` forks the same workspace with `clonefile` and with a plain copy. On a MacBook Air (M2, 24 GB), with an 80 MB `node_modules` tree of 4,400 files and 16 heads:

| forker | per head | logical | extra disk |
|---|---|---|---|
| apfs-clonefile | 45 ms | 1.2 GB | 22 MB |
| copy | 1,108 ms | 1.2 GB | 1.3 GB |

Run it on your own repo: `hydra bench ./my-repo --heads 16`. Extra disk is measured from free space before and after, so other activity on the machine shows up as noise.

## Isolation (API engine)

Every shell command a head runs goes through macOS Seatbelt (`sandbox-exec`):

- Writes are allowed only inside that head's clone and its private temp dir. `.git` is read-only for heads.
- Credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, Keychains, …) are unreadable.
- Outbound network stops at loopback unless you pass `--network`.
- The shell gets a clean environment: no API keys or tokens.
- Commands have a timeout, output is capped, and anything left running in the background is killed when the command returns.

The text editor runs in Hydra's own process, so it re-checks every path: no `..`, no symlinks out of the clone or into `.git`, no writing through hard links.

Limits, stated plainly: Seatbelt is a macOS mechanism, not a VM. Heads can read most of your filesystem (just not the credential folders), and use CPU and memory freely. Run Hydra on code you'd be comfortable letting an agent work on.

## Engines

Hydra drives the heads one of two ways. Either way, credentials stay on your machine.

- **`--engine claude-code` (default).** Each head is a headless Claude Code session (`claude -p`) on whatever Claude Code is logged in with, so a Claude Pro or Max plan works with no API credits. Heads count against your plan's usage limits, and eight heads use them about eight times as fast as one session. Each head runs with:
  - `--safe-mode`, so no CLAUDE.md, hooks, plugins or MCP.
  - No user or project settings, so a repo's own `.claude/settings.json` can't loosen anything.
  - Claude Code's sandbox for Bash: writes stay in the clone, no network, credential folders unreadable, and no unsandboxed escape hatch.
  - Permission rules that deny the file tools on credential folders and `.git`.
  - No API keys in its environment.

  Before the first run on each Claude Code version, Hydra runs an isolation canary: a real session told to escape. It only lets heads start if every escape failed. Run it any time with `hydra canary`.
- **`--engine api`.** Hydra's own tool loop on the Messages API with `ANTHROPIC_API_KEY` (pay as you go). Shell commands run under Hydra's own Seatbelt profile, described below.

## Install

Needs macOS on APFS, Node 22+, and Xcode Command Line Tools (for the one-file clone helper, compiled on first run).

```
npm install
npm run build
node dist/cli.js doctor
```

For the default engine, log Claude Code in once with `claude auth login`. For `--engine api`, put your key in `~/.hydra/.env` (`ANTHROPIC_API_KEY=...`) or export it.

## Commands

```
hydra run [repo] --task "..." --test "cmd"   race heads on a repo
hydra bench [dir] --heads 16                 clonefile vs copy, measured
hydra replay <run-dir>                       watch a recorded run
hydra export <run-dir> <out-dir>             static replay you can host anywhere
hydra doctor                                 check the machine
hydra canary                                 prove Claude Code heads can't escape
```

Useful `run` flags: `--heads 8`, `--rounds 2`, `--mode race|best`, `--model claude-opus-5-5`, `--effort medium`, `--apply` (apply the winning patch to your repo), `--ui` (live tree view).

Every run is saved under `~/.hydra/runs/<id>/` with `events.jsonl`, the winning patch, the body and the winning head.

## Models

With `--engine claude-code`, heads use your Claude Code default model unless you pass `--model` (for example `opus` or `sonnet`). With `--engine api`, the default is `claude-opus-5-5` at `medium` effort, and on models that support them Hydra turns on server-side refusal fallbacks and short progress notes between tool calls, which show up in the live view.

The judge (git and your test command) always runs under Hydra's own Seatbelt profile, whichever engine drove the heads.

## License

MIT
