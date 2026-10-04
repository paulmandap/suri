# Project state

_Last updated: 2026-10-04 (end of Phase 0)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Phase 0 (setup and spike) is done, except one manual VS Code check (see Next).**

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | Next |
| 2 Approvals | |
| 3 Hook installer + Settings | |
| 4 AI layer + risk explainer + eval | |
| 5 Mascot | |
| 6 Recap, history, digest | |
| 7 Drop a file, ask a question | |
| 8 Ship and resume | |

## Phase 0 results

- **Name:** Suri, for both the app and the mascot (a baby meerkat lookout).
- **Scaffold:** electron-vite React + TS with Electron 44.5.1, Vite 7, React 19, TypeScript 5.9, Tailwind 4, Zustand, Zod 4, motion 14 and Vitest 5. Windows-only build config (NSIS, per-user install). The window is a placeholder until Phase 1.
- **Hook spike** (`docs/spike-hooks.md`): HTTP hooks work headless. Events arrive in at most 3.4 ms. Allow, deny, deny with a message and the no-answer fallback are all proven. Claude Code isn't slowed down when Suri is closed; it just shows one "Stop hook error" notice per turn. 14 real payloads are saved as scrubbed fixtures with a contract test.
- **Decisions:** ADR-001 to ADR-006 accepted, ADR-007 (safety net) proposed (`docs/decisions.md`).

## Next

1. **Paul: the VS Code check (about 3 minutes).**
   1. In a VS Code terminal in this project, run `npm run spike:hooks -- --decision ask` and leave it running.
   2. File → New Window → Open Folder → `C:\paul\ai_tool_no-name-yet\sandbox`. If VS Code asks whether to trust the folder, say yes.
   3. In that new window, open Claude Code and type: `run the command: echo hello-vscode`
   4. The spike terminal asks `Allow …? [y / n / enter]`. Type `y` and press Enter. In the Claude window, does the command run without you clicking anything there?
   5. Ask again with `echo second-try`, and type `n` this time. What does Claude say?
   6. Stop the spike (Ctrl+C). Ask once more with `echo third-try`. What does the Claude window show?
   7. Tell Claude what you saw in steps 4–6 (screenshots help). The results go into `docs/spike-hooks.md` and ADR-002.
2. **Paul: decide on ADR-007 (safety net).** Should Suri force a prompt for high-risk commands even though your settings allow Bash and PowerShell without asking?
3. **Paul, any time:** update Ollama (quit it from the tray and reopen it, or reinstall from ollama.com), then run `ollama pull qwen3.5:9b` and `ollama pull qwen3.5:4b`. Make the mascot images with the prompts in the plan and save them in `assets/mascot/source/`.
4. **Phase 1 — overlay + live feed.** Start with `src/shared/hook-events.ts` (Zod schemas, checked against `tests/fixtures/hooks/`), then `src/main/hook-server.ts`, then the overlay window.

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint`
- Electron 44 has no install script. It downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- Hook spike: `npm run spike:hooks -- --decision allow|deny|none|ask`. It logs to `spike/logs/` (gitignored).
- `sandbox/` is a separate, gitignored project. Its `.claude/settings.local.json` sends every hook to the spike on port 47821 and has ask rules for Bash, PowerShell, Edit and Write, so permission prompts appear.

## Known issues

- ESLint 9 is marked end-of-life upstream, but the electron-toolkit ESLint configs don't support ESLint 10 yet. Revisit in Phase 8.
- The placeholder window still uses the template's `sandbox: false`. Phase 1 replaces it with the overlay, sandbox on.
- The renderer bundle triggers Vite's 500 kB warning. Look at it in Phase 1.
- No license chosen yet. Pick one before the GitHub repo goes public (MIT is common for code; the mascot art can stay "all rights reserved", like Coucou's).
