#!/bin/sh
# Usage: ./docker-setup.sh /path/to/your/git/repo   → writes .env, then `docker compose up -d --build`
set -e
[ -n "$1" ] || { echo "usage: $0 /path/to/git/repo"; exit 1; }
REPO=$(cd "$1" && pwd)
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "$REPO is not a git repository"; exit 1; }
if [ -f .env ]; then echo ".env already exists – not overwriting"; exit 1; fi
cat > .env <<EOT
PROJECT_DIR=$REPO
CREW_UID=$(id -u)
CREW_GID=$(id -g)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOT
echo "Wrote .env (project: $REPO). Add your ANTHROPIC_API_KEY there if it's empty, then:"
echo "  docker compose up -d --build   →   http://127.0.0.1:4317"
