/**
 * 检视器面板（T1.5 · PLAN §7.3 右侧面板 / 术语映射 Inspector → 检视器）
 *
 * 功能（DoD 逐条）：
 *  - 选中 0 节点：空态提示 + 当前资产信息（名 / 节点数）；未打开资产时提示打开方式。
 *  - 选中 1 节点：schema 驱动——按 PropDef.group 分组折叠（组序 PROP_GROUP_ORDER：
 *    节点/布局/内容/外观/行为/数据；折叠状态记在本组件 state，选中切换后保持）。
 *  - 搜索框：按属性显示名 / id 过滤（大小写不敏感）；命中组自动展开；无结果显示「无匹配属性」。
 *  - 修改即入命令栈：每个控件改动 → runUICommand('检视器：<属性名>'，draft 内改 UINode
 *    的对应存储位置——storeLocation 映射 name/transform/props，见 inspector-model.ts）。
 *  - 多选：显示共同属性（id + 控件类型 + 分组交集）；值全同 → 显示值，不同 → 混合态「—」；
 *    修改 → 单命令应用到全部节点（「检视器：批量修改 <属性> N 个」，一次撤销全部还原）。
 *  - 类型编辑器：UIPropType → 控件分发见 PropEditors.tsx（14 个编辑分支全覆盖）；
 *    PropDef.disabled 置灰（position 按实际父级解锁：根 / 自由容器内可编辑）；doc 悬浮提示。
 *  - 内建事件区：选中单节点时面板底部列出 schema.events + logicAsset 的自定义事件
 *    （自定义事件为空 / 加载失败则不显示该子节）；「跳转」按钮为占位 toast（T5.2 接入）。
 *
 * 接线：由 index.ts 的 registerInspectorPanel() 注册（PM 在 defaultPanels.tsx 替换占位，
 * id 保持 'inspector' 不变），本文件不改 dock 代码。本文件不 import 样式（node:test 可
 * 挂载冒烟）；inspector.css 由 index.ts 引入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UIAsset, UINode } from '@/ir/types'
import {
  collectUINodeIds,
  findUINode,
  getSceneTreeDomain,
  runUICommand,
  useSceneTreeDomain,
  useUIEditorStore,
} from '@/ui-editor/store'
import { getUISchema, type PropDef } from '@/ui-editor/schema'
import { expandPrefabNode, getCachedPrefab } from '@/ui-editor/prefab'
import { openPrefabTab } from '@/ui-editor/prefabTab'
import { detachPrefabCommand } from '@/panels/scene-tree/commands'
import { PropEditor } from './PropEditors'
import { FlexLayoutSection } from './FlexLayoutSection'
import { VariableSection } from './VariableSection'
import {
  PROPTYPE_LABELS,
  anyRowDisabled,
  filterPropDefs,
  groupPropRows,
  intersectPropDefs,
  propCommandLabel,
  propRowStates,
  writePropsOnNodes,
  type PropRowState,
} from './inspector-model'

/** toast 自动消失时长 */
const TOAST_MS = 4000

/** 属性行（标签 + 类型徽标 + 控件） */
function PropRow(props: {
  row: PropRowState
  nodes: readonly UINode[]
  root: UINode
  onCommit: (def: PropDef, value: unknown) => void
  onPlaceholder: (message: string) => void
}) {
  const { row } = props
  const disabled = anyRowDisabled(row.def, props.nodes, props.root)
  const typeLabel = PROPTYPE_LABELS[row.def.type] ?? row.def.type
  return (
    <div className={`insp-row${disabled ? ' insp-row--disabled' : ''}`}>
      <span className="insp-label" title={row.def.doc ?? row.def.label}>
        {row.def.label}
      </span>
      <span className="insp-type">{typeLabel}</span>
      <span className="insp-control">
        <PropEditor
          def={row.def}
          value={row.value}
          mixed={row.mixed}
          disabled={disabled}
          onCommit={(value) => props.onCommit(row.def, value)}
          onPlaceholder={props.onPlaceholder}
        />
      </span>
    </div>
  )
}

/** 事件行（内建 / 自定义共用）：显示名 + 事件名 + 跳转按钮（占位 toast） */
function EventRow(props: { label: string; name: string; onJump: () => void }) {
  return (
    <div className="insp-event-row">
      <span className="insp-event-name" title={props.label}>
        {props.label}
      </span>
      <span className="insp-event-id" title={`事件名：${props.name}`}>
        {props.name}
      </span>
      <button type="button" className="insp-btn" onClick={props.onJump}>
        跳转
      </button>
    </div>
  )
}

