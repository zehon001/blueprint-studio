/**
 * Blueprint Studio v2 —— 项目管理器页（T0.6）
 *
 * 三栏卡片布局（PLAN §6.1）：
 *  1. 最近项目：localStorage（bps.recentProjects.v2）持久化，打开 / 移除；
 *     修改时间经 GET /api/projects 按文件夹名比对补全。
 *  2. 新建项目：名称输入 + 模板卡（空项目 / 日志分析器）→ POST /api/projects，成功直接打开。
 *  3. 导入项目：本地文件夹绝对路径 → POST /api/projects/import-folder（T0.6 新端点）。
 *
 * 打开项目 = window.location.href = '/editor.html?project=' + encodeURIComponent(项目文件夹名)。
 * 移除只从最近列表删除，不触碰磁盘文件。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, Check, FolderOpen, FolderPlus, ListTree } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { ApiError, projectsApi, type ProjectSummary } from './api'

/* ============================================================
 * 最近项目（localStorage 持久化）
 * ============================================================ */

const RECENT_KEY = 'bps.recentProjects.v2'
const RECENT_MAX = 20

/** 最近项目条目（folder = 项目文件夹名，即服务端 ProjectSummary.path） */
interface RecentProject {
  name: string
  folder: string
  /** ISO 时间 */
  lastOpened: string
}

function loadRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (it): it is RecentProject =>
        !!it &&
        typeof it === 'object' &&
        typeof (it as RecentProject).name === 'string' &&
        typeof (it as RecentProject).folder === 'string' &&
        typeof (it as RecentProject).lastOpened === 'string',
    )
  } catch {
    return []
  }
}

function saveRecent(list: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式等存储失败：仅本次会话内可见 */
  }
}

/* ============================================================
 * 模板卡 / 校验 / 工具
 * ============================================================ */

const TEMPLATE_CARDS = [
  { id: 'empty', title: '空项目', desc: '空白 UI 项目脚手架，从零开始搭建工具' },
  { id: 'log-analyzer', title: '日志分析器', desc: '预置日志列表 UI、蓝图骨架与示例日志' },
] as const

type TemplateId = (typeof TEMPLATE_CARDS)[number]['id']

/** 前端项目名校验（与服务端 validateProjectName 对齐的常用规则），返回错误提示或 null */
function validateNameClient(raw: string): string | null {
  const name = raw.trim().replace(/[. ]+$/, '')
  if (!name) return '项目名不能为空'
  if (name.length > 64) return '项目名过长（不超过 64 字符）'
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return '项目名不能包含 \\ / : * ? " < > | 或控制字符'
  if (name.startsWith('.')) return '项目名不能以点开头'
  return null
}

