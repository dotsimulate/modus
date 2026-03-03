# Proactive/Scheduled Agent Patterns — Research Report
*Generated: 2026-03-02*

## Summary

Proactive agent patterns represent a fundamental shift from the default "ask-and-answer" model of AI assistants toward autonomous, schedule-driven systems that wake up, evaluate their environment, and take action without human prompting. The ecosystem in early 2026 offers multiple layers of tooling for this: from bare-metal cron/systemd timers invoking `claude -p` on a schedule, through purpose-built schedulers like `claude-code-scheduler` and OpenClaw's heartbeat system, to full workflow engines like n8n that orchestrate multi-step chains triggered by time, webhooks, or file events.

For a Linux (Fedora) user running Claude Code on subscription billing, the practical starting point is simple: a systemd timer that runs a shell script calling `claude -p "your task" --max-turns 10 --output-format json`, with output logged to a file. This costs nothing beyond the subscription, requires no new infrastructure, and can be extended incrementally. More sophisticated patterns — heartbeat loops, event-driven triggers, workflow engines — layer on top as needs grow, but the core primitive is always the same: something wakes up, passes a prompt to Claude Code in non-interactive mode, captures the output, and optionally takes follow-up action.

The key risk is not cost (subscription billing makes per-token costs predictable) but runaway execution and unaudited autonomy. The `--max-turns` flag, sandboxing via `--allowedTools`, container isolation, and disciplined logging are the primary mitigations. The pattern that emerges from the research is: start with the thinnest possible scheduling layer, constrain the agent's scope tightly, log everything, and expand only when you've validated the simpler version works reliably.

## Findings

### 1. Cron/Systemd Timer Patterns

**Confidence: HIGH** — This is well-documented, battle-tested Linux infrastructure applied to a new use case.

#### Claude Code in Non-Interactive Mode

The foundation for all scheduled agent patterns is `claude -p` (the `--print` flag), which runs Claude Code non-interactively. Key properties:

- Does not require a TTY or user interaction
- Sends response to stdout, exits with code 0 on success
- Supports `--output-format json` for structured, parseable output
- Supports `--output-format stream-json` for real-time streaming
- All CLI options work: `--allowedTools`, `--max-turns`, `--append-system-prompt`, `--continue`, `--resume`
- Supports piped input: `cat file.txt | claude -p "Summarize this"`

#### Cron-Based Scheduling

The simplest pattern — a crontab entry that invokes a shell script:

```bash
#!/bin/bash
# /home/user/scripts/morning-summary.sh
LOGDIR="/home/user/logs/claude"
mkdir -p "$LOGDIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

claude -p "Check my GitHub notifications at github.com/user and write a summary of anything requiring attention. Focus on PRs needing review and issues assigned to me." \
  --allowedTools "Bash(gh *),Read" \
  --max-turns 10 \
  --output-format json \
  > "$LOGDIR/morning-summary-$TIMESTAMP.json" 2>&1
```

Crontab entry:
```
0 8 * * 1-5  /home/user/scripts/morning-summary.sh
```

This runs at 8:00 AM every weekday. Output is captured as JSON with session metadata for later review.

#### Systemd Timer-Based Scheduling (Recommended for Fedora)

Systemd timers are more robust than cron on Fedora: they support logging via journald, dependency ordering, failure notifications, persistent timers (catch up on missed runs), and calendar-based scheduling with timezone support.

**Service unit** (`~/.config/systemd/user/claude-morning.service`):
```ini
[Unit]
Description=Claude Code Morning Summary
After=network-online.target

[Service]
Type=oneshot
ExecStart=/home/user/scripts/morning-summary.sh
StandardOutput=journal
StandardError=journal
Environment=HOME=/home/user
```

