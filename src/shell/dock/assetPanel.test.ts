/**
 * 资产面板模型单测（v3 T8.1）
 *
 * 只测纯逻辑（id 语法 / 显示名 / 布局扫描 / workspace 同步 / 关闭确认），
 * 不加载编辑器组件（assetPanel.tsx）——node:test 下避免拉入 @xyflow CSS。
 */
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assetBadge,
  assetDisplayName,
  assetPanelId,
  assetPanelTitle,
  collectAssetPanels,
  collectPanelIdsRaw,
  confirmCloseIfDirty,
  parseAssetPanelId,
  requestClosePanel,
  requestClosePanels,
  syncWorkspaceFromDock,
  type AssetPanelKind,
} from './assetPanelModel'
import { findTabsByPanel, makeTabs, type DockNode } from './tree'
import { useDockStore } from './store'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'

/** 构造 12 面板布局（6 资产 + 6 静态），验证扫描/同步规模 */
function buildLargeLayout(): DockNode {
  const assets: AssetPanelKind[] = ['ui', 'ui', 'blueprint', 'script', 'element', 'style']
  const paths = [
    'ui/main.ui.json',
    'ui/prefabs/item.ui.json',
    'logic/main.bp.json',
    'logic/parser.ts',
    'ui/elements/card.elem.json',
    'ui/styles/base.uss.json',
  ]
  const assetTabs = makeTabs(assets.map((kind, i) => assetPanelId(kind, paths[i]!)))
  const staticTabs = makeTabs(['file-system', 'inspector', 'events', 'console', 'runtime', 'scene-tree'])
  return {
    kind: 'split',
    dir: 'h',
    sizes: [3, 1],
    children: [assetTabs, staticTabs],
  }
}

describe('资产面板 id / 显示名', () => {
  it('id 往返：kind 与路径可解析；非资产 / 非法 id 返回 null', () => {
    const id = assetPanelId('blueprint', 'logic/main.bp.json')
    assert.equal(id, 'asset:blueprint:logic/main.bp.json')
    assert.deepEqual(parseAssetPanelId(id), { kind: 'blueprint', path: 'logic/main.bp.json' })
    assert.equal(parseAssetPanelId('inspector'), null)
    assert.equal(parseAssetPanelId('asset:unknown:x'), null)
    assert.equal(parseAssetPanelId('asset:ui:'), null)
  })

  it('显示名去双扩展名；脚本保留完整名；徽标口径', () => {
    assert.equal(assetDisplayName('ui', 'ui/main.ui.json'), 'main')
    assert.equal(assetDisplayName('blueprint', 'logic/main.bp.json'), 'main')
    assert.equal(assetDisplayName('element', 'ui/elements/card.elem.json'), 'card')
    assert.equal(assetDisplayName('style', 'ui/styles/base.uss.json'), 'base')
    assert.equal(assetDisplayName('function', 'library/functions/fmt.fn.json'), 'fmt')
    assert.equal(assetPanelTitle('script', 'logic/parser.ts'), 'parser.ts')
    assert.equal(assetBadge('ui'), 'UI')
    assert.equal(assetBadge('script', 'a.py'), 'PY')
    assert.equal(assetBadge('script', 'a.ts'), 'TS')
  })
})

describe('布局扫描', () => {
  it('collectPanelIdsRaw 收集全部面板；collectAssetPanels 只取资产并去重', () => {
    const root = buildLargeLayout()
    const ids = collectPanelIdsRaw(root)
    assert.equal(ids.length, 12)
    assert.equal(new Set(ids).size, 12)
    const assets = collectAssetPanels(root)
    assert.equal(assets.length, 6)
    assert.ok(assets.every((a) => a.path !== ''))
  })

  it('原始 JSON 结构（未 normalize）同样可扫描', () => {
    const raw = { kind: 'split', dir: 'h', children: [{ kind: 'tabs', panels: ['asset:ui:a.ui.json'] }] }
    assert.deepEqual(collectPanelIdsRaw(raw), ['asset:ui:a.ui.json'])
  })
})

