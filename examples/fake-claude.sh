#!/bin/sh
# Stand-in for the `claude` binary, used by the test-suite to exercise the login flow.
S="${FAKE_STATE:-/tmp/fake-claude-state}"
case "$1 $2" in
  "auth status") if [ -f "$S" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; fi ;;
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then touch "$S"; echo "Logged in"; exit 0; else echo "Couldn't log in: bad code"; exit 1; fi ;;
  "auth logout") rm -f "$S" ;;
esac
