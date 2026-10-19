/**
 * 插件管理面板（T6.2 · PLAN §14.2 全交互 / ADR-004）
 *
 * 功能：
 *  - 列表：GET /api/plugins?project=<当前项目>（未打开项目则不带 project 参数）。
 *    每行：kind 字符图标 / 名称 / 版本（detect 后填）/ 描述 / 来源徽标（内置·项目·静态目录，
 *    三色）/ 配套节点数；点击行展开节点详情（节点名 / 引脚 / 类型）。
 *  - 状态徽标四态（detect 结果驱动，见 model.ts deriveStatus）：
 *      未安装（灰）→【下载 / 安装】；已安装·最新（绿）→ 更新按钮置灰 disabled；
 *      可更新（黄，当前版 → 最新版）→【更新】；自定义（蓝）→【重载】（重拉清单+detect）。
 *  - 首次加载：列表渲染后逐项 detect（runPool 并发 3 节流）；detect 失败 = 未安装。
 *  - 安装 / 更新：确认对话框（显示将执行的命令——detect 返回的 cmd 优先，否则策略名）
 *    → GET /api/plugins/:id/install?action=… SSE 流：内嵌日志区实时追加（自动滚动到底部、
 *    可暂停；等宽字体；error 行红色）；done → 重跑 detect 刷新徽标 + toast 成功；
 *    error → toast；请求可取消（AbortController + 「停止」按钮，取消后状态复位）。
 *  - 警告条：清单损坏等 warnings 显示在列表顶部；「刷新」整体重拉清单 + detect。
 *
 * 接线：由本目录 index.ts 的 registerPluginManagerPanel() 注册进 dock（PM 接线一行，
 * 不改 defaultPanels.tsx）；本面板也可作为中央工作区标签页打开——
 * useWorkspaceStore.openAsset({ kind:'plugin-manager', assetPath:'', title:'插件管理' })，
 * 面板头部提供「在编辑器中打开」按钮与说明文字。
 *
 * 注意：本文件不 import .css（node:test 需直接加载本文件做挂载冒烟）；
 * 样式由 index.ts（注册入口）引入 styles.css，全部引用 theme.css token。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plug, SquareTerminal } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { useWorkspaceStore } from '@/shell/workspace-store'
import type { PluginManifest, PluginNodeSpec } from '@/ir/types'
import {
  deriveStatus,
  installCommandText,
  runPool,
  type DetectEntry,
  type DetectResult,
} from './model'
import { defaultPluginApi, errorMessage, type PluginApi } from './api'
import type { InstallStreamEvent } from './sse'

/* ============================================================
 * 常量与小工具
 * ============================================================ */

/** 首次加载逐项 detect 的并发上限（任务卡定案：并发 3 节流） */
export const DETECT_CONCURRENCY = 3

/** toast 自动消失时长 */
const TOAST_MS = 4000

/** 安装流日志行 */
interface LogLine {
  kind: 'log' | 'error'
  text: string
}

/** 进行中 / 刚结束的安装任务（内嵌日志区） */
interface InstallJob {
  pluginId: string
  action: 'install' | 'update'
  lines: LogLine[]
  running: boolean
}

interface ToastState {
  kind: 'success' | 'error' | 'info'
  text: string
}

/** 确认对话框状态 */
interface ConfirmState {
  manifest: PluginManifest
  action: 'install' | 'update'
  commandText: string | null
}

/** kind 字符图标（cli=终端提示符 / custom=自定义插件标记） */
function kindIcon(kind: PluginManifest['kind']) {
  return kind === 'cli' ? SquareTerminal : Plug
}

/** 来源徽标文案 */
const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  project: '项目',
  static: '静态目录',
}

/** 引脚摘要文本：id:类型（可选标记） */
function pinText(pins: PluginNodeSpec['inputs']): string {
  if (!pins || pins.length === 0) return '—'
  return pins
    .map((p) => `${p.id}:${p.type}${p.optional ? '?' : ''}`)
    .join('、')
}

