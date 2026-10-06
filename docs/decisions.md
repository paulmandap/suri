# Architecture decisions

Never rewrite an old decision. Supersede it with a new ADR and say why.

## ADR-001 — Electron + React + TypeScript
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** Suri needs a transparent, always-on-top overlay on Windows, a local HTTP server, secret storage and calls to AI providers. Paul already works in React, TypeScript, Tailwind, Zustand, Zod and Vitest (learning_app, portfolio).

**Options.** Electron + React + TS · Tauri 2 + Rust (smaller app and Coucou's stack, but Rust is new to Paul and there's no official SDK for the AI APIs) · Python + PySide6 (overlay polish is harder, and PyInstaller builds often trip Defender).

**Decision.** Electron 44 + electron-vite 5 + React 19 + TypeScript 5.9, with Tailwind 4, Zustand, Zod 4, motion and Vitest 5.

**Consequences.** One language end to end; an installer around 100 MB. Electron must stay on a supported major: the electron-vite template pinned 39, so setup moved to 44. TypeScript stays on 5.9 until the ESLint configs support 7.

## ADR-002 — Claude Code integration through HTTP hooks
**Date:** 2026-10-04 · **Status:** Accepted for the CLI · VS Code interactive check pending

**Context.** Coucou relays hooks through a small exe and a named pipe, which avoids shell quoting and stays silent when the app is closed. Claude Code now supports `"type": "http"` hooks.

**Decision.** Claude Code POSTs every hook event to `http://127.0.0.1:<port>/hooks` in Suri (default port 47821), with a per-install bearer token in the hook's `headers`.

**Evidence** (`docs/spike-hooks.md`). Events arrive in at most 3.4 ms. Allow, deny, deny with a message, and "no answer" (Claude Code falls back to its own flow) all work. With Suri closed, Claude Code keeps working at full speed.

**Consequences.** No extra binary and no shell quoting. The cost: while Suri is closed, Claude Code shows "Stop hook error occurred · ctrl+o to see" once per turn. Accepted, because Suri normally runs from the tray. If it gets annoying, the fallback is Coucou's approach (a tiny relay exe that exits 0 silently), recorded as a new ADR.

## ADR-003 — Sessions start from the first event, not SessionStart
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** SessionStart only supports `command` and `mcp_tool` hooks, not HTTP (docs). It never arrived in the spike.

**Decision.** The installer doesn't register SessionStart. Suri opens a session the first time it sees a new `session_id` (usually on UserPromptSubmit or PreToolUse) and closes it on SessionEnd.

**Consequences.** A session appears with its first prompt rather than at launch. That's fine for the island.

## ADR-004 — AI runs on Ollama (local) and the Gemini API (free tier)
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** Paul wants the AI features to cost nothing. The local GPU is an RTX 3050 with 8 GB VRAM. Gemini's free tier covers several Flash models, but Google may use free-tier data to improve its products, and limits are per project.

**Decision.** One `AIProvider` interface with Ollama and Gemini (`@google/genai`) providers, routing per feature in config, and fallback to Ollama on rate limits or when offline. Defaults: risk check and recap on Ollama `qwen3.5:9b`; file Q&A and digest on Gemini `gemini-3.8-flash`. Secrets are redacted before any cloud call. No Claude API provider in v1, since it costs money and Paul's Pro plan doesn't cover API calls.

**Consequences.** Works offline and for free. The Phase 4 eval sets the final model defaults from measured numbers.

## ADR-005 — Hidden from screen capture by default
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** Paul doesn't want the overlay to show when sharing the screen.

