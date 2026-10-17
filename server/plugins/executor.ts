/**
 * Blueprint Studio v2 —— 插件 CLI 执行器（T6.3 · Server-Agent · PLAN §14.1/§14.2）
 *
 * 职责（对端契约已由 T6.2 / T6.4 按 PM 定案消费，本文件实现服务端，契约不变）：
 *  1. detect：POST /api/plugins/:id/detect?project=&cmdOverride=<base64url(命令)>
 *     → exec detect.cmd（10s 超时）→ versionRegex 提取当前版本（第一捕获组）→
 *     与 update.latestVersion 做 semver 逐段比较（非数字段字符串比；任一侧解析
 *     失败不可比 → updatable:false）→ detect 执行失败 = 未安装（ok 恒 true，
 *     installed:false——客户端按「请求成功但未安装」处理）。
 *  2. install/update：GET /api/plugins/:id/install?project=&action=install|update
 *     → SSE 流 data:{"type":"log"|"done"|"error",...}；四策略生成命令
 *     （winget / npm-global / download-zip 占位说明 / custom-cmd），cmdOverride
 *     优先；同 id 并发锁（单飞行）；stdout/stderr 合并逐行流；1MB 输出截断；
 *     done 后自动重 detect 并把结果附在 done 事件上。
 *  3. invoke：POST /api/plugins/invoke，body { plugin, node, args, project? }。
 *     - 通用通道：args.__cmd 透传执行（30s 超时）→ 返回 stdout 尾部 100KB；
 *       无 __cmd 且插件无专属执行器 → ok:false + 中文 message；
 *     - feishu-cli（T6.6）：feishuCli.send 按命令模板构造并透传执行（只封装命令
 *       构造与执行，不实现功能本体）；
 *     - phone-log（T6.5）：转交 ./phone-log.ts（双模式读取 + 持续流）。
 *  4. 持续流推送 hub（plugin.push 协议扩展）：复用 server/ws.ts 的 /ws 连接通道
 *     （本模块实现 PluginPushHub，由 index.ts 追加 attach；不改 ws.ts）：
 *       客户端 → 服务端：{ type:'plugin.subscribe', project } / { type:'plugin.unsubscribe', project }
 *       服务端 → 客户端：{ type:'plugin.push', plugin, streamId, line, project }
 *                        { type:'plugin.close', plugin, streamId, project }
 *     连接断开 / 退订后某项目订阅归零 → 延迟（抗瞬断）停掉该项目名下的流。
 *
 * Windows 输出解码：按 UTF-8 尽力解码（StringDecoder 处理跨 chunk 多字节），
 * GBK 环境下中文输出会出乱码替换符（遗留问题，已记录汇报）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import { loadPluginRegistry } from './registry'
import { isPluginNodeId } from './registry'
import type { PluginManifest } from '../../src/ir/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** detect 命令超时（任务卡 DoD：10s） */
export const DETECT_TIMEOUT_MS = 10_000
/** detect 输出收集上限 */
export const DETECT_MAX_OUTPUT_BYTES = 256 * 1024
/** 安装/更新流输出截断上限（任务卡 DoD：1MB） */
export const INSTALL_MAX_OUTPUT_BYTES = 1024 * 1024
/** invoke 通用通道命令超时（任务卡 DoD：30s） */
export const INVOKE_TIMEOUT_MS = 30_000
/** invoke 输出收集上限（防失控进程拖垮内存） */
export const INVOKE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** invoke 返回的 stdout 尾部字节数（任务卡 DoD：100KB） */
export const INVOKE_TAIL_BYTES = 100 * 1024
/** 项目最后一名订阅者离开后多久停其名下持续流（抗 WS 瞬断重连；测试可调小） */
export const STREAM_IDLE_STOP_MS = 5_000
/** 持续流启动后的早退探测窗口（窗口内退出 = 启动失败，invoke 返回 ok:false） */
export const STREAM_EARLY_EXIT_MS = 250
/** 单条持续流的输出上限（超出后不再推送行，防风暴） */
export const STREAM_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** 安装动作中文名（日志 / 错误消息用） */
const ACTION_LABEL: Record<'install' | 'update', string> = { install: '安装', update: '更新' }

/* ============================================================
 * 命令执行基建（shell 串命令 + 逐行合并流 + 超时 / 截断 / 杀树）
 * ============================================================ */

/** 命令执行结果 */
export interface CmdResult {
  /** 退出码（null = 被 shell 中途杀死 / spawn 失败） */
  code: number | null
  stdout: string
  stderr: string
  /** 超时被终止 */
  timedOut: boolean
  /** 输出超过 maxOutputBytes 被截断 */
  truncated: boolean
}

/** 命令执行可选项 */
export interface RunCmdOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** 超时毫秒（超时杀进程树；缺省不限时） */
  timeoutMs?: number
  /** 输出字节上限（stdout+stderr 累计；超出截断，进程继续跑完） */
  maxOutputBytes?: number
  /** 中止信号（中止 = 杀进程树；调用方负责忽略后续输出） */
  signal?: AbortSignal
  /** 逐行回调（stdout/stderr 合并、按到达顺序；空行跳过；截断后不再回调） */
  onLine?: (line: string) => void
}

/**
 * 输出汇：UTF-8 尽力解码（StringDecoder 处理跨 chunk 的多字节序列）+ 按行切分。
 * GBK 兜底（T6.3 DoD「尽力 UTF-8」+ 遗留改善）：流式逐行按 UTF-8 解码（乱码行仅
 * 影响展示），结束时若全文含替换符（U+FFFD）则尝试以 GBK 重解码整段（Windows
 * 中文环境 cmd.exe 的报文为 GBK 编码，如「不是内部或外部命令」），替换符更少者胜。
 */
