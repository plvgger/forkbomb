# Security

Forkbomb runs AI coding agents on your machine, so isolation is the core of the product. The threat model, the isolation layers and their limits are written up at https://forkbomb.fun/security.

## Status

Forkbomb is pre-release (0.1.x). The sandbox and the judge are still being hardened. Run it on code you'd be comfortable letting an agent work on.

## Scope

- The CLI: the Seatbelt sandbox, the Claude Code engine's isolation settings and canary, the path checks in the text editor, and the judge.
- The hosted API (`/api/v1`, the OpenAI-compatible gateway behind `--engine hosted`): API keys, credit reservation and debiting, rate limits.
- The burn verifier: reading burns back from Solana, memo and mint checks, burn-time pricing, and crediting each signature once.

## Reporting a vulnerability

Please report privately through a GitHub security advisory:
https://github.com/plvgger/forkbomb/security/advisories/new

Don't open a public issue for a vulnerability. Include the Forkbomb version, the engine (`claude-code`, `api` or `hosted`), your macOS version, and the smallest repro you can share. For the hosted API or the burn verifier, include the endpoint and, if relevant, the transaction signature, never an API key or a private key. We'll acknowledge the report and keep you posted on the fix.
