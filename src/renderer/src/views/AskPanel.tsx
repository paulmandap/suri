import { useEffect, useRef, useState } from 'react'
import { MAX_FILE_BYTES, MAX_QUESTION_CHARS, type DocumentInfo } from '@shared/file-qa'
import { Markdown } from '../lib/Markdown'
import { only } from '../lib/only'
import { MascotHead } from '../mascot/Mascot'
import { useIsland, type AskMessage } from '../store'

/** Drop a file, ask a question (plan, Phase 7; ADR-027). */
export function AskPanel(): React.JSX.Element {
  const ask = useIsland((s) => s.ask)
  const closeAsk = useIsland((s) => s.closeAsk)
  const setAsk = useIsland((s) => s.setAsk)
  return (
    <div className="flex h-full flex-col px-4 pb-3 pt-3" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 pb-2">
        <MascotHead
          mood={ask.messages.some((m) => m.state === 'streaming') ? 'working' : 'idle'}
          size={22}
        />
        <span className="text-[13px] font-semibold">Ask about a file</span>
        {ask.doc && <RouteNote doc={ask.doc} />}
        <button
          type="button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={only(closeAsk)}
          className="ml-auto rounded-full px-2 py-0.5 text-[13px] text-white/50 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
      {ask.doc ? (
        <Chat doc={ask.doc} onChangeFile={() => setAsk({ doc: null, messages: [], error: null })} />
      ) : (
        <DropZone />
      )}
    </div>
  )
}

function RouteNote({ doc }: { doc: DocumentInfo }): React.JSX.Element {
  const cloud = doc.route.provider === 'gemini'
  return (
    <span
      className="truncate text-[11px] text-white/40"
      title={
        cloud
          ? 'On the free tier, Google may use what is sent. Suri takes secrets out first.'
          : 'Runs on this PC: the file never leaves it.'
      }
    >
      · {doc.route.model}
      {cloud ? ' (Gemini, secrets taken out)' : ' on this PC'}
    </span>
  )
}

function DropZone(): React.JSX.Element {
  const ask = useIsland((s) => s.ask)
  const setAsk = useIsland((s) => s.setAsk)
  const [over, setOver] = useState(false)

  const load = async (file: File): Promise<void> => {
    if (file.size > MAX_FILE_BYTES) {
      setAsk({ error: 'Suri reads files up to 20 MB.' })
      return
    }
    setAsk({ loading: file.name, error: null })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await window.suri.loadFile(file.name, bytes)
    setAsk(
      result.ok
        ? { doc: result.doc, loading: null, messages: [] }
        : { loading: null, error: result.message }
    )
  }

  const choose = async (): Promise<void> => {
    setAsk({ loading: '…', error: null })
    const result = await window.suri.chooseFile()
    if (result.ok) setAsk({ doc: result.doc, loading: null, messages: [] })
    // An empty message: the dialog was cancelled.
    else setAsk({ loading: null, error: result.message || null })
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void load(file)
      }}
      className={`flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed text-center transition-colors ${
        over ? 'border-teal-300/70 bg-teal-300/[0.07]' : 'border-white/15 bg-white/[0.02]'
      }`}
    >
      {ask.loading ? (
        <p className="text-[13px] text-white/70">
          Reading {ask.loading === '…' ? 'the file' : ask.loading}…
        </p>
      ) : (
        <>
          <p className="text-[13.5px] text-white/85">Drop a file here</p>
          <p className="mt-1 text-[11.5px] text-white/45">
            A PDF, Markdown, notes or code, up to 20 MB
          </p>
          <button
            type="button"
            onClick={only(() => void choose())}
            className="mt-4 rounded-full bg-white px-4 py-1.5 text-[12px] font-medium text-black hover:bg-white/90"
          >
            Choose a file…
          </button>
        </>
      )}
      {ask.error && <p className="mt-3 max-w-[85%] text-[11.5px] text-red-300">{ask.error}</p>}
    </div>
  )
}

