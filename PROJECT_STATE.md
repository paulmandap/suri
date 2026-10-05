# Project state

_Last updated: 2026-10-05 (end of Phase 3)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Phase 3 (hook installer + Settings window) is done.** Suri can install its hooks into `~/.claude/settings.json` with a preview, a backup and a click, so it sees every Claude Code session, not just `sandbox/`. Paul hasn't installed them on his own settings yet (see Next). The VS Code check is still open.

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | ✅ Done |
| 2 Approvals + safety net | ✅ Done |
| 3 Hook installer + Settings | ✅ Done |
| 4 AI layer + risk explainer + eval | Next |
| 5 Mascot | |
| 6 Recap, history, digest | |
| 7 Drop a file, ask a question | |
| Proposed: Screen helper + push-to-talk | Paul to confirm (ADR-010, ADR-011) |
| 8 Ship and resume | |

## Phase 3 results

- **Installer** (`src/shared/hook-config.ts`, `src/main/installer.ts`, ADR-013): adds one HTTP hook group per event (11) to Claude Code's user settings and takes out only Suri's entries again. It reads a BOM, refuses invalid JSON, keeps other tools' hooks and every other setting, and keeps the file's own format (indent, CRLF, BOM, whitespace), so install then uninstall gives back the exact bytes. Writing needs a preview, a click, a matching fingerprint and a dated backup next to the file, then an atomic replace. It honors `CLAUDE_CONFIG_DIR`.
- **Settings window** (`src/main/settings-window.ts`, `src/preload/settings.ts`, `src/renderer/src/settings/`, ADR-014): opens from the tray (**Settings…**) or with `suri --settings`.
  - **Claude Code:** status (connected, not installed, needs an update and why, or can't read), the file path, other hooks kept, then **Preview install / update / removal** with a line diff (tokens and keys masked) and the backup path, then a click to apply.
  - **General:** the port (the hook server moves live; the hooks then show "needs an update"), Start with Windows (installed app only), Hide from screen sharing, Safety net.
  - **AI:** a "coming soon" card for Phase 4.
- **Tray and island:** the tray says when the hooks aren't installed or need an update and offers a shortcut to Settings. The island's peek and empty views say the same.
- **Build:** a second preload and page; `scripts/check-preloads.mjs` now runs in `npm run build` and fails it if a sandboxed preload needs anything but `electron`.
- **Verified:** typecheck, lint, **209 unit tests**, and the production build. Then an end-to-end run of the built app on a throwaway settings file (`CLAUDE_CONFIG_DIR` in a temp folder), driven over the DevTools protocol: **37/37 checks**. They covered the preview and masking, a script call without a click (refused), a file changed after the preview (refused, with a fresh preview), the install with its backup and kept format, moving the port to 47999 and back, the update, the removal back to the exact original bytes, and reopening Settings with `--settings`. Settings also loads under `npm run dev`. Paul's real `~/.claude/settings.json` and Suri's own settings were checked unchanged afterwards, and the screenshots were deleted.

## Try it yourself

1. `npm run dev`, then tray → **Settings…**
2. **Claude Code** → **Preview install**. Read the diff (`+` lines are Suri's hooks), then click **Install hooks**. The backup path appears.
3. Start Claude Code in any project: the island shows it.
4. To undo: **Preview removal** → **Remove hooks**, or copy the backup over `settings.json`.

## Next

1. **Paul: install the hooks on your own settings (about 2 minutes).** Do steps 1–3 above, then:
   1. Run Claude Code in a normal project (not `sandbox/`). Does the island show the session?
   2. Quit Suri and send one prompt: you should see "Stop hook error" once (expected, ADR-002).
   3. In `sandbox/`, check that each tool shows up once on the island, not twice. The Claude Code docs say identical hooks run once; if you see doubles, tell Claude and delete the `hooks` block in `sandbox/.claude/settings.local.json`.
2. **Paul: the VS Code check (about 3 minutes).** Same steps as before, now in any project once the hooks are installed:
   1. Ask Claude Code: `run the command: echo hello-vscode`. Suri shows the approval card. Click **Allow**. Does the command run without you clicking anything in VS Code?
   2. Ask again and click **Deny**. What does Claude say?
   3. Ask for `git push --force` in a repo with no remote. Does Suri's card appear (safety net), or only VS Code's own prompt?
   4. Quit Suri (tray → Quit Suri) and ask once more. What does VS Code show?
   5. Tell Claude what you saw. It goes into `docs/spike-hooks.md` and ADR-002 / ADR-012.
3. **Phase 4 — AI layer + risk explainer + eval** (see the plan). The Settings window's AI tab is the place for providers and the Gemini key.
4. **Paul: confirm the screen helper and push-to-talk** (ADR-010, ADR-011) as a new phase after Phase 7.
5. **Paul, any time:** update Ollama and pull `qwen3.5:9b` / `qwen3.5:4b`; make the mascot images (prompts in the plan).

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- Electron 44 downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- `npm run sandbox:hooks` (needs Suri started once) · `npm run replay -- session|permission|risky|error|multi|end [--hold ms]`
- Dev switches: `SURI_ALLOW_CAPTURE=1` (show Suri in screenshots), `SURI_DEVTOOLS=1` (DevTools for the island and Settings), `CLAUDE_CONFIG_DIR=<folder>` (point the installer at a test settings.json), `--settings` (open Settings at launch).

## Known issues

- Uninstalling the Suri app doesn't remove its hooks yet. Use Settings → Remove hooks first (Phase 8 adds an uninstall step).
- With the hooks installed, every project shows "Stop hook error" once per turn while Suri is closed (ADR-002).
- Not verified live yet: that Claude Code runs the sandbox's identical hook only once, and that a running session picks up new hooks without a restart. The docs say both; Next → 1 checks them.
- Not confirmed yet in VS Code: whether a held PermissionRequest blocks VS Code's own dialog, and whether a PreToolUse `"ask"` leads to Suri's card or only VS Code's prompt. The VS Code check answers both.
- The diff preview can show a new block as `+ },` / `+ {` … instead of `− }` / `+ },`. It's a correct diff, just shifted by a line.
- The safety-net rules are pattern-based. They err on the side of asking (an `echo "rm -rf /"` would be flagged too). Phase 4 adds the LLM explanation and the eval set.
- No sound yet for "needs you" (it comes with the sound pack in Phase 5).
- With two active sessions, the compact bar's focus flips between them (polish in Phase 5).
- "Open in VS Code" from a session row hasn't been clicked through by hand yet (ADR-008).
- The tray icon is still the Electron default; the mascot is a placeholder (Phase 5).
- ESLint 9 is end-of-life upstream, but the electron-toolkit configs don't support 10 yet. The renderer's shared chunk triggers Vite's 500 kB warning. Revisit both before shipping.
- No license chosen yet. Pick one before the repo goes public.
