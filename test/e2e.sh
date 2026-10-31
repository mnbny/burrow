#!/usr/bin/env bash
# End-to-end harness: the real container behind a real proxy, deployed to by
# the real CLI. Everything binds to localhost and is removed on exit.
set -euo pipefail
cd "$(dirname "$0")"

HOST=http://127.0.0.1:18199
export BURROW_HOST=$HOST BURROW_TOKEN=test-token

compose() { docker compose -f compose.yml "$@"; }
cli() { node ../cli/burrow.mjs deploy "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

trap 'compose down --volumes --timeout 2 > /dev/null 2>&1' EXIT
compose up -d --build --quiet-pull

# The proxy answers 502 until the app is up, so readiness is the app's own
# 404 for the root path.
ready() {
  for _ in $(seq 1 40); do
    [[ "$(code "$HOST/")" == 404 ]] && return
    sleep 0.5
  done
  echo "stack never became ready" >&2
  exit 1
}
ready

fails=0
check() {
  if [[ $2 == "$3" ]]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected: $2, got: $3)"
    fails=$((fails + 1))
  fi
}

url=$(cli fixtures --project reports --slug smoke --auth me:secret)
check "deploy prints the url" "$HOST/reports/smoke/" "$url"
jar=$(mktemp)
check "protected page needs auth" 401 "$(code "$HOST/reports/smoke/")"
check "navigation gets the sign-in page" 'Sign in' "$(curl -s -H 'Accept: text/html' "$HOST/reports/smoke/" | grep -o 'Sign in' | head -1)"
check "asset request gets a bare 401" 401 "$(code "$HOST/reports/smoke/style.css")"
check "wrong password is rejected" 401 "$(curl -s -o /dev/null -w '%{http_code}' --data 'username=me&password=nope' "$HOST/reports/smoke/")"
check "login grants a session" 303 "$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" --data 'username=me&password=secret' "$HOST/reports/smoke/")"
check "protected page serves with session" 200 "$(code -b "$jar" "$HOST/reports/smoke/")"
check "html arrives intact" '<h1>smoke</h1>' "$(curl -s -b "$jar" "$HOST/reports/smoke/" | grep -o '<h1>smoke</h1>')"
check "asset mime type" text/css "$(curl -s -o /dev/null -w '%{content_type}' -b "$jar" "$HOST/reports/smoke/style.css")"
check "session does not open other slugs" 404 "$(code -b "$jar" "$HOST/reports/nonexistent/")"
check "metadata file is hidden" 404 "$(code -b "$jar" "$HOST/reports/smoke/.meta.json")"
check "directory redirects to slash" 301 "$(code -b "$jar" "$HOST/reports/smoke")"
check "traversal is blocked" 404 "$(code -b "$jar" "$HOST/reports/smoke/..%2f..%2fetc%2fpasswd")"

url2=$(cli fixtures --project reports)
check "uuid deploy serves without auth" 200 "$(code "$url2")"

if BURROW_TOKEN=bad cli fixtures --project reports --slug intruder > /dev/null 2>&1; then
  check "bad token is rejected" rejected accepted
else
  check "bad token is rejected" rejected rejected
fi

# Flags beat env vars: bad env, correct flags.
urlflag=$(BURROW_HOST=http://127.0.0.1:1 BURROW_TOKEN=bad cli fixtures --project reports --host "$HOST" --token test-token)
check "host and token flags override env" 200 "$(code "$urlflag")"

url3=$(cli fixtures --project reports --slug smoke)
case $url3 in
  "$HOST/reports/smoke-"*) check "taken slug gets a unique suffix" suffixed suffixed ;;
  *) check "taken slug gets a unique suffix" "$HOST/reports/smoke-*" "$url3" ;;
esac
check "suffixed deploy serves" 200 "$(code "$url3")"
check "original deploy is untouched" 401 "$(code "$HOST/reports/smoke/")"

url4=$(cli fixtures --project "My Reports" --slug "Fancy Report")
check "project and slug are slugified" "$HOST/my-reports/fancy-report/" "$url4"

urlfile=$(cli fixtures/index.html --project reports --slug single)
check "single file deploys as the index" 200 "$(code "$urlfile")"

urlcss=$(cli fixtures/style.css --project reports --slug single-asset)
case $urlcss in
  */style.css) check "non-index file URL names the file" 200 "$(code "$urlcss")" ;;
  *) check "non-index file URL names the file" "*/style.css" "$urlcss" ;;
esac

