/**
 * 人设：角色卡 / 规范 / 记忆。
 */
import { useEffect, useMemo, useState } from 'react'
import { Brain, FileText, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, RoleCard } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { personnelApi } from './api'
import { formatDateTime, relativeTime } from './format'
import {
  ConfirmDialog,
  PpSectionCard,
  PpSpinner,
} from './primitives'

interface PersonaTabProps {
  detail: PersonDetail
  busy: boolean
  onRefresh: () => Promise<void>
}

function cardTagsText(card: RoleCard | undefined): string {
  return card ? card.tags.join('，') : ''
}

export function RoleCardsTab(props: PersonaTabProps) {
  const serverCardsSignature = JSON.stringify(props.detail.cards)
  const [cards, setCards] = useState<RoleCard[]>(props.detail.cards)
  const [selectedId, setSelectedId] = useState<string | null>(props.detail.cards[0]?.id ?? null)
  const [tagText, setTagText] = useState(cardTagsText(props.detail.cards[0]))
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RoleCard | null>(null)

  useEffect(() => {
    setCards(props.detail.cards)
    setSelectedId((current) =>
      current && props.detail.cards.some((card) => card.id === current)
        ? current
        : (props.detail.cards[0]?.id ?? null),
    )
  }, [serverCardsSignature, props.detail.id])

  const selected = cards.find((card) => card.id === selectedId) ?? null
  useEffect(() => {
    setTagText(cardTagsText(selected ?? undefined))
  }, [selectedId, serverCardsSignature])

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

  const addCard = (): void => {
    const card: RoleCard = {
      id: `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: '新角色卡',
      tags: [],
      content: '你是……\n职责是：……',
      updatedAt: Date.now(),
    }
    setCards((list) => [...list, card])
    setSelectedId(card.id)
    setTagText('')
  }

  const removeCard = (): void => {
    if (!deleteTarget) return
    const next = cards.filter((card) => card.id !== deleteTarget.id)
    setCards(next)
    setSelectedId((current) => (current === deleteTarget.id ? (next[0]?.id ?? null) : current))
    setDeleteTarget(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await personnelApi.update(props.detail.id, { cards })
      toast.success('角色卡已保存')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存角色卡失败')
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
              <span className="pp-card-item-name">{card.name || '未命名角色卡'}</span>
              <span className="pp-card-item-tags">
                {card.tags.length ? card.tags.join(' · ') : '未设置标签'}
              </span>
            </button>
          ))}
          {cards.length === 0 ? <div className="pp-sub-list-empty">还没有角色卡</div> : null}
        </div>
        <button
          type="button"
          className="pp-sub-add"
          onClick={addCard}
          disabled={props.busy}
        >
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
                <p>内容会写入 AGENTS.md；会话启动读取 AGENTS.md 时即包含角色卡。</p>
              </div>
              <div className="pp-card-right">
                <button
                  type="button"
                  className="pp-btn danger ghost sm"
                  disabled={props.busy}
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
              <div className="pp-form-cols">
                <label className="pp-form-field">
                  <span>名字</span>
                  <input
                    className="pp-input"
                    value={selected.name}
                    maxLength={60}
                    disabled={props.busy}
                    onChange={(e) => patchCard({ name: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="pp-form-field">
                  <span>标签</span>
                  <input
                    className="pp-input"
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
                </label>
              </div>
              <label className="pp-form-field">
                <span>具体内容</span>
                <textarea
                  className="pp-textarea pp-card-content"
                  value={selected.content}
                  disabled={props.busy}
                  placeholder={'你是XXX。\n职责是XXX。'}
                  onChange={(e) => patchCard({ content: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
              <div className="pp-inline-meta">
                <span>{selected.content.length} 字</span>
                <span>每张卡都会按顺序拼进角色设定</span>
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
          message={`确定删除「${deleteTarget.name || '未命名角色卡'}」吗？保存后才会真正生效。`}
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

  useEffect(() => {
    setNorms(props.detail.norms)
  }, [props.detail.norms, props.detail.id])

  const dirty = norms !== props.detail.norms

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
        <textarea
          className="pp-textarea pp-norms-textarea"
          value={norms}
          disabled={props.busy}
          placeholder="# 工作规范&#10;- 修改文件前先读取…&#10;- 命令失败时先读错误输出…"
          onChange={(e) => setNorms(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const memory = props.detail.memory

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

  return (
    <div className="pp-grid">
      <PpSectionCard
        title="记忆"
        desc="来自工作区 memory/ 目录；执行时会读入上下文。"
        right={
          <button
            type="button"
            className="pp-btn danger sm"
            disabled={props.busy || clearing || (memory.count === 0 && memory.files.length === 0)}
            onClick={() => setConfirmOpen(true)}
          >
            {clearing ? <PpSpinner /> : <Icon icon={Trash2} size={13} />}
            清理记忆
          </button>
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
                  <span className="pp-memory-file-size">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                </div>
              ))}
            </div>
            <pre className="pp-memory-preview">{memory.text}</pre>
          </>
        )}
        {memory.updatedAt ? (
          <div className="pp-inline-meta">
            <span>最后更新：{formatDateTime(memory.updatedAt)}</span>
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
