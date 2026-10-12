#!/usr/bin/env bash
# Packs the CLI the way `npm publish` would, installs the tarball into a fresh folder outside the repo and runs it
# from there. Catches what the test suite can't: a file the CLI reads at runtime left out of "files", a bin that
# doesn't run, a module that only resolves inside the repo.
#
#   1. npm pack (prepack builds dist/ from clean); the tarball holds only dist/*.js, native/, ui/, README, LICENSE,
#      and dist/cli.js is packed executable
#   2. npm install <tarball> into an empty folder; the bin is linked and has its node shebang
#   3. forkbomb --help and every `forkbomb <command> --help`
#   4. forkbomb doctor: the machine checks (macOS, Node, APFS clones, clang, the Seatbelt sandbox) all pass
#   5. forkbomb bench on a copy of examples/calc: compiles the clone helper from the installed native/ and clones
#   6. forkbomb export on a copy of docs/runs/20261007-015122: copies the installed ui/
#   7. forkbomb replay: serves the installed ui/, as --ui does
#
# Needs macOS on APFS, clang and the npm registry (to install the one dependency). FORKBOMB_HOME points into the
# temp folder, so nothing touches ~/.forkbomb. CI runs this as the package job; locally: npm run check:package.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="${TMPDIR:-/tmp}"
work="$(mktemp -d "${tmp%/}/forkbomb-package.XXXXXX")"
replay_pid=""
cleanup() {
  if [ -n "$replay_pid" ]; then kill "$replay_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'check-package: %s\n' "$*" >&2
  exit 1
}

step "pack"
mkdir "$work/pack"
(cd "$repo" && npm pack --pack-destination "$work/pack")
tgz="$(ls "$work"/pack/*.tgz)"
printf '%s, %s bytes\n' "$(basename "$tgz")" "$(stat -f %z "$tgz")"
stray="$(tar -tzf "$tgz" | grep -Ev '^package/(dist/.+\.js|native/[^/]+|ui/[^/]+|README\.md|LICENSE|package\.json)$' || true)"
[ -z "$stray" ] || fail "the tarball holds files the CLI doesn't need:
$stray"
# The build marks dist/cli.js executable so ./dist/cli.js runs from a checkout. npm install sets a bin's mode itself,
# so an installed copy can't show whether the build did it; the tarball can.
mode="$(tar -tvzf "$tgz" package/dist/cli.js | cut -c1-10)" || fail "the tarball has no dist/cli.js"
[ "$mode" = "-rwxr-xr-x" ] || fail "dist/cli.js is packed as $mode, not -rwxr-xr-x: the build didn't mark it executable"
printf 'dist/cli.js packed %s\n' "$mode"

step "install into $work/app"
mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tgz"
name="$(node -p 'require(process.argv[1]).name' "$repo/package.json")"
pkg="$work/app/node_modules/$name"
bin="$work/app/node_modules/.bin/forkbomb"
# npm links the bin and marks its target executable on install, so this checks the bin entry, not the build's chmod.
[ -x "$bin" ] || fail "no executable forkbomb in node_modules/.bin"
[ "$(head -n 1 "$pkg/dist/cli.js")" = "#!/usr/bin/env node" ] || fail "dist/cli.js has no node shebang"
export FORKBOMB_HOME="$work/home"

step "forkbomb --help"
out="$("$bin" --help)" || fail "forkbomb --help exited $?"
printf '%s\n' "$out" | sed -n 1p
for cmd in run bench replay export doctor credits canary; do
  out="$("$bin" "$cmd" --help)" || fail "forkbomb $cmd --help exited $?"
  case "$out" in *"forkbomb $cmd"*) ;; *) fail "forkbomb $cmd --help doesn't show its usage" ;; esac
  printf 'ok  %s\n' "$(printf '%s\n' "$out" | sed -n '2s/^ *//p')"
done

step "forkbomb doctor"
# A runner has no Claude Code login. With an Anthropic API key set, doctor counts on the api engine instead and only
# checks that the key is set, so a placeholder stands in. The hosted key is unset so doctor doesn't call the gateway
# with one from this shell. Every machine check still runs, from the installed package.
status=0
out="$(env -u FORKBOMB_API_KEY -u FORKBOMB_HOSTED_URL ANTHROPIC_API_KEY=placeholder "$bin" doctor)" || status=$?
printf '%s\n' "$out"
[ "$status" -eq 0 ] || fail "forkbomb doctor exited $status"
for check in "macOS" "APFS copy-on-write clones" "clang (builds the clone helper)" "Seatbelt sandbox confines writes" \
  "Seatbelt sandbox blocks outbound network, keeps loopback"; do
  printf '%s\n' "$out" | grep -qxF "ok    $check" || fail "forkbomb doctor didn't report ok for: $check"
done

step "forkbomb bench (copy of examples/calc, 4 forks)"
cp -R "$repo/examples/calc" "$work/calc"
out="$("$bin" bench "$work/calc" --forks 4)" || fail "forkbomb bench exited $?"
printf '%s\n' "$out"
case "$out" in *apfs-clonefile*) ;; *) fail "bench made no clonefile forks" ;; esac
ls "$FORKBOMB_HOME"/bin/hclone-* >/dev/null 2>&1 || fail "the clone helper wasn't compiled into \$FORKBOMB_HOME/bin"

step "forkbomb export (copy of docs/runs/20261007-015122)"
cp -R "$repo/docs/runs/20261007-015122" "$work/run"
"$bin" export "$work/run" "$work/replay" || fail "forkbomb export exited $?"
for f in index.html app.js style.css; do
  cmp -s "$repo/ui/$f" "$work/replay/$f" || fail "export wrote a different $f than ui/$f"
done
for f in data.js events.jsonl; do
  [ -s "$work/replay/$f" ] || fail "export wrote no $f"
done

step "forkbomb replay (serves ui/, as --ui does)"
"$bin" replay "$work/run" --no-open >"$work/replay.log" 2>&1 &
replay_pid=$!
url=""
for _ in $(seq 1 50); do
  url="$(sed -n 's/.* at \(http:[^ ]*\/\)\. Ctrl-C.*/\1/p' "$work/replay.log")"
  [ -n "$url" ] && break
  sleep 0.2
done
[ -n "$url" ] || fail "replay didn't start: $(cat "$work/replay.log")"
for f in index.html app.js style.css; do
  curl -fsS "$url$f" | cmp -s - "$repo/ui/$f" || fail "replay served a different $f than ui/$f"
done
curl -fsS "${url}events.json" >/dev/null || fail "replay didn't serve the run's events"
echo "served index.html, app.js, style.css and events.json at $url"
kill "$replay_pid"
wait "$replay_pid" 2>/dev/null || true
replay_pid=""

step "ok: $(basename "$tgz") installs and runs outside the repo"
