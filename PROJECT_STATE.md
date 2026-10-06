# Project state

_Last updated: 2026-10-06 (Phase 4a: the AI layer)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Phase 4 is split in two. 4a (the AI layer and the Settings AI tab) is done; 4b (the risk explainer and its eval) is next.** Phase 3's installer is done too, but Paul hasn't installed the hooks on his own settings yet, and the VS Code check is still open (see Next).

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | ✅ Done |
| 2 Approvals + safety net | ✅ Done |
| 3 Hook installer + Settings | ✅ Done |
| 4 AI layer + risk explainer + eval | 4a ✅ AI layer · 4b next: risk explainer + eval |
| 5 Mascot | |
| 6 Recap, history, digest | |
| 7 Drop a file, ask a question | |
| Proposed: Screen helper + push-to-talk | Paul to confirm (ADR-010, ADR-011) |
| 8 Ship and resume | |

## Phase 4a results (ADR-015)

- **One interface** (`src/main/ai/provider.ts`): `generateJSON` (checked against a Zod schema), `streamText`, `listModels`, `test`. Every failure is an `AIError` with one kind (offline, rate-limit, auth, no-key, not-found, timeout, aborted, bad-output, unavailable, other).
- **Ollama** (`src/main/ai/ollama.ts`): plain HTTP to its API, `think: false`, temperature 0, the schema in `format`. Only an address on this PC is accepted, and redirects are refused.
- **Gemini** (`src/main/ai/gemini.ts`): the `@google/genai` SDK with `responseJsonSchema`, no SDK retries, the host pinned in code, and the key scrubbed from every error message.
- **Router** (`src/main/ai/router.ts`): picks the model per feature from Settings. If Gemini can't answer, the local fallback model does; local never falls back to the cloud. Redaction (`src/shared/redact.ts`) runs right before any cloud call. Not wired to a feature yet: 4b's risk explainer is the first user.
- **Gemini key** (`src/main/secrets.ts`): kept with Electron safeStorage (Windows DPAPI) in `%APPDATA%\Suri\secrets.json`. The page can save or remove it and see whether one is saved, never read it.
- **Settings → AI:** Ollama's address and connection test with the installed models, the local fallback model, the Gemini key (saved one way) with a test and the free-tier privacy note, and "Which model does what" per feature. A model that isn't pulled shows its `ollama pull` command.
- **Settings file:** an `ai` section in Suri's `settings.json`; each bad value falls back to its default on its own.
- **Verified:**
  - **Unit tests:** typecheck, lint, the build, and **317 unit tests** (108 new), all offline: fake servers on 127.0.0.1 for Ollama, a fake `fetch` under the real SDK for Gemini.
  - **End to end:** the built app's AI tab passed 20 checks against live Ollama. They covered the models listed, the pull hint, a remote address refused (page and main), bad input refused by main, and the key saved encrypted, cleared from the page, never in `settings.json`, then removed. Suri's files were restored afterwards.
  - **Live calls:** one each. Ollama (`qwen2.5:3b-instruct`) and Gemini (`gemini-3.8-flash`) both returned valid structured JSON in about 5–7 s. The router answered from Gemini with a planted token removed; an earlier router call fell back to the local model on its own.
  - **Review findings, fixed:** three redaction leaks (a lowercase `bearer`, a letters-only Basic credential, a number value under a secret name), and environment variables that could have redirected Gemini calls. Each has a test.
- **Paul's Gemini key is saved** in Suri's encrypted store on this PC (2026-10-06). "Test connection" says the key works, with 32 models, `gemini-3.8-flash` among them.

## Phase 3 results (ADR-013, ADR-014)

- **Installer:** adds one HTTP hook group per event to `~/.claude/settings.json` and takes out only Suri's entries again. BOM-tolerant, refuses invalid JSON, keeps other tools' hooks and the file's own format (install then uninstall gives back the exact bytes). A write needs a preview, a click, a matching fingerprint and a dated backup, then an atomic replace. Honors `CLAUDE_CONFIG_DIR`.
- **Settings window** (tray → **Settings…**, or `suri --settings`). The **Claude Code** tab shows the status, a diff preview and the backup path. The **General** tab has the port (the server moves live), Start with Windows (installed app only), Hide from screen sharing and the Safety net.
- **Verified:** 37/37 end-to-end checks on a throwaway settings file, plus `npm run dev`.

## Try it yourself

1. `npm run dev`, then tray → **Settings…**
2. **AI** tab: Ollama is tested when the tab opens; Gemini says "API key saved". Click **Test connection** under Gemini.
3. **Claude Code** tab → **Preview install** → read the diff → **Install hooks**. Start Claude Code in any project: the island shows it. To undo: **Preview removal** → **Remove hooks**.

## Next

