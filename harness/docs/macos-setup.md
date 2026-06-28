# macOS Setup

This guide is for a fresh Mac user profile where Homebrew, GitHub auth, Bun,
Claude Code, and Codex may not be installed or signed in yet.

## Open Terminal

Press `Command + Space`, type `Terminal`, and press `Return`.

## Install or Fix Homebrew

If `brew` is not installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

If Homebrew exists but says `/opt/homebrew is not writable`, repair ownership:

```bash
sudo chown -R "$USER" /opt/homebrew
chmod u+w /opt/homebrew
```

## Clone Modus

Install GitHub CLI and sign in:

```bash
brew install gh
gh auth login
```

Choose GitHub.com, HTTPS, authenticate Git with GitHub credentials, then use the
browser login flow.

Clone the repo:

```bash
cd ~/Documents
git clone https://github.com/dotsimulate/modus.git
cd modus
```

If GitHub asks for a password during `git clone`, do not enter your GitHub
password. GitHub HTTPS requires GitHub CLI auth or a token.

## Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

Make Bun available in the current terminal:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Make Bun available in future terminals:

```bash
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.zshrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.zshrc
```

Verify:

```bash
bun --help
```

## Install Provider CLIs

Modus can run with different providers, but each provider needs its own CLI or
API credentials before sessions for that provider will work.

Install Claude Code:

```bash
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"' >> ~/.zshrc
source ~/.zshrc
claude
```

Finish the browser login. Quit Claude with `/quit`.

Install Codex:

```bash
bun install -g @openai/codex
codex login
```

Finish the browser login.

Verify both CLIs are visible:

```bash
claude --version
codex --version
```

If `claude` is not found, check where it was installed:

```bash
ls ~/.local/bin/claude
ls ~/.claude/local/claude
```

If one exists but `claude` is still not found, reload your shell:

```bash
source ~/.zshrc
```

## Set Up and Start Modus

```bash
cd ~/Documents/modus
./modus.sh setup
modus
```

For foreground logs:

```bash
modus start
```

For background daemon mode:

```bash
modus start -d
modus logs -f
```

## Memory Guard on macOS

Modus blocks new sessions when system memory pressure is high. On macOS, normal
cached memory may look high in logs, so pressure warnings do not block sessions
by default on macOS. The log should show `pressure blocking: off`.

If you are running an older checkout and see `new sessions will be blocked`,
start Modus with pressure blocking disabled:

```bash
MG_BLOCK_ON_PRESSURE=0 modus start
```

For daemon mode:

```bash
MG_BLOCK_ON_PRESSURE=0 modus start -d
```

Do not use this as a substitute for stopping runaway provider processes. It is
only a setup-time escape hatch for older builds. The concurrent session limit and
per-process heap cap still protect the machine.

## Common Errors

`./modus.sh: line 2: exec: bun: not found`

Run:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Then retry:

```bash
./modus.sh setup
```

`Provider binary "claude" not found in PATH`

Run:

```bash
echo 'export PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"' >> ~/.zshrc
source ~/.zshrc
claude --version
```

`Invalid username or token. Password authentication is not supported`

Run:

```bash
brew install gh
gh auth login
```

Then retry `git clone`.
