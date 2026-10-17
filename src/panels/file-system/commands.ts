/**
 * 文件系统命令域（T0.7 · PLAN §6.3 filesystem 域）
 *
 * 设计（对应任务卡「撤销支持」）：
 *  - filesystem 域状态 = 最近操作日志 FsOp[]（时间序，上限 100，超出丢最旧）；
 *  - 面板所有「文件级结构操作」（新建 / 重命名 / 删除 / 导入 / 复制）先执行磁盘 REST，
 *    成功后 runCommand('filesystem', label, recipe) 把操作入日志（immer patch 可重放）；
 *  - undo/redo 时命令栈重放日志补丁，本模块的 startFsUndoSync 订阅 subscribeReplay，
 *    对被移出 / 加回的日志条目执行对应的磁盘逆 / 正操作：
 *      rename → move 回去 / 再 move 过去；create → 删除 / 按模板重建；import → 删除 / 再导入；
 *      delete 的 undo = 内容已不在，标记「需从 .history 快照恢复（T7.4 提供）」提示。
 *  - 内容级 undo 不在本卡（内容编辑保存属后续卡）；.history 快照恢复属 T7.4。
 *
 * 磁盘补偿在补丁应用之后异步执行：失败只 toast 报错并刷新树（SSE watch 也会兜底刷新），
 * 不回滚命令栈（与 Godot「文件级撤销尽力而为 + 快照兜底」一致）。
 */
import {
  getDomainState,
  isDomainRegistered,
  registerDomainState,
  runCommand,
  subscribeReplay,
  type ReplayNotice,
  type RunCommandResult,
} from '@/shell/commands'
import { errorMessage, type FsApi, defaultFsApi } from './api'
import { baseName, contentForNewFile, joinPosix, parentOf, type NewFileTemplate } from './paths'

/* ============================================================
 * 域状态：最近操作日志
 * ============================================================ */

export type FsOpKind = 'create' | 'rename' | 'delete' | 'import'

/** 一条文件级结构操作（入日志；字段按 kind 取用） */
export interface FsOp {
  kind: FsOpKind
  /** 命令名（撤销/重做菜单展示，与 runCommand 的 label 一致） */
  label: string
  /** 操作时间（ISO） */
  ts: string
  /** create / import：落盘目标路径；delete：被删路径 */
  path?: string
  /** rename：from → to */
  from?: string
  to?: string
  /** create：目标种类（dir 用占位文件法建目录） */
  targetKind?: 'file' | 'dir'
  /** create(file)：模板类别（ui/bp 确定性重建；text 用 content 原样回写） */
  template?: NewFileTemplate
  /** create(text)（拖入导入等客户端写入的文本）：重做时回写 */
  content?: string
  /** import：服务端本地绝对来源路径（重做时再次导入） */
  sourcePath?: string
  /** delete：被删对象种类（提示文案用） */
  wasKind?: 'file' | 'dir'
}

/** filesystem 域状态 */
export interface FsDomainState {
  /** 最近操作日志（时间序；上限 100 条，超出丢最旧） */
  ops: FsOp[]
}

export const FS_OP_LOG_LIMIT = 100

/** 向日志追加一条（immer recipe 内调用；超出上限丢最旧） */
export function pushOp(draft: FsDomainState, op: FsOp): void {
  draft.ops.push(op)
  if (draft.ops.length > FS_OP_LOG_LIMIT) {
    draft.ops.splice(0, draft.ops.length - FS_OP_LOG_LIMIT)
  }
}

/** 挂载 filesystem 域（幂等；重复调用不重置历史） */
export function registerFsDomain(): void {
  if (!isDomainRegistered('filesystem')) {
    registerDomainState('filesystem', { ops: [] })
  }
}

/**
 * 执行一条文件系统命令（磁盘操作由调用方先行完成，成功后才入栈）。
 * label 同时作为撤销菜单文案与日志条目 label。
 * 入栈后同步推进日志镜像（undo/redo 的尾差分依赖镜像与命令栈严格同步）。
 */
export function runFsCommand(label: string, op: Omit<FsOp, 'label' | 'ts'>): RunCommandResult {
  registerFsDomain()
  const result = runCommand<FsDomainState>('filesystem', label, (draft) => {
    pushOp(draft, { ...op, label, ts: new Date().toISOString() })
  })
  if (result.changed) opMirror = [...currentOps()]
  return result
}

