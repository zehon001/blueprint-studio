/**
 * 业务 store 双向桥接（T0.4 · PLAN §3.1 状态同步：action 广播按序重放，各窗口一致）
 *
 * 主窗（业务状态唯一写者）：
 *   - workspace-store 变更 → 全量快照广播（小状态；JSON 去重避免空转 burn seq）；
 *   - editorStore 变更 → 按变更来源打补丁广播：
 *       runCommand（undoStack 增长）→ domain-patch(entry.patches)
 *       undo / redo（lastReplay 变化）→ domain-patch(逆 / 正补丁)
 *       registerDomainState / 外部 setState / 新增移除域 → domain-reset(整体状态)
 *       undo / redo 栈长度变化 → history 摘要
 *   - 弹窗动作（action）→ interpretAction 在主窗执行（写冲突由「单写者」模型天然规避）；
 *   - 弹窗 hello / 未知会话 ping → 回全量快照（baseline）；
 *     ping → pong；bye → 面板自动合回；心跳超时 → 面板失联自动合回。
 *
 * 弹窗（镜像）：
 *   - 接收广播重放进本窗口的真实 zustand store（面板组件零改动即得一致状态）；
 *     workspace 用快照整替；命令域用 immer 补丁重放（失败 → 请求 resync 全量兜底）；
 *   - 拦截 workspace-store 的全部写 action → 转发主窗（弹窗自身不写业务状态）；
 *     命令栈操作经 sync.sendToMain({type:'cmd.*'}) 转发（弹窗不持有撤销栈，本地 undo 为空栈 no-op）。
 *
 * 撤销栈：真源在主窗。弹窗只同步 undoCount / redoCount 摘要（useWindowLinkStore），
 * 不镜像栈条目——防止弹窗本地 undo()/redo()（自由函数，无法拦截）产生分叉写。
 */
import { applyPatches, type Patch } from 'immer'
import { create } from 'zustand'
import { redo as stackRedo, runCommandBy, undo as stackUndo, useEditorStore, type CommandDomain } from '@/shell/commands'
import { useWorkspaceStore, type OpenTab, type OpenTabKind, type ProjectRef } from '@/shell/workspace-store'
import type { PeerMeta, SyncAction, SyncDataKind, WindowSync, WindowSyncOptions } from './sync'
import { createWindowSync } from './sync'
import { handlePopoutClosed, handlePopoutLost } from './popout'

/* ---------------- 同步快照载荷 ---------------- */

export interface WorkspaceSnapshot {
  currentProject: ProjectRef | null
  openTabs: OpenTab[]
  activeTabId: string | null
}

export interface HistorySummary {
  undoCount: number
  redoCount: number
}

/** hello / resync 应答：弹窗镜像的全量基线 */
export interface SnapshotPayload {
  workspace: WorkspaceSnapshot
  domains: Record<string, unknown>
  history: HistorySummary
}

/* ---------------- 弹窗侧连接状态（PopoutApp 头部展示） ---------------- */

export interface WindowLinkState {
  /** 已收到主窗消息 */
  connected: boolean
  /** 心跳超时判定主窗失联 */
  lost: boolean
  /** 主窗撤销栈摘要（弹窗不持有栈） */
  undoCount: number
  redoCount: number
  markConnected: () => void
  markLost: () => void
  setHistory: (undoCount: number, redoCount: number) => void
}

export const useWindowLinkStore = create<WindowLinkState>()((set) => ({
  connected: false,
  lost: false,
  undoCount: 0,
  redoCount: 0,
  markConnected: () => set({ connected: true, lost: false }),
  markLost: () => set({ lost: true }),
  setHistory: (undoCount, redoCount) => set({ undoCount, redoCount }),
}))

/* ---------------- 主窗：执行弹窗转发来的动作 ---------------- */

/** workspace 写 action 的结构子集（主窗安装时捕获原始实现，弹窗环境解释动作不走拦截层） */
interface WorkspaceWriteActions {
  openAsset: (input: { kind: OpenTabKind; assetPath: string; title?: string }) => void
  closeTab: (id: string) => void
  setActive: (id: string) => void
  markDirty: (id: string) => void
  clearDirty: (id: string) => void
  closeProject: () => void
}

/**
 * 主窗安装时捕获的原始 workspace 写 action。
 * 弹窗桥会拦截 store 的写 action 转发主窗；主窗解释动作必须走原始实现，
 * 否则（以及在单进程测试环境中）会二次转发造成回环。真实部署中主窗
 * 从未安装拦截，捕获值与 store 一致。
 */
let mainWorkspaceActions: WorkspaceWriteActions | null = null

/**
 * 弹窗镜像回放进行中标记：弹窗把主窗广播重放进 store 时，
 * 同窗口内的主窗订阅者（单进程测试环境共享 store）必须跳过再广播，防止回环。
 * 真实部署中弹窗与主窗的 store 是不同实例，此标记恒为 false。
 */
