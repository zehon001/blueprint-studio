/**
 * 文件系统面板（T0.7 · PLAN §6.2 左列 / 术语映射 FileSystem Dock → 文件系统面板）
 *
 * 功能：
 *  - 树：根 = 当前项目（workspace-store.currentProject，URL ?project= 初始化），
 *    GET /api/tree 加载；目录折叠展开、文件带扩展名图标字符；未打开项目时空态提示。
 *  - 文件监视：GET /api/watch SSE 订阅，add / unlink 增量合并（change 不刷），防抖 300ms；
 *    无法安全增量合并时整体重载；卸载断开。
 *  - 双击：文件 → workspace openAsset（.ui.json→UI / .bp.json→蓝图 / .ts·.py→脚本，
 *    其余提示不支持）；目录 → 折叠切换（不是打开）。
 *  - 右键菜单（通用 Menu 组件）：文件=打开/历史快照…/重命名/复制/删除；
 *    目录=新建文件/新建文件夹/重命名/删除/导入文件到此处；空白=新建文件/新建文件夹/刷新/导入。
 *    重命名为行内编辑（Enter 确认 Esc 取消）；删除经 confirm 后 DELETE。
 *  - 历史快照（T7.4）：文件右键「历史快照…」弹列表（新 → 旧）→ 选择版本恢复；
 *    恢复前服务端自动为当前内容留快照（可再恢复撤销）；恢复成功后刷新文件树，
 *    并对该文件的激活中 tab 关闭重开以重新读盘；文件「删除」的 Ctrl+Z 撤销同样走快照
 *    恢复（见 commands.ts 的 restore 磁盘动作）。.history 目录由服务端从树与 watch
 *    事件中隐藏，不在面板显示。
 *  - 撤销：全部写操作经 runCommand('filesystem', ...) 入统一命令栈（见 commands.ts），
 *    undo/redo 由模块级同步执行磁盘补偿；本面板订阅通知刷新树 + toast。
 *  - 拖拽移动：文件 / 目录拖到目录行 = 移入该目录；拖到面板空白 = 移入项目根。
 *    只调整所属目录、不支持排序（无 before/after 落区）；项目根 / 自身 / 自身子树 /
 *    同名冲突拒绝。落定 POST /api/move 并入命令栈「移动…」（Ctrl+Z 移回）。
 *  - 拖入导入：OS 文件拖到目录行或面板空白 → 读文本 → PUT /api/file（二进制提示走右键导入）。
 *
 * 接线：由 src/panels/file-system/index.ts 的 registerFileSystemPanel() 注册（PM 在
 * defaultPanels.tsx 替换占位组件那一行即可），本文件不改 dock 代码。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  GripVertical,
  History,
  Import,
  MoreHorizontal,
  Package,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Icon } from '@/shell/ui/Icon'
import { IconButton } from '@/shell/ui/IconButton'
import { Dialog } from '@/shell/ui/Dialog'
import { fileIconFor } from '@/shell/ui/icons'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { assetPanelId, openAssetPanel } from '@/shell/dock/assetPanelModel'
import { useDockStore } from '@/shell/dock/store'
import { useSelectionStore } from '@/shell/selection/store'
import { Menu, type MenuItem } from './Menu'
import { defaultFsApi, errorMessage, type FsApi, type HistoryEntry } from './api'
import {
  applyFsEvents,
  checkFsMove,
  findNode,
  hideProjectLibrary,
  sortTree,
  type FsChangeEvent,
  type FsMoveCheck,
  type FsNode,
} from './tree-model'
import {
  assetKindOf,
  baseName,
  contentForNewFile,
  dedupeName,
  displayNameOf,
  extensionOf,
  formatBytes,
  historyTsLabel,
  joinPosix,
  newFileTemplateOf,
  parentOf,
  validateFileName,
} from './paths'
import { mkdirViaPlaceholder, onFsNotice, onFsRefresh, runFsCommand, type FsNoticeKind } from './commands'
import {
  cascadeElementRename,
  cascadeFunctionRename,
  cascadeStyleRename,
} from '@/ui-editor/cascadeProject'
import './menu.css'
import './styles.css'

/* ============================================================
 * 弹窗输入（小模态：浏览器无本地「文件对话框」，导入路径 / 新建文件名用此输入）
 * ============================================================ */

interface PromptState {
  title: string
  label: string
  value: string
  placeholder?: string
  mono?: boolean
  confirmText: string
  /** 确认回调（value 已去首尾空白） */
  onConfirm: (value: string) => void
}

function PromptModal(props: PromptState & { onCancel: () => void }) {
  const [value, setValue] = useState(props.value)
  return (
    <Dialog
      title={props.title}
      width={400}
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            onClick={() => props.onConfirm(value.trim())}
          >
            {props.confirmText}
          </button>
        </>
      }
    >
      <label className="fs-modal-label" htmlFor="fs-prompt-input">
        {props.label}
      </label>
      <input
        id="fs-prompt-input"
        className="fs-modal-input"
        style={props.mono ? { fontFamily: 'var(--font-mono)' } : undefined}
        value={value}
        placeholder={props.placeholder}
        spellCheck={false}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onConfirm(value.trim())
        }}
      />
    </Dialog>
  )
}

/* ============================================================
 * 新建资产向导（v3 T8.4：选类型 + 输主名 → 自动补扩展名与目录）
 * ============================================================ */

export interface NewAssetType {
  id: string
  label: string
  /** 项目内目录（空 = 项目根） */
  dir: string
  /** 自动补全的扩展名 */
  ext: string
  /** 新建内容模板类别 */
  template: 'ui' | 'bp' | 'elem' | 'uss' | 'fn' | 'text'
}

