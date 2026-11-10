/** 派发任务弹窗：保存当前任务并立即构建工作区、启动 / 复用 DSH 会话。 */
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@/shell/ui/Dialog'
import { toast } from 'sonner'
import { personnelApi } from './api'
import { PpSpinner } from './primitives'

interface DispatchTaskDialogProps {
  personId: string
  personName: string
  initialTask: string
  onClose: () => void
  onDispatched: () => Promise<void>
}

export function DispatchTaskDialog(props: DispatchTaskDialogProps) {
  const [task, setTask] = useState(props.initialTask)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const taskRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    taskRef.current?.focus()
    const el = taskRef.current
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const dispatch = async (): Promise<void> => {
    const text = task.trim()
    if (!text) {
      setError('请先写清楚要派发的任务')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await personnelApi.update(props.personId, { task: text })
      await personnelApi.run(props.personId)
      toast.success(`任务已派发给「${props.personName}」，DSH 会话已启动`)
      await props.onDispatched()
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '派发任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title="派发任务"
      width={620}
      onClose={props.onClose}
      footer={
        <>
          <button
            type="button"
            className="pp-btn ghost"
            onClick={props.onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="pp-btn primary"
            onClick={() => void dispatch()}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <PpSpinner />
                派发中
              </>
            ) : (
              '派发并执行'
            )}
          </button>
        </>
      }
    >
      <div className="pp-form">
        <label className="pp-form-field">
          <span>任务内容</span>
          <textarea
            ref={taskRef}
            className="pp-textarea pp-dispatch-textarea"
            value={task}
            maxLength={30_000}
            autoFocus
            placeholder="写清楚这位人员要做什么、验收标准是什么、哪些文件 / 资料需要先看…"
            onChange={(e) => {
              setTask(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void dispatch()
              }
              e.stopPropagation()
            }}
          />
        </label>
        <p className="pp-dialog-desc">
          派发后会保存任务、构建工作区，再启动 / 复用 DSH 会话；会话启动只发送
          「读取 AGENTS.md，然后完成里面的事项」。
        </p>
        <div className="pp-inline-meta">
          <span>{task.length} 字</span>
          <span>Ctrl / ⌘ + Enter 快速派发</span>
        </div>
        {error ? <div className="pp-form-error">{error}</div> : null}
      </div>
    </Dialog>
  )
}
