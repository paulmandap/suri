import { useState } from 'react'
import type { GeneralView } from '@shared/settings-ipc'
import type { SoundCue } from '@shared/sounds'
import type { HookServerStatus, HookState } from '@shared/types'
import { playCue } from '../lib/sound'
import { Button, Card, Notice, Section, ToggleRow } from './ui'

interface Props {
  general: GeneralView
  server: HookServerStatus
  hooks: HookState
  onShowHooks: () => void
}

export function GeneralPane({ general, server, hooks, onShowHooks }: Props): React.JSX.Element {
  const [port, setPort] = useState(String(general.port))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const value = Number(port)
  const valid = /^\d{4,5}$/.test(port) && value >= 1024 && value <= 65535
  // Same port after a failed start (it was taken): offer to try it again.
  const retry = server.state === 'error' && value === general.port
  const canSave = valid && !saving && (value !== general.port || retry)

  const savePort = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await window.suriSettings.updateGeneral({ port: value })
    setSaving(false)
    if (!result.ok) setError(result.message)
  }

  return (
    <div>
      <Section title="Hook server">
        <Card>
          <label htmlFor="port" className="text-[13.5px] text-zinc-100">
            Port
          </label>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
            Claude Code sends its events to this port on 127.0.0.1. Change it only if another app
            uses it.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              id="port"
              type="text"
              inputMode="numeric"
              value={port}
              aria-invalid={!valid}
              onChange={(event) => setPort(event.target.value.trim())}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSave) void savePort()
              }}
              className="w-28 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[13px] text-zinc-100 outline-none focus:border-teal-300/60 aria-[invalid=true]:border-red-400/60"
            />
            <Button tone="primary" disabled={!canSave} onClick={() => void savePort()}>
              {retry ? 'Try again' : 'Use this port'}
            </Button>
          </div>
          {!valid && (
            <p className="mt-2 text-[12px] text-red-300">Pick a number from 1024 to 65535.</p>
          )}
          <ServerLine server={server} />
          {error && (
            <div className="mt-3">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          {hooks === 'outdated' && (
            <div className="mt-3">
              <Notice tone="warn">
                Claude Code&apos;s hooks still point at the old port.{' '}
                <button
                  type="button"
                  onClick={onShowHooks}
                  className="underline underline-offset-2 hover:text-white"
                >
                  Update them
                </button>
              </Notice>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Behaviour">
        <Card>
          <div className="divide-y divide-white/[0.06]">
            <ToggleRow
              label="Start with Windows"
              hint={
                general.canOpenAtLogin
                  ? 'Suri starts in the tray when you sign in.'
                  : 'Only in the installed app (a dev build would register Electron itself).'
              }
              checked={general.openAtLogin}
              disabled={!general.canOpenAtLogin}
              onChange={(openAtLogin) => void window.suriSettings.updateGeneral({ openAtLogin })}
            />
            <ToggleRow
              label="Hide from screen sharing"
              hint="Zoom, Teams, Discord, OBS and screenshots don't see the island. Turn it off to record a demo."
              checked={general.hideFromCapture}
              onChange={(hideFromCapture) =>
                void window.suriSettings.updateGeneral({ hideFromCapture })
              }
            />
            <ToggleRow
              label="Safety net"
              hint="Asks before high-risk commands like rm -rf, a force push or curl | sh, even when Claude Code would run them straight away."
              checked={general.safetyNet}
              onChange={(safetyNet) => void window.suriSettings.updateGeneral({ safetyNet })}
            />
          </div>
        </Card>
      </Section>

      <Section title="Sounds">
        <Card>
          <div className="divide-y divide-white/[0.06]">
            <ToggleRow
              label="When Claude needs you"
              hint={
                <>
                  A short chirp when a request waits for Allow or Deny. <Play cue="needs-you" />
                </>
              }
              checked={general.soundNeedsYou}
              onChange={(soundNeedsYou) =>
                void window.suriSettings.updateGeneral({ soundNeedsYou })
              }
            />
            <ToggleRow
              label="When a session finishes"
              hint={
                <>
                  A soft step up when Claude is done (<Play cue="finished" />
                  ), a low note when it stops with an error (<Play cue="error" />
                  ).
                </>
              }
              checked={general.soundFinished}
              onChange={(soundFinished) =>
                void window.suriSettings.updateGeneral({ soundFinished })
              }
            />
          </div>
        </Card>
      </Section>
    </div>
  )
}

function Play({ cue }: { cue: SoundCue }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => playCue(cue)}
      className="text-zinc-400 underline underline-offset-2 outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-teal-300/70"
    >
      play
    </button>
  )
}

function ServerLine({ server }: { server: HookServerStatus }): React.JSX.Element {
  const [dot, text] =
    server.state === 'listening'
      ? ['bg-emerald-400', `Listening on 127.0.0.1:${server.port}`]
      : server.state === 'starting'
        ? ['bg-zinc-500', 'Starting…']
        : ['bg-red-400', server.message]
  return (
    <div className="mt-3 flex items-center gap-2 text-[12px] text-zinc-400">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className={server.state === 'error' ? 'text-red-300' : undefined}>{text}</span>
    </div>
  )
}