/* ============================================================
 * undo / redo 的磁盘动作映射（纯函数，单测覆盖）
 * ============================================================ */

/** undo / redo 需要在磁盘上执行的动作（performDiskAction 解释执行） */
export type FsDiskAction =
  | { action: 'move'; from: string; to: string }
  | { action: 'write'; path: string; content: string }
  | { action: 'delete'; path: string }
  | { action: 'mkdir'; path: string }
  | { action: 'import'; targetDir: string; sourcePath: string }
  | { action: 'unavailable'; message: string }

/** undo：按 kind 构造逆操作 */
export function inverseActionOf(op: FsOp): FsDiskAction {
  switch (op.kind) {
    case 'rename':
      return { action: 'move', from: op.to ?? '', to: op.from ?? '' }
    case 'create':
    case 'import':
      // create/import 的逆操作都是「删掉落盘产物」；目标已不存在时服务端 404 → toast 说明
      return { action: 'delete', path: op.path ?? '' }
    case 'delete':
      return {
        action: 'unavailable',
        message: '「删除」的内容级撤销需从 .history 快照恢复（T7.4 提供），本期暂无法撤销删除。',
      }
  }
}

/** redo：按 kind 重放正向操作 */
export function redoActionOf(op: FsOp): FsDiskAction {
  switch (op.kind) {
    case 'rename':
      return { action: 'move', from: op.from ?? '', to: op.to ?? '' }
    case 'create':
      return op.targetKind === 'dir'
        ? { action: 'mkdir', path: op.path ?? '' }
        : { action: 'write', path: op.path ?? '', content: contentForCreate(op) }
    case 'import':
      return { action: 'import', targetDir: parentOf(op.path ?? ''), sourcePath: op.sourcePath ?? '' }
    case 'delete':
      return { action: 'delete', path: op.path ?? '' }
  }
}

/** create 操作对应的写入内容（ui/bp 用确定性模板重建；text 用记录的内容） */
export function contentForCreate(op: FsOp): string {
  if (op.template === 'ui' || op.template === 'bp') {
    return contentForNewFile(baseName(op.path ?? ''))
  }
  return op.content ?? ''
}

/**
 * 日志尾差分：undo 时被移出的条目 / redo 时加回的条目。
 * 结构对不上（域被重挂载等异常情况）时两个方向都返回 null，调用方只刷新树不做磁盘补偿。
 */
export interface FsLogDiff {
  removed: FsOp | null
  added: FsOp | null
}

function sameOp(a: FsOp, b: FsOp): boolean {
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.ts === b.ts &&
    a.path === b.path &&
    a.from === b.from &&
    a.to === b.to &&
    a.targetKind === b.targetKind &&
    a.template === b.template &&
    a.content === b.content &&
    a.sourcePath === b.sourcePath &&
    a.wasKind === b.wasKind
  )
}

export function diffLogTail(before: readonly FsOp[], after: readonly FsOp[]): FsLogDiff {
  if (after.length === before.length) return { removed: null, added: null }
  if (after.length === before.length - 1) {
    let headEqual = true
    for (let i = 0; i < after.length; i++) {
      if (!sameOp(before[i], after[i])) {
        headEqual = false
        break
      }
    }
    if (headEqual) return { removed: before[before.length - 1] ?? null, added: null }
  }
  if (before.length === after.length - 1) {
    let headEqual = true
    for (let i = 0; i < before.length; i++) {
      if (!sameOp(before[i], after[i])) {
        headEqual = false
        break
      }
    }
    if (headEqual) return { removed: null, added: after[after.length - 1] ?? null }
  }
  return { removed: null, added: null }
}

/* ============================================================
 * 磁盘动作执行
 * ============================================================ */

/**
 * 建空目录：服务端无 mkdir 端点，用「写占位文件（自动建父目录）→ 删占位文件」实现，
 * 空目录留在磁盘上。占位名带随机尾避免与已有文件冲突。
 */
