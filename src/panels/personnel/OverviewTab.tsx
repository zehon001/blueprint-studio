/**
 * 概览：任务看板、队列状态、最近一次任务与人员动态。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Archive,
  Brain,
  CheckCircle2,
  CircleX,
  Clock,
  Eye,
  FolderOpen,
  Image,
  Layers,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  UserPlus,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type {
  PersonActivity,
  PersonDetail,
  PersonSummary,
  PersonTask,
} from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { Dialog } from '@/shell/ui/Dialog'
import { personnelApi } from './api'
import {
  formatDateTime,
  formatDuration,
  relativeTime,
  runStatusMeta,
  taskStatusMeta,
} from './format'
import { ConfirmDialog, PpSectionCard, PpSpinner, PpStatus } from './primitives'
import { Markdown } from './Markdown'

interface OverviewTabProps {
  person: PersonSummary
  detail: PersonDetail
  onRefresh: () => Promise<void>
}

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  run_started: Play,
  run_completed: CheckCircle2,
  run_failed: XCircle,
  run_stopped: Square,
  queue_started: ListTodo,
  queue_completed: CheckCircle2,
  queue_stopped: Square,
  queue_failed: XCircle,
  task_added: Plus,
  task_deleted: Trash2,
  task_retried: RotateCcw,
  workspace_built: FolderOpen,
  workspace_reset: RotateCcw,
  memory_cleared: Brain,
  person_created: UserPlus,
  settings_saved: Settings2,
  avatar_changed: Image,
  session_archived: Archive,
}

function activityIcon(type: string): LucideIcon {
  return ACTIVITY_ICONS[type] ?? Activity
}

function toneOfActivity(type: string): string {
  if (type === 'run_completed' || type === 'queue_completed') return 'success'
  if (type === 'run_failed' || type === 'queue_failed') return 'error'
  if (
    type === 'run_started' ||
    type === 'run_stopped' ||
    type === 'queue_started' ||
    type === 'queue_stopped'
  ) {
    return 'warning'
  }
  return ''
}

/** 看板标题已经显示第一行时，内容区不再重复显示同一行 */
function taskBodyText(task: PersonTask): string {
  const content = task.content.trim()
  if (!content) return ''
  const lines = content.split(/\r?\n/)
  const firstLine = (lines[0] ?? '').replace(/^#+\s*/, '').trim()
  if (firstLine === task.title.trim()) {
    return lines.slice(1).join('\n').trim()
  }
  return content
}

/** 概览任务看板只展示最近 3 条，完整列表进入全部任务弹窗 */
const TASK_PREVIEW_LIMIT = 3

interface TaskRowProps {
  task: PersonTask
  pendingOrder: number
  canMoveUp: boolean
  canMoveDown: boolean
  actionBusy: string
  queueActive: boolean
  stopping: boolean
  reportLoading: boolean
  onMove: (taskId: string, direction: 'up' | 'down') => void
  onRetry: (taskId: string) => void
  onStop: (taskId: string) => void
  onReport: (task: PersonTask) => void
  onDelete: (task: PersonTask) => void
}

function TaskRow(props: TaskRowProps) {
  const {
    task,
    pendingOrder,
    canMoveUp,
    canMoveDown,
    actionBusy,
    queueActive,
    stopping,
    reportLoading,
    onMove,
    onRetry,
    onStop,
    onReport,
    onDelete,
  } = props
  const taskMeta = taskStatusMeta(task.status)
  const body = taskBodyText(task)
  const busy = actionBusy !== ''
  return (
    <div className={`pp-task-row pp-task-${task.status}`}>
      <div className="pp-task-main">
        <div className="pp-task-head">
          <PpStatus tone={taskMeta.tone} label={taskMeta.label} />
          <span className="pp-task-title">{task.title}</span>
          {task.source?.kind === 'blueprint' ? (
            <span
              className="pp-task-source"
              title={`来源蓝图：${task.source.project ?? ''}/${task.source.assetPath ?? ''}${
                task.source.nodeId ? ` · 节点 ${task.source.nodeId}` : ''
              }`}
            >
              蓝图
            </span>
          ) : null}
          {task.status === 'pending' ? (
            <span className="pp-task-order">#{pendingOrder + 1}</span>
          ) : null}
        </div>
        {body ? (
          <div className="pp-task-content" title={task.content}>
            {body}
          </div>
        ) : null}
        <div className="pp-task-meta">
          <span>
            <Clock size={11} /> {formatDateTime(task.createdAt)}
          </span>
          {task.startedAt ? <span>开始 {formatDateTime(task.startedAt)}</span> : null}
          {task.finishedAt ? (
            <span>
              结束 {formatDateTime(task.finishedAt)} · 耗时{' '}
              {formatDuration(task.startedAt, task.finishedAt)}
            </span>
          ) : null}
        </div>
        {task.error ? <div className="pp-task-error">{task.error}</div> : null}
        {task.result ? (
          <details className="pp-task-result">
            <summary>查看执行结果</summary>
            <Markdown text={task.result} className="pp-task-result-md" />
          </details>
        ) : null}
      </div>
      <div className="pp-task-actions">
        {task.status === 'pending' ? (
          <>
            <button
              type="button"
              className="pp-icon-btn"
              title="上移"
              aria-label="任务上移"
              disabled={!canMoveUp || busy}
              onClick={() => onMove(task.id, 'up')}
            >
              <Icon icon={ArrowUp} size={13} />
            </button>
            <button
              type="button"
              className="pp-icon-btn"
              title="下移"
              aria-label="任务下移"
              disabled={!canMoveDown || busy}
              onClick={() => onMove(task.id, 'down')}
            >
              <Icon icon={ArrowDown} size={13} />
            </button>
          </>
        ) : null}
        {task.status === 'failed' || task.status === 'stopped' ? (
          <button
            type="button"
            className="pp-btn sm"
            disabled={busy}
            onClick={() => onRetry(task.id)}
          >
            <Icon icon={RotateCcw} size={13} />
            重试
          </button>
        ) : null}
        {task.status === 'running' && queueActive ? (
          <button
            type="button"
            className="pp-btn sm danger"
            disabled={busy || stopping}
            onClick={() => onStop(task.id)}
          >
            {actionBusy === `stop-${task.id}` || stopping ? (
              <PpSpinner />
            ) : (
              <Icon icon={Square} size={13} />
            )}
            {stopping ? '停止中' : '停止'}
          </button>
        ) : null}
        {task.status === 'completed' &&
        task.artifacts?.some((artifact) => artifact.kind === 'markdown') ? (
          <button
            type="button"
            className="pp-icon-btn"
            title="查看报表"
            aria-label={`查看任务报表 ${task.title}`}
            disabled={reportLoading}
            onClick={() => onReport(task)}
          >
            {reportLoading ? <PpSpinner /> : <Icon icon={Eye} size={14} />}
          </button>
        ) : null}
        <button
          type="button"
          className="pp-icon-btn danger"
          title="删除任务"
          aria-label={`删除任务 ${task.title}`}
          disabled={task.status === 'running' || busy}
          onClick={() => onDelete(task)}
        >
          <Icon icon={Trash2} size={14} />
        </button>
      </div>
    </div>
  )
}

export function OverviewTab(props: OverviewTabProps) {
  const { person, detail, onRefresh } = props
  const queue = person.queue
  const tasks = detail.tasks
  const previewTasks = tasks.slice(0, TASK_PREVIEW_LIMIT)
  const taskCounts = person.taskCounts
  const pendingIds = useMemo(
    () => tasks.filter((task) => task.status === 'pending').map((task) => task.id),
    [tasks],
  )
  const currentTask = queue.currentTaskId
    ? tasks.find((task) => task.id === queue.currentTaskId)
    : undefined
  const done = queue.completed + queue.failed
  const progress = queue.total > 0 ? Math.min(100, Math.round((done / queue.total) * 100)) : 0
  const run = person.run
  const runMeta = runStatusMeta(run.status)
  const [actionBusy, setActionBusy] = useState('')
  const [stoppingTaskIds, setStoppingTaskIds] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<PersonTask | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [allLogsOpen, setAllLogsOpen] = useState(false)
  const [allTasksOpen, setAllTasksOpen] = useState(false)
  const [reportLoadingId, setReportLoadingId] = useState('')
  const [reportModal, setReportModal] = useState<{
    title: string
    artifactTitle?: string
    content: string
    path: string
  } | null>(null)

  useEffect(() => {
    const runningIds = new Set(
      tasks.filter((task) => task.status === 'running').map((task) => task.id),
    )
    setStoppingTaskIds((previous) => previous.filter((id) => runningIds.has(id)))
  }, [tasks])

  const statCards = useMemo(
    () => [
      { label: '待执行', value: taskCounts.pending, icon: ListTodo },
      { label: '已完成', value: taskCounts.completed, icon: CheckCircle2 },
      { label: '失败', value: taskCounts.failed, icon: CircleX },
      { label: '任务总数', value: taskCounts.total, icon: Layers },
    ],
    [taskCounts.completed, taskCounts.failed, taskCounts.pending, taskCounts.total],
  )

  const moveTask = async (taskId: string, direction: 'up' | 'down'): Promise<void> => {
    setActionBusy(`move-${taskId}-${direction}`)
    try {
      await personnelApi.moveTask(person.id, taskId, direction)
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '调整任务顺序失败')
    } finally {
      setActionBusy('')
    }
  }

  const retryTask = async (taskId: string): Promise<void> => {
    setActionBusy(`retry-${taskId}`)
    try {
      await personnelApi.retryTask(person.id, taskId)
      toast.success('任务已重新加入待执行队列')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试任务失败')
    } finally {
      setActionBusy('')
    }
  }

  const stopTask = async (taskId: string): Promise<void> => {
    setActionBusy(`stop-${taskId}`)
    try {
      await personnelApi.stop(person.id, taskId)
      setStoppingTaskIds((previous) =>
        previous.includes(taskId) ? previous : [...previous, taskId],
      )
      toast.success('已请求停止该任务，等待会话确认')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '停止任务失败')
    } finally {
      setActionBusy('')
    }
  }

  const removeTask = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await personnelApi.deleteTask(person.id, deleteTarget.id)
      toast.success(`已删除任务「${deleteTarget.title}」`)
      setDeleteTarget(null)
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除任务失败')
    } finally {
      setDeleting(false)
    }
  }

  const revealWorkspace = async (): Promise<void> => {
    setRevealing(true)
    try {
      await personnelApi.revealWorkspace(person.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打开工作区失败')
    } finally {
      setRevealing(false)
    }
  }

  const openReport = async (task: PersonTask): Promise<void> => {
    setReportLoadingId(task.id)
    try {
      const result = await personnelApi.getTaskReport(person.id, task.id)
      setReportModal({
        title: task.title,
        ...(result.title ? { artifactTitle: result.title } : {}),
        content: result.content,
        path: result.path,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取任务报表失败')
    } finally {
      setReportLoadingId('')
    }
  }

  const renderTaskRow = (task: PersonTask) => {
    const pendingOrder = pendingIds.indexOf(task.id)
    return (
      <TaskRow
        key={task.id}
        task={task}
        pendingOrder={pendingOrder}
        canMoveUp={task.status === 'pending' && pendingOrder > 0}
        canMoveDown={
          task.status === 'pending' &&
          pendingOrder >= 0 &&
          pendingOrder < pendingIds.length - 1
        }
        actionBusy={actionBusy}
        queueActive={queue.status === 'running' || queue.status === 'stopping'}
        stopping={stoppingTaskIds.includes(task.id)}
        reportLoading={reportLoadingId === task.id}
        onMove={(taskId, direction) => void moveTask(taskId, direction)}
        onRetry={(taskId) => void retryTask(taskId)}
        onStop={(taskId) => void stopTask(taskId)}
        onReport={(nextTask) => void openReport(nextTask)}
        onDelete={setDeleteTarget}
      />
    )
  }

  return (
    <div className="pp-grid">
      <div className="pp-stats">
        {statCards.map((stat) => (
          <div key={stat.label} className="pp-card pp-stat">
            <span className="pp-stat-icon">
              <Icon icon={stat.icon} size={18} />
            </span>
            <div className="pp-stat-n">{stat.value}</div>
            <div className="pp-stat-l">{stat.label}</div>
          </div>
        ))}
      </div>

      <PpSectionCard
        title="任务看板"
        right={
          <button
            type="button"
            className="pp-title-link"
            onClick={() => setAllTasksOpen(true)}
          >
            查看全部任务 <span aria-hidden>→</span>
          </button>
        }
      >
        {queue.status === 'running' || queue.status === 'stopping' ? (
          <div className="pp-queue-banner">
            <div className="pp-queue-banner-head">
              <span>{queue.status === 'stopping' ? '正在停止当前任务…' : '任务队列执行中'}</span>
              <span>
                {done}/{queue.total}
              </span>
            </div>
            <div className="pp-progress">
              <i style={{ width: `${progress}%` }} />
            </div>
            {currentTask ? (
              <div className="pp-queue-current">
                当前任务：<b>{currentTask.title}</b>
              </div>
            ) : null}
          </div>
        ) : null}

        {tasks.length === 0 ? (
          <div className="pp-empty">
            <ListTodo size={30} />
            <span>任务看板还是空的。点右上角「发布任务」添加任务。</span>
          </div>
        ) : (
          <div className="pp-task-list">
            {previewTasks.map(renderTaskRow)}
          </div>
        )}
      </PpSectionCard>

      <div className="pp-two-col">
        <PpSectionCard
          title="最近一次任务"
          desc="会话被删除后重新执行时，会从 STATE.md 与 memory/ 续接。"
          right={<PpStatus tone={runMeta.tone} label={runMeta.label} />}
        >
          {run.startedAt ? (
            <div className="pp-run-info">
              <div className="pp-kv">
                <span>任务</span>
                <span>{run.taskTitle || '—'}</span>
                <span>会话</span>
                <span>{run.sessionTitle || '未命名会话'}</span>
                <span>会话 ID</span>
                <span className="pp-mono">{run.sessionId || '—'}</span>
                <span>开始</span>
                <span>{formatDateTime(run.startedAt)}</span>
                <span>结束</span>
                <span>{formatDateTime(run.finishedAt)}</span>
                <span>耗时</span>
                <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
              </div>
              {run.error ? <div className="pp-note error">{run.error}</div> : null}
              {run.lastReply ? (
                <div className="pp-reply-wrap">
                  <div className="pp-section-label">最后回复</div>
                  <Markdown text={run.lastReply} className="pp-reply-md" />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="pp-empty small">
              <Play size={22} />
              <span>还没有执行记录。发布任务后点右上角「执行」开始。</span>
            </div>
          )}
        </PpSectionCard>

        <PpSectionCard
          title="工作区"
          desc="构建会把默认工作区里的文件移动到目标工作区；执行时自动构建。"
          right={
            <button
              type="button"
              className="pp-title-link"
              title="在访达中打开工作区"
              disabled={revealing}
              onClick={() => void revealWorkspace()}
            >
              {revealing ? <PpSpinner /> : <Icon icon={FolderOpen} size={12} />}
              查看
            </button>
          }
        >
          <div className="pp-kv pp-workspace-kv">
            <span>当前生效</span>
            <span className="pp-mono pp-path">{detail.activeWorkspace}</span>
            <span>默认工作区</span>
            <span className="pp-mono pp-path">{detail.defaultWorkspace}</span>
            <span>最近构建</span>
            <span>
              {detail.config.workspace.builtAt
                ? formatDateTime(detail.config.workspace.builtAt)
                : '尚未构建'}
            </span>
            <span>记忆</span>
            <span>{person.memoryCount} 条</span>
          </div>
        </PpSectionCard>
      </div>

      <PpSectionCard
        title="最近动态"
        desc="任务、队列、构建与配置变更记录。"
        right={
          <button
            type="button"
            className="pp-title-link"
            onClick={() => setAllLogsOpen(true)}
          >
            全部日志 <span aria-hidden>→</span>
          </button>
        }
      >
        <div className="pp-activity">
          {detail.activity.length === 0 ? (
            <div className="pp-empty small">
              <Activity size={22} />
              <span>还没有动态</span>
            </div>
          ) : (
            detail.activity.slice(0, 10).map((entry: PersonActivity) => (
              <div key={entry.id} className={`pp-activity-item ${toneOfActivity(entry.type)}`}>
                <span className="pp-activity-icon">
                  <Icon icon={activityIcon(entry.type)} size={13} />
                </span>
                <span className="pp-activity-text">{entry.text}</span>
                <span className="pp-activity-time">{relativeTime(entry.ts)}</span>
              </div>
            ))
          )}
        </div>
      </PpSectionCard>

      {deleteTarget ? (
        <ConfirmDialog
          title="删除任务"
          message={`确定从任务看板删除「${deleteTarget.title}」吗？${
            deleteTarget.status === 'completed' ? '已完成的执行结果也会一起删除。' : ''
          }`}
          confirmLabel="删除任务"
          danger
          busy={deleting}
          onConfirm={() => void removeTask()}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {allTasksOpen ? (
        <Dialog
          title={`全部任务（${tasks.length}）`}
          width={900}
          onClose={() => setAllTasksOpen(false)}
          footer={
            <button
              type="button"
              className="pp-btn"
              onClick={() => setAllTasksOpen(false)}
            >
              关闭
            </button>
          }
        >
          {tasks.length === 0 ? (
            <div className="pp-empty">
              <ListTodo size={26} />
              <span>任务看板还是空的</span>
            </div>
          ) : (
            <div className="pp-task-modal">
              <div className="pp-task-list">{tasks.map(renderTaskRow)}</div>
            </div>
          )}
        </Dialog>
      ) : null}

      {allLogsOpen ? (
        <Dialog
          title="全部日志"
          width={760}
          onClose={() => setAllLogsOpen(false)}
          footer={
            <button
              type="button"
              className="pp-btn"
              onClick={() => setAllLogsOpen(false)}
            >
              关闭
            </button>
          }
        >
          {detail.activity.length === 0 ? (
            <div className="pp-empty">
              <Activity size={26} />
              <span>还没有日志</span>
            </div>
          ) : (
            <div className="pp-log-modal">
              {detail.activity.map((entry: PersonActivity) => (
                <div
                  key={entry.id}
                  className={`pp-log-row ${toneOfActivity(entry.type)}`}
                >
                  <span className="pp-log-time">{formatDateTime(entry.ts)}</span>
                  <span className="pp-log-icon">
                    <Icon icon={activityIcon(entry.type)} size={13} />
                  </span>
                  <span className="pp-log-text">{entry.text}</span>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      ) : null}

      {reportModal ? (
        <Dialog
          title={`任务报表 · ${reportModal.title}`}
          width={900}
          onClose={() => setReportModal(null)}
          footer={
            <button type="button" className="pp-btn" onClick={() => setReportModal(null)}>
              关闭
            </button>
          }
        >
          {reportModal.artifactTitle ? (
            <div className="pp-report-title">{reportModal.artifactTitle}</div>
          ) : null}
          <div className="pp-report-meta">报表文件：{reportModal.path}</div>
          <div className="pp-report-modal">
            <Markdown text={reportModal.content} />
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
