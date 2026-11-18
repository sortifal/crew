# ⚓ Crew

A web UI where **Opus is your project head** and **local Qwen models are your developers**.
You chat with the Head; it plans, writes task briefs, assigns them to named developers, reviews their diffs,
approves or sends them back, and **coaches them** so they stop repeating mistakes.

```
 you ──chat──▶ Head (Opus, Claude Agent SDK, read-only on the repo)
                │ create_task / get_task / approve / reject / add_lesson …
                ▼
        task board ──▶ worker runs (Qwen Code CLI, one git worktree per task)
                          │ commit → run your check command → auto-retry on failure
                          ▼
              review (diff) → approve = merge into main
```

## Docker (recommended)

Runs the server, the Qwen Code CLI and git in one container. Workers (which run with auto-approve) are then confined to the container: they only see the mounted project and Crew's own volumes.

```bash
./docker-setup.sh /path/to/your/git/repo      # writes .env (PROJECT_DIR, your UID/GID, API key)
$EDITOR .env                                  # optional: ANTHROPIC_API_KEY — or skip it and log in from the UI
docker compose up -d --build                  # → http://127.0.0.1:4317
```
Then open http://127.0.0.1:4317 and click **🔑 Log in to Claude** (top bar): open the link, authorise, paste the code back. The login (Claude subscription or Console) is stored in the `crew-home` volume and survives restarts; an API key in `.env` works too. Then open **⚙ Settings**: set the project name/branch, your workers, and the model name your local server exposes.

- Your local model server runs on the host and is reached as `host.docker.internal` (pre-configured, port 8080). It must listen on `0.0.0.0`, not only `127.0.0.1` (`llama-server --host 0.0.0.0`, `OLLAMA_HOST=0.0.0.0`). On Linux you can instead use `network_mode: host` (see comment in `docker-compose.yml`) so `localhost` URLs work.
- The project is bind-mounted at `/workspace/project`; approved tasks are merged straight into your working copy (it must be checked out on `baseBranch`, with no uncommitted changes to tracked files). The container runs as your UID so file ownership stays yours.
- State lives in named volumes: `crew-data` (tasks, chats, lessons, logs, worktrees), `crew-config` (`crew.config.yaml`), `crew-home` (Qwen/Claude state). `docker compose down -v` wipes them.
- While a task is running its git worktree lives in `crew-data`, so `git worktree list` on the host shows a path that only exists in the container. It is removed when the task is merged or cancelled (`git worktree prune` cleans up leftovers).
- Not tested in CI: the image build was not run in the environment where this was written; the compose file and entrypoint were validated statically. If `npm install -g @qwen-code/qwen-code` or the Qwen flags changed, adjust the `Dockerfile` / config.

### The agents' sandbox
The container is the sandbox: workers run as a user with **passwordless `sudo` inside the container**, so they can `sudo apt-get install`, `pip install`, `npm i -g`, start servers, etc. without touching your host OS. The image ships with python3/pip/venv, build-essential, curl, jq, ripgrep and friends, and each brief tells the agent it may install what it needs (preferably project-local, and to list system packages in its report). Your host only sees the mounted project folder and whatever network the container can reach.
- System-level installs (apt) live in the container, so they are lost when the image is rebuilt/recreated. For packages every task needs, put commands in `/app/config/sandbox-setup.sh` (kept in the config volume, runs as root at each start), e.g. `docker compose exec crew sh -c 'echo "apt-get update && apt-get install -y golang" > /app/config/sandbox-setup.sh'`.
- Files agents create as root via `sudo` are handed back to your user after every attempt so commits and cleanup keep working.
- Not a hard security boundary: the project folder is writable, and the container can reach your LAN and the model server. Cap resources by uncommenting `mem_limit` / `cpus` / `pids_limit` in `docker-compose.yml`. Existing installs: run `docker compose up -d --build` again (the compose file no longer pins `user:` or drops capabilities, because `sudo` needs them).

