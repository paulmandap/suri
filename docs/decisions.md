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
