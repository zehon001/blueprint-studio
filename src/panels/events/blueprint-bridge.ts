/**
 * 事件面板 ⇄ 蓝图的桥接层（T5.2 · 只调 blueprint store 的既有 action，不改其源码）
 *
 * 职责：双击意图（events-model.ts 的 DoubleClickIntent）的执行端——
 *  - openAndLocateEvent：确保蓝图 tab 打开并激活（workspace.openAsset kind 'blueprint'）
 *    → 等待 BlueprintTab 装载完成（blueprint store assetPath 就绪）→ 执行图内定位 / 创建；
 *  - gotoEventNode：切图 + 选中（blueprint store 的 switchGraph / setSelection；
 *    画布居中需 ReactFlow 实例，属蓝图面板内部能力，本卡降级为选中定位，见交卡遗留）；
 *  - createBuiltInEntry：内建事件入口 = addNode('event.custom') + setNodeParams(eventName)
 *    （insertEventNode 校验 asset.events 定义，内建事件不在表中，故走 addNode 两步）；
 *  - createCustomEntry：自定义事件入口 = switchGraph(entry) + insertEventNode（事件已定义）；
 *  - openScriptAsset：.ts 资产 → 打开脚本 tab（kind 'script'）；
 *  - mountLogicAssetOnSelection：「新建蓝图并挂载」快捷流（PUT 空蓝图 + runUICommand
 *    双写 UINode.logicAsset / props.logicAsset，复用 T2.6 LogicRefEditor 的写入约定）。
 *
 * 多窗口说明：workspace 写 action 在弹窗环境被 PopoutBridge 拦截转发主窗（T0.4 契约），
 * 本层只经 store action 调用，不感知窗口角色；命令域编辑与检视器 / 树面板同路径。
 */
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { emptyBlueprintAsset } from '@/runtime/binding'
import type { UIAsset, UINode } from '@/ir/types'
import { findUINode, runUICommand, useUIEditorStore } from '@/ui-editor/store'
import { tabIdOf, useWorkspaceStore } from '@/shell/workspace-store'
import { entryInsertPosition, type DoubleClickIntent } from './events-model'

/** 等待蓝图 tab 装载完成的超时（毫秒；含 GET /api/file 网络往返余量） */
export const BLUEPRINT_ACTIVATE_TIMEOUT_MS = 8000

/* ============================================================
 * 1. 蓝图 tab 打开 / 就绪等待
 * ============================================================ */

