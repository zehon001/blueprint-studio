/** 新建人员弹窗：名称 + 类型。创建后服务端同步生成默认工作区。 */
import { useState } from 'react'
import { Dialog } from '@/shell/ui/Dialog'
import type { PersonType } from '@/shared/personnel'
import { PpSpinner, PpSelect } from './primitives'

interface PersonCreateDialogProps {
  types: PersonType[]
  onClose: () => void
  onCreate: (name: string, typeId: string) => Promise<void>
}

export function PersonCreateDialog(props: PersonCreateDialogProps) {
  const [name, setName] = useState('')
  const [typeId, setTypeId] = useState(props.types[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入人员名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await props.onCreate(trimmed, typeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="新建人员"
      width={460}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="pp-btn ghost" onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="pp-btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? (
              <>
                <PpSpinner />
                创建中
              </>
            ) : (
              '创建人员'
            )}
          </button>
        </>
      }
    >
      <div className="pp-form">
        <label className="pp-form-field">
          <span>名字</span>
          <input
            className="pp-input"
            value={name}
            maxLength={40}
            autoFocus
            placeholder="比如：客服小蓝"
            onChange={(e) => {
              setName(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              }
              e.stopPropagation()
            }}
          />
        </label>
        <label className="pp-form-field">
          <span>人员类型</span>
          <PpSelect
            value={typeId}
            options={[
              ...props.types.map((t) => ({ value: t.id, label: t.name })),
              { value: '', label: '未分类' },
            ]}
            onChange={setTypeId}
            placeholder="未分类"
          />
        </label>
        <p className="pp-dialog-desc">
          创建后会自动生成默认工作区文件夹，头像、名字、角色卡、规范、记忆与设置都保存在里面。
        </p>
        {error ? <div className="pp-form-error">{error}</div> : null}
      </div>
    </Dialog>
  )
}
