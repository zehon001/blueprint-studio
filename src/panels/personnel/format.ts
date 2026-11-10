/** 人员页时间 / 状态格式化（纯函数，便于复用与测试）。 */
import type { PersonRunStatus } from '@/shared/personnel'

export function relativeTime(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDuration(start?: number, end?: number): string {
  if (!start) return '—'
  const ms = Math.max(0, (end ?? Date.now()) - start)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

export interface RunStatusMeta {
  label: string
  tone: 'idle' | 'running' | 'success' | 'error' | 'warning'
}

export function runStatusMeta(status: PersonRunStatus): RunStatusMeta {
  switch (status) {
    case 'running':
      return { label: '执行中', tone: 'running' }
    case 'stopping':
      return { label: '停止中', tone: 'warning' }
    case 'completed':
      return { label: '已完成', tone: 'success' }
    case 'failed':
      return { label: '失败', tone: 'error' }
    case 'stopped':
      return { label: '已停止', tone: 'warning' }
    default:
      return { label: '空闲', tone: 'idle' }
  }
}
