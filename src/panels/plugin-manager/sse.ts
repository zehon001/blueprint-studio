/**
 * 插件安装流（SSE）消费（T6.2 · 执行器 T6.3 契约，勿 import 其代码只走 HTTP）
 *
 * 契约：GET /api/plugins/:id/install?project=&action=install|update → SSE 流
 *   data: {"type":"log","line":"..."}     进度日志行
 *   data: {"type":"done", ...}            完成
 *   data: {"type":"error","message":".."} 失败（message 中文）
 *
 * 实现决策：**不用 EventSource**（部分浏览器/环境下不可用且无法携带 AbortController），
 * 统一用 fetch 流式读取 + 手写 SSE 帧解析（跨浏览器一致、可注入 mock、可取消）。
 * 解析层（createSseParser）与事件层（parseInstallEvent）拆开，各自可单测。
 */

/** 安装流事件（与执行器 SSE data JSON 一一对应） */
export type InstallStreamEvent =
  | { type: 'log'; line: string }
  | { type: 'done'; message?: string }
  | { type: 'error'; message: string }

/** 流的结束方式：done 事件 / error 事件 / 主动取消 / 未收到结束事件即断开 */
export type InstallOutcome = 'done' | 'error' | 'aborted' | 'closed'

/**
 * 增量 SSE 帧解析器：feed 任意切分的文本块，按 SSE 规则取出 data 帧。
 *  - 以空行结束的一组 data 行构成一帧（多行 data 以 '\n' 合并）；
 *  - `:` 开头的注释/心跳行忽略；event/id/retry 字段忽略（本协议只用 data）；
 *  - 容忍 \r\n 行尾；end() 时若有未收到空行收尾的 data 残留也作为一帧交付
 *    （服务端常省略流尾空行）。
 */
export interface SseParser {
  push(chunk: string): void
  end(): void
}

export function createSseParser(onFrame: (data: string) => void): SseParser {
  let buffer = ''
  let dataLines: string[] = []
  const flush = (): void => {
    if (dataLines.length > 0) {
      const data = dataLines.join('\n')
      dataLines = []
      onFrame(data)
    }
  }
  const handleLine = (raw: string): void => {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      flush()
      return
    }
    if (line.startsWith(':')) return // 注释 / 心跳
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
  }
  return {
    push(chunk: string): void {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        handleLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
      }
    },
    end(): void {
      if (buffer !== '') {
        handleLine(buffer) // 流尾无换行符的最后一条行也纳入
        buffer = ''
      }
      flush()
    },
  }
}

/**
 * data 帧 JSON → 事件：log/done/error 三型一一对应；
 * 非 JSON 或未知形态的帧按原始文本降级为 log 行（进度日志不丢帧）。
 */
export function parseInstallEvent(raw: string): InstallStreamEvent {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o.type === 'log' && typeof o.line === 'string') return { type: 'log', line: o.line }
    if (o.type === 'done') {
      return { type: 'done', message: typeof o.message === 'string' ? o.message : undefined }
    }
    if (o.type === 'error' && typeof o.message === 'string') return { type: 'error', message: o.message }
    return { type: 'log', line: raw }
  } catch {
    return { type: 'log', line: raw }
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/**
 * 消费 SSE 响应体直到流结束 / 取消：
 *  - 流以 done 事件收尾 → 'done'；以 error 事件收尾 → 'error'（事件已经 onEvent 交付）；
 *  - signal 中止（read 抛 AbortError）→ 'aborted'；
 *  - 其余（服务端提前断开、body 为空、传输错误）→ 'closed'。
 * done/error 事件之后若流未立即关闭，继续读到流尾，最终以最后一种结束事件定性。
 */
export async function consumeSseBody(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (ev: InstallStreamEvent) => void,
  signal?: AbortSignal | null,
): Promise<InstallOutcome> {
  if (!body) return 'closed'
  let lastTerminal: Extract<InstallOutcome, 'done' | 'error'> | null = null
  const parser = createSseParser((data) => {
    const ev = parseInstallEvent(data)
    if (ev.type === 'done' || ev.type === 'error') lastTerminal = ev.type
    onEvent(ev)
  })
  const decoder = new TextDecoder()
  const reader = body.getReader()
  try {
    for (;;) {
      if (signal?.aborted) return 'aborted'
      const { done, value } = await reader.read()
      if (done) break
      if (value) parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode()) // 冲刷多字节解码残留
    parser.end()
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) return 'aborted'
    return 'closed' // 传输错误：按连接中断处理（进度日志已交付部分不丢）
  }
  return lastTerminal ?? 'closed'
}
