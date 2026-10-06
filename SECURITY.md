# Security

Forkbomb runs AI coding agents on your machine, so isolation is the core of the product. The threat model, the isolation layers and their limits are written up at https://forkbomb-heads.vercel.app/security.

## Status

Forkbomb is pre-release (0.1.x). The sandbox and the judge are still being hardened. Run it on code you'd be comfortable letting an agent work on.

## Reporting a vulnerability

Please report privately through a GitHub security advisory:
https://github.com/plvgger/forkbomb/security/advisories/new

Don't open a public issue for a vulnerability. Include the Forkbomb version, the engine (`claude-code` or `api`), your macOS version, and the smallest repro you can share. We'll acknowledge the report and keep you posted on the fix.
