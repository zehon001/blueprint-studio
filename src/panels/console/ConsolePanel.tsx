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

/** 频道名（运行窗口 RuntimeApp 与本面板的跨窗口契约） */
export const CONSOLE_CHANNEL = 'bps-console'

/** 行数上限（FIFO；与运行窗口控制台同量级） */
export const CONSOLE_MAX_LINES = 1000

/** 运行窗口广播的控制台消息（BroadcastChannel 契约） */
export interface ConsoleMessage {
  type: 'console.line'
  /** 控制台行文本（运行窗口已拼好前缀） */
  line: string
  /** 项目文件夹名（过滤/展示用） */
  project: string
  /** 运行模式：main（F5）/ current（F6） */
  mode: 'main' | 'current'
  /** 发送时间戳（epoch ms） */
  ts: number
}

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

/** 从 BroadcastChannel 事件还原消息（非法负载返回 null） */
export function parseConsoleEvent(data: unknown): ConsoleMessage | null {
  if (!data || typeof data !== 'object') return null
  const m = data as Partial<ConsoleMessage>
  if (m.type !== 'console.line' || typeof m.line !== 'string') return null
  if (typeof m.ts !== 'number') return null
  return {
    type: 'console.line',
    line: m.line,
    project: typeof m.project === 'string' ? m.project : '',
    mode: m.mode === 'current' ? 'current' : 'main',
    ts: m.ts,
  }
}

/** 控制台面板（dock 注册组件；占位面板 ConsolePanelPlaceholder 的正式实现） */
export function ConsolePanel() {
  const [rows, setRows] = useState<ConsoleRow[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)

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

  // 跟随滚动到底部（最新输出可见）
  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [rows])

  return (
    <div className="bps-console">
      <div className="bps-console-toolbar">
        <span className="bps-console-title">控制台</span>
        <span className="bps-console-hint">运行窗口日志实时推送（print / 生命周期 / 错误）</span>
        <button
          type="button"
          className="bps-console-clear"
          onClick={() => setRows([])}
          title="清空当前显示（不影响运行窗口）"
        >
          清空
        </button>
      </div>
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
