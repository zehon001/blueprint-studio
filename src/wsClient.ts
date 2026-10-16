/**
 * WebSocket 客户端（单例）：与后端实时通讯，不轮询。
 * 消息分发由 appStore 注册处理器。
 */

type ServerMessage =
  | { type: 'hello' }
  | {
      type: 'source.event'
      runId: string
      sourceId: string
      ts: string
      line: string
    }
  | { type: 'source.status'; runId: string; sourceId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'rpc.result'; id: number; ok: boolean; result: unknown }
  | { type: 'error'; message: string }

type ClientMessage =
  | { type: 'plugin.run'; runId: string; sources: unknown[] }
  | { type: 'plugin.stop'; runId: string }
  | { type: 'rpc'; id: number; method: string; args: unknown }

type Handlers = {
  onMessage?: (msg: ServerMessage) => void
  onStatus?: (status: 'online' | 'offline') => void
}

class WsClient {
  private ws: WebSocket | null = null
  private backoff = 800
  handlers: Handlers = {}

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 800
      this.handlers.onStatus?.('online')
    }
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage?.(JSON.parse(ev.data as string))
      } catch {
        // 忽略非 JSON 帧
      }
    }
    ws.onclose = () => {
      this.handlers.onStatus?.('offline')
      this.ws = null
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 1.6, 8000)
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }
}

export const wsClient = new WsClient()
