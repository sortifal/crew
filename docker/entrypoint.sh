#!/bin/sh
set -e
# Starts as root, creates a user matching your host UID/GID (so files in the mounted project keep
# your ownership), gives it passwordless sudo INSIDE this container, then drops to that user.
if [ "$(id -u)" = 0 ]; then
  U=${CREW_UID:-1000}; G=${CREW_GID:-1000}
  getent group "$G" >/dev/null || groupadd -g "$G" crew
  getent passwd "$U" >/dev/null || useradd -u "$U" -g "$G" -d /home/crew -s /bin/bash -M crew
  NAME=$(getent passwd "$U" | cut -d: -f1)
  echo "$NAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/crew && chmod 440 /etc/sudoers.d/crew
  chown "$U:$G" /home/crew /app/data /app/config 2>/dev/null || true
  # Optional: commands that must run as root at every container start (e.g. install packages that
  # a project always needs). Edit it from the host: docker compose exec crew sh -c 'cat > /app/config/sandbox-setup.sh'
  if [ -f /app/config/sandbox-setup.sh ]; then
    echo "[crew] running /app/config/sandbox-setup.sh"
    sh /app/config/sandbox-setup.sh || echo "[crew] WARNING: sandbox-setup.sh failed" >&2
  fi
  exec gosu "$U:$G" "$0" "$@"
fi

if [ ! -f "$CREW_CONFIG" ]; then
  cp /app/docker/crew.config.docker.yaml "$CREW_CONFIG"
  echo "[crew] wrote default config to $CREW_CONFIG (edit it in the web UI → Settings)"
fi
if ! git -C /workspace/project rev-parse --git-dir >/dev/null 2>&1; then
  echo "[crew] WARNING: /workspace/project is not a git repository. Set PROJECT_DIR in .env to a git repo with at least one commit." >&2
fi
exec "$@"
