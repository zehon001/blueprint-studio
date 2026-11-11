/**
 * 人员任务看板（目录即状态）
 *
 * 目录布局（位于人员当前工作区，DSH 会话可直接访问）：
 *   TASKBOARD/
 *     pending/    待执行（只由服务端写入 / 删除）
 *     running/    执行中（由执行会话移入）
 *     completed/  已完成（由执行会话移入）
 *     failed/     执行失败（由执行会话移入）
 *     stopped/    已中断（由执行会话移入）
 *
 * 任务文件 = `<四位序号>_<taskId>.md`，内容不可变：
 *   <!-- bp-task
 *   { "id": "...", "title": "...", "createdAt": 0, "source": {...} }
 *   -->
 *   # 标题
 *
 *   正文
 *
 * 结果与产物写同名 sidecar（不改任务文件）：
 *   <base>.result.md        结果文本
 *   <base>.error.txt        失败 / 中断原因
 *   <base>.artifacts.json   产物登记 [{ path, kind, title }]
 *
 * 状态迁移靠 rename（同盘原子）：会话领取任务 = mv pending/x.md running/x.md。
 * 服务端只负责 pending/ 与异常恢复；正常终态由执行会话写入，避免共享文件并发覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  PersonArtifact,
  PersonArtifactKind,
  PersonTask,
  PersonTaskSource,
  PersonTaskStatus,
} from '../src/shared/personnel'

export const BOARD_DIR_NAME = 'TASKBOARD'

export type BoardStatus = PersonTaskStatus

const BOARD_STATUSES: readonly BoardStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'stopped',
]

const ARTIFACT_KINDS: readonly PersonArtifactKind[] = ['markdown', 'json', 'csv', 'image', 'file']

const META_PREFIX = '<!-- bp-task'
const META_RE = /^<!-- bp-task\s*\r?\n([\s\S]*?)\r?\n-->\s*\r?\n?/
const TASK_FILE_RE = /^(\d{1,8})_(.+)\.md$/

export function boardRootOf(workspace: string): string {
  return path.join(workspace, BOARD_DIR_NAME)
}

export function boardStatusDir(workspace: string, status: BoardStatus): string {
  return path.join(boardRootOf(workspace), status)
}

export function isBoardInitialized(workspace: string): boolean {
  return (
    fs.existsSync(boardRootOf(workspace)) &&
    BOARD_STATUSES.every((status) => fs.existsSync(boardStatusDir(workspace, status)))
  )
}

export function initBoardDirs(workspace: string): void {
  fs.mkdirSync(boardRootOf(workspace), { recursive: true })
  for (const status of BOARD_STATUSES) fs.mkdirSync(boardStatusDir(workspace, status), { recursive: true })
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function removeIfExists(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* 忽略 */
  }
}

function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

function padSeq(seq: number): string {
  return String(Math.max(1, seq)).padStart(4, '0')
}

/** 任务标题缺省值：正文第一行非空文本（去掉 Markdown 标题前缀） */
export function taskTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return (firstLine || '未命名任务').slice(0, 120)
}

/** 规范化蓝图来源（只保留已知字段；空对象返回 undefined） */
export function normalizeTaskSource(raw: unknown): PersonTaskSource | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Partial<PersonTaskSource>
  const kind = str(o.kind) === 'blueprint' ? 'blueprint' : str(o.kind) === 'manual' ? 'manual' : ''
  if (!kind) return undefined
  const out: PersonTaskSource = { kind }
  for (const key of ['project', 'assetPath', 'graphName', 'nodeId', 'runId', 'resumeOf'] as const) {
    const value = str(o[key]).trim()
    if (value) out[key] = value.slice(0, 500)
  }
  return out
}