/** 等待 blueprint store 打开指定资产（已打开立即返回；订阅 openAsset 落地；超时 false） */
export function waitForBlueprintAsset(assetPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (useBlueprintStore.getState().assetPath === assetPath && useBlueprintStore.getState().asset) {
      resolve(true)
      return
    }
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      resolve(ok)
    }
    const unsub = useBlueprintStore.subscribe((s) => {
      if (s.assetPath === assetPath && s.asset) finish(true)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

/**
 * 打开（或激活）蓝图 tab 并等待蓝图编辑器就绪，随后执行定位回调。
 * 返回错误消息（null = 成功）。tab 未开 → openAsset；已开未激活 → setActive；
 * 就绪判定 = blueprint store 的 assetPath 与目标一致（BlueprintTab 装载后由
 * openAsset action 落地；期间用户会看到蓝图 tab 载入）。
 */
export async function openAndLocateEvent(
  logicAsset: string,
  locate: () => void,
  timeoutMs = BLUEPRINT_ACTIVATE_TIMEOUT_MS,
): Promise<string | null> {
  const ws = useWorkspaceStore.getState()
  if (!ws.currentProject) {
    return '未打开项目（请从项目管理器进入编辑器）'
  }
  const tabId = tabIdOf('blueprint', logicAsset)
  const isOpen = ws.openTabs.some((t) => t.id === tabId)
  if (!isOpen) {
    ws.openAsset({ kind: 'blueprint', assetPath: logicAsset })
  } else if (ws.activeTabId !== tabId) {
    ws.setActive(tabId)
  }
  const ready = await waitForBlueprintAsset(logicAsset, timeoutMs)
  if (!ready) {
    return `蓝图打开超时：${logicAsset}（资产可能不存在，可在文件面板右键新建）`
  }
  locate()
  return null
}

/* ============================================================
 * 2. 图内定位 / 创建（blueprint store action 封装）
 * ============================================================ */

/** 切到入口图（跳转 / 创建前统一归位；entry 图不存在时保持当前图） */
function switchToEntryGraph(): void {
  const st = useBlueprintStore.getState()
  const entry = st.asset?.entry
  if (entry && st.graphName !== entry && st.asset?.graphs[entry]) {
    st.switchGraph(entry)
  }
}

/** 跳转到事件入口节点：切图 + 选中（画布居中为蓝图面板内部能力，本卡降级） */
export function gotoEventNode(graphName: string, nodeId: string): void {
  const st = useBlueprintStore.getState()
  if (st.graphName !== graphName && st.asset?.graphs[graphName]) {
    st.switchGraph(graphName)
  }
  st.setSelection({ nodeIds: [nodeId], edgeIds: [] })
}

/**
 * 创建内建事件入口：addNode('event.custom') + setNodeParams(eventName)（两条命令，
 * 撤销为两步——blueprint store 未提供单命令版内建入口 action，见交卡遗留）。
 * 返回新节点 id（失败 null，失败时 store 已 notify）。
 */
export function createBuiltInEntry(eventName: string): string | null {
  switchToEntryGraph()
  const st = useBlueprintStore.getState()
  const pos = entryInsertPosition(st.asset)
  const id = st.addNode('event.custom', pos)
  if (!id) return null
  st.setNodeParams(id, { eventName })
  return id
}

/** 创建自定义事件入口：切入口图 + insertEventNode（事件已在 asset.events 定义） */
export function createCustomEntry(eventName: string): string | null {
  switchToEntryGraph()
  return useBlueprintStore.getState().insertEventNode(eventName)
}

/** 打开脚本资产 tab（.ts 事件在脚本视图编辑） */
export function openScriptAsset(assetPath: string): void {
  useWorkspaceStore.getState().openAsset({ kind: 'script', assetPath })
}

/* ============================================================
 * 3. 双击意图执行端（EventsPanel 调用；返回提示消息或 null）
 * ============================================================ */

/**
 * 执行「跳转 / 创建」类意图：先确保蓝图 tab 打开就绪，再执行图内动作。
 * logicAsset = 逻辑资产路径（选中节点的绑定路径，或资产级行的蓝图 tab 路径——
 * 显式传入而非读 blueprint store 现状，避免 store 里开着别的蓝图时跳错资产）。
 * 返回错误消息（null = 成功）。
 */
export async function executeBlueprintIntent(
  intent: Extract<DoubleClickIntent, { kind: 'goto' | 'create-builtin' | 'create-custom' }>,
  logicAsset: string,
): Promise<string | null> {
  return openAndLocateEvent(logicAsset, () => {
    if (intent.kind === 'goto') {
      gotoEventNode(intent.graphName, intent.nodeId)
    } else if (intent.kind === 'create-builtin') {
      createBuiltInEntry(intent.eventName)
    } else {
      createCustomEntry(intent.eventName)
    }
  })
}

/* ============================================================
 * 4. 新建蓝图并挂载（无 logicAsset 时的快捷流）
 * ============================================================ */

/**
 * 新建空蓝图（PUT /api/file）并挂到当前选中节点（runUICommand 双写
 * UINode.logicAsset + props.logicAsset，T2.6 LogicRefEditor 同约定，可撤销）。
 * defaultName = 节点名（资产文件名默认值）。返回错误消息（null = 成功）。
 */
export async function mountLogicAssetOnSelection(defaultName: string): Promise<string | null> {
  const { projectPath, selection } = useUIEditorStore.getState()
  if (!projectPath) return '未打开项目'
  if (selection.length !== 1) return '请先选中一个 UI 节点'
  const raw = window.prompt('新逻辑资产文件名（logic/ 下，可含子目录）', `logic/${defaultName}.bp.json`)
  if (raw === null) return null // 用户取消：静默
  const rel = raw.trim().replace(/^\/+|\/+$/g, '')
  if (rel === '') return null
  if (!rel.toLowerCase().endsWith('.bp.json')) {
    return '文件名必须以 .bp.json 结尾（本期新建仅支持蓝图资产）'
  }
  const name = rel.slice(0, -'.bp.json'.length).split('/').pop() || '新蓝图'
  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `${projectPath}/${rel}`,
        content: JSON.stringify(emptyBlueprintAsset(name), null, 2),
      }),
    })
    const j = (await res.json()) as { ok?: boolean; message?: string }
    if (!j.ok) return `创建失败：${j.message ?? `HTTP ${res.status}`}`
  } catch (err) {
    return `创建失败：${err instanceof Error ? err.message : String(err)}`
  }
  const assetPath = rel
  runUICommand('事件面板：挂载逻辑资产', (draft) => {
    const root = (draft as UIAsset).root
    const node: UINode | null = findUINode(root, selection[0]!)
    if (!node) return
    node.logicAsset = assetPath
    node.props.logicAsset = assetPath
  })
  return null
}
