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
 *  - 拖入导入：OS 文件拖到目录行或面板空白 → 读文本 → PUT /api/file（二进制提示走右键导入）。
 *
 * 接线：由 src/panels/file-system/index.ts 的 registerFileSystemPanel() 注册（PM 在
 * defaultPanels.tsx 替换占位组件那一行即可），本文件不改 dock 代码。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { assetPanelId, openAssetPanel } from '@/shell/dock/assetPanelModel'
import { useDockStore } from '@/shell/dock/store'
import { Menu, type MenuItem } from './Menu'
import { defaultFsApi, errorMessage, type FsApi, type HistoryEntry } from './api'
import { applyFsEvents, findNode, sortTree, type FsChangeEvent, type FsNode } from './tree-model'
import {
  assetKindOf,
  baseName,
  contentForNewFile,
  dedupeName,
  displayNameOf,
  extensionOf,
  extLabelOf,
  formatBytes,
  historyTsLabel,
  joinPosix,
  newFileTemplateOf,
  parentOf,
  validateFileName,
} from './paths'
import { mkdirViaPlaceholder, onFsNotice, onFsRefresh, runFsCommand, type FsNoticeKind } from './commands'
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
    <div
      className="fs-modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div
        className="fs-modal"
        role="dialog"
        aria-label={props.title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel()
          else if (e.key === 'Enter') props.onConfirm(value.trim())
        }}
      >
        <div className="fs-modal-title">{props.title}</div>
        <label className="fs-modal-label">{props.label}</label>
        <input
          className={`fs-modal-input${props.mono ? ' mono' : ''}`}
          value={value}
          placeholder={props.placeholder}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="fs-modal-actions">
          <button type="button" className="fs-btn" onClick={props.onCancel}>
            取消
          </button>
          <button type="button" className="fs-btn primary" onClick={() => props.onConfirm(value.trim())}>
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>
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
  template: 'ui' | 'bp' | 'text'
}

