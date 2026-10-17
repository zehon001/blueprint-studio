/**
 * 多窗口拆合单测（T0.4 DoD · PLAN §3.1 窗口模型）
 *
 * 覆盖：
 *   1. action / 消息序列化反序列化往返（JSON 传输契约）
 *   2. seq 乱序缓存重排（收到 3,1,2 → 按 1,2,3 重放；baseline 基线重置）
 *   3. 心跳超时判定（node:test mock.timers：弹窗 2s ping / 主窗 5s 失联 / 弹窗 8s 失联）
 *   4. popout URL 构造 + 降级链（window.open mock：null → _blank；再 null → toast + blocked）
 *   5. 「已拆出占位」→「合回」状态机（opening → popped ⇄ docked；lost → docked）
 *   6. 同步桥：双向改 store 均同步（弹窗写动作转发主窗执行 → 广播 → 弹窗镜像重放；
 *      主窗补丁广播 → 弹窗重放；cmd.runPatches / cmd.undo 跨窗口；resync 兜底）
 *
 * 运行：npx tsx --test src/shell/windows/windows.test.ts
 */
import { before, afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { produceWithPatches } from 'immer'
import { registerPanel } from '@/shell/dock/registry'
import { resetEditorStore, registerDomainState, runCommand, useEditorStore } from '@/shell/commands'
import { tabIdOf, useWorkspaceStore } from '@/shell/workspace-store'
import {
  ALL_ADDRESS,
  createSeqDeliverer,
  createWindowSync,
  deserializeMessage,
  serializeMessage,
  type SyncAction,
  type SyncChannel,
  type SyncMessage,
  type WindowSync,
} from './sync'
import {
  POPOUT_HEIGHT,
  POPOUT_WINDOW_NAME_PREFIX,
  POPOUT_WIDTH,
  buildPopoutUrl,
  closePopoutWindow,
  handlePopoutClosed,
  handlePopoutLost,
  isPoppedOut,
  popoutPanel,
  recallPopout,
  usePopoutsStore,
  type OpenWindowFn,
  type PopoutWindowLike,
} from './popout'
import {
  applyRemoteState,
  installMainBridge,
  installPopoutBridge,
  interpretAction,
  useWindowLinkStore,
  type SnapshotPayload,
} from './bridge'

/* ---------------- 测试工具 ---------------- */

/** 内存总线：替代 BroadcastChannel 的同步通道（JSON 往返模拟真实传输） */
interface FakeBus {
  channels: Map<string, Set<FakeChannel>>
  /** 全部 postMessage 记录（按发送顺序，text 为线上数据） */
  log: Array<{ from: string; text: unknown }>
}

class FakeChannel implements SyncChannel {
  onmessage: ((ev: { data: unknown }) => void) | null = null

  constructor(
    private readonly bus: FakeBus,
    private readonly name: string,
  ) {
    let set = bus.channels.get(name)
    if (!set) {
      set = new Set()
      bus.channels.set(name, set)
    }
    set.add(this)
  }

  postMessage(data: unknown): void {
    this.bus.log.push({ from: this.name, text: data })
    // 模拟真实传输：JSON 往返（BroadcastChannel 结构化传输对纯 JSON 载荷等价）
    const wire: unknown = JSON.parse(JSON.stringify(data))
    for (const peer of this.bus.channels.get(this.name) ?? []) {
      if (peer === this) continue
      peer.onmessage?.({ data: wire })
    }
  }

  close(): void {
    const set = this.bus.channels.get(this.name)
    if (set) set.delete(this)
  }
}

function makeBus(): { factory: (name: string) => SyncChannel; bus: FakeBus } {
  const bus: FakeBus = { channels: new Map(), log: [] }
  return { bus, factory: (name) => new FakeChannel(bus, name) }
}

/** 从总线记录解析出全部有序消息 */
function loggedMessages(bus: FakeBus, kind?: string): SyncMessage[] {
  return bus.log
    .map((l) => (typeof l.text === 'string' ? deserializeMessage(l.text) : null))
    .filter((m): m is SyncMessage => m !== null && (kind === undefined || m.kind === kind))
}

function makeWindow(): PopoutWindowLike & { closeCalls: number } {
  const win = { closed: false, closeCalls: 0, close() { win.closeCalls += 1 }, focus() {} }
  return win
}

/* ---------------- 全局 store 卫生（单例，测试间还原） ---------------- */

let pristineWorkspace: ReturnType<typeof useWorkspaceStore.getState>

/** 桥接 / 同步实例回收站：断言失败也能在 afterEach 兜底释放定时器（否则测试进程挂起不退出） */
const pendingDisposers: Array<() => void> = []
function track<T extends { dispose: () => void }>(instance: T): T {
  pendingDisposers.push(() => instance.dispose())
  return instance
}

before(() => {
  // 面板注册（popoutPanel 需要 registry 中的定义）
  registerPanel({ id: 'inspector', title: '检视器', component: () => null, defaultArea: 'right' })
  registerPanel({ id: 'console', title: '控制台', component: () => null, defaultArea: 'bottom' })
  pristineWorkspace = useWorkspaceStore.getState()
})

afterEach(() => {
  for (const dispose of pendingDisposers.splice(0)) dispose()
  useWorkspaceStore.setState(pristineWorkspace, true)
  resetEditorStore()
  usePopoutsStore.setState({ sessions: {} })
  useWindowLinkStore.setState({ connected: false, lost: false, undoCount: 0, redoCount: 0 })
})

/* ---------------- 1. 协议：序列化往返 ---------------- */

describe('协议：序列化 / 反序列化往返', () => {
  it('有序消息（含 SyncAction 载荷）JSON 往返无损', () => {
    const action: SyncAction = {
      type: 'workspace.openAsset',
      kind: 'script',
      assetPath: 'logic/a.ts',
      title: 'a.ts',
    }
    const msg: SyncMessage = { seq: 7, from: 'w-abc', to: 'main', kind: 'action', payload: action }
    const back = deserializeMessage(serializeMessage(msg))
    assert.deepEqual(back, msg)
  })

  it('snapshot 消息 baseline 标记往返', () => {
    const msg: SyncMessage = {
      seq: 1,
      from: 'w-main',
      to: ALL_ADDRESS,
      kind: 'snapshot',
      payload: { workspace: { openTabs: [] }, domains: {}, history: { undoCount: 0, redoCount: 0 } },
      baseline: true,
    }
    assert.deepEqual(deserializeMessage(serializeMessage(msg)), msg)
  })

  it('非法输入拒绝且不抛错', () => {
    assert.equal(deserializeMessage('not json'), null)
    assert.equal(deserializeMessage(123), null)
    assert.equal(deserializeMessage('{}'), null)
    assert.equal(deserializeMessage(JSON.stringify({ seq: 'x', from: 'a', to: 'b', kind: 'ping' })), null)
    assert.equal(deserializeMessage(JSON.stringify({ seq: 1, kind: 'ping' })), null)
  })
})

/* ---------------- 2. 按序重排 ---------------- */

describe('按序重放：seq 乱序缓存重排', () => {
  it('收到 3,1,2 → 按 1,2,3 重放', () => {
    const got: number[] = []
    const d = createSeqDeliverer<{ seq: number }>((m) => got.push(m.seq))
    d.ingest({ seq: 3 })
    d.ingest({ seq: 1 })
    d.ingest({ seq: 2 })
    assert.deepEqual(got, [1, 2, 3])
    assert.equal(d.pendingCount(), 0)
  })

  it('缺口持续缓存，补齐后连续补放', () => {
    const got: number[] = []
    const d = createSeqDeliverer<{ seq: number }>((m) => got.push(m.seq))
    d.ingest({ seq: 1 }) // 基线：期望序号从 1 起（首条广播）
    d.ingest({ seq: 3 })
    d.ingest({ seq: 4 })
    assert.deepEqual(got, [1])
    assert.equal(d.pendingCount(), 2)
    d.ingest({ seq: 2 }) // 补上 2 之后连续补放 2,3,4
    assert.deepEqual(got, [1, 2, 3, 4])
    assert.equal(d.pendingCount(), 0)
  })

  it('过期 / 重复序号丢弃', () => {
    const got: number[] = []
    const d = createSeqDeliverer<{ seq: number }>((m) => got.push(m.seq))
    d.ingest({ seq: 1 })
    d.ingest({ seq: 1 }) // 重复
    d.ingest({ seq: 0 }) // 过期
    assert.deepEqual(got, [1])
    assert.equal(d.pendingCount(), 0)
  })

  it('baseline 重置基线：丢弃早于基线的缓存，新于基线的按序补放', () => {
    // 模拟中途加入的弹窗：主窗 seq 已累积，弹窗先收到一条普通消息（缓存），再收到基线快照
    const got: string[] = []
    const d = createSeqDeliverer<{ seq: number; kind: string }>((m) => got.push(`${m.kind}#${m.seq}`))
    d.ingest({ seq: 9, kind: 'workspace-state' })
    assert.deepEqual(got, [])
    d.ingest({ seq: 8, kind: 'snapshot' }, true)
    assert.deepEqual(got, ['snapshot#8', 'workspace-state#9'])
    assert.equal(d.expected(), 10)
    // 此后过期序号（弹窗加入前的旧广播）不再回放
    d.ingest({ seq: 5, kind: 'history' })
    assert.deepEqual(got, ['snapshot#8', 'workspace-state#9'])
  })
})

/* ---------------- 3. 心跳与失联 ---------------- */

describe('心跳：2s ping / 失联判定（定时器 mock）', () => {
  it('弹窗停止 ping，主窗 5s 判定失联', () => {
    // Node 24 的 mock.timers 不接受 clearInterval API（启用 setInterval 时隐式一并 mock）
    mock.timers.enable({ apis: ['Date', 'setInterval'] })
    try {
      const { factory } = makeBus()
      const lost: string[] = []
      const mainSync = createWindowSync('main', 'hb-main', {
        channelFactory: factory,
        onPeerLost: (sid) => lost.push(sid),
      })
      const popoutSync = createWindowSync('popout', 'hb-main', {
        channelFactory: factory,
        pingIntervalMs: 2000,
        meta: { panelId: 'inspector', title: '检视器' },
      })
      mock.timers.tick(2100) // 第 2s：一次 ping 到达主窗（mock 时钟在该 tick 内即已走到 2100）
      assert.equal(lost.length, 0)
      popoutSync.close() // 弹窗停止心跳
      mock.timers.tick(4000) // 时钟到 6.1s，距最后一次 ping 4.0s < 5s：未失联
      assert.equal(lost.length, 0)
      mock.timers.tick(1000) // 时钟到 7.1s，距最后一次 ping 5.0s ≥ 5s：失联
      assert.deepEqual(lost, [popoutSync.sessionId])
      mainSync.close()
    } finally {
      mock.timers.reset()
    }
  })

  it('主窗离线，弹窗 8s 判定主窗失联（只触发一次）', () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'] })
    try {
      const { factory } = makeBus()
      let mainLost = 0
      const mainSync = createWindowSync('main', 'hb-popout', { channelFactory: factory })
      const popoutSync = createWindowSync('popout', 'hb-popout', {
        channelFactory: factory,
        pingIntervalMs: 2000,
        onMainLost: () => {
          mainLost += 1
        },
      })
      mainSync.close() // 主窗离线：不再 pong
      mock.timers.tick(9000)
      assert.equal(mainLost, 1)
      popoutSync.close()
    } finally {
      mock.timers.reset()
    }
  })

  it('双向正常心跳不误报', () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'] })
    try {
      const { factory } = makeBus()
      const lost: string[] = []
      let mainLost = 0
      const mainSync = createWindowSync('main', 'hb-ok', {
        channelFactory: factory,
        onPeerLost: (sid) => lost.push(sid),
      })
      const popoutSync = createWindowSync('popout', 'hb-ok', {
        channelFactory: factory,
        pingIntervalMs: 2000,
        onMainLost: () => {
          mainLost += 1
        },
      })
      // mock.timers.tick 的时钟在整段 tick 开始即跳到目标时刻（回调不再分段推进），
      // 大步长 tick 会让「先到的巡检回调」看到超过阈值的 now() 而误报失联；
      // 按 1s 步进逼近真实时钟推进。
      for (let i = 0; i < 10; i += 1) mock.timers.tick(1000)
      assert.equal(lost.length, 0)
      assert.equal(mainLost, 0)
      mainSync.close()
      popoutSync.close()
    } finally {
      mock.timers.reset()
    }
  })
})

