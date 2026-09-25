#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fail=0
if find . -path ./.git -prune -o -type f \( -name '*.jsonl' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.pem' -o -name '*.key' -o -name '*.token' \) -print | grep -q .; then
  echo "release-check: runtime/secret-like files found" >&2
  fail=1
fi
if grep -RInE --exclude-dir=.git --exclude='release-check.sh' '(-100[0-9]{8,}|api\.sdsvip88\.com|38\.49\.217\.114|HermesConsultantPlus_Bot|Pi_consultant_bot|/root/\.hermes|/home/pi-consultant)' .; then
  echo "release-check: production-specific identifier/path found" >&2
  fail=1
fi
if grep -RInE --exclude-dir=.git --exclude='release-check.sh' '(botToken|apiKey|secret|password)[[:space:]]*[=:][[:space:]]*"[^<][^"]+"' .; then
  echo "release-check: possible inline secret found" >&2
  fail=1
fi
[ "$fail" -eq 0 ] || exit 1
echo "release-check: clean"
