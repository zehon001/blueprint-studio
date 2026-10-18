/**
 * 事件面板（T5.2 · PLAN §11：复刻 Godot Signals 面板操作）
 *
 * 功能（DoD 逐条）：
 *  - 选中 UI 节点（共享 store.selection，单选）→ 两节列表：
 *      ① 内建事件：schema.events 全列（事件名 / 中文 label）+ 节点绑定徽标（logicAsset 存在与否）
 *         + 逐行「已有入口」点标（逻辑资产 IR 中已存在 event.custom 入口节点）；
 *      ② 自定义事件：logicAsset 存在 → GET /api/file 拉取 → .bp.json 走 deserializeIR 列
 *         asset.events（事件名 / 参数签名）；.ts 资产轻量正则粗扫 @on(...)（精确列表在
 *         脚本编辑器诊断区）；.py 降级提示（T4.x 接入）。
 *  - 未选节点：提示「选中 UI 节点查看事件」；若工作区有活动蓝图 tab，显示其资产级
 *    自定义事件（blueprint store 当前打开的 IR）。
 *  - 双击（DoD 核心）：
 *      内建事件 → 已有入口跳转选中；缺失自动创建入口（addNode + setNodeParams eventName）；
 *      自定义事件 → 已有入口跳转选中；缺失提示「蓝图无该事件入口节点」+「一键创建」按钮
 *      （insertEventNode）；无 logicAsset → 提示 +「新建蓝图并挂载」按钮（PUT 空蓝图 +
 *      runUICommand 双写 logicAsset）；.ts → 打开脚本 tab。
 *  - 右键行 → 上下文菜单（跳转 / 创建、复制事件名）。
 *  - 运行中状态（T5.1 咬合，可选项）：事件总线实例位于运行窗口进程，编辑器面板无法
 *    访问——本卡降级不做「运行中」徽标（遗留记录见交卡汇报）。
 *
 * 接线：由 index.ts 的 registerEventsPanel() 注册（PM 在 defaultPanels.tsx 用它替换
 * EventsPanelPlaceholder 占位行，id 保持 'events' 不变）。本文件不 import 样式
 * （node:test 可挂载冒烟）；styles.css 由 index.ts 引入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { deserializeIR } from '@/ir/validate'
import { resolveBoundPath } from '@/runtime/binding'
import { findUINode, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import { embeddedBlueprintOf } from '@/ui-editor/embedded'
import { requestUIBlueprint } from '@/shell/workspace/uiBlueprintBridge'
import { getUISchema } from '@/ui-editor/schema'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { Menu, type MenuItem } from '@/panels/file-system/Menu'
import {
  NO_ENTRY_MESSAGE,
  assembleEventRows,
  customEventRows,
  resolveDoubleClick,
  scanScriptEvents,
  withEntryFlags,
  type DoubleClickIntent,
  type EventRowModel,
  type LogicEventsInfo,
} from './events-model'
import {
  executeBlueprintIntent,
  mountLogicAssetOnSelection,
  openAndLocateEvent,
  openScriptAsset,
} from './blueprint-bridge'

/** 面板内提示（notice）的自动消失时长（无按钮时） */
const NOTICE_MS = 6000

/** notice 状态：文本 + 可选动作按钮（一键创建 / 新建蓝图并挂载） */
interface NoticeState {
  text: string
  actionLabel?: string
  onAction?: () => void
}

/* ============================================================
 * 行与分节（叶子组件，node:test 可直接渲染）
 * ============================================================ */

/** 事件行：入口点标 + 显示名 + 事件名 + 参数签名；双击激活 / 右键菜单 */
export function EventRowItem(props: {
  row: EventRowModel
  onActivate: (row: EventRowModel) => void
  onContext: (row: EventRowModel, x: number, y: number) => void
}) {
  const { row } = props
  const entryKnown = row.entry !== undefined
  return (
    <div
      className="ev-row"
      role="listitem"
      title={
        entryKnown
          ? row.entry
            ? `已有入口节点——双击跳转（${row.name}）`
            : `无入口节点——双击创建 / 跳转（${row.name}）`
          : `双击跳转或创建（${row.name}）`
      }
      onDoubleClick={() => props.onActivate(row)}
      onContextMenu={(e: ReactMouseEvent) => {
        e.preventDefault()
        props.onContext(row, e.clientX, e.clientY)
      }}
    >
      {entryKnown ? (
        <span
          className={`ev-dot${row.entry ? ' ev-dot--on' : ''}`}
          title={row.entry ? '已有事件入口节点' : '无事件入口节点'}
          aria-hidden
        />
      ) : (
        <span className="ev-dot ev-dot--none" aria-hidden />
      )}
      <span className="ev-row-label" title={row.label}>
        {row.label}
      </span>
      <span className="ev-row-name" title={`事件名：${row.name}`}>
        {row.name}
      </span>
      {row.signature && row.signature !== '()' ? (
        <span className="ev-row-sig" title={`参数签名：${row.signature}`}>
          {row.signature}
        </span>
      ) : null}
    </div>
  )
}

