# FORKBOMB

Fork your coding agent. Kill the losers. Keep the patch that passes.

Forkbomb forks a coding agent into N sandboxed copies of your repo in milliseconds. Each fork gets its own clone, its own sandbox and its own strategy. They race. Your test suite judges. The losers get killed, one fork exits 0, and its diff is the answer.

```
forkbomb run ./my-repo --task "fix the date parser" --test "npm test" --forks 8 --ui
```

Open source, MIT, macOS only today (APFS + Seatbelt). Not on npm yet: until the npm release, run it from source as `node dist/cli.js …` (see Install).

## How a race works

1. **Fork.** Forkbomb clones your repo once (pid 1), commits a base snapshot, then forks it into N copies with `clonefile(2)`. On APFS a clone shares every data block with its parent until a fork writes, so a fork costs metadata, not a copy.
2. **Race.** Each fork is a coding agent with two tools, `bash` and a text editor, and a different strategy (surgeon, root-cause, test-driven, skeptic, …). Diversity is the point: eight copies with one strategy fail the same way eight times.
3. **Judge.** When a fork stops, Forkbomb takes its diff against the base, drops any change to tests or test config, applies what is left to a fresh clone of pid 1, and runs your test command there. A fork is judged by the patch it would ship, so hacks to ignored files (`node_modules`, build output) or planted tests never count. A run where tests went missing doesn't count as a pass either.
4. **Kill.** In `race` mode the first fork to pass exits 0 and the rest are killed mid-thought. In `best` mode everyone finishes and the smallest passing diff wins.
5. **Grow.** If nobody passes, the best fork's verified state (pid 1 + its patch) becomes the parent of the next round, with a note on where it left off.

## Numbers

`forkbomb bench` forks the same workspace with `clonefile` and with a plain copy. On a MacBook Air (M2, 24 GB), with an 80 MB `node_modules` tree of 4,400 files and 16 forks:

| forker | per fork | logical | extra disk |
|---|---|---|---|
| apfs-clonefile | 45 ms | 1.2 GB | 22 MB |
| copy | 1,108 ms | 1.2 GB | 1.3 GB |

Run it on your own repo: `forkbomb bench ./my-repo --forks 16`. Extra disk is measured from free space before and after, so other activity on the machine shows up as noise.

## Engines

Forkbomb drives the forks one of three ways. Whichever you pick, every shell command still runs on your machine, under the sandbox.

- **`--engine claude-code` (default).** Each fork is a headless Claude Code session (`claude -p`) on whatever Claude Code is logged in with, so a Claude Pro or Max plan works with no API credits. Forks count against your plan's usage limits, and eight forks use them about eight times as fast as one session. Before the first run on each Claude Code version, Forkbomb runs an isolation canary: a real session told to escape. Forks start only if every escape failed. Run it any time with `forkbomb canary`.
- **`--engine api`.** Forkbomb's own tool loop on the Anthropic Messages API with `ANTHROPIC_API_KEY`, pay as you go. Default model `claude-opus-5-5` at `medium` effort.
- **`--engine hosted`.** The same tool loop and the same sandbox, but the model runs on the hosted gateway (OpenAI-compatible, `FORKBOMB_HOSTED_URL`, default `https://forkbomb-fun.vercel.app/api/v1`), paid with credit from burned $FORKBOMB. Put a workspace key in `FORKBOMB_API_KEY`; `forkbomb credits` shows the balance and pricing. If a fork finds the balance empty, no more forks start. **The hosted GPU pool is coming online and isn't serving yet**, so use `claude-code` or `api` for now.

Self-hosting stays free. Keys stay on your machine: the Anthropic key goes only to Anthropic, the hosted key only to the hosted gateway, and no key ever reaches a fork.

## Burn for compute

$FORKBOMB has not launched yet. When it does, hosted credit works like this:

- **Burn with a memo.** Create a workspace at `https://forkbomb-fun.vercel.app/app`, then burn $FORKBOMB in a transaction whose memo is exactly `forkbomb:<workspaceId>`.
- **Priced at burn time.** The server reads the finalized transaction back from Solana, checks it burned the right mint with your memo, and prices it in USD at the time of the burn, from price samples around the block time. The most conservative price wins.
- **Consumptive credit.** The USD value becomes credit on your workspace, spent per token on the hosted gateway. Credit has no cash value and is non-refundable and non-transferable; burns are final.
- **Public ledger.** Every verified burn is listed on the site's burns page, and each signature is credited at most once.

## Isolation

Every shell command a fork runs goes through macOS Seatbelt (`sandbox-exec`): writes only inside that fork's clone and private temp dir, `.git` read-only, credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, Keychains, …) unreadable, network stopped at loopback unless you pass `--network`, a clean environment with no API keys, and a timeout and output cap on every command. The text editor re-checks every path: no `..`, no symlinks out of the clone or into `.git`, no writing through hard links. Claude Code forks additionally run with `--safe-mode`, no user or project settings, Claude Code's own Bash sandbox and permission rules that deny the file tools on credential folders and `.git`. The judge always runs under Forkbomb's own Seatbelt profile.

Limits, stated plainly: Seatbelt is a macOS mechanism, not a VM. Forks can read most of your filesystem (not the credential folders) and use CPU and memory freely. Run Forkbomb on code you'd be comfortable letting an agent work on.

The full threat model is at https://forkbomb-fun.vercel.app/security.

## Install

From source. Needs macOS on APFS, Node 22+, and Xcode Command Line Tools (for the one-file clone helper, compiled on first run).

```
git clone https://github.com/plvgger/forkbomb
cd forkbomb
npm install
npm run build
node dist/cli.js doctor
```

For the default engine, log Claude Code in once with `claude auth login`. For `--engine api`, put your key in `~/.forkbomb/.env` (`ANTHROPIC_API_KEY=...`) or export it.

Upgrading from Forkbomb: `~/.forkbomb` is still used until `~/.forkbomb` exists, and `FORKBOMB_API_KEY`, `FORKBOMB_HOSTED_URL`, `FORKBOMB_HOME` and the `--heads`, `--head-timeout`, `--keep-heads` flags still work. `doctor` tells you what to rename.

## Commands

Shown as `forkbomb …`; until the npm release, type `node dist/cli.js …`.

```
forkbomb run [repo] --task "..." --test "cmd"   race forks on a repo
forkbomb bench [dir] --forks 16                 clonefile vs copy, measured
forkbomb replay <run-dir>                       watch a recorded run
forkbomb export <run-dir> <out-dir>             static replay you can host anywhere
forkbomb doctor                                 check the machine
forkbomb credits                                hosted credit balance and pricing
forkbomb canary                                 prove Claude Code forks can't escape
```

Useful `run` flags: `--forks 8`, `--rounds 2`, `--mode race|best`, `--engine claude-code|api|hosted`, `--model`, `--effort medium`, `--apply` (apply the winning patch to your repo), `--ui` (live process tree). `forkbomb --help` lists the rest.

Every run is saved under `~/.forkbomb/runs/<id>/` with `events.jsonl`, the winning patch, pid 1 and the winning fork.

## License

MIT. Forkbomb is an independent project, not affiliated with or endorsed by Anthropic.
