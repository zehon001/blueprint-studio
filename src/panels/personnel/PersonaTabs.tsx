/**
 * 人设：角色卡（单张生效）/ 规范（分节或整段）/ 记忆（整理 & 清理）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Brain, FileText, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, RoleCard } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { personnelApi } from './api'
import { formatDateTime, relativeTime } from './format'
import { ConfirmDialog, PpRow, PpSectionCard, PpSpinner } from './primitives'
import { SectionEditor } from './SectionEditor'
import {
  detectNormsStyle,
  joinBracketSections,
  joinSections,
  splitBracketSections,
  splitSections,
  type SectionStyle,
  type TextSection,
} from './section-model'

interface PersonaTabProps {
  detail: PersonDetail
  busy: boolean
  onRefresh: () => Promise<void>
}

type EditorMode = 'sections' | 'whole'

function cardTagsText(card: RoleCard | undefined): string {
  return card ? card.tags.join('，') : ''
}

function readMode(kind: string): EditorMode {
  try {
    return localStorage.getItem(`bps.personnel.${kind}.mode`) === 'whole' ? 'whole' : 'sections'
  } catch {
    return 'sections'
  }
}

function storeMode(kind: string, mode: EditorMode): void {
  try {
    localStorage.setItem(`bps.personnel.${kind}.mode`, mode)
  } catch {
    /* localStorage 不可用 */
  }
}

function ModeSwitch(props: {
  mode: EditorMode
  onChange: (mode: EditorMode) => void
  stats: string
  disabled: boolean
}) {
  return (
    <div className="pp-mode-row">
      <div className="pp-mode-seg" role="tablist" aria-label="编辑方式">
        <button
          type="button"
          role="tab"
          aria-selected={props.mode === 'sections'}
          className={props.mode === 'sections' ? 'on' : ''}
          disabled={props.disabled}
          onClick={() => props.onChange('sections')}
        >
          分节
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.mode === 'whole'}
          className={props.mode === 'whole' ? 'on' : ''}
          disabled={props.disabled}
          onClick={() => props.onChange('whole')}
        >
          整段
        </button>
      </div>
      <span className="pp-mode-stats">{props.stats}</span>
    </div>
  )
}

