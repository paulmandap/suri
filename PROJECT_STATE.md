# Project state

_Last updated: 2026-10-04 (end of Phase 1)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Phase 1 (overlay + live feed) is done.** The Phase 0 VS Code check is still open and is needed before Phase 2.

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | ✅ Done |
| 2 Approvals + safety net | Next |
| 3 Hook installer + Settings | |
| 4 AI layer + risk explainer + eval | |
| 5 Mascot | |
| 6 Recap, history, digest | |
| 7 Drop a file, ask a question | |
| Proposed: Screen helper + push-to-talk | Paul to confirm (ADR-010, ADR-011) |
| 8 Ship and resume | |

## Phase 1 results

- **Hook server** (`src/main/hook-server.ts`): 127.0.0.1 only; bearer token, exact Host, no Origin, 1 MB cap; every check unit tested. It never fails Claude Code: unknown events, pauses and Suri's own bugs all get an empty 200.
- **Session logic** (`src/shared/sessions.ts`): a pure reducer replayed on the real Phase 0 payloads. It handles parallel tools, denied tools (`stopped`), permission waits, failures, subagents and pruning.
- **Island** (`src/renderer/src/island/`): one transparent, always-on-top, non-focusable window. The shape springs between hidden → peek → compact → expanded, plus finished / waiting / error cards. Clicks pass through except over the island. The island is hidden from screen capture by default (tray toggle). The decision table is `src/shared/island-mode.ts`, unit tested.
- **Tray:** Open, Pause, Hide from screen sharing, Quit. Single instance; launching again opens the island.
- **Placeholder meerkat** drawn in code, with moods (idle, working, alert, happy, sleepy, worried) and a blink. The waiting card has the demo-style jump and a "!" badge (ADR-007).
- **Dev tools:** `npm run sandbox:hooks` points `sandbox/` at Suri, and `npm run replay -- <scenario>` feeds it real captured payloads.
- **Verified:** typecheck, lint, 102 unit tests, production build, and an end-to-end run (built app + replayed payloads + screenshots of every state). The screenshots were deleted afterwards.

## Try it yourself

1. `npm run dev`. The tray icon appears and the island stays hidden; hover the top centre of the screen to make it peek.
2. In a second terminal: `npm run replay -- multi`, then `npm run replay -- permission`, then `npm run replay -- end`.
3. Live: open `C:\paul\ai_tool_no-name-yet\sandbox` in a new VS Code window and use Claude Code there. Suri shows the session; the sandbox's ask rules make Claude ask permission, and Suri shows "needs your OK".
4. Recording your screen? Turn off "Hide from screen sharing" in the tray first, or the recording won't show Suri.

## Next

1. **Paul: the VS Code check (about 3 minutes; needed for Phase 2).** Quit Suri first (tray → Quit Suri), because the spike uses the same port.
   1. In a VS Code terminal in this project: `npm run spike:hooks -- --decision ask`.
   2. File → New Window → Open Folder → `C:\paul\ai_tool_no-name-yet\sandbox` (trust it if asked).
   3. In that window, ask Claude Code: `run the command: echo hello-vscode`.
   4. The spike asks `Allow …? [y / n / enter]`. Type `y`. Does the command run without you clicking anything in VS Code?
   5. Again with `echo second-try`, answering `n`. What does Claude say?
   6. Stop the spike (Ctrl+C) and ask once more. What does VS Code show?
   7. Tell Claude what you saw.
2. **Phase 2 — approvals + safety net:** Allow / Deny from the island (answering the held PermissionRequest), a first small set of high-risk rules that force "ask" (ADR-007), and the cute alert animation.
3. **Paul: confirm the screen helper and push-to-talk** (ADR-010, ADR-011) as a new phase after Phase 7.
4. **Paul, any time:** update Ollama and pull `qwen3.5:9b` / `qwen3.5:4b`; make the mascot images (prompts in the plan).

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- Electron 44 downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- `npm run sandbox:hooks` (needs Suri started once, so `%APPDATA%\Suri\settings.json` exists) · `npm run replay -- session|permission|error|multi|end`
- Dev switches: `SURI_ALLOW_CAPTURE=1` (show Suri in screenshots), `SURI_DEVTOOLS=1` (island DevTools).
- Hook spike: `npm run spike:hooks -- --decision allow|deny|none|ask` (logs to `spike/logs/`, gitignored).

## Known issues

- With two active sessions, the compact bar's focus flips between them as events alternate. Polish in Phase 5.
- Opening a folder through `vscode://file/…` (ADR-008) hasn't been clicked through by hand yet.
- The tray icon is still the Electron default, and the mascot is a placeholder (Phase 5).
- Phase 1 didn't run live Claude Code into Suri, to save Pro usage. The chain is covered in two halves: the Phase 0 spike (Claude Code → HTTP hooks) and the replay of real payloads (payload → island).
- ESLint 9 is marked end-of-life upstream, but the electron-toolkit configs don't support ESLint 10 yet. Revisit before shipping.
- The renderer bundle triggers Vite's 500 kB warning (React + motion). Check before shipping.
- No license chosen yet. Pick one before the repo goes public (MIT for code is common; the mascot art can stay "all rights reserved").
