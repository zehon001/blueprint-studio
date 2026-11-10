/**
 * 概览：任务执行统计、当前任务、最近一次执行与人员动态。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Archive,
  Brain,
  CheckCircle2,
  CircleX,
  FolderOpen,
  Image,
  Play,
  RotateCcw,
  Send,
  Settings2,
  Square,
  UserPlus,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonActivity, PersonDetail, PersonSummary } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { personnelApi } from './api'
import { formatDateTime, formatDuration, relativeTime, runStatusMeta } from './format'
import { PpSectionCard, PpSpinner, PpStatus } from './primitives'

interface OverviewTabProps {
  person: PersonSummary
  detail: PersonDetail
  busy: boolean
  onRefresh: () => Promise<void>
  onDispatch: (task: string) => void
}

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  run_started: Play,
  run_completed: CheckCircle2,
  run_failed: XCircle,
  run_stopped: Square,
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
  if (type === 'run_completed') return 'success'
  if (type === 'run_failed') return 'error'
  if (type === 'run_started' || type === 'run_stopped') return 'warning'
  return ''
}

export function OverviewTab(props: OverviewTabProps) {
  const task = props.detail.config.task
  const [taskDraft, setTaskDraft] = useState(task)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTaskDraft(task)
  }, [task, props.person.id])

  const dirty = taskDraft !== task
  const run = props.person.run
  const meta = runStatusMeta(run.status)
  const stats = props.person.stats

  const statCards = useMemo(
    () => [
      { label: '执行次数', value: stats.runs, icon: Play },
      { label: '完成', value: stats.completed, icon: CheckCircle2 },
      { label: '失败', value: stats.failed, icon: CircleX },
      { label: '角色卡', value: props.person.roleCardCount, icon: UserPlus },
    ],
    [props.person.roleCardCount, stats.completed, stats.failed, stats.runs],
  )

  const saveTask = async (): Promise<void> => {
    setSaving(true)
    try {
      await personnelApi.update(props.person.id, { task: taskDraft })
      toast.success('任务已保存，并写入工作区 AGENTS.md 与 TASK.md')
      await props.onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存任务失败')
    } finally {
      setSaving(false)
    }
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

      <div className="pp-two-col">
        <PpSectionCard
          title="当前任务"
          desc="任务会写入 AGENTS.md（执行入口）与 TASK.md（记录）；会话启动只读取 AGENTS.md。"
          right={
            <div className="pp-card-right">
              <button
                type="button"
                className="pp-btn sm"
                onClick={() => void saveTask()}
                disabled={props.busy || saving || !dirty}
              >
                {saving ? <PpSpinner /> : null}
                {dirty ? '保存任务' : '已保存'}
              </button>
              <button
                type="button"
                className="pp-btn primary sm"
                onClick={() => props.onDispatch(taskDraft)}
                disabled={props.busy || saving || !taskDraft.trim()}
                title="保存任务并立即构建工作区、启动 DSH 会话"
              >
                <Send size={13} />
                派发并执行
              </button>
            </div>
          }
        >
          <textarea
            className="pp-textarea pp-task-textarea"
            value={taskDraft}
            disabled={props.busy}
            placeholder="写清楚这位人员要做什么、验收标准是什么…"
            onChange={(e) => setTaskDraft(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="pp-inline-meta">
            <span>{taskDraft.length} 字</span>
            <span>派发后自动构建工作区；会话读取 AGENTS.md</span>
          </div>
        </PpSectionCard>

        <PpSectionCard
          title="最近一次执行"
          desc="会话被删除后重新执行时，会从 STATE.md 与 memory/ 续接。"
          right={<PpStatus tone={meta.tone} label={meta.label} />}
        >
          {run.startedAt ? (
            <div className="pp-run-info">
              <div className="pp-kv">
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
                  <pre className="pp-reply">{run.lastReply}</pre>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="pp-empty small">
              <Play size={22} />
              <span>还没有执行记录。点击右上角「执行」开始。</span>
            </div>
          )}
        </PpSectionCard>
      </div>

      <PpSectionCard
        title="工作区"
        desc="构建会把默认工作区里的文件移动到目标工作区；执行时自动构建。"
      >
        <div className="pp-kv pp-workspace-kv">
          <span>当前生效</span>
          <span className="pp-mono pp-path">{props.detail.activeWorkspace}</span>
          <span>默认工作区</span>
          <span className="pp-mono pp-path">{props.detail.defaultWorkspace}</span>
          <span>最近构建</span>
          <span>{props.detail.config.workspace.builtAt ? formatDateTime(props.detail.config.workspace.builtAt) : '尚未构建'}</span>
          <span>记忆</span>
          <span>{props.person.memoryCount} 条</span>
        </div>
      </PpSectionCard>

      <PpSectionCard title="动态" desc="人员创建、构建、执行、停止与配置变更记录。">
        <div className="pp-activity">
          {props.detail.activity.length === 0 ? (
            <div className="pp-empty small">
              <Activity size={22} />
              <span>还没有动态</span>
            </div>
          ) : (
            props.detail.activity.slice(0, 40).map((entry: PersonActivity) => (
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
    </div>
  )
}