/** v3 全部资产类型（元素/样式/函数已随 M11/M12 开放） */
export const NEW_ASSET_TYPES: readonly NewAssetType[] = [
  { id: 'scene', label: 'UI 场景（.ui.json）', dir: 'ui', ext: '.ui.json', template: 'ui' },
  { id: 'prefab', label: '预制体（.ui.json）', dir: 'ui/prefabs', ext: '.ui.json', template: 'ui' },
  { id: 'element', label: '元素（.elem.json）', dir: 'ui/elements', ext: '.elem.json', template: 'elem' },
  { id: 'style', label: '样式表（.uss.json）', dir: 'ui/styles', ext: '.uss.json', template: 'uss' },
  { id: 'blueprint', label: '纯逻辑蓝图（.bp.json）', dir: 'logic', ext: '.bp.json', template: 'bp' },
  { id: 'script-ts', label: '脚本（.ts）', dir: 'logic', ext: '.ts', template: 'text' },
  { id: 'script-py', label: '脚本（.py）', dir: 'logic', ext: '.py', template: 'text' },
]

function NewAssetModal(props: {
  /** 右键目录（仅作提示；实际落盘仍按类型约定目录） */
  fromDir: string
  projectPath: string
  onCancel: () => void
  onCreate: (type: NewAssetType, fileName: string) => void
}) {
  const [typeId, setTypeId] = useState(NEW_ASSET_TYPES[0].id)
  const [name, setName] = useState('')
  const type = NEW_ASSET_TYPES.find((t) => t.id === typeId) ?? NEW_ASSET_TYPES[0]
  const raw = name.trim()
  const lower = raw.toLowerCase()
  const stem = lower.endsWith(type.ext) ? raw.slice(0, raw.length - type.ext.length) : raw
  const fileName = stem ? `${stem}${type.ext}` : ''
  const invalid = stem ? validateFileName(fileName) : null
  const canCreate = stem !== '' && invalid === null
  return (
    <Dialog
      title="新建资产"
      width={440}
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={!canCreate}
            onClick={() => props.onCreate(type, fileName)}
          >
            创建
          </button>
        </>
      }
    >
      <div className="fs-form-row">
        <label className="fs-modal-label" htmlFor="fs-new-asset-type">
          资产类型
        </label>
        <select
          id="fs-new-asset-type"
          className="fs-modal-input"
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          aria-label="资产类型"
        >
          {NEW_ASSET_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="fs-form-row">
        <label className="fs-modal-label" htmlFor="fs-new-asset-name">
          主名（自动补 {type.ext}）
        </label>
        <input
          id="fs-new-asset-name"
          className="fs-modal-input mono"
          value={name}
          placeholder={type.id === 'prefab' ? '如 list-item' : type.id.startsWith('script') ? '如 parser' : '如 main'}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) props.onCreate(type, fileName)
          }}
        />
      </div>
      <div className="fs-modal-hint">
        目标：{joinPosix(props.projectPath, type.dir)}/{fileName || `${'{主名}'}${type.ext}`}
        {props.fromDir !== joinPosix(props.projectPath, type.dir)
          ? '（按类型约定目录，不跟随右键目录）'
          : ''}
      </div>
      {invalid ? <div className="fs-modal-error">{invalid}</div> : null}
    </Dialog>
  )
}

/* ============================================================
 * 历史快照列表弹层（T7.4：选择快照版本恢复）
 * ============================================================ */

/** 历史快照弹层状态：目标文件节点 + 服务端返回的快照列表（新 → 旧） */
interface HistoryState {
  node: FsNode
  entries: HistoryEntry[]
}

