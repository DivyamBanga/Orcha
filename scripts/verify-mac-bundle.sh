#!/bin/bash
# Static checks on a packaged Orcha.app (CI, after electron-builder):
# signature, architectures, the executable bits node-pty needs, Info.plist,
# bundle size, and that no shipped binary needs a newer macOS than we claim.
set -uo pipefail
APP="${1:-dist/mac-arm64/Orcha.app}"
FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
# $1 > $2 for dotted versions (BSD sort has no -V).
vergt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]; }
pass() { echo "ok:   $*"; }

# A valid ad-hoc seal is what makes macOS offer "Open Anyway" rather than
# calling the app damaged.
if codesign --verify --deep --strict --verbose=2 "$APP"; then pass "signature verifies"; else fail "signature does not verify"; fi
if codesign -dv "$APP" 2>&1 | grep -q 'Signature=adhoc'; then pass "ad-hoc signed"; else fail "not ad-hoc signed"; fi
ASSESS=$(spctl --assess -vv "$APP" 2>&1 || true)
echo "spctl: $ASSESS"
if echo "$ASSESS" | grep -Eqi 'damaged|invalid signature|not signed at all|code has no resources'; then
  fail "Gatekeeper would call it damaged"
else
  pass "Gatekeeper sees an unnotarized app (expected), not a broken one"
fi

UNPACKED="$APP/Contents/Resources/app.asar.unpacked/node_modules"
SDK_BIN="$UNPACKED/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
[ -x "$SDK_BIN" ] && pass "Agent SDK binary unpacked" || fail "Agent SDK binary missing or not executable: $SDK_BIN"
while IFS= read -r -d '' f; do
  if lipo -archs "$f" 2>/dev/null | grep -qw arm64; then pass "arm64: ${f#$APP/}"; else fail "not arm64: $f"; fi
done < <(find "$UNPACKED" \( -name '*.node' -o -path '*claude-agent-sdk-darwin-arm64/claude' \) -type f \
  -not -path '*/prebuilds/win32-*' -not -path '*/prebuilds/darwin-x64/*' -not -path '*/prebuilds/linux-*' -print0)
# (node-pty ships every platform's prebuild; on Apple Silicon it only ever
# loads build/Release or prebuilds/darwin-arm64.)
while IFS= read -r -d '' f; do
  [ -x "$f" ] && pass "executable: ${f#$APP/}" || fail "spawn-helper not executable: $f"
done < <(find "$UNPACKED/node-pty" -name spawn-helper -type f -print0)

PLIST="$APP/Contents/Info.plist"
MIN_OS=$(plutil -extract LSMinimumSystemVersion raw "$PLIST" 2>/dev/null || echo "")
[ -n "$MIN_OS" ] && pass "LSMinimumSystemVersion $MIN_OS" || fail "no LSMinimumSystemVersion"
if plutil -p "$PLIST" | grep -q '"orcha"'; then pass "orcha:// scheme registered"; else fail "orcha:// scheme missing"; fi

ASAR_MB=$(( $(stat -f %z "$APP/Contents/Resources/app.asar") / 1048576 ))
if [ "$ASAR_MB" -lt 250 ]; then pass "app.asar ${ASAR_MB} MB"; else fail "app.asar is ${ASAR_MB} MB (sibling projects bundled?)"; fi

# Highest minimum macOS any shipped binary was built for.
MAX_MINOS="0"
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  for v in $(otool -l "$f" 2>/dev/null | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0} /LC_VERSION_MIN_MACOSX/{m=1} m&&/version/{print $2; m=0}'); do
    if vergt "$v" "$MAX_MINOS"; then
      MAX_MINOS="$v"; MAX_FILE="$f"
    fi
  done
done < <(find "$APP" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0)
echo "highest binary minos: $MAX_MINOS (${MAX_FILE:-none})"
if [ -n "$MIN_OS" ] && vergt "$MAX_MINOS" "$MIN_OS"; then
  fail "a binary needs macOS $MAX_MINOS but the app claims $MIN_OS: ${MAX_FILE}"
else
  pass "every binary runs on macOS $MIN_OS"
fi

exit $FAILED
