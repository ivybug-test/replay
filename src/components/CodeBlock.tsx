import { useMemo } from 'react'
import clsx from 'clsx'
import { highlight, langFor } from '../lib/highlight'

/** Syntax-highlighted code with optional line numbers. */
export default function CodeBlock({
  content,
  language,
  path,
  lineNumbers = true,
  wrapLongLines = false,
  className,
}: {
  content: string
  language?: string
  path?: string
  lineNumbers?: boolean
  /** Keep long lines inside narrow containers while preserving indentation. */
  wrapLongLines?: boolean
  className?: string
}) {
  const lang = langFor(language, path)
  const lines = useMemo(() => content.replace(/\n$/, '').split('\n'), [content])
  const html = useMemo(() => lines.map((l) => highlight(l, language, path)), [lines, language, path])

  return (
    <div className={clsx('rounded-lg border border-line bg-code', wrapLongLines ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto', className)}>
      <table className={clsx('w-full border-collapse font-mono text-[12.5px] leading-relaxed', wrapLongLines && 'table-fixed')}>
        <tbody>
          {html.map((h, i) => (
            <tr key={i} className="hover:bg-white/[0.03]">
              {lineNumbers && (
                <td className="select-none border-r border-line/60 px-2.5 text-right align-top text-zinc-600">
                  {i + 1}
                </td>
              )}
              <td
                className={clsx(
                  'hljs px-3 align-top text-zinc-200',
                  wrapLongLines ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre',
                )}
                dangerouslySetInnerHTML={{ __html: h || ' ' }}
              />
            </tr>
          ))}
        </tbody>
      </table>
      {lang && (
        <div className="border-t border-line/60 px-3 py-1 text-right text-[10px] uppercase tracking-wide text-zinc-600">
          {lang}
        </div>
      )}
    </div>
  )
}