let applyingRemote = false

/**
 * 在主窗解释执行一个业务动作（同步协议的「reducer」）。
 * 主窗自身组件也可统一走本入口（等效于直接调 store）。
 */
export function interpretAction(action: SyncAction): void {
  const ws = mainWorkspaceActions ?? useWorkspaceStore.getState()
  switch (action.type) {
    case 'workspace.openAsset':
      ws.openAsset({
        kind: action.kind,
        assetPath: action.assetPath,
        ...(action.title !== undefined ? { title: action.title } : {}),
      })
      break
    case 'workspace.closeTab':
      ws.closeTab(action.id)
      break
    case 'workspace.setActive':
      ws.setActive(action.id)
      break
    case 'workspace.markDirty':
      ws.markDirty(action.id)
      break
    case 'workspace.clearDirty':
      ws.clearDirty(action.id)
      break
    case 'workspace.closeProject':
      ws.closeProject()
      break
    case 'cmd.runPatches':
      // 弹窗在镜像上算好补丁，主窗经命令栈执行（可撤销，与本地命令同权）
      try {
        runCommandBy({
          domain: action.domain,
          label: action.label,
          apply: (draft) => {
            applyPatches(draft as object, action.patches as Patch[])
          },
        })
      } catch (err) {
        console.error('[windows] 弹窗命令补丁执行失败', action, err)
      }
      break
    case 'cmd.undo':
      stackUndo()
      break
    case 'cmd.redo':
      stackRedo()
      break
  }
}

/* ---------------- 主窗：安装广播 / 会话管理 ---------------- */

export interface MainBridgeTestOptions
  extends Pick<WindowSyncOptions, 'channelName' | 'channelFactory' | 'now' | 'checkIntervalMs' | 'lostTimeoutMs'> {}

export interface MainBridge {
  sync: WindowSync
  /** 本主窗会话地址（= sync.sessionId；定向控制消息用，如主窗刷新后点对点重连） */
  readonly sessionId: string
  dispose: () => void
}

