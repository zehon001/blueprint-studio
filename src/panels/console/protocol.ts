/**
 * 编辑器控制台跨窗口协议（运行窗口广播 / 编辑器面板订阅共用）
 *
 * 本模块只包含纯逻辑与 Web 标准类型，不引入 React / 编辑器 store，
 * 便于在 node:test 中注入内存频道验证。
 */

/** 频道名（运行窗口与编辑器控制台面板的跨窗口契约） */
export const CONSOLE_CHANNEL = 'bps-console'

/** 行数上限（FIFO；与运行窗口控制台同量级） */
export const CONSOLE_MAX_LINES = 1000

/** 运行模式：main（主蓝图）/ current（当前蓝图） */
export type ConsoleMode = 'main' | 'current'

/** 运行窗口广播的控制台消息（BroadcastChannel 契约） */
export interface ConsoleMessage {
  type: 'console.line'
  /** 控制台行文本（运行窗口已拼好前缀） */
  line: string
  /** 项目文件夹名（过滤/展示用） */
  project: string
  /** 运行模式 */
  mode: ConsoleMode
  /** 发送时间戳（epoch ms） */
  ts: number
}

/** 频道最小结构（node:test 以内存总线实现同一接口） */
export interface ConsoleChannel {
  postMessage(data: unknown): void
  close(): void
}

/** 频道工厂（缺省使用同源 BroadcastChannel） */
export type ConsoleChannelFactory = (name: string) => ConsoleChannel

export interface ConsoleMirrorOptions {
  /** 广播消息携带的项目文件夹名 */
  project: string
  /** 广播消息携带的运行模式，缺省 main */
  mode?: ConsoleMode
  /** 时间源（测试注入） */
  now?: () => number
  /** 频道工厂（测试注入） */
  channelFactory?: ConsoleChannelFactory
}

export interface ConsoleMirror {
  /** 广播一行控制台输出；频道不可用时静默降级 */
  post(line: string): void
  /** 关闭频道（卸载时调用，幂等） */
  close(): void
}

/** 缺省频道：同源 BroadcastChannel；环境不支持时抛出，由 createConsoleMirror 静默降级 */
function defaultChannelFactory(name: string): ConsoleChannel {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannel }).BroadcastChannel
  if (typeof Ctor !== 'function') throw new Error('[console] 当前环境不支持 BroadcastChannel')
  return new Ctor(name)
}

/**
 * 创建控制台广播镜像：首次 post 时懒建频道，之后复用；
 * 任一环节失败都只静默丢弃该行，不影响运行窗口本地控制台。
 */
export function createConsoleMirror(opts: ConsoleMirrorOptions): ConsoleMirror {
  const factory = opts.channelFactory ?? defaultChannelFactory
  const now = opts.now ?? Date.now
  let channel: ConsoleChannel | null = null
  let closed = false

  return {
    post(line) {
      if (closed) return
      try {
        channel ??= factory(CONSOLE_CHANNEL)
        const msg: ConsoleMessage = {
          type: 'console.line',
          line,
          project: opts.project,
          mode: opts.mode ?? 'main',
          ts: now(),
        }
        channel.postMessage(msg)
      } catch {
        /* 广播不可用：静默降级 */
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        channel?.close()
      } catch {
        /* 频道已关闭 */
      }
      channel = null
    },
  }
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
