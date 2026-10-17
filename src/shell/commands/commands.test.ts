/**
 * 统一命令栈单元测试（T0.5 DoD）
 * 运行：npx tsx --test src/shell/commands/commands.test.ts
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canRedo,
  canUndo,
  getDomainState,
  getHistory,
  isDomainRegistered,
  peekRedo,
  peekUndo,
  redo,
  registerDomainState,
  resetEditorStore,
  runCommand,
  runCommandBy,
  subscribeReplay,
  undo,
  useEditorStore,
} from './index'
import type { ReplayNotice } from './index'

/* ---- 示例域状态（T0.5 DoD：蓝图 / UI 树 / 检视器三域各接一个示例命令） ---- */

interface BlueprintState {
  nodes: { id: string; title: string }[]
}
interface SceneTreeState {
  names: Record<string, string>
}
interface InspectorState {
  props: Record<string, unknown>
}

function setupThreeDomains(): void {
  registerDomainState<BlueprintState>('blueprint', { nodes: [] })
  registerDomainState<SceneTreeState>('scene-tree', { names: { n1: 'Label' } })
  registerDomainState<InspectorState>('inspector', { props: { text: 'a' } })
}

beforeEach(() => {
  resetEditorStore()
})

describe('命令域注册', () => {
  it('未注册域执行命令报错', () => {
    assert.equal(isDomainRegistered('blueprint'), false)
    assert.throws(() => runCommand('blueprint', 'x', () => {}), /未注册/)
    assert.throws(() => getDomainState('blueprint'), /未注册/)
  })

  it('注册后 runCommand 应用变更并入栈', () => {
    setupThreeDomains()
    assert.equal(isDomainRegistered('blueprint'), true)
    const r = runCommand<BlueprintState>('blueprint', '添加节点', (d) => {
      d.nodes.push({ id: 'n1', title: '节点A' })
    })
    assert.deepEqual(r, { domain: 'blueprint', changed: true })
    assert.deepEqual(getDomainState<BlueprintState>('blueprint').nodes, [{ id: 'n1', title: '节点A' }])
    assert.equal(canUndo(), true)
    assert.equal(canRedo(), false)
    assert.deepEqual(peekUndo(), { label: '添加节点', domain: 'blueprint' })
  })

  it('重挂载域会替换状态并清除该域历史，其余域历史保留', () => {
    setupThreeDomains()
    runCommand<BlueprintState>('blueprint', '添加节点', (d) => {
      d.nodes.push({ id: 'n1', title: 'A' })
    })
    runCommand<SceneTreeState>('scene-tree', '重命名节点', (d) => {
      d.names.n1 = 'Label2'
    })
    undo() // 撤销重命名 → redoStack = [重命名]
    // 重新打开蓝图资产：重挂载 blueprint 域
    registerDomainState<BlueprintState>('blueprint', { nodes: [{ id: 'fresh', title: '新资产' }] })
    assert.equal(canUndo(), false) // 「添加节点」（blueprint 域）的历史被清除
    assert.deepEqual(getDomainState<BlueprintState>('blueprint').nodes, [{ id: 'fresh', title: '新资产' }])
    const n = redo()
    assert.ok(n)
    assert.deepEqual(n.domains, ['scene-tree']) // 其余域历史仍可重做
    assert.equal(getDomainState<SceneTreeState>('scene-tree').names.n1, 'Label2')
  })
})

describe('跨域统一时间栈（DoD：三域示例命令，全局时间线撤销）', () => {
  it('撤销按时间逆序、重做按原序，受影响域报告正确', () => {
    setupThreeDomains()
    const notices: ReplayNotice[] = []
    subscribeReplay((n) => notices.push(n))

    // 三个域依次执行一条命令（时间序：blueprint → scene-tree → inspector）
    runCommand<BlueprintState>('blueprint', '添加节点', (d) => {
      d.nodes.push({ id: 'n1', title: '节点A' })
    })
    runCommand<SceneTreeState>('scene-tree', '重命名节点', (d) => {
      d.names.n1 = 'Label2'
    })
    runCommand<InspectorState>('inspector', '修改属性', (d) => {
      d.props.text = 'b'
    })
    assert.equal(canUndo(), true)
    assert.equal(canRedo(), false)

    // 撤销：统一栈按时间逆序 inspector → scene-tree → blueprint
    let n = undo()
    assert.deepEqual(n, { op: 'undo', domains: ['inspector'], label: '修改属性' })
    assert.deepEqual(getDomainState<InspectorState>('inspector').props, { text: 'a' })
    assert.equal(canUndo(), true)

    n = undo()
    assert.deepEqual(n, { op: 'undo', domains: ['scene-tree'], label: '重命名节点' })
    assert.equal(getDomainState<SceneTreeState>('scene-tree').names.n1, 'Label')

    n = undo()
    assert.deepEqual(n, { op: 'undo', domains: ['blueprint'], label: '添加节点' })
    assert.deepEqual(getDomainState<BlueprintState>('blueprint').nodes, [])
    assert.equal(canUndo(), false)
    assert.equal(canRedo(), true)

    // 重做：按原始时间序 blueprint → scene-tree → inspector
    n = redo()
    assert.deepEqual(n, { op: 'redo', domains: ['blueprint'], label: '添加节点' })
    assert.deepEqual(getDomainState<BlueprintState>('blueprint').nodes, [{ id: 'n1', title: '节点A' }])

    n = redo()
    assert.deepEqual(n, { op: 'redo', domains: ['scene-tree'], label: '重命名节点' })
    assert.equal(getDomainState<SceneTreeState>('scene-tree').names.n1, 'Label2')

    n = redo()
    assert.deepEqual(n, { op: 'redo', domains: ['inspector'], label: '修改属性' })
    assert.deepEqual(getDomainState<InspectorState>('inspector').props, { text: 'b' })
    assert.equal(canRedo(), false)

    // 重放通知序列（面板据此刷新对应域）
    assert.deepEqual(
      notices.map((x) => [x.op, ...x.domains]),
      [
        ['undo', 'inspector'],
        ['undo', 'scene-tree'],
        ['undo', 'blueprint'],
        ['redo', 'blueprint'],
        ['redo', 'scene-tree'],
        ['redo', 'inspector'],
      ],
    )
  })
})

