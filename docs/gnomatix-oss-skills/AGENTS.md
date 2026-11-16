# AGENTS.md: get and use the GNOMATIX OSS skills
Every GNOMATIX agent session runs with the current GNOMATIX OSS skills installed. A session without them does not start work.
- Releases (public): https://github.com/gnomatix/gnomatix-oss-skills
- Live development (GNOMATIX LAN only): https://gitea.gnomatix.com/gnomatix/gnomatix-oss-skills
- Current release on 2026-11-16: v0.1.21 (VERSION at the repo root)

## Claude Code (CLI, desktop, IDE)
```bash
claude plugin marketplace add gnomatix/gnomatix-oss-skills   # first time only
claude plugin marketplace update gnomatix-oss-skills
claude plugin install <plugin>@gnomatix-oss-skills
claude plugin update <plugin>@gnomatix-oss-skills             # each installed plugin
```
Restart the session after updating so hooks and skills reload.

## Claude Code on the web / claude.ai cloud sessions
The skills reach a cloud session through the Claude AI skills sync. If the sync has not delivered them:
```bash
git clone --depth 1 https://github.com/gnomatix/gnomatix-oss-skills.git ~/gnomatix-oss-skills
ls ~/gnomatix-oss-skills/plugins/*/skills/*/SKILL.md
```
Then read the SKILL.md of every skill that applies before acting.

## Any agent with mise (Codex, Copilot, Cursor, OpenCode, Kiro, Antigravity)
```bash
curl -fsSL https://raw.githubusercontent.com/gnomatix/gnomatix-oss-skills/main/deps/mise.sh | sh
mise skills sync --prune
mise run doctor
```

## Check
Name the release you are on (VERSION) in your first status reply.

## After installing
1. Use the skills: read the current SKILL.md of each one that applies and follow it.
2. Work in your assigned role (R&D, software engineering, IT, PM, GNPNG roles); roles are expert roles at all times.
3. Keep your SOPs current.
