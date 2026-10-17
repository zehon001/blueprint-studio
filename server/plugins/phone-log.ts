/**
 * Blueprint Studio v2 —— 手机日志插件执行器（T6.5 · PLAN §14.3 全项）
 *
 * 职责（invoke 端点内实现；经 executor.ts 的 handleInvoke 转交）：
 *  1. phoneLog.read 双模式（args.mode，以清单 options 实际 value 对齐：
 *     'device'/'file'，并兼容中文 label '手机读取'/'文件读取'；缺省 device）：
 *     - 手机读取 device：拉全量 dump `adb [-s serial] logcat -d -v time`（30s 超时），
 *       服务端解析 + 按 packageFilter 过滤（启发式：msg / tag / raw 包含即保留，
 *       不依赖 shell 管道跨平台 findstr/grep）；adb 不存在 → ok:false 中文提示。
 *     - 文件读取 file：args.files（绝对路径数组，multi）逐文件读 → parseAndroidLogLine
 *       逐行解析（单源：直接 import src/nodes/convert.ts，无浏览器依赖）→
 *       多文件时间稳定归并排序（同时间戳 tie-break：文件序 → 行序，比较器构成
 *       全序、结果确定）→ LogRow[]。
 *     outputs 键与清单输出脚 id 一致：{ rows: LogRow[], count: rows.length }。
 *  2. phoneLog.onLine 持续流（简化可行版）：
 *     - args { action:'start', serial?, packageFilter? } → 服务端 spawn
 *       `adb [-s serial] logcat -v time`（无 -d 长进程），注册到流管理器，
 *       返回 { ok:true, streamId }；行过滤（同启发式）后经 WS hub 以
 *       { type:'plugin.push', plugin:'phone-log', streamId, line, project } 广播
 *       给订阅了该 project 的连接；
 *     - args { action:'stop', streamId } → 杀进程树；进程自然结束 / 出错 →
 *       流管理器广播 { type:'plugin.close', streamId }；
 *     - 启动后早退探测（250ms 窗口内退出 = 启动失败，典型为 adb 不存在）。
 *  3. 测试钩子：args.__adbPath 覆盖 adb 可执行文件路径（mock adb 用），
 *     args.__cmd 走 executor 通用透传通道（不经本文件）。
 *
 * 日志解析单源说明：src/nodes/convert.ts 只依赖 ./spec 与 ../ir/types（均为
 * 纯模块、无浏览器 API），服务端直接 import 复用 parseAndroidLogLine / LogRow。
 */
import fs from 'node:fs'
import { parseAndroidLogLine, type LogRow } from '../../src/nodes/convert'
import {
  COMMAND_NOT_FOUND_RE,
  isCommandNotFound,
  runCommand,
  tailText,
  type CmdResult,
  type InvokePayload,
  type PluginStreamManager,
  type RunCmdOptions,
} from './executor'

/** 手机读取（logcat dump）超时 */
export const READ_TIMEOUT_MS = 30_000
/** 手机读取输出收集上限（全量 dump 可能很大，给到 8MB） */
export const READ_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/* ============================================================
 * 通用小工具（与 executor.ts 内同名工具语义一致，保持本文件自包含）
 * ============================================================ */

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strArrayArg(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

/** 延迟（早退探测窗口用；计时器不吊住进程退出） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/* ============================================================
 * 模式与命令构造
 * ============================================================ */

/** 读取模式（与清单 phone-log.json 的 mode options value 对齐） */
export type PhoneLogMode = 'device' | 'file'

/**
 * 模式取值对齐（以清单为准）：options value = 'device' / 'file'（label 为
 * '手机读取' / '文件读取'）。两种写法都接受；其余（非空）→ null（未知模式）。
 */
export function normalizePhoneLogMode(v: unknown): PhoneLogMode | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === 'device' || s === '手机读取') return 'device'
  if (s === 'file' || s === '文件读取') return 'file'
  return null
}

