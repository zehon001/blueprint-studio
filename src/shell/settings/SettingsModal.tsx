/**
 * 设置模态弹窗（v3 T8.3 · PLAN §4.3）
 *
 * 右上角齿轮 / Ctrl+, 打开；左侧四分区（通用 / 快捷键 / 插件 / 关于）。
 * - 整个弹窗是模态：Esc / 点遮罩关闭；弹窗内按键不冒泡到全局快捷键；
 * - 上次分区记在 bps.settings.section（仅 UI 习惯，不写进设置文件）；
 * - 快捷键分区复用 v2 SettingsPanel（改键/冲突/恢复默认能力不丢）；
 * - 插件分区复用 PluginManagerPanel（四态徽标/SSE 日志/刷新能力不丢）；
 * - 本文件不 import CSS（node:test 可加载 store / 校验纯函数）。
 */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { registerDefaultShortcut } from '@/shell/keymap/registry'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { SettingsPanel } from '@/panels/settings'
import { PluginManagerPanel } from '@/panels/plugin-manager'
import {
  loadLastSection,
  saveLastSection,
  useSettingsStore,
  validateLibraryRoot,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './store'

export type { SettingsSection } from './store'

interface SettingsModalState {
  open: boolean
  section: SettingsSection
  openSettings: (section?: SettingsSection) => void
  setSection: (section: SettingsSection) => void
  close: () => void
}

export const useSettingsModal = create<SettingsModalState>()((set) => ({
  open: false,
  section: loadLastSection(),
  openSettings: (section) => {
    const next = section ?? loadLastSection()
    saveLastSection(next)
    set({ open: true, section: next })
  },
  setSection: (section) => {
    saveLastSection(section)
    set({ section })
  },
  close: () => set({ open: false }),
}))

/* ---------------- 通用分区 ---------------- */

function GeneralSection() {
  const libraryRoot = useSettingsStore((s) => s.libraryRoot)
  const autoRerun = useSettingsStore((s) => s.autoRerun)
  const update = useSettingsStore((s) => s.update)
  const projectPath = useWorkspaceStore((s) => s.currentProject?.path ?? null)
  const [draft, setDraft] = useState(libraryRoot)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => setDraft(libraryRoot), [libraryRoot])

  const apply = (): void => {
    const message = validateLibraryRoot(draft, projectPath)
    setError(message)
    if (message) return
    update({ libraryRoot: draft.trim() })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">通用</h3>
      <div className="settings-field">
        <label className="settings-label" htmlFor="settings-library-root">
          内置资源库路径
        </label>
        <div className="settings-row">
          <input
            id="settings-library-root"
            className="settings-input"
            value={draft}
            spellCheck={false}
            placeholder="留空使用默认：%USERPROFILE%\.blueprint-studio\library"
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply()
            }}
          />
          <button type="button" className="settings-btn primary" onClick={apply}>
            应用
          </button>
          <button
            type="button"
            className="settings-btn"
            title="恢复服务端默认库路径"
            onClick={() => {
              setDraft('')
              update({ libraryRoot: '' })
              setError(null)
            }}
          >
            默认
          </button>
        </div>
        {error ? <div className="settings-error">{error}</div> : null}
        {saved ? <div className="settings-ok">已保存（库读写将在资源库服务接入后生效）</div> : null}
        <div className="settings-hint">
          路径为编辑器级资源库根（所有项目共用）；M8 仅做格式校验，安全根与越权拒绝由资源库服务（T11.4）接管。
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={autoRerun}
            onChange={(e) => update({ autoRerun: e.target.checked })}
          />
          保存成功后自动重跑内置运行视图
        </label>
        <div className="settings-hint">关闭后仍可手动点运行 / 刷新；默认开启。</div>
      </div>
    </div>
  )
}

/* ---------------- 弹窗 ---------------- */

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'general':
      return <GeneralSection />
    case 'shortcuts':
      return <SettingsPanel />
    case 'plugins':
      return <PluginManagerPanel />
    case 'about':
      return (
        <div className="settings-section">
          <h3 className="settings-section-title">关于</h3>
          <div className="settings-about-name">Blueprint Studio</div>
          <div className="settings-hint">可视化插件引擎 · v3（编辑器体验与数据模型升级）</div>
          <div className="settings-hint">
            前端 React 18 + TypeScript + Vite + React Flow；本地 Node 服务（资产 / 运行时 / 插件 / 资源库）。
          </div>
          <div className="settings-hint">文档：docs/v3/PLAN.md · docs/v3/TASKBOARD.md · docs/user-manual.md</div>
        </div>
      )
    default:
      return null
  }
}

/** 设置模态宿主：随外壳常驻，负责 Ctrl+, 与弹窗渲染 */
export function SettingsModalHost() {
  const open = useSettingsModal((s) => s.open)
  const section = useSettingsModal((s) => s.section)
  const setSection = useSettingsModal((s) => s.setSection)
  const close = useSettingsModal((s) => s.close)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Ctrl+, 默认键位：记入回放表（「恢复默认」后不丢）
  useEffect(() => {
    registerDefaultShortcut({
      id: 'settings.open',
      label: '打开设置',
      keys: 'Ctrl+,',
      handler: () => useSettingsModal.getState().openSettings(),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    // 打开后焦点入弹窗（键盘用户可直接 Tab）
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="settings-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDownCapture={(e) => {
          // 弹窗内按键不触发全局快捷键（Esc 由 window 监听处理）
          if (e.key !== 'Escape') e.stopPropagation()
        }}
      >
        <div className="settings-side">
          <div className="settings-title">设置</div>
          <div className="settings-nav">
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings-nav-item${s.id === section ? ' active' : ''}`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-content">
          <button type="button" className="settings-close" title="关闭（Esc）" onClick={close}>
            ×
          </button>
          <SectionBody section={section} />
        </div>
      </div>
    </div>
  )
}

/** 命令式打开（顶栏齿轮 / 其它面板用） */
export function openSettings(section?: SettingsSection): void {
  useSettingsModal.getState().openSettings(section)
}
