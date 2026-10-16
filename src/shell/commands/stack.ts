/**
 * 统一命令栈 API（T0.5 · PLAN §6.3 命令栈契约）
 *
 * 统一单栈：跨域命令按时间序混排在同一个 undo/redo 栈中（Godot 习惯：
 * 全局时间线撤销，而非每域独立栈）；undo/redo 时按条目携带的 domain 把补丁
 * 重放到对应 store 切片，并给出「本次重放影响的 domain」列表。
 *
 * 后续业务域（蓝图 / UI 树 / 检视器 / 文件系统面板）接入方式：
 *   1. 打开资产或面板初始化时挂载状态：registerDomainState('blueprint', initialState)
 *   2. 所有用户操作经命令入栈：runCommand('blueprint', '添加节点', (draft) => { ... })
 *   3. 撤销/重做（顶栏按钮 / 快捷键）：undo() / redo()，返回 ReplayNotice，
 *      其中 domains 为受影响命令域列表；也可 subscribeReplay 订阅，
 *      或 React 侧 useEditorStore((s) => s.lastReplay)
 *   4. canUndo / canRedo 可订阅：useEditorStore((s) => s.undoStack.length > 0)
 *      或直接用 useCanUndo() / useCanRedo()
 *
 * 约束：域状态只允许经本 API 变更（保证补丁可重放）；域状态须为 immer 可处理的
 * 普通对象/数组（Map/Set 需另行 enableMapSet，当前未开启）。
 */
import { applyPatches, produceWithPatches, type Draft } from 'immer'
import { useEditorStore } from './editor-store'
import type {
  Command,
  CommandDomain,
  CommandEntry,
  HistoryMeta,
  ReplayNotice,
  RunCommandResult,
} from './types'

/* ---------------- 重放通知（undo/redo 影响了哪些域） ---------------- */

const replayListeners = new Set<(notice: ReplayNotice) => void>()

/** 订阅 undo/redo 重放通知（面板命令式刷新用），返回解绑函数 */
export function subscribeReplay(listener: (notice: ReplayNotice) => void): () => void {
  replayListeners.add(listener)
  return () => {
    replayListeners.delete(listener)
  }
}

function emitReplay(notice: ReplayNotice): void {
  for (const listener of replayListeners) {
    try {
      listener(notice)
    } catch (err) {
      // 单个面板刷新失败不阻断其余面板，也不打断命令栈
      console.error('[command-stack] 重放通知回调执行失败', err)
    }
  }
}

/* ---------------- 域注册与读取 ---------------- */

/**
 * 挂载命令域初始状态（幂等守卫：未注册域执行命令会报错）。
 * 重挂载（如重新打开资产）会替换该域状态，并从两栈中剔除该域的历史条目
 * （旧补丁对新状态不再适用），其余域条目保持时间序不动。
 */
export function registerDomainState<S>(domain: CommandDomain, initial: S): void {
  const s = useEditorStore.getState()
  const existed = domain in s.domains
  useEditorStore.setState({
    domains: { ...s.domains, [domain]: initial },
    undoStack: existed ? s.undoStack.filter((e) => e.domain !== domain) : s.undoStack,
    redoStack: existed ? s.redoStack.filter((e) => e.domain !== domain) : s.redoStack,
  })
}

/** 域是否已挂载 */
export function isDomainRegistered(domain: CommandDomain): boolean {
  return domain in useEditorStore.getState().domains
}

function requireDomain(domain: CommandDomain): unknown {
  const { domains } = useEditorStore.getState()
  if (!(domain in domains)) {
    throw new Error(`[command-stack] 命令域未注册：${domain}（请先 registerDomainState）`)
  }
  return domains[domain]
}

/** 读取域当前状态；未注册域抛错 */
export function getDomainState<S = unknown>(domain: CommandDomain): S {
  return requireDomain(domain) as S
}

/* ---------------- 命令执行 ---------------- */

/** 执行命令（PLAN §6.3 契约形式）：apply 生成补丁入栈并应用 */
export function runCommandBy<S = unknown>(command: Command<S>): RunCommandResult {
  const before = requireDomain(command.domain) as S
  const [next, patches, inversePatches] = produceWithPatches(before, (draft: Draft<S>) => {
    command.apply(draft)
  })
  if (patches.length === 0) {
    // 空配方（无任何实际变更）不入栈，避免污染撤销历史
    return { domain: command.domain, changed: false }
  }
  const entry: CommandEntry = {
    label: command.label,
    domain: command.domain,
    patches,
    inversePatches,
    ...(command.describe ? { detail: command.describe(next) } : {}),
  }
  const s = useEditorStore.getState()
  useEditorStore.setState({
    domains: { ...s.domains, [command.domain]: next },
    undoStack: [...s.undoStack, entry],
    redoStack: [], // 新命令截断重做分支（通用编辑器习惯）
  })
  return { domain: command.domain, changed: true }
}