/**
 * 构造 logcat 命令（shell 串）：
 *  - dump（read）：`adb [-s <serial>] logcat -d -v time`
 *  - follow（onLine 持续流）：`adb [-s <serial>] logcat -v time`（无 -d）
 * adbPath / serial 含空格时引号包裹；-s 是 adb 级选项，位于 logcat 子命令之前。
 */
export function buildLogcatCommand(opts: { adbPath?: string; serial?: string; follow: boolean }): string {
  const rawPath = opts.adbPath?.trim() ?? ''
  const adb = rawPath !== '' ? `"${rawPath.replace(/"/g, '')}"` : 'adb'
  const parts: string[] = [adb]
  const serial = opts.serial?.trim() ?? ''
  if (serial !== '') parts.push('-s', `"${serial.replace(/"/g, '')}"`)
  parts.push('logcat')
  if (!opts.follow) parts.push('-d')
  parts.push('-v', 'time')
  return parts.join(' ')
}

/* ============================================================
 * 日志解析与多文件时间归并（§14.3 核心）
 * ============================================================ */

/** 解析多行日志文本（跳过空行；解析失败行保留 raw、ts=0） */
export function parseLogLines(text: string, now: Date): LogRow[] {
  const rows: LogRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    rows.push(parseAndroidLogLine(line, now))
  }
  return rows
}

/** 带归并稳定键的日志条目（文件序 + 行序） */
export interface LogEntry {
  row: LogRow
  /** 文件序（args.files 的下标） */
  file: number
  /** 行序（文件内行下标，跳过空行不影响该下标） */
  line: number
}

/** 解析单个日志文件文本为带稳定键的条目 */
export function parseLogFileText(text: string, fileIndex: number, now: Date): LogEntry[] {
  const out: LogEntry[] = []
  const lines = text.split(/\r?\n/)
  for (let li = 0; li < lines.length; li++) {
    if (lines[li].trim() === '') continue
    out.push({ row: parseAndroidLogLine(lines[li], now), file: fileIndex, line: li })
  }
  return out
}

/**
 * 多文件时间稳定归并排序（PLAN §14.3：同时间按文件序 + 行序 tie-break）。
 * 实现为「带稳定键的 sort」：比较器 (ts, file, line) 三元组构成全序（键唯一），
 * 与 Array.sort 的实现稳定性无关、结果确定，语义等价于 k 路稳定归并。
 */
export function mergeSortLogEntries(entries: readonly LogEntry[]): LogRow[] {
  const sorted = [...entries].sort(
    (a, b) => a.row.ts - b.row.ts || a.file - b.file || a.line - b.line,
  )
  return sorted.map((e) => e.row)
}

/** 包名过滤启发式：msg / tag / raw 包含即保留（dump 场景包名出现在 msg/tag 中） */
export function rowMatchesPackage(row: LogRow, filter: string): boolean {
  return row.msg.includes(filter) || row.tag.includes(filter) || row.raw.includes(filter)
}

/** 按包名过滤行（filter 为空 = 全量） */
export function filterRows(rows: LogRow[], filter: string): LogRow[] {
  if (filter === '') return rows
  return rows.filter((r) => rowMatchesPackage(r, filter))
}

/** 持续流行过滤（原始行包含即保留；与 parse 后的启发式一致） */
export function lineMatchesPackage(line: string, filter: string): boolean {
  return line.includes(filter)
}

/* ============================================================
 * phoneLog.read 双模式
 * ============================================================ */

/** phone-log 执行依赖（executor.ts 组装；测试注入替换） */
export interface PhoneLogDeps {
  /** 归属项目（持续流推送按 project 订阅广播；'' = 无项目） */
  project: string
  /** 流管理器（onLine 持续流用） */
  streams: PluginStreamManager
  /** 命令执行（缺省 runCommand；测试可注入 mock 捕获命令串） */
  runCmd?: (cmd: string, opts?: RunCmdOptions) => Promise<CmdResult>
  /** 手机读取超时（缺省 READ_TIMEOUT_MS；测试用小值） */
  readTimeoutMs?: number
}

