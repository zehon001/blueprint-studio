/**
 * 编辑器控制台（T1.6 兑现：运行窗口日志接入编辑器）
 *
 * 数据通道：BroadcastChannel 'bps-console' —— 运行窗口（runtime.html）每追加一条
 * 控制台行就 post 一条消息（含项目名 / 运行模式 / 时间戳），编辑器控制台面板订阅
 * 同名频道实时显示。同源多窗口（编辑器 + 多个运行窗口）共享同一频道；编辑器自身
 * 刷新后频道重订阅（历史行不回放，运行窗口仍持续推送新行）。
 *
 * 本模块的 reduceConsoleMessage / CONSOLE_MAX_LINES 为纯逻辑（node:test 可测），
 * 组件只做订阅与渲染。
 */
import { useEffect, useRef, useState } from 'react'
import { useConsoleUiStore } from './ui-store'
import {
  CONSOLE_CHANNEL,
  CONSOLE_MAX_LINES,
  parseConsoleEvent,
  type ConsoleMessage,
} from './protocol'

export { CONSOLE_CHANNEL, CONSOLE_MAX_LINES, parseConsoleEvent } from './protocol'
export type { ConsoleMessage } from './protocol'

/** 面板内的一行（渲染视图：时间 + 正文） */
export interface ConsoleRow {
  key: string
  time: string
  line: string
}

/** 纯函数：把一条广播消息追加进行列表（FIFO 上限；单测可测） */
export function reduceConsoleMessage(rows: ConsoleRow[], msg: ConsoleMessage): ConsoleRow[] {
  const row: ConsoleRow = {
    key: `${msg.ts}-${rows.length}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date(msg.ts).toLocaleTimeString('zh-CN', { hour12: false }),
    line: msg.line,
  }
  const next = rows.length >= CONSOLE_MAX_LINES ? rows.slice(rows.length - CONSOLE_MAX_LINES + 1) : rows.slice()
  next.push(row)
  return next
}

/** 控制台面板（dock 注册组件；占位面板 ConsolePanelPlaceholder 的正式实现） */
export function ConsolePanel() {
  const [rows, setRows] = useState<ConsoleRow[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const clearSeq = useConsoleUiStore((s) => s.clearSeq)

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    let ch: BroadcastChannel | null = null
    try {
      ch = new BroadcastChannel(CONSOLE_CHANNEL)
    } catch {
      return
    }
    ch.onmessage = (ev: MessageEvent) => {
      const msg = parseConsoleEvent(ev.data)
      if (msg) setRows((prev) => reduceConsoleMessage(prev, msg))
    }
    return () => {
      ch!.close()
    }
  }, [])

  // 清空按钮在 dock 标签栏：收到请求后清空当前显示
  useEffect(() => {
    if (clearSeq > 0) setRows([])
  }, [clearSeq])

  // 跟随滚动到底部（最新输出可见）
  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [rows])

  return (
    <div className="bps-console">
      <div className="bps-console-body" ref={bodyRef}>
        {rows.length === 0 ? (
          <div className="bps-console-empty">暂无输出 —— F5/F6 打开运行窗口后，print / 生命周期 / 错误行实时显示在这里。</div>
        ) : (
          rows.map((r) => (
            <div className="bps-console-line" key={r.key}>
              <span className="bps-console-time">{r.time}</span>
              <span className="bps-console-text">{r.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