1. **Paul: install the hooks on your own settings (about 2 minutes).** Try-it step 3, then:
   1. Run Claude Code in a normal project (not `sandbox/`). Does the island show the session?
   2. Quit Suri and send one prompt: you should see "Stop hook error" once (expected, ADR-002).
   3. In `sandbox/`, check that each tool shows up once on the island, not twice. The Claude Code docs say identical hooks run once; if you see doubles, tell Claude and delete the `hooks` block in `sandbox/.claude/settings.local.json`.
2. **Paul: the VS Code check (about 3 minutes),** in any project once the hooks are installed:
   1. Ask Claude Code: `run the command: echo hello-vscode`. Suri shows the approval card. Click **Allow**. Does the command run without you clicking anything in VS Code?
   2. Ask again and click **Deny**. What does Claude say?
   3. Ask for `git push --force` in a repo with no remote. Does Suri's card appear (safety net), or only VS Code's own prompt?
   4. Quit Suri (tray → Quit Suri) and ask once more. What does VS Code show?
   5. Tell Claude what you saw. It goes into `docs/spike-hooks.md` and ADR-002 / ADR-012.
3. **Paul, when convenient: `ollama pull qwen3.5:9b`** (6.6 GB; the default local model) and `ollama pull qwen3.5:4b` (3.4 GB). Settings → AI shows which ones are missing.
4. **Phase 4b: the risk explainer and its eval** (plan, Phase 4):
   - Wire the router in `src/main/index.ts` with `secrets: () => [settings.token, secrets.get('geminiApiKey') ?? '']`.
   - `src/main/ai/risk.ts`: a prompt → `{ summary, level, reasons[], reversible }`. The approval card shows the rule's level at once and the AI text fills in. The final level is the higher of rule and AI. Cache by command.
   - Expand `src/shared/risk-rules.ts` (writes outside cwd, .env and secrets, registry edits …) with tests.
   - `evals/`: about 60 labelled commands; `npm run eval:risk` reports accuracy, a confusion matrix and latency per model. Never asserted in unit tests.
   - Show which model answered, and when the local model stepped in for Gemini (`fellBackFrom`).
5. **Paul: confirm the screen helper and push-to-talk** (ADR-010, ADR-011) as a new phase after Phase 7.
6. **Paul, any time:** make the mascot images (prompts in the plan).

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- Electron 44 downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- `npm run sandbox:hooks` (needs Suri started once) · `npm run replay -- session|permission|risky|error|multi|end [--hold ms]`
- Dev switches: `SURI_ALLOW_CAPTURE=1` (show Suri in screenshots), `SURI_DEVTOOLS=1` (DevTools for the island and Settings), `CLAUDE_CONFIG_DIR=<folder>` (point the installer at a test settings.json), `--settings` (open Settings at launch).
- Talk to Ollama through its HTTP API (`curl http://127.0.0.1:11434/api/version`) in scripts: running the `ollama` command started a pending Ollama update on 2026-10-05.

## Known issues

- Ollama must be running; Suri doesn't start it. Settings says "Can't reach Ollama … Is it running?" when it isn't (seen live).
- The default local model `qwen3.5:9b` isn't pulled yet, so a local route would fail with "not-found" until it is. No feature uses the AI yet, so nothing breaks today.
- The Gemini free tier allows few requests per minute. The router then lets the local model answer, which happened once in the live test.
- Redaction is pattern-based. It errs on removing too much (`max_tokens=100` loses its value) and can miss a secret with an unknown shape and an innocent name.
- `@google/genai` brings `google-auth-library`, `protobufjs` and `ws` along (unused with an API key), which adds to the installer's size.
- Uninstalling the Suri app doesn't remove its hooks yet. Use Settings → Remove hooks first (Phase 8 adds an uninstall step).
- With the hooks installed, every project shows "Stop hook error" once per turn while Suri is closed (ADR-002).
- Not verified live yet: that Claude Code runs the sandbox's identical hook only once, and that a running session picks up new hooks without a restart. The docs say both; Next → 1 checks them.
- Not confirmed yet in VS Code: whether a held PermissionRequest blocks VS Code's own dialog, and whether a PreToolUse `"ask"` leads to Suri's card or only VS Code's prompt. The VS Code check answers both.
- The diff preview can show a new block as `+ },` / `+ {` … instead of `− }` / `+ },`. It's a correct diff, just shifted by a line.
- The safety-net rules are pattern-based. They err on the side of asking (an `echo "rm -rf /"` would be flagged too). Phase 4b adds the LLM explanation and the eval set.
- No sound yet for "needs you" (it comes with the sound pack in Phase 5).
- With two active sessions, the compact bar's focus flips between them (polish in Phase 5).
- "Open in VS Code" from a session row hasn't been clicked through by hand yet (ADR-008).
- The tray icon is still the Electron default; the mascot is a placeholder (Phase 5).
- ESLint 9 is end-of-life upstream, but the electron-toolkit configs don't support 10 yet. The renderer's shared chunk triggers Vite's 500 kB warning. Revisit both before shipping.
- No license chosen yet. Pick one before the repo goes public.