/**
 * phoneLog.read（双模式读取）：
 *  - device：adb dump（30s 超时）→ 服务端解析 → 包名过滤；不重排（dump 天然时间序）；
 *    解析失败行（如 '--------- beginning of xxx' 头）保留 raw、ts=0。
 *  - file：逐文件读 → 解析 → 多文件时间稳定归并（tie-break 文件序→行序）→ 包名过滤。
 * outputs 键与清单输出脚一致：{ rows, count }。
 */
export async function readPhoneLog(
  args: Record<string, unknown>,
  deps: PhoneLogDeps,
): Promise<InvokePayload> {
  const rawMode = typeof args.mode === 'string' ? args.mode.trim() : ''
  const mode = rawMode === '' ? 'device' : normalizePhoneLogMode(rawMode)
  if (mode === null) {
    return { ok: false, message: `未知读取模式：${rawMode}（支持 device=手机读取 / file=文件读取）` }
  }
  const filter = strArg(args.packageFilter)

  if (mode === 'device') {
    const adbPath = strArg(args.__adbPath)
    const serial = strArg(args.serial)
    const cmd = buildLogcatCommand({ adbPath: adbPath || undefined, serial: serial || undefined, follow: false })
    const run = deps.runCmd ?? runCommand
    const result = await run(cmd, {
      timeoutMs: deps.readTimeoutMs ?? READ_TIMEOUT_MS,
      maxOutputBytes: READ_MAX_OUTPUT_BYTES,
    })
    if (isCommandNotFound(result)) {
      return { ok: false, message: 'adb 未安装或不在 PATH（可在插件面板安装）' }
    }
    if (result.timedOut) {
      return { ok: false, message: `读取手机日志超时（${deps.readTimeoutMs ?? READ_TIMEOUT_MS}ms）` }
    }
    if (result.code !== 0) {
      const stderrTail = tailText(result.stderr, 400).trim()
      return {
        ok: false,
        message: `adb logcat 执行失败（退出码 ${result.code ?? '未知'}）${stderrTail !== '' ? `：${stderrTail}` : ''}`,
      }
    }
    // 拉全量 dump 后在服务端解析 + 过滤（不依赖 shell 管道，跨平台一致）
    const rows = filterRows(parseLogLines(result.stdout, new Date()), filter)
    return { ok: true, outputs: { rows, count: rows.length }, stdout: tailText(result.stdout, 100 * 1024) }
  }

  // ---- file 模式：多文件读取 + 归并 ----
  const files = strArrayArg(args.files)
  if (files.length === 0) {
    return { ok: false, message: '文件读取模式需要提供日志文件（files 引脚，可多选）' }
  }
  const now = new Date()
  const entries: LogEntry[] = []
  for (let fi = 0; fi < files.length; fi++) {
    let text: string
    try {
      text = await fs.promises.readFile(files[fi], 'utf8')
    } catch (err) {
      // 文件对话框返回的绝对路径可能不存在 / 无权限：整体失败并说明（不静默跳过）
      return {
        ok: false,
        message: `日志文件读取失败：${files[fi]}（${err instanceof Error ? err.message : String(err)}）`,
      }
    }
    entries.push(...parseLogFileText(text, fi, now))
  }
  const merged = mergeSortLogEntries(entries)
  const rows = filterRows(merged, filter)
  return { ok: true, outputs: { rows, count: rows.length } }
}

/* ============================================================
 * phoneLog.onLine 持续流（启动 / 停止）
 * ============================================================ */