function normalizeArtifacts(raw: unknown): PersonArtifact[] {
  if (!Array.isArray(raw)) return []
  const out: PersonArtifact[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const o = item as { path?: unknown; kind?: unknown; title?: unknown }
    const rel = str(o.path).trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
    if (
      !rel ||
      path.posix.isAbsolute(rel) ||
      /^[A-Za-z]:/.test(rel) ||
      rel.split('/').includes('..') ||
      /[\u0000-\u001f]/.test(rel) ||
      seen.has(rel)
    ) {
      continue
    }
    const kind = str(o.kind) as PersonArtifactKind
    if (!ARTIFACT_KINDS.includes(kind)) continue
    seen.add(rel)
    out.push({
      path: rel,
      kind,
      ...(str(o.title) ? { title: str(o.title).slice(0, 120) } : {}),
    })
  }
  return out
}

interface BoardFile {
  file: string
  base: string
  seq: number
  filenameId: string
}

function taskFilesIn(workspace: string, status: BoardStatus): BoardFile[] {
  const dir = boardStatusDir(workspace, status)
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: BoardFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    if (entry.name.endsWith('.result.md')) continue
    const match = TASK_FILE_RE.exec(entry.name)
    if (!match) continue
    const seq = Number(match[1])
    const filenameId = match[2]!
    if (!Number.isFinite(seq) || !isSafeTaskId(filenameId)) continue
    out.push({
      file: path.join(dir, entry.name),
      base: path.join(dir, entry.name.slice(0, -3)),
      seq,
      filenameId,
    })
  }
  out.sort((a, b) => a.seq - b.seq || a.filenameId.localeCompare(b.filenameId))
  return out
}

/** 读 sidecar：优先同目录；兼容“先写结果再 mv 任务文件”的旧习惯（去其余状态目录找同名文件） */
function readSidecar(workspace: string, base: string, ext: string): string {
  const primary = `${base}${ext}`
  if (fs.existsSync(primary)) return readText(primary)
  const name = `${path.basename(base)}${ext}`
  for (const status of BOARD_STATUSES) {
    const candidate = path.join(boardStatusDir(workspace, status), name)
    if (candidate === primary) continue
    if (fs.existsSync(candidate)) return readText(candidate)
  }
  return ''
}