class OutputSink {
  private readonly decoder = new StringDecoder('utf8')
  private readonly chunks: Buffer[] = []
  private buf = ''
  /** 已收到的解码文本（截断后不再追加；end() 后为 GBK 兜底择优结果） */
  text = ''

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    const s = this.decoder.write(chunk)
    this.text += s
    this.buf += s
    let idx = this.buf.indexOf('\n')
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      if (line !== '') this.emit(line)
      idx = this.buf.indexOf('\n')
    }
  }

  /** 流尾冲刷：未换行的最后一段按行交付 + GBK 兜底择优解码全文 */
  end(): void {
    const s = this.decoder.end()
    this.text += s
    this.buf += s
    const line = this.buf.replace(/\r$/, '')
    this.buf = ''
    if (line !== '') this.emit(line)
    if (this.text.includes('\uFFFD') && this.chunks.length > 0) {
      try {
        const gbk = new TextDecoder('gbk').decode(Buffer.concat(this.chunks))
        if (countReplacementChars(gbk) < countReplacementChars(this.text)) this.text = gbk
      } catch {
        /* 运行时无 gbk 解码器（ICU 受限）：保持 UTF-8 尽力结果（遗留：乱码行） */
      }
    }
  }
}

/** 统计替换符个数（GBK 兜底择优依据） */
function countReplacementChars(s: string): number {
  let n = 0
  for (const ch of s) if (ch === '\uFFFD') n++
  return n
}

/**
 * 杀掉子进程树：Windows 下 shell 模式的直接子进程是 cmd.exe，直接 kill 会残留
 * 孙进程（真正的 CLI），用 taskkill /T /F 整树终止；POSIX 用 SIGKILL。
 */
export function killChild(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return // 已退出
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      try { child.kill() } catch { /* 已退出 */ }
    }
  } else {
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  }
}

/**
 * 启动一条 shell 命令（shell: true——清单里的 cmd 是完整命令字符串，如
 * "adb version" / "npm install -g pkg"；本地服务只执行清单与设置中的命令）。
 * 返回 child、结束 Promise 与输出读取器（stdoutText / stderrText——end 后含 GBK
 * 兜底解码结果；持续流早退探测在进程退出后即时读取用）。
 */
export function spawnShell(
  cmd: string,
  opts: RunCmdOptions = {},
): { child: ChildProcess; done: Promise<CmdResult>; stdoutText: () => string; stderrText: () => string } {
  const maxBytes = opts.maxOutputBytes ?? Number.MAX_SAFE_INTEGER
  const child = spawn(cmd, [], {
    shell: true,
    windowsHide: true,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  })

  const acc = { bytes: 0, truncated: false }
  const outSink = new OutputSink((line) => opts.onLine?.(line))
  const errSink = new OutputSink((line) => opts.onLine?.(line))
  const feed = (sink: OutputSink, chunk: Buffer): void => {
    if (acc.truncated) return // 已截断：继续排水但不收集，防内存失控
    acc.bytes += chunk.length
    if (acc.bytes > maxBytes) {
      acc.truncated = true
      return
    }
    sink.push(chunk)
  }
  child.stdout?.on('data', (c: Buffer) => feed(outSink, c))
  child.stderr?.on('data', (c: Buffer) => feed(errSink, c))

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, Math.max(1, opts.timeoutMs))
    timer.unref?.()
  }
  const onAbort = (): void => killChild(child)
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  const done = new Promise<CmdResult>((resolve) => {
    let settled = false
    const finish = (code: number | null, extraStderr = ''): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (!acc.truncated) {
        outSink.end()
        errSink.end()
      }
      resolve({
        code,
        stdout: outSink.text,
        stderr: extraStderr ? `${errSink.text}\n${extraStderr}`.trim() : errSink.text,
        timedOut,
        truncated: acc.truncated,
      })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (err) => finish(null, err.message)) // spawn 本身失败（shell 都没起起来）
  })
  return {
    child,
    done,
    stdoutText: () => outSink.text,
    stderrText: () => errSink.text,
  }
}

/** 一次性执行命令并等待结束 */
export function runCommand(cmd: string, opts: RunCmdOptions = {}): Promise<CmdResult> {
  return spawnShell(cmd, opts).done
}

/** 「命令不存在」类报文特征（中英文 Windows / POSIX shell） */
export const COMMAND_NOT_FOUND_RE =
  /不是内部或外部命令|is not recognized as|system cannot find the (file|path)|系统找不到|No such file or directory/

/**
 * 判定「命令不存在」类失败：Windows cmd.exe 退出码 9009 / POSIX shell 127，
 * 或输出中带未找到命令的报文（退出码随 shell / 系统语言有差异，双重判定兜底）。
 */
export function isCommandNotFound(result: CmdResult): boolean {
  if (result.code === 9009 || result.code === 127) return true
  const combined = `${result.stderr}\n${result.stdout}`
  return COMMAND_NOT_FOUND_RE.test(combined)
}

/* ============================================================
 * 版本比较（semver 逐段；非数字段字符串比；不可比 → null → updatable:false）
 * ============================================================ */

/** 拆版本段：按 '.' 切；空串 / 非字符串 → null（不可比） */
function parseVersionSegments(v: string | undefined): string[] | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  return s.split('.')
}