/* ============================================================
 * 面板
 * ============================================================ */

export interface PluginManagerPanelProps {
  /** 注入式 API（测试用；默认走全局 fetch 的 defaultPluginApi） */
  api?: PluginApi
}

export function PluginManagerPanel({ api = defaultPluginApi }: PluginManagerPanelProps) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const projectPath = project?.path ?? null

  /* —— 列表与 detect 状态 —— */
  const [manifests, setManifests] = useState<PluginManifest[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detects, setDetects] = useState<Record<string, DetectEntry>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  /* —— 安装 / 更新 —— */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [job, setJob] = useState<InstallJob | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [toast, setToast] = useState<ToastState | null>(null)

  const jobRef = useRef<InstallJob | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const disposedRef = useRef(false)
  /** detect 轮次（整体刷新后，旧轮次的迟到结果按过期丢弃） */
  const loadGenRef = useRef(0)
  const toastTimerRef = useRef<number | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    jobRef.current = job
  }, [job])

  const showToast = useCallback((kind: ToastState['kind'], text: string): void => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ kind, text })
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(
    () => () => {
      disposedRef.current = true
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      abortRef.current?.abort() // 卸载时中断在途安装流
    },
    [],
  )

  /* —— 单插件 detect（安装完成后刷新徽标用） —— */
  const redetect = useCallback(
    async (pluginId: string): Promise<void> => {
      setDetects((prev) => (prev[pluginId] ? { ...prev, [pluginId]: { phase: 'checking' } } : prev))
      try {
        const r = await api.detect(pluginId, projectPath)
        if (disposedRef.current) return
        setDetects((prev) => (prev[pluginId] ? { ...prev, [pluginId]: { phase: 'settled', result: r } } : prev))
      } catch (e) {
        if (disposedRef.current) return
        setDetects((prev) =>
          prev[pluginId] ? { ...prev, [pluginId]: { phase: 'settled', failure: errorMessage(e) } } : prev,
        )
      }
    },
    [api, projectPath],
  )

  /* —— 列表加载 + 逐项 detect（并发 3） —— */
  const loadList = useCallback(async (): Promise<void> => {
    const gen = ++loadGenRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const { manifests: list, warnings: warns } = await api.list(projectPath)
      if (disposedRef.current || loadGenRef.current !== gen) return
      setManifests(list)
      setWarnings(warns)
      const init: Record<string, DetectEntry> = {}
      for (const m of list) init[m.id] = m.detect ? { phase: 'checking' } : { phase: 'settled' }
      setDetects(init)
      setLoading(false)
      // 列表渲染后逐项 detect：并发 3 节流；单项失败按未安装处理（不中断其余项）
      const tasks = list
        .filter((m) => m.detect)
        .map((m) => async (): Promise<null> => {
          let r: DetectResult
          try {
            r = await api.detect(m.id, projectPath)
          } catch (e) {
            if (disposedRef.current || loadGenRef.current !== gen) return null
            setDetects((prev) =>
              prev[m.id] ? { ...prev, [m.id]: { phase: 'settled', failure: errorMessage(e) } } : prev,
            )
            return null
          }
          if (disposedRef.current || loadGenRef.current !== gen) return null
          setDetects((prev) => (prev[m.id] ? { ...prev, [m.id]: { phase: 'settled', result: r } } : prev))
          return null
        })
      await runPool(tasks, DETECT_CONCURRENCY)
    } catch (e) {
      if (disposedRef.current || loadGenRef.current !== gen) return
      setManifests([])
      setDetects({})
      setLoadError(errorMessage(e))
      setLoading(false)
    }
  }, [api, projectPath])

  useEffect(() => {
    void loadList()
  }, [loadList])

  /* —— 日志自动滚动（可暂停） —— */
  const lineCount = job?.lines.length ?? 0
  useEffect(() => {
    if (!autoScroll) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lineCount, autoScroll])

  /* —— 安装 / 更新执行 —— */
  const startInstall = useCallback(
    async (manifest: PluginManifest, action: 'install' | 'update'): Promise<void> => {
      if (jobRef.current?.running) return // 同时只允许一个安装任务
      const verb = action === 'install' ? '安装' : '更新'
      const controller = new AbortController()
      abortRef.current = controller
      const fresh: InstallJob = { pluginId: manifest.id, action, lines: [], running: true }
      jobRef.current = fresh
      setJob(fresh)
      let lastError: string | null = null
      const appendLine = (line: LogLine): void => {
        setJob((prev) =>
          prev && prev.pluginId === manifest.id ? { ...prev, lines: [...prev.lines, line] } : prev,
        )
      }
      let outcome: 'done' | 'error' | 'aborted' | 'closed' = 'closed'
      try {
        outcome = await api.startInstall({
          pluginId: manifest.id,
          action,
          project: projectPath,
          signal: controller.signal,
          onEvent: (ev: InstallStreamEvent) => {
            if (ev.type === 'log') appendLine({ kind: 'log', text: ev.line })
            else if (ev.type === 'error') {
              lastError = ev.message
              appendLine({ kind: 'error', text: ev.message })
            } else appendLine({ kind: 'log', text: ev.message ?? '完成' })
          },
        })
      } catch (e) {
        lastError = errorMessage(e)
        appendLine({ kind: 'error', text: lastError })
        outcome = 'closed'
      }
      if (disposedRef.current) return
      abortRef.current = null
      if (outcome === 'done') {
        setJob((prev) => (prev && prev.pluginId === manifest.id ? { ...prev, running: false } : prev))
        showToast('success', `「${manifest.name}」${verb}完成`)
        void redetect(manifest.id) // done → 重跑 detect 刷新状态徽标
      } else if (outcome === 'error') {
        setJob((prev) => (prev && prev.pluginId === manifest.id ? { ...prev, running: false } : prev))
        showToast('error', `「${manifest.name}」${verb}失败：${lastError ?? '未知错误'}`)
      } else if (outcome === 'aborted') {
        setJob((prev) => (prev && prev.pluginId === manifest.id ? null : prev)) // 取消：状态复位
        showToast('info', `已停止「${manifest.name}」的${verb}`)
      } else {
        setJob((prev) => (prev && prev.pluginId === manifest.id ? { ...prev, running: false } : prev))
        showToast('error', `「${manifest.name}」${verb}连接中断${lastError ? `：${lastError}` : ''}`)
      }
    },
    [api, projectPath, redetect, showToast],
  )

  const stopInstall = useCallback((): void => {
    abortRef.current?.abort()
  }, [])

  /* —— 打开确认对话框（显示将执行的命令 / 策略） —— */
  const openConfirm = useCallback(
    (manifest: PluginManifest, action: 'install' | 'update'): void => {
      const entry = detects[manifest.id]
      const detect = entry?.phase === 'settled' ? entry.result ?? null : null
      setConfirm({ manifest, action, commandText: installCommandText(manifest, detect) })
    },
    [detects],
  )

  const toggleExpand = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /* ============================================================
   * 渲染
   * ============================================================ */

  function renderActions(m: PluginManifest): ReactNode {
    const entry: DetectEntry = detects[m.id] ?? { phase: 'checking' }
    const st = deriveStatus(m, entry)
    const busy = job?.running === true && job.pluginId === m.id
    if (st.state === 'checking') {
      return <span className="pm-detecting">检测中…</span>
    }
    if (st.state === 'not-installed') {
      if (!m.install) return <span className="pm-no-install">未提供安装命令（请手动安装）</span>
      return (
        <button
          type="button"
          className="pm-btn primary"
          data-action="install"
          disabled={busy}
          title={st.message ?? '安装该插件'}
          onClick={() => openConfirm(m, 'install')}
        >
          下载 / 安装
        </button>
      )
    }
    if (st.state === 'up-to-date') {
      return (
        <button
          type="button"
          className="pm-btn"
          data-action="update"
          disabled
          title="已是最新版本"
        >
          更新
        </button>
      )
    }
    if (st.state === 'updatable') {
      return (
        <button
          type="button"
          className="pm-btn primary"
          data-action="update"
          disabled={busy}
          title={st.version ? `当前 ${st.version} → 最新 ${st.latest ?? '?'}` : '更新该插件'}
          onClick={() => openConfirm(m, 'update')}
        >
          更新
        </button>
      )
    }
    // custom：无安装按钮，重载 = 重新拉取清单 + detect
    return (
      <button
        type="button"
        className="pm-btn"
        data-action="reload"
        disabled={busy}
        title="重新拉取清单并检测"
        onClick={() => void loadList()}
      >
        重载
      </button>
    )
  }

  function renderBadge(m: PluginManifest): ReactNode {
    const entry: DetectEntry = detects[m.id] ?? { phase: 'checking' }
    const st = deriveStatus(m, entry)
    if (st.state === 'checking') return <span className="pm-badge checking">检测中…</span>
    if (st.state === 'not-installed') {
      return (
        <span className="pm-badge state-not-installed" title={st.message ?? '未检测到安装'}>
          未安装
        </span>
      )
    }
    if (st.state === 'up-to-date') {
      return <span className="pm-badge state-up-to-date" title="已是最新版本">已安装·最新</span>
    }
    if (st.state === 'updatable') {
      return (
        <span className="pm-badge state-updatable" title={st.message ?? '有新版本可用'}>
          可更新{st.version ? ` ${st.version} → ${st.latest ?? '?'}` : ''}
        </span>
      )
    }
    return <span className="pm-badge state-custom" title="自定义插件（不做检测）">自定义</span>
  }

  function renderRow(m: PluginManifest): ReactNode {
    const entry: DetectEntry = detects[m.id] ?? { phase: 'checking' }
    const st = deriveStatus(m, entry)
    const isOpen = expanded.has(m.id)
    return (
      <div key={m.id} className="pm-item" data-plugin-id={m.id}>
        <div
          className={`pm-row${isOpen ? ' open' : ''}`}
          onClick={() => toggleExpand(m.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleExpand(m.id)
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span className="pm-chevron" aria-hidden>
            <Icon icon={isOpen ? ChevronDown : ChevronRight} size={12} />
          </span>
          <span className={`pm-icon kind-${m.kind}`} aria-hidden>
            <Icon icon={kindIcon(m.kind)} size={14} />
          </span>
          <span className="pm-name" title={m.id}>{m.name}</span>
          <span className="pm-version" title="当前版本（检测后填入）">{st.version ?? '—'}</span>
          <span className="pm-desc" title={m.description}>{m.description || '（无描述）'}</span>
          {renderBadge(m)}
          <span className={`pm-badge-source source-${m.source ?? 'unknown'}`} title="清单来源">
            {SOURCE_LABEL[m.source ?? ''] ?? '未知'}
          </span>
          <span className="pm-nodecount" title="配套节点数">{m.nodes.length} 节点</span>
          <span className="pm-actions" onClick={(e) => e.stopPropagation()}>{renderActions(m)}</span>
        </div>
        {job && job.pluginId === m.id && (
          <div className="pm-job">
            <div className="pm-job-head">
              <span className={`pm-job-title${job.running ? ' running' : ''}`}>
                {job.running
                  ? `正在${job.action === 'install' ? '安装' : '更新'}「${m.name}」…`
                  : `${job.action === 'install' ? '安装' : '更新'}已结束`}
              </span>
              <label className="pm-scroll-toggle" title="暂停 / 恢复自动滚动到底部">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                自动滚动
              </label>
              {job.running ? (
                <button type="button" className="pm-btn small danger" onClick={stopInstall}>
                  停止
                </button>
              ) : (
                <button type="button" className="pm-btn small" onClick={() => setJob(null)}>
                  关闭日志
                </button>
              )}
            </div>
            <div className="pm-log" ref={logRef}>
              {job.lines.map((l, i) => (
                <div key={i} className={`pm-log-line${l.kind === 'error' ? ' error' : ''}`}>
                  {l.text}
                </div>
              ))}
              {job.lines.length === 0 ? <div className="pm-log-line dim">等待服务端输出…</div> : null}
            </div>
          </div>
        )}
        {isOpen && (
          <div className="pm-details">
            {m.nodes.length === 0 ? (
              <div className="pm-details-empty">该插件未封装节点</div>
            ) : (
              m.nodes.map((n) => (
                <div key={n.id} className="pm-node">
                  <div className="pm-node-head">
                    <span className="pm-node-title">{n.title}</span>
                    {n.kind === 'event' ? <span className="pm-node-kind">持续流</span> : null}
                    <span className="pm-node-id">{n.id}</span>
                  </div>
                  <div className="pm-node-pins">
                    <span className="pm-pin-group">入：{pinText(n.inputs)}</span>
                    <span className="pm-pin-group">出：{pinText(n.outputs)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="pm-panel">
      <div className="pm-header">
        <span className="pm-header-title">插件管理</span>
        <span className="pm-header-project" title={projectPath ?? undefined}>
          {project ? project.name : '未打开项目（仅显示内置与静态目录插件）'}
        </span>
        <button
          type="button"
          className="pm-header-btn"
          title="重新拉取清单并逐项检测"
          onClick={() => void loadList()}
        >
          刷新
        </button>
      </div>
      {warnings.length > 0 && (
        <div className="pm-warnings" role="alert" title="清单损坏 / 校验失败等告警（已跳过对应清单）">
          {warnings.map((w, i) => (
            <div key={i} className="pm-warning-line">
              <span className="pm-warn-mark">!</span>
              {w}
            </div>
          ))}
        </div>
      )}
      <div className="pm-list">
        {loadError ? (
          <div className="pm-empty">
            插件清单加载失败
            <br />
            {loadError}
            <br />
            （请确认本地服务已启动，点击「刷新」重试）
          </div>
        ) : loading && manifests.length === 0 ? (
          <div className="pm-empty">正在加载插件清单…</div>
        ) : manifests.length === 0 ? (
          <div className="pm-empty">
            未发现插件
            <br />
            （内置注册表 plugins-registry/ 为空）
          </div>
        ) : (
          manifests.map((m) => renderRow(m))
        )}
      </div>
      <div className="pm-footer-hint">
        提示：本界面已迁入右上角「设置 → 插件」模态弹窗（v3 T8.3）；安装/更新行为与原面板一致。
      </div>
      {confirm && (
        <div
          className="pm-confirm-overlay"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setConfirm(null)
          }}
        >
          <div
            className="pm-confirm"
            role="dialog"
            aria-label={`${confirm.action === 'install' ? '安装' : '更新'}插件`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirm(null)
            }}
          >
            <div className="pm-confirm-title">
              {confirm.action === 'install' ? '安装' : '更新'}「{confirm.manifest.name}」
            </div>
            <div className="pm-confirm-label">将执行命令（服务端执行，可随时停止）：</div>
            <code className="pm-confirm-cmd">{confirm.commandText ?? '（无可用命令）'}</code>
            <div className="pm-confirm-actions">
              <button type="button" className="pm-btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="pm-btn primary"
                onClick={() => {
                  const { manifest, action } = confirm
                  setConfirm(null)
                  void startInstall(manifest, action)
                }}
              >
                {confirm.action === 'install' ? '确认安装' : '确认更新'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`pm-toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