describe('命令形式与历史查询', () => {
  it('runCommandBy 契约形式 + describe 历史详情', () => {
    setupThreeDomains()
    const r = runCommandBy<BlueprintState>({
      domain: 'blueprint',
      label: '添加节点',
      apply: (d) => {
        d.nodes.push({ id: 'n1', title: '节点A' })
      },
      describe: (after) => `共 ${after.nodes.length} 个节点`,
    })
    assert.equal(r.changed, true)
    assert.deepEqual(getHistory().undo[0], {
      label: '添加节点',
      domain: 'blueprint',
      detail: '共 1 个节点',
    })
  })

  it('空配方不入栈', () => {
    setupThreeDomains()
    const r = runCommand<BlueprintState>('blueprint', '空命令', () => {})
    assert.deepEqual(r, { domain: 'blueprint', changed: false })
    assert.equal(canUndo(), false)
    assert.deepEqual(getHistory(), { undo: [], redo: [] })
  })

  it('新命令截断重做分支', () => {
    setupThreeDomains()
    runCommand<InspectorState>('inspector', '改属性A', (d) => {
      d.props.text = 'b'
    })
    undo()
    assert.deepEqual(peekRedo(), { label: '改属性A', domain: 'inspector' })
    assert.equal(canRedo(), true)
    runCommand<InspectorState>('inspector', '改属性B', (d) => {
      d.props.text = 'c'
    })
    assert.equal(canRedo(), false)
    assert.equal(redo(), null)
    assert.deepEqual(getDomainState<InspectorState>('inspector').props, { text: 'c' })
    // 「改属性A」在被撤销后进 redo 栈，被新命令截断丢弃，只剩「改属性B」
    assert.deepEqual(getHistory().undo.map((m) => m.label), ['改属性B'])
    assert.deepEqual(peekUndo(), { label: '改属性B', domain: 'inspector' })
    undo()
    assert.deepEqual(getDomainState<InspectorState>('inspector').props, { text: 'a' })
  })

  it('配方抛错时状态与栈不受影响', () => {
    setupThreeDomains()
    assert.throws(() => {
      runCommand<BlueprintState>('blueprint', '会失败的命令', (d) => {
        d.nodes.push({ id: 'x', title: 'x' })
        throw new Error('boom')
      })
    }, /boom/)
    assert.deepEqual(getDomainState<BlueprintState>('blueprint').nodes, [])
    assert.equal(canUndo(), false)
  })

  it('空栈 undo/redo 返回 null，lastReplay 为 null', () => {
    assert.equal(undo(), null)
    assert.equal(redo(), null)
    assert.equal(useEditorStore.getState().lastReplay, null)
  })

  it('undo/redo 写入 lastReplay 供 React 订阅', () => {
    setupThreeDomains()
    runCommand<InspectorState>('inspector', '改属性', (d) => {
      d.props.text = 'b'
    })
    undo()
    assert.deepEqual(useEditorStore.getState().lastReplay, {
      op: 'undo',
      domains: ['inspector'],
      label: '改属性',
    })
    redo()
    assert.deepEqual(useEditorStore.getState().lastReplay, {
      op: 'redo',
      domains: ['inspector'],
      label: '改属性',
    })
  })

  it('subscribeReplay 可解绑', () => {
    setupThreeDomains()
    runCommand<InspectorState>('inspector', '改属性', (d) => {
      d.props.text = 'b'
    })
    const seen: ReplayNotice[] = []
    const off = subscribeReplay((n) => seen.push(n))
    undo()
    off()
    redo()
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { op: 'undo', domains: ['inspector'], label: '改属性' })
  })

  it('resetEditorStore 清空域与历史', () => {
    setupThreeDomains()
    runCommand<BlueprintState>('blueprint', '添加节点', (d) => {
      d.nodes.push({ id: 'n1', title: 'A' })
    })
    resetEditorStore()
    assert.equal(isDomainRegistered('blueprint'), false)
    assert.equal(canUndo(), false)
    assert.throws(() => getDomainState('blueprint'), /未注册/)
    assert.deepEqual(getHistory(), { undo: [], redo: [] })
  })
})