### Offloading agents to OpenRouter
Any agent can run on [OpenRouter](https://openrouter.ai) (or any OpenAI-compatible API) instead of your local model, so it doesn't use your GPU. In **Settings → Team**, pick the agent and set **Provider: OpenRouter**, then paste your API key, press **Test connection** (it validates the key and shows your usage) and choose a model id such as `qwen/qwen3-coder`. Choose a model that supports tool calling, since the agent CLI relies on it.
- The key is stored in the config file on the server and is never sent back to the browser. Instead of pasting it, you can enter `env:OPENROUTER_API_KEY` and set that variable in `.env` (the compose file passes it through).
- Mix freely: e.g. Mira on your local Qwen and Theo on OpenRouter. Their chats and their `qwen` CLI runs all use their own endpoint, model and key. Agents without overrides use **Settings → Local model**.
- Concurrency is limited separately: **Parallel runs · local model** (default 1) and **Parallel runs · other endpoints** (default 3), so an OpenRouter agent works while the GPU is busy.
- **Pinning the upstream provider:** for OpenRouter agents, set **Pin providers** (e.g. `relace`, or `relace, fireworks` in order of preference) and/or **Quantization** (e.g. `fp4`). By default other providers are not used if the pinned ones fail; tick the box to allow fallbacks. Crew adds the matching `provider` field to every request (chats directly, and CLI runs through a small built-in proxy at `/llm-proxy`, which only the CLI processes Crew starts can use).
- OpenRouter bills per token, and an agent can make a lot of calls. Set a spending limit on the key in your OpenRouter account. Crew does not track this cost.

## Quick start without Docker (NixOS / any Linux)

```bash
# needs: node ≥ 20, git, the `qwen` CLI (Qwen Code), a local OpenAI-compatible server (llama.cpp / Ollama / vLLM)
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # optional – or log in from the UI (🔑 button)
$EDITOR crew.config.yaml                 # set project.repo, your Qwen endpoint/model, worker names
npm start                                # → http://127.0.0.1:4317
```
On NixOS: `nix-shell -p nodejs_22 git` (and install Qwen Code with `npm i -g @qwen-code/qwen-code`).
Everything is configured from **Settings** in the UI (applies instantly) — see below; `crew.config.yaml` is just where it is stored.

The target repo must be a git repo with at least one commit, **checked out on `baseBranch`** (that is where approved work is merged).

## Using it

| Where | What |
|---|---|
| **🧭 Head** | Describe what you want. The Head asks sharp questions, creates tasks, reviews, reports back. |
| **💬 Team** | Live channel: workers announce start/finish/blockers. `@Mira do X` DMs a worker, `@head …` pings the Head. |
| **@Name** | Private chat with a developer (runs on your local model, in persona, knows its lessons and recent tasks). |
| **Board / task panel** | Status, brief, worker report, check output, diff, live log. You can approve, send back (with feedback + a lesson), answer a blocked worker, retry, cancel — the Head can do all of this too. |
| **🧠 Lessons** | The team's memory (per worker + project-wide). Edit or delete freely. |

### How "learning from mistakes" works
1. A task fails checks / is rejected / a worker gets stuck.
2. The Head (or you) records a short imperative **lesson** (`add_lesson`, or the "lesson" box when sending back).
3. Lessons live in `data/lessons/*.md` and are **injected into every future brief** of that worker (project-wide ones into everyone's) and into their DM persona. The newest `lessons.maxChars` are kept.

### Keeping Opus cheap
- The Head never writes code; workers do the token-heavy part locally.
- Every task can carry a **check command** (tests/lint/build). Workers run it, and the system re-runs it after each attempt; on failure the worker **retries by itself** (`scheduler.autoRetries`) before the Head is woken up.
- The Head is only woken for: ready for review, blocked, or failed after retries (`head.autoReview: false` to disable and drive it manually).

## Settings
A form-based **Settings** dialog (sidebar) replaces hand-editing YAML (still available under *Advanced*):
- **General** – project name/repo/base branch, shared *conventions & context* (included in the Head's prompt and every brief), Head model, auto-review, extra Head instructions.
- **Team** – add / remove / rename / disable agents. Per agent: role, persona, standing instructions, model and endpoint overrides (e.g. a bigger model for the hard tasks, or a second GPU box), timeout, auto-retries. Renaming keeps an agent's tasks, lessons and chat history; removing is refused while it has unfinished tasks (disable it instead).
- **Local model** – endpoint + key with a *Test connection* button that lists the models the server exposes, default model, agent CLI command / arguments / environment variables.
- **Workflow** – parallel runs, auto-retries, max attempts, lesson size.

## UI
**Usage tab:** token counts for every model request: prompt tokens (and how many of them came from a cache), output tokens, tokens/s and duration, per agent and per task, plus the Head's cost and how full its context is. Agent numbers are the ones the server reports (llama.cpp and OpenRouter both do); if a server doesn't, the value is estimated and marked `~`. The Head's numbers come straight from the API, including prompt-cache reads.

**Run limits.** An agent that keeps calling the model is stopped after **100 model requests** per attempt (Settings → Workflow; optionally also a prompt-token cap for paid APIs). The task then goes straight to the Head as “needs attention” instead of retrying, so it can be split or re-briefed. Briefs also tell agents to read files in ranges and keep command output short, since large tool results stay in their context for the rest of the task.

**Keeping the Head cheap.** The Head re-reads its whole conversation on every turn, so Crew keeps that small and cacheable:
- The system prompt never changes between turns, so Anthropic's prompt cache keeps working. The board is sent as a short `[board]` summary at the start of a message, only when it changed.
- When the conversation grows past **Reset context above** (default 60k tokens, Settings → Project → Head), the Head restarts with the board and its last few messages. The chat shows a note when this happens.
- Tool results are kept lean: the diff is capped at ~14k characters, and only the latest attempt is shown in full.
- **Thinking effort** (default `medium`) and a short **wait before waking the Head** (default 8 s), so several finished tasks are reviewed in one turn instead of several.
- The Head is told to be terse and not to re-fetch what it already has.

**Live tab:** one card per running agent with its task, elapsed time, the files it has touched so far (refreshed every ~4 s from its worktree), and a tail of its terminal output, streamed as it happens. A "quiet 2m" marker turns orange if an agent has produced no output for a while, which is usually a hung model call. The sidebar also shows each running agent's latest output line and timer. Each card also has a **model output** box showing what the model itself is doing: *waiting*, *thinking* (reasoning), *writing*, *calling a tool* (with its arguments) or *running a tool / between requests*, plus the request count and a rough tokens/s. This works because every agent's requests go through a small proxy inside Crew (`/llm-proxy`, usable only by the CLI processes Crew starts), which reads the streamed response on its way to the CLI. It works the same for the local model and OpenRouter. Click a card to open the task.

Light and dark themes (toggle in the sidebar; follows your system by default). The design language follows [Beautiful UI](https://www.beautifului.dev/) (MIT): OKLCH neutral tokens, hairline rings, pill buttons, 14/10/8 px radii, Inter + JetBrains Mono. Fonts are not bundled and nothing is fetched from the internet; install Inter / JetBrains Mono locally to get the exact look, otherwise system fonts are used.

## Files
- `crew.config.yaml` – all configuration (also editable in the UI).
- `data/` – tasks, chats, lessons, logs, git worktrees (`data/worktrees/tN`). Safe to back up; delete to reset.
- `src/` – `tasks.mjs` (engine/scheduler), `head.mjs` (Opus head + tools), `dm.mjs`, `git.mjs`, `lessons.mjs`, `server.mjs`.
- `npm test` – end-to-end test with a mock worker (no GPU / API key needed).

## Notes & limits
- The server binds to `127.0.0.1` and has **no authentication**; do not expose it. Workers run with `--yolo` (auto-approve) inside the task's worktree — they can still run arbitrary shell commands as your user, so use a repo/container you trust.
- Qwen Code flags/env names change between releases; adjust `qwen.args` / `qwen.env` in the config if needed (`{prompt}` is replaced by a short pointer to `.crew/BRIEF.md`). Any CLI agent that takes a prompt works (e.g. `opencode run "{prompt}"`).
- Every brief tells the agent not to use sub-agents: Qwen Code's own sub-agents are separate conversations, and on a single llama.cpp slot (`-np 1`) they evict each other's prompt cache, so each switch re-reads the whole prompt. If you do want them, run `llama-server` with `-np 2` (and `-c` doubled) and remove that line in `buildBrief`.
- `maxParallel` (default 1) applies to agents on the default local model, because one GPU serves one model well; `maxParallelRemote` (default 3) applies to agents on other endpoints. Raise the first only if your server batches requests (`-np`).
- Merges are `--no-ff` into `baseBranch`; on a conflict the merge is aborted and you're told to send the task back for a rebase.
- Not yet tested against a real Opus session or a real Qwen Code install (verified with a mock worker and a stub LLM server); expect to tune the Head's system prompt in `src/head.mjs` and the worker brief in `src/tasks.mjs` after a few real runs.