describe('workspace 注册表同步', () => {
  before(() => {
    // 确保测试不依赖 URL
    useWorkspaceStore.setState({ currentProject: null })
  })
  afterEach(() => {
    useDockStore.setState(useDockStore.getInitialState())
    useWorkspaceStore.setState({ currentProject: null, openTabs: [], activeTabId: null })
  })

  it('12 面板布局 → 6 个 openTabs；activePanelId 决定 activeTabId', () => {
    useDockStore.getState().initDockLayout(buildLargeLayout(), undefined, 'asset:blueprint:logic/main.bp.json')
    syncWorkspaceFromDock()
    const ws = useWorkspaceStore.getState()
    assert.equal(ws.openTabs.length, 6)
    assert.equal(ws.activeTabId, tabIdOf('blueprint', 'logic/main.bp.json'))
    // 静态面板聚焦时保留最近资产
    const staticGroup = findTabsByPanel(useDockStore.getState().root, 'inspector')
    assert.ok(staticGroup)
    useDockStore.getState().setTabActive(staticGroup.node.id, 0)
    syncWorkspaceFromDock()
    assert.equal(useWorkspaceStore.getState().activeTabId, tabIdOf('blueprint', 'logic/main.bp.json'))
  })

  it('关闭资产面板 → 对应 tab 移除；重复打开只聚焦', () => {
    useDockStore.getState().initDockLayout(buildLargeLayout(), undefined, 'asset:ui:ui/main.ui.json')
    syncWorkspaceFromDock()
    useDockStore.getState().closePanel('asset:ui:ui/main.ui.json')
    syncWorkspaceFromDock()
    assert.equal(
      useWorkspaceStore.getState().openTabs.some((t) => t.id === tabIdOf('ui', 'ui/main.ui.json')),
      false,
    )
    const before = useWorkspaceStore.getState().openTabs.length
    useDockStore.getState().openPanel('asset:ui:ui/main.ui.json', 'center')
    syncWorkspaceFromDock()
    assert.equal(useWorkspaceStore.getState().openTabs.length, before + 1)
    useDockStore.getState().openPanel('asset:ui:ui/main.ui.json', 'center')
    syncWorkspaceFromDock()
    assert.equal(useWorkspaceStore.getState().openTabs.length, before + 1)
  })

  it('中央组锚定 runtime：不会把新面板并到 BFS 先命中的底部控制台', () => {
    useDockStore.getState().initDockLayout(
      {
        kind: 'split',
        dir: 'v',
        sizes: [4, 1],
        children: [makeTabs(['runtime']), makeTabs(['console'])],
      },
      undefined,
    )
    useDockStore.getState().openPanel('inspector', 'center')
    const runtimeGroup = findTabsByPanel(useDockStore.getState().root, 'runtime')
    assert.ok(runtimeGroup)
    assert.deepEqual(runtimeGroup.node.panels, ['runtime', 'inspector'])
    assert.equal(findTabsByPanel(useDockStore.getState().root, 'console')?.node.panels.length, 1)
  })

  it('脏标记关闭确认：无 confirm 环境视为同意；requestClosePanel 移除面板', () => {
    useDockStore.getState().initDockLayout(makeTabs([assetPanelId('ui', 'ui/main.ui.json')]))
    syncWorkspaceFromDock()
    const id = tabIdOf('ui', 'ui/main.ui.json')
    useWorkspaceStore.getState().markDirty(id)
    assert.equal(confirmCloseIfDirty('asset:ui:ui/main.ui.json'), true)
    assert.equal(requestClosePanel('asset:ui:ui/main.ui.json'), true)
    assert.equal(useDockStore.getState().root, null)
  })

  it('confirm 返回 false → 不关闭；关闭其他批量同样受确认保护', () => {
    useDockStore.getState().initDockLayout(buildLargeLayout())
    syncWorkspaceFromDock()
    const detail = 'asset:ui:ui/main.ui.json'
    useWorkspaceStore.getState().markDirty(tabIdOf('ui', 'ui/main.ui.json'))
    const g = globalThis as { window?: unknown }
    const oldWindow = g.window
    g.window = { confirm: () => false }
    try {
      assert.equal(requestClosePanel(detail), false)
      assert.ok(findTabsByPanel(useDockStore.getState().root, detail))
      const others = collectAssetPanels(useDockStore.getState().root)
        .map((r) => assetPanelId(r.kind, r.path))
        .filter((id) => id !== detail)
      // 批量里含脏面板 → 整批中止（不部分关闭）
      assert.equal(requestClosePanels([detail, ...others]), false)
      assert.equal(collectAssetPanels(useDockStore.getState().root).length, 6)
    } finally {
      g.window = oldWindow
    }
  })
})
