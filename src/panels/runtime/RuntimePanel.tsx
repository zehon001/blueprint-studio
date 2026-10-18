/**
 * 内置运行视图面板（v3 T8.5 · PLAN §4.5）
 *
 * - 单实例 iframe 承载 `runtime.html?...&embed=1&run=<nonce>`；
 * - F5/F6 经 runtime-launch 更新 target → 本面板随 nonce 刷新 src（不双开）；
 * - `autoRerun`（设置默认开）：保存成功（workspace.saveSeq 增长）后自动重跑；
 * - 「拆出独立窗口」：window.open 完整运行页（pong 探测沿用）+ 关闭内置面板；
 * - iframe 内 F5/F6/Ctrl+S 经 postMessage 转发父窗执行。
 *
 * 本文件不 import CSS（node:test 可加载 store / 纯函数）。
 */
import { useCallback, useEffect, useRef } from 'react'
import { getBindings } from '@/shell/keymap/registry'
import { useDockStore } from '@/shell/dock/store'
import { useSettingsStore } from '@/shell/settings/store'
import { useWorkspaceStore } from '@/shell/workspace-store'
import {
  buildRuntimeUrl,
  launchRuntimeCurrent,
  launchRuntimeMain,
  openRuntimeWindowExternal,
  RUNTIME_WINDOW_FEATURES,
  runtimeWindowName,
} from '@/shell/runtime-launch'
import { useRuntimeStore, RUNTIME_PANEL_ID, type RuntimeTarget } from './store'

/** 运行面板 URL（embed + nonce） */
export function buildEmbedRuntimeUrl(target: RuntimeTarget, nonce: number): string {
  return buildRuntimeUrl({
    project: target.project,
    ui: target.ui,
    mode: target.mode,
    embed: true,
    run: nonce,
  })
}

/** 拆分窗口 URL（完整运行页，不带 embed） */
export function buildExternalRuntimeUrl(target: RuntimeTarget): string {
  return buildRuntimeUrl({ project: target.project, ui: target.ui, mode: target.mode })
}

/** iframe 键盘转发消息形状 */
interface RuntimeKeyMessage {
  type?: string
  key?: string
}

function modeLabel(mode: RuntimeTarget['mode']): string {
  return mode === 'current' ? '当前 UI' : '主 UI'
}

export function RuntimePanel() {
  const target = useRuntimeStore((s) => s.target)
  const nonce = useRuntimeStore((s) => s.nonce)
  const rerun = useRuntimeStore((s) => s.rerun)
  const stop = useRuntimeStore((s) => s.clearTarget)
  const autoRerun = useSettingsStore((s) => s.autoRerun)
  const saveSeq = useWorkspaceStore((s) => s.saveSeq)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  /** 保存成功自动重跑（默认开；只在已有运行目标时） */
  useEffect(() => {
    if (!autoRerun || !target || saveSeq <= 0) return
    rerun()
  }, [saveSeq, autoRerun, target, rerun])

  /** iframe 内快捷键转发（F5/F6/Ctrl+S） */
  useEffect(() => {
    if (!target) return
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const msg = e.data as RuntimeKeyMessage | null
      if (!msg || msg.type !== 'bps-runtime-key') return
      if (msg.key === 'F5') void launchRuntimeMain()
      else if (msg.key === 'F6') void launchRuntimeCurrent()
      else if (msg.key === 'Ctrl+S') getBindings('file.save')[0]?.handler()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [target])

  const onPopout = useCallback(async (): Promise<void> => {
    if (!target) return
    const ok = await openRuntimeWindowExternal(buildExternalRuntimeUrl(target), target.mode)
    if (ok) useDockStore.getState().closePanel(RUNTIME_PANEL_ID)
  }, [target])

  if (!target) {
    return (
      <div className="runtime-panel runtime-panel--empty">
        <div className="runtime-panel-empty-title">运行视图</div>
        <div className="runtime-panel-empty-hint">按 F5 运行主 UI，或 F6 运行当前 UI；运行结果会在此标签内显示。</div>
        <div className="runtime-panel-empty-hint">需要独立窗口时，运行后点右上角「拆出独立窗口」。</div>
      </div>
    )
  }

  return (
    <div className="runtime-panel">
      <div className="runtime-panel-bar">
        <span className="runtime-panel-title">运行 · {modeLabel(target.mode)}</span>
        <span className="runtime-panel-meta" title={target.ui ?? 'project.json 的 mainUI'}>
          {target.project}
          {target.ui ? ` / ${target.ui}` : ''}
        </span>
        <span className="runtime-panel-spacer" />
        <button
          type="button"
          className="runtime-panel-btn runtime-panel-btn--stop"
          onClick={stop}
          title="停止运行：卸载 iframe、中止蓝图运行时与定时器"
        >
          停止
        </button>
        <button type="button" className="runtime-panel-btn" onClick={rerun} title="重跑当前目标">
          重跑
        </button>
        <button
          type="button"
          className="runtime-panel-btn"
          onClick={() => void onPopout()}
          title={`打开 ${RUNTIME_WINDOW_FEATURES} 独立运行窗口并关闭内置视图`}
        >
          拆出独立窗口
        </button>
      </div>
      <div className="runtime-panel-stage">
        <iframe
          ref={iframeRef}
          className="runtime-panel-iframe"
          title={`运行视图：${runtimeWindowName(target.mode)}`}
          src={buildEmbedRuntimeUrl(target, nonce)}
        />
      </div>
    </div>
  )
}
