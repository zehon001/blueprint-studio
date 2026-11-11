/**
 * 人员看板事件刷新：只替换服务端动态字段，保留正在编辑的本地草稿。
 */
import type { PersonDetail } from '@/shared/personnel'

/**
 * 合并看板快照。
 * 卡片 / 规范 / 配置可能正在编辑且尚未保存；后台刷新整体替换 detail 会冲掉草稿，
 * 因此这里只覆盖任务、队列、运行状态、记忆与动态记录。
 */
export function mergePersonBoardSnapshot(prev: PersonDetail, next: PersonDetail): PersonDetail {
  return {
    ...prev,
    memory: next.memory,
    memoryCount: next.memoryCount,
    roleCardCount: next.roleCardCount,
    stats: next.stats,
    run: next.run,
    queue: next.queue,
    taskCounts: next.taskCounts,
    tasks: next.tasks,
    activity: next.activity,
  }
}