/**
 * 版本逐段比较：数字段按数值比；非数字段（或一侧非数字）按字典序字符串比；
 * 段数不齐按 '0' 补齐（'35.0' == '35'）。任一侧解析失败返回 null（不可比）。
 */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const sa = parseVersionSegments(a)
  const sb = parseVersionSegments(b)
  if (!sa || !sb) return null
  const len = Math.max(sa.length, sb.length)
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? '0'
    const y = sb[i] ?? '0'
    if (x === y) continue
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) < Number(y) ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/* ============================================================
 * cmdOverride（设置覆盖命令；query 传 base64url(命令)）
 * ============================================================ */

/** 解码 cmdOverride 查询参数（base64url）；空 / 解码为空白 → undefined */
export function decodeCmdOverride(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  return decoded.trim() !== '' ? decoded : undefined
}

/* ============================================================
 * detect（检测当前版本与可更新状态）
 * ============================================================ */

/** detect 端点响应（T6.2 model.ts 消费契约；cmd 供确认框展示） */
export interface DetectResult {
  /** 端点本身是否执行成功（执行失败也返回 ok:true + installed:false） */
  ok: boolean
  /** 是否已安装（detect 执行失败 = 未安装） */
  installed: boolean
  /** 当前版本（versionRegex 第一捕获组；未配置或未命中则缺省） */
  version?: string
  /** 清单声明的最新版本 */
  latest?: string
  /** 是否可更新（当前 < 最新；任一侧不可比 = false） */
  updatable: boolean
  /** 附加消息（中文） */
  message?: string
  /** 实际使用的检测命令（供展示） */
  cmd?: string
}

/**
 * 执行清单 detect：跑 detect.cmd（cmdOverride 优先）→ 正则提取版本 → 与
 * update.latestVersion 比较。detect 命令执行失败（非零退出 / 超时）= 未安装。
 */
export async function detectPlugin(
  manifest: PluginManifest,
  opts: { cmdOverride?: string; timeoutMs?: number } = {},
): Promise<DetectResult> {
  const detect = manifest.detect
  const latest = manifest.update?.latestVersion
  if (!detect) {
    // 无 detect 的清单（自定义插件惯例）：按已安装处理（管理界面本就不调 detect）
    return {
      ok: true,
      installed: true,
      updatable: false,
      ...(latest !== undefined ? { latest } : {}),
      message: '该插件未声明检测命令（按已安装处理）',
    }
  }
  const override = opts.cmdOverride?.trim()
  const cmd = override ? override : detect.cmd
  const result = await runCommand(cmd, {
    timeoutMs: opts.timeoutMs ?? DETECT_TIMEOUT_MS,
    maxOutputBytes: DETECT_MAX_OUTPUT_BYTES,
  })
  if (result.timedOut || result.code !== 0) {
    const reason = result.timedOut
      ? `检测命令超时（${opts.timeoutMs ?? DETECT_TIMEOUT_MS}ms）`
      : `检测命令执行失败（退出码 ${result.code ?? '无'}）`
    return { ok: true, installed: false, updatable: false, cmd, message: `${reason}——按未安装处理` }
  }

  const combined = `${result.stdout}\n${result.stderr}`
  let version: string | undefined
  if (detect.versionRegex) {
    const m = new RegExp(detect.versionRegex).exec(combined)
    if (m && typeof m[1] === 'string') version = m[1].trim()
  }
  const cmp = version !== undefined && latest !== undefined ? compareVersions(version, latest) : null
  return {
    ok: true,
    installed: true,
    ...(version !== undefined ? { version } : {}),
    ...(latest !== undefined ? { latest } : {}),
    updatable: cmp !== null && cmp < 0,
    cmd,
  }
}

/* ============================================================
 * install / update（四策略 + 并发锁 + SSE 事件回调）
 * ============================================================ */

/** 安装流事件（与 T6.2 sse.ts parseInstallEvent 契约一致；done 可附 detect 结果） */
export type InstallStreamEvent =
  | { type: 'log'; line: string }
  | { type: 'done'; message?: string; detect?: DetectResult }
  | { type: 'error'; message: string }

/** 同插件 id 安装并发锁（单飞行） */
const installLocks = new Map<string, 'install' | 'update'>()

/** 查询某插件是否正在安装 / 更新（管理界面轮询可用） */
export function isInstallRunning(pluginId: string): boolean {
  return installLocks.has(pluginId)
}

/** 安装命令构造结果 */
export type BuiltCommand = { ok: true; cmd: string } | { ok: false; message: string }

/**
 * 按清单 install 策略构造命令（cmdOverride 优先——设置覆盖跨策略生效）：
 *  - winget：args[0] = 包 id → `winget install|upgrade -e --id X --accept-*-agreements`
 *  - npm-global：args[0] = 包名 → `npm install -g X`（update 追加 @latest）
 *  - download-zip：占位策略——不自动下载安装，返回说明（error 事件带手动步骤）
 *  - custom-cmd：install.cmd（install / update 共用）
 */
export function buildInstallCommand(
  manifest: PluginManifest,
  action: 'install' | 'update',
  cmdOverride?: string,
): BuiltCommand {
  const override = cmdOverride?.trim()
  if (override) return { ok: true, cmd: override }
  const install = manifest.install
  if (!install) {
    return { ok: false, message: `清单未声明安装命令（install），无法执行${ACTION_LABEL[action]}` }
  }
  const pkg = install.args?.[0]
  switch (install.strategy) {
    case 'winget': {
      if (!pkg) return { ok: false, message: '清单 install.args 缺少包 id（winget 策略需要 args: ["<PackageId>"]）' }
      const verb = action === 'install' ? 'install' : 'upgrade'
      return { ok: true, cmd: `winget ${verb} -e --id ${pkg} --accept-source-agreements --accept-package-agreements` }
    }
    case 'npm-global': {
      if (!pkg) return { ok: false, message: '清单 install.args 缺少包名（npm-global 策略需要 args: ["<package>"]）' }
      const spec = action === 'install' ? pkg : `${pkg}@latest`
      return { ok: true, cmd: `npm install -g ${spec}` }
    }
    case 'download-zip':
      // 占位说明（T6.3 DoD）：本期不实现自动下载解压，仅给手动步骤
      return {
        ok: false,
        message: `download-zip 为占位策略：请手动下载 ${pkg ?? '(清单未配置下载地址)'} 并解压，将可执行文件目录加入 PATH 后重新检测`,
      }
    case 'custom-cmd': {
      const cmd = install.cmd?.trim()
      if (!cmd) return { ok: false, message: "清单 install.strategy 为 'custom-cmd' 但未提供 install.cmd" }
      return { ok: true, cmd }
    }
  }
}