/** M8 开放的类型（元素/样式/函数随 M11 契约开放） */
export const NEW_ASSET_TYPES: readonly NewAssetType[] = [
  { id: 'scene', label: 'UI 场景（.ui.json）', dir: 'ui', ext: '.ui.json', template: 'ui' },
  { id: 'prefab', label: '预制体（.ui.json）', dir: 'ui/prefabs', ext: '.ui.json', template: 'ui' },
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
    <div
      className="fs-modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div
        className="fs-modal"
        role="dialog"
        aria-label="新建资产"
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel()
          else if (e.key === 'Enter' && canCreate) props.onCreate(type, fileName)
        }}
      >
        <div className="fs-modal-title">新建资产</div>
        <label className="fs-modal-label">资产类型</label>
        <select
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
        <label className="fs-modal-label">主名（自动补 {type.ext}）</label>
        <input
          className="fs-modal-input mono"
          value={name}
          placeholder={type.id === 'prefab' ? '如 list-item' : type.id.startsWith('script') ? '如 parser' : '如 main'}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="fs-modal-hint">
          目标：{joinPosix(props.projectPath, type.dir)}/{fileName || `${'{主名}'}${type.ext}`}
          {props.fromDir !== joinPosix(props.projectPath, type.dir)
            ? '（按类型约定目录，不跟随右键目录）'
            : ''}
        </div>
        {invalid ? <div className="fs-modal-error">{invalid}</div> : null}
        <div className="fs-modal-actions">
          <button type="button" className="fs-btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="fs-btn primary"
            disabled={!canCreate}
            onClick={() => props.onCreate(type, fileName)}
          >
            创建
          </button>
        </div>
      </div>
    </div>
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
    <div
      className="fs-modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        className="fs-modal fs-history-modal"
        role="dialog"
        aria-label={`历史快照 — ${state.node.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="fs-modal-title">历史快照 — {state.node.name}</div>
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
                <button type="button" className="fs-btn primary" onClick={() => onRestore(e.ts)}>
                  恢复
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="fs-modal-actions">
          <button type="button" className="fs-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * 面板
 * ============================================================ */

export interface FileSystemPanelProps {
  /** 注入式 API（测试用；默认走全局 fetch 的 defaultFsApi） */
  api?: FsApi
}

interface ToastState {
  kind: FsNoticeKind
  text: string
}

/** toast 自动消失时长 */
const TOAST_MS = 4000
/** SSE 事件防抖（卡片要求 300ms；change 事件不参与） */
const WATCH_DEBOUNCE_MS = 300

/**
 * 恢复快照后同步已打开的 tab（T7.4）：工作区只挂载「激活中」tab 的内容组件，
 * 非激活 tab 切换到时会自动重新读盘，无需处理；激活中的 tab 内容仍在内存里，
 * 关闭并立即重开（openAsset）以强制重新加载磁盘上的恢复结果。
 */
function reloadOpenTabs(relAssetPath: string): void {
  const { openTabs, activeTabId } = useWorkspaceStore.getState()
  const active = openTabs.find((t) => t.id === activeTabId)
  if (!active || active.kind === 'plugin-manager' || active.assetPath !== relAssetPath) return
  if (active.kind !== 'ui' && active.kind !== 'blueprint' && active.kind !== 'script') return
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
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 重命名保留的扩展名（v3 T8.4：只输主名） */
  const [renameExt, setRenameExt] = useState('')
  /** 新建资产向导（null = 关闭；值为右键所在目录） */
  const [newAsset, setNewAsset] = useState<{ fromDir: string } | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 历史快照弹层（T7.4；null = 关闭） */
  const [history, setHistory] = useState<HistoryState | null>(null)

  /** 当前树的镜像（SSE 增量合并读取用，避免在 setState updater 里做副作用） */
  const treeRef = useRef<FsNode | null>(null)
  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  /** 已完成首次加载的项目（切换项目时重置展开/选中） */
  const loadedProjectRef = useRef<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((kind: FsNoticeKind, text: string): void => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ kind, text })
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

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
      const root = sortTree(dto)
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
            if (next) setTree(next)
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

  function openFileNode(node: FsNode): void {
    const kind = assetKindOf(node.name)
    if (!kind) {
      showToast('info', `暂不支持打开「${node.name}」（支持 .ui.json / .bp.json / .ts / .py）`)
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
        setSelected((cur) => (cur === path ? to : cur))
        setExpanded((prev) => {
          // 目录重命名时同步迁移展开记录的子路径
          const next = new Set<string>()
          for (const p of prev) {
            if (p === path) next.add(to)
            else if (p.startsWith(`${path}/`)) next.add(`${to}${p.slice(path.length)}`)
            else next.add(p)
          }
          return next
        })
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

  function fileMenuItems(node: FsNode): MenuItem[] {
    return [
      { label: '打开', disabled: assetKindOf(node.name) === null, onSelect: () => openFileNode(node) },
      { label: '历史快照…', onSelect: () => void openHistory(node) },
      { label: '重命名', onSelect: () => startRename(node.path) },
      { label: '复制', onSelect: () => void duplicateNode(node) },
      { separator: true },
      { label: '删除', danger: true, onSelect: () => void deleteNode(node) },
    ]
  }

  function dirMenuItems(node: FsNode): MenuItem[] {
    return [
      { label: '新建资产…', onSelect: () => setNewAsset({ fromDir: node.path }) },
      { label: '新建文件（自定义扩展名）', onSelect: () => setPrompt(newFilePrompt(node.path)) },
      { label: '新建文件夹', onSelect: () => void createDir(node.path) },
      { label: '重命名', onSelect: () => startRename(node.path) },
      { label: '删除', danger: true, onSelect: () => void deleteNode(node) },
      { separator: true },
      { label: '导入文件到此处', onSelect: () => setPrompt(importPrompt(node.path)) },
    ]
  }

  function blankMenuItems(dirPath: string): MenuItem[] {
    return [
      { label: '新建资产…', onSelect: () => setNewAsset({ fromDir: dirPath }) },
      { label: '新建文件（自定义扩展名）', onSelect: () => setPrompt(newFilePrompt(dirPath)) },
      { label: '新建文件夹', onSelect: () => void createDir(dirPath) },
      { label: '刷新', onSelect: () => void refresh() },
      { separator: true },
      { label: '导入文件', onSelect: () => setPrompt(importPrompt(dirPath)) },
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
        <div className="fs-empty">
          未打开项目
          <br />
          请从项目管理器打开或新建一个项目
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

  function renderRows(node: FsNode, depth: number): ReactNode {
    if (node.type === 'dir') {
      const isExpanded = expanded.has(node.path)
      const dropTarget = dragOver === node.path
      return (
        <Fragment key={node.path}>
          <div
            className={`fs-row${selected === node.path ? ' selected' : ''}${dropTarget ? ' dragover' : ''}`}
            style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-5))` }}
            title={node.path}
            onClick={() => setSelected(node.path)}
            onDoubleClick={() => toggleExpand(node.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setSelected(node.path)
              openMenuAt(e, dirMenuItems(node))
            }}
            onDragOver={(e) => {
              if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'copy'
              setDragOver(node.path)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(null)
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
              {isExpanded ? '▾' : '▸'}
            </span>
            <span className="fs-icon dir" aria-hidden>
              ▤
            </span>
            {renamingPath === node.path ? renderRenameInput() : <span className="fs-name">{node.name}</span>}
          </div>
          {isExpanded ? node.children.map((c) => renderRows(c, depth + 1)) : null}
        </Fragment>
      )
    }
    return (
      <div
        key={node.path}
        className={`fs-row${selected === node.path ? ' selected' : ''}`}
        style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-5))` }}
        title={node.path}
        onClick={() => setSelected(node.path)}
        onDoubleClick={() => openFileNode(node)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setSelected(node.path)
          openMenuAt(e, fileMenuItems(node))
        }}
      >
        <span className={`fs-icon ext-${extLabelOf(node.name).replace(/[^a-zA-Z0-9]/g, '')}`} aria-hidden>
          {extLabelOf(node.name)}
        </span>
        {renamingPath === node.path ? (
          renderRenameInput()
        ) : (
          <span className="fs-name">{displayNameOf(node.name)}</span>
        )}
      </div>
    )
  }

  return (
    <div
      className="fs-panel"
      onContextMenu={(e) => {
        e.preventDefault()
        openMenuAt(e, blankMenuItems(projectPath ?? ''))
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(null)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(null)
        void handleDropFiles(e, projectPath ?? '')
      }}
    >
      <div className="fs-header">
        <span className="fs-header-title" title={projectPath ?? undefined}>
          {project.name}
        </span>
        <button type="button" className="fs-header-btn" title="刷新（重新读取目录树）" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      <div className="fs-tree">
        {loadError ? (
          <div className="fs-empty">
            目录树加载失败
            <br />
            {loadError}
            <br />
            （请确认本地服务已启动，右键可刷新）
          </div>
        ) : tree ? (
          tree.children.map((c) => renderRows(c, 1))
        ) : (
          <div className="fs-empty">正在加载目录树…</div>
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
      {toast && <div className={`fs-toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