**Decision.** `BrowserWindow.setContentProtection(true)` (Windows `WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004+), behind a Settings toggle that is on by default.

**Consequences.** Suri disappears from Zoom, Teams, Discord, OBS and screenshots, including Paul's own demo recordings. The toggle must be off when recording.

## ADR-006 — Dynamic Island motion inside a fixed window
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** Paul wants the same feel as the Coucou demo (the iPhone Dynamic Island). Resizing a transparent window flickers on Windows.

**Decision.** One fixed, transparent, always-on-top window. A single black shape inside it springs between pill, compact and expanded sizes using motion springs. Content fades in after the shape settles and out before it shrinks. Clicks pass through everywhere outside the shape.

**Consequences.** Smooth animation without native resizing. Click-through has to be toggled precisely (`setIgnoreMouseEvents` with `forward`).

## ADR-007 — Safety net: Suri can force a prompt for risky commands
**Date:** 2026-10-04 · **Status:** Accepted by Paul on 2026-10-04 ("yes, with cute animations like the video demo"). Interactive behaviour to test in Phase 2.

**Paul's addition.** The warning must feel like the Coucou demo: the island springs open with a warm amber glow, the meerkat jumps into its alert pose (standing tall, paw shading its eyes, a "!" bubble), and the card pops in with the command and Allow / Deny. Calm and cute, not a scary dialog.

**Delivery.** Phase 2 builds the approval card and its animations, plus a first small set of high-risk rules, so approvals actually show up on Paul's setup. Phase 4 expands the rules and adds the LLM explanation. Phase 5 swaps in the real meerkat art.

**Context.** Paul's global settings let Claude Code run Bash, PowerShell, Edit and Write without asking, so it almost never sends a PermissionRequest. Approvals and the risk explainer would rarely appear. In spike test F, a PreToolUse hook answering `permissionDecision: "ask"` stopped a globally allowed command.

**Proposal.** Suri's instant rules engine (Phase 4) answers PreToolUse with "ask" only for high-risk commands (rm -rf, force push, curl | sh …) and shows the reason. Everything else gets no decision. A Settings switch turns it off.

**Open question.** In VS Code, does that "ask" bring up Suri's approval card (a PermissionRequest), or only Claude Code's own dialog?

## ADR-008 — Open a session's folder through `vscode://`, not by running `code`
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** Clicking a session should open its project in VS Code. The folder path comes from a hook payload. Running `code <path>` on Windows means spawning `code.cmd`, which Node only allows through a shell, and a crafted folder name could then inject commands.

**Decision.** Main opens `vscode://file/<path>` with `shell.openExternal`, after checking the path is absolute and an existing directory. Each path segment is URL-encoded. If no VS Code handler is registered, it falls back to Explorer (`shell.openPath`). The renderer only ever sends a session id; main looks up the folder itself.

**Consequences.** No shell ever sees the path. Opening a folder (rather than a file) through the URL still needs a manual check by clicking a session row.

## ADR-009 — A sandboxed renderer with a five-call API
**Date:** 2026-10-04 · **Status:** Accepted

**Context.** The island renders data that comes from hook payloads (prompts, commands, file names). If that page could reach Node, a rendering bug could become code execution.

**Decision.** The overlay runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, under a strict CSP, and it refuses navigation and new windows. The preload imports only `electron` (electron-vite leaves npm packages external, and a sandboxed preload can't load them) and exposes `window.suri` with five calls: `onSnapshot`, `onOpenIsland`, `rendererReady`, `setInteractive`, `openSession`. Main checks that every IPC message comes from the overlay and has the right type.

**Consequences.** All logic that needs Node stays in main. The renderer is a pure view of `IslandSnapshot` plus its own hover state. Decision logic lives in `src/shared/` as pure functions (`reduceSessions`, `deriveIslandView`) that the tests cover without Electron.

## ADR-010 — Screen helper: Suri offers help when Paul looks stuck
**Date:** 2026-10-04 · **Status:** Proposed by Paul. To confirm, then schedule after Phase 7 (it needs the AI layer from Phase 4 and the chat answers from Phase 7).

**Context.** Paul wants Suri to keep an eye on the screen, notice when he's stuck (an error that won't go away, failing builds), and offer help or a suggestion. Code in an answer should have a Copy button, like Claude's.

**Proposal.**
- **Opt-in and visible.** Off by default. While on, the island shows a small "watching" mark. It pauses on lock, idle, or when Suri is paused. Screenshots are never written to disk.
- **Cheap first, smart second.** Every ~10 s Suri reads the focused window's text with local OCR (the engine is chosen in this phase's spike) and adds its own Claude Code signals: failed tools, StopFailure, the same command failing again, idle time. Only when that looks like being stuck (an error still on screen after ~90 s, repeated failures) does the local model (`qwen3.5:9b`, which has vision) write a short suggestion. That keeps the GPU free almost all the time.
- **Local only by default.** Screen content never goes to a cloud model on its own. "Ask Gemini" is a separate click that first shows exactly what will be sent, after redaction.
- **Polite.** At most one offer every few minutes. Snooze, "not now", and a per-app "never watch" list (password managers, banking).
- **Answers** render Markdown, with a Copy button on each code block. Copying goes through main's `clipboard`, because the island never takes focus.

