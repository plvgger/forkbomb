# ops

Operator scripts and end-to-end tests. They import the real server code from `../web/lib/server`, so install both
`web/` and `ops/` (`npm ci` in each) first. Nothing here deploys anything or moves funds.

| Command (in `ops/`) | What it does |
| --- | --- |
| `npm test` | Tests for the review-burn tool: in-memory PGlite, stubbed Solana RPC, no network. |
| `npm run typecheck` | Type-checks the scripts and the server code they import. |
| `npm run review -- list` | Lists burns held for review in the database at `DATABASE_URL`. |
| `npm run review -- approve <signature> [--yes]` | Pays out one burn held for review. See the runbook below. |
| `npm run e2e:devnet` | Burns on devnet (or a loopback validator) and verifies them with the server code. |
| `npm run e2e:dapp` | Drives the real `/app` UI in headless Chrome against a local validator. Needs `solana-test-validator` and Chrome. The header of `e2e/dapp-burn-e2e.ts` lists its scenarios and env. |

## Runbook: a burn held for review

A burn worth more than `MAX_CREDIT_PER_BURN_USD` (default $5000; `/api/token` reports it as `maxCreditPerBurnUsd`)
is recorded with status `review` and credits nothing. The user sees "held for review" in `/app`, and `/burns`
lists the row as review. Only an operator can release it.

1. Put the production `DATABASE_URL` (Neon console, production branch, connection string) into your shell's
   environment without echoing it. The tool prints only the database host.
2. `npm run review -- list` shows every burn in review: signature, workspace, owner, amount, burn-time price, USD
   value and the credit it would add.
3. Check the burn before paying it. Open `https://solscan.io/tx/<signature>`, compare the recorded price with the
   market at the block time, and look at the owner and the workspace.
4. `npm run review -- approve <signature>` is a dry run. It shows the credit, the balance before and after, and every
   earlier operator grant to that workspace. If one of those grants already paid this burn by hand, stop:
   approving would pay it twice.
5. `npm run review -- approve <signature> --yes` makes the change. In one transaction it sets the burn to
   `credited` and adds the credit recorded at verification to the workspace (`credit_ledger` reason `burn`, ref the
   signature). It's the same write `verifyBurn` makes for a burn under the cap. `MAX_GRANT_USD` doesn't apply.
   Running it again, even at the same moment, changes nothing.
6. Tell the user to verify the signature again in `/app`. It now answers "already credited", and the ledger's
   credited total includes the burn.

Don't use `POST /api/admin/grant` for this. Its ref takes at most 64 characters (a signature has 87 or 88), one
grant is capped at `MAX_GRANT_USD` (default $100), and the burn would stay in review, so a later approve would pay
it a second time.

To refuse a burn, leave it in review. Nothing is credited, and the user keeps seeing "held for review".