**Timer unit** (`~/.config/systemd/user/claude-morning.timer`):
```ini
[Unit]
Description=Run Claude morning summary on weekdays

[Timer]
OnCalendar=Mon..Fri *-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with:
```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-morning.timer
```

Verify with:
```bash
systemctl --user list-timers
systemd-analyze calendar "Mon..Fri *-*-* 08:00:00"
journalctl --user -u claude-morning.service
```

**Advantages over cron:**
- `Persistent=true` — if the machine was off at 8 AM, the job runs when it boots
- Journal integration — `journalctl` gives you structured, searchable logs
- Dependency management — `After=network-online.target` ensures network is up
- `systemd-analyze calendar` lets you test expressions before deploying

#### Passing Context to Scheduled Invocations

Several patterns for providing rich context:

1. **Inline prompt**: `claude -p "Check GitHub notifications and summarize"`
2. **Prompt from file**: `claude -p "$(cat /path/to/prompt.md)"`
3. **Piped input**: `gh notification list | claude -p "Summarize these notifications"`
4. **System prompt customization**: `claude -p "..." --append-system-prompt "You are a security auditor"`
5. **Session continuation**: `claude -p "Follow up on yesterday's review" --continue`

#### Dedicated Scheduler: claude-code-scheduler

The `claude-code-scheduler` project (github.com/jshchnz/claude-code-scheduler) wraps these patterns with a management layer:

- Defines tasks as JSON with cron expressions, timeouts, and working directories
- Converts natural-language time expressions to cron ("every morning at 9am")
- Uses native OS schedulers under the hood (crontab on Linux)
- Supports Git worktree mode for isolated code changes
- One-time tasks auto-clean after execution

Example task config:
```json
{
  "id": "security-audit",
  "name": "Nightly Security Audit",
  "enabled": true,
  "trigger": {
    "cron": "0 2 * * *",
    "timezone": "America/New_York"
  },
  "execution": {
    "command": "Review all changes from the last 24 hours for security issues",
    "workingDirectory": "/home/user/project",
    "timeout": 300000,
    "skipPermissions": true,
    "worktree": true
  }
}
```

**Note:** The `skipPermissions` flag uses `--dangerously-skip-permissions` under the hood — see Section 6 for security implications.

#### Claude Cowork Scheduled Tasks (Alternative)

As of February 2026, Anthropic's Claude Cowork (desktop app) natively supports scheduled tasks:
- Type `/schedule` inside any Cowork task
- Configure frequency: hourly, daily, weekly, weekdays, on-demand
- Choose model, working folder, and prompt
- Available on Pro, Max, Team, and Enterprise plans

**Limitation:** Requires Claude Desktop to be open on an active/awake computer. Tasks are skipped when the device sleeps and re-run when it wakes. This makes it unsuitable for truly autonomous server-side scheduling.

---

### 2. Heartbeat/Polling Systems

**Confidence: HIGH** for OpenClaw heartbeat (well-documented), **MEDIUM** for custom polling loops (straightforward to build but less battle-tested at scale).

#### OpenClaw's Heartbeat System

OpenClaw is an open-source AI agent platform that implements a "heartbeat" pattern — the most mature implementation of proactive agent scheduling available. Architecture:

1. **Gateway** sends the agent a heartbeat prompt every N minutes (default: 30m)
2. Agent reads `HEARTBEAT.md` from its workspace — a checklist of tasks to evaluate
3. Agent decides if anything needs attention right now
4. If yes: takes action and/or sends a message to the user via configured channel
5. If no: responds with `HEARTBEAT_OK`, which the Gateway suppresses (no notification)

**Configuration** (in `~/.openclaw/config.json` or project `.openclaw.config.json`):
```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        model: "anthropic/claude-opus-4-6",
        target: "last",       // "none", "last", or channel name
        prompt: "Read HEARTBEAT.md if it exists...",
        ackMaxChars: 300,
        includeReasoning: false,
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York"
        }
      }
    }
  }
}
```

**HEARTBEAT.md format** — keep it concise (5-10 items), framed as questions:
```markdown
# Heartbeat checklist

- GitHub: any PRs assigned to me needing review?
- Calendar: conflicts in next 24 hours?
- Email: urgent items from $BOSS?
- Deploys: any failed pipelines since last check?
- RSS: new posts from feeds in watchlist.opml?
```

**Key design decisions:**
- `activeHours` prevents 3 AM wake-ups — heartbeats are skipped outside the window
- `ackMaxChars: 300` — if the agent's "nothing to report" message is under 300 chars, it's suppressed entirely
- `target: "none"` for internal-only monitoring (agent acts but doesn't message)
- Channel-level suppression: can show/hide heartbeat acknowledgments per platform
- Manual trigger: `openclaw system event --text "Check for urgent follow-ups" --mode now`

**Cost implications:** Heartbeats consume tokens on every wake-up. At 30-minute intervals with a moderate context window, expect $5-30/day on Opus 4.5 API pricing. On subscription billing, this translates to usage quota consumption rather than direct cost.

#### Custom Python Polling Loop

For a lighter-weight alternative without OpenClaw's full infrastructure:

```python
#!/usr/bin/env python3
"""Simple heartbeat loop for Claude Code agent."""
import subprocess
import json
import time
import logging
from pathlib import Path
from datetime import datetime

