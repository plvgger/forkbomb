# Changelog

All notable changes to Forkbomb are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.2.0 - 2026-10-12

### Added

- `--engine openai`: race forks on any OpenAI-compatible Chat Completions server, such as Ollama or LM Studio on your own machine, vLLM, llama.cpp or OpenRouter. Set the server with `--base-url` (or `OPENAI_BASE_URL`) and the model with `--model`. It uses the same tool loop and sandbox as the hosted engine and spends no credit. The engine's own key is `FORKBOMB_OPENAI_API_KEY`. `OPENAI_API_KEY` goes only where an OpenAI SDK with the same settings would send it, and the run prints which key goes to which host. Before forking, a `GET /models` call checks the server, key and model. Errors every fork would hit (a rejected key, a missing model, a server that turns tool calls down) stop the run with what to change. Cost is reported as unknown. ([#21](https://github.com/plvgger/forkbomb/pull/21), closes #6)
- The hosted engine says when the GPU pool is warming up: one note after 20 s of waiting during a cold start, the wait so far about once a minute, and a line when answers start. ([#21](https://github.com/plvgger/forkbomb/pull/21), closes #7)
- Three more example repos to race on: `durations`, `lru-cache` and `rate-limiter`, each with interacting bugs and fake clocks so every judge run is deterministic. `examples/README.md` lists each example's baseline, and a test fails when that table goes stale. ([#17](https://github.com/plvgger/forkbomb/pull/17), closes #9)
- npm packaging: a `files` allowlist, a `prepack` build, an executable bin, and `npm run check:package`, which installs the packed tarball in a clean folder and runs every command's `--help`, `doctor`, `bench` and `export` from it. CI runs it as a `package` job. The package isn't published yet: the npm name `forkbomb` belongs to an unrelated project. ([#22](https://github.com/plvgger/forkbomb/pull/22), closes #11)

### Changed

- The README opens with an animated replay of the recorded race. ([#18](https://github.com/plvgger/forkbomb/pull/18), closes #10)

### Security

- Tamper guard: the judge rejects a fork whose changes to non-test source files switch the tests off, such as overriding `assert` methods, replacing test-runner globals, swapping assertion modules through the module loader, or exiting early with success. It scans the patch and probes the changed modules in the sandbox. A rejected fork can't score a pass and is never applied. `--no-tamper-guard` turns it off. ([#19](https://github.com/plvgger/forkbomb/pull/19), closes #8)
- With `--engine openai` on a local model server, that server's port is closed to forks, the baseline, the judge and the tamper guard's probe, even with `--network` on. A fork can't drive the model server, for example to pull or delete models. ([#21](https://github.com/plvgger/forkbomb/pull/21))
- The judge protects every file `node --test` runs by default: `*-test.*`, `*_test.*`, `test-*.*` and `test.js` (with `.mjs`/`.cjs`), on top of `*.test.*`, `*.spec.*` and `test/` folders. ([#23](https://github.com/plvgger/forkbomb/pull/23), closes #20)

### Fixed

- The RunPod poll-spacing test no longer fails under machine load: it checks the pace the gateway keeps, not millisecond gaps between two clocks. ([#24](https://github.com/plvgger/forkbomb/pull/24))

## 0.1.0 - 2026-10-09

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
- Hosted API at `https://forkbomb.fun/api/v1`: OpenAI-compatible `POST /chat/completions` with streaming and tool calls, `GET /me` and `GET /usage`. `GET /models` lists `forkbomb-hosted` for OpenAI SDKs. Metered per token with reserve-then-settle accounting in integer micro-USD. The hosted engine streams its turns, so killing a fork hangs up mid-answer and only what was streamed is billed; on RunPod serverless the gateway uses RunPod's job queue and cancels the job when a client leaves or the 280 s budget runs out (live: the GPU is free within about 2 s). The GPU pool is live; credit opens when $FORKBOMB launches. First hosted race (2026-10-07, run `20261007-015122`, log in `docs/runs/`): 4 forks, 14/14 tests passing, $0.09 of operator-granted test credit billed.
- Burn for compute: workspaces with API keys shown once; an on-chain verifier for SPL Token and Token-2022 burns carrying the memo `forkbomb:<workspaceId>`; USD credit priced at burn time from Jupiter (DexScreener fallback) samples, taken whenever the price is read or a burn is verified and the latest is over 2 minutes old, plus a scheduled job for quiet hours; and a public burn ledger at `/burns` and `GET /api/ledger`. Burns over the per-burn cap wait for an operator, who pays them out with `ops/review-burns.ts` (runbook in `ops/README.md`).
- Wallet app at `/app`: connect a Wallet Standard wallet, create a workspace, burn, and track credit and usage. It blocks burns too small to earn credit and re-reads the wallet balance before sending.
- Operator credit grants (`POST /api/admin/grant`), switched off unless `ADMIN_SECRET` is set.
- forkbomb.fun: docs, threat model, token page, a replay of a recorded run, terms and privacy.
- `ops/devnet-burn-e2e.ts`: end-to-end burn verification on Solana devnet against the real server code, for classic SPL and Token-2022 mints.
- `ops/e2e/dapp-burn-e2e.ts` (`npm run e2e:dapp`): drives the real `/app` in headless Chrome with a scripted Wallet Standard wallet on a local validator: connect, workspace, burns on both token programs, exact credit, replay, rejection, the review cap, wallet-shaped and hand-built transactions, a price outage.

### Security

- Every shell command a fork runs goes through a per-fork Seatbelt profile: writes only in its own clone and temp dir, `.git` read-only, nothing under the home folder readable except the clone, the temp dir and toolchain folders, no network beyond this machine (outbound TCP and UDP, DNS included, are refused), no reads of other forks or the runs folder, an environment allowlist with no API keys, and caps on file size and process count. Every command has a timeout and an output cap, and its whole process group is killed on exit, timeout or abort. Ctrl-C, SIGTERM and SIGHUP stop every fork, judge and test run and apply nothing.
- The text editor confines every path to the clone: no `..` escapes, symlinks resolved and re-checked at each path component, `.git` rejected in any letter case, and no writes through hard links or final-component symlinks.
- Claude Code forks run with `--safe-mode`, no user or project settings, Claude Code's own sandbox with unsandboxed commands disabled, and deny rules on credential folders, on every `.env` key file in `~`, its dot-folders and the CLI home, and on `.git`. An isolation canary runs a real session told to escape before the first run on each Claude Code version; forks start only if every escape step was attempted and failed.
- The judge scores the patch, not the workspace: edits to protected test files, test config, setup files and tool config are dropped, the patch is applied to a fresh clone of the base, and a run with fewer tests than the baseline can't score a full pass. Every git call against a fork's clone runs sandboxed, with hooks and fsmonitor disabled.
- Keys stay local. The Anthropic key goes only to Anthropic and the hosted key only to the gateway (https, or http to loopback only; redirects refused). Neither reaches a fork, and the hosted key is redacted from events and errors.
- API keys are stored only as HMAC-SHA256 under a server pepper and compared in constant time. Client IPs are stored only as HMACs. Rate limits are counted in Postgres.
- Credit can't go negative: reservations debit with one conditional update under a `CHECK` constraint, every reservation settles or expires exactly once, and each burn signature credits at most once. Burns over the per-burn cap are held for manual review. Burn pricing never uses a price above the last sample before the burn.
- The upstream URL, host and key are scrubbed from every client-facing error. Every response carries baseline security headers, API errors are always JSON (405s list the allowed methods), and the browser reaches Solana only through an allowlisted, read-only, same-site RPC proxy. The replay server answers only on 127.0.0.1/localhost, and `export` strips local paths.
