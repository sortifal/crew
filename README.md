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
Light and dark themes (toggle in the sidebar; follows your system by default). The design language follows [Beautiful UI](https://www.beautifului.dev/) (MIT): OKLCH neutral tokens, hairline rings, pill buttons, 14/10/8 px radii, Inter + JetBrains Mono. Fonts are not bundled and nothing is fetched from the internet; install Inter / JetBrains Mono locally to get the exact look, otherwise system fonts are used.

## Files
- `crew.config.yaml` – all configuration (also editable in the UI).
- `data/` – tasks, chats, lessons, logs, git worktrees (`data/worktrees/tN`). Safe to back up; delete to reset.
- `src/` – `tasks.mjs` (engine/scheduler), `head.mjs` (Opus head + tools), `dm.mjs`, `git.mjs`, `lessons.mjs`, `server.mjs`.
- `npm test` – end-to-end test with a mock worker (no GPU / API key needed).

## Notes & limits
- The server binds to `127.0.0.1` and has **no authentication**; do not expose it. Workers run with `--yolo` (auto-approve) inside the task's worktree — they can still run arbitrary shell commands as your user, so use a repo/container you trust.
- Qwen Code flags/env names change between releases; adjust `qwen.args` / `qwen.env` in the config if needed (`{prompt}` is replaced by a short pointer to `.crew/BRIEF.md`). Any CLI agent that takes a prompt works (e.g. `opencode run "{prompt}"`).
- `maxParallel` defaults to 1 because one GPU serves one model well; raise it if your server batches requests.
- Merges are `--no-ff` into `baseBranch`; on a conflict the merge is aborted and you're told to send the task back for a rebase.
- Not yet tested against a real Opus session or a real Qwen Code install (verified with a mock worker and a stub LLM server); expect to tune the Head's system prompt in `src/head.mjs` and the worker brief in `src/tasks.mjs` after a few real runs.