/** runInstall 可选项 */
export interface InstallOptions {
  action: 'install' | 'update'
  /** 覆盖安装命令（设置覆盖；base64url 解码后的命令串） */
  cmdOverride?: string
  /** 流事件回调（log / done / error） */
  onEvent: (ev: InstallStreamEvent) => void
  /** 中止信号（客户端取消安装 → 杀子进程） */
  signal?: AbortSignal
  /** 安装命令超时（缺省不限时；测试用小值） */
  timeoutMs?: number
}

/**
 * 执行安装 / 更新并逐事件回调：
 * 同 id 并发锁（单飞行，第二个请求直接 error 事件）→ 构造命令 → 流式执行
 * （stdout/stderr 合并逐行 → log 事件；1MB 截断提示）→ 退出码 0 → done +
 * 自动重 detect（用清单自带 detect 命令，不用 cmdOverride——那是安装命令的覆盖）
 * → 非 0 / 超时 → error。
 */
export async function runInstall(manifest: PluginManifest, opts: InstallOptions): Promise<void> {
  const { action, onEvent } = opts
  const running = installLocks.get(manifest.id)
  if (running) {
    onEvent({
      type: 'error',
      message: `该插件已有${ACTION_LABEL[running]}任务在进行中（同一插件同时只允许一个安装/更新任务）`,
    })
    return
  }
  installLocks.set(manifest.id, action)
  try {
    const built = buildInstallCommand(manifest, action, opts.cmdOverride)
    if (!built.ok) {
      onEvent({ type: 'error', message: built.message })
      return
    }
    onEvent({ type: 'log', line: `> ${built.cmd}` })
    const result = await runCommand(built.cmd, {
      maxOutputBytes: INSTALL_MAX_OUTPUT_BYTES,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onLine: (line) => onEvent({ type: 'log', line }),
    })
    if (result.truncated) {
      onEvent({ type: 'log', line: '……输出超过 1MB，已截断（后续输出不再显示）' })
    }
    if (opts.signal?.aborted) return // 客户端取消：SSE 已断开，不再发事件
    if (result.timedOut) {
      onEvent({ type: 'error', message: `${ACTION_LABEL[action]}命令超时被终止（${opts.timeoutMs}ms）` })
      return
    }
    if (result.code !== 0) {
      onEvent({
        type: 'error',
        message: `${ACTION_LABEL[action]}命令执行失败（退出码 ${result.code ?? '无'}），详情见上方日志`,
      })
      return
    }
    // done 后自动重 detect（管理界面据此刷新状态徽标；结果附在 done 事件上）
    const detect = await detectPlugin(manifest)
    onEvent({ type: 'done', message: `${ACTION_LABEL[action]}命令执行完成`, detect })
  } finally {
    installLocks.delete(manifest.id)
  }
}

/* ============================================================
 * 持续流推送 hub（plugin.push 协议扩展；复用 /ws 连接通道，不改 ws.ts）
 * ============================================================ */

/** 项目订阅从「有订阅者」变「零订阅者」后的停流延迟，见 STREAM_IDLE_STOP_MS */
type IdleStopCallback = (project: string) => void

/**
 * 插件推送 hub：按 project 管理订阅连接、广播 plugin.push / plugin.close。
 * 连接断开（或退订）导致某项目订阅归零时，经 idleStopMs 抗瞬断延迟后回调
 * onProjectIdle（PluginStreamManager 注册 → 停该项目名下的流）。
 */