logging.basicConfig(
    filename="/home/user/logs/heartbeat.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)

HEARTBEAT_FILE = Path("/home/user/agent/HEARTBEAT.md")
INTERVAL_SECONDS = 1800  # 30 minutes
MAX_TURNS = 10
ACTIVE_HOURS = (9, 22)  # 9 AM to 10 PM

def is_active_hours():
    hour = datetime.now().hour
    return ACTIVE_HOURS[0] <= hour < ACTIVE_HOURS[1]

def run_heartbeat():
    if not HEARTBEAT_FILE.exists():
        logging.info("No HEARTBEAT.md found, skipping")
        return

    checklist = HEARTBEAT_FILE.read_text().strip()
    if not checklist:
        return

    prompt = f"""You are a proactive assistant. Review this checklist and
take action on anything that needs attention. If nothing needs doing,
respond with just 'HEARTBEAT_OK'.

{checklist}"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt,
             "--max-turns", str(MAX_TURNS),
             "--output-format", "json",
             "--allowedTools", "Bash(gh *),Bash(curl *),Read"],
            capture_output=True, text=True, timeout=300
        )
        response = json.loads(result.stdout)
        if "HEARTBEAT_OK" not in response.get("result", ""):
            logging.info(f"Action taken: {response.get('result', '')[:200]}")
            # Could send notification here (Telegram, email, etc.)
        else:
            logging.debug("HEARTBEAT_OK — nothing to do")
    except subprocess.TimeoutExpired:
        logging.error("Heartbeat timed out after 300s")
    except Exception as e:
        logging.error(f"Heartbeat failed: {e}")

if __name__ == "__main__":
    while True:
        if is_active_hours():
            run_heartbeat()
        else:
            logging.debug("Outside active hours, sleeping")
        time.sleep(INTERVAL_SECONDS)
```

Run as a systemd user service for resilience:
```ini
[Unit]
Description=Claude Heartbeat Agent
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/user/scripts/heartbeat.py
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
```

#### Backoff Strategies

When there's nothing to do, don't waste resources:

- **Exponential backoff**: double the interval after each `HEARTBEAT_OK`, reset on action. E.g., 30m -> 1h -> 2h -> 4h (cap at 4h)
- **Time-of-day weighting**: check more frequently during business hours, less at night
- **Event-triggered reset**: if a file watcher or webhook detects activity, reset the interval to minimum
- **Token budget**: track cumulative token usage per day, pause heartbeats when a daily budget is hit

---

### 3. Lightweight Workflow Engines

**Confidence: HIGH** for n8n (extensive documentation and Claude integration), **MEDIUM** for Activepieces (newer, less Claude-specific documentation), **HIGH** for Python-native schedulers (well-established libraries).

#### n8n — Self-Hosted Workflow Automation

n8n is the most relevant workflow engine for this use case. Key characteristics:

- **Self-hosted**: runs on your own infrastructure (Docker, npm, or binary)
- **400+ integrations**: GitHub, Telegram, RSS, email, HTTP webhooks, file system, etc.
- **Native AI capabilities**: built-in Claude/Anthropic node for direct API integration
- **Fair-code license**: free to self-host, source-available
- **Visual builder**: node-based workflow editor in the browser
- **Trigger types**: schedule (cron), webhook, app event, file change, manual

**How it integrates with Claude Code:**

1. **Direct API node**: n8n has a native Anthropic (Claude) node that calls the API
2. **Execute Command node**: runs `claude -p "..." --output-format json` locally
3. **HTTP Request node**: can trigger Claude Code via webhook hooks
4. **n8n-MCP**: A Model Context Protocol server gives Claude deep knowledge of n8n's 1,236 workflow nodes, enabling Claude to design and build n8n workflows itself

**Example workflow** — "Morning GitHub summary to Telegram":
```
[Cron Trigger: 8AM weekdays]
  → [Execute Command: gh notification list --json]
  → [Execute Command: claude -p "Summarize these: ${input}" --output-format json]
  → [Telegram: Send message to @user]
```

**Installation on Fedora:**
```bash
# Docker (recommended)
docker run -d --name n8n -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  n8nio/n8n

# Or via npm
npm install -g n8n
n8n start
```

#### Activepieces — Alternative to n8n

Activepieces is a newer, more beginner-friendly alternative:

- Docker-based with embedded database — minimal setup
- Step-based vertical builder (linear, not graph-based)
- Native OpenAI and Claude blocks built in
- Easier to set up (G2 ease-of-setup score: 9.1 vs n8n's 7.7)
- Slower execution in benchmarks (~15s vs n8n's 0.5-1s for simple tasks)
- Less mature community and fewer integrations than n8n

**When to choose Activepieces over n8n:** If you want the absolute simplest visual workflow builder and don't need n8n's performance or breadth of integrations.

**When to choose n8n:** If you want maximum flexibility, performance, and the deepest integration ecosystem. For a developer audience, n8n is the stronger choice.

#### Python-Native Schedulers

For the thinnest possible layer — no external services, no Docker, just Python:

**APScheduler** (Advanced Python Scheduler):
```python
from apscheduler.schedulers.blocking import BlockingScheduler
import subprocess

def morning_summary():
    result = subprocess.run(
        ["claude", "-p", "Check GitHub and summarize", "--max-turns", "10"],
        capture_output=True, text=True
    )
    # Process result...

scheduler = BlockingScheduler()
scheduler.add_job(morning_summary, 'cron', hour=8, minute=0, day_of_week='mon-fri')
scheduler.start()
```

- Lightweight, in-process, no external dependencies (no Redis, no message broker)
- Supports cron, interval, and date-based triggers
- Dynamic job management (add/remove jobs at runtime)
- Best for: single-machine, moderate-complexity scheduling

**Celery Beat** (with Redis/RabbitMQ):
- Distributed task queue with periodic scheduling
- Overkill for single-machine agent scheduling
- Best for: multi-worker, multi-machine, high-availability scenarios

**Recommendation:** For this use case, APScheduler or bare systemd timers are the right weight. Celery is only warranted if you're running multiple agents across multiple machines.

#### Which is the Thinnest Layer?

Ranked from thinnest to thickest:

1. **systemd timer + shell script** — zero dependencies, native OS support
2. **cron + shell script** — nearly as thin, slightly less capable
3. **APScheduler in Python** — minimal dependency, dynamic scheduling
4. **claude-code-scheduler** — purpose-built, still lightweight
5. **n8n** — full workflow engine, maximum flexibility
6. **Activepieces** — similar to n8n, easier but slower
7. **Celery Beat** — distributed task queue, heavy for this use case

---

### 4. Event-Driven Triggers

**Confidence: HIGH** for file watchers and git hooks, **MEDIUM** for webhook receivers (straightforward but requires networking setup).

#### File Watchers (inotify/watchdog)

**Python watchdog** (uses inotify on Linux):
```python
#!/usr/bin/env python3
"""Watch a directory and trigger Claude Code on new files."""
import subprocess
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class NewFileHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        filepath = event.src_path
        print(f"New file detected: {filepath}")
        subprocess.run([
            "claude", "-p",
            f"A new file was added at {filepath}. Read it and process it according to the instructions in /home/user/agent/PROCESSING_RULES.md",
            "--max-turns", "15",
            "--allowedTools", "Read,Write,Bash(python3 *)"
        ])

if __name__ == "__main__":
    observer = Observer()
    observer.schedule(NewFileHandler(), "/home/user/inbox/", recursive=False)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
```

**Important caveat:** Claude Code's own file writes use atomic operations (write to temp file, rename) that may not trigger inotify events on the final path. This is a known issue. Workaround: watch for `IN_MOVED_TO` events in addition to `IN_CREATE`.

**inotifywait** (command-line, no Python needed):
```bash
#!/bin/bash
# Watch for new files and trigger Claude
inotifywait -m -e create /home/user/inbox/ |
while read dir action file; do
    claude -p "Process the new file at ${dir}${file}" \
      --max-turns 10 \
      --output-format json \
      >> /home/user/logs/file-processing.json
done
```

#### Webhook Receivers

A simple HTTP endpoint that triggers Claude Code on incoming webhooks:

```python
#!/usr/bin/env python3
"""Minimal webhook receiver that triggers Claude Code."""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import subprocess
import threading

class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')

        # Respond immediately (don't block the webhook sender)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')

        # Process asynchronously
        threading.Thread(target=self.process_webhook, args=(body,)).start()

    def process_webhook(self, body):
        try:
            data = json.loads(body)
            # Example: GitHub webhook
            if 'pull_request' in data:
                pr_url = data['pull_request']['html_url']
                subprocess.run([
                    "claude", "-p",
                    f"Review the pull request at {pr_url}. Check for bugs, security issues, and style problems.",
                    "--max-turns", "15",
                    "--allowedTools", "Bash(gh *),Read",
                    "--output-format", "json"
                ], timeout=600)
        except Exception as e:
            print(f"Webhook processing error: {e}")

if __name__ == "__main__":
    server = HTTPServer(('0.0.0.0', 8080), WebhookHandler)
    print("Webhook server listening on :8080")
    server.serve_forever()
```

**Claude Code also has native HTTP hooks** — you can configure hooks of `"type": "http"` that POST event data to a URL. This is the inverse pattern: Claude Code calling out to your webhook, rather than a webhook triggering Claude.

#### Git Hooks

**Post-commit hook** (`.git/hooks/post-commit`):
```bash
#!/bin/bash
# Trigger Claude Code review after every commit
DIFF=$(git diff HEAD~1)
echo "$DIFF" | claude -p \
  "Review this commit for potential issues. Be concise." \
  --max-turns 5 \
  --output-format json \
  >> /home/user/logs/commit-reviews.json &
```

**Note on Claude Code's own hooks system:** Claude Code has its own hook lifecycle (PreToolUse, PostToolUse, etc.) that triggers shell commands or HTTP calls at specific points during a Claude session. These are complementary to git hooks — they control Claude's behavior during a session, while git hooks trigger Claude sessions from external events.

A workaround for post-commit behavior within Claude Code hooks: use a PostToolUse hook with matcher `Bash(git commit:*)` to trigger after Claude itself makes a commit.

#### GitHub Webhooks → Local Agent: The Full Chain

The complete pipeline for running a local Claude agent in response to GitHub events:

1. **GitHub webhook** fires on PR/issue/push event
2. **Webhook forwarding** via ngrok, Cloudflare Tunnel, or smee.io relays to your local machine
3. **Local webhook receiver** (Python/Node) validates the payload and signature
4. **Receiver spawns** `claude -p "Review PR #123..." --max-turns 15`
5. **Claude Code** uses `gh` CLI to read the PR, analyze code, post comments
6. **Output** is logged locally and optionally posted back via `gh pr comment`

For a more managed approach, **claude-hub** (github.com/claude-did-this/claude-hub) provides a pre-built webhook service that connects Claude Code to GitHub repositories, enabling @mention-triggered AI code review.

---

### 5. Practical Use Cases

#### Use Case 1: "Agent checks GitHub notifications, summarizes, sends to Telegram"

**Implementation: systemd timer + shell script**

```bash
#!/bin/bash
# /home/user/scripts/github-telegram-summary.sh
set -euo pipefail

LOGFILE="/home/user/logs/github-summary-$(date +%Y%m%d).log"
TELEGRAM_BOT_TOKEN="your-bot-token"
TELEGRAM_CHAT_ID="your-chat-id"

# Get GitHub notifications
NOTIFICATIONS=$(gh api notifications --jq '.[].subject | "\(.type): \(.title) (\(.url))"' 2>/dev/null || echo "No notifications")

if [ "$NOTIFICATIONS" = "No notifications" ]; then
    echo "$(date): No notifications" >> "$LOGFILE"
    exit 0
fi

# Have Claude summarize
SUMMARY=$(echo "$NOTIFICATIONS" | claude -p \
  "Summarize these GitHub notifications concisely. Group by priority (needs action / FYI). Keep it under 500 chars for Telegram." \
  --max-turns 3)

# Send to Telegram
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  -d text="$SUMMARY" \
  -d parse_mode="Markdown" >> "$LOGFILE"

echo "$(date): Summary sent" >> "$LOGFILE"
```

Timer: `OnCalendar=Mon..Fri *-*-* 08:30:00`

#### Use Case 2: "Agent monitors a directory for new files, processes them"

**Implementation: watchdog + Claude Code**

Use the watchdog script from Section 4 with a `PROCESSING_RULES.md`:

```markdown
# File Processing Rules

When a new file appears in /home/user/inbox/:

1. If it's a .pdf — extract text, summarize key points, save summary to /home/user/processed/
2. If it's a .csv — analyze the data, generate a brief statistical summary
3. If it's a .py — run a code review, check for bugs and style issues
4. For anything else — describe the file contents and move to /home/user/processed/

Always log what you did to /home/user/logs/processing.log
```

#### Use Case 3: "Agent runs nightly code review on recent commits"

**Implementation: systemd timer + git diff piping**

```bash
#!/bin/bash
# /home/user/scripts/nightly-review.sh
set -euo pipefail

PROJECT_DIR="/home/user/projects/myapp"
LOGDIR="/home/user/logs/reviews"
mkdir -p "$LOGDIR"
TIMESTAMP=$(date +%Y%m%d)

cd "$PROJECT_DIR"
git fetch origin

# Get commits from last 24 hours
DIFF=$(git log --since="24 hours ago" --oneline --no-merges origin/main)

if [ -z "$DIFF" ]; then
    echo "No new commits" > "$LOGDIR/review-$TIMESTAMP.txt"
    exit 0
fi

FULL_DIFF=$(git diff "origin/main@{24 hours ago}" origin/main 2>/dev/null || git diff HEAD~5 HEAD)

echo "$FULL_DIFF" | claude -p \
  "You are a senior code reviewer. Review these changes from the last 24 hours.
   Flag: security issues, bugs, performance problems, missing error handling.
   Format: a concise report with severity levels (CRITICAL/WARNING/INFO)." \
  --max-turns 10 \
  --allowedTools "Read" \
  --output-format json \
  > "$LOGDIR/review-$TIMESTAMP.json"
```

Timer: `OnCalendar=*-*-* 02:00:00` (2 AM daily)

#### Use Case 4: "Agent checks RSS feeds and compiles a daily research digest"

**Implementation: APScheduler + feedparser + Claude Code**

```python
#!/usr/bin/env python3
"""Daily RSS digest compiled by Claude Code."""
import subprocess
import json
import feedparser
from datetime import datetime, timedelta

FEEDS = [
    "https://simonwillison.net/atom/everything/",
    "https://blog.anthropic.com/rss.xml",
    "https://news.ycombinator.com/rss",
]

def fetch_recent_entries(hours=24):
    cutoff = datetime.now() - timedelta(hours=hours)
    entries = []
    for feed_url in FEEDS:
        feed = feedparser.parse(feed_url)
        for entry in feed.entries[:10]:  # Last 10 per feed
            entries.append(f"- [{entry.get('title', 'Untitled')}]({entry.get('link', '')})")
    return "\n".join(entries)

def compile_digest():
    entries = fetch_recent_entries()
    if not entries:
        return

    prompt = f"""Compile a research digest from these recent articles.
Group by theme. For each item, write a 1-2 sentence summary of why it matters.
Highlight anything relevant to AI agents, developer tools, or automation.

Articles:
{entries}"""

    result = subprocess.run(
        ["claude", "-p", prompt, "--max-turns", "5"],
        capture_output=True, text=True, timeout=120
    )

    output_path = f"/home/user/digests/{datetime.now():%Y-%m-%d}.md"
    with open(output_path, 'w') as f:
        f.write(f"# Research Digest — {datetime.now():%Y-%m-%d}\n\n")
        f.write(result.stdout)

if __name__ == "__main__":
    compile_digest()
```

Schedule via systemd timer at 7:00 AM daily.

---

### 6. Security and Cost Considerations

**Confidence: HIGH** — well-documented by Anthropic and the community.

#### Limiting Scope for Unattended Execution

**`--allowedTools` (primary mechanism):** Explicitly whitelist only the tools the agent needs:
```bash
claude -p "..." --allowedTools "Read,Bash(gh *),Bash(git diff *)"
```
This prevents the agent from using Write, Edit, or arbitrary Bash commands. The syntax supports prefix matching (`Bash(gh *)` allows any command starting with `gh`).

**`--dangerously-skip-permissions`:** Required for fully autonomous execution (no permission prompts), but carries serious risks:
- Data loss: the agent can delete files
- System compromise: can execute arbitrary commands
- Credential exposure: can read `.env`, API keys
- A documented incident: an agent executed `rm -rf /` on a developer's Ubuntu/WSL2 system

**Safe usage of `--dangerously-skip-permissions`:**
- **Always** run inside a container (Docker, devcontainer) or VM
- **Always** combine with `--allowedTools` to restrict the tool surface
- **Never** run as root (Claude Code blocks this, but be aware)
- Use read-only bind mounts for sensitive directories
- Prefer `--allowedTools` alone when possible — it auto-approves only the listed tools

**Sandboxing (Claude Code native):**
Claude Code has built-in sandboxing that defines boundaries: which directories and network hosts are accessible. Commands within the sandbox don't require approval; commands outside it trigger notifications.

#### Cost Management on Subscription Billing

With Pro ($20/month) or Max ($100-200/month) plans:
- Per-token costs are not a concern — it's a flat monthly fee
- The real cost is **usage quota consumption** — each plan has a message/usage limit
- Pro: ~45 messages every 5 hours
- Max $100: 5x Pro usage; Max $200: 20x Pro usage
- Scheduled agents consume quota even when you're not actively using Claude

**Mitigation strategies:**
- Use `--max-turns` to cap each session (e.g., `--max-turns 10`)
- Schedule during off-hours when you're not using quota interactively
- Use lower frequency (hourly, not every 5 minutes) for polling tasks
- Use backoff: skip heartbeats when nothing has changed
- For Agent SDK programmatic usage: requires API key (not subscription billing) — this is a significant limitation noted in the community

#### The `--max-turns` Flag

`--max-turns N` is the primary safety rail for automated sessions:
- Limits the number of tool-call iterations (not wall-clock time)
- Prevents infinite loops and runaway token consumption
- Execution stops and returns an error result when the limit is hit
- Recommended: start low (5-10), increase only after validating the task completes

**Limitation:** Does not prevent tight, token-expensive loops within the turn limit. An agent can burn significant tokens in 10 turns if each turn involves large context windows.

#### Logging and Auditing

**Structured output logging:**
```bash
claude -p "..." --output-format json > /logs/session-$(date +%s).json
```
The JSON output includes: result text, session ID, token usage metadata, and tool calls made.

**Session continuation for auditing:**
```bash
# Capture session ID
session_id=$(claude -p "..." --output-format json | jq -r '.session_id')
# Later, review what happened
claude -p "Summarize what you did in the previous session" --resume "$session_id"
```

**systemd journal integration:**
```bash
# Review all Claude agent runs
journalctl --user -u 'claude-*' --since today
# Follow in real time
journalctl --user -u claude-morning.service -f
```

**Enterprise auditing:** Organizations should implement weekly log reviews, denied-action alert investigation, and log retention policies (1 year recommended).

#### Graceful Failure Handling

Key principles for unattended agents:
1. **Timeout everything**: `subprocess.run(..., timeout=300)` and systemd `TimeoutStopSec=`
2. **Don't retry infinitely**: cap retries at 2-3, then alert and stop
3. **Alert on failure**: send a notification (email, Telegram, systemd `OnFailure=`) when an agent fails
4. **Log stderr**: capture error output alongside success output
5. **Use `set -euo pipefail`** in wrapper scripts: fail fast on errors

systemd failure notification:
```ini
[Unit]
Description=Claude Agent Task
OnFailure=notify-failure@%n.service

[Service]
Type=oneshot
ExecStart=/home/user/scripts/agent-task.sh
TimeoutStartSec=600
```

---

## Implementation Comparison

| Approach | Complexity | Reliability | Flexibility | Best For |
|----------|-----------|-------------|-------------|----------|
| systemd timer + script | Low | High | Medium | Single-machine scheduled tasks |
| cron + script | Low | Medium | Medium | Quick-and-dirty scheduling |
| claude-code-scheduler | Low-Medium | High | Medium | Purpose-built Claude scheduling |
| Python heartbeat loop | Medium | Medium | High | Custom polling with backoff |
| OpenClaw heartbeat | Medium | High | High | Full proactive agent platform |
| File watcher (watchdog) | Medium | High | Medium | Event-driven file processing |
| Webhook receiver | Medium | Medium | High | GitHub/API event responses |
| Git hooks | Low | High | Low | Post-commit automation |
| n8n workflows | Medium-High | High | Very High | Multi-step, multi-service orchestration |
| Activepieces | Medium | Medium | High | Simpler visual workflows |
| APScheduler (Python) | Low-Medium | Medium | High | Dynamic in-process scheduling |
| Claude Cowork scheduled | Very Low | Medium | Low | Desktop-bound recurring tasks |

---

## Sources

1. [Run Claude Code programmatically — Claude Code Docs](https://code.claude.com/docs/en/headless)
2. [CLI reference — Claude Code Docs](https://code.claude.com/docs/en/cli-reference)
3. [Automate workflows with hooks — Claude Code Docs](https://code.claude.com/docs/en/hooks-guide)
4. [Sandboxing — Claude Code Docs](https://code.claude.com/docs/en/sandboxing)
5. [Manage costs effectively — Claude Code Docs](https://code.claude.com/docs/en/costs)
6. [Schedule recurring tasks in Cowork — Claude Help Center](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork)
7. [Heartbeat — OpenClaw Docs](https://docs.openclaw.ai/gateway/heartbeat)
8. [Schedule Proactive OpenClaw Tasks with Heartbeat in 15 Minutes — Markaicode](https://markaicode.com/openclaw-heartbeat-proactive-tasks/)
9. [How OpenClaw Works — Bibek Poudel, Medium](https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764)
10. [claude-code-scheduler — GitHub (jshchnz)](https://github.com/jshchnz/claude-code-scheduler)
11. [Building Automated Claude Code Workers with Cron and MCP Servers — blle.co](https://www.blle.co/blog/automated-claude-code-workers)
12. [Claude Code Cron Automation Complete Guide — SmartScope](https://smartscope.blog/en/generative-ai/claude/claude-code-cron-schedule-automation-complete-guide-2025/)
13. [n8n — Fair-code workflow automation — GitHub](https://github.com/n8n-io/n8n)
14. [Claude Code n8n workflows: the era of self-building agents — Ability AI](https://www.ability.ai/blog/claude-code-n8n-workflows)
15. [n8n-MCP — Connect AI to Workflow Automation](https://www.n8n-mcp.com/)
16. [n8n vs Activepieces — Activepieces](https://www.activepieces.com/blog/activepieces-vs-n8n)
17. [Scheduling Tasks in Python APScheduler vs Celery Beat — Leapcell](https://leapcell.io/blog/scheduling-tasks-in-python-apscheduler-vs-celery-beat)
18. [Systemd Timers for Scheduling Tasks — Fedora Magazine](https://fedoramagazine.org/systemd-timers-for-scheduling-tasks/)
19. [systemd/Timers — ArchWiki](https://wiki.archlinux.org/title/Systemd/Timers)
20. [What is --max-turns in Claude Code — ClaudeLog](https://claudelog.com/faqs/what-is-max-turns-in-claude-code/)
21. [Claude Code --dangerously-skip-permissions: Safe Usage Guide — ksred.com](https://www.ksred.com/claude-code-dangerously-skip-permissions-when-to-use-it-and-when-you-absolutely-shouldnt/)
22. [What is --output-format in Claude Code — ClaudeLog](https://claudelog.com/faqs/what-is-output-format-in-claude-code/)
23. [OpenClaw vs Claude Code: Agent Architecture Deep Dive — ClaudeWorld](https://claude-world.com/articles/openclaw-vs-claude-code/)
24. [The Ultimate Guide to AI Agents in 2026 — DEV Community](https://dev.to/tech_croc_f32fbb6ea8ed4/the-ultimate-guide-to-ai-agents-in-2026-openclaw-vs-claude-cowork-vs-claude-code-395h)
25. [Claude Code in Enterprise Environments — Claude AI](https://claude-ai.chat/blog/claude-code-in-enterprise-environments/)
26. [Claude Code Hooks Guide: All 12 Lifecycle Events — Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
27. [claude-mcp-scheduler — GitHub (tonybentley)](https://github.com/tonybentley/claude-mcp-scheduler)
28. [claude-hub — GitHub (claude-did-this)](https://github.com/claude-did-this/claude-hub)
29. [webhook-skills for AI coding agents — GitHub (hookdeck)](https://github.com/hookdeck/webhook-skills)
30. [Claude Cowork scheduled tasks: 6 ways I automated my work — aiblewmymind](https://aiblewmymind.substack.com/p/claude-cowork-scheduled-tasks-6-ways)

---

## Implications

### Recommended Approach: Start Simple, Grow as Needed

**Phase 1 — Validate the pattern (Day 1):**
Start with a single systemd timer calling a shell script that runs `claude -p` with `--max-turns 10` and `--allowedTools` restrictions. Pick one concrete use case — the GitHub notification summary is a good first candidate because it's read-only (low risk) and immediately useful. Log output as JSON. Review the logs manually for a week.

**Phase 2 — Add event-driven triggers (Week 2-3):**
Once you trust the scheduled pattern, add a file watcher for an inbox directory or a post-commit git hook. These are still single-purpose, stateless triggers. Keep each one as a separate systemd service or script.

**Phase 3 — Introduce a heartbeat loop (Week 4+):**
If you find yourself wanting multiple scheduled checks that share context, implement the Python heartbeat pattern with a `HEARTBEAT.md` checklist. This consolidates multiple timers into a single intelligent loop. Consider OpenClaw if you want a full-featured version with messaging integration.

**Phase 4 — Workflow engine (only if needed):**
Only bring in n8n if you need multi-step workflows with branching logic, multiple external service integrations, or visual workflow management. For most single-user agent patterns, the systemd timer + script approach will carry you further than you'd expect.

**Key principle:** Each layer of complexity should be justified by a specific limitation of the previous layer. Don't start with n8n when a shell script will do. Don't build a custom polling loop when a systemd timer with `Persistent=true` handles missed runs.

### Subscription Billing Advantage

Running Claude Code on Max plan ($100-200/month) rather than API billing fundamentally changes the economics of proactive agents. You don't need to optimize for token cost — you need to optimize for quota consumption. This means:
- Prefer fewer, more comprehensive agent sessions over many small ones
- Use `--max-turns` aggressively to prevent quota-burning loops
- Schedule heavy tasks during off-hours when interactive quota isn't needed
- The Agent SDK (Python/TypeScript) currently requires API keys, not subscription — this is a constraint to watch as it may change

---

## Open Questions

1. **Quota impact measurement:** How many "messages" does a single `claude -p` invocation with `--max-turns 10` consume on a Max plan? Is each turn a separate message, or is the whole session one message? This needs empirical testing.

2. **Agent SDK + subscription billing:** The Agent SDK currently requires API keys. Will Anthropic extend subscription billing to the SDK? This would unlock programmatic multi-agent patterns without per-token cost.

3. **Session persistence across scheduled runs:** Can `--resume` reliably continue context across days/weeks of scheduled runs, or does session state expire? What's the retention window?

4. **Concurrent agent safety:** If two scheduled tasks overlap (e.g., a timer fires while the previous run is still active), what happens? Need to test `flock`-based locking or systemd's `ExecCondition` for mutual exclusion.

5. **Claude Code file write detection:** Watchdog/inotify may miss Claude Code's atomic file writes. Need to verify the exact mechanism and whether watching for `IN_MOVED_TO` events resolves this reliably on Fedora.

6. **Heartbeat vs timer cost comparison:** On Max plan, is a 30-minute heartbeat loop (which keeps context warm) more quota-efficient than independent systemd timer invocations (which start cold each time)?

7. **OpenClaw maturity for non-messaging use cases:** OpenClaw is optimized for messaging-platform integration (Telegram, WhatsApp). How well does it work for developer-centric use cases (code review, file processing) where the output destination is a file or API rather than a chat message?

8. **Container isolation overhead:** Running Claude Code in Docker for safe `--dangerously-skip-permissions` adds startup latency. What's the cold-start penalty for containerized scheduled runs, and does it matter at 30-minute intervals?
