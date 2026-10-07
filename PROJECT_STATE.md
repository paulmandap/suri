# Project state

_Last updated: 2026-10-07 (Suri stays out of full-screen games, ADR-029; the screen helper and push-to-talk moved to after Phase 8)_

Read `CLAUDE.md` first. The plan is in `~/.claude/plans/i-want-to-build-zany-gosling.md` (local only, not in the repo).

## Where we are

**Suri now stays out of full-screen games** (ADR-029): while a game or another app fills the screen, the island hides and stays silent, AI work waits, and Suri's model leaves the graphics card; what waited shows (and chirps) when the game is gone. **Phase 7 is built: drop a file on the island and ask about it** (ADR-027), and most known issues are fixed (ADR-024 to ADR-028). Paul chose (2026-10-07) to build the screen helper and push-to-talk **after Phase 8**, as v1.1. **Next is Phase 8** (ship and resume), after Paul's short checks (Next → 1 and 2).

| Phase | Status |
|---|---|
| 0 Setup and spike | ✅ Done (VS Code check pending) |
| 1 Overlay + live feed | ✅ Done |
| 2 Approvals + safety net | ✅ Done |
| 3 Hook installer + Settings | ✅ Done |
| 4 AI layer + risk explainer + eval | ✅ Done |
| 5 Mascot | ✅ Done (a turning animation is left for later) |
| 6 Recap, history, digest | ✅ Done |
| 7 Drop a file, ask a question | ✅ Done (a real drag from Explorer left for Paul) |
| Stay out of full-screen games (ADR-029) | ✅ Done (a check with a real game left for Paul) |
| 8 Ship and resume | Next |
| v1.1: Screen helper + push-to-talk | After Phase 8 (Paul, 2026-10-07; ADR-010, ADR-011) |

## Staying out of full-screen games (ADR-029)