export class PluginPushHub {
  /** 连接 → 该连接订阅的项目集合 */
  private readonly conns = new Map<WebSocket, Set<string>>()
  /** 项目 → 订阅连接集合 */
  private readonly subscribers = new Map<string, Set<WebSocket>>()
  /** 项目订阅归零回调（PluginStreamManager 注册） */
  onProjectIdle: IdleStopCallback | null = null
  /** 归零判定延迟毫秒（0 = 立即；测试可调小） */
  idleStopMs = STREAM_IDLE_STOP_MS
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 绑定到 WebSocketServer（index.ts 追加一行 attach；测试可直调 register） */
  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => this.register(ws))
  }

  /** 登记一条连接（与 WsDebugHub 并行监听同一连接的 message，互不干扰） */
  register(ws: WebSocket): void {
    this.conns.set(ws, new Set())
    ws.on('message', (raw) => this.handleMessage(ws, raw))
    ws.on('close', () => this.dropConnection(ws))
  }

  /** 统计快照（健康接口 / 测试断言用） */
  stats(): { connections: number; projects: number } {
    let projects = 0
    for (const set of this.subscribers.values()) if (set.size > 0) projects++
    return { connections: this.conns.size, projects }
  }

  /** 订阅某项目的插件推送（幂等；容错：未 register 的连接先登记） */
  subscribe(ws: WebSocket, project: string): void {
    if (project === '') return
    let projects = this.conns.get(ws)
    if (!projects) {
      projects = new Set()
      this.conns.set(ws, projects)
      ws.on('close', () => this.dropConnection(ws))
    }
    if (projects.has(project)) return
    projects.add(project)
    let set = this.subscribers.get(project)
    if (!set) {
      set = new Set()
      this.subscribers.set(project, set)
    }
    set.add(ws)
    this.cancelIdleStop(project) // 有订阅者（含重新订阅）：取消停流排程
  }

  /** 退订某项目（幂等） */
  unsubscribe(ws: WebSocket, project: string): void {
    const projects = this.conns.get(ws)
    if (!projects || !projects.has(project)) return
    projects.delete(project)
    this.afterSubscriberLoss(ws, project)
  }

  /** 向某项目的全部订阅连接广播（未连接 / 发送失败静默跳过） */
  broadcast(project: string, payload: Record<string, unknown>): void {
    const set = this.subscribers.get(project)
    if (!set || set.size === 0) return
    const data = JSON.stringify(payload)
    for (const ws of set) {
      if (ws.readyState !== 1 /* OPEN */) continue
      try {
        ws.send(data)
      } catch {
        /* 发送失败交由 close 清理 */
      }
    }
  }

  /** 释放停流排程（测试收尾用；hub 本体可继续工作） */
  dispose(): void {
    for (const t of this.idleTimers.values()) clearTimeout(t)
    this.idleTimers.clear()
  }

  /* ---------------- 内部 ---------------- */

  /** 处理连接报文：只认 plugin.subscribe / plugin.unsubscribe，其余静默（debug.* 由 ws.ts 处理） */
  private handleMessage(ws: WebSocket, raw: unknown): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type === 'plugin.subscribe' && typeof msg.project === 'string') {
      this.subscribe(ws, msg.project)
    } else if (msg.type === 'plugin.unsubscribe' && typeof msg.project === 'string') {
      this.unsubscribe(ws, msg.project)
    }
  }

  private dropConnection(ws: WebSocket): void {
    const projects = this.conns.get(ws)
    if (!projects) return
    this.conns.delete(ws)
    for (const project of projects) this.afterSubscriberLoss(ws, project)
  }

  /** 某连接失去某项目订阅：订阅归零 → 排程停流（抗瞬断延迟） */
  private afterSubscriberLoss(ws: WebSocket, project: string): void {
    const set = this.subscribers.get(project)
    if (!set) return
    set.delete(ws)
    if (set.size > 0) return
    this.subscribers.delete(project)
    if (project === '') return
    if (this.idleStopMs <= 0) {
      this.onProjectIdle?.(project)
      return
    }
    const t = setTimeout(() => {
      this.idleTimers.delete(project)
      this.onProjectIdle?.(project)
    }, this.idleStopMs)
    t.unref?.()
    this.idleTimers.set(project, t)
  }

  private cancelIdleStop(project: string): void {
    const t = this.idleTimers.get(project)
    if (t) {
      clearTimeout(t)
      this.idleTimers.delete(project)
    }
  }
}

/* ============================================================
 * 持续流管理器（长进程注册 / 停止 / close 广播）
 * ============================================================ */

/** 一条持续流的登记 */
interface StreamRecord {
  id: string
  project: string
  plugin: string
  child: ChildProcess
}

/** start 可选项 */
export interface StreamStartOptions {
  /** 归属项目（推送按 project 订阅广播；'' = 广播不可达且不参与自动停流） */
  project: string
  /** 插件 id（close 报文回带） */
  plugin: string
  /** 完整命令串（shell 执行的长进程，如 `adb -s X logcat -v time`） */
  cmd: string
  /** 每行回调（stdout/stderr 合并；line 为原始行文本；截断后不再回调） */
  onLine?: (line: string, streamId: string) => void
  /** 输出字节上限（缺省 STREAM_MAX_OUTPUT_BYTES） */
  maxOutputBytes?: number
}

/** start 的返回：child 供调用方做早退探测；done 在 close 处理（含广播）完成后 resolve；stderrText 供「命令不存在」判定（GBK 兜底解码） */
export interface StreamStartResult {
  streamId: string
  child: ChildProcess
  /** 进程关闭且管理器完成清理 / close 广播后 resolve */
  done: Promise<void>
  stderrText: () => string
}

/**
 * 持续流管理器：spawn 长进程 → 逐行回调 → 进程自然结束 / 出错 / 被停 →
 * 广播 plugin.close。构造时接管所属 hub 的 onProjectIdle：项目订阅归零
 * （延迟判定）→ 停该项目全部流（「连接断开时清理该连接名下的流」的落地形态：
 * 流按项目归属，最后一个订阅连接离开后流失去消费方，随停）。
 */
export class PluginStreamManager {
  private readonly streams = new Map<string, StreamRecord>()
  private seq = 0
  /** 启动后的早退探测窗口毫秒（窗口内退出 = 启动失败，invoke 返回 ok:false） */
  earlyExitMs = STREAM_EARLY_EXIT_MS

  constructor(public readonly hub: PluginPushHub) {
    hub.onProjectIdle = (project) => {
      this.stopProject(project)
    }
  }

  /** 当前存活流数（测试 / 健康接口用） */
  get size(): number {
    return this.streams.size
  }