/* ---------------- 4. 拆出：URL 与降级链 ---------------- */

describe('拆出：popout URL 构造与降级', () => {
  it('URL 携带 panel 与 project（encodeURIComponent）', () => {
    assert.equal(buildPopoutUrl('inspector', '/proj/A'), '/editor.html?panel=inspector&project=%2Fproj%2FA')
    assert.equal(buildPopoutUrl('inspector'), '/editor.html?panel=inspector')
    assert.equal(buildPopoutUrl('ui tree', null), '/editor.html?panel=ui+tree')
  })

  it('弹出成功 → window 模式（命名窗口 + 尺寸特征）', () => {
    const calls: Array<{ url: string; target?: string; features?: string }> = []
    const win = makeWindow()
    const toasts: string[] = []
    const r = popoutPanel('inspector', {
      open: (url, target, features) => {
        calls.push({ url, target, features })
        return win
      },
      toast: (m) => toasts.push(m),
      projectPath: '/proj/A',
    })
    assert.deepEqual(r, { ok: true, mode: 'window' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/editor.html?panel=inspector&project=%2Fproj%2FA')
    assert.equal(calls[0].target, `${POPOUT_WINDOW_NAME_PREFIX}inspector`)
    assert.match(calls[0].features ?? '', new RegExp(`width=${POPOUT_WIDTH}`))
    assert.match(calls[0].features ?? '', new RegExp(`height=${POPOUT_HEIGHT}`))
    assert.ok(isPoppedOut('inspector'))
    assert.equal(usePopoutsStore.getState().sessions['inspector'].status, 'popped')
    assert.equal(toasts.length, 0)
  })

  it('被拦截 → 降级 _blank 新标签页', () => {
    const calls: Array<{ url: string; target?: string; features?: string }> = []
    const win = makeWindow()
    const open: OpenWindowFn = (url, target, features) => {
      calls.push({ url, target, features })
      return calls.length === 1 ? null : win // 第一次被拦截
    }
    const r = popoutPanel('inspector', { open, toast: () => {}, projectPath: null })
    assert.deepEqual(r, { ok: true, mode: 'tab' })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].target, '_blank')
    assert.equal(calls[1].features, undefined) // 新标签页不带窗口尺寸特征
    assert.ok(isPoppedOut('inspector'))
  })

  it('再被拦截 → toast 提示并报告 blocked', () => {
    const toasts: string[] = []
    const r = popoutPanel('inspector', { open: () => null, toast: (m) => toasts.push(m) })
    assert.deepEqual(r, { ok: false, reason: 'blocked' })
    assert.equal(toasts.length, 1)
    assert.match(toasts[0], /拦截/)
    assert.equal(isPoppedOut('inspector'), false)
  })

  it('未知面板 → unknown-panel + toast', () => {
    const toasts: string[] = []
    const r = popoutPanel('no-such-panel', { open: () => null, toast: (m) => toasts.push(m) })
    assert.deepEqual(r, { ok: false, reason: 'unknown-panel' })
    assert.equal(toasts.length, 1)
  })

  it('已拆出 → 聚焦已有窗口，不重复打开', () => {
    const win = makeWindow()
    let opens = 0
    popoutPanel('inspector', {
      open: () => {
        opens += 1
        return win
      },
      toast: () => {},
    })
    const r = popoutPanel('inspector', {
      open: () => {
        opens += 1
        return win
      },
      toast: () => {},
    })
    assert.deepEqual(r, { ok: true, mode: 'window' })
    assert.equal(opens, 1)
  })

  it('合回：关窗 + 恢复停靠；重复合回返回 false', () => {
    const win = makeWindow()
    const toasts: string[] = []
    popoutPanel('inspector', { open: () => win, toast: () => {} })
    assert.ok(recallPopout('inspector', { toast: (m) => toasts.push(m) }))
    assert.equal(win.closeCalls, 1)
    assert.equal(isPoppedOut('inspector'), false)
    assert.match(toasts[0], /合回/)
    assert.equal(recallPopout('inspector'), false)
  })

  it('closePopoutWindow：无跟踪窗口时静默', () => {
    assert.doesNotThrow(() => closePopoutWindow('never-opened'))
  })
})

