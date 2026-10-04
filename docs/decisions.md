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
**Date:** 2026-10-04 · **Status:** Proposed (Paul to decide; interactive behaviour to test in Phase 2)

**Context.** Paul's global settings let Claude Code run Bash, PowerShell, Edit and Write without asking, so it almost never sends a PermissionRequest. Approvals and the risk explainer would rarely appear. In spike test F, a PreToolUse hook answering `permissionDecision: "ask"` stopped a globally allowed command.

**Proposal.** Suri's instant rules engine (Phase 4) answers PreToolUse with "ask" only for high-risk commands (rm -rf, force push, curl | sh …) and shows the reason. Everything else gets no decision. A Settings switch turns it off.

**Open question.** In VS Code, does that "ask" bring up Suri's approval card (a PermissionRequest), or only Claude Code's own dialog?