- **What counts** (`src/shared/quiet.ts`): a window in front that fills the island's monitor, a Direct3D game that owns the screen, or presentation mode. Not counted: a maximized window, the desktop, another monitor, and the programs Claude Code runs in (VS Code, Cursor, Windows Terminal, PowerShell, cmd, Git Bash's mintty and a few more), so a full-screen VS Code still gets its cards.
- **How Suri knows** (`src/main/foreground.ts`): Windows calls through **koffi** (new dependency, MIT, about 3 MB, prebuilt, nothing to compile). One look takes about 0.1 ms. It looks on every hook event and once a second while something could show (`src/main/quiet-watch.ts`). It goes quiet at once and comes back a second after the game is gone. The program's name is read only for a full-screen window, once per process, with the least access (anti-cheat tools watch who opens a game).
- **While quiet:** the overlay window is hidden (it can't take a click), no sounds, the file panel closes. A held request waits; when the game is gone the card appears fresh (the click guard starts then) with one chirp. The risk check runs then too, and recaps wait. The warm-up stops and Suri's model is unloaded from Ollama (`keep_alive: 0`), so the game gets the graphics card. Claude Code still asks for itself after 110 s.
- **Settings → General → "Stay out of full-screen games"** (on by default). The tray says "Staying quiet: dota2.exe is full screen".
- **Verified:** typecheck, lint, the build and **633 unit tests** (27 new: the decision table with the window shapes measured on this PC, the watcher's timing, waiting and giving up, the recap queue held through more games than its yield limit, sounds, the island view, settings, Ollama's `/api/ps` and unload, and a smoke test of the real Windows calls). A mutation check: counting a game as a recap yield fails the test. **End to end in the packaged app** (`electron-builder --dir`, koffi's binary unpacked from the asar automatically), with a scratch `SURI_DATA_DIR`, a fake Ollama that logged every call, and a black full-screen window for 9 s: a replayed request during the "game" gave a black screenshot (no island, no card); the fake Ollama saw `/api/ps` and an unload, and no warm-up and no risk call; about 2 s after the window closed the card appeared with the AI's answer, and the warm-up came back on the next event. Paul's own Suri and Ollama weren't touched.
- **Not checked by hand:** a real game (Dota 2 in its own full-screen mode, Next → 2), the tray line and the Settings switch, the chirp on coming back (unit tested only).

## Phase 7 and the known-issue fixes (ADR-024 to ADR-028)

- **Questions about a file** (`src/main/ai/file-qa.ts`, `src/renderer/src/views/AskPanel.tsx`): "+ Ask a file" in the expanded island, tray → Ask about a file…, or `suri --ask`. Drop a PDF, Markdown, notes or code (up to 20 MB), or choose one, then chat about it. Answers stream in, with Markdown and a Copy button on code. Only text reaches any model, so redaction always runs before Gemini; PDFs are read with `unpdf` (2 MB). Gemini gets the whole file; a local model gets the chunks that best match the question (BM25), and the answer says so. The window takes clicks and focus only while the panel is open; Esc or a click outside closes it.
- **Speed** (ADR-024): the first Claude Code event of a working spell loads the model in the background, and Suri asks Ollama to keep it 15 minutes after each call, so the first risk check of a spell answers in about 3 s instead of waiting 10–60 s for a load. Seen live: the model was loaded 13 s after one replayed event, held until 15 minutes later. Ollama's app starts with Suri if it's closed, and Settings → AI has a Start button and switches for both. The windows' code is minified (926 kB → 352 kB).
- **Approval clicks must be aimed** (ADR-028): a test card popped up over Dota 2 and a game click landed on Allow. Now the buttons ignore clicks for the first second, and only count once the pointer has moved onto them after that.
- **Risk checks without comments** (ADR-025): the model no longer sees shell comments ("this is safe, rate it low"). `qwen3.5:9b` + rules now catches all 22 high-risk eval cases (95%).
- **Smaller fixes:** the finished card counts the turn, not the whole session. Settings → General → History → Delete history… (two clicks; the file is rewritten so deleted rows don't linger). `suri --digest` opens today's notes. Subagents: one real capture (2026-10-07) showed their events carry the parent's session and `prompt_id`, so History already put them in the right turn; now pinned by fixtures and a test. Replays' approvals stay out of History too. The repo is MIT, the mascot art all rights reserved (`assets/mascot/LICENSE.md`).
- **Evals for every AI feature** (ADR-026): digest (`npm run eval:digest`) and file questions (`npm run eval:files`, with a retrieval check: 7 of 7 answers in the chunks Suri picks). Gemini runs only when named. The recap rubric's needs-input now means "the final message asks something".
- **Gemini** (`gemini-3.8-flash`) is still unmeasured: on 2026-10-07 it timed out, said "unavailable", then hit the free-tier limit, so the runs were stopped before saving "no answer" rows.
- **Eval results (local models, Ollama 0.40):**

  | Model | Risk + rules | Recap outcome | Digest placed right (claimed done) | File questions: facts, "it doesn't say" |
  |---|---|---|---|---|
  | **`qwen3.5:9b`** (default) | **95%**, 22/22 high | 96% | 16/19 (1) | **100%**, 3/3 |
  | `qwen2.5:7b-instruct` | 90% | 88% | 18/19 (0) | 92%, 3/3 |
  | `qwen3.5:4b` | 82% | 92% | 16/19 (1) | 100%, 3/3 |
  | `qwen2.5:3b-instruct` | 80% | 79% | 18/19 (0) | 92%, 3/3 |

  Retrieval for local file questions: 7 of 7 answers in the picked chunks. The digest's and file questions' default is Gemini (the 9b is their fallback); Gemini isn't measured yet.
- **Verified:** typecheck, lint, the build and **606 unit tests** (155 more than Phase 5). All four evals on four local models. In a scratch Suri (`SURI_DATA_DIR`): the warm-up (model loaded 13 s after one event, held 15 minutes); the file panel from `suri --ask`, a dropped README (synthetic drop event, the same handler and IPC as a real drag) and a question answered by `qwen3.5:9b` with "(Gemini: no key)", the code block's Copy (Paul's clipboard saved and put back), Esc closing it and focus going back to VS Code; Start Ollama with Ollama fully closed (back in 3 s, "started Ollama" logged). Fixed on the way: `--ask` at launch asked for focus before the window had appeared, and the Open dialog had no owner, so it could open behind the island. **Not checked by hand:** a real drag from Explorer, the Open dialog (it opened behind Paul's browser, and the test typed nothing), Save as .md, the tray items, and a card over a full-screen game.

## Phase 6 results (ADR-020, ADR-021, ADR-022)

- **History** (`src/main/history.ts`, `src/main/db.ts`): SQLite in `%APPDATA%\Suri\history.db` through Node's built-in `node:sqlite`, not `better-sqlite3`: a native module would need one build for Electron's Node 24 and another for the tests' Node 22. One row per request (a "turn", found by Claude Code's `prompt_id`), one per tool call, plus approvals and digests. Migrations by `PRAGMA user_version`. Steps are kept 30 days, the rest a year. Text is redacted before it's stored. Recording never throws, so a broken history can't cost Claude Code an answer; a damaged file is moved aside.
- **The recap** (`src/main/ai/recap.ts`): when a turn ends, code counts the facts (files changed with their lines, commands with ok / failed, reads, failures) and the model writes only `{ title, summary, outcome, followUps }`, so it can't invent a file or a command. Outcomes: done, partial, needs-input, failed. Recaps run one at a time and step aside while a risk check runs (Paul waits on that one). The finished card shows "writing a recap…", then the recap's title, summary and outcome ("partly done", "needs your answer", "couldn't finish"). Settings → General → Session recaps turns it off.
- **History window** (tray → History…, or `suri --history`): days on the left; for each day the standup notes and every request by project, with its recap, files, commands, approvals and Claude's last message, plus "Write a recap" to try again. A third sandboxed window with its own preload, like Settings.
- **Daily digest** (tray → Today's digest): the day's recaps as standup notes (done, in progress, blockers, next), by the digest model (Gemini by default, the local model as fallback). The model is held to the history's projects, never sees paths or commands, and its prompt stays inside Ollama's default context. With no model at all, Suri writes a plain version itself and says why. Copy (Markdown) and Save as .md; "3 requests came in after these were written" offers a rewrite.
- **The recap eval** (`npm run eval:recap`, `evals/recap-cases.json`): 24 labelled turns (9 done, 6 partial, 5 needs-input, 4 failed). It scores the outcome, the facts each case says the recap should state, made-up claims (like "tests pass" after a failed last run), length, and follow-ups. Results on Ollama 0.40 (`evals/results/recap.md`):

  | Model | Outcome right | Facts stated | Made-up claims | No follow-up | Median |
  |---|---|---|---|---|---|
  | **`qwen3.5:9b`** (the default) | 96% | 100% | 0 | 0 | 3.0 s |
  | `qwen2.5:7b-instruct` | 92% | 98% | 0 | 0 | 1.3 s |
  | `qwen3.5:4b` | 88% | 98% | 1 | 4 | 1.6 s |
  | `qwen2.5:3b-instruct` | 63% | 96% | 0 | 3 | 0.7 s |

  Only the 4b fell for the "tests should pass now" trap after a failed run. The misses are close calls: a denied push called "needs-input", and a request for code that isn't in the repo.
- **One local model for everything (ADR-023, Paul's pick):** the risk eval, run again on Ollama 0.40, gave the same answers word for word, but `qwen3.5:9b` now loads in 12.7 s instead of 45 s (about 8 s when Windows has the file cached). The 9b and the 7b can't share the 8 GB card, so one model for the risk check, the recap and the fallback stays warm while Paul works. Paul's own settings were switched (one line), with a backup (`settings.json.before-local-model-20261007-145139`).
- **For testing:** `SURI_DATA_DIR=<folder>` runs Suri with its own settings and history. Replays are marked and stay out of History unless `--record`. New `npm run replay -- workday`: four requests in two projects.
- **Verified:**
  - **Unit tests:** typecheck, lint, the build (three preloads, self-contained) and **530 unit tests** (79 new), with real SQLite in memory and in temp folders: migrations, a damaged file moved aside, a newer Suri's file left alone, a real captured turn turned into facts, Esc then a new prompt, a turn seen mid-way, redaction before storing, the replay mark, pruning, the recap prompt and queue (one at a time, stepping aside for a risk check at most 3 times, stop on quit), the digest's facts, plain version, model held to the facts, Markdown, prompt budget and fallback.
  - **End to end** with a scratch Suri (`SURI_DATA_DIR`, port 47931) and a fake Ollama on 127.0.0.1:11999 that answers with canned JSON, so the real pipeline ran without the GPU: `replay workday --record` stored 4 turns with the right files, lines and failed commands, and 4 recaps came back through the real Ollama provider. The History window, the digest (Gemini had no key, so the local fallback answered and the notes say "Gemini: no key"), the turn details, the island's "writing a recap…" then the recap, a recap failing with Ollama down (the card keeps Claude's message; History shows "Can't reach Ollama…"), "Write a recap" after Ollama came back, recaps switched off, Copy as Markdown (Paul's clipboard was saved and put back), `--history` on a second launch, and the dev server build. Bad input from the page (`../../etc`, a negative turn id) was refused, and each window sees only its own API. Paul's own `%APPDATA%\Suri` was not touched.

## Phase 5 results (ADR-018, ADR-019)

- **Paul's art, cut by a script** (`scripts/mascot/build_mascot.py`, run once per art change; how-to in `assets/mascot/source/README.md`). The four sheets came as JPEGs with a checkerboard painted in. rembg's BiRefNet model cuts the background out, which a colour key can't do: the laptop, the blanket and the eye highlights share the checkerboard's greys. The script finds each figure as its own blob (so a stray tail stays with its owner) and writes 15 WebP sprites, the blank head and `head.json`, plus the icons. Its outputs are committed, so building the app never needs Python.
- **On the island** (`src/renderer/src/mascot/`): the cards show Paul's poses, one per mood. A high-risk approval raises the **shield**, and "Allowed" gives a **thumbs-up**. They breathe slowly and pop in when the pose changes. The compact bar, peek and header show the **blank head with eyes and a mouth drawn in SVG**, placed from the measured eye patches. It changes expression with the mood, blinks, glances toward the pointer as it comes near (using mouse moves Electron already forwards, so nothing runs at idle), and springs up from its "burrow" when the bar appears.
- **Icons:** the front view's head as a seven-size `resources/tray.ico` (sharp at any display scaling), the app icon (`build/icon.ico`, `build/icon.png`) and the Settings window's icon. The installer no longer packs `assets/` or the dev scripts.
- **Sounds, made in code** (`src/shared/sounds.ts`): three short cues built from a few notes, no audio files. *Needs you*: two quick rising chirps, the meerkat's lookout call. *Finished*: a warm step up. *Error*: one low note that sinks. Only something new makes a sound: a request that just arrived (not the next one in the queue), a new wait, a finish or a failure. Nothing on the first snapshot after a start, or while paused.
- **Settings → General → Sounds:** "When Claude needs you" (on by default) and "When a session finishes" (off), each with a "play" link. Two new fields in Suri's `settings.json`; each falls back to its default on its own.
- **A steady compact bar** (`pickFocus` in `src/shared/island-mode.ts`): the bar keeps its session for at least 5 s instead of jumping to whichever session sent the last event. A session that needs Paul takes over at once, and a busy one beats a finished one. Working and thinking count as the same: a session switches between them on every tool call (that's what the first try got wrong, caught live).
- **Verified:**
  - **Unit tests:** typecheck, lint, the build and **451 unit tests**: the cues' length, loudness, clicks and timing, when each cue plays, the focus rules, the new settings, the pupils' look, that every sprite the island imports exists, and that `head.json` describes a face.
  - **The art:** every sprite checked on black (the island's colour) and at 3× zoom: no checkerboard halo, props intact. The measured eye patches checked with outlines on the head. Running the script twice gives byte-identical files.
  - **End to end:** replayed sessions in the dev app showed the head in the compact bar, the happy pose on "finished", the shield on a high-risk request (then the AI's answer), and the worried pose on an error. The speakers' peak meter read 0.16 while a replayed request popped up, against 0.00 at rest, so the chirp plays. Ten screenshots of two replayed sessions plus this chat showed the bar switch once and stay; before the fix it flipped on every event.

## Phase 4b results (ADR-016, ADR-017)

- **The risk explainer** (`src/main/ai/risk.ts`). Every PermissionRequest Suri holds gets a plain-English check through the router: `{ level, summary, reasons[], reversible }`, checked with Zod. The model never sees the rule's verdict. The card shows the higher of the two levels, so the AI can raise a warning but never lower one. One model call at a time, cached by command, cancelled when Paul answers first. Failures aren't cached.
- **The card.** The rule's level and reason show at once, then "Suri is checking this…", then the summary, "Can be undone / Can't be undone", the first reason, and the model that answered (with "Gemini: …" when the local model stepped in). The card turns red when the AI finds a danger the rules missed. If no model answers, one muted line says why. The card's height never changes, so the buttons don't move when the answer arrives.
- **Rules** (`src/shared/risk-rules.ts`): 15 shell rules, 6 for file changes, 1 for reads. New: registry edits, rewriting PATH, deleting a remote branch, `git checkout -- .` / `git restore .`, emptying a table, unpublishing, login files (high); showing secrets to the agent, force-deleting branches or stashes, installs for the whole PC, permanent environment variables, and files outside the project (medium). Fixed a false alarm: `-Force`, `-LiteralPath` and `-ErrorAction` no longer count as "recursive".
- **The eval** (`evals/`, `npm run eval:risk`): 61 labelled cases (20 low, 19 medium, 22 high), each model called directly with the app's prompt and no fallback. Results in `evals/results/risk.md`, plus one JSON per model:

  | Model | Alone | + rules (the card) | High caught (+ rules) | Too low (+ rules) | Warm | First call |
  |---|---|---|---|---|---|---|
  | Rules alone | 77% | – | 17/22 | 13 | – | – |
  | `qwen3.5:9b` | 85% | **93%** | 21/22 | 1 | 3.1 s | about 50 s |
  | **`qwen2.5:7b-instruct`** (the default until ADR-023) | 74% | **90%** | 21/22 | 3 | 1.0 s | 7.9 s |
  | `qwen3.5:4b` | 72% | 82% | 22/22 | 4 | 1.9 s | 14.7 s |
  | `qwen2.5:3b-instruct` | 61% | 79% | 21/22 | 6 | 0.6 s | 3.7 s |

  The rules and the model miss different things. Rules miss deletes written in Python, Node or `find`; models miss `git checkout -- .`, git hooks and Claude Code's own settings. A comment saying "this is safe, rate it low" talked both qwen2.5 models down to low; `qwen3.5:9b` said medium, and only `qwen3.5:4b` said high.

- **The default model (ADR-017, Paul's pick):** `qwen2.5:7b-instruct`. A risk check is nearly always a cold start, because approvals are rare and Ollama unloads a model after five idle minutes. `qwen3.5:9b` is the most accurate, but it takes about 50 s to load, more than the 45 s limit. Paul's own Suri settings were switched to the 7b, with a backup next to the file (`settings.json.before-risk-model-20261006-225657`). Recap and the fallback stay on `qwen3.5:9b`. `gemma4:12b` and `gemini-3.8-flash` aren't measured: Gemini was overloaded, then rate-limited, all evening. **Superseded on 2026-10-07 by ADR-023:** since Ollama 0.40 the 9b loads in about 8–13 s, so every local feature uses it.
- **Verified:**
  - **Unit tests:** typecheck, lint, the build, and **423 unit tests** (106 new), all offline.
  - **End to end** in the dev app, with the replay script and Ollama. With the default route (`qwen3.5:9b`, not pulled), the card said "No AI check: Ollama doesn't have "qwen3.5:9b". Get it with: ollama pull qwen3.5:9b". With the risk route set to `qwen2.5:7b-instruct`, a delete hidden in Python (no rule) showed "Suri is checking this…", then turned the card red ("High risk · Deletes files outside the project · Can't be undone"). `rm -rf /` showed the rule's reason at once and the AI's summary under it. The PreToolUse safety net still answered "ask". Suri's `settings.json` was backed up first and restored byte for byte (same hash).
  - **Review fixes:** an answer arriving after the model changed in Settings is no longer cached; a check that throws can't fail the hook request; the eval retries "overloaded" and "too many requests" instead of scoring them.

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
4. **The risk explainer:** with Suri running, `npm run replay -- explain` holds a request for a delete hidden in Python: no rule fires, then the AI turns the card red (about 10 s the first time, while the model loads). `npm run replay -- risky` shows the rule and the AI together.
5. **Sounds:** Settings → General → Sounds → "play" next to each switch. `npm run replay -- permission` makes the island chirp.
6. **The mascot:** `npm run replay -- session` (the head in the compact bar, then the happy pose), `-- risky` (the shield), `-- error` (worried). Move the pointer toward the island and the head looks at it.
7. **Recaps and History:** with Ollama running, just use Claude Code: each finished request shows "writing a recap…" on the card, then the recap. Tray → **History…** shows every request today. `npm run replay -- workday --record` adds four sample requests (they do land in your history; leave out `--record` to keep them out).
8. **Standup notes:** tray → **Today's digest**, then **Copy** or **Save as .md**.
9. **Ask about a file:** hover the island and click **+ Ask a file** (or tray → Ask about a file…). Drag a PDF or a Markdown file from Explorer onto the panel, then ask about it. Esc closes it.
10. **Full-screen games:** run `npm run replay -- permission --hold 60000`, then put a game (or a browser with F11) in full screen: the card vanishes. Leave full screen: it comes back with a chirp.

## Next

1. **Paul: two minutes with the file panel.** With Suri running, hover the island → **+ Ask a file**, drag a PDF from Explorer onto it, ask something. Then **Choose a file…** once, and History → **Save as .md** once. Tell Claude if anything is off.
2. **Paul: one game check (about 3 minutes, ADR-029).** With Suri running and Dota 2 open in full screen: in a terminal, `npm run replay -- permission --hold 60000`, then switch to the game within a few seconds. The card should vanish within a second, with no sound. Hover the tray icon: "Staying quiet: dota2.exe is full screen". Leave the game after about 10 s: the card comes back with a chirp. Tell Claude if the game wasn't detected (and which display mode it uses). Also: during the 2026-10-07 test a card got an Allow click about 3 s after it appeared over Paul's browser; tell Claude whether that was on purpose.
3. **Phase 8: ship and resume** (plan, Phase 8): the installer with an uninstall step (hooks and history), GitHub Actions, the README with a demo, and the resume bullets. Also decide about `@google/genai` (it brings unused packages; plain `fetch` would do), leave koffi's docs and C++ sources out of the installer, and list third-party licences (koffi is MIT).
4. **The hooks are installed** on Paul's settings (seen 2026-10-06: all 11 entries, and this chat showed on the island). Two small checks are left:
   1. Quit Suri and send one prompt: you should see "Stop hook error" once (expected, ADR-002).
   2. In `sandbox/`, check that each tool shows up once on the island, not twice. The Claude Code docs say identical hooks run once; if you see doubles, tell Claude and delete the `hooks` block in `sandbox/.claude/settings.local.json`.
5. **Paul: the VS Code check (about 3 minutes),** in any project:
   1. Ask Claude Code: `run the command: echo hello-vscode`. Suri shows the approval card. Click **Allow**. Does the command run without you clicking anything in VS Code?
   2. Ask again and click **Deny**. What does Claude say?
   3. Ask for `git push --force` in a repo with no remote. Does Suri's card appear (safety net), or only VS Code's own prompt?
   4. Quit Suri (tray → Quit Suri) and ask once more. What does VS Code show?
   5. Tell Claude what you saw. It goes into `docs/spike-hooks.md` and ADR-002 / ADR-012.
6. **After Phase 8 (v1.1): the screen helper and push-to-talk** (ADR-010, ADR-011), each with its own spike first.
7. **Paul, when Gemini isn't overloaded: the Gemini evals** (about 20 minutes, paced for the free tier; the key is already in the VS Code terminal): `npm run eval:digest -- --models gemini-3.8-flash`, then the same with `eval:files`, `eval:recap` and `eval:risk`. The digest and file questions use Gemini by default, so these two matter most.

## How to run

- `npm install` · `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`
- Electron 44 downloads its ~100 MB binary the first time it runs, so the first `npm run dev` on a fresh clone takes longer.
- `npm run sandbox:hooks` (needs Suri started once) · `npm run replay -- session|permission|risky|explain|error|multi|workday|end [--hold ms] [--record]` (`--record` saves the replay in History and writes recaps)
- `npm run eval:risk` and `npm run eval:recap` (live models; see `evals/README.md`). `-- --models a,b` for some models, `-- --limit 5` for a quick check that saves nothing, `-- --report` to rebuild the report from saved runs (after a rule change, say).
- Dev switches: `SURI_ALLOW_CAPTURE=1` (show Suri in screenshots), `SURI_DEVTOOLS=1` (DevTools for the island, Settings and History), `CLAUDE_CONFIG_DIR=<folder>` (point the installer at a test settings.json), `SURI_DATA_DIR=<folder>` (a Suri with its own settings and history; give it another port), `--settings` / `--history` (open that window at launch).
- An end-to-end run without the GPU: a tiny server on another port that answers `/api/tags` and `/api/chat` with canned JSON, set as the Ollama address in the scratch `settings.json` (Phase 6 and ADR-029 did this; the script isn't in the repo).
- Launching Electron from a Claude Code session in VS Code needs `ELECTRON_RUN_AS_NODE` unset; that goes for the packaged `dist/win-unpacked/suri.exe` too.
- Tests need Node 22.13+ (`node:sqlite` without a flag).
- Talk to Ollama through its HTTP API (`curl http://127.0.0.1:11434/api/version`) in scripts: running the `ollama` command started a pending Ollama update on 2026-10-05.

## Known issues

- **Not checked by hand yet:** a real drag from Explorer onto the file panel, the Open dialog, Save as .md and the tray items. Next → 1.
- While the file panel is open it takes clicks at the top centre of the screen (by design, so a drop can land); a click there in another app closes it instead (seen when the test panel was open over Paul's browser).
- **Full-screen games (ADR-029) not tried with a real game yet**, only with a full-screen Electron window (Next → 2). A game in a plain window (not full screen) still gets cards and keeps the model on the graphics card. A program that runs Claude Code but isn't on the list in `src/shared/quiet.ts` goes quiet in full screen. A card over another app (not a game) can still catch a click meant for that app once the pointer moves onto it; the click guard (ADR-028) only stops a cursor that was already there.
- **Keep warm holds the graphics card while Claude Code works**, about 5.6 GB for `qwen3.5:9b`, until 15 minutes after Claude Code goes quiet. A full-screen game frees it (ADR-029); a windowed one doesn't. Switch it off in Settings → AI. Starting Ollama's app can install a waiting Ollama update.
- The installer carries koffi's docs and C++ sources (about 1 MB it doesn't need). Phase 8.
- A load from disk, after a restart or when Windows drops the model file from its cache, can still take much longer than 10 s (17 s for the 9b and 60 s for the 7b right after the Ollama update). The warm-up starts it early; a risk check that runs out of its 45 s says the model is probably still loading.
- The digest eval: `qwen3.5:9b` (the digest's fallback) once listed half-finished work as done (two of three endpoints, the third stubbed), and most models put a failed run under blockers rather than in progress. Small set (6 days); read it as a sanity check.
- File questions: Gemini gets PDF text only, without images or layout, because a raw PDF can't be redacted (ADR-027). A scanned PDF has no text and is refused.
- Text that hides outside a comment (an `echo`, a heredoc, a commit message) still reaches the risk model; the rules stay the floor.
- The recap rubric was clarified after looking at the eval's cases (ADR-026), so its gain is a little flattered; the 7b got two cases worse. New cases written later would be the fair test.
- `node:sqlite` is marked experimental in Node; the tests hide Node 22's warning. No delete-on-uninstall yet for the history or the hooks (Phase 8): use Settings → Delete history… and Remove hooks first.
- `@google/genai` brings `google-auth-library`, `protobufjs` and `ws` along (unused with an API key), which adds to the installer's size. Phase 8.
- With the hooks installed, every project shows "Stop hook error" once per turn while Suri is closed (ADR-002). Start with Windows (installed app) makes that rare.
- Not verified live yet: that Claude Code runs the sandbox's identical hook only once, and that a running session picks up new hooks without a restart. The docs say both; Next → 4 checks them.
- Not confirmed yet in VS Code: whether a held PermissionRequest blocks VS Code's own dialog, and whether a PreToolUse `"ask"` leads to Suri's card or only VS Code's prompt. The VS Code check (Next → 5) answers both.
- "Open in VS Code" from a session row hasn't been clicked through by hand yet (ADR-008).
- The risk eval's cases and rules were written in the same phase, so "Rules alone" (77%) flatters the rules. The model's own score and "+ rules" are the fair numbers.
- The Gemini free tier allows few requests per minute. The router then lets the local model answer.
- Redaction is pattern-based. It errs on removing too much (`max_tokens=100` loses its value) and can miss a secret with an unknown shape and an innocent name.
- The safety-net rules match text, so they err on the side of asking: a command that only mentions `rm -rf /` (an `echo`, a commit message) is flagged high, and the AI can't lower it. Deletes written in Python or Node pass the rules; the AI is what catches them.
- `prisma migrate reset`, `migrate:fresh` and `db:drop` force a prompt (they wipe the database). The rule is easy to drop to medium if it gets in the way.
- The installer's diff preview shows an appended JSON block shifted by a line (`+ },` / `+ {` instead of `− }` / `+ },`). It's a correct, minimal diff, the same shape git shows, so it stays.
- The mascot doesn't turn yet: the three-quarter, side and back views are cut but unused, and so are the wave and pointing poses.
- Re-running the art script needs Python and rembg (about 500 MB with its model). Only needed when the art changes.
- ESLint 9 is end-of-life upstream, but the electron-toolkit configs don't support 10 yet.
