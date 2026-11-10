/** Aurabot 风格分节编辑器：标题、字数、上下移、删除、AI 润色对比。 */
import { useState, type CSSProperties } from 'react'
import { ArrowDown, ArrowUp, Check, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Icon } from '@/shell/ui/Icon'
import type { TextSection } from './section-model'
import { PpSpinner } from './primitives'

interface SectionEditorProps {
  sections: TextSection[]
  onChange: (sections: TextSection[]) => void
  disabled: boolean
  polishKind: 'card' | 'norms'
  leadLabel: string
  suggestions: string[]
  onPolish: (section: TextSection, others: string[]) => Promise<string>
}

const SECTION_COLORS = [
  '#4f9a8c',
  '#8a7bc0',
  '#c08a4a',
  '#5f8fc7',
  '#c47a90',
  '#6f9f68',
  '#5c6fae',
  '#b9775a',
]

function sectionColor(index: number): string {
  return index === 0 ? 'var(--accent)' : SECTION_COLORS[(index - 1) % SECTION_COLORS.length]!
}

function autoRows(text: string): number {
  return Math.min(22, Math.max(3, text.split('\n').length + 1))
}

export function SectionEditor(props: SectionEditorProps) {
  const [polishingId, setPolishingId] = useState('')
  const [pending, setPending] = useState<Record<string, string>>({})

  const updateSection = (id: string, patch: Partial<TextSection>): void => {
    props.onChange(
      props.sections.map((section) => (section.id === id ? { ...section, ...patch } : section)),
    )
  }

  const moveSection = (index: number, direction: -1 | 1): void => {
    const targetIndex = index + direction
    if (index <= 0 || targetIndex <= 0 || targetIndex >= props.sections.length) return
    const next = props.sections.slice()
    const [section] = next.splice(index, 1)
    next.splice(targetIndex, 0, section!)
    props.onChange(next)
  }

  const deleteSection = (section: TextSection): void => {
    if (section.text.trim() && !window.confirm(`删掉「${section.title || '未命名小节'}」这一节？`)) {
      return
    }
    props.onChange(props.sections.filter((item) => item.id !== section.id))
  }

  const addSection = (title: string): void => {
    const id = `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    props.onChange([...props.sections, { id, title, text: '' }])
  }

  const polish = async (section: TextSection): Promise<void> => {
    setPolishingId(section.id)
    try {
      const others = props.sections
        .filter((item) => item.id !== section.id && item.title.trim())
        .map((item) => item.title.trim())
      const text = await props.onPolish(section, others)
      setPending((current) => ({ ...current, [section.id]: text }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 润色失败')
    } finally {
      setPolishingId('')
    }
  }

  const choosePending = (section: TextSection, useNew: boolean): void => {
    if (useNew) updateSection(section.id, { text: pending[section.id] ?? section.text })
    setPending((current) => {
      const next = { ...current }
      delete next[section.id]
      return next
    })
  }

  return (
    <div className="pp-sections">
      {props.sections.map((section, index) => {
        const lead = index === 0
        const color = sectionColor(index)
        const comparing = pending[section.id] !== undefined
        return (
          <div
            key={section.id}
            className={`pp-section${lead ? ' lead' : ''}${comparing ? ' cmp' : ''}`}
            style={{ '--c': color } as CSSProperties}
          >
            <div className="pp-section-head">
              <span className="pp-section-dot" />
              {lead ? (
                <span className="pp-section-fixed">{props.leadLabel}</span>
              ) : (
                <input
                  className="pp-section-title"
                  value={section.title}
                  maxLength={30}
                  disabled={props.disabled || comparing}
                  placeholder="这一节叫什么"
                  onChange={(e) =>
                    updateSection(section.id, { title: e.target.value.replace(/[【】\n]/g, '') })
                  }
                  onKeyDown={(e) => e.stopPropagation()}
                />
              )}
              <span className="pp-section-count">{section.text.length} 字</span>
              <div className="pp-section-actions">
                {lead ? null : (
                  <>
                    <button
                      type="button"
                      className="pp-icon-btn"
                      title="往上移"
                      aria-label="小节上移"
                      disabled={props.disabled || comparing || index <= 1}
                      onClick={() => moveSection(index, -1)}
                    >
                      <Icon icon={ArrowUp} size={13} />
                    </button>
                    <button
                      type="button"
                      className="pp-icon-btn"
                      title="往下移"
                      aria-label="小节下移"
                      disabled={
                        props.disabled || comparing || index >= props.sections.length - 1
                      }
                      onClick={() => moveSection(index, 1)}
                    >
                      <Icon icon={ArrowDown} size={13} />
                    </button>
                    <button
                      type="button"
                      className="pp-icon-btn danger"
                      title="删掉这一节"
                      aria-label="删除小节"
                      disabled={props.disabled || comparing}
                      onClick={() => deleteSection(section)}
                    >
                      <Icon icon={Trash2} size={13} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="pp-aibtn"
                  title={section.text.trim() ? '用当前模型润色这一节' : '用当前模型写一版'}
                  disabled={props.disabled || comparing || polishingId !== ''}
                  onClick={() => void polish(section)}
                >
                  {polishingId === section.id ? (
                    <PpSpinner />
                  ) : (
                    <Icon icon={Sparkles} size={13} />
                  )}
                  {polishingId === section.id
                    ? '润色中'
                    : section.text.trim()
                      ? 'AI 润色'
                      : 'AI 写一版'}
                </button>
              </div>
            </div>
            <textarea
              className="pp-section-textarea"
              rows={autoRows(section.text)}
              value={section.text}
              disabled={props.disabled}
              readOnly={comparing}
              placeholder={
                lead
                  ? '这一节写你是谁、核心职责；可以像说话一样自然。'
                  : '- 一条一行，写清楚职责、原则或边界。'
              }
              onChange={(e) => updateSection(section.id, { text: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {comparing ? (
              <div className="pp-section-compare">
                <div className="pp-section-compare-head">
                  <b>AI 润色版</b>
                  <span>原版仍在上面，可对比后选择</span>
                  <div className="pp-spacer" />
                  <button
                    type="button"
                    className="pp-btn sm"
                    onClick={() => choosePending(section, false)}
                  >
                    <Icon icon={X} size={12} />
                    保留原版
                  </button>
                  <button
                    type="button"
                    className="pp-btn primary sm"
                    onClick={() => choosePending(section, true)}
                  >
                    <Icon icon={Check} size={12} />
                    用润色版
                  </button>
                </div>
                <pre className="pp-section-preview">{pending[section.id]}</pre>
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="pp-section-add">
        <span className="pp-muted">加一节：</span>
        {props.suggestions.map((title) => (
          <button
            key={title}
            type="button"
            className="pp-section-chip"
            disabled={props.disabled}
            onClick={() => addSection(title)}
          >
            {title}
          </button>
        ))}
        <button
          type="button"
          className="pp-section-chip solid"
          disabled={props.disabled}
          onClick={() => addSection('新小节')}
        >
          ＋ 自己起名
        </button>
      </div>
    </div>
  )
}