/**
 * phoneLog.onLine（持续流事件节点）：
 *  - start：spawn `adb [-s serial] logcat -v time` 长进程 → 注册流管理器 →
 *    返回 { ok:true, streamId }；行（按包名过滤后）经 WS hub 广播 plugin.push；
 *    250ms 早退探测窗口内退出（典型：adb 不存在，cmd.exe 退出码 9009 / POSIX 127）
 *    → ok:false 中文 message（adb 缺失给专用提示）。
 *  - stop：按 streamId 杀进程树（close 广播由流管理器完成）。
 */
export async function onLineStream(
  args: Record<string, unknown>,
  deps: PhoneLogDeps,
): Promise<InvokePayload> {
  const action = strArg(args.action) || 'start'
  const streams = deps.streams

  if (action === 'stop') {
    const streamId = strArg(args.streamId)
    const stopped = streams.stop(streamId)
    return stopped
      ? { ok: true, message: '已停止持续流' }
      : { ok: false, message: `持续流不存在或已结束：${streamId !== '' ? streamId : '(未提供 streamId)'}` }
  }
  if (action !== 'start') {
    return { ok: false, message: `未知 action：${action}（支持 start / stop）` }
  }

  const adbPath = strArg(args.__adbPath)
  const serial = strArg(args.serial)
  const filter = strArg(args.packageFilter)
  const cmd = buildLogcatCommand({ adbPath: adbPath || undefined, serial: serial || undefined, follow: true })
  const project = deps.project
  const { streamId, child, done, stderrText } = streams.start({
    project,
    plugin: 'phone-log',
    cmd,
    onLine: (line) => {
      // 行过滤（启发式）后经 WS hub 广播给订阅了该 project 的连接（协议扩展 plugin.push）
      if (filter !== '' && !lineMatchesPackage(line, filter)) return
      streams.hub.broadcast(project, {
        type: 'plugin.push',
        plugin: 'phone-log',
        streamId,
        line,
        project,
      })
    },
  })

  // 早退探测：窗口内已退出 = 启动失败（进程 close 事件已由流管理器清理并广播 close）。
  // 「命令不存在」判定：退出码 9009/127，或 GBK 兜底解码后的 stderr 命中报文特征
  // （Windows cmd.exe 对找不到的命令退出码可能为 1 且报文随系统语言变化）。
  await delay(streams.earlyExitMs)
  if (child.exitCode !== null || child.signalCode !== null) {
    // 等 close 处理完成（stdio 排干 + GBK 兜底解码落定），再读 stderr
    await Promise.race([done, delay(500)])
    const code = child.exitCode
    const notFound =
      code === 9009 || code === 127 || COMMAND_NOT_FOUND_RE.test(stderrText())
    return {
      ok: false,
      message: notFound
        ? 'adb 未安装或不在 PATH（可在插件面板安装）'
        : `adb logcat 启动失败（退出码 ${code ?? '未知'}）`,
    }
  }
  return {
    ok: true,
    streamId,
    message: '持续流已启动（行推送经 WS plugin.push；停止传 action=stop + streamId）',
  }
}

/* ============================================================
 * invoke 分发入口（executor.handleInvoke 转交）
 * ============================================================ */

/** 节点 id 尾段（'phoneLog.read' / 'phone-log.read' → 'read'） */
function nodeTail(node: string): string {
  return node.replace(/^phoneLog\./, '').replace(/^phone-log\./, '')
}

/** phone-log 节点执行入口（read / onLine；未知节点走通用通道由 executor 处理） */
export async function invokePhoneLogNode(
  node: string,
  args: Record<string, unknown>,
  deps: PhoneLogDeps,
): Promise<InvokePayload> {
  const tail = nodeTail(node)
  if (tail === 'read') return readPhoneLog(args, deps)
  if (tail === 'onLine') return onLineStream(args, deps)
  return {
    ok: false,
    message: `插件「phone-log」未实现节点「${node}」的执行器（通用通道可在 args 传 __cmd 透传执行）`,
  }
}
