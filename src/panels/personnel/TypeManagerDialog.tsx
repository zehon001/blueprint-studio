/**
 * 人员类型管理弹窗：新增 / 重命名 / 删除类型、设置类型级交付要求，以及「按类型分组」开关。
 */
import { useEffect, useMemo, useState } from 'react'
import { PackageOpen, Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/shell/ui/Dialog'
import type {
  PersonArtifactKind,
  PersonDeliveryConfig,
  PersonSummary,
  PersonType,
} from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { PpCheckbox, PpSpinner } from './primitives'

interface TypeManagerDialogProps {
  types: PersonType[]
  people: PersonSummary[]
  groupByType: boolean
  onGroupByTypeChange: (value: boolean) => void
  onSave: (types: PersonType[]) => Promise<void>
  onClose: () => void
}

function tempTypeId(): string {
  return `type_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

const ARTIFACT_KIND_OPTIONS: Array<{ value: PersonArtifactKind; label: string }> = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'image', label: '图片' },
  { value: 'file', label: '其他文件' },
]

function emptyDelivery(): PersonDeliveryConfig {
  return { dir: '', artifactKinds: [], required: false }
}

function normalizeDeliveryDraft(delivery: PersonDeliveryConfig): PersonDeliveryConfig {
  const dir = delivery.dir.trim()
  const naming = delivery.naming?.trim() ?? ''
  return {
    dir,
    artifactKinds: delivery.artifactKinds,
    required: delivery.required && dir !== '' && delivery.artifactKinds.length > 0,
    ...(naming ? { naming } : {}),
  }
}

function deliveryForSave(type: PersonType): PersonDeliveryConfig | undefined {
  if (!type.delivery) return undefined
  const delivery = normalizeDeliveryDraft(type.delivery)
  if (!delivery.dir && delivery.artifactKinds.length === 0 && !delivery.naming) return undefined
  return delivery
}

function TypeDeliveryEditor(props: {
  delivery?: PersonDeliveryConfig
  onChange: (delivery: PersonDeliveryConfig) => void
}) {
  const delivery = props.delivery ?? emptyDelivery()
  const patch = (next: Partial<PersonDeliveryConfig>): void => {
    const merged = { ...delivery, ...next }
    props.onChange({
      ...merged,
      required:
        merged.required && merged.dir.trim() !== '' && merged.artifactKinds.length > 0,
    })
  }
  return (
    <div className="pp-type-delivery">
      <label className="pp-type-field">
        <span>产物目录</span>
        <input
          className="pp-input"
          value={delivery.dir}
          placeholder="例如 reports；留空表示由任务自行决定"
          maxLength={120}
          spellCheck={false}
          onChange={(e) => patch({ dir: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <div className="pp-type-field">
        <span>产物类型</span>
        <div className="pp-type-kinds">
          {ARTIFACT_KIND_OPTIONS.map((option) => {
            const checked = delivery.artifactKinds.includes(option.value)
            return (
              <PpCheckbox
                key={option.value}
                checked={checked}
                label={option.label}
                onChange={(next) =>
                  patch({
                    artifactKinds: next
                      ? [...delivery.artifactKinds, option.value]
                      : delivery.artifactKinds.filter((kind) => kind !== option.value),
                  })
                }
              />
            )
          })}
        </div>
      </div>
      <label className="pp-type-field">
        <span>命名规则</span>
        <input
          className="pp-input"
          value={delivery.naming ?? ''}
          placeholder="可选，例如 {date}_{app}_{platform}_{report}.md"
          maxLength={200}
          spellCheck={false}
          onChange={(e) => patch({ naming: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <PpCheckbox
        checked={delivery.required}
        disabled={!delivery.dir || delivery.artifactKinds.length === 0}
        label="每个任务都必须产出文件"
        onChange={(required) => patch({ required })}
      />
      <p className="pp-type-hint">
        交付要求会写进该类型人员工作区的 AGENTS.md。任务产物需要在 TASKS.json 中登记，概览页才会出现查看入口。
      </p>
    </div>
  )
}

export function TypeManagerDialog(props: TypeManagerDialogProps) {
  const [draft, setDraft] = useState<PersonType[]>(props.types)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deliveryOpenId, setDeliveryOpenId] = useState('')

  useEffect(() => {
    setDraft(props.types)
    setNewName('')
    setError('')
    setDeliveryOpenId('')
  }, [props.types])

  const usage = useMemo(() => {
    const map = new Map<string, number>()
    for (const person of props.people) {
      map.set(person.typeId, (map.get(person.typeId) ?? 0) + 1)
    }
    return map
  }, [props.people])

  const addType = (): void => {
    const name = newName.trim()
    if (!name) {
      setError('请输入类型名称')
      return
    }
    if (name.length > 20) {
      setError('类型名称不能超过 20 个字')
      return
    }
    if (draft.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setError('已经有同名类型了')
      return
    }
    setDraft((list) => [...list, { id: tempTypeId(), name }])
    setNewName('')
    setError('')
  }

  const save = async (): Promise<void> => {
    for (const type of draft) {
      if (!type.name.trim()) {
        setError('类型名称不能为空')
        return
      }
      if (type.name.length > 20) {
        setError('类型名称不能超过 20 个字')
        return
      }
    }
    const names = draft.map((t) => t.name.trim().toLowerCase())
    if (new Set(names).size !== names.length) {
      setError('类型名称不能重复')
      return
    }
    setSaving(true)
    setError('')
    try {
      await props.onSave(
        draft.map((t) => {
          const delivery = deliveryForSave(t)
          return {
            id: t.id,
            name: t.name.trim(),
            ...(delivery ? { delivery } : {}),
          }
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="编辑人员类型"
      width={560}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="pp-btn ghost" onClick={props.onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="pp-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? (
              <>
                <PpSpinner />
                保存中
              </>
            ) : (
              '保存类型'
            )}
          </button>
        </>
      }
    >
      <div className="pp-type-dialog">
        <p className="pp-dialog-desc">
          类型用于给人员分类。重命名会同步到所有该类型的人员；删除类型后，这些人员会变为「未分类」。
        </p>
        <div className="pp-type-list">
          {draft.length === 0 ? <div className="pp-type-empty">还没有类型</div> : null}
          {draft.map((type) => (
            <div key={type.id} className="pp-type-item">
              <div className="pp-type-row">
                <input
                  className="pp-input"
                  value={type.name}
                  maxLength={20}
                  aria-label="类型名称"
                  onChange={(e) => {
                    const name = e.target.value
                    setDraft((list) => list.map((t) => (t.id === type.id ? { ...t, name } : t)))
                    setError('')
                  }}
                />
                <span className="pp-type-usage">{usage.get(type.id) ?? 0} 人</span>
                <button
                  type="button"
                  className={`pp-btn sm${deliveryOpenId === type.id ? ' primary' : ''}`}
                  title="设置该类型的交付要求"
                  aria-expanded={deliveryOpenId === type.id}
                  onClick={() =>
                    setDeliveryOpenId((id) => (id === type.id ? '' : type.id))
                  }
                >
                  <Icon icon={PackageOpen} size={13} />
                  交付
                </button>
                <button
                  type="button"
                  className="pp-icon-btn danger"
                  title="删除类型"
                  aria-label={`删除类型 ${type.name}`}
                  onClick={() => {
                    setDraft((list) => list.filter((t) => t.id !== type.id))
                    setError('')
                    if (deliveryOpenId === type.id) setDeliveryOpenId('')
                  }}
                >
                  <Icon icon={Trash2} size={14} />
                </button>
              </div>
              {deliveryOpenId === type.id ? (
                <TypeDeliveryEditor
                  delivery={type.delivery}
                  onChange={(delivery) =>
                    setDraft((list) =>
                      list.map((t) => (t.id === type.id ? { ...t, delivery } : t)),
                    )
                  }
                />
              ) : null}
            </div>
          ))}
        </div>
        <div className="pp-type-add">
          <input
            className="pp-input"
            value={newName}
            maxLength={20}
            placeholder="新类型名称"
            aria-label="新类型名称"
            onChange={(e) => {
              setNewName(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addType()
              }
              e.stopPropagation()
            }}
          />
          <button type="button" className="pp-btn" onClick={addType}>
            <Icon icon={Plus} size={13} />
            添加
          </button>
        </div>
        {error ? <div className="pp-form-error">{error}</div> : null}
        <div className="pp-type-group-toggle">
          <PpCheckbox
            checked={props.groupByType}
            onChange={props.onGroupByTypeChange}
            label="人员列表按类型分组"
          />
          <span>勾选后左侧人员列表会按类型分组展示。</span>
        </div>
      </div>
    </Dialog>
  )
}