/* ---------------- 5. 状态机与自动合回 ---------------- */

describe('「已拆出占位」→「合回」状态机', () => {
  it('opening → popped ⇄ docked（手动合回 / 弹窗关闭）', () => {
    usePopoutsStore.getState().markOpening('console', 'tab')
    assert.deepEqual(usePopoutsStore.getState().sessions['console'], { status: 'opening', mode: 'tab' })
    usePopoutsStore.getState().markOpened('console')
    assert.equal(usePopoutsStore.getState().sessions['console'].status, 'popped')
    assert.ok(isPoppedOut('console'))
    usePopoutsStore.getState().markDocked('console')
    assert.equal(usePopoutsStore.getState().sessions['console'], undefined)
    assert.equal(isPoppedOut('console'), false)
  })

  it('markOpened / markLost 对无记录面板为 no-op；markDocked 幂等', () => {
    usePopoutsStore.getState().markOpened('console')
    usePopoutsStore.getState().markLost('console')
    assert.deepEqual(usePopoutsStore.getState().sessions, {})
    usePopoutsStore.getState().markOpening('console', 'window')
    usePopoutsStore.getState().markDocked('console')
    usePopoutsStore.getState().markDocked('console')
    assert.deepEqual(usePopoutsStore.getState().sessions, {})
  })

  it('lost：失联标记 → 弹窗自动关闭 → 自动合回 + toast', () => {
    const win = makeWindow()
    popoutPanel('inspector', { open: () => win, toast: () => {} })
    const toasts: string[] = []
    handlePopoutLost('inspector', { toast: (m) => toasts.push(m) })
    assert.equal(win.closeCalls, 1) // 弹窗自动关闭
    assert.equal(isPoppedOut('inspector'), false) // 面板自动回主窗
    assert.equal(toasts.length, 1)
    assert.match(toasts[0], /失联/)
    assert.match(toasts[0], /合回/)
  })

  it('lost 对已停靠面板为 no-op', () => {
    const toasts: string[] = []
    handlePopoutLost('inspector', { toast: (m) => toasts.push(m) })
    assert.equal(toasts.length, 0)
  })

  it('bye（弹窗正常关闭）：关窗 + 恢复停靠（幂等）', () => {
    const win = makeWindow()
    popoutPanel('console', { open: () => win, toast: () => {} })
    handlePopoutClosed('console')
    handlePopoutClosed('console')
    assert.equal(win.closeCalls, 1)
    assert.equal(isPoppedOut('console'), false)
  })
})

