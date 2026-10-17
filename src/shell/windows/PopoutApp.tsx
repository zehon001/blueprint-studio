/**
 * 弹窗模式根组件（T0.4 · PLAN §3.1）
 *
 * URL 约定：/editor.html?panel=<panelId>&project=<项目路径>
 * main.tsx 检测 ?panel= 后以本组件替代 DockShell 渲染：
 *   - 只渲染该面板（registry 组件，业务状态经 bridge 镜像保持与主窗一致）；
 *   - 安装即发 hello 拉全量快照；卸载（关闭窗口）发 bye → 主窗自动合回；
 *   - 标题「面板名 · Blueprint Studio」；头部展示同步状态与主窗撤销历史摘要；
 *   - 主窗心跳超时失联 → 提示并延时自动关闭（主窗侧也会主动关窗 + 自动合回）。
 */
import { useEffect } from 'react'
import { getPanel } from '@/shell/dock/registry'
import { installPopoutBridge, useWindowLinkStore } from './bridge'
import { recallPopout, usePopoutsStore } from './popout'
import { ToastHost } from './toast'
import './windows.css'

/** 主窗 dock 中「已拆出」占位页签（点击合回；失联态自动合回前的提示） */
export function PopoutPlaceholder({ panelId }: { panelId: string }) {
  const session = usePopoutsStore((s) => s.sessions[panelId])
  const title = getPanel(panelId)?.title ?? panelId
  return (
    <div className="dock-panel-placeholder">
      <div className="dock-panel-placeholder-title">{title} · 已拆出</div>
      {session?.status === 'lost' ? (
        <div className="popout-lost-hint">弹窗窗口已失联，正在自动合回…</div>
      ) : (
        <div>
          该面板已在独立{session?.mode === 'tab' ? '标签页' : '窗口'}中打开，业务状态与主窗实时同步；
          关闭弹窗后将自动回到此处。
        </div>
      )}
      <button
        type="button"
        className="popout-placeholder-btn"
        title="关闭弹窗并把面板恢复到主窗此页签"
        onClick={() => recallPopout(panelId)}
      >
        合回主窗
      </button>
    </div>
  )
}

/** 弹窗模式根：只渲染 ?panel= 指定的面板 */
export default function PopoutApp({ panelId }: { panelId: string }) {
  const def = getPanel(panelId)
  const connected = useWindowLinkStore((s) => s.connected)
  const lost = useWindowLinkStore((s) => s.lost)
  const undoCount = useWindowLinkStore((s) => s.undoCount)

  useEffect(() => {
    if (!def) return
    document.title = `${def.title} · Blueprint Studio`
    const bridge = installPopoutBridge({ panelId, title: def.title })
    // 关窗 / 刷新前告知主窗（bye）→ 面板自动回主窗原位
    const sayBye = (): void => {
      try {
        bridge.sync.sendControl('bye', { panelId })
      } catch {
        /* 通道可能已关闭 */
      }
    }
    window.addEventListener('pagehide', sayBye)
    window.addEventListener('beforeunload', sayBye)
    return () => {
      window.removeEventListener('pagehide', sayBye)
      window.removeEventListener('beforeunload', sayBye)
      sayBye()
      bridge.dispose()
    }
  }, [def, panelId])

  // 主窗失联（心跳超时）：提示后自动关闭（主窗侧同样会判定失联并自动合回）
  useEffect(() => {
    if (!lost) return
    const timer = window.setTimeout(() => window.close(), 1500)
    return () => window.clearTimeout(timer)
  }, [lost])

  if (!def) {
    return (
      <div className="popout-app">
        <div className="dock-panel-placeholder">
          <div className="dock-panel-placeholder-title">未知面板：{panelId}</div>
          <div>请回到主编辑器，从面板页签重新拆出。</div>
        </div>
        <ToastHost />
      </div>
    )
  }

  return (
    <div className="popout-app">
      <div className="popout-header">
        <span
          className={`popout-link-dot${connected && !lost ? ' on' : ''}`}
          title={lost ? '与主窗失联' : connected ? '与主窗已同步' : '正在连接主窗'}
        />
        <span className="popout-title">{def.title}</span>
        <span className="popout-status">
          {lost ? '与主窗失联，即将自动关闭' : connected ? '已同步' : '正在连接主窗…'}
        </span>
        <span className="popout-history" title="撤销栈真源在主窗；弹窗改动同样计入主窗历史">
          撤销历史 {undoCount} 条 · 由主窗管理
        </span>
        <button
          type="button"
          className="popout-recall-btn"
          title="关闭本窗口，面板回到主窗原位"
          onClick={() => window.close()}
        >
          合回主窗
        </button>
      </div>
      <div className="popout-body">
        <def.component />
      </div>
      <ToastHost />
    </div>
  )
}