export async function mkdirViaPlaceholder(dirPath: string, api: FsApi = defaultFsApi): Promise<void> {
  const marker = joinPosix(dirPath, `.bps-mkdir-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await api.writeFile(marker, '')
  try {
    await api.deletePath(marker)
  } catch {
    // 占位文件删除失败：目录已建成，残留文件经刷新可见，不阻断主流程
    console.warn(`[file-system] 建目录占位文件删除失败：${marker}`)
  }
}

/** 执行一个磁盘动作；失败抛 FsApiError（由调用方 toast），unavailable 由调用方单独处理 */
export async function performDiskAction(action: FsDiskAction, api: FsApi = defaultFsApi): Promise<void> {
  switch (action.action) {
    case 'move':
      await api.move(action.from, action.to)
      return
    case 'write':
      await api.writeFile(action.path, action.content)
      return
    case 'delete':
      await api.deletePath(action.path)
      return
    case 'mkdir':
      await mkdirViaPlaceholder(action.path, api)
      return
    case 'import':
      await api.importFile(action.targetDir, action.sourcePath)
      return
    case 'unavailable':
      return
  }
}

/* ============================================================
 * undo/redo 同步（模块级单例：面板关闭时撤销依然落盘）
 * ============================================================ */

export type FsNoticeKind = 'success' | 'error' | 'info'

/** 撤销/重做的执行结果通知（面板渲染成 toast；面板未挂载时丢弃） */
export interface FsNotice {
  kind: FsNoticeKind
  text: string
}

const noticeListeners = new Set<(n: FsNotice) => void>()

/** 订阅通知（返回解绑函数） */
export function onFsNotice(listener: (n: FsNotice) => void): () => void {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

function emitNotice(notice: FsNotice): void {
  for (const listener of noticeListeners) {
    try {
      listener(notice)
    } catch {
      /* 单个订阅者失败不阻断 */
    }
  }
}

const refreshListeners = new Set<() => void>()

/** 订阅「文件级 undo/redo 磁盘补偿完成，请刷新树」通知（返回解绑函数） */
export function onFsRefresh(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => {
    refreshListeners.delete(listener)
  }
}

function emitRefresh(): void {
  for (const listener of refreshListeners) {
    try {
      listener()
    } catch {
      /* 单个订阅者失败不阻断 */
    }
  }
}

let syncStarted = false
/** 已入栈日志的镜像（与命令栈同步推进，用于尾差分定位被 undo/redo 的条目） */
let opMirror: FsOp[] = []

function currentOps(): FsOp[] {
  if (!isDomainRegistered('filesystem')) return []
  return getDomainState<FsDomainState>('filesystem').ops
}

function handleReplay(notice: ReplayNotice, api: FsApi): void {
  if (!notice.domains.includes('filesystem')) return
  const ops = currentOps()
  const diff = diffLogTail(opMirror, ops)
  opMirror = [...ops]

  if (notice.op === 'undo' && diff.removed) {
    const action = inverseActionOf(diff.removed)
    if (action.action === 'unavailable') {
      emitNotice({ kind: 'info', text: action.message })
      emitRefresh()
      return
    }
    void performDiskAction(action, api)
      .then(() => emitNotice({ kind: 'success', text: `已撤销：${notice.label}` }))
      .catch((e: unknown) => emitNotice({ kind: 'error', text: `撤销「${notice.label}」失败：${errorMessage(e)}` }))
      .finally(() => emitRefresh())
    return
  }
  if (notice.op === 'redo' && diff.added) {
    const action = redoActionOf(diff.added)
    void performDiskAction(action, api)
      .then(() => emitNotice({ kind: 'success', text: `已重做：${notice.label}` }))
      .catch((e: unknown) => emitNotice({ kind: 'error', text: `重做「${notice.label}」失败：${errorMessage(e)}` }))
      .finally(() => emitRefresh())
    return
  }
  // 结构对不上（域重挂载等）：至少刷新树保持与磁盘一致
  emitRefresh()
}

/**
 * 启动 undo/redo 磁盘补偿同步（模块级一次；在 registerFileSystemPanel() 中调用）。
 * 面板即使被关闭/卸载，filesystem 域命令的撤销依然会落盘。
 */
export function startFsUndoSync(api: FsApi = defaultFsApi): void {
  if (syncStarted) return
  syncStarted = true
  registerFsDomain()
  opMirror = [...currentOps()]
  subscribeReplay((notice) => handleReplay(notice, api))
}

/** 测试重置（与 commands 的 resetEditorStore 搭配使用） */
export function __resetFsUndoSyncForTests(): void {
  syncStarted = false
  opMirror = []
}