/* ---------------- 6. 同步桥：双向改 store 均同步 ---------------- */

describe('同步桥：interpretAction（主窗执行动作）', () => {
  it('workspace / cmd.runPatches / cmd.undo 在主窗生效', () => {
    registerDomainState('inspector', { sel: 'a' })
    interpretAction({ type: 'workspace.openAsset', kind: 'ui', assetPath: 'ui/x.ui.json' })
    assert.ok(useWorkspaceStore.getState().openTabs.some((t) => t.assetPath === 'ui/x.ui.json'))
    interpretAction({
      type: 'cmd.runPatches',
      domain: 'inspector',
      label: '选中节点',
      patches: [{ op: 'replace', path: ['sel'], value: 'b' }],
    })
    assert.equal((useEditorStore.getState().domains['inspector'] as { sel: string }).sel, 'b')
    assert.equal(useEditorStore.getState().undoStack[0]?.label, '选中节点')
    interpretAction({ type: 'cmd.undo' })
    assert.equal((useEditorStore.getState().domains['inspector'] as { sel: string }).sel, 'a')
    interpretAction({ type: 'workspace.closeTab', id: tabIdOf('ui', 'ui/x.ui.json') })
    assert.ok(!useWorkspaceStore.getState().openTabs.some((t) => t.assetPath === 'ui/x.ui.json'))
  })
})