/** 主窗桥接：安装后主窗即成为业务状态真源与多窗同步枢纽（main.tsx 调用一次） */
export function installMainBridge(options: MainBridgeTestOptions = {}): MainBridge {
  // 捕获原始写 action（防二次转发回环，见 mainWorkspaceActions 注释）
  const s0 = useWorkspaceStore.getState()
  mainWorkspaceActions = {
    openAsset: s0.openAsset,
    closeTab: s0.closeTab,
    setActive: s0.setActive,
    markDirty: s0.markDirty,
    clearDirty: s0.clearDirty,
    closeProject: s0.closeProject,
  }
  const sync = createWindowSync('main', options.channelName, {
    ...(options.channelFactory ? { channelFactory: options.channelFactory } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.checkIntervalMs !== undefined ? { checkIntervalMs: options.checkIntervalMs } : {}),
    ...(options.lostTimeoutMs !== undefined ? { lostTimeoutMs: options.lostTimeoutMs } : {}),
    onPeerLost: (sessionId) => {
      // 心跳超时（PLAN §3.1：5s 未收到 ping）→ 失联提示 + 弹窗自动关闭 + 面板合回
      const panelId = sessionPanels.get(sessionId)
      sessionPanels.delete(sessionId)
      if (panelId) handlePopoutLost(panelId)
    },
  })

  /** 弹窗会话 → 面板（hello / ping 的 payload 登记） */
  const sessionPanels = new Map<string, string>()

  const workspacePayload = (s: ReturnType<typeof useWorkspaceStore.getState>): WorkspaceSnapshot => ({
    currentProject: s.currentProject,
    openTabs: s.openTabs,
    activeTabId: s.activeTabId,
  })

  // JSON 去重基线：安装时初始化，避免随后的 action 拦截等无业务变化的 setState 触发空广播
  let lastWorkspaceJson = JSON.stringify(workspacePayload(useWorkspaceStore.getState()))

  const buildSnapshot = (): SnapshotPayload => {
    const ws = useWorkspaceStore.getState()
    const ed = useEditorStore.getState()
    return {
      workspace: workspacePayload(ws),
      domains: { ...ed.domains },
      history: { undoCount: ed.undoStack.length, redoCount: ed.redoStack.length },
    }
  }

  const sendSnapshot = (): void => {
    sync.broadcastData('snapshot', buildSnapshot(), true)
  }

  // workspace 变更 → 快照广播（JSON 去重：不产生业务变化的 setState 不 burn seq）
  const offWorkspace = useWorkspaceStore.subscribe((s) => {
    if (applyingRemote) return // 弹窗镜像回放不回环
    const payload = workspacePayload(s)
    const json = JSON.stringify(payload)
    if (json === lastWorkspaceJson) return
    lastWorkspaceJson = json
    sync.broadcastData('workspace-state', payload)
  })

  // editorStore 变更 → 按来源打补丁广播（PLAN §3.1：主窗订阅命令栈重放与 workspace 变更）
  const offEditor = useEditorStore.subscribe((s, prev) => {
    if (applyingRemote) return // 弹窗镜像回放不回环
    if (s.undoStack.length !== prev.undoStack.length || s.redoStack.length !== prev.redoStack.length) {
      sync.broadcastData('history', { undoCount: s.undoStack.length, redoCount: s.redoStack.length })
    }
    if (s.domains === prev.domains) return

    const lastReplay = s.lastReplay // 局部 const：参数属性无法做别名条件收窄（TS 限制）
    const replayChanged = lastReplay !== prev.lastReplay && lastReplay !== null
    if (replayChanged && lastReplay.op === 'undo') {
      // 撤销：刚移入 redo 栈顶的条目，其逆补丁已被应用
      const entry = s.redoStack[s.redoStack.length - 1]
      if (entry) sync.broadcastData('domain-patch', { domain: entry.domain, patches: entry.inversePatches })
      return
    }
    if (replayChanged && lastReplay.op === 'redo') {
      // 重做：刚移入 undo 栈顶的条目，其正补丁已被应用
      const entry = s.undoStack[s.undoStack.length - 1]
      if (entry) sync.broadcastData('domain-patch', { domain: entry.domain, patches: entry.patches })
      return
    }
    if (!replayChanged && s.undoStack.length > prev.undoStack.length) {
      // 新命令：栈顶条目的正补丁已被应用
      const entry = s.undoStack[s.undoStack.length - 1]
      if (entry) sync.broadcastData('domain-patch', { domain: entry.domain, patches: entry.patches })
      return
    }
    // 非命令路径的域变更（registerDomainState / 外部 setState）：整体重置；移除的域广播 null
    for (const domain of Object.keys(s.domains) as CommandDomain[]) {
      if (s.domains[domain] !== prev.domains[domain]) {
        sync.broadcastData('domain-reset', { domain, state: s.domains[domain] })
      }
    }
    for (const domain of Object.keys(prev.domains)) {
      if (!(domain in s.domains)) {
        sync.broadcastData('domain-reset', { domain, state: null })
      }
    }
  })

  // 会话管理：hello / 未知会话 ping → 全量快照（baseline）；ping → pong；bye → 自动合回
  const offControl = sync.onControl((kind, payload, from) => {
    if (kind === 'hello' || kind === 'ping') {
      const meta = (payload ?? {}) as PeerMeta
      if (kind === 'hello' || !sessionPanels.has(from)) {
        if (meta.panelId) sessionPanels.set(from, meta.panelId)
        sendSnapshot() // 未知会话 ping = 主窗刷新后弹窗重连，重新全量同步
      }
      if (kind === 'ping') sync.sendControl('pong', undefined, from)
      return
    }
    if (kind === 'bye') {
      const meta = (payload ?? {}) as PeerMeta
      const panelId = sessionPanels.get(from) ?? meta.panelId
      sessionPanels.delete(from)
      if (panelId) handlePopoutClosed(panelId)
    }
  })

  // 弹窗有序消息：动作就地执行；resync 重发全量
  const offRemote = sync.onRemoteState((kind: SyncDataKind, payload) => {
    if (kind === 'action') {
      interpretAction(payload as SyncAction)
      return
    }
    if (kind === 'resync') sendSnapshot()
  })

  return {
    sync,
    sessionId: sync.sessionId,
    dispose: () => {
      offWorkspace()
      offEditor()
      offControl()
      offRemote()
      sessionPanels.clear()
      mainWorkspaceActions = null
      sync.close()
    },
  }
}

/* ---------------- 弹窗：镜像重放 + 写 action 拦截 ---------------- */

function applyWorkspaceSnapshot(payload: unknown): void {
  const p = (payload ?? {}) as Partial<WorkspaceSnapshot>
  useWorkspaceStore.setState({
    currentProject: p.currentProject ?? null,
    openTabs: Array.isArray(p.openTabs) ? p.openTabs : [],
    activeTabId: p.activeTabId ?? null,
  })
}

/**
 * 弹窗侧有序消息重放：快照 / workspace 整替；命令域补丁重放（失败请求 resync）。
 * 导出仅供单测直接构造消息验证重放语义（内部 API）。
 */
