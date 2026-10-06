# Suri

**A meerkat lookout for your Claude Code sessions on Windows.**

Suri lives in a small Dynamic Island–style bar at the top of your screen. It shows what Claude Code is doing, lets you allow or deny permission requests with one click, explains risky commands in plain English, and sums up each session, using local models (Ollama) or Gemini.

> **Status:** early development (Phase 4 of 8). Live Claude Code activity, one-click approvals, a safety net for risky commands, and a Settings window that installs Suri's hooks into Claude Code with a diff preview and a backup. The AI layer is in place: local models through Ollama, Gemini as an option, with secrets removed before anything goes to the cloud. The AI features themselves come next.

## Development

Requirements: Windows 10/11 and Node 22.12+.

```powershell
npm install
npm run dev     # start the app
npm test        # unit tests
```

How Suri talks to Claude Code, and what was measured: [`docs/spike-hooks.md`](docs/spike-hooks.md). Design decisions: [`docs/decisions.md`](docs/decisions.md).

## Credits

Inspired by [Coucou](https://github.com/louis-cfm/coucou) (MIT) by Louis Raillé. Suri is an independent project with its own code, name and character.
