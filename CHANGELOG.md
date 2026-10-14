# Changelog

## 0.2.0

A project that passed 0.1.x can fail 0.2.0: the gate now also fails on instructions hidden in
the files agents load as direction. That is the change's purpose, so it ships as a minor
version with this note rather than behind a flag.

- Scan instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and the instruction files
  under `.claude/`, `.agents/`, `.codex/`, `.cursor/rules/`, `.github/`) for hidden direction:
  invisible Unicode (zero-width, bidi overrides, tag characters decoded to the text they
  spell), HTML comments and hidden elements that address the agent, links that carry a secret
  in their query, and base64 that decodes to an injection. Scanned against the instruction
  files of 23 public repositories: no findings.
- Add `trifecta-gate drill [dir]`: a canary test of the static verdict. It plants a fake
  secret and an injected issue in a throwaway copy and listens on `127.0.0.1` for the secret.
  `--simulate` runs the exfiltration itself; running a real agent is left to you.

## 0.1.1

- Releases are staged on npm from a version tag through trusted publishing and published only
  after a maintainer approves them with 2FA.
- Show which pull request the gate failed, and link the repository from `package.json`.

## 0.1.0

- First release: read Claude Code, Codex and Cursor configuration and fail CI when one agent
  holds the lethal trifecta: private data, untrusted content and a way to send data out.