export function applyRemoteState(sync: WindowSync, kind: SyncDataKind, payload: unknown): void {
  const link = useWindowLinkStore.getState()
  applyingRemote = true
  try {
    switch (kind) {
      case 'snapshot': {
        const snap = (payload ?? {}) as Partial<SnapshotPayload>
        applyWorkspaceSnapshot(snap.workspace)
        useEditorStore.setState({ domains: { ...((snap.domains ?? {}) as Record<string, unknown>) } })
        if (snap.history) link.setHistory(snap.history.undoCount, snap.history.redoCount)
        break
      }
      case 'workspace-state':
        applyWorkspaceSnapshot(payload)
        break
      case 'domain-patch': {
        const { domain, patches } = (payload ?? {}) as { domain?: CommandDomain; patches?: Patch[] }
        if (typeof domain !== 'string' || !Array.isArray(patches)) break
        const { domains } = useEditorStore.getState()
        if (!(domain in domains)) {
          sync.sendData('resync', null) // 镜像缺域（理论上不会发生），全量兜底
          break
        }
        try {
          const next = applyPatches(domains[domain] as object, patches)
          useEditorStore.setState({ domains: { ...domains, [domain]: next } })
        } catch {
          sync.sendData('resync', null) // 补丁重放失败（分叉防护）：重放全量
        }
        break
      }
      case 'domain-reset': {
        const { domain, state } = (payload ?? {}) as { domain?: CommandDomain; state: unknown }
        if (typeof domain !== 'string') break
        const { domains } = useEditorStore.getState()
        if (state === null) {
          if (!(domain in domains)) break
          const nextDomains = { ...domains }
          delete nextDomains[domain]
          useEditorStore.setState({ domains: nextDomains })
          break
        }
        useEditorStore.setState({ domains: { ...domains, [domain]: state } })
        break
      }
      case 'history': {
        const h = (payload ?? {}) as Partial<HistorySummary>
        link.setHistory(h.undoCount ?? 0, h.redoCount ?? 0)
        break
      }
      case 'action':
      case 'resync':
        break // 弹窗不会收到这两类消息
    }
  } finally {
    applyingRemote = false
  }
}

export interface PopoutBridgeTestOptions
  extends Pick<WindowSyncOptions, 'channelName' | 'channelFactory' | 'now' | 'pingIntervalMs' | 'popoutLostTimeoutMs'> {}

export interface PopoutBridge {
  sync: WindowSync
  /** 本弹窗会话 id（= sync.sessionId；主窗定向投递 / 测试用） */
  readonly sessionId: string
  dispose: () => void
}

/**
 * 弹窗桥接：
 *   1. 拦截 workspace-store 全部写 action → 转发主窗（弹窗不写业务状态，PLAN §3.1）；
 *   2. 订阅主窗广播 → 重放进本窗口 store（面板组件零改动）；
 *   3. 安装即发 hello 拉取全量快照；心跳（ping/pong）由 sync 负责。
 * dispose 还原被拦截的 action 与镜像数据（测试用；弹窗关闭即 dispose）。
 */
export function installPopoutBridge(meta: PeerMeta, options: PopoutBridgeTestOptions = {}): PopoutBridge {
  const sync = createWindowSync('popout', options.channelName, {
    ...(options.channelFactory ? { channelFactory: options.channelFactory } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
    ...(options.popoutLostTimeoutMs !== undefined ? { popoutLostTimeoutMs: options.popoutLostTimeoutMs } : {}),
    meta,
    onMainLost: () => {
      useWindowLinkStore.getState().markLost() // PopoutApp 展示失联提示并自动关闭
    },
  })

  const initial = useWorkspaceStore.getState()
  useWorkspaceStore.setState({
    openAsset: (input) =>
      sync.sendToMain({
        type: 'workspace.openAsset',
        kind: input.kind,
        assetPath: input.assetPath,
        ...(input.title !== undefined ? { title: input.title } : {}),
      }),
    closeTab: (id) => sync.sendToMain({ type: 'workspace.closeTab', id }),
    setActive: (id) => sync.sendToMain({ type: 'workspace.setActive', id }),
    markDirty: (id) => sync.sendToMain({ type: 'workspace.markDirty', id }),
    clearDirty: (id) => sync.sendToMain({ type: 'workspace.clearDirty', id }),
    closeProject: () => sync.sendToMain({ type: 'workspace.closeProject' }),
  })

  const offRemote = sync.onRemoteState((kind, payload) => {
    applyRemoteState(sync, kind, payload)
    useWindowLinkStore.getState().markConnected()
  })
  const offControl = sync.onControl(() => {
    useWindowLinkStore.getState().markConnected()
  })

  sync.sendControl('hello', meta) // 安装即拉全量快照（seq 基线随后建立）

  return {
    sync,
    sessionId: sync.sessionId,
    dispose: () => {
      offRemote()
      offControl()
      // 还原拦截：以安装时快照整体替换（含原始 action 实现）
      useWorkspaceStore.setState(initial, true)
      sync.close()
    },
  }
}
