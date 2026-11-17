FROM node:22-bookworm-slim

# git: worktrees/merges · bash: task check commands · qwen: the developer agent
# The rest is the agents' sandbox toolbox: sudo (passwordless, inside the container only) plus common
# build tools, so workers can `sudo apt-get install` / pip / npm whatever the task needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates sudo gosu \
      build-essential python3 python3-pip python3-venv curl wget jq ripgrep unzip zip make pkg-config openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory '*' \
 && npm install -g @qwen-code/qwen-code \
 && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# World-writable so the container can run as any host UID (see compose `user:`).
# HOME holds Qwen/Claude state; data holds tasks, chats, lessons, logs and git worktrees.
RUN mkdir -p /app/data /app/config /home/crew /workspace/project \
 && chmod 777 /app/data /app/config /home/crew

ENV HOME=/home/crew \
    CREW_SANDBOX=1 \
    HOST=0.0.0.0 \
    PORT=4317 \
    CREW_CONFIG=/app/config/crew.config.yaml \
    NODE_ENV=production

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "src/server.mjs"]
