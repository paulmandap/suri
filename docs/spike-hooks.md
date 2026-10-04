# Phase 0 spike: Claude Code HTTP hooks

**Date:** 2026-10-04 · **Claude Code:** 2.1.284 (the binary bundled with the VS Code extension), run headless with `-p` on Claude Haiku 4.5 · **Code:** `spike/hook-logger.mjs`

Question: can Suri talk to Claude Code through official `"type": "http"` hooks, with no relay program in between? Every answer below was observed, not taken from docs. Raw logs live in `spike/logs/` (gitignored); scrubbed payloads are committed in `tests/fixtures/hooks/`.

## Setup

- A throwaway project, `sandbox/` (gitignored, its own git repo), whose `.claude/settings.local.json` sends every hook to `http://127.0.0.1:47821/hooks` with `Authorization: Bearer spike-token`. Paul's global `~/.claude/settings.json` was never touched.
- The spike server logs each payload and answers `PermissionRequest` with allow, deny, or nothing.
- The child Claude Code ran with this session's environment removed (session id, VS Code messaging pipe, effort), so it was a separate session.

## Results

| # | Test | Result |
|---|---|---|
| A | Read, Edit and Bash with hooks on | Every event arrived with the bearer header. No `PermissionRequest`, because Paul's global settings allow Bash, PowerShell, Edit and Write without asking. |
| B | Sandbox `ask` rule for Bash and Edit; spike answers **allow** | `PermissionRequest` arrived for Edit and Bash; the tools ran. |
| C | Spike answers **deny** | Claude got the tool result `Permission denied by hook` (`is_error: true`) and told the user it was blocked. |
| D | Spike answers **nothing** (empty 200) | Claude Code fell back to its normal permission flow. In headless mode that means "Claude requested permissions to use Bash, but you haven't granted it yet." |
| D3 | Deny with `"message": "Denied from Suri (spike test)"` | Claude received exactly that text as the tool result and repeated it to the user. |
| E | Spike **not running** (Suri closed) | Claude Code worked normally with no slowdown (connection refused is instant). Visible cost: a system notice `Stop hook error occurred · ctrl+o to see`, plus `SessionEnd hook [...] failed: connect ECONNREFUSED` on stderr in headless mode. Other failed hooks stayed silent. |
| F | Bash and PowerShell allowed globally; `PreToolUse` answers `permissionDecision: "ask"` when the input contains "danger-zone" | The flagged command did not run. Headless Claude got the reason text `Suri flagged this command as risky` as the tool result. No `PermissionRequest` followed in headless mode. |

**Latency:** across 40 requests the server took a median of 0.4 ms and at most 3.4 ms per request.

**Headers Claude Code sends:** `Host: 127.0.0.1:47821`, no `Origin`, `User-Agent: axios/1.15.2`, `Content-Type: application/json`, plus our `Authorization` header. The planned checks (token, exact Host, reject any Origin) are compatible.

## Payload facts (from real payloads; some docs summaries were wrong)

- Common fields: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`.
- `PostToolUse` puts the result in **`tool_response`** (not `tool_output`) and adds `duration_ms`.
- An Edit's `tool_response.structuredPatch[].lines` is a ready-made unified diff, so +N −M is a simple count.
- Bash results: `tool_response.stdout`, `stderr`, `interrupted`.
- `PermissionRequest` has `tool_name` and `tool_input` but **no `tool_use_id`**. Match it to its `PreToolUse` by session + tool + input.
- `Stop` has `last_assistant_message` and `stop_hook_active`.
- `SessionEnd` has **`reason`** (not `session_end_reason`).
- **`SessionStart` does not support HTTP hooks** (docs: only `command` and `mcp_tool`), and it never arrived. Suri creates a session on the first event that carries a new `session_id`.
- On Windows Claude Code also has a **`PowerShell`** tool. In test D2 the model used PowerShell to get around an ask rule that only covered Bash. Risk rules must treat Bash and PowerShell commands alike.

## Still open (needs Paul, about 3 minutes)

The interactive **VS Code extension** path wasn't tested yet, because it needs a person at the keyboard:

1. Does a `PermissionRequest` answered by Suri dismiss the VS Code permission dialog (or keep it from showing)?
2. After a `PreToolUse` "ask", does VS Code show its own prompt, and does a `PermissionRequest` follow that Suri could answer?
3. What does the VS Code chat show while Suri is closed?

Steps are in PROJECT_STATE.md under "Next".
