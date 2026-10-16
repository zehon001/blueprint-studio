import { Interpreter } from './interpreter'
import type { EngineToUI, UIToEngine } from '../types'

// 环境里同时启用 DOM 和 WebWorker lib 会冲突，这里用最小结构描述 worker 上下文
type WorkerScope = {
  postMessage(message: EngineToUI): void
  onmessage: ((ev: MessageEvent<UIToEngine>) => void) | null
}

const scope = self as unknown as WorkerScope

let interpreter: Interpreter | null = null
/** 事件串行队列：流式日志按到达顺序执行，异步节点（延时/RPC）不会打乱顺序 */
let queue: Promise<void> = Promise.resolve()

scope.onmessage = (ev) => {
  const msg = ev.data
  // RPC 回执绕过串行队列：队列可能正被等待该回执的执行链阻塞（否则死锁）
  if (msg.type === 'rpcResult') {
    interpreter?.resolveRpc(msg.id, msg.ok, msg.result)
    return
  }
  queue = queue.then(async () => {
    try {
      if (msg.type === 'load') {
        interpreter = new Interpreter(msg.graph, {
          vars: msg.vars,
          assets: msg.assets,
          emit: (m) => scope.postMessage(m),
        })
        scope.postMessage({ type: 'ready' })
        if (msg.autoRun) await interpreter.runEvent('event/onStart')
      } else if (msg.type === 'run') {
        if (!interpreter) throw new Error('引擎尚未加载流程图')
        if (msg.sourceId) {
          await interpreter.runSourceEvent(msg.sourceId, msg.payload ?? {})
        } else {
          await interpreter.runEvent(msg.eventDefId, msg.payload, msg.nodeId)
        }
      }
    } catch (err) {
      scope.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
}
