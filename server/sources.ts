import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type SourceSpec = {
  id: string
  kind: string
  params: Record<string, unknown>
}

export type SourcePush = (line: string) => void
export type SourceStatus = (level: 'info' | 'warn' | 'error', message: string) => void

export interface SourceAdapter {
  start(push: SourcePush, status: SourceStatus): void
  stop(): void
}

const uploadsDir = path.join(process.cwd(), 'assets', 'uploads')
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

/** 模拟 Dolphin 轮唱日志：会话/轮次结构 + 高频重复行 */
class DemoSource implements SourceAdapter {
  private timer: NodeJS.Timeout | null = null
  private sessN = 0
  private roundN = 0
  private roundsInSess = 0
  private entryN = 0

  start(push: SourcePush, _status: SourceStatus) {
    const tick = () => {
      if (this.roundN === 0 || this.entryN > 10) {
        this.entryN = 0
        this.roundN = 0
        if (this.roundsInSess >= 3) {
          this.roundsInSess = 0
          this.sessN++
          push(`=== SESSION START ${now()} ===`)
        } else if (this.sessN === 0) {
          this.sessN++
          push(`=== SESSION START ${now()} ===`)
        }
        this.roundsInSess++
        push(`--- ROUND ${++this.roundN} ---`)
        return
      }
      const roll = Math.random()
      if (roll < 0.12) {
        // 高频突发：同一行连发，验证「高频日志合并」
        const n = 4 + Math.floor(Math.random() * 9)
        for (let i = 0; i < n; i++) push('[DEBUG] com.dolphin.audio: frame drop')
      } else if (roll < 0.3) {
        push(`[WARN] com.dolphin.net: unstable rtt ${300 + Math.floor(Math.random() * 250)}ms`)
      } else if (roll < 0.45) {
        push(`[ERROR] com.dolphin.net: request timeout, retry ${1 + Math.floor(Math.random() * 3)}`)
      } else if (roll < 0.7) {
        push('[INFO] com.dolphin.core: round summary sent')
      } else if (roll < 0.85) {
        push('[DEBUG] com.dolphin.audio: buffer warm')
      } else {
        push('[INFO] com.dolphin.core: engine heartbeat')
      }
      this.entryN++
    }
    this.timer = setInterval(tick, 350)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** 真机日志：adb logcat（需后端主机装有 adb 且连接设备） */
class AdbSource implements SourceAdapter {
  private child: ReturnType<typeof spawn> | null = null

  constructor(
    private pkg: unknown,
    private tag: unknown,
  ) {}

  start(push: SourcePush, status: SourceStatus) {
    const pkg = String(this.pkg ?? '')
    const tag = String(this.tag ?? '').trim()
    const args = ['logcat', '-v', 'time', ...(tag ? ['-s', tag] : [])]
    try {
      const child = spawn('adb', args)
      this.child = child
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const l of lines) {
          const line = l.trim()
          if (line && (!pkg || line.includes(pkg))) push(line)
        }
      })
      child.on('error', () => {
        status('error', '手机日志源：未检测到 adb，请确认后端主机已安装 adb 并连接设备')
      })
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) status('warn', `adb logcat 已退出（code ${code}）`)
      })
      status('info', `手机日志源：adb logcat 已启动${pkg ? `（过滤 ${pkg}）` : ''}`)
    } catch {
      status('error', '手机日志源：无法启动 adb')
    }
  }

  stop() {
    this.child?.kill()
    this.child = null
  }
}

/** 日志文件：先按行间隔回放，再持续监听追加（tail -f） */
class FileSource implements SourceAdapter {
  private timers: NodeJS.Timeout[] = []
  private watcher: fs.FSWatcher | null = null
  private stopped = false
  private lastPos = 0

  constructor(
    private asset: unknown,
    private intervalMs: unknown,
  ) {}

  start(push: SourcePush, status: SourceStatus) {
    const name = String(this.asset ?? '')
    if (!name || !/^[\p{L}\p{N}_. -]+$/u.test(name) || name.includes('..')) {
      status('error', '日志文件源：请先在节点上选择资产文件')
      return
    }
    const file = path.join(uploadsDir, name)
    if (!fs.existsSync(file)) {
      status('error', `日志文件源：文件不存在「${name}」`)
      return
    }
    const interval = Math.max(10, Number(this.intervalMs) || 120)
    const pump = () => {
      if (this.stopped) return
      const stat = fs.statSync(file)
      if (stat.size <= this.lastPos) return
      const fd = fs.openSync(file, 'r')
      const chunk = Buffer.alloc(stat.size - this.lastPos)
      fs.readSync(fd, chunk, 0, chunk.length, this.lastPos)
      fs.closeSync(fd)
      this.lastPos = stat.size
      const pending = chunk.toString('utf8').split('\n').filter((l) => l.length > 0)
      let i = 0
      const emitNext = () => {
        if (this.stopped) return
        if (i < pending.length) {
          push(pending[i++])
          this.timers.push(setTimeout(emitNext, interval))
        }
      }
      emitNext()
    }
    pump()
    this.watcher = fs.watch(file, () => pump())
    status('info', `日志文件源：开始读取「${name}」并监听追加`)
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.watcher?.close()
    this.watcher = null
  }
}

export function createSource(spec: SourceSpec): SourceAdapter {
  switch (spec.kind) {
    case 'demo':
      return new DemoSource()
    case 'adb':
      return new AdbSource(spec.params.package, spec.params.tag)
    case 'file':
      return new FileSource(spec.params.asset, spec.params.intervalMs)
    default: {
      const kind = spec.kind
      return {
        start(_push: SourcePush, status: SourceStatus) {
          status('error', `未知日志源类型「${kind}」`)
        },
        stop() {},
      }
    }
  }
}