**Why it's a good resume piece.** Context-aware help with local vision and OCR, privacy by design, measured with an eval of "stuck" screens.

## ADR-011 — Push-to-talk: hold a shortcut, speak, Suri understands
**Date:** 2026-10-04 · **Status:** Proposed by Paul. To confirm, then schedule with the screen helper (ADR-010).

**Context.** Paul wants to hold Alt + Windows key, say a request, and have Suri act on it right away.

**Proposal.**
- **The shortcut.** Electron's `globalShortcut` can't register modifier-only combos, so detecting Alt + Win needs a low-level keyboard hook (for example `uiohook-napi`). Windows may also open the Start menu when Win is released. A spike decides; if Alt + Win misbehaves, the default becomes a regular combo (for example Ctrl + Alt + Space). The shortcut is configurable either way.
- **Hold to talk.** The mic is open only while the keys are held. The island shows a listening state (the meerkat's ears perk up) and a live level meter. Audio is never written to disk.
- **Local speech-to-text.** Whisper running locally on the RTX 3050 (whisper.cpp bindings, or the faster-whisper models already on this PC), so a short request is text in about a second, offline and for free.
- **Then the AI layer.** The text goes to the same router as everything else: questions, "what is Claude doing?", "summarise today", "explain the error on my screen".
- **Safety.** Voice never approves a high-risk command, because a misheard word must not run `rm -rf`. Voice approvals, if added at all, are limited to low-risk requests and need a clear confirmation.

## ADR-012 — Approvals: Suri holds the PermissionRequest until a click
**Date:** 2026-10-04 · **Status:** Accepted (VS Code interactive behaviour still to confirm with Paul's check)

**Context.** Phase 2 answers Claude Code's permission requests from the island. The spike showed that Claude Code waits for the PermissionRequest hook's answer before it falls back to its own prompt.

**Decision.**
- Suri keeps the HTTP request open and shows the approval card (oldest first, with a "+N waiting" count).
- **Allow** answers `{"behavior":"allow"}`. **Deny** answers `{"behavior":"deny","message":"Denied from Suri."}`.
- **Ask in Claude Code**, a 110 s timeout (the hook's own is 120 s), Claude Code closing the request, Pause, or Quit all answer empty, so Claude Code asks for itself. Nothing is ever left hanging.
- Only a click answers. No keyboard shortcut or voice approvals (ADR-011).
- An answer clears the session's wait at once (`markPermissionAnswered`), so the "answer in Claude Code" card never flashes.
- The safety net (ADR-007) answers PreToolUse with `"ask"` for the high-risk rules in `src/shared/risk-rules.ts` (8 shell rules and 3 file rules, plus 2 medium ones shown on the card). It can be switched off from the tray.

**Consequences.** One-click approvals without leaving the editor. While Suri holds a request, Claude Code's own prompt only appears once Suri steps aside, which is why "Ask in Claude Code" and the countdown are on the card.

## ADR-013 — The hook installer: how Suri edits Claude Code's settings.json
**Date:** 2026-10-05 · **Status:** Accepted

**Context.** Phase 3 moves Suri from the sandbox project to every project, which means editing Claude Code's user settings. That file also holds Paul's permissions, model and other tools' hooks, so a bad write would break every Claude Code session. Plan decision 4 and CLAUDE.md list the rules; Coucou's installer (MIT) supplied the test cases.

**Decision.**
- **Which file:** `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set (Claude Code moves its config there too).
- **What goes in:** one matcher group per subscribed event (11), added after any existing groups, with `matcher: "*"` on tool events. Each is the same handler the sandbox uses (URL, `Authorization` header, timeout 10 s; PermissionRequest 120 s; SessionEnd 2 s). The Claude Code docs say an identical handler in two settings files runs once, so the sandbox shouldn't get events twice.
- **Finding Suri's entries:** by shape, with no marker field (Claude Code validates its settings, so an unknown key is an avoidable risk). A Suri hook is an `http` hook to `127.0.0.1` or `localhost`, path `/hooks`, any port, with `Bearer` and 64 hex characters. Any port and token count, so an old install is replaced and never doubled. Lookalikes (another path, host or scheme, or a different token shape) are left alone, and the preview shows any removal before it happens.
- **Merging (Coucou's rules):** a BOM is fine and an empty file means `{}`. Invalid JSON or a non-object is refused, because not knowing what's in the file is not the same as it being empty. Suri's hooks come out wherever they are, even from a group shared with another tool. Event lists and the `hooks` block are dropped only when removing Suri's hooks emptied them. A `hooks` block or event list with the wrong type is refused.
- **Formatting:** key order, indent, CRLF or LF, the BOM and the whitespace around the JSON all stay as they were. The diff then shows only real changes, and install followed by uninstall gives back the exact original bytes.
- **Writing safely:** the preview's diff masks Suri's token and any value whose key looks like a secret (the renderer never sees secrets). A sha256 fingerprint of the previewed bytes must still match at write time. A dated backup of those exact bytes goes next to the file (`settings.json.suri-backup-YYYYMMDD-HHMMSS`, created exclusively, `-2` on a same-second clash). The write is a temp file, fsync, then rename, retried briefly when Windows says the file is busy. A symlinked settings.json is written through. Only the newest preview can be applied, only once, and only if Suri's port and token haven't changed since.
- **The click:** the Settings preload refuses `applyHooks` unless `navigator.userActivation.isActive` (a real click or key press). Main also checks the sender and the preview id.
- **Status:** installed, not installed, needs an update (with the reason), or unreadable, plus warnings for `disableAllHooks` and for an `allowedHttpHookUrls` that wouldn't allow Suri. A folder watcher keeps it current.

**Consequences.** Install and uninstall are safe to click and easy to undo. Backups pile up next to settings.json (small, and never deleted by Suri). JSON details that a parse can't keep (`1.0`, `\u` escapes, duplicate keys) are rewritten, and a file that isn't pretty-printed gets pretty-printed; both show in the diff. Uninstalling the Suri app doesn't remove the hooks yet (Phase 8). While Suri is closed, every project now shows "Stop hook error" once per turn (ADR-002).

## ADR-014 — The Settings window: a second sandboxed window with its own preload
**Date:** 2026-10-05 · **Status:** Accepted

**Context.** Phase 3 adds a Settings window (Claude Code hooks, General, and an AI placeholder for Phase 4). It can change Claude Code's settings, so it needs the island's lockdown, and the island must not gain these powers.

**Decision.**
- An ordinary window that can take focus, with a dark title bar drawn by the page (`titleBarStyle: 'hidden'` + `titleBarOverlay`). Sandbox, context isolation, no Node, a strict CSP, and navigation and new windows refused.
- Its own preload (`src/preload/settings.ts`) exposes `window.suriSettings` with six calls; the island keeps its own `window.suri`. Main checks the sender of every message and validates every payload with Zod (`src/shared/settings-schemas.ts`). The page never sends a path: "Show in Explorer" names a target and main looks up the path.
- Two preload entries in the build. A sandboxed preload can't load a shared chunk, so the two share no runtime code, and `scripts/check-preloads.mjs` fails `npm run build` if a preload requires anything but `electron`. electron-vite's `isolatedEntries` option would do this too, but 5.0.0 crashes outside an interactive terminal (`process.stdout.clearLine`), which would break CI.
- One Settings window at a time. `suri --settings` opens it, also as a second launch (for shortcuts and tests).
- Changing the port starts the new hook server before stopping the old one, so a taken port never leaves Suri deaf. Held approvals step aside, and the installed hooks then show "needs an update".
- "Start with Windows" only works in the installed app; a dev build would register electron.exe itself.

**Consequences.** Least privilege per window. The two renderer pages share one JS chunk (React and motion).

## ADR-015 — The AI layer: one interface, local first, redaction at the door
**Date:** 2026-10-05 · **Status:** Accepted

**Context.** Phase 4 builds the AI layer that the risk explainer (4b), recaps and the digest (Phase 6) and file questions (Phase 7) will use. ADR-004 chose Ollama and Gemini; this records how they are wired.

**Decision.**
- **One interface.** `AIProvider` (`src/main/ai/provider.ts`) has `generateJSON` (the reply must match a Zod schema, sent to the model as JSON Schema), `streamText`, `listModels` and `test`. Every failure becomes an `AIError` with one kind: offline, rate-limit, auth, no-key, not-found, timeout, aborted, bad-output, unavailable or other.
- **Ollama** is called over its HTTP API with plain `fetch`: `think: false` (fast, and accepted by models that can't think), temperature 0, the schema in `format`. Its address must be on this PC (a loopback URL), because "local" is the privacy promise and redaction only guards the cloud path.
- **Gemini** uses the official `@google/genai` SDK (2.27), with `responseJsonSchema` for structured output. SDK retries stay off, so a 429 comes back at once and the router can fall back. The host and API are pinned in code (`generativelanguage.googleapis.com`, `vertexai: false`): otherwise `GOOGLE_GEMINI_BASE_URL` or `GOOGLE_GENAI_USE_VERTEXAI` in the environment could send the key and prompts somewhere else. With an API key the SDK never starts Google's cloud auth library, so no other Google service is contacted.
- **A router picks the model per feature** from Settings. A Gemini route has the local fallback model behind it, and any Gemini failure except a cancel falls back to it. A local route never falls back to the cloud. A stream doesn't fall back once text has been shown.
- **Redaction lives in the router,** right before a cloud call, so no feature can forget it. It removes Suri's hook token and the Gemini key by exact value, plus pattern-matched secrets: private keys, passwords in URLs, the whole credential after `Authorization:` (any scheme, any case), well-known token shapes (including Google's newer `AQ.` keys), and secret-named values in JSON (strings and numbers), .env and YAML. It errs on the side of removing too much, and a second pass finds nothing new.
- **The Gemini key** is kept with Electron `safeStorage` (Windows DPAPI) in `%APPDATA%\Suri\secrets.json`, as base64 of the encrypted bytes, written atomically. Without encryption it isn't saved at all. The Settings page can save or remove the key and see whether one is saved; main never sends it back.
- **Defaults** follow ADR-004: risk and recap on `qwen3.5:9b`, file questions and the digest on `gemini-3.8-flash` (free on the free tier, checked 2026-10-05), with `qwen3.5:9b` as the fallback. The Phase 4 eval sets the final defaults.
- Model names are checked before use. Gemini ids may only hold lowercase letters, digits, dots and dashes, because they end up in a URL path.

**Consequences.** Features ask for "risk" or "recap", not for a model, so models can change without touching them. Unit tests use fake providers and fake servers on 127.0.0.1; live models only run in `evals/`. On the free tier Google may use what Suri sends, which Settings says next to the key. If the default local model isn't pulled yet, Settings shows the `ollama pull` command.
