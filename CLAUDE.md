# CLAUDE.md — rules for AI assistants working on Suri

Read this file and `PROJECT_STATE.md` before doing anything.

## What this project is

Suri is a Windows desktop companion for Claude Code: a baby-meerkat mascot in a Dynamic Island–style bar at the top of the screen. It shows live Claude Code activity (through HTTP hooks), lets Paul allow or deny permission requests with one click, and adds AI features: a risk explainer, session recaps, file Q&A and a daily digest. Electron + React + TypeScript.

The full plan (phases 0–8) is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo). Decisions live in `docs/decisions.md`.

Inspired by Coucou (github.com/louis-cfm/coucou, MIT). Use it for ideas and pitfalls only. Never copy its name, the Mochi character, its icon, its sounds or its art.

## Git: you do not commit

Paul is the only person who commits and pushes.

**Never run:** `git commit`, `git push`, `git tag`, `git reset`, `git rebase`, `git merge`, `git checkout`, or anything else that rewrites history or touches a remote. Read-only git (`status`, `diff`, `log`, `show`) is fine.

At the end of a phase or a meaningful unit of work, report:

```
Files changed
What changed
Tests performed
Known issues
Suggested commit message
Next recommended task
```

Then give copy-paste PowerShell blocks: `cd C:\paul\ai_tool_no-name-yet`, `git add .`, `git status --short` (say how many files to expect), and `git commit` with several `-m` flags (PowerShell 5.1 mangles here-strings). Put `git push` in its **own separate block**.

## Rules that protect Paul's Claude Code

- **Never block Claude Code.** Events that need no decision get an immediate empty 200. A PermissionRequest waits at most ~110 s, then gets an empty answer so Claude Code asks for itself. When Suri is paused, answer at once.
- **Never write `~/.claude/settings.json`** without all of these: a BOM-tolerant parse, refusing invalid JSON, a merge that keeps other tools' hooks, a shown diff, a dated backup, a check that the file still matches what was previewed, an atomic write (temp file + rename), and Paul's explicit click. Uninstall removes only Suri's entries.
- **Tests never touch the real `~/.claude/settings.json`.** Unit tests use temp folders; an end-to-end run sets `CLAUDE_CONFIG_DIR` to a scratch folder. Only Paul's click in Settings installs the global hooks. Try risky hook changes in `sandbox/` first (gitignored, its own git repo, its own `.claude/settings.local.json`).
- **Never approve, deny or "always allow" anything without an explicit click from Paul.**

## Security

- The hook server listens on 127.0.0.1 only. It requires the bearer token, rejects any `Origin` header and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, and caps the body size.
- Renderer: contextIsolation on, nodeIntegration off, sandbox on (from Phase 1), a strict CSP, and a small typed preload API. The renderer never sees secrets; it can only ask whether a key exists.
- Secrets live in Electron `safeStorage` (Windows DPAPI): never in plain files, logs or git.
- Redact secrets before any cloud AI call. No telemetry. Network calls go only to services Paul configured (Ollama, Gemini).
- Fixtures, logs and docs that get committed must not contain personal paths or usernames. Scrub them first.

## Testing and measuring

- `npm test` (Vitest) must pass with no internet and Ollama stopped. Loopback servers on 127.0.0.1 are fine (the hook server test uses one). Anything that needs a live model belongs in `evals/`, not `tests/`.
- Keep decisions in pure functions in `src/shared/` (`reduceSessions`, `deriveIslandView`) so they are tested without Electron.
- Never assert an eval score in a unit test.
- Hook payload shapes come from real captured payloads (`tests/fixtures/hooks/`), not from docs summaries. The summaries were wrong twice in Phase 0 (`tool_response`, `reason`).
- Don't claim something works unless it was run. If only part works, say which part.

## Conventions

- TypeScript strict. Use Zod for anything that crosses a boundary: hook payloads, IPC, model output, settings files.
- Main process in `src/main/`, preload in `src/preload/`, renderer in `src/renderer/src/`, shared types and schemas in `src/shared/`.
- Comments explain why, not what. Match the surrounding style (Prettier: single quotes, no semicolons, 100 columns).
- Windows first. Claude Code on Windows also has a `PowerShell` tool, so treat Bash and PowerShell commands alike.
- Launching Electron from inside a Claude Code session in VS Code: the session inherits `ELECTRON_RUN_AS_NODE=1` from VS Code, which makes Electron run as plain Node. Unset it first (`env -u ELECTRON_RUN_AS_NODE …`). Paul's own terminal doesn't have this problem.
- Don't build ahead of the current phase.

## Dev switches

- `SURI_ALLOW_CAPTURE=1` turns off "hide from screen sharing" for that run (screenshots, demo recordings).
- `SURI_DEVTOOLS=1` opens DevTools for the island in a separate window (the island itself can never take focus), and for Settings.
- `CLAUDE_CONFIG_DIR=<folder>` makes the installer edit `<folder>/settings.json` instead of `~/.claude/settings.json` (Claude Code reads the same variable). Use a scratch folder for tests.
- `--settings` opens the Settings window at launch, or in the running Suri on a second launch.

## Documentation duties

- Update `PROJECT_STATE.md` whenever a milestone lands. It's the handoff document: the next session must be able to pick up from it alone.
- Add an ADR to `docs/decisions.md` for every architectural decision. Never rewrite an old one; supersede it.

## Working style

Paul is building this to learn and to show on a resume. Explain the one decision worth understanding, briefly, in short and simple English. Prefer steps over long reasoning. Inspect before editing, plan meaningful changes, then build and test.

Do the work and the reviews inline. Run a Workflow or subagents only when Paul asks for one by name: fan-outs have used up his Pro limits without returning anything.

## Commands

```powershell
npm run dev            # run the app with hot reload
npm test               # unit tests (no network)
npm run typecheck      # main + renderer types
npm run lint
npm run build          # typecheck + production bundle + preload check
npm run build:win      # Windows installer (NSIS, per-user)
npm run sandbox:hooks  # point sandbox/ at the running Suri (reads %APPDATA%\Suri\settings.json)
npm run replay -- session|permission|risky|explain|error|multi|end [--hold ms]   # feed real captured payloads to Suri
npm run eval:risk      # risk eval on live models (evals/README.md); never part of npm test
npm run spike:hooks -- --decision none|allow|deny|ask   # Phase 0 hook logger
```