  /** 启动一条流（同步返回 child 供调用方做早退探测；close 由管理器广播） */
  start(opts: StreamStartOptions): StreamStartResult {
    const streamId = `ps-${++this.seq}-${Date.now().toString(36)}`
    const record: StreamRecord = { id: streamId, project: opts.project, plugin: opts.plugin, child: null as unknown as ChildProcess }
    this.streams.set(streamId, record)
    const spawned = spawnShell(opts.cmd, {
      maxOutputBytes: opts.maxOutputBytes ?? STREAM_MAX_OUTPUT_BYTES,
      onLine: (line) => opts.onLine?.(line, streamId),
    })
    record.child = spawned.child
    let closed = false
    let settleClosed: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      settleClosed = resolve
    })
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return
      closed = true
      this.streams.delete(streamId)
      // 进程天然结束 / 出错 / 被停：向项目订阅者广播 close（订阅者据此收尾）
      this.hub.broadcast(record.project, {
        type: 'plugin.close',
        plugin: record.plugin,
        streamId,
        project: record.project,
        ...(code !== null ? { code } : {}),
        ...(signal !== null ? { signal } : {}),
      })
      settleClosed()
    }
    spawned.child.on('close', (code, signal) => close(code, signal))
    spawned.child.on('error', () => close(null, null))
    return { streamId, child: spawned.child, done, stderrText: spawned.stderrText }
  }

  /** 停止一条流（杀进程树；close 事件随后广播）。流不存在返回 false */
  stop(streamId: string): boolean {
    const record = this.streams.get(streamId)
    if (!record) return false
    killChild(record.child)
    return true
  }

  /** 停止某项目名下全部流（项目订阅归零 / 显式清理） */
  stopProject(project: string): void {
    for (const record of [...this.streams.values()]) {
      if (record.project === project) this.stop(record.id)
    }
  }
}

/** 进程内默认实例（index.ts 使用；测试自建实例隔离） */
export const pluginPushHub = new PluginPushHub()
export const pluginStreams = new PluginStreamManager(pluginPushHub)

/* ============================================================
 * invoke（通用通道 + feishu-cli 透传 + phone-log 转交）
 * ============================================================ */

/** invoke 响应体（T6.4 PluginInvokeResponse 契约；onLine start 额外带 streamId） */
export interface InvokePayload {
  ok: boolean
  outputs?: Record<string, unknown>
  stdout?: string
  stderr?: string
  message?: string
  /** 持续流 id（phoneLog.onLine start 成功时附带） */
  streamId?: string
}

/** handleInvoke 可注入依赖（测试替换命令执行 / 流管理器） */
export interface InvokeDeps {
  projectsRoot: string
  /** 流管理器（缺省进程内单例） */
  streams?: PluginStreamManager
  /** 命令执行函数（缺省 runCommand；测试注入捕获） */
  runCmd?: typeof runCommand
  /** 通用通道超时（缺省 INVOKE_TIMEOUT_MS；测试用小值） */
  invokeTimeoutMs?: number
  /** phone-log 读取超时（缺省 30s；测试用小值） */
  readTimeoutMs?: number
}

/** 修整任意值为非空字符串（trim 后为空 → ''） */
function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 输出尾部截断（字节近似按字符数；任务卡 DoD：stdout 尾部 100KB） */
export function tailText(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(-maxChars)
}

/**
 * cmd.exe 下的值引用（尽力而为）：引号包裹 + 去内部双引号 + 换行折空格。
 * 只用于本地工具的命令构造（消息文本等），非通用 shell 转义方案（遗留：跨平台
 * 引用策略如需加固，走 ADR）。
 */
export function shellQuoteText(v: string): string {
  return `"${v.replace(/[\r\n]+/g, ' ').replace(/"/g, '').trim()}"`
}

/* ---------------- feishu-cli（T6.6：只封装命令构造与执行，不实现功能本体） ---------------- */

/**
 * 飞书 CLI 默认命令模板（清单未声明 invoke.cmdTemplate 时的兜底）。
 * 占位符：{message}（必填）；target 非空时按下方规则生成 --to 变体。
 */
const FEISHU_CMD_TEMPLATES: Record<string, string> = {
  'feishuCli.send': 'feishu send --text {message}',
}

/** 飞书命令构造结果 */
export type FeishuCommand = { ok: true; cmd: string } | { ok: false; message: string }

/**
 * feishuCli.send → CLI 命令构造：message 必填；target 非空时生成含 --to 的命令。
 *
 * 模板解析顺序：清单 invoke.cmdTemplate（T6.6 扩展字段，ADR-004 待 PM 追认）→ 内置模板。
 * target 处理规则：
 *  - 模板含 {target} 占位符 → 直接按占位符替换（值引号包裹）；
 *  - 模板未含 {target} → 按内置约定在首个 `--text` 标记前插入 `--to "<target>" `
 *   （清单模板是「无 target 的基础模板」，如 'feishu send --text {message}'）；
 *    无 `--text` 标记则追加到命令尾部。
 */
export function buildFeishuSendCommand(
  args: Record<string, unknown>,
  manifest?: PluginManifest,
): FeishuCommand {
  const message = typeof args.message === 'string' ? args.message : ''
  if (!message.trim()) return { ok: false, message: 'feishuCli.send 需要 message 输入（消息内容不能为空）' }
  const target = strArg(args.target)
  const base = manifest?.invoke?.cmdTemplate?.trim() || FEISHU_CMD_TEMPLATES['feishuCli.send']
  const qMsg = shellQuoteText(message)
  let cmd: string
  if (target !== '') {
    const qTarget = shellQuoteText(target)
    if (base.includes('{target}')) {
      cmd = base.replace('{target}', qTarget).replace('{message}', qMsg)
    } else {
      const at = base.indexOf('--text')
      const withTo =
        at >= 0
          ? `${base.slice(0, at).trimEnd()} --to ${qTarget} ${base.slice(at).trimStart()}`
          : `${base.trimEnd()} --to ${qTarget}`
      cmd = withTo.replace('{message}', qMsg)
    }
  } else {
    cmd = base.replace('{message}', qMsg)
  }
  return { ok: true, cmd }
}