function HistoryModal(props: { state: HistoryState; onClose: () => void; onRestore: (ts: string) => void }) {
  const { state, onClose, onRestore } = props
  return (
    <Dialog
      title={`历史快照 — ${state.node.name}`}
      icon={<Icon icon={History} size={15} />}
      width={460}
      onClose={onClose}
      footer={
        <button type="button" className="ui-btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="fs-modal-label">
        共 {state.entries.length} 份（新 → 旧）；恢复前会自动为当前内容留存快照，可再次恢复撤销。
      </div>
      {state.entries.length === 0 ? (
        <div className="fs-history-empty">
          暂无快照（文件被覆盖保存 / 删除时由服务端自动生成，默认每文件保留最近 20 份）
        </div>
      ) : (
        <div className="fs-history-list">
          {state.entries.map((e) => (
            <div key={e.ts} className="fs-history-item">
              <span className="fs-history-ts">{historyTsLabel(e.ts)}</span>
              <span className="fs-history-size">{formatBytes(e.size)}</span>
              <button type="button" className="ui-btn" data-variant="primary" onClick={() => onRestore(e.ts)}>
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}

/* ============================================================
 * 面板
 * ============================================================ */

export interface FileSystemPanelProps {
  /** 注入式 API（测试用；默认走全局 fetch 的 defaultFsApi） */
  api?: FsApi
}

/** SSE 事件防抖（卡片要求 300ms；change 事件不参与） */
const WATCH_DEBOUNCE_MS = 300

/** 内部拖拽的自定义 MIME（与 OS 文件拖入的 'Files' 区分） */
const FS_NODE_DRAG_MIME = 'application/x-blueprint-fs-node'

/** 目录改名 / 移动后迁移展开集里该目录及后代的路径 */
function remapPathSet(prev: ReadonlySet<string>, from: string, to: string): Set<string> {
  const next = new Set<string>()
  for (const p of prev) {
    if (p === from) next.add(to)
    else if (p.startsWith(`${from}/`)) next.add(`${to}${p.slice(from.length)}`)
    else next.add(p)
  }
  return next
}

/**
 * 恢复快照后同步已打开的 tab（T7.4）：工作区只挂载「激活中」tab 的内容组件，
 * 非激活 tab 切换到时会自动重新读盘，无需处理；激活中的 tab 内容仍在内存里，
 * 关闭并立即重开（openAsset）以强制重新加载磁盘上的恢复结果。
 */
function reloadOpenTabs(relAssetPath: string): void {
  const { openTabs, activeTabId } = useWorkspaceStore.getState()
  const active = openTabs.find((t) => t.id === activeTabId)
  if (!active || active.assetPath !== relAssetPath) return
  // v3 T8.1：资产面板才是内容宿主——关闭再打开该面板以强制重新读盘
  const panelId = assetPanelId(active.kind, active.assetPath)
  useDockStore.getState().closePanel(panelId)
  openAssetPanel(active.kind, active.assetPath)
}

export function FileSystemPanel({ api = defaultFsApi }: FileSystemPanelProps) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const projectPath = project?.path ?? null

  /* —— 树与交互状态 —— */
  const [tree, setTree] = useState<FsNode | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const publishSelection = useSelectionStore((s) => s.publish)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 重命名保留的扩展名（v3 T8.4：只输主名） */
  const [renameExt, setRenameExt] = useState('')
  /** 新建资产向导（null = 关闭；值为右键所在目录） */
  const [newAsset, setNewAsset] = useState<{ fromDir: string } | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 内部拖拽中的节点路径（ref：dragover 高频路径不依赖 state 闭包） */
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const dragPathRef = useRef<string | null>(null)
  /** 空白区落点（移动到项目根）高亮 */
  const [rootDragOver, setRootDragOver] = useState(false)
  /** 历史快照弹层（T7.4；null = 关闭） */
  const [history, setHistory] = useState<HistoryState | null>(null)

  /** 当前树的镜像（SSE 增量合并读取用，避免在 setState updater 里做副作用） */
  const treeRef = useRef<FsNode | null>(null)
  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  /** 已完成首次加载的项目（切换项目时重置展开/选中） */
  const loadedProjectRef = useRef<string | null>(null)

  const showToast = useCallback((kind: FsNoticeKind, text: string): void => {
    if (kind === 'success') toast.success(text)
    else if (kind === 'error') toast.error(text)
    else toast.info(text)
  }, [])

  /* —— 树加载 / 刷新 —— */
  const refresh = useCallback(async (): Promise<void> => {
    if (!projectPath) {
      loadedProjectRef.current = null
      setTree(null)
      setLoadError(null)
      return
    }
    try {
      const { tree: dto } = await api.readTree(projectPath)
      const root = hideProjectLibrary(sortTree(dto))
      setTree(root)
      setLoadError(null)
      if (loadedProjectRef.current !== projectPath) {
        loadedProjectRef.current = projectPath
        // 默认展开：项目根 + 第一层目录（Godot 内容浏览器习惯）
        const def = new Set<string>([root.path])
        for (const c of root.children) if (c.type === 'dir') def.add(c.path)
        setExpanded(def)
        setSelected(null)
      }
    } catch (e) {
      setTree(null)
      setLoadError(errorMessage(e))
    }
  }, [api, projectPath])

  useEffect(() => {
    void refresh()
    setMenu(null)
    setRenamingPath(null)
    setPrompt(null)
    setHistory(null) // 切换项目 / 刷新时同步关闭历史快照弹层（T7.4）
  }, [refresh])

  /* —— SSE 文件监视：add/unlink 防抖 300ms 增量合并；change 不刷 —— */
  useEffect(() => {
    if (!projectPath) return
    const pending: FsChangeEvent[] = []
    let timer: number | null = null
    const es = new EventSource(api.watchUrl(projectPath))
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as { events?: FsChangeEvent[] }
        if (!Array.isArray(data.events)) return
        for (const e of data.events) {
          if (e.type === 'change') continue // change 不需要刷
          // T7.4：.history 快照写入理论上已被服务端 watch 过滤，这里兜底跳过双保险
          if (e.path.split('/').includes('.history')) continue
          pending.push(e)
        }
        if (pending.length > 0 && timer === null) {
          timer = window.setTimeout(() => {
            timer = null
            const batch = pending.splice(0, pending.length)
            const cur = treeRef.current
            if (!cur) {
              void refresh()
              return
            }
            const next = applyFsEvents(cur, batch)
            if (next) setTree(hideProjectLibrary(next))
            else void refresh() // 无法安全增量合并（整目录删除等）→ 整体重载
          }, WATCH_DEBOUNCE_MS)
        }
      } catch {
        /* 非 JSON 帧（心跳注释等）忽略 */
      }
    }
    // 连接断开时 EventSource 按服务端 retry: 3000 自动重连，无需处理
    return () => {
      es.close()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api, projectPath, refresh])

  /* —— undo/redo 磁盘补偿完成 → 刷新树；补偿通知 → toast —— */
  useEffect(() => {
    const offRefresh = onFsRefresh(() => {
      void refresh()
    })
    const offNotice = onFsNotice((n) => showToast(n.kind, n.text))
    return () => {
      offRefresh()
      offNotice()
    }
  }, [refresh, showToast])

  /* ============================================================
   * 基础操作
   * ============================================================ */

  /** 相对项目根的路径（workspace openAsset 的 assetPath 约定，与 SEED_TABS 一致） */
  const relInProject = useCallback(
    (path: string): string => {
      const prefix = projectPath ? `${projectPath}/` : ''
      return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    },
    [projectPath],
  )

  const toggleExpand = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /** 展开到某路径（含全部祖先目录） */
  const expandTo = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      let acc = ''
      for (const seg of path.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${seg}` : seg
        next.add(acc)
      }
      return next
    })
  }, [])

  /** 选中文件/目录：同步本面板选中态 + 发布统一选择（T8.2 检视器文件信息） */
  function selectNode(node: FsNode): void {
    setSelected(node.path)
    publishSelection({
      source: 'file',
      path: node.path,
      name: node.name,
      kind: node.type,
      ext: node.ext,
    })
  }

  /* ============================================================
   * 拖拽移动（仅调整所属目录，不支持排序）
   * ============================================================ */

  /** 开始内部拖拽：记录路径 + 写入 dataTransfer（与 OS 文件拖入的 'Files' 区分） */
  function beginInternalDrag(e: ReactDragEvent, node: FsNode): void {
    dragPathRef.current = node.path
    setDraggingPath(node.path)
    setDragOver(null)
    setRootDragOver(false)
    selectNode(node)
    try {
      if (e.dataTransfer) {
        e.dataTransfer.setData(FS_NODE_DRAG_MIME, node.path)
        e.dataTransfer.setData('text/plain', node.path)
        e.dataTransfer.effectAllowed = 'move'
      }
    } catch {
      /* happy-dom 等环境可能不支持 DataTransfer */
    }
  }

  function endInternalDrag(): void {
    dragPathRef.current = null
    setDraggingPath(null)
    setDragOver(null)
    setRootDragOver(false)
  }

  /** 当前内部拖拽落到 dirPath 的校验结果（没有内部拖拽 / 树未加载 → null） */
  function internalDropTarget(dirPath: string): FsMoveCheck | null {
    const from = dragPathRef.current
    const root = treeRef.current
    if (!from || !root) return null
    return checkFsMove(root, from, dirPath)
  }

  /** 拖拽落定：移动节点到目标目录；入 filesystem 命令栈（undo = 移回原目录） */
  async function moveNodeTo(from: string, toDir: string): Promise<void> {
    const root = treeRef.current
    if (!root) return
    const check = checkFsMove(root, from, toDir)
    if (!check.ok || !check.to) {
      if (check.reason) showToast('error', `无法移动：${check.reason}`)
      return
    }
    const source = findNode(root, from)
    if (!source) return
    const to = check.to
    try {
      const r = await api.move(from, to)
      if (!r.moved) return
    } catch (e) {
      showToast('error', `移动失败：${errorMessage(e)}`)
      return
    }
    const destLabel = toDir === root.path ? '项目根' : baseName(toDir)
    runFsCommand(`移动「${source.name}」到「${destLabel}」`, { kind: 'rename', from, to })
    // v3 T13.1：元素 / 样式文件换目录同样改变引用路径，级联更新项目内引用
    if (project && source.type === 'file') {
      try {
        const fromRel = relInProject(from)
        const toRel = relInProject(to)
        const lower = source.name.toLowerCase()
        if (lower.endsWith('.elem.json')) await cascadeElementRename(project.path, fromRel, toRel)
        else if (lower.endsWith('.uss.json')) await cascadeStyleRename(project.path, fromRel, toRel)
      } catch {
        showToast('info', '引用级联更新失败：请检查元素 / 样式引用路径')
      }
    }
    setExpanded((prev) => remapPathSet(prev, from, to))
    setSelected((cur) => {
      if (cur === null) return cur
      if (cur === from) return to
      if (cur.startsWith(`${from}/`)) return `${to}${cur.slice(from.length)}`
      return cur
    })
    // 被移动子树内的选中项：统一选择（检视器）同步到新路径
    if (selected && (selected === from || selected.startsWith(`${from}/`))) {
      const selNode = findNode(root, selected)
      if (selNode) {
        publishSelection({
          source: 'file',
          path: `${to}${selected.slice(from.length)}`,
          name: selNode.name,
          kind: selNode.type,
          ext: selNode.ext,
        })
      }
    }
    expandTo(toDir)
    await refresh()
    showToast('success', `已移动「${source.name}」到「${destLabel}」`)
  }

  function openFileNode(node: FsNode): void {
    const kind = assetKindOf(node.name)
    if (!kind) {
      showToast(
        'info',
        `暂不支持打开「${node.name}」（支持 .ui.json / .elem.json / .uss.json / .fn.json / .bp.json / .ts / .py）`,
      )
      return
    }
    openAssetPanel(kind, relInProject(node.path))
  }

  function startRename(path: string): void {
    const node = tree ? findNode(tree, path) : null
    if (!node) return
    setRenamingPath(path)
    // v3 T8.4：资产只输主名（输入框显示 displayName），扩展名由 renameExt 保留
    setRenameExt(node.type === 'dir' ? '' : extensionOf(node.name))
    setRenameDraft(node.type === 'dir' ? node.name : displayNameOf(node.name))
  }

  function commitRename(): void {
    const path = renamingPath
    const node = tree && path ? findNode(tree, path) : null
    if (!path || !node) {
      setRenamingPath(null)
      return
    }
    const typed = renameDraft.trim()
    const stem =
      renameExt && typed.toLowerCase().endsWith(renameExt.toLowerCase())
        ? typed.slice(0, typed.length - renameExt.length)
        : typed
    if (renameExt && stem === '') {
      showToast('error', '名称不能为空')
      return
    }
    const name = renameExt ? `${stem}${renameExt}` : typed
    const invalid = validateFileName(name)
    if (invalid) {
      showToast('error', invalid)
      return // 保留行内编辑态，便于修正
    }
    if (name === node.name) {
      setRenamingPath(null)
      return
    }
    const to = joinPosix(parentOf(path), name)
    void (async () => {
      try {
        const r = await api.move(path, to)
        setRenamingPath(null)
        if (!r.moved) return // 同名 move = no-op（Windows 大小写歧义），不入栈
        runFsCommand(`重命名「${node.name}」为「${name}」`, { kind: 'rename', from: path, to })
        // v3 T13.1：资产改名级联（元素/样式/项目函数）
        if (project && node.type === 'file') {
          const fromRel = relInProject(path)
          const toRel = relInProject(to)
          const fromLower = name.toLowerCase()
          if (fromLower.endsWith('.elem.json')) {
            await cascadeElementRename(project.path, fromRel, toRel)
          } else if (fromLower.endsWith('.uss.json')) {
            await cascadeStyleRename(project.path, fromRel, toRel)
          } else if (fromLower.endsWith('.fn.json')) {
            await cascadeFunctionRename(
              project.path,
              baseName(path).replace(/\.fn\.json$/i, ''),
              baseName(to).replace(/\.fn\.json$/i, ''),
            )
          }
        }
        setSelected((cur) => (cur === path ? to : cur))
        // 目录重命名时同步迁移展开记录的子路径
        setExpanded((prev) => remapPathSet(prev, path, to))
        await refresh()
      } catch (e) {
        setRenamingPath(null)
        showToast('error', `重命名失败：${errorMessage(e)}`) // 目标已存在 409 等服务端 message
      }
    })()
  }

  async function createFile(dirPath: string, rawName: string): Promise<void> {
    const name = rawName.trim()
    const invalid = validateFileName(name)
    if (invalid) {
      showToast('error', invalid)
      return
    }
    const siblings = (tree ? findNode(tree, dirPath)?.children ?? [] : []).map((c) => c.name)
    const finalName = dedupeName(siblings, name)
    const finalPath = joinPosix(dirPath, finalName)
    try {
      await api.writeFile(finalPath, contentForNewFile(finalName))
      runFsCommand(`新建文件「${finalName}」`, {
        kind: 'create',
        path: finalPath,
        targetKind: 'file',
        template: newFileTemplateOf(finalName),
      })
      expandTo(dirPath)
      await refresh()
      // Godot 习惯：新建后直接行内重命名（Esc 保留默认名）；只显示/编辑主名
      setRenameExt(extensionOf(finalName))
      setRenameDraft(displayNameOf(finalName))
      setRenamingPath(finalPath)
      setSelected(finalPath)
    } catch (e) {
      showToast('error', `新建文件失败：${errorMessage(e)}`)
    }
  }

  async function createDir(dirPath: string): Promise<void> {
    const siblings = (tree ? findNode(tree, dirPath)?.children ?? [] : []).map((c) => c.name)
    const name = dedupeName(siblings, '新文件夹')
    const path = joinPosix(dirPath, name)
    try {
      await mkdirViaPlaceholder(path, api)
      runFsCommand(`新建文件夹「${name}」`, { kind: 'create', path, targetKind: 'dir' })
      expandTo(path)
      await refresh()
      setRenameExt('')
      setRenameDraft(name)
      setRenamingPath(path)
      setSelected(path)
    } catch (e) {
      showToast('error', `新建文件夹失败：${errorMessage(e)}`)
    }
  }

  async function deleteNode(node: FsNode): Promise<void> {
    const isDir = node.type === 'dir'
    const message = isDir
      ? `确定删除文件夹「${node.name}」及其全部内容？\n（.history 快照按文件留存，文件夹删除暂不可撤销）`
      : `确定删除文件「${node.name}」？\n（删除前服务端会自动留存 .history 快照，Ctrl+Z 可撤销删除）`
    if (!window.confirm(message)) return
    try {
      await api.deletePath(node.path)
      runFsCommand(`删除「${node.name}」`, {
        kind: 'delete',
        path: node.path,
        wasKind: isDir ? 'dir' : 'file',
      })
      setSelected((cur) => (cur === node.path ? null : cur))
      await refresh()
    } catch (e) {
      showToast('error', `删除失败：${errorMessage(e)}`)
    }
  }

  /** 复制（同目录副本）：走服务端 /api/import 本地复制（支持二进制与目录），落盘产物入撤销日志 */
  async function duplicateNode(node: FsNode): Promise<void> {
    try {
      const root = (await api.projectsRoot()).replace(/\/+$/, '')
      const sourceAbs = `${root}/${node.path}`
      const r = await api.importFile(parentOf(node.path), sourceAbs)
      runFsCommand(`复制「${node.name}」`, {
        kind: 'import',
        path: r.target,
        sourcePath: sourceAbs,
      })
      await refresh()
      showToast('success', `已复制为「${baseName(r.target)}」`)
    } catch (e) {
      showToast('error', `复制失败：${errorMessage(e)}`)
    }
  }

  async function importFrom(targetDir: string, rawSourcePath: string): Promise<void> {
    const sourcePath = rawSourcePath.trim()
    if (!sourcePath) {
      showToast('error', '请输入本地文件 / 文件夹的绝对路径')
      return
    }
    try {
      const r = await api.importFile(targetDir, sourcePath)
      runFsCommand(`导入「${baseName(r.target)}」`, { kind: 'import', path: r.target, sourcePath })
      expandTo(targetDir)
      await refresh()
      showToast('success', `已导入 ${r.files} 个文件到「${targetDir || '项目根'}」${r.renamed ? '（重名已自动改名）' : ''}`)
    } catch (e) {
      showToast('error', `导入失败：${errorMessage(e)}`)
    }
  }

  /* —— 拖入导入（DataTransfer.files → 读文本 → PUT；目录拖拽排序不做） —— */
  async function handleDropFiles(e: ReactDragEvent, targetDir: string): Promise<void> {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) {
      showToast('info', '未检测到拖入的文件')
      return
    }
    const names = (tree ? findNode(tree, targetDir)?.children ?? [] : []).map((c) => c.name)
    let imported = 0
    for (const file of files) {
      let text: string
      try {
        text = await file.text()
      } catch {
        showToast('error', `读取「${file.name}」失败`)
        continue
      }
      if (text.includes('\u0000')) {
        showToast('error', `「${file.name}」是二进制文件：拖入导入仅支持文本，请改用右键「导入文件」（服务端复制）`)
        continue
      }
      const name = dedupeName(names, file.name)
      names.push(name)
      const path = joinPosix(targetDir, name)
      try {
        await api.writeFile(path, text)
        runFsCommand(`导入「${name}」（拖入）`, {
          kind: 'create',
          path,
          targetKind: 'file',
          template: 'text',
          content: text,
        })
        imported++
      } catch (err) {
        showToast('error', `写入「${name}」失败：${errorMessage(err)}`)
      }
    }
    if (imported > 0) {
      expandTo(targetDir)
      await refresh()
      showToast('success', `已导入 ${imported} 个文件到「${targetDir || '项目根'}」`)
    }
  }

  /* ============================================================
   * 历史快照（T7.4：浏览 / 恢复）
   * ============================================================ */

  /** 打开某文件的历史快照列表（文件已删除的场景经删除撤销的 restore 磁盘动作处理） */
  async function openHistory(node: FsNode): Promise<void> {
    try {
      const r = await api.listHistory(node.path)
      setHistory({ node, entries: r.entries })
    } catch (e) {
      showToast('error', `读取历史快照失败：${errorMessage(e)}`)
    }
  }

  /** 恢复到指定快照：服务端会先为当前内容留快照；成功后刷新树并重载已打开的 tab */
  async function restoreSnapshot(node: FsNode, ts: string): Promise<void> {
    const rel = relInProject(node.path)
    // 打开中的同名 tab 有未保存修改时先确认（恢复以磁盘内容为准，编辑器将重新读盘）
    const hasDirty = useWorkspaceStore.getState().openTabs.some((t) => t.assetPath === rel && t.dirty)
    if (hasDirty && !window.confirm(`「${node.name}」有未保存的修改，恢复历史快照将丢弃这些修改，继续？`)) {
      return
    }
    try {
      const r = await api.restore(node.path, ts)
      setHistory(null)
      reloadOpenTabs(rel)
      await refresh()
      showToast(
        'success',
        `已恢复「${node.name}」到 ${historyTsLabel(ts)}${r.preRestoreTs ? '（恢复前内容已留快照，可再恢复撤销）' : ''}`,
      )
    } catch (e) {
      showToast('error', `恢复失败：${errorMessage(e)}`)
    }
  }

  /* ============================================================
   * 右键菜单
   * ============================================================ */

  function openMenuAt(e: ReactMouseEvent, items: MenuItem[]): void {
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  function openMenuAtPoint(x: number, y: number, items: MenuItem[]): void {
    setMenu({ x, y, items })
  }

  /** 鼠标悬停「更多」按钮：在按钮下方打开与右键相同的菜单 */
  function openRowMenu(anchor: HTMLElement, items: MenuItem[]): void {
    const rect = anchor.getBoundingClientRect()
    openMenuAtPoint(rect.left, rect.bottom + 2, items)
  }

  function fileMenuItems(node: FsNode): MenuItem[] {
    return [
      { label: '打开', icon: FolderOpen, disabled: assetKindOf(node.name) === null, onSelect: () => openFileNode(node) },
      { label: '历史快照…', icon: History, onSelect: () => void openHistory(node) },
      { label: '重命名', icon: Pencil, onSelect: () => startRename(node.path) },
      { label: '复制', icon: Copy, onSelect: () => void duplicateNode(node) },
      { separator: true },
      { label: '删除', icon: Trash2, danger: true, onSelect: () => void deleteNode(node) },
    ]
  }

  function dirMenuItems(node: FsNode): MenuItem[] {
    return [
      { label: '新建资产…', icon: FolderPlus, onSelect: () => setNewAsset({ fromDir: node.path }) },
      { label: '新建文件（自定义扩展名）', icon: FilePlus2, onSelect: () => setPrompt(newFilePrompt(node.path)) },
      { label: '新建文件夹', icon: FolderPlus, onSelect: () => void createDir(node.path) },
      { label: '重命名', icon: Pencil, onSelect: () => startRename(node.path) },
      { label: '删除', icon: Trash2, danger: true, onSelect: () => void deleteNode(node) },
      { separator: true },
      { label: '导入文件到此处', icon: Import, onSelect: () => setPrompt(importPrompt(node.path)) },
    ]
  }

  function blankMenuItems(dirPath: string): MenuItem[] {
    return [
      { label: '新建资产…', icon: FolderPlus, onSelect: () => setNewAsset({ fromDir: dirPath }) },
      { label: '新建文件（自定义扩展名）', icon: FilePlus2, onSelect: () => setPrompt(newFilePrompt(dirPath)) },
      { label: '新建文件夹', icon: FolderPlus, onSelect: () => void createDir(dirPath) },
      { label: '刷新', icon: RefreshCw, onSelect: () => void refresh() },
      { separator: true },
      { label: '导入文件', icon: Import, onSelect: () => setPrompt(importPrompt(dirPath)) },
    ]
  }

  function newFilePrompt(dirPath: string): PromptState {
    return {
      title: '新建文件',
      label: `文件名（含扩展名；写入「${dirPath || '项目根'}」）`,
      placeholder: '如 main.ui.json / main.bp.json / tool.ts',
      value: '',
      mono: true,
      confirmText: '创建',
      onConfirm: (name) => {
        setPrompt(null)
        void createFile(dirPath, name)
      },
    }
  }

  /** 新建资产向导：按类型约定目录落盘（复用 createFile 的去重/撤销/行内重命名） */
  async function createAsset(type: NewAssetType, fileName: string): Promise<void> {
    setNewAsset(null)
    const base = projectPath ?? ''
    if (!base) return
    await createFile(joinPosix(base, type.dir), fileName)
  }

  function importPrompt(dirPath: string): PromptState {
    return {
      title: '导入文件到此处',
      label: `本地文件 / 文件夹绝对路径（复制入「${dirPath || '项目根'}」）`,
      placeholder: '如 D:\\MyTools\\data\\sample.log',
      value: '',
      mono: true,
      confirmText: '导入',
      onConfirm: (p) => {
        setPrompt(null)
        void importFrom(dirPath, p)
      },
    }
  }

  /* ============================================================
   * 渲染
   * ============================================================ */

  if (!project) {
    return (
      <div className="fs-panel">
        <div className="fs-empty-state">
          <Icon icon={FolderOpen} size={48} />
          <div className="fs-empty-title">未打开项目</div>
          <div className="fs-empty-desc">请从项目管理器打开或新建一个项目。</div>
          <button type="button" className="ui-btn" data-variant="primary" onClick={() => { window.location.href = '/' }}>
            返回项目管理器
          </button>
        </div>
      </div>
    )
  }

  function renderRenameInput(): ReactNode {
    return (
      <input
        className="fs-rename-input"
        value={renameDraft}
        spellCheck={false}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setRenameDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename()
          else if (e.key === 'Escape') setRenamingPath(null)
        }}
        onBlur={() => setRenamingPath(null)}
      />
    )
  }

  /** 当前可见行（展开态扁平化，键盘导航用） */
  function visibleTreeNodes(): FsNode[] {
    const out: FsNode[] = []
    const walk = (node: FsNode): void => {
      for (const child of node.children ?? []) {
        out.push(child)
        if (child.type === 'dir' && expanded.has(child.path)) walk(child)
      }
    }
    if (tree) walk(tree)
    return out
  }

  const treeElRef = useRef<HTMLDivElement | null>(null)

  function focusRow(node: FsNode): void {
    selectNode(node)
    window.requestAnimationFrame(() => {
      const el = treeElRef.current?.querySelector(`[data-fs-path="${CSS.escape(node.path)}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  }

  /** 树键盘导航：↑↓ 选中、←→ 折叠/展开、Enter 打开、Home/End 首尾 */
  function onTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    const rows = visibleTreeNodes()
    if (rows.length === 0) return
    const index = selected ? rows.findIndex((r) => r.path === selected) : -1
    const current = index >= 0 ? rows[index]! : null
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)
      focusRow(rows[next]!)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusRow(e.key === 'Home' ? rows[0]! : rows[rows.length - 1]!)
    } else if (e.key === 'ArrowRight' && current?.type === 'dir') {
      e.preventDefault()
      if (!expanded.has(current.path)) toggleExpand(current.path)
      else {
        const child = current.children?.[0]
        if (child) focusRow(child)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (current?.type === 'dir' && expanded.has(current.path)) toggleExpand(current.path)
      else if (current) {
        const parent = findNode(tree!, parentOf(current.path))
        if (parent && parent.path !== current.path) focusRow(parent)
      }
    } else if (e.key === 'Enter' && current) {
      e.preventDefault()
      if (current.type === 'dir') toggleExpand(current.path)
      else openFileNode(current)
    } else if (e.key === ' ' && current?.type === 'dir') {
      e.preventDefault()
      toggleExpand(current.path)
    }
  }

  function renderRowActions(node: FsNode, items: MenuItem[]): ReactNode {
    return (
      <span className="fs-row-actions">
        <IconButton
          icon={MoreHorizontal}
          label="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            selectNode(node)
            openRowMenu(e.currentTarget, items)
          }}
        />
      </span>
    )
  }

  function renderRows(node: FsNode, depth: number): ReactNode {
    if (node.type === 'dir') {
      const isExpanded = expanded.has(node.path)
      const dropTarget = dragOver === node.path
      const spec = fileIconFor(node.name, { isDir: true, expanded: isExpanded })
      return (
        <Fragment key={node.path}>
          <div
            role="treeitem"
            aria-expanded={isExpanded}
            aria-selected={selected === node.path}
            data-fs-path={node.path}
            className={
              `fs-row${selected === node.path ? ' selected' : ''}${dropTarget ? ' dragover' : ''}` +
              `${draggingPath === node.path ? ' dragging' : ''}`
            }
            style={{ paddingLeft: `calc(var(--space-2) + ${depth * 14}px)` }}
            title={node.path}
            draggable={renamingPath !== node.path}
            onClick={() => selectNode(node)}
            onDoubleClick={() => toggleExpand(node.path)}
            onDragStart={(e) => beginInternalDrag(e, node)}
            onDragEnd={endInternalDrag}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              selectNode(node)
              openMenuAt(e, dirMenuItems(node))
            }}
            onDragOver={(e) => {
              if (dragPathRef.current) {
                // 内部拖拽：只有「移入本目录」一个落点（排序已禁用）
                e.stopPropagation()
                const check = internalDropTarget(node.path)
                if (!check?.ok) {
                  setDragOver((cur) => (cur === node.path ? null : cur))
                  return
                }
                e.preventDefault()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                setDragOver(node.path)
                return
              }
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
              e.preventDefault()
              e.stopPropagation()
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
              setDragOver(node.path)
            }}
            onDragLeave={(e) => {
              const related = e.relatedTarget as Node | null
              if (related && (e.currentTarget as HTMLElement).contains(related)) return
              setDragOver((cur) => (cur === node.path ? null : cur))
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const from = dragPathRef.current
              setDragOver(null)
              if (from) {
                endInternalDrag()
                void moveNodeTo(from, node.path)
                return
              }
              void handleDropFiles(e, node.path)
            }}
          >
            <span
              className="fs-chevron"
              title={isExpanded ? '折叠' : '展开'}
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(node.path)
              }}
            >
              {isExpanded ? <Icon icon={ChevronDown} size={12} /> : <Icon icon={ChevronRight} size={12} />}
            </span>
            <span className="fs-icon" aria-hidden>
              <Icon icon={spec.icon} size={14} style={{ color: spec.color }} />
            </span>
            {renamingPath === node.path ? renderRenameInput() : <span className="fs-name">{node.name}</span>}
            <span className="fs-grip" aria-hidden>
              <Icon icon={GripVertical} size={12} />
            </span>
            {renderRowActions(node, dirMenuItems(node))}
          </div>
          {isExpanded ? node.children.map((c) => renderRows(c, depth + 1)) : null}
        </Fragment>
      )
    }
    const spec = fileIconFor(node.name)
    const isBp = /\.bp\.json$/i.test(node.name)
    const isUi = /\.ui\.json$/i.test(node.name)
    return (
      <div
        key={node.path}
        role="treeitem"
        aria-selected={selected === node.path}
        data-fs-path={node.path}
        className={`fs-row${selected === node.path ? ' selected' : ''}${draggingPath === node.path ? ' dragging' : ''}`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth * 14}px)` }}
        title={node.path}
        draggable={renamingPath !== node.path}
        onClick={() => selectNode(node)}
        onDoubleClick={() => openFileNode(node)}
        onDragStart={(e) => beginInternalDrag(e, node)}
        onDragEnd={endInternalDrag}
        onDragOver={(e) => {
          // 文件行不是落点：拦住冒泡，避免被面板当成「移动到项目根」
          if (!dragPathRef.current) return
          e.stopPropagation()
        }}
        onDrop={(e) => {
          if (!dragPathRef.current) return
          e.preventDefault()
          e.stopPropagation()
          endInternalDrag()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          selectNode(node)
          openMenuAt(e, fileMenuItems(node))
        }}
      >
        <span className="fs-chevron fs-chevron--ghost" aria-hidden />
        <span className="fs-icon" aria-hidden>
          <Icon icon={spec.icon} size={14} style={{ color: spec.color }} />
        </span>
        {renamingPath === node.path ? (
          renderRenameInput()
        ) : (
          <span className="fs-name">{displayNameOf(node.name)}</span>
        )}
        {isBp || isUi ? (
          <span className="fs-type-chip" title={isBp ? '蓝图资产' : '界面资产'}>
            <Icon icon={spec.icon} size={11} />
          </span>
        ) : null}
        <span className="fs-grip" aria-hidden>
          <Icon icon={GripVertical} size={12} />
        </span>
        {renderRowActions(node, fileMenuItems(node))}
      </div>
    )
  }

  const relSelected = selected ? relInProject(selected) : ''
  const crumbs = [project.name, ...relSelected.split('/').filter(Boolean)]

  return (
    <div
      className="fs-panel"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.fs-row')) return
        e.preventDefault()
        openMenuAt(e, blankMenuItems(projectPath ?? ''))
      }}
      onDragOver={(e) => {
        if (dragPathRef.current) {
          // 空白区 = 项目根（把文件 / 文件夹移出子目录）
          const root = treeRef.current
          const check = root ? checkFsMove(root, dragPathRef.current, root.path) : null
          if (!check?.ok) {
            setRootDragOver(false)
            return
          }
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          setRootDragOver(true)
          return
        }
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        setDragOver(null)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(null)
          setRootDragOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        const from = dragPathRef.current
        setDragOver(null)
        setRootDragOver(false)
        if (from) {
          endInternalDrag()
          const rootPath = treeRef.current?.path
          if (rootPath) void moveNodeTo(from, rootPath)
          return
        }
        void handleDropFiles(e, projectPath ?? '')
      }}
    >
      <div className="fs-header">
        <div className="fs-breadcrumb" title={selected ?? projectPath ?? undefined}>
          <Icon icon={Package} size={13} className="fs-breadcrumb-root" />
          {crumbs.map((crumb, i) => (
            <Fragment key={`${crumb}:${i}`}>
              {i > 0 ? <Icon icon={ChevronRight} size={10} className="fs-crumb-sep" /> : null}
              <span className={i === crumbs.length - 1 ? 'fs-crumb fs-crumb--current' : 'fs-crumb'}>{crumb}</span>
            </Fragment>
          ))}
        </div>
        <IconButton icon={RefreshCw} label="刷新目录树" onClick={() => void refresh()} />
      </div>
      <div
        className={`fs-tree${rootDragOver ? ' root-dragover' : ''}`}
        ref={treeElRef}
        role="tree"
        aria-label="项目文件"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
      >
        {loadError ? (
          <div className="fs-empty-state">
            <Icon icon={TriangleAlert} size={32} className="fs-empty-error-icon" />
            <div className="fs-empty-title">目录树加载失败</div>
            <div className="fs-empty-desc">{loadError}</div>
            <button type="button" className="ui-btn" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        ) : tree ? (
          tree.children.length === 0 ? (
            <div className="fs-empty-state">
              <Icon icon={FolderOpen} size={48} />
              <div className="fs-empty-title">项目还是空的</div>
              <div className="fs-empty-desc">新建一个 UI 场景、蓝图或脚本，开始搭建你的工具。</div>
              <button
                type="button"
                className="ui-btn"
                data-variant="primary"
                onClick={() => setNewAsset({ fromDir: projectPath ?? '' })}
              >
                新建资产
              </button>
            </div>
          ) : (
            tree.children.map((c) => renderRows(c, 0))
          )
        ) : (
          <div className="fs-empty-state">
            <div className="fs-empty-desc">正在加载目录树…</div>
          </div>
        )}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {newAsset ? (
        <NewAssetModal
          fromDir={newAsset.fromDir}
          projectPath={projectPath ?? ''}
          onCancel={() => setNewAsset(null)}
          onCreate={(type, fileName) => void createAsset(type, fileName)}
        />
      ) : null}
      {prompt && <PromptModal {...prompt} onCancel={() => setPrompt(null)} />}
      {history && (
        <HistoryModal
          state={history}
          onClose={() => setHistory(null)}
          onRestore={(ts) => void restoreSnapshot(history.node, ts)}
        />
      )}
    </div>
  )
}