function Chat({
  doc,
  onChangeFile
}: {
  doc: DocumentInfo
  onChangeFile: () => void
}): React.JSX.Element {
  const ask = useIsland((s) => s.ask)
  const setAsk = useIsland((s) => s.setAsk)
  const addQuestion = useIsland((s) => s.addQuestion)
  const stopAnswer = useIsland((s) => s.stopAnswer)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const streaming = ask.messages.find((m) => m.state === 'streaming')

  // A new file: ready to type.
  useEffect(() => input.current?.focus(), [doc])
  // Follow the answer as it grows.
  const last = ask.messages[ask.messages.length - 1]
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [last?.answer, ask.messages.length])

  const send = async (): Promise<void> => {
    const question = draft.trim()
    if (!question || streaming) return
    const started = await window.suri.ask(question)
    if (!started.ok) {
      setAsk({ error: started.message })
      return
    }
    addQuestion(started.id, question)
    setDraft('')
  }

  const stop = (): void => {
    if (!streaming) return
    window.suri.cancelAsk(streaming.id)
    stopAnswer(streaming.id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 rounded-xl bg-white/[0.06] px-3 py-1.5 text-[11.5px]">
        <span className="truncate font-medium text-white/90">{doc.name}</span>
        <span className="shrink-0 text-white/40">
          {doc.kind === 'pdf' ? `${doc.pages} ${doc.pages === 1 ? 'page' : 'pages'}` : 'text'} ·{' '}
          {sizeLabel(doc.chars)}
          {doc.truncated ? ' (start only)' : ''}
        </span>
        <button
          type="button"
          onClick={only(onChangeFile)}
          className="ml-auto shrink-0 text-white/45 underline-offset-2 hover:text-white hover:underline"
        >
          Change file
        </button>
      </div>

      <div ref={list} className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 select-text">
        {ask.messages.length === 0 && (
          <p className="pt-6 text-center text-[12px] text-white/40">
            Ask anything about this file. Answers come from the file only.
          </p>
        )}
        {ask.messages.map((m) => (
          <Exchange key={m.id} message={m} />
        ))}
      </div>

      {ask.error && <p className="mt-1.5 text-[11.5px] text-red-300">{ask.error}</p>}
      <div className="mt-2 flex items-end gap-2">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          maxLength={MAX_QUESTION_CHARS}
          placeholder="Ask a question…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          className="max-h-20 min-h-[34px] flex-1 resize-none rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-[12.5px] text-white outline-none placeholder:text-white/35 focus:border-teal-300/50"
        />
        {streaming ? (
          <button
            type="button"
            onClick={only(stop)}
            className="shrink-0 rounded-full bg-white/10 px-3.5 py-2 text-[12px] hover:bg-white/15"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={!draft.trim()}
            onClick={only(() => void send())}
            className="shrink-0 rounded-full bg-white px-3.5 py-2 text-[12px] font-medium text-black hover:bg-white/90 disabled:bg-white/30"
          >
            Ask
          </button>
        )}
      </div>
    </div>
  )
}

function Exchange({ message }: { message: AskMessage }): React.JSX.Element {
  return (
    <div>
      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-teal-300/15 px-3 py-1.5 text-[12.5px] text-white/90">
        {message.question}
      </div>
      <div className="mt-1.5">
        {message.answer ? (
          <Markdown text={message.answer} />
        ) : message.state === 'streaming' ? (
          <p className="text-[12px] text-white/45">Reading the file…</p>
        ) : null}
        {message.state === 'error' && (
          <p className="mt-1 text-[11.5px] text-red-300">{message.error}</p>
        )}
        {message.state === 'stopped' && <p className="mt-1 text-[11px] text-white/40">Stopped.</p>}
        {message.state === 'done' && (
          <p className="mt-1 text-[10.5px] text-white/35">
            {message.model}
            {message.fellBackFrom ? ` (Gemini: ${message.fellBackFrom})` : ''}
            {message.partial ? ' · from the parts of the file that match the question' : ''}
          </p>
        )}
      </div>
    </div>
  )
}

function sizeLabel(chars: number): string {
  if (chars < 1000) return `${chars} characters`
  return `${Math.round(chars / 1000)}k characters`
}