/* ---------------- invoke 路由 ---------------- */

/**
 * POST /api/plugins/invoke 路由体（返回 HTTP 状态 + 响应 JSON）：
 *  - phone-log 节点 → phone-log 执行器（./phone-log.ts）；
 *  - feishu-cli 的 feishuCli.send → 命令模板构造 + 透传执行（outputs.text = stdout 尾部）；
 *  - args.__cmd → 通用透传执行（30s 超时，stdout 尾部 100KB；任意插件 id 开放）；
 *  - 其余：已注册插件 → ok:false（未实现执行器）；未注册插件 → 404。
  * 顺序：插件专属执行器（phone-log / feishu-cli send）优先于通用通道
 * （__cmd 对专属节点不劫持；feishu 其它节点仍可走通用通道）。
 */
export async function handleInvoke(
  body: Record<string, unknown>,
  deps: InvokeDeps,
): Promise<{ status: number; payload: InvokePayload }> {
  const plugin = strArg(body.plugin)
  const node = strArg(body.node)
  if (!plugin || !node) {
    return { status: 400, payload: { ok: false, message: 'invoke 需要 plugin 与 node 字段（非空字符串）' } }
  }
  const args =
    body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {}
  const project = strArg(body.project)
  const projectsRoot = deps.projectsRoot

  const result = await loadPluginRegistry({ projectsRoot, projectPath: project || null })
  const manifest = result.manifests.find((m) => m.id === plugin) ?? null

  const runCmd = deps.runCmd ?? runCommand

  // ① phone-log：专属执行器（双模式读取 + 持续流，见 phone-log.ts）
  if (plugin === 'phone-log' && isPluginNodeId(plugin, node)) {
    const payload = await invokePhoneLog(node, args, {
      project,
      streams: deps.streams ?? pluginStreams,
      runCmd,
      readTimeoutMs: deps.readTimeoutMs,
    })
    return { status: 200, payload }
  }

  // ② feishu-cli：feishuCli.send 命令模板构造 + 透传执行（T6.6）
  if (plugin === 'feishu-cli' && node === 'feishuCli.send') {
    const built = buildFeishuSendCommand(args, manifest ?? undefined)
    if (!built.ok) return { status: 200, payload: { ok: false, message: built.message } }
    const result2 = await runCmd(built.cmd, {
      timeoutMs: deps.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS,
      maxOutputBytes: INVOKE_MAX_OUTPUT_BYTES,
    })
    const stdoutTail = tailText(result2.stdout, INVOKE_TAIL_BYTES)
    const stderrTail = tailText(result2.stderr, INVOKE_TAIL_BYTES)
    if (result2.timedOut) {
      return { status: 200, payload: { ok: false, stdout: stdoutTail, stderr: stderrTail, message: `飞书 CLI 调用超时（${deps.invokeTimeoutMs ?? INVOKE_TIMEOUT_MS}ms）` } }
    }
    return {
      status: 200,
      payload: {
        ok: result2.code === 0,
        outputs: { text: stdoutTail },
        stdout: stdoutTail,
        stderr: stderrTail,
        ...(result2.code === 0 ? {} : { message: `飞书 CLI 调用失败（退出码 ${result2.code ?? '无'}）` }),
      },
    }
  }

  // ③ 通用通道：__cmd 透传执行（30s 超时；stdout 尾部 100KB）。对任意插件 id 开放
  // （未注册插件亦可用，作为显式逃生通道；配合 node 字段仅作请求标识）
  const passthrough = await invokeGenericCmd(args, runCmd, deps.invokeTimeoutMs)
  if (passthrough !== null) return { status: 200, payload: passthrough }

  // ④ 未实现 / 未注册：已注册插件给「未实现」说明；未注册插件给 404（拼写错误更易发现）
  if (manifest) {
    return {
      status: 200,
      payload: {
        ok: false,
        message: `插件「${plugin}」未实现节点「${node}」的服务端执行器（通用通道可在 args 传 __cmd: 命令字符串透传执行）`,
      },
    }
  }
  return { status: 404, payload: { ok: false, message: `插件不存在：${plugin}` } }
}

/**
 * 通用透传通道：args.__cmd（非空字符串）→ shell 执行（30s 超时），返回
 * stdout 尾部 100KB；退出码非 0 → ok:false + 中文 message。无 __cmd 返回 null
 * （调用方继续走插件专属执行器 / 未实现分支）。
 */
async function invokeGenericCmd(
  args: Record<string, unknown>,
  runCmd: typeof runCommand,
  timeoutMs?: number,
): Promise<InvokePayload | null> {
  const cmd = strArg(args.__cmd)
  if (!cmd) return null
  const effectiveTimeout = timeoutMs ?? INVOKE_TIMEOUT_MS
  const result = await runCmd(cmd, {
    timeoutMs: effectiveTimeout,
    maxOutputBytes: INVOKE_MAX_OUTPUT_BYTES,
  })
  const stdoutTail = tailText(result.stdout, INVOKE_TAIL_BYTES)
  const stderrTail = tailText(result.stderr, INVOKE_TAIL_BYTES)
  if (result.timedOut) {
    return { ok: false, stdout: stdoutTail, stderr: stderrTail, message: `命令执行超时被终止（${effectiveTimeout}ms）：${cmd}` }
  }
  return {
    ok: result.code === 0,
    stdout: stdoutTail,
    stderr: stderrTail,
    ...(result.code === 0 ? {} : { message: `命令执行失败（退出码 ${result.code ?? '无'}）` }),
  }
}

