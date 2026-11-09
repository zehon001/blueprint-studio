/**
 * 隐藏运行宿主（运行面板移除后的运行承载）
 *
 * 运行不再占用 dock 面板：iframe 以 0 尺寸常驻后台执行蓝图，
 * print / 生命周期 / 错误行经 BroadcastChannel 'bps-console' 实时推送到
 * 编辑器控制台（原运行面板只显示打印信息，功能并入控制台输出）。
 * 保留：保存成功自动重跑（设置 autoRerun）、iframe 内 F5 / Ctrl+S 转发。
 */
import { useEffect, useRef } from 'react'
import { getBindings } from '@/shell/keymap/registry'
import { useSettingsStore } from '@/shell/settings/store'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { buildRuntimeUrl, launchRuntime } from '@/shell/runtime-launch'
import { useRuntimeStore, type RuntimeTarget } from './store'
import './runtime-host.css'

/** 隐藏 iframe 运行 URL（embed + nonce） */
export function buildEmbedRuntimeUrl(target: RuntimeTarget, nonce: number): string {
  return buildRuntimeUrl({
    project: target.project,
    bp: target.bp,
    embed: true,
    run: nonce,
  })
}

/** 拆分窗口 URL（完整运行页，不带 embed；预留给外部窗口场景） */
export function buildExternalRuntimeUrl(target: RuntimeTarget): string {
  return buildRuntimeUrl({ project: target.project, bp: target.bp })
}

/** iframe 键盘转发消息形状 */
interface RuntimeKeyMessage {
  type?: string
  key?: string
}

export function RuntimeHost() {
  const target = useRuntimeStore((s) => s.target)
  const nonce = useRuntimeStore((s) => s.nonce)
  const rerun = useRuntimeStore((s) => s.rerun)
  const autoRerun = useSettingsStore((s) => s.autoRerun)
  const saveSeq = useWorkspaceStore((s) => s.saveSeq)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const lastSaveSeq = useRef(saveSeq)

  /** 保存成功自动重跑（默认开；只在「新的一次保存」且已有运行目标时） */
  useEffect(() => {
    if (saveSeq === lastSaveSeq.current) return
    lastSaveSeq.current = saveSeq
    if (!autoRerun || !target) return
    rerun()
  }, [saveSeq, autoRerun, target, rerun])

  /** iframe 内快捷键转发（F5/Ctrl+S） */
  useEffect(() => {
    if (!target) return
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const msg = e.data as RuntimeKeyMessage | null
      if (!msg || msg.type !== 'bps-runtime-key') return
      if (msg.key === 'F5') void launchRuntime()
      else if (msg.key === 'Ctrl+S') getBindings('file.save')[0]?.handler()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [target])

  if (!target) return null
  return (
    <iframe
      ref={iframeRef}
      className="runtime-hidden-iframe"
      title="蓝图运行宿主"
      src={buildEmbedRuntimeUrl(target, nonce)}
    />
  )
}
