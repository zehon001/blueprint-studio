/**
 * 人员模块共享类型（前端页面 ↔ 服务端存储 / DSH 执行）。
 *
 * 说明：人员配置、角色卡、规范与运行状态全部落在人员的工作区目录里；
 * 这里仅定义跨端复用的数据结构，不包含任何运行时逻辑。
 */

/** 当前支持的 Agent 平台（人员执行固定走 DSH） */
export const PERSON_PLATFORMS = ['dsh'] as const
export type PersonPlatform = (typeof PERSON_PLATFORMS)[number]

/** 角色卡：一张卡对应一段人设 / 职责描述 */
export interface RoleCard {
  id: string
  name: string
  tags: string[]
  content: string
  updatedAt?: number
}

/** 人员类型（全局分类，保存在人员根目录 types.json） */
export type PersonArtifactKind = 'markdown' | 'json' | 'csv' | 'image' | 'file'

/** 类型级交付要求：产物目录、允许的产物类型、是否必须有产物 */
export interface PersonDeliveryConfig {
  dir: string
  artifactKinds: PersonArtifactKind[]
  required: boolean
  naming?: string
}

export interface PersonType {
  id: string
  name: string
  delivery?: PersonDeliveryConfig
}

/** 模型设置 */
export interface PersonModelSettings {
  platform: PersonPlatform
  model: string
  reasoning: string
  permission: string
}

/** 工作区设置 */
export interface PersonWorkspaceSettings {
  /** 用户选择的工作区目录；空 = 使用默认工作区 */
  dir: string
  /** DSH 会话标题；空 = 自动生成 */
  sessionTitle: string
  /** 执行完毕后是否归档会话 */
  deleteSessionAfterRun: boolean
  /** 是否复用上一次会话 */
  reuseSession: boolean
  /** 最近一次构建工作区的时间 */
  builtAt?: number
}

/** 人员统计（概览页卡片） */
export interface PersonStats {
  runs: number
  completed: number
  failed: number
  lastRunAt?: number
}

/** 人员配置（.person/config.json） */
export interface PersonConfig {
  id: string
  name: string
  typeId: string
  /** 头像文件名（.person/avatar.*） */
  avatarFile?: string
  createdAt: number
  updatedAt: number
  /** 当前执行任务（写入 AGENTS.md / TASK.md） */
  task: string
  /** 当前使用的角色卡（多张卡只选一张生效） */
  currentCardId?: string
  model: PersonModelSettings
  workspace: PersonWorkspaceSettings
  stats: PersonStats
}

/** 执行状态 */
export type PersonRunStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped'

/** 当前 / 最近一次执行 */
export interface PersonRunState {
  status: PersonRunStatus
  runId?: string
  /** 当前执行的任务 */
  taskId?: string
  taskTitle?: string
  sessionId?: string
  sessionTitle?: string
  startedAt?: number
  finishedAt?: number
  /** 最终回复（截断后） */
  lastReply?: string
  /** 失败 / 停止原因 */
  error?: string
  workspaceDir?: string
}

/** 任务状态 */
export type PersonTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

/** 任务看板中的一条任务 */
export interface PersonArtifact {
  /** 相对工作区的路径 */
  path: string
  kind: PersonArtifactKind
  title?: string
}

export interface PersonTask {
  id: string
  title: string
  content: string
  status: PersonTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  error?: string
  artifacts?: PersonArtifact[]
}

/** 队列状态 */
export type PersonQueueStatus = 'idle' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed'

/** 任务队列执行状态 */
export interface PersonQueueState {
  status: PersonQueueStatus
  queueId?: string
  /** 本队列包含的任务 id（执行期间新增的任务也会追加） */
  taskIds?: string[]
  currentTaskId?: string
  /** 当前执行到第几个（1 起） */
  currentIndex?: number
  total: number
  completed: number
  failed: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

/** 任务数量统计 */
export interface PersonTaskCounts {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
  stopped: number
}

/** 动态记录（.person/activity.jsonl） */
export interface PersonActivity {
  id: string
  type: string
  text: string
  ts: number
}

/** 记忆文件摘要 */
export interface PersonMemoryFile {
  name: string
  size: number
  preview: string
}

/** 记忆快照（来自工作区 memory/ 目录） */
export interface PersonMemory {
  text: string
  files: PersonMemoryFile[]
  count: number
  updatedAt?: number
}

/** 人员列表项 */
export interface PersonSummary {
  id: string
  name: string
  typeId: string
  avatarUrl: string
  createdAt: number
  updatedAt: number
  defaultWorkspace: string
  activeWorkspace: string
  roleCardCount: number
  memoryCount: number
  stats: PersonStats
  run: PersonRunState
  queue: PersonQueueState
  taskCounts: PersonTaskCounts
}

/** 人员详情（编辑页） */
export interface PersonDetail extends PersonSummary {
  config: PersonConfig
  cards: RoleCard[]
  norms: string
  tasks: PersonTask[]
  memory: PersonMemory
  activity: PersonActivity[]
}