/* ---------------- phone-log 转交（实现本体在 ./phone-log.ts） ---------------- */

/** phone-log invoke 依赖（phone-log.ts 消费；executor 侧组装） */
export interface PhoneLogInvokeDeps {
  project: string
  streams: PluginStreamManager
  runCmd: typeof runCommand
  readTimeoutMs?: number
}

/**
 * phone-log 节点执行入口（phoneLog.read / phoneLog.onLine；兼容字面
 * 'phone-log.*' 前缀写法）。实现见 ./phone-log.ts（T6.5）。
 */
async function invokePhoneLog(
  node: string,
  args: Record<string, unknown>,
  deps: PhoneLogInvokeDeps,
): Promise<InvokePayload> {
  const { invokePhoneLogNode } = await import('./phone-log')
  return invokePhoneLogNode(node, args, deps)
}

/* ============================================================
 * HTTP 路由分发（index.ts 追加调用；真实 server 冒烟走这里）
 * ============================================================ */

/** 路由上下文（index.ts 注入自身的基础设施，保持「只追加」的改动形态） */
export interface ExecutorRouteContext {
  req: IncomingMessage
  res: ServerResponse
  pathname: string
  query: URLSearchParams
  projectsRoot: string
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void
  /** invoke / detect 依赖注入（测试用；缺省进程内单例与默认超时） */
  invoke?: Pick<InvokeDeps, 'streams' | 'runCmd' | 'invokeTimeoutMs' | 'readTimeoutMs'>
  detect?: { timeoutMs?: number }
}

/** 从注册表按 id 取清单（project 感知：项目级清单可覆盖内置） */
async function loadManifestById(
  projectsRoot: string,
  project: string | null,
  id: string,
): Promise<PluginManifest | null> {
  const result = await loadPluginRegistry({ projectsRoot, projectPath: project })
  return result.manifests.find((m) => m.id === id) ?? null
}

/**
 * 执行器路由（index.ts 在插件注册表路由**之前**追加调用）：
 *  - POST /api/plugins/invoke                              → JSON
 *  - GET|POST /api/plugins/:id/detect?project=&cmdOverride= → JSON
 *  - GET /api/plugins/:id/install?project=&action=&cmdOverride= → SSE 流
 * 命中返回 true（已响应）；未命中返回 false（index.ts 继续后续路由）。
 * SSE：写头后逐事件 data 帧 + 15s 心跳注释行；客户端断开 → abort 子进程。
 */
export async function handleExecutorRequest(ctx: ExecutorRouteContext): Promise<boolean> {
  const { pathname, query, req, res } = ctx

  // ---- POST /api/plugins/invoke ----
  if (pathname === '/api/plugins/invoke') {
    if (req.method !== 'POST') {
      ctx.sendJson(res, 405, { ok: false, message: 'invoke 仅支持 POST' })
      return true
    }
    const body = await ctx.readJson(req) // FsError 由 index.ts 统一 catch 转 JSON
    const result = await handleInvoke(body, { projectsRoot: ctx.projectsRoot, ...ctx.invoke })
    ctx.sendJson(res, result.status, result.payload)
    return true
  }

  // ---- /api/plugins/:id/detect | /api/plugins/:id/install ----
  const match = /^\/api\/plugins\/([^/]+)\/(detect|install)\/?$/.exec(pathname)
  if (!match) return false
  let id: string
  try {
    id = decodeURIComponent(match[1])
  } catch {
    ctx.sendJson(res, 400, { ok: false, message: `插件 id 编码非法：${match[1]}` })
    return true
  }
  const verb = match[2] as 'detect' | 'install'
  const manifest = await loadManifestById(ctx.projectsRoot, query.get('project'), id)
  if (!manifest) {
    ctx.sendJson(res, 404, { ok: false, message: `插件不存在：${id}` })
    return true
  }

  if (verb === 'detect') {
    if (req.method !== 'POST' && req.method !== 'GET') {
      ctx.sendJson(res, 405, { ok: false, message: 'detect 仅支持 POST / GET' })
      return true
    }
    const result = await detectPlugin(manifest, {
      cmdOverride: decodeCmdOverride(query.get('cmdOverride')),
      timeoutMs: ctx.detect?.timeoutMs,
    })
    ctx.sendJson(res, 200, result)
    return true
  }

  // ---- install / update：SSE 流 ----
  if (req.method !== 'GET') {
    ctx.sendJson(res, 405, { ok: false, message: 'install 仅支持 GET（SSE 流）' })
    return true
  }
  const rawAction = query.get('action')
  if (rawAction !== 'install' && rawAction !== 'update') {
    ctx.sendJson(res, 400, { ok: false, message: 'action 必须为 install 或 update' })
    return true
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  const send = (ev: InstallStreamEvent): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }
  send({ type: 'log', line: `开始${ACTION_LABEL[rawAction]}插件「${manifest.name}」…` })
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)
  ping.unref?.()
  const abort = new AbortController()
  req.on('close', () => abort.abort()) // 客户端取消安装 → 杀子进程
  try {
    await runInstall(manifest, {
      action: rawAction,
      cmdOverride: decodeCmdOverride(query.get('cmdOverride')),
      onEvent: send,
      signal: abort.signal,
    })
  } catch (err) {
    send({ type: 'error', message: `安装流异常：${err instanceof Error ? err.message : String(err)}` })
  } finally {
    clearInterval(ping)
    if (!res.writableEnded) res.end()
  }
  return true
}
