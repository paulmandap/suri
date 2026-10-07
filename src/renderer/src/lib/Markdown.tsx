import { useState } from 'react'
import { parseMarkdown, type Inline } from '@shared/markdown'

/** An answer, from parsed Markdown to React elements: never HTML (ADR-027). */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="space-y-2 text-[12.5px] leading-relaxed text-white/85">
      {parseMarkdown(text).map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <p key={i} className="font-semibold text-white">
                <Inlines items={block.inline} />
              </p>
            )
          case 'paragraph':
            return (
              <p key={i}>
                <Inlines items={block.inline} />
              </p>
            )
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List
                key={i}
                className={`space-y-0.5 pl-5 marker:text-white/35 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inlines items={item} />
                  </li>
                ))}
              </List>
            )
          }
          case 'code':
            return <CodeBlock key={i} code={block.text} lang={block.lang} />
        }
      })}
    </div>
  )
}

function Inlines({ items }: { items: Inline[] }): React.JSX.Element {
  return (
    <>
      {items.map((item, i) =>
        item.kind === 'code' ? (
          <code key={i} className="rounded bg-white/10 px-1 py-px font-mono text-[11.5px]">
            {item.text}
          </code>
        ) : item.kind === 'bold' ? (
          <strong key={i} className="font-semibold text-white">
            {item.text}
          </strong>
        ) : (
          <span key={i}>{item.text}</span>
        )
      )}
    </>
  )
}

function CodeBlock({ code, lang }: { code: string; lang: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    if (await window.suri.copyText(code)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-2.5 py-1">
        <span className="font-mono text-[10.5px] text-white/40">{lang || 'code'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded px-1.5 text-[10.5px] text-white/55 hover:bg-white/10 hover:text-white"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11.5px] leading-snug text-white/85">
        <code>{code}</code>
      </pre>
    </div>
  )
}