check "oversized expiration is rejected" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Authorization: Bearer test-token' -H 'x-expires: 1e9' --data-binary @/dev/null "$HOST/_deploy/reports/overflow")"

# A payload shipping .meta.json as a directory must not crash the server.
evildir=$(mktemp -d)
mkdir "$evildir/.meta.json"
echo '<h1>dirmeta</h1>' > "$evildir/index.html"
urldirmeta=$(cli "$evildir" --project reports --slug dir-meta)
rm -rf "$evildir"
check "metadata directory payload is survived" 200 "$(code "$urldirmeta")"

# Concurrent deploys to one slug must land on two distinct URLs.
ca=$(mktemp) cb=$(mktemp)
cli fixtures --project reports --slug clash > "$ca" &
cli fixtures --project reports --slug clash > "$cb" &
wait
if [[ -s $ca && -s $cb && "$(cat "$ca")" != "$(cat "$cb")" ]]; then
  check "concurrent deploys stay distinct" distinct distinct
else
  check "concurrent deploys stay distinct" distinct "$(cat "$ca") vs $(cat "$cb")"
fi
check "first concurrent deploy serves" 200 "$(code "$(cat "$ca")")"
check "second concurrent deploy serves" 200 "$(code "$(cat "$cb")")"
rm -f "$ca" "$cb"

check "nosniff header is set" nosniff "$(curl -sI "$HOST/reports/smoke/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-content-type-options"{print $2}')"

# A relative dot-dot symlink survives tar but must not survive the deploy.
evil=$(mktemp -d)
echo '<h1>evil</h1>' > "$evil/index.html"
ln -s ../../../../etc/passwd "$evil/escape"
urlevil=$(cli "$evil" --project reports --slug escape-attempt)
rm -rf "$evil"
check "symlink is scrubbed from the deploy" 404 "$(code "$urlevil"escape)"
check "scrubbed deploy still serves" 200 "$(code "$urlevil")"

check "robots.txt is forced" "User-agent: *" "$(curl -s "$HOST/robots.txt" | head -1)"

check "server dropped root privileges" node "$(compose exec -T app sh -c 'ps | awk "\$1==1{print \$2}"')"

fake=$(mktemp -d)
echo '<h1>fake</h1>' > "$fake/index.html"
echo '{"auth":"attacker:pwn"}' > "$fake/.meta.json"
urlfake=$(cli "$fake" --project reports --slug fake-meta)
rm -rf "$fake"
check "server metadata beats a deployed one" 200 "$(code "$urlfake")"

# A decompression bomb is stopped while it streams, not after it lands.
bombdir=$(mktemp -d)
dd if=/dev/zero of="$bombdir/big" bs=1048576 count=600 2> /dev/null
tar -czf "$bombdir/bomb.tgz" -C "$bombdir" big
rm "$bombdir/big"
check "decompression bomb is rejected" 413 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Authorization: Bearer test-token' --data-binary "@$bombdir/bomb.tgz" "$HOST/_deploy/reports/bomb")"
rm -rf "$bombdir"

slow=$(mktemp)
dd if=/dev/urandom of="$slow" bs=1048576 count=8 2> /dev/null
curl -s -o /dev/null -m 1 --limit-rate 100K -X PUT -H 'Authorization: Bearer test-token' --data-binary "@$slow" "$HOST/_deploy/reports/aborted" || true
rm -f "$slow"
sleep 1
staging_left=$(compose exec -T app sh -c 'ls /data/.staging 2>/dev/null | wc -l' | tr -d '[:space:]')
check "aborted upload leaves no staging garbage" 0 "$staging_left"

# The compressed body is capped at 50MB.
big=$(mktemp)
dd if=/dev/urandom bs=1048576 count=51 of="$big" 2> /dev/null
check "oversized upload is rejected" 413 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Authorization: Bearer test-token' --data-binary "@$big" "$HOST/_deploy/reports/too-big")"
rm -f "$big"

# Expiration: the sweep runs at server start, so an expired deploy vanishes
# across a restart while a non-expiring one survives it.
url5=$(cli fixtures --project reports --slug fleeting --expires 0.00002)
url6=$(cli fixtures --project reports --slug forever --expires 0)
sleep 3
compose restart > /dev/null 2>&1
ready
check "expired deploy is swept at start" 404 "$(code "$url5")"
check "non-expiring deploy survives the sweep" 200 "$(code "$url6")"

echo
if [[ $fails -eq 0 ]]; then
  echo "all checks passed"
else
  echo "$fails check(s) failed"
  exit 1
fi