/** 执行命令（简洁形式）：runCommand(domain, label, recipe) */
export function runCommand<S = unknown>(
  domain: CommandDomain,
  label: string,
  recipe: (draft: Draft<S>) => void,
): RunCommandResult {
  return runCommandBy<S>({ domain, label, apply: recipe })
}

/* ---------------- 撤销 / 重做 ---------------- */

/** 撤销：栈顶命令的 inversePatches 重放到其域；返回受影响域报告（空栈返回 null） */
export function undo(): ReplayNotice | null {
  const s = useEditorStore.getState()
  const entry = s.undoStack[s.undoStack.length - 1]
  if (!entry) return null
  const next = applyPatches(getDomainState(entry.domain) as object, entry.inversePatches)
  const notice: ReplayNotice = { op: 'undo', domains: [entry.domain], label: entry.label }
  useEditorStore.setState({
    domains: { ...s.domains, [entry.domain]: next },
    undoStack: s.undoStack.slice(0, -1),
    redoStack: [...s.redoStack, entry],
    lastReplay: notice,
  })
  emitReplay(notice)
  return notice
}

/** 重做：重做栈顶命令的 patches 重放到其域；返回受影响域报告（空栈返回 null） */
export function redo(): ReplayNotice | null {
  const s = useEditorStore.getState()
  const entry = s.redoStack[s.redoStack.length - 1]
  if (!entry) return null
  const next = applyPatches(getDomainState(entry.domain) as object, entry.patches)
  const notice: ReplayNotice = { op: 'redo', domains: [entry.domain], label: entry.label }
  useEditorStore.setState({
    domains: { ...s.domains, [entry.domain]: next },
    undoStack: [...s.undoStack, entry],
    redoStack: s.redoStack.slice(0, -1),
    lastReplay: notice,
  })
  emitReplay(notice)
  return notice
}

/* ---------------- 栈查询（可订阅：经 useEditorStore 选择器） ---------------- */

export function canUndo(): boolean {
  return useEditorStore.getState().undoStack.length > 0
}

export function canRedo(): boolean {
  return useEditorStore.getState().redoStack.length > 0
}

function toMeta(e: CommandEntry): HistoryMeta {
  return { label: e.label, domain: e.domain, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
}

/** 栈顶待撤销命令摘要（撤销菜单 tooltip 用）；空栈返回 null */
export function peekUndo(): HistoryMeta | null {
  const s = useEditorStore.getState()
  const entry = s.undoStack[s.undoStack.length - 1]
  return entry ? toMeta(entry) : null
}

/** 栈顶待重做命令摘要；空栈返回 null */
export function peekRedo(): HistoryMeta | null {
  const s = useEditorStore.getState()
  const entry = s.redoStack[s.redoStack.length - 1]
  return entry ? toMeta(entry) : null
}

/** 完整历史（undo 按时间正序；redo 已倒序 = 下一个重做的在最前）；历史面板用 */
export function getHistory(): { undo: HistoryMeta[]; redo: HistoryMeta[] } {
  const s = useEditorStore.getState()
  return { undo: s.undoStack.map(toMeta), redo: [...s.redoStack].reverse().map(toMeta) }
}

/** 清空全部域状态与历史（关闭/切换项目、测试重置时调用；重放订阅不受影响） */
export function resetEditorStore(): void {
  useEditorStore.setState({ domains: {}, undoStack: [], redoStack: [], lastReplay: null })
}

/* ---------------- React 侧便捷订阅 ---------------- */

/** 订阅某域状态（React hook；域未注册时返回 undefined） */
export function useDomainState<S = unknown>(domain: CommandDomain): S {
  return useEditorStore((s) => s.domains[domain]) as S
}

/** 可撤销（React hook） */
export function useCanUndo(): boolean {
  return useEditorStore((s) => s.undoStack.length > 0)
}

/** 可重做（React hook） */
export function useCanRedo(): boolean {
  return useEditorStore((s) => s.redoStack.length > 0)
}
