#!/bin/sh
set -e
if [ ! -f "$CREW_CONFIG" ]; then
  cp /app/docker/crew.config.docker.yaml "$CREW_CONFIG"
  echo "[crew] wrote default config to $CREW_CONFIG (edit it in the web UI → Settings)"
fi
if ! git -C /workspace/project rev-parse --git-dir >/dev/null 2>&1; then
  echo "[crew] WARNING: /workspace/project is not a git repository. Set PROJECT_DIR in .env to a git repo with at least one commit." >&2
fi
exec "$@"