export function InspectorPanel() {
  const { asset } = useSceneTreeDomain()
  const selection = useUIEditorStore((s) => s.selection)
  const projectPath = useUIEditorStore((s) => s.projectPath)

  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [customEvents, setCustomEvents] = useState<string[]>([])
  const toastTimer = useRef<number | null>(null)

  /* —— 选中节点解析（失效 id 静默剔除） —— */
  const nodes = useMemo<UINode[]>(() => {
    if (!asset) return []
    const out: UINode[] = []
    for (const id of selection) {
      const n = findUINode(asset.root, id)
      if (n) out.push(n)
    }
    return out
  }, [asset, selection])

  /* —— 预制体（T7.3 · ADR-009）：单选实例 → 缓存中的预制体根（显示值/schema 以有效节点为准） —— */
  const single = nodes.length === 1 ? nodes[0]! : null
  const cachedPrefabRoot = single?.prefab ? (getCachedPrefab(single.prefab)?.root ?? null) : null
  /** 展示用节点：单选实例且预制体已缓存 → 展开后的有效节点（属性显示预制体合并值） */
  const displayNodes = useMemo<UINode[]>(() => {
    if (single && single.prefab && cachedPrefabRoot) {
      return [expandPrefabNode(single, getCachedPrefab).node]
    }
    return nodes
  }, [single, cachedPrefabRoot, nodes])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  function showToast(message: string): void {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }

  /* —— logicAsset 自定义事件（T2.6 前逻辑资产多为空；为空 / 加载失败不显示子节） —— */
  const logicAsset = nodes.length === 1 ? nodes[0]!.logicAsset : undefined
  useEffect(() => {
    if (!logicAsset || !projectPath) {
      setCustomEvents([])
      return
    }
    let cancelled = false
    fetch(`/api/file?path=${encodeURIComponent(`${projectPath}/${logicAsset}`)}`)
      .then((r) => r.json() as Promise<{ ok?: boolean; content?: string }>)
      .then((j) => {
        if (cancelled) return
        if (!j.ok || !j.content) {
          setCustomEvents([])
          return
        }
        try {
          const ir = JSON.parse(j.content) as { events?: Array<{ name?: unknown }> }
          setCustomEvents(
            (ir.events ?? [])
              .map((e) => String(e?.name ?? ''))
              .filter((n) => n.length > 0),
          )
        } catch {
          setCustomEvents([])
        }
      })
      .catch(() => {
        if (!cancelled) setCustomEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [logicAsset, projectPath])

  /* —— schema 驱动：单选取全量属性，多选取共同属性交集 ——
     实例节点（ADR-009）：schema 以预制体根 type 为准（实例 type 是实例化时刻快照） —— */
  const firstSchema = nodes.length > 0 ? getUISchema(displayNodes[0]!.type) : undefined
  const hasUnknownType = displayNodes.some((n) => getUISchema(n.type) === undefined)
  const defs = useMemo(() => {
    if (nodes.length === 0) return []
    if (nodes.length === 1) return firstSchema?.props ?? []
    return intersectPropDefs(nodes.map((n) => getUISchema(n.type)?.props ?? []))
  }, [nodes, firstSchema])

  /* —— 搜索过滤（命中组自动展开 = 搜索态忽略折叠记忆） —— */
  const keyword = search.trim()
  const searching = keyword.length > 0
  // 行值取展示节点（实例 = 有效节点，显示预制体合并值）；提交仍写实例自身 props（覆盖）
  const rows = propRowStates(displayNodes, searching ? filterPropDefs(defs, keyword) : defs)
  const groups = groupPropRows(rows)

  /** 断开预制体（物化）：单命令入栈可撤销；预制体未缓存时拒绝并提示 */
  function detachPrefab(): void {
    if (!single) return
    const r = detachPrefabCommand(single.id)
    if (r === 'prefab-missing') showToast('断开失败：预制体未加载（如文件已删，请重新打开资产）')
    else if (r === 'not-instance') showToast('该节点不是预制体实例')
    else if (r === 'ok') showToast('已断开预制体：预制体内容已物化为当前节点子树（可撤销）')
  }

  /* —— 提交：单命令应用到全部选中节点（可撤销） —— */
  function commitProp(def: PropDef, value: unknown): void {
    const assetNow = getSceneTreeDomain().asset
    if (!assetNow) return
    const ids = useUIEditorStore.getState().selection.filter((id) => findUINode(assetNow.root, id) !== null)
    if (ids.length === 0) return
    const label = propCommandLabel(def, ids.length)
    // vec2 / size：编辑器提交增量补丁（如 {x}），按节点与各自当前值合并
    const partialMerge = def.type === 'vec2' || def.type === 'size'
    runUICommand(label, (draft) => {
      const root = (draft as UIAsset).root
      writePropsOnNodes(root, ids, def, value, partialMerge)
    })
  }

  /* ============ 空态（未打开资产 / 未选中） ============ */
  if (nodes.length === 0) {
    return (
      <div className="insp-panel">
        {asset ? (
          <div className="insp-body">
            <VariableSection />
            <div className="insp-empty">
              <div className="insp-empty-title">未选中节点</div>
              <div>资产：{asset.name}</div>
              <div>节点数：{collectUINodeIds(asset.root).length}</div>
              <div className="insp-empty-hint">在 2D 视口或 UI 树面板中选择节点以编辑属性</div>
            </div>
          </div>
        ) : (
          <div className="insp-empty">
            <div className="insp-empty-title">未打开 UI 资产</div>
            <div className="insp-empty-hint">在文件系统面板双击 *.ui.json 打开</div>
          </div>
        )}
      </div>
    )
  }

  /* ============ 选中（单选 / 多选） ============ */
  const builtInEvents = single ? (firstSchema?.events ?? []) : []
  const showEvents = single !== null && (builtInEvents.length > 0 || customEvents.length > 0)
  const typeSummary = [...new Set(displayNodes.map((n) => getUISchema(n.type)?.title ?? n.type))].join('、')

  const header =
    single !== null ? (
      <div className="insp-header">
        <span className="insp-icon" aria-hidden>
          {firstSchema?.icon ?? '?'}
        </span>
        <span className="insp-title" title={single.name}>
          {single.name}
        </span>
        <span className="insp-badge">{firstSchema?.title ?? single.type}</span>
        <span className="insp-id" title={`节点 id：${single.id}`}>
          {single.id}
        </span>
      </div>
    ) : (
      <div className="insp-header">
        <span className="insp-title">已选中 {nodes.length} 个节点</span>
        <span className="insp-badge">{typeSummary}</span>
      </div>
    )

  return (
    <div className="insp-panel">
      {header}
      <div className="insp-toolbar">
        <input
          className="insp-search"
          type="text"
          placeholder="搜索属性…"
          value={search}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
        />
        {nodes.length > 1 ? (
          <div className="insp-hint">显示共同属性 · 值不同以 — 显示 · 修改将批量应用到全部选中节点</div>
        ) : null}
      </div>
      <div className="insp-body">
        {/* v3 T9.5：flex 布局/容器条目（单选） */}
        {single ? <FlexLayoutSection node={single} /> : null}
        {single ? <VariableSection node={single} /> : null}
        {single?.prefab ? (
          <div className="insp-prefab">
            <div className="insp-prefab-head">
              <span className="insp-prefab-title">预制体</span>
              <span className="insp-prefab-path" title={`预制体文件：${single.prefab}`}>
                ⧉ {single.prefab}
              </span>
            </div>
            <div className="insp-prefab-actions">
              <button type="button" className="insp-btn" onClick={() => openPrefabTab(single.prefab as string)}>
                编辑预制体
              </button>
              <button
                type="button"
                className="insp-btn"
                title="把预制体内容物化为本节点子树并解除引用（可撤销）"
                onClick={detachPrefab}
              >
                断开预制体
              </button>
            </div>
            <div className="insp-prefab-hint">
              属性修改即实例覆盖（仅写实例自身）；结构以预制体为准——双击树中实例行也可进入编辑。
            </div>
          </div>
        ) : null}
        {hasUnknownType ? (
          <div className="insp-note">存在未知类型节点，仅显示可识别的共同属性</div>
        ) : null}
        {groups.length === 0 ? (
          <div className="insp-empty-inline">{searching ? '无匹配属性' : '（无可编辑属性）'}</div>
        ) : (
          groups.map(({ group, rows: groupRows }) => {
            const isCollapsed = searching ? false : collapsed[group] === true
            return (
              <div key={group} className="insp-group">
                <button
                  type="button"
                  className="insp-group-head"
                  title={isCollapsed ? '展开' : '折叠'}
                  onClick={() => setCollapsed((c) => ({ ...c, [group]: !isCollapsed }))}
                >
                  <span className="insp-caret">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="insp-group-title">{group}</span>
                  <span className="insp-count">{groupRows.length}</span>
                </button>
                {isCollapsed ? null : (
                  <div className="insp-group-body">
                    {groupRows.map((row) => (
                      <PropRow
                        key={row.def.id}
                        row={row}
                        nodes={displayNodes}
                        root={asset?.root ?? nodes[0]!}
                        onCommit={commitProp}
                        onPlaceholder={showToast}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
        {showEvents ? (
          <div className="insp-events">
            {builtInEvents.length > 0 ? <div className="insp-events-title">内建事件</div> : null}
            {builtInEvents.map((ev) => (
              <EventRow key={ev.name} label={ev.label} name={ev.name} onJump={() => showToast('T5.2 事件面板接入')} />
            ))}
            {customEvents.length > 0 && logicAsset ? (
              <>
                <div className="insp-events-title">自定义事件（{logicAsset}）</div>
                {customEvents.map((name) => (
                  <EventRow
                    key={name}
                    label={name}
                    name={name}
                    onJump={() => showToast('T5.2 事件面板接入')}
                  />
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {toast ? <div className="insp-toast">{toast}</div> : null}
    </div>
  )
}
