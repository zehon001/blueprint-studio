/** 发布任务弹窗：只把任务加入看板，不立即执行。 */
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@/shell/ui/Dialog'
import { toast } from 'sonner'
import { personnelApi } from './api'
import { PpSpinner } from './primitives'

interface AddTaskDialogProps {
  personId: string
  personName: string
  onClose: () => void
  onAdded: () => Promise<void>
}

export function AddTaskDialog(props: AddTaskDialogProps) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const contentRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    contentRef.current?.focus()
  }, [])

  const add = async (): Promise<void> => {
    const text = content.trim()
    if (!text) {
      setError('请先写清楚任务内容')
      return
    }
    setSaving(true)
    setError('')
    try {
      await personnelApi.addTask(props.personId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        content: text,
      })
      toast.success(`任务已加入「${props.personName}」的任务看板`)
      await props.onAdded()
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="发布任务"
      width={620}
      onClose={props.onClose}
      footer={
        <>
          <button
            type="button"
            className="pp-btn ghost"
            onClick={props.onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="pp-btn primary"
            onClick={() => void add()}
            disabled={saving}
          >
            {saving ? (
              <>
                <PpSpinner />
                添加中
              </>
            ) : (
              '添加到任务列表'
            )}
          </button>
        </>
      }
    >
      <div className="pp-form">
        <label className="pp-form-field">
          <span>任务标题（可选）</span>
          <input
            className="pp-input"
            value={title}
            maxLength={120}
            placeholder="留空时取任务内容第一行"
            onChange={(e) => {
              setTitle(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
        <label className="pp-form-field">
          <span>任务内容</span>
          <textarea
            ref={contentRef}
            className="pp-textarea pp-dispatch-textarea"
            value={content}
            maxLength={30_000}
            placeholder="写清楚要做什么、验收标准是什么、需要先看哪些文件或资料…"
            onChange={(e) => {
              setContent(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void add()
              }
              e.stopPropagation()
            }}
          />
        </label>
        <p className="pp-dialog-desc">
          发布后只加入任务看板，不会立即执行。点右上角「执行」后，会按列表顺序依次运行所有待执行任务。
        </p>
        <div className="pp-inline-meta">
          <span>{content.length} 字</span>
          <span>Ctrl / ⌘ + Enter 快速添加</span>
        </div>
        {error ? <div className="pp-form-error">{error}</div> : null}
      </div>
    </Dialog>
  )
}