export function RoleCardsTab(props: PersonaTabProps) {
  const serverCardsSignature = JSON.stringify(props.detail.cards)
  const [cards, setCards] = useState<RoleCard[]>(props.detail.cards)
  const [selectedId, setSelectedId] = useState<string | null>(props.detail.cards[0]?.id ?? null)
  const [tagText, setTagText] = useState(cardTagsText(props.detail.cards[0]))
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RoleCard | null>(null)
  const [mode, setMode] = useState<EditorMode>(() => readMode('card'))
  const [sections, setSections] = useState<TextSection[]>(() =>
    splitBracketSections(props.detail.cards[0]?.content ?? ''),
  )

  const currentCardId = props.detail.config.currentCardId ?? props.detail.cards[0]?.id ?? ''
  const selected = cards.find((card) => card.id === selectedId) ?? null
  const isCurrent = Boolean(selected && selected.id === currentCardId)

  useEffect(() => {
    setCards(props.detail.cards)
    setSelectedId((current) =>
      current && props.detail.cards.some((card) => card.id === current)
        ? current
        : (props.detail.cards[0]?.id ?? null),
    )
  }, [serverCardsSignature, props.detail.id])

  useEffect(() => {
    setTagText(cardTagsText(selected ?? undefined))
  }, [selectedId, serverCardsSignature])

  useEffect(() => {
    if (!selected || mode !== 'sections') return
    setSections(splitBracketSections(selected.content))
  }, [selectedId, mode, serverCardsSignature, props.detail.id])

  const dirty = useMemo(
    () => JSON.stringify(cards) !== JSON.stringify(props.detail.cards),
    [cards, props.detail.cards],
  )

  const patchCard = (patch: Partial<RoleCard>): void => {
    if (!selectedId) return
    setCards((list) =>
      list.map((card) => (card.id === selectedId ? { ...card, ...patch } : card)),
    )
  }

  const setSectionsAndContent = (nextSections: TextSection[]): void => {
    setSections(nextSections)
    patchCard({ content: joinBracketSections(nextSections) })
  }

  const switchMode = (next: EditorMode): void => {
    setMode(next)
    storeMode('card', next)
    if (next === 'sections' && selected) {
      setSections(splitBracketSections(selected.content))
    }
  }

  const addCard = (): void => {
    const card: RoleCard = {
      id: `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: '新角色卡',
      tags: [],
      content: '你是……\n\n【职责】\n……\n\n【工作原则】\n- ……',
      updatedAt: Date.now(),
    }
    setCards((list) => [...list, card])
    setSelectedId(card.id)
    setTagText('')
    setSections(splitBracketSections(card.content))
  }

  const removeCard = (): void => {
    if (!deleteTarget) return
    const next = cards.filter((card) => card.id !== deleteTarget.id)
    setCards(next)
    setSelectedId((current) => (current === deleteTarget.id ? (next[0]?.id ?? null) : current))
    setDeleteTarget(null)
  }

  const save = async (extra?: { currentCardId?: string }): Promise<void> => {
    setSaving(true)
    try {
      await personnelApi.update(props.detail.id, {
        cards,
        ...(extra?.currentCardId ? { currentCardId: extra.currentCardId } : {}),
      })
      toast.success(extra?.currentCardId ? '已切换当前角色卡' : '角色卡已保存')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存角色卡失败')
    } finally {
      setSaving(false)
    }
  }

  const setCurrent = async (): Promise<void> => {
    if (!selected || isCurrent) return
    if (dirty) {
      await save({ currentCardId: selected.id })
      return
    }
    setSaving(true)
    try {
      await personnelApi.update(props.detail.id, { currentCardId: selected.id })
      toast.success('已切换当前角色卡')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换角色卡失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pp-split">
      <aside className="pp-sub-list">
        <div className="pp-sub-list-head">
          <span>角色卡</span>
          <span className="pp-count">{cards.length}</span>
        </div>
        <div className="pp-sub-list-scroll">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className={`pp-card-item${selectedId === card.id ? ' active' : ''}`}
              onClick={() => setSelectedId(card.id)}
            >
              <span className="pp-card-item-name">
                {card.name || '未命名角色卡'}
                {card.id === currentCardId ? <i className="pp-current-badge">正在用</i> : null}
              </span>
              <span className="pp-card-item-tags">
                {card.tags.length ? card.tags.join(' · ') : '未设置标签'}
              </span>
            </button>
          ))}
          {cards.length === 0 ? <div className="pp-sub-list-empty">还没有角色卡</div> : null}
        </div>
        <button type="button" className="pp-sub-add" onClick={addCard} disabled={props.busy}>
          <Icon icon={Plus} size={13} />
          新增角色卡
        </button>
      </aside>

      <section className="pp-card pp-card-editor">
        {selected ? (
          <>
            <div className="pp-card-head">
              <div className="pp-card-heading">
                <h3>编辑角色卡</h3>
                <p>只有当前角色卡会写入 AGENTS.md；多张卡互斥，不会合并。</p>
              </div>
              <div className="pp-card-right">
                {isCurrent ? null : (
                  <button
                    type="button"
                    className="pp-btn sm"
                    disabled={props.busy || saving}
                    onClick={() => void setCurrent()}
                  >
                    <Icon icon={Sparkles} size={13} />
                    设为当前
                  </button>
                )}
                <button
                  type="button"
                  className="pp-btn danger ghost sm"
                  disabled={props.busy || saving}
                  onClick={() => setDeleteTarget(selected)}
                >
                  <Icon icon={Trash2} size={13} />
                  删除
                </button>
                <button
                  type="button"
                  className="pp-btn primary sm"
                  disabled={props.busy || saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? <PpSpinner /> : null}
                  {dirty ? '保存角色卡' : '已保存'}
                </button>
              </div>
            </div>
            <div className="pp-form pp-card-editor-form">
              <div className="pp-card-meta-rows">
                <PpRow label="名字">
                  <input
                    className="pp-input pp-row-input"
                    value={selected.name}
                    maxLength={60}
                    disabled={props.busy}
                    onChange={(e) => patchCard({ name: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </PpRow>
                <PpRow label="标签" hint="用逗号隔开">
                  <input
                    className="pp-input pp-row-input"
                    value={tagText}
                    placeholder="用逗号分隔，比如：客服，售前"
                    disabled={props.busy}
                    onChange={(e) => {
                      const text = e.target.value
                      setTagText(text)
                      patchCard({
                        tags: text
                          .split(/[,，\s]+/)
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      })
                    }}
                    onBlur={() => setTagText(cardTagsText(selected))}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </PpRow>
              </div>

              <ModeSwitch
                mode={mode}
                onChange={switchMode}
                stats={
                  mode === 'sections'
                    ? `${Math.max(0, sections.length - 1)} 节 · ${selected.content.length} 字`
                    : `${selected.content.length} 字`
                }
                disabled={props.busy}
              />

              {mode === 'sections' ? (
                <SectionEditor
                  key={`${selected.id}-${mode}`}
                  sections={sections}
                  onChange={setSectionsAndContent}
                  disabled={props.busy}
                  polishKind="card"
                  leadLabel="开场"
                  suggestions={['职责', '工作原则', '语气', '边界', '输出格式']}
                  onPolish={async (section, others) => {
                    const result = await personnelApi.polish(props.detail.id, {
                      kind: 'card',
                      title: section.title || '开场',
                      text: section.text,
                      others,
                    })
                    return result.text
                  }}
                />
              ) : (
                <label className="pp-form-field">
                  <span>具体内容</span>
                  <textarea
                    className="pp-textarea pp-card-content"
                    value={selected.content}
                    disabled={props.busy}
                    placeholder={'你是XXX。\n\n【职责】\n……\n\n【工作原则】\n- ……'}
                    onChange={(e) => patchCard({ content: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>
              )}
              <div className="pp-inline-meta">
                <span>{selected.content.length} 字</span>
                <span>只有当前角色卡会进入 AGENTS.md</span>
              </div>
            </div>
          </>
        ) : (
          <div className="pp-empty">
            <FileText size={28} />
            <span>先新增一张角色卡，写清楚「你是谁、职责是什么」。</span>
            <button type="button" className="pp-btn primary sm" onClick={addCard} disabled={props.busy}>
              <Icon icon={Plus} size={13} />
              新增角色卡
            </button>
          </div>
        )}
      </section>

      {deleteTarget ? (
        <ConfirmDialog
          title="删除角色卡"
          message={`确定删除「${deleteTarget.name || '未命名角色卡'}」吗？${
            deleteTarget.id === currentCardId
              ? '删除当前卡后会自动切换到下一张。'
              : '保存后才会真正生效。'
          }`}
          confirmLabel="删除"
          danger
          onConfirm={removeCard}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  )
}

export function NormsTab(props: PersonaTabProps) {
  const [norms, setNorms] = useState(props.detail.norms)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<EditorMode>(() => readMode('norms'))
  const [style, setStyle] = useState<SectionStyle>(() => detectNormsStyle(props.detail.norms))
  const [sections, setSections] = useState<TextSection[]>(() =>
    splitSections(props.detail.norms, detectNormsStyle(props.detail.norms)),
  )

  useEffect(() => {
    setNorms(props.detail.norms)
    if (mode === 'sections') {
      const nextStyle = detectNormsStyle(props.detail.norms)
      setStyle(nextStyle)
      setSections(splitSections(props.detail.norms, nextStyle))
    }
  }, [props.detail.norms, props.detail.id])

  const dirty = norms !== props.detail.norms

  const setSectionsAndNorms = (nextSections: TextSection[]): void => {
    setSections(nextSections)
    setNorms(joinSections(nextSections, style))
  }

  const switchMode = (next: EditorMode): void => {
    setMode(next)
    storeMode('norms', next)
    if (next === 'sections') {
      const nextStyle = detectNormsStyle(norms)
      setStyle(nextStyle)
      setSections(splitSections(norms, nextStyle))
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await personnelApi.update(props.detail.id, { norms })
      toast.success('规范已保存')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存规范失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pp-grid">
      <PpSectionCard
        title="工作规范"
        desc="说明怎么操作文件、怎么使用工具、失败后怎么处理。会写入 AGENTS.md，由会话启动时读取。"
        right={
          <button
            type="button"
            className="pp-btn primary sm"
            onClick={() => void save()}
            disabled={props.busy || saving || !dirty}
          >
            {saving ? <PpSpinner /> : null}
            {dirty ? '保存规范' : '已保存'}
          </button>
        }
      >
        <ModeSwitch
          mode={mode}
          onChange={switchMode}
          stats={
            mode === 'sections'
              ? `${Math.max(0, sections.length - 1)} 节 · ${norms.length} 字`
              : `${norms.length} 字`
          }
          disabled={props.busy}
        />
        {mode === 'sections' ? (
          <SectionEditor
            key={`${style}-${mode}`}
            sections={sections}
            onChange={setSectionsAndNorms}
            disabled={props.busy}
            polishKind="norms"
            leadLabel="前言"
            suggestions={['文件操作', '工具使用', '工作状态', '输出规范', '禁止事项']}
            onPolish={async (section, others) => {
              const result = await personnelApi.polish(props.detail.id, {
                kind: 'norms',
                title: section.title || '前言',
                text: section.text,
                others,
              })
              return result.text
            }}
          />
        ) : (
          <textarea
            className="pp-textarea pp-norms-textarea"
            value={norms}
            disabled={props.busy}
            placeholder="# 工作规范&#10;- 修改文件前先读取…&#10;- 命令失败时先读错误输出…"
            onChange={(e) => setNorms(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        <div className="pp-inline-meta">
          <span>{norms.length} 字</span>
          <span>保存在 .person/norms.md</span>
        </div>
      </PpSectionCard>

      <PpSectionCard title="建议覆盖的内容">
        <ul className="pp-tips">
          <li>文件：先读后写、只改相关文件、不要删除无关内容。</li>
          <li>工具：命令失败时读取错误输出，不要静默忽略。</li>
          <li>状态：每完成一个阶段更新 STATE.md，方便会话重建后续接。</li>
          <li>记忆：把跨会话仍然重要的事实写进 memory/MEMORY.md。</li>
          <li>边界：明确哪些事情不能做、哪些操作需要先确认。</li>
        </ul>
      </PpSectionCard>
    </div>
  )
}

export function MemoryTab(props: PersonaTabProps) {
  const [clearing, setClearing] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const memory = props.detail.memory
  const empty = memory.count === 0 && memory.files.length === 0

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      await personnelApi.clearMemory(props.detail.id)
      toast.success('记忆已清理')
      setConfirmOpen(false)
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清理记忆失败')
    } finally {
      setClearing(false)
    }
  }

  const organize = async (): Promise<void> => {
    setOrganizing(true)
    try {
      await personnelApi.organizeMemory(props.detail.id)
      toast.success('记忆已用当前模型整理，旧记忆已归档')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '整理记忆失败')
    } finally {
      setOrganizing(false)
    }
  }

  return (
    <div className="pp-grid">
      <PpSectionCard
        title="记忆"
        desc="来自工作区 memory/ 目录；执行时会读入上下文。整理会调用当前模型合并重复、按主题归类。"
        right={
          <div className="pp-card-right">
            <button
              type="button"
              className="pp-btn sm"
              disabled={props.busy || organizing || empty}
              onClick={() => void organize()}
              title="调用当前模型整理长期记忆"
            >
              {organizing ? <PpSpinner /> : <Icon icon={Sparkles} size={13} />}
              整理记忆
            </button>
            <button
              type="button"
              className="pp-btn danger sm"
              disabled={props.busy || clearing || empty}
              onClick={() => setConfirmOpen(true)}
            >
              {clearing ? <PpSpinner /> : <Icon icon={Trash2} size={13} />}
              清理记忆
            </button>
          </div>
        }
      >
        <div className="pp-memory-summary">
          <span>
            <b>{memory.count}</b> 条记忆
          </span>
          <span>{memory.files.length} 个文件</span>
          {memory.updatedAt ? <span>更新于 {relativeTime(memory.updatedAt)}</span> : null}
        </div>
        {memory.files.length === 0 ? (
          <div className="pp-empty">
            <Brain size={28} />
            <span>还没有长期记忆。执行会话会把重要事实写进 memory/MEMORY.md。</span>
          </div>
        ) : (
          <>
            <div className="pp-memory-files">
              {memory.files.map((file) => (
                <div key={file.name} className="pp-memory-file">
                  <Icon icon={FileText} size={13} />
                  <span className="pp-memory-file-name">{file.name}</span>
                  <span className="pp-memory-file-size">
                    {Math.max(1, Math.round(file.size / 1024))} KB
                  </span>
                </div>
              ))}
            </div>
            <pre className="pp-memory-preview">{memory.text}</pre>
          </>
        )}
        {memory.updatedAt ? (
          <div className="pp-inline-meta">
            <span>最后更新：{formatDateTime(memory.updatedAt)}</span>
            <span>整理后旧记忆会归档到 memory/.archive</span>
          </div>
        ) : null}
      </PpSectionCard>

      {confirmOpen ? (
        <ConfirmDialog
          title="清理记忆"
          message="会删除工作区 memory/ 目录下的全部记忆文件。角色卡、规范、任务和 STATE.md 不受影响。"
          confirmLabel="清理记忆"
          danger
          busy={clearing}
          onConfirm={() => void clear()}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  )
}
