## What and why

<!-- What changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

- [ ] `npm run build && npx vitest run` passes at the root
- [ ] `cd web && npx tsc --noEmit -p . && npx vitest run` passes (if `web/` changed)
- [ ] New behavior has a test; a bug fix has a test that failed before the fix

## Checklist

- [ ] Touches the sandbox, editor path checks, judge, engine isolation, gateway metering or burn verification: explained above
- [ ] No secrets, local absolute paths or invented numbers
- [ ] User-visible change noted under `## Unreleased` in `CHANGELOG.md`