describe('同步桥：applyRemoteState（弹窗镜像重放）', () => {
  let sentResync: string[] = []
  const fakeSync = { sendData: (kind: string) => sentResync.push(kind) } as unknown as WindowSync

  it('快照整替 workspace 与全部命令域', () => {
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null, currentProject: { name: 'P', path: '/P' } })
    applyRemoteState(fakeSync, 'snapshot', {
      workspace: {
        currentProject: { name: 'Demo', path: '/Demo' },
        openTabs: [{ id: 'ui:a', kind: 'ui', assetPath: 'ui/a.ui.json', title: 'A', dirty: true }],
        activeTabId: 'ui:a',
      },
      domains: { blueprint: { v: 1 } },
      history: { undoCount: 3, redoCount: 1 },
    })
    const ws = useWorkspaceStore.getState()
    assert.deepEqual(ws.currentProject, { name: 'Demo', path: '/Demo' })
    assert.deepEqual(ws.openTabs, [{ id: 'ui:a', kind: 'ui', assetPath: 'ui/a.ui.json', title: 'A', dirty: true }])
    assert.equal(ws.activeTabId, 'ui:a')
    assert.deepEqual(useEditorStore.getState().domains['blueprint'], { v: 1 })
    assert.equal(useWindowLinkStore.getState().undoCount, 3)
    assert.equal(useWindowLinkStore.getState().redoCount, 1)
  })

  it('镜像缺域收到补丁 → 请求 resync（不应用）', () => {
    sentResync = []
    resetEditorStore()
    applyRemoteState(fakeSync, 'domain-patch', { domain: 'blueprint', patches: [{ op: 'replace', path: ['v'], value: 9 }] })
    assert.deepEqual(sentResync, ['resync'])
    assert.equal(useEditorStore.getState().domains['blueprint'], undefined)
  })

  it('补丁重放失败（非法路径）→ 请求 resync（状态不损坏）', () => {
    sentResync = []
    registerDomainState('blueprint', { v: 1 })
    applyRemoteState(fakeSync, 'domain-patch', {
      domain: 'blueprint',
      patches: [{ op: 'replace', path: ['nope', 'deep'], value: 1 }],
    })
    assert.deepEqual(sentResync, ['resync'])
    assert.deepEqual(useEditorStore.getState().domains['blueprint'], { v: 1 })
  })

  it('domain-reset(null) 移除域；history 摘要更新', () => {
    sentResync = []
    registerDomainState('blueprint', { v: 1 })
    applyRemoteState(fakeSync, 'domain-reset', { domain: 'blueprint', state: null })
    assert.equal(useEditorStore.getState().domains['blueprint'], undefined)
    applyRemoteState(fakeSync, 'history', { undoCount: 7, redoCount: 2 })
    assert.equal(useWindowLinkStore.getState().undoCount, 7)
    assert.equal(useWindowLinkStore.getState().redoCount, 2)
  })
})