/* ============================================================
 * 面板主体
 * ============================================================ */

export function EventsPanel() {
  const { asset } = useSceneTreeDomain()
  const selection = useUIEditorStore((s) => s.selection)
  const projectPath = useUIEditorStore((s) => s.projectPath)

  /* 蓝图侧（资产级列表 + 双击就绪判定） */
  const bpAsset = useBlueprintStore((s) => s.asset)
  const bpAssetPath = useBlueprintStore((s) => s.assetPath)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  const openTabs = useWorkspaceStore((s) => s.openTabs)

  const [logic, setLogic] = useState<LogicEventsInfo | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [reloadSeq, setReloadSeq] = useState(0)
  const [busy, setBusy] = useState(false)
  const noticeTimer = useRef<number | null>(null)

  /* —— 选中节点（仅单选显示事件；多选不显示——Godot Signals 同语义） —— */
  const node = useMemo(() => {
    if (!asset || selection.length !== 1) return null
    return findUINode(asset.root, selection[0]!)
  }, [asset, selection])
  const schema = node ? getUISchema(node.type) : undefined

  /** 绑定路径（props.logicAsset 优先回落顶层，T2.6 双写口径） */
  const logicAssetPath = node ? (resolveBoundPath(node) ?? null) : null

  /* —— 活动蓝图 tab（未选节点时的资产级数据源） —— */
  const activeBlueprintPath = useMemo(() => {
    const tab = openTabs.find((t) => t.id === activeTabId)
    return tab && tab.kind === 'blueprint' ? tab.assetPath : null
  }, [openTabs, activeTabId])

  /* —— 拉取逻辑资产（节点绑定路径变化 / 手动重载时） —— */
  useEffect(() => {
    // v3：UI 资产的内嵌蓝图是唯一逻辑挂载方式（logicAsset 已退役）
    if (!logicAssetPath) {
      if (asset?.graphs || (asset?.events ?? []).length > 0) {
        const ir = embeddedBlueprintOf(asset!)
        setLogic({
          path: '（本资产内嵌蓝图）',
          lang: 'bp',
          events: customEventRows(ir),
          ok: true,
          ir,
        })
      } else {
        setLogic(null)
      }
      return
    }
    if (!projectPath) {
      setLogic(null)
      return
    }
    const lower = logicAssetPath.toLowerCase()
    if (lower.endsWith('.py')) {
      setLogic({
        path: logicAssetPath,
        lang: 'py',
        events: [],
        ok: false,
        message: 'Python 资产事件解析将在 T4.x 接入（当前不阻塞绑定与运行）',
      })
      return
    }
    let cancelled = false
    const url = `/api/file?path=${encodeURIComponent(`${projectPath}/${logicAssetPath}`)}`
    fetch(url)
      .then((r) => r.json() as Promise<{ ok?: boolean; content?: string; message?: string }>)
      .then((j) => {
        if (cancelled) return
        if (!j.ok || typeof j.content !== 'string') {
          setLogic({ path: logicAssetPath, lang: 'bp', events: [], ok: false, message: `逻辑资产加载失败：${j.message ?? '未知错误'}` })
          return
        }
        try {
          if (lower.endsWith('.bp.json')) {
            const ir = deserializeIR(j.content)
            setLogic({ path: logicAssetPath, lang: 'bp', events: customEventRows(ir), ok: true, ir })
          } else if (lower.endsWith('.ts')) {
            setLogic({
              path: logicAssetPath,
              lang: 'ts',
              events: scanScriptEvents(j.content),
              ok: true,
              message: '脚本事件为 @on 轻量粗扫（精确列表在脚本编辑器诊断区）',
            })
          } else {
            setLogic({ path: logicAssetPath, lang: 'unknown', events: [], ok: false, message: '无法识别的逻辑资产类型（支持 .bp.json / .ts / .py）' })
          }
        } catch (err) {
          setLogic({
            path: logicAssetPath,
            lang: 'bp',
            events: [],
            ok: false,
            message: `逻辑资产解析失败：${err instanceof Error ? err.message : String(err)}`,
          })
        }
      })
      .catch(() => {
        if (!cancelled) setLogic({ path: logicAssetPath, lang: 'bp', events: [], ok: false, message: '逻辑资产加载失败：网络错误' })
      })
    return () => {
      cancelled = true
    }
  }, [asset, logicAssetPath, projectPath, reloadSeq])

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    },
    [],
  )

  /* —— 行组装 —— */
  const rows = useMemo(() => {
    if (node) return assembleEventRows(node, logic)
    if (bpAsset && activeBlueprintPath && bpAssetPath === activeBlueprintPath) {
      return { builtin: [], custom: withEntryFlags(customEventRows(bpAsset), bpAsset) }
    }
    return { builtin: [], custom: [] }
  }, [node, logic, bpAsset, bpAssetPath, activeBlueprintPath])

  /** 双击意图用的逻辑资产信息（选中态 = 拉取结果；资产级 = 蓝图 store 现状） */
  const logicForIntent: LogicEventsInfo | null = useMemo(() => {
    if (node) return logic
    if (bpAsset && bpAssetPath && activeBlueprintPath === bpAssetPath) {
      return { path: bpAssetPath, lang: 'bp', events: [], ok: true, ir: bpAsset }
    }
    return null
  }, [node, logic, bpAsset, bpAssetPath, activeBlueprintPath])

  function showMessage(text: string, withAction?: { actionLabel: string; onAction: () => void }): void {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setNotice({ text, ...(withAction ?? {}) })
    if (!withAction) {
      noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
    }
  }

  /* —— 双击 / 菜单「跳转或创建」的执行端 —— */
  async function activate(row: EventRowModel): Promise<void> {
    if (busy) return
    // v3：内嵌蓝图事件 → 切蓝图模式并定位事件入口节点
    if (logic?.path === '（本资产内嵌蓝图）') {
      requestUIBlueprint({
        assetPath: useUIEditorStore.getState().assetPath ?? undefined,
        graph: 'event',
        eventName: row.name,
      })
      return
    }
    const intent = resolveDoubleClick(row, logicForIntent)
    switch (intent.kind) {
      case 'no-logic':
        showMessage(intent.message, {
          actionLabel: '新建蓝图并挂载',
          onAction: () => void createAndMount(),
        })
        return
      case 'unsupported':
        showMessage(intent.message)
        return
      case 'open-script':
        openScriptAsset(intent.assetPath)
        return
      case 'create-custom': {
        // 卡片语义：双击 → 跳转蓝图；缺入口 → 提示 +「一键创建」按钮（不自动建）
        setBusy(true)
        const err = await openAndLocateEvent(logicForIntent?.path ?? '', () => {})
        setBusy(false)
        if (err) {
          showMessage(err)
          return
        }
        showMessage(NO_ENTRY_MESSAGE, {
          actionLabel: '一键创建',
          onAction: () => void runIntent({ kind: 'create-custom', eventName: intent.eventName }),
        })
        return
      }
      default:
        await runIntent(intent)
    }
  }

  async function runIntent(
    intent: Extract<DoubleClickIntent, { kind: 'goto' | 'create-builtin' | 'create-custom' }>,
  ): Promise<void> {
    const path = logicForIntent?.path ?? ''
    if (!path) return
    setBusy(true)
    const err = await executeBlueprintIntent(intent, path)
    setBusy(false)
    if (err) showMessage(err)
    else setNotice(null)
  }

  /* —— 新建蓝图并挂载（无 logicAsset 快捷流） —— */
  async function createAndMount(): Promise<void> {
    setBusy(true)
    const err = await mountLogicAssetOnSelection(node?.name ?? '新蓝图')
    setBusy(false)
    if (err) {
      showMessage(err)
      return
    }
    setNotice(null)
    setReloadSeq((s) => s + 1) // 重新拉取新挂载的资产
  }

  /* —— 右键菜单 —— */
  const [menu, setMenu] = useState<{ x: number; y: number; row: EventRowModel } | null>(null)

  function openRowMenu(row: EventRowModel, x: number, y: number): void {
    setMenu({ x, y, row })
  }

  /** 菜单项按当前行派生（渲染时构建，避免过期闭包） */
  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return []
    const row = menu.row
    return [
      { label: row.entry ? '跳转事件入口' : '创建 / 跳转事件入口', onSelect: () => void activate(row) },
      {
        label: '复制事件名',
        onSelect: () => {
          try {
            void navigator.clipboard?.writeText(row.name)
          } catch {
            /* 剪贴板不可用静默 */
          }
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, logicForIntent, busy, node?.id])

  /* ============ 渲染 ============ */
  const showBuiltin = rows.builtin.length > 0
  const customTitle = node
    ? logicAssetPath
      ? `自定义事件（${logicAssetPath}）`
      : '自定义事件'
    : `自定义事件（蓝图：${bpAssetPath ?? ''}）`
  const nothingToList = !showBuiltin && rows.custom.length === 0

  return (
    <div className="ev-panel">
      <div className="ev-header">
        {node ? (
          <>
            <span className="ev-title" title={node.name}>
              {node.name}
            </span>
            <span className="ev-badge">{schema?.title ?? node.type}</span>
            <span
              className={`ev-binding${logicAssetPath ? ' ev-binding--on' : ''}`}
              title={logicAssetPath ? `已挂载逻辑资产：${logicAssetPath}` : '未挂载逻辑资产（检视器「逻辑资产」属性）'}
            >
              {logicAssetPath ? '已绑定' : '未绑定'}
            </span>
          </>
        ) : (
          <span className="ev-title">事件面板</span>
        )}
      </div>
      <div className="ev-body">
        {!asset && !bpAsset ? (
          <div className="ev-empty">
            <div className="ev-empty-title">未打开资产</div>
            <div className="ev-hint">在文件系统面板双击 *.ui.json 打开 UI，选中节点查看事件</div>
          </div>
        ) : null}

        {!node && (asset || rows.custom.length > 0) ? (
          <div className="ev-empty">
            <div className="ev-empty-title">选中 UI 节点查看事件</div>
            {rows.custom.length > 0 ? (
              <div className="ev-hint">资产级自定义事件（活动蓝图：{bpAssetPath}）</div>
            ) : null}
          </div>
        ) : null}

        {showBuiltin ? (
          <div className="ev-section">
            <div className="ev-section-head">
              <span>内建事件</span>
              <span className="ev-count">{rows.builtin.length}</span>
            </div>
            <div className="ev-list" role="list">
              {rows.builtin.map((row) => (
                <EventRowItem key={row.name} row={row} onActivate={(r) => void activate(r)} onContext={openRowMenu} />
              ))}
            </div>
          </div>
        ) : null}

        {rows.custom.length > 0 ? (
          <div className="ev-section">
            <div className="ev-section-head">
              <span>{customTitle}</span>
              <span className="ev-count">{rows.custom.length}</span>
            </div>
            <div className="ev-list" role="list">
              {rows.custom.map((row) => (
                <EventRowItem key={row.name} row={row} onActivate={(r) => void activate(r)} onContext={openRowMenu} />
              ))}
            </div>
            {logic?.message && logic.lang === 'ts' ? <div className="ev-note">{logic.message}</div> : null}
          </div>
        ) : null}

        {node && !logicAssetPath && showBuiltin ? (
          <div className="ev-note">未挂载逻辑资产——双击内建事件可新建蓝图并挂载</div>
        ) : null}
        {node && logic?.message && !logic.ok && rows.custom.length === 0 ? (
          <div className="ev-note ev-note--warn">{logic.message}</div>
        ) : null}
        {nothingToList && asset && node ? <div className="ev-empty-inline">该节点无内建事件，逻辑资产也无自定义事件</div> : null}

        {notice ? (
          <div className="ev-notice" role="status">
            <span className="ev-notice-text">{notice.text}</span>
            {notice.actionLabel && notice.onAction ? (
              <button type="button" className="ev-btn" disabled={busy} onClick={notice.onAction}>
                {notice.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="ev-notice-close"
              title="关闭提示"
              onClick={() => {
                if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
                setNotice(null)
              }}
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
      {menu ? <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}
