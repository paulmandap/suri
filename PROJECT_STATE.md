# Project state

_Last updated: 2026-10-04 (end of Phase 2)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Phase 2 (approvals + safety net) is done.** The VS Code check is still open; it confirms how approvals behave in the VS Code extension.

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | ✅ Done |
| 2 Approvals + safety net | ✅ Done |
| 3 Hook installer + Settings | Next |
| 4 AI layer + risk explainer + eval | |
| 5 Mascot | |
| 6 Recap, history, digest | |
| 7 Drop a file, ask a question | |
| Proposed: Screen helper + push-to-talk | Paul to confirm (ADR-010, ADR-011) |
| 8 Ship and resume | |

## Phase 2 results

- **Approvals** (`src/main/approvals.ts`, ADR-012): Suri holds each PermissionRequest and shows an approval card with the exact command, any risk, a countdown, and **Allow / Deny / Ask in Claude Code**. Several requests queue up oldest first. A timeout (110 s), Claude Code closing the request, Pause or Quit all step aside with an empty answer.
- **Safety net** (`src/shared/risk-rules.ts`, ADR-007): instant rules for wide deletes, pipe-to-shell, force push, discarding work, disk and system changes, shutdown, publishing, dropping data, and edits to Claude Code settings, SSH keys or git hooks. High risk answers PreToolUse with `"ask"`; medium risk only shows on the card. Tray toggle: "Safety net (ask before risky commands)", on by default.
- **Cute moments:** the meerkat jumps to attention with a "!" (red for high risk), a soft ring breathes around the card, and a click gives a short "Allowed" hop or "Denied" face before the island folds.
- **Hook server** now tells a held request when Claude Code hangs up (an AbortSignal).
- **Verified:** typecheck, lint, **151 unit tests**, production build, and an end-to-end run. The `rm -rf /` replay got the safety net's "ask", and the held request showed the red approval card and stepped aside when the client gave up. The screenshots were deleted afterwards.

## Try it yourself

1. `npm run dev`.
2. In a second terminal: `npm run replay -- risky`. Watch the red card; click Allow or Deny (the replay prints Suri's answer). Also try `npm run replay -- permission`.
3. Live: `npm run sandbox:hooks`, then open `C:\paul\ai_tool_no-name-yet\sandbox` in a new VS Code window and use Claude Code there.

## Next

1. **Paul: the VS Code check (about 3 minutes; Suri itself replaces the spike now).** With Suri running (`npm run dev`) and the sandbox hooks pointing at it (`npm run sandbox:hooks`):
   1. Open `C:\paul\ai_tool_no-name-yet\sandbox` in a new VS Code window and ask Claude Code: `run the command: echo hello-vscode`.
   2. Suri shows the approval card. Click **Allow**. Does the command run without you clicking anything in VS Code?
   3. Ask again and click **Deny**. What does Claude say?
   4. Ask for `git push --force` (the sandbox has no remote, so it's harmless). Does Suri's card appear (safety net), or only VS Code's own prompt?
   5. Quit Suri (tray → Quit Suri) and ask once more. What does VS Code show?
   6. Tell Claude what you saw. It goes into `docs/spike-hooks.md` and ADR-002 / ADR-012.
2. **Phase 3 — hook installer + Settings window:** install Suri's hooks into `~/.claude/settings.json` with diff, backup and click (decision 4), plus a Settings window. After that, Suri works in every project, not just `sandbox/`.
3. **Paul: confirm the screen helper and push-to-talk** (ADR-010, ADR-011) as a new phase after Phase 7.
4. **Paul, any time:** update Ollama and pull `qwen3.5:9b` / `qwen3.5:4b`; make the mascot images (prompts in the plan).

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- Electron 44 downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- `npm run sandbox:hooks` (needs Suri started once) · `npm run replay -- session|permission|risky|error|multi|end [--hold ms]`
- Dev switches: `SURI_ALLOW_CAPTURE=1` (show Suri in screenshots), `SURI_DEVTOOLS=1` (island DevTools).

## Known issues

- Not confirmed yet in VS Code: whether a held PermissionRequest blocks VS Code's own dialog, and whether a PreToolUse `"ask"` leads to Suri's card or only VS Code's prompt. The VS Code check answers both.
- The safety-net rules are pattern-based. They err on the side of asking (an `echo "rm -rf /"` would be flagged too). Phase 4 adds the LLM explanation and the eval set.
- No sound yet for "needs you" (it comes with the sound pack in Phase 5).
- With two active sessions, the compact bar's focus flips between them (polish in Phase 5).
- "Open in VS Code" from a session row hasn't been clicked through by hand yet (ADR-008).
- The tray icon is still the Electron default; the mascot is a placeholder (Phase 5).
- ESLint 9 is end-of-life upstream, but the electron-toolkit configs don't support 10 yet. The renderer bundle triggers Vite's 500 kB warning. Revisit both before shipping.
- No license chosen yet. Pick one before the repo goes public.