describe('同步桥：双向改 store 均同步（内存总线集成）', () => {
  it('弹窗安装 → hello → 主窗回全量快照（baseline）', () => {
    useWorkspaceStore.getState().openAsset({ kind: 'script', assetPath: 'logic/pre.ts' })
    const { bus, factory } = makeBus()
    const main = track(installMainBridge({ channelName: 'br-snap', channelFactory: factory }))
    const popout = track(installPopoutBridge({ panelId: 'inspector', title: '检视器' }, { channelName: 'br-snap', channelFactory: factory }))
    const snapshots = loggedMessages(bus, 'snapshot')
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].baseline, true)
    const payload = snapshots[0].payload as SnapshotPayload
    assert.ok(payload.workspace.openTabs.some((t) => t.assetPath === 'logic/pre.ts'))
    popout.dispose()
    main.dispose()
  })

  it('弹窗写 action 拦截并转发；dispose 还原原始实现', () => {
    const { bus, factory } = makeBus()
    const originalOpenAsset = useWorkspaceStore.getState().openAsset
    const bridge = track(installPopoutBridge({ panelId: 'inspector' }, { channelName: 'pb-1', channelFactory: factory }))
    assert.notEqual(useWorkspaceStore.getState().openAsset, originalOpenAsset) // 已拦截
    useWorkspaceStore.getState().setActive('no-such-tab') // 无业务效果的写动作也必须转发（弹窗不本地写）
    const actions = loggedMessages(bus, 'action')
    assert.equal(actions.length, 1)
    assert.deepEqual(actions[0].payload, { type: 'workspace.setActive', id: 'no-such-tab' })
    bridge.dispose()
    assert.equal(useWorkspaceStore.getState().openAsset, originalOpenAsset) // 已还原
  })

  it('弹窗改 workspace → 转发主窗执行 → 广播回弹窗（双向一致）', () => {
    const { factory } = makeBus()
    const main = track(installMainBridge({ channelName: 'br-ws', channelFactory: factory }))
    const actionSeen: SyncAction[] = []
    main.sync.onRemoteState((kind, payload) => {
      if (kind === 'action') actionSeen.push(payload as SyncAction)
    })
    const popoutKinds: string[] = []
    const popout = track(installPopoutBridge({ panelId: 'inspector' }, { channelName: 'br-ws', channelFactory: factory }))
    popout.sync.onRemoteState((kind) => popoutKinds.push(kind))

    // 弹窗 → 主窗：调用镜像 store 的 action（被拦截转发），主窗执行后广播回弹窗
    useWorkspaceStore.getState().openAsset({ kind: 'script', assetPath: 'logic/a.ts' })
    assert.deepEqual(actionSeen[0], { type: 'workspace.openAsset', kind: 'script', assetPath: 'logic/a.ts' })
    assert.ok(popoutKinds.includes('workspace-state'))
    const ws = useWorkspaceStore.getState()
    assert.ok(ws.openTabs.some((t) => t.assetPath === 'logic/a.ts'))
    assert.equal(ws.activeTabId, tabIdOf('script', 'logic/a.ts'))

    // 主窗侧改（任意路径触达共享 store）→ 镜像同步 dirty 标记
    useWorkspaceStore.getState().markDirty(tabIdOf('ui', 'ui/main.ui.json'))
    assert.equal(
      useWorkspaceStore.getState().openTabs.find((t) => t.id === tabIdOf('ui', 'ui/main.ui.json'))?.dirty,
      true,
    )
    popout.dispose()
    main.dispose()
  })

  it('命令域：主窗命令 → 补丁广播 → 弹窗镜像；弹窗 cmd.runPatches / cmd.undo → 主窗执行', () => {
    const { factory } = makeBus()
    const main = track(installMainBridge({ channelName: 'br-cmd', channelFactory: factory }))
    const popoutKinds: string[] = []
    const popout = track(installPopoutBridge({ panelId: 'inspector' }, { channelName: 'br-cmd', channelFactory: factory }))
    popout.sync.onRemoteState((kind) => popoutKinds.push(kind))

    // 主窗注册域 → domain-reset 广播 → 弹窗镜像
    registerDomainState('blueprint', { v: 1, nodes: [] })
    assert.ok(popoutKinds.includes('domain-reset'))
    assert.deepEqual(useEditorStore.getState().domains['blueprint'], { v: 1, nodes: [] })

    // 主窗执行命令 → domain-patch + history 广播 → 弹窗镜像重放
    runCommand('blueprint', '改标题', (draft) => {
      ;(draft as { v: number }).v = 2
    })
    assert.ok(popoutKinds.includes('history'))
    assert.ok(popoutKinds.includes('domain-patch'))
    assert.equal((useEditorStore.getState().domains['blueprint'] as { v: number }).v, 2)
    assert.equal(useWindowLinkStore.getState().undoCount, 1)

    // 弹窗 → 主窗：镜像上算补丁 → cmd.runPatches 转发 → 主窗经命令栈执行 → 广播回弹窗
    const mirror = useEditorStore.getState().domains['blueprint'] as { v: number }
    const [, patches] = produceWithPatches(mirror, (draft) => {
      ;(draft as { v: number }).v = 42
    })
    popout.sync.sendToMain({ type: 'cmd.runPatches', domain: 'blueprint', label: '弹窗改值', patches })
    assert.equal((useEditorStore.getState().domains['blueprint'] as { v: number }).v, 42)
    assert.equal(useEditorStore.getState().undoStack[useEditorStore.getState().undoStack.length - 1]?.label, '弹窗改值')
    assert.equal(useWindowLinkStore.getState().undoCount, 2)

    // 弹窗请求撤销 → 主窗 undo → 逆补丁广播 → 弹窗镜像回退
    popout.sync.sendToMain({ type: 'cmd.undo' })
    assert.equal((useEditorStore.getState().domains['blueprint'] as { v: number }).v, 2)
    assert.equal(useWindowLinkStore.getState().undoCount, 1)
    assert.equal(useWindowLinkStore.getState().redoCount, 1)
    popout.dispose()
    main.dispose()
  })

  it('镜像缺域收到补丁（经真实总线）→ resync → 主窗重发全量快照', () => {
    const { bus, factory } = makeBus()
    const main = track(installMainBridge({ channelName: 'br-resync', channelFactory: factory }))
    const resyncSeen: string[] = []
    main.sync.onRemoteState((kind) => {
      if (kind === 'resync') resyncSeen.push(kind)
    })
    const popoutKinds: string[] = []
    const popout = track(installPopoutBridge({ panelId: 'inspector' }, { channelName: 'br-resync', channelFactory: factory }))
    popout.sync.onRemoteState((kind) => popoutKinds.push(kind))

    // 第三方窗口向总线注入一条弹窗镜像中不存在的域补丁（seq 取弹窗当前期望值）
    const rogue = factory('br-resync')
    rogue.postMessage(
      serializeMessage({
        seq: 2,
        from: 'w-rogue',
        to: ALL_ADDRESS,
        kind: 'domain-patch',
        payload: { domain: 'blueprint', patches: [{ op: 'replace', path: ['v'], value: 9 }] },
      }),
    )
    rogue.close()
    assert.equal(resyncSeen.length, 1) // 弹窗发现缺域 → 请求 resync
    // 注：内存总线为同步投递，resync 应答快照会在「缺域补丁」投递返回前先送达弹窗，
    // 故断言重放序列含 snapshot（而非严格末位）；补丁本身不得应用（镜像状态不损坏）。
    assert.ok(popoutKinds.includes('snapshot'))
    assert.equal(useEditorStore.getState().domains['blueprint'], undefined)
    assert.ok(loggedMessages(bus, 'snapshot').length >= 2)
    popout.dispose()
    main.dispose()
  })

  it('两个弹窗同时镜像；定向消息只达目标会话', () => {
    const { bus, factory } = makeBus()
    const main = track(installMainBridge({ channelName: 'br-two', channelFactory: factory }))
    const popA = track(installPopoutBridge({ panelId: 'inspector' }, { channelName: 'br-two', channelFactory: factory }))
    const popB = track(installPopoutBridge({ panelId: 'console' }, { channelName: 'br-two', channelFactory: factory }))
    useWorkspaceStore.getState().openAsset({ kind: 'ui', assetPath: 'ui/shared.ui.json' })
    assert.ok(bus.log.length > 0)
    // 定向控制消息（pong → popA）不串台
    let aPong = 0
    let bPong = 0
    popA.sync.onControl((kind) => {
      if (kind === 'pong') aPong += 1
    })
    popB.sync.onControl((kind) => {
      if (kind === 'pong') bPong += 1
    })
    main.sync.sendControl('pong', undefined, popA.sessionId)
    assert.equal(aPong, 1)
    assert.equal(bPong, 0)
    // 弹窗角色的广播 / 转发主窗为 no-op（主窗是唯一写者）
    assert.doesNotThrow(() => popA.sync.broadcastData('workspace-state', {}))
    assert.doesNotThrow(() => main.sync.sendToMain({ type: 'workspace.closeProject' }))
    popA.dispose()
    popB.dispose()
    main.dispose()
  })
})
