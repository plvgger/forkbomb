# Changelog

All notable changes to Forkbomb are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- The hosted engine streams its turns. Killing a fork hangs up mid-answer, so the gateway stops the GPU and bills only what was streamed, instead of running the fork's last turn to the end and billing all of it. A turn the gateway refunded in full before the model produced anything, such as a cold start that ran past the budget, is still retried.
- On RunPod serverless, the gateway sends requests through RunPod's job queue instead of its OpenAI route, which kept generating after the client hung up. A job is cancelled when a streaming client leaves or the 280 s budget runs out, and it carries its own time limit in case the cancel is lost. In a live check, the GPU was free 88 ms after the client left. Polls are spaced at 250 ms and back off on a 429, so busy streams stay inside RunPod's shared rate limits. `UPSTREAM_TRANSPORT=openai` switches back.

### Fixed

- A hosted turn that fails mid-stream (for example a gateway timeout) now counts what the gateway charged for it in the fork's and the run's cost. Before, the run's total left those charges out.
- The gateway bills reasoning sent as `delta.reasoning` (vLLM 0.30) when a stream is cut short. Before, a stream cut off mid-thought was billed for its input alone.
- Error messages from the gateway no longer carry the upstream model name.

## 0.1.0 - 2026-10-07

First public pre-release. macOS on APFS, Node 22 or newer. Install from source; not on npm yet.

### Added

- `forkbomb run` forks a coding agent into up to 64 sandboxed copies of a repo per round, each with its own strategy, and judges every fork by running your test command on its patch. `race` mode exits 0 on the first passing fork and kills the rest; `best` mode lets every fork finish and keeps the smallest passing diff. Up to 10 rounds; when a round has no pass, its best fork seeds the next round if it beat its parent.
- Copy-on-write forking with `clonefile(2)` through a one-file C helper (`native/hclone.c`), compiled with clang on first use and cached per source version. Falls back to `cp -R` off APFS or across volumes.
- Twelve fork strategies: surgeon, root-cause, test-driven, rewriter, skeptic, cartographer, sprinter, spec-first, bisector, minimalist, tracer and contrarian.
- Three engines. `claude-code` (default) runs headless Claude Code on a Claude Pro or Max plan. `api` runs Forkbomb's own tool loop on the Anthropic Messages API, default model `claude-opus-5-5` at `medium` effort. `hosted` runs the same tool loop against the Forkbomb gateway, paid with credit from burning $FORKBOMB.
- Judge with summary parsers for node:test, vitest, jest, cargo, pytest, mocha, unittest and go test, partial-credit scoring, and carry-over of the best partial state between rounds.
- `forkbomb bench` measures clonefile against a plain copy on your own tree. Reference run, 16 forks of an 80 MB, 4,400-file `node_modules` tree on a MacBook Air (M2, 24 GB): 45 ms vs 1,108 ms per fork, 22 MB vs 1.3 GB of extra disk.
- `forkbomb replay` and `forkbomb export` play back a recorded run or export it as a static site. Both check every line of the log first and refuse one the viewer can't play. `--ui` streams the live process tree over server-sent events on 127.0.0.1.
- `forkbomb doctor`, `forkbomb credits` and `forkbomb canary`.
- Every run is saved under `~/.forkbomb/runs/<id>/` with an `events.jsonl` log (14 event types), pid 1, the winning fork and its patch. `--apply` applies the winning patch to your repo.
- Hosted API at `https://forkbomb.fun/api/v1`: OpenAI-compatible `POST /chat/completions` with streaming and tool calls, `GET /me` and `GET /usage`. Metered per token with reserve-then-settle accounting in integer micro-USD. Clients see the model as `forkbomb-hosted`. The GPU pool is live; credit opens when $FORKBOMB launches. First hosted race (2026-10-07, run `20261007-015122`, log in `docs/runs/`): 4 forks, 14/14 tests passing, $0.06 of operator-granted test credit.
- Burn for compute: workspaces with API keys shown once; an on-chain verifier for SPL Token and Token-2022 burns carrying the memo `forkbomb:<workspaceId>`; USD credit priced at burn time; a price sampler (Jupiter, DexScreener fallback) pinged every 5 minutes by a GitHub Actions workflow; and a public burn ledger at `/burns` and `GET /api/ledger`.
- Wallet app at `/app`: connect a Wallet Standard wallet, create a workspace, burn, and track credit and usage.
- Operator credit grants (`POST /api/admin/grant`), switched off unless `ADMIN_SECRET` is set.
- forkbomb.fun: docs, threat model, token page, a replay of a recorded run, terms and privacy.
- `ops/devnet-burn-e2e.ts`: end-to-end burn verification on Solana devnet against the real server code, for classic SPL and Token-2022 mints.

### Security

- Every shell command a fork runs goes through a per-fork Seatbelt profile: writes only in its own clone and temp dir, `.git` read-only, nothing under the home folder readable except the clone, the temp dir and toolchain folders, network limited to loopback with DNS blocked, and an environment allowlist with no API keys. Every command has a timeout and an output cap, and its whole process group is killed on exit, timeout or abort.
- The text editor confines every path to the clone: no `..` escapes, symlinks resolved and re-checked at each path component, `.git` rejected in any letter case, and no writes through hard links or final-component symlinks.
- Claude Code forks run with `--safe-mode`, no user or project settings, Claude Code's own sandbox with unsandboxed commands disabled, and deny rules on credential folders, on every `.env` key file in `~`, its dot-folders and the CLI home, and on `.git`. An isolation canary runs a real session told to escape before the first run on each Claude Code version; forks start only if every escape fails.
- The judge scores the patch, not the workspace: edits to protected test files and test config are dropped, the patch is applied to a fresh clone of the base, and a run with fewer tests than the baseline can't score a full pass. Every git call against a fork's clone runs sandboxed, with hooks and fsmonitor disabled.
- Keys stay local. The Anthropic key goes only to Anthropic and the hosted key only to the gateway (https, or http to loopback only; redirects refused). Neither reaches a fork, and the hosted key is redacted from events and errors.
- API keys are stored only as HMAC-SHA256 under a server pepper and compared in constant time. Client IPs are stored only as HMACs. Rate limits are counted in Postgres.
- Credit can't go negative: reservations debit with one conditional update under a `CHECK` constraint, every reservation settles or expires exactly once, and each burn signature credits at most once. Burns over the per-burn cap are held for manual review. Burn pricing never uses a price above the last sample before the burn.
- The upstream URL, host and key are scrubbed from every client-facing error. Every response carries baseline security headers, and the browser reaches Solana only through an allowlisted, read-only RPC proxy.
