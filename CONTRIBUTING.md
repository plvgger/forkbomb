# Contributing to Forkbomb

Bug reports, fixes and focused features are welcome. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: it maps every part of the codebase in one page.

## Setup

You need macOS on an APFS volume, Node 22 or newer, and Xcode Command Line Tools (`xcode-select --install`). The sandbox and `clonefile(2)` are macOS-only, and the CLI test suite exercises both for real.

```
git clone https://github.com/plvgger/forkbomb
cd forkbomb
npm install
npm run build
node dist/cli.js doctor
```

`npm run forkbomb -- <command>` runs the CLI from source through tsx, without a build.

## Layout

| Path | What lives there |
|---|---|
| `src/` | The CLI: orchestrator, forker, sandbox, tools, engines, judge, event log |
| `native/hclone.c` | The `clonefile(2)` helper, compiled on first use |
| `ui/` | Live process tree and replay viewer |
| `test/` | CLI tests |
| `web/` | forkbomb.fun: site, wallet app (`/app`) and hosted API (`/api`) |
| `ops/` | Devnet burn end-to-end test |
| `examples/calc/` | A small broken repo to race on |

## Tests

There are two suites. CI runs both on every push to `main` and every pull request (`.github/workflows/ci.yml`). Keep both green.

**CLI** (repo root):

```
npm run build
npx vitest run
```

These tests create real APFS clones and run real commands under Seatbelt. Models are scripted (`FakeModel` in `test/helpers.ts`, `test/fake-claude.mjs` for the Claude Code engine, a local mock gateway for the hosted engine), so the suite makes no model calls and costs nothing. Temp files go to `.test-tmp/` on the same volume, and `FORKBOMB_HOME` points there, so nothing is written to your real `~/.forkbomb`.

**Web** (`web/`):

```
cd web
npm install
npx tsc --noEmit -p .
npx vitest run
npm run build      # CI runs this too: migrations dry-run on in-memory PGlite, then next build
```

Tests run against a fresh in-memory PGlite with the migrations applied, and Solana RPC and price APIs are mocked, so the suite needs no network, wallet or database server.

**Ops** (optional): `cd ops && npm install && npm run typecheck`. `npm run e2e:devnet` burns test tokens on Solana devnet (or a local validator via `E2E_RPC_URL`) and never touches mainnet.

## Running the web app locally

```
cd web
npm run dev        # http://localhost:4319
```

Without `DATABASE_URL`, the server opens an in-memory PGlite and applies the migrations on first use (`web/lib/server/db.ts`), so data is gone when the process stops. Production requires `DATABASE_URL`. Other defaults outside production:

- `KEY_PEPPER` falls back to a fixed dev-only value.
- With `TOKEN_MINT` unset, burns are closed, the ledger is empty and price sampling is skipped.
- With `UPSTREAM_BASE_URL` unset, the gateway answers 503 `upstream_unavailable` without charging. Point it at any OpenAI-compatible server to exercise the full metering path.
- `POST /api/admin/grant` exists only when `ADMIN_SECRET` is at least 32 characters. Use it to give a local workspace test credit.

To point the CLI at your local gateway, set `FORKBOMB_HOSTED_URL=http://localhost:4319/api/v1` and `FORKBOMB_API_KEY` to a key from `POST /api/workspaces`. Plain http is accepted for loopback only.

`web/` is a Next.js 16 App Router app (see `web/package.json` for the version). Route handlers live in `web/app/api/`, server code in `web/lib/server/`.

## Conventions

- **TypeScript, strict.** `strict` and `noUncheckedIndexedAccess` are on. ESM throughout; Node built-ins use the `node:` prefix; relative imports in `src/` end in `.js`.
- **Match the surrounding style.** Two-space indent, double quotes, semicolons. There is no formatter config, so keep diffs free of unrelated reformatting.
- **Comments say why.** Short JSDoc on exported functions and anything security-relevant. Don't narrate what the code already says.
- **Errors are sentences.** User-facing messages say what went wrong and what to do next, in plain words.
- **Untrusted input stays sandboxed.** Anything a model produces (commands, paths, file contents) goes through `runSandboxed()` or `Workspace`. `exec()` is only for trusted, fixed commands.
- **Names come from one place.** The product name, slug and env names live in `src/brand.ts` and `web/lib/server/config.ts`. Don't hardcode them.
- **Money is integer micro-USD** on the server. No floats in balances, reservations or credits.
- **API errors use `ApiError`**, which produces the OpenAI error shape. Route handlers are wrapped in `handler()`.
- **Clients never see the upstream.** The hosted model is `forkbomb-hosted` in every response; the upstream model, URL and key stay server-side.
- **Numbers are real.** Every figure on the site lives in `web/app/config.ts` and comes from a real run or measurement. Don't add one that doesn't. `TEST_COUNT` there must equal the CLI suite's size; `test/site.test.ts` fails until it does.
- **Tests come with changes.** One behavior per `it`. CLI tests use `tempDir()` from `test/helpers.ts`; web tests use `freshDb()` from `web/test/helpers.ts`.
- **Commit messages** are one short line in the imperative or as a plain statement, e.g. `Run database migrations in the Vercel build`.

## Security issues

Don't open a public issue for a vulnerability. Report it privately through a [GitHub security advisory](https://github.com/plvgger/forkbomb/security/advisories/new). [SECURITY.md](SECURITY.md) covers the scope and what to include. Never paste an API key, a private key or a seed phrase anywhere, including a private report.

## Pull requests

- [ ] One focused change per PR, with a description of what changed and why.
- [ ] `npm run build && npx vitest run` passes at the root.
- [ ] `npx tsc --noEmit -p . && npx vitest run` passes in `web/`, if you touched it.
- [ ] New behavior has a test; a bug fix has a test that failed before the fix.
- [ ] Changes to the sandbox, editor path checks, judge, engines' isolation, gateway metering or burn verification are called out in the description.
- [ ] No secrets, no local absolute paths, no invented numbers.
- [ ] User-visible changes are noted under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
