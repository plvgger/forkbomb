#!/usr/bin/env bash
# Packs the CLI the way `npm publish` would, installs the tarball into a fresh folder outside the repo and runs it
# from there. Catches what the test suite can't: a file the CLI reads at runtime left out of "files", a bin that
# doesn't run, a module that only resolves inside the repo.
#
#   1. npm pack (prepack builds dist/ from clean); the tarball holds only dist/*.js, native/, ui/, README, LICENSE
#   2. npm install <tarball> into an empty folder; the bin has its shebang and is executable
#   3. forkbomb --help and every `forkbomb <command> --help`
#   4. forkbomb bench on a copy of examples/calc: compiles the clone helper from the installed native/ and clones
#   5. forkbomb export on a copy of docs/runs/20261007-015122: copies the installed ui/
#   6. forkbomb replay: serves the installed ui/, as --ui does
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

step "install into $work/app"
mkdir "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tgz"
name="$(node -p 'require(process.argv[1]).name' "$repo/package.json")"
pkg="$work/app/node_modules/$name"
bin="$work/app/node_modules/.bin/forkbomb"
[ -x "$bin" ] || fail "no executable forkbomb in node_modules/.bin"
[ -x "$pkg/dist/cli.js" ] || fail "dist/cli.js isn't executable"
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