/** 规范化项目名（去首尾空白与结尾点/空格，与 Windows 文件系统语义一致） */
function normalizeName(raw: string): string {
  return raw.trim().replace(/[. ]+$/, '')
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

/* ============================================================
 * 组件
 * ============================================================ */

type ToastKind = 'success' | 'error' | 'info'
interface ToastState {
  kind: ToastKind
  text: string
}

export default function ProjectManager() {
  /* —— 最近项目 —— */
  const [recents, setRecents] = useState<RecentProject[]>([])
  /* —— 服务端状态（列表用于补全修改时间 / 判定在线） —— */
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [projectsRoot, setProjectsRoot] = useState<string | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)

  /* —— 新建表单 —— */
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [template, setTemplate] = useState<TemplateId>('empty')
  const [creating, setCreating] = useState(false)

  /* —— 导入表单 —— */
  const [importPath, setImportPath] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  /* —— toast —— */
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimer = useRef<number | null>(null)

  function showToast(kind: ToastKind, text: string): void {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast({ kind, text })
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    setRecents(loadRecent())
    let alive = true
    projectsApi
      .list()
      .then((r) => {
        if (!alive) return
        setProjects(r.projects)
        setProjectsRoot(r.root)
        setOnline(true)
      })
      .catch(() => {
        if (!alive) return
        setProjects(null)
        setOnline(false)
      })
    return () => {
      alive = false
    }
  }, [])

  /** 文件夹名 → 服务端项目摘要（补全修改时间 / 磁盘存在性） */
  const projectByFolder = useMemo(() => {
    const map = new Map<string, ProjectSummary>()
    for (const p of projects ?? []) map.set(p.path.toLowerCase(), p)
    return map
  }, [projects])

  /** 写入最近列表（去重合并，最新在前） */
  function touchRecent(name: string, folder: string): void {
    setRecents((prev) => {
      const entry: RecentProject = { name, folder, lastOpened: new Date().toISOString() }
      const next = [entry, ...prev.filter((r) => r.folder.toLowerCase() !== folder.toLowerCase())]
      saveRecent(next.slice(0, RECENT_MAX))
      return next.slice(0, RECENT_MAX)
    })
  }

  /** 打开项目 → 进入主编辑器（v3 门禁：engineVersion 主版本必须 ≥ 3） */
  function openProject(name: string, folder: string): void {
    const summary = projects?.find((p) => p.path.toLowerCase() === folder.toLowerCase())
    const major = summary?.engineVersion ? Number.parseInt(summary.engineVersion.split('.')[0] ?? '', 10) : NaN
    if (Number.isFinite(major) && major < 3) {
      window.alert(
        `v3 不兼容 v2 项目：当前项目引擎版本为 ${summary?.engineVersion}。\n请用 v3 模板新建项目，或迁移工程后重试。`,
      )
      return
    }
    touchRecent(name, folder)
    window.location.href = '/editor.html?project=' + encodeURIComponent(folder)
  }

  async function handleCreate(): Promise<void> {
    if (creating) return
    const err = validateNameClient(newName)
    setNameError(err)
    if (err) return
    setCreating(true)
    try {
      const r = await projectsApi.create(normalizeName(newName), template)
      openProject(r.project.name, r.project.path) // 新建成功直接打开（页面随即跳转）
    } catch (e) {
      setCreating(false)
      showToast('error', errorMessage(e)) // 重名 409 等服务端 message 原样提示
    }
  }

  async function handleImport(): Promise<void> {
    if (importing) return
    const p = importPath.trim()
    if (!p) {
      setImportError('请输入本地文件夹的绝对路径')
      return
    }
    setImportError(null)
    setImporting(true)
    try {
      const r = await projectsApi.importFolder(p)
      openProject(r.project.name, r.project.path)
    } catch (e) {
      setImporting(false)
      showToast('error', errorMessage(e)) // 直接展示服务端 message
    }
  }

  function handleRemove(entry: RecentProject): void {
    if (
      !window.confirm(`从最近列表移除「${entry.name}」？\n（只移除记录，不会删除磁盘上的项目文件）`)
    ) {
      return
    }
    setRecents((prev) => {
      const next = prev.filter((r) => r.folder.toLowerCase() !== entry.folder.toLowerCase())
      saveRecent(next)
      return next
    })
    showToast('info', '已从最近列表移除（磁盘文件保留）')
  }

  return (
    <div className="pm-page">
      <header className="pm-header">
        <div className="pm-header-title">
          <div className="pm-brand">
            <Icon icon={Boxes} size={24} />
            <h1>Blueprint Studio</h1>
          </div>
          <span className={`pm-badge ${online === true ? 'ok' : online === false ? 'off' : 'wait'}`}>
            <span className="pm-service-dot" aria-hidden />
            {online === true ? '本地服务已连接' : online === false ? '本地服务离线' : '正在连接…'}
          </span>
          <span className="pm-version">v0.2.0</span>
        </div>
        <p className="pm-subtitle">工具制作引擎 · 项目管理器</p>
      </header>

      <main className="pm-columns">
        {/* ============ ① 最近项目 ============ */}
        <section className="pm-card">
          <h2 className="pm-card-title">最近项目</h2>
          {projectsRoot && <div className="pm-root" title="项目安全根目录">安全根：{projectsRoot}</div>}
          {recents.length === 0 ? (
            <div className="pm-empty">
              <Icon icon={FolderOpen} size={48} className="pm-empty-icon" />
              <div className="pm-empty-title">还没有打开过项目</div>
              <div className="pm-empty-desc">从右侧新建或导入一个项目开始使用。</div>
            </div>
          ) : (
            <ul className="pm-recent-list">
              {recents.map((r) => {
                const onDisk = projectByFolder.get(r.folder.toLowerCase())
                return (
                  <li key={r.folder} className="pm-recent-item">
                    <div className="pm-recent-info">
                      <div className="pm-recent-name" title={r.folder}>
                        {r.name}
                        {onDisk === undefined && <span className="pm-tag warn">未在磁盘</span>}
                        {onDisk?.broken && <span className="pm-tag warn">project.json 损坏</span>}
                      </div>
                      <div className="pm-recent-path" title={r.folder}>
                        {r.folder}
                      </div>
                      <div className="pm-recent-meta">
                        修改：{formatTime(onDisk?.mtime)} · 打开：{formatTime(r.lastOpened)}
                      </div>
                    </div>
                    <div className="pm-recent-actions">
                      <button
                        type="button"
                        className="pm-btn primary"
                        onClick={() => openProject(r.name, r.folder)}
                      >
                        打开
                      </button>
                      <button type="button" className="pm-btn ghost" onClick={() => handleRemove(r)}>
                        移除
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* ============ ② 新建项目 ============ */}
        <section className="pm-card">
          <h2 className="pm-card-title">新建项目</h2>
          <label className="pm-field">
            <span className="pm-field-label">项目名称</span>
            <input
              className="pm-input"
              type="text"
              value={newName}
              placeholder="如：日志分析工具"
              maxLength={80}
              onChange={(e) => {
                setNewName(e.target.value)
                if (nameError) setNameError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
              }}
            />
            {nameError && <span className="pm-field-error">{nameError}</span>}
          </label>

          <span className="pm-field-label">选择模板</span>
          <div className="pm-template-list" role="radiogroup" aria-label="项目模板">
            {TEMPLATE_CARDS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={template === t.id}
                className={`pm-template${template === t.id ? ' selected' : ''}`}
                onClick={() => setTemplate(t.id)}
              >
                <span className="pm-template-icon" aria-hidden>
                  <Icon icon={t.id === 'empty' ? FolderPlus : ListTree} size={16} />
                </span>
                <span className="pm-template-text">
                  <span className="pm-template-name">{t.title}</span>
                  <span className="pm-template-desc">{t.desc}</span>
                </span>
                {template === t.id ? (
                  <span className="pm-template-check" aria-hidden>
                    <Icon icon={Check} size={13} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="pm-btn primary block"
            disabled={creating}
            onClick={() => void handleCreate()}
          >
            {creating ? '正在创建…' : '创建项目'}
          </button>
          <p className="pm-hint">创建成功后将直接进入主编辑器。</p>
        </section>

        {/* ============ ③ 导入项目 ============ */}
        <section className="pm-card">
          <h2 className="pm-card-title">导入项目</h2>
          <label className="pm-field">
            <span className="pm-field-label">本地文件夹绝对路径</span>
            <input
              className="pm-input mono"
              type="text"
              value={importPath}
              placeholder="如 D:\\MyTools\\LogViewer"
              spellCheck={false}
              onChange={(e) => {
                setImportPath(e.target.value)
                if (importError) setImportError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleImport()
              }}
            />
            {importError && <span className="pm-field-error">{importError}</span>}
          </label>
          <button
            type="button"
            className="pm-btn primary block"
            disabled={importing}
            onClick={() => void handleImport()}
          >
            {importing ? '正在导入…' : '导入文件夹'}
          </button>
          <p className="pm-hint">
            把本机已有文件夹复制为项目：含 project.json 的文件夹原样导入；不含的会自动补齐标准目录与
            project.json。导入成功后直接打开。
          </p>
        </section>
      </main>

      {toast && <div className={`pm-toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