function parseTaskFile(workspace: string, item: BoardFile, status: BoardStatus): PersonTask | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(item.file)
  } catch {
    return null
  }
  const raw = readText(item.file)
  let meta: Record<string, unknown> = {}
  let body = raw
  const match = META_RE.exec(raw)
  if (match) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      /* 元数据损坏：按文件名与正文降级 */
    }
    body = raw.slice(match[0].length)
  }
  const id = isSafeTaskId(str(meta.id)) ? str(meta.id) : item.filenameId
  const heading = /^#\s+(.+?)\s*$/m.exec(body)
  const content = body
    .replace(/^#\s+.+?\s*\r?\n+/, '')
    .trim()
  const title =
    str(meta.title).trim().slice(0, 120) ||
    heading?.[1]?.trim().slice(0, 120) ||
    taskTitleFromContent(content)
  const result = readSidecar(workspace, item.base, '.result.md').trim().slice(0, 20_000)
  const error = readSidecar(workspace, item.base, '.error.txt').trim().slice(0, 2_000)
  let artifacts: PersonArtifact[] = []
  const artifactsRaw = readSidecar(workspace, item.base, '.artifacts.json')
  if (artifactsRaw.trim()) {
    try {
      artifacts = normalizeArtifacts(JSON.parse(artifactsRaw))
    } catch {
      artifacts = []
    }
  }
  const source = normalizeTaskSource(meta.source)
  const createdAt = num(meta.createdAt) || stat.birthtimeMs || stat.ctimeMs
  return {
    id,
    title,
    content,
    status,
    createdAt,
    ...(status === 'running' ? { startedAt: stat.ctimeMs } : {}),
    ...(status !== 'pending' && status !== 'running' ? { finishedAt: stat.ctimeMs } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(source ? { source } : {}),
  }
}

/** 读取整块看板：running → pending（执行顺序）→ 终态（最近完成在前） */
export function readBoardTasks(workspace: string): PersonTask[] {
  const tasks: PersonTask[] = []
  for (const item of taskFilesIn(workspace, 'running')) {
    const task = parseTaskFile(workspace, item, 'running')
    if (task) tasks.push(task)
  }
  for (const item of taskFilesIn(workspace, 'pending')) {
    const task = parseTaskFile(workspace, item, 'pending')
    if (task) tasks.push(task)
  }
  const terminal: PersonTask[] = []
  for (const status of ['completed', 'failed', 'stopped'] as const) {
    for (const item of taskFilesIn(workspace, status)) {
      const task = parseTaskFile(workspace, item, status)
      if (task) terminal.push(task)
    }
  }
  terminal.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
  tasks.push(...terminal)
  return tasks
}

function nextSeq(workspace: string): number {
  let max = 0
  for (const status of BOARD_STATUSES) {
    for (const item of taskFilesIn(workspace, status)) max = Math.max(max, item.seq)
  }
  return max + 1
}

export interface BoardTaskInput {
  title?: string
  content: string
  createdAt?: number
  source?: PersonTaskSource
}

/** 写任务文件（任务内容不可变；仅新建 / 迁移时调用） */
export function writeBoardTaskFile(
  workspace: string,
  status: BoardStatus,
  seq: number,
  task: Pick<PersonTask, 'id' | 'title' | 'content' | 'createdAt' | 'source'>,
): string {
  initBoardDirs(workspace)
  const base = path.join(boardStatusDir(workspace, status), `${padSeq(seq)}_${task.id}`)
  const meta = {
    id: task.id,
    title: task.title,
    createdAt: task.createdAt,
    ...(task.source ? { source: task.source } : {}),
  }
  writeTextAtomic(
    `${base}.md`,
    `${META_PREFIX}\n${JSON.stringify(meta, null, 2)}\n-->\n# ${task.title}\n\n${task.content.trimEnd()}\n`,
  )
  return base
}

/** 派生任务（服务端发布）：写入 pending/ 并返回任务对象 */
export function addBoardTask(
  workspace: string,
  id: string,
  input: BoardTaskInput,
): PersonTask {
  if (!isSafeTaskId(id)) throw new Error(`任务 id 非法：${id}`)
  const content = input.content.trim()
  if (!content) throw new Error('任务内容不能为空')
  initBoardDirs(workspace)
  const task: PersonTask = {
    id,
    title: str(input.title).trim().slice(0, 120) || taskTitleFromContent(content),
    content,
    status: 'pending',
    createdAt: num(input.createdAt) || Date.now(),
    ...(input.source ? { source: input.source } : {}),
  }
  writeBoardTaskFile(workspace, 'pending', nextSeq(workspace), task)
  return task
}

/** 按 id 找任务文件（跨目录） */
export function findBoardTask(
  workspace: string,
  id: string,
): { status: BoardStatus; item: BoardFile; task: PersonTask } | null {
  for (const status of BOARD_STATUSES) {
    for (const item of taskFilesIn(workspace, status)) {
      if (item.filenameId !== id) {
        const task = parseTaskFile(workspace, item, status)
        if (!task || task.id !== id) continue
        return { status, item, task }
      }
      const task = parseTaskFile(workspace, item, status)
      if (task) return { status, item, task }
    }
  }
  return null
}

function sidecarBases(base: string): string[] {
  return [`${base}.result.md`, `${base}.error.txt`, `${base}.artifacts.json`]
}

/** 删除任务及其 sidecar（执行中的任务由调用方拦截） */
export function deleteBoardTask(workspace: string, id: string): PersonTask | null {
  const found = findBoardTask(workspace, id)
  if (!found) return null
  removeIfExists(found.item.file)
  for (const file of sidecarBases(found.item.base)) removeIfExists(file)
  return found.task
}

function renameTaskFile(workspace: string, id: string, targetStatus: BoardStatus): BoardFile | null {
  const found = findBoardTask(workspace, id)
  if (!found) return null
  if (found.status === targetStatus) return found.item
  initBoardDirs(workspace)
  const targetDir = boardStatusDir(workspace, targetStatus)
  const targetFile = path.join(targetDir, path.basename(found.item.file))
  if (!fs.existsSync(targetFile)) {
    fs.renameSync(found.item.file, targetFile)
  } else {
    // 目标已有同名任务（极端脏数据）：补一个序号，避免覆盖
    const targetBase = path.join(targetDir, `${padSeq(nextSeq(workspace))}_${id}`)
    fs.renameSync(found.item.file, `${targetBase}.md`)
  }
  for (const file of sidecarBases(found.item.base)) {
    if (!fs.existsSync(file)) continue
    const next = path.join(targetDir, path.basename(file))
    removeIfExists(next)
    fs.renameSync(file, next)
  }
  return findBoardTask(workspace, id)?.item ?? null
}

/** 服务端异常恢复：把 running 任务移入指定终态并写原因 */
export function settleRunningTask(
  workspace: string,
  id: string,
  status: 'failed' | 'stopped',
  error: string,
): boolean {
  const found = findBoardTask(workspace, id)
  if (!found || found.status !== 'running') return false
  const moved = renameTaskFile(workspace, id, status)
  if (!moved) return false
  if (error.trim()) writeTextAtomic(`${moved.base}.error.txt`, `${error.trim()}\n`)
  return true
}

/** 调整 pending 顺序（只交换相邻 pending 任务的序号前缀） */
export function movePendingTask(workspace: string, id: string, direction: 'up' | 'down'): boolean {
  const pending = taskFilesIn(workspace, 'pending')
    .map((item) => ({ item, task: parseTaskFile(workspace, item, 'pending') }))
    .filter((entry): entry is { item: BoardFile; task: PersonTask } => entry.task !== null)
  const index = pending.findIndex((entry) => entry.task.id === id)
  if (index < 0) return false
  const step = direction === 'up' ? -1 : 1
  const swapIndex = index + step
  if (swapIndex < 0 || swapIndex >= pending.length) return false
  const a = pending[index]!.item
  const b = pending[swapIndex]!.item
  const dir = boardStatusDir(workspace, 'pending')
  const tmp = path.join(dir, `.swap-${process.pid}-${Date.now()}.md`)
  fs.renameSync(a.file, tmp)
  fs.renameSync(b.file, a.file)
  fs.renameSync(tmp, b.file)
  return true
}

/** 失败 / 停止任务重新放回 pending（保留产物登记，清除结果与错误） */
export function retryBoardTask(workspace: string, id: string): boolean {
  const found = findBoardTask(workspace, id)
  if (!found || (found.status !== 'failed' && found.status !== 'stopped')) return false
  removeIfExists(`${found.item.base}.result.md`)
  removeIfExists(`${found.item.base}.error.txt`)
  return renameTaskFile(workspace, id, 'pending') !== null
}

/** 旧 tasks.json → 看板迁移（调用方保证只在看板未初始化时调用一次） */
export function migrateLegacyTasks(workspace: string, tasks: readonly PersonTask[]): void {
  initBoardDirs(workspace)
  for (const [index, task] of tasks.entries()) {
    if (!isSafeTaskId(task.id)) continue
    const base = writeBoardTaskFile(workspace, task.status, index + 1, task)
    if (task.result) writeTextAtomic(`${base}.result.md`, `${task.result.trimEnd()}\n`)
    if (task.error) writeTextAtomic(`${base}.error.txt`, `${task.error.trimEnd()}\n`)
    if (task.artifacts && task.artifacts.length > 0) {
      writeTextAtomic(`${base}.artifacts.json`, `${JSON.stringify(task.artifacts, null, 2)}\n`)
    }
  }
}

/** 读取任务结果 sidecar（报表查看入口用） */
export function readBoardTaskResult(workspace: string, id: string): string {
  const found = findBoardTask(workspace, id)
  if (!found) return ''
  return readText(`${found.item.base}.result.md`).trim()
}
