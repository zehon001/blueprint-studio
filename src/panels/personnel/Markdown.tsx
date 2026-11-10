/** 人员页 Markdown 渲染：marked + 基础 HTML 清洗。 */
import { useMemo } from 'react'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sanitizeMarkdownHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(html)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,textarea,select,button'),
  )) {
    el.remove()
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim().toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name)
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^javascript:/i.test(value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return doc.body.innerHTML
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    if (!text.trim()) return ''
    const parsed = marked.parse(text, { async: false }) as string
    return sanitizeMarkdownHtml(parsed)
  }, [text])
  return (
    <div
      className={`pp-markdown${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
