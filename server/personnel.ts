/**
 * 人员模块（服务端）
 *
 * 存储布局（peopleRoot 默认 <repo>/_people，可用 BP_PEOPLE_ROOT 覆盖）：
 *   _people/
 *     types.json                         人员类型（全局）
 *     <personId>/
 *       run.json                         最近一次执行状态
 *       workspace/                       默认工作区（人员创建时同步生成）
 *         .person/
 *           config.json                  名称 / 类型 / 模型 / 工作区设置
 *           cards.json                   角色卡
 *           norms.md                     规范
 *           activity.jsonl               动态记录
 *           avatar.*                     头像
 *         AGENTS.md                      DSH 会话唯一启动入口：身份 / 角色卡 / 规范 / 当前任务 / 工作协议
 *         PERSON.md
 *         TASK.md
 *         STATE.md                     跨会话进度（构建时只在缺失时生成，绝不覆盖）
 *         memory/MEMORY.md             长期记忆
 *
 * 「构建工作区」会把默认工作区里除 .person 外的文件移动到用户设置的工作区；
 * 执行时会先构建，再创建 / 复用 DSH 会话并只发送一句启动指令：
 * 「读取 AGENTS.md，然后完成里面的事项。」完整上下文都在 AGENTS.md 中。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { agentGateway } from './agents/handler'
import { isSessionArchived } from './agents/ledger'
import { FsError, repoRoot } from './fs'
import {
  PERSON_PLATFORMS,
  type PersonActivity,
  type PersonConfig,
  type PersonDetail,
  type PersonMemory,
  type PersonMemoryFile,
  type PersonModelSettings,
  type PersonQueueState,
  type PersonRunState,
  type PersonStats,
  type PersonSummary,
  type PersonTask,
  type PersonTaskCounts,
  type PersonTaskStatus,
  type PersonType,
  type PersonWorkspaceSettings,
  type RoleCard,
} from '../src/shared/personnel'

/* ============================================================
 * 常量 / 根目录
 * ============================================================ */

const PROFILE_DIR_NAME = '.person'
const DEFAULT_WORKSPACE_NAME = 'workspace'
const TYPES_FILE_NAME = 'types.json'
const TASKS_FILE_NAME = 'tasks.json'
const TASKS_JSON_NAME = 'TASKS.json'
const QUEUE_FILE_NAME = 'queue.json'
const MAX_ACTIVITY = 500
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const MAX_CARD_CONTENT = 50_000
const MAX_TASK_LENGTH = 30_000
const MAX_NORMS_LENGTH = 50_000
const RUN_TIMEOUT_SEC = 7_200

/** DSH 会话启动指令：完整上下文由工作区 AGENTS.md 提供 */
export const PERSON_STARTUP_PROMPT = '读取 AGENTS.md，然后完成里面的事项。'

/** 人员在 DSH 通知路由里的项目键（与蓝图项目隔离） */
function personProjectKey(id: string): string {
  return `person:${id}`
}

/** 人员根目录（BP_PEOPLE_ROOT 覆盖；缺省 <repo>/_people） */
export function resolvePeopleRoot(): string {
  const env = process.env.BP_PEOPLE_ROOT?.trim()
  if (env) return path.resolve(env)
  return path.join(repoRoot(), '_people')
}

/** 确保人员根目录存在 */
export function ensurePeopleRoot(root: string = resolvePeopleRoot()): string {
  fs.mkdirSync(root, { recursive: true })
  return path.resolve(root)
}

/* ============================================================
 * 基础读写
 * ============================================================ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function readTextFile(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

function writeTextFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

function newPersonId(): string {
  return `p_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

function newRecordId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
}

function assertSafePersonId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new FsError(400, '人员 id 非法')
  return id
}

function personDirOf(root: string, id: string): string {
  return path.join(root, assertSafePersonId(id))
}

function sanitizeName(raw: unknown): string {
  const name = str(raw).replace(/[\u0000-\u001f]/g, '').trim()
  if (!name) throw new FsError(400, '人员名称不能为空')
  if (name.length > 40) throw new FsError(400, '人员名称不能超过 40 个字')
  return name
}

/* ============================================================
 * 默认内容
 * ============================================================ */

function defaultTypes(): PersonType[] {
  return [{ id: 'general', name: '通用' }]
}

function defaultNorms(): string {
  return `【怎么操作文件】
- 所有产出都放在当前工作区里，不要写到工作区之外。
- 修改文件前先读取原内容，避免凭记忆覆盖。
- 不要删除与当前任务无关的文件；需要清理时先说明原因。
- 大文件先搜索再局部读取，不要一次性把整个仓库读进上下文。

【怎么使用工具】
- 优先使用当前环境可用的文件、终端与搜索工具完成任务。
- 命令失败时先读错误输出，再决定重试或换方案，不要静默忽略失败。
- 执行有副作用的命令前，先确认目标路径与影响范围。
- 需要联网或调用外部服务时，先检查配置是否齐全。

【工作状态】
- 每次开始先读 STATE.md，接着上次的进度继续。
- 每完成一个阶段，就把已完成、进行中、下一步写回 STATE.md。
- 值得长期记住的事实写进 memory/MEMORY.md。
`
}

function defaultTask(name: string): string {
  return `等待添加任务。

${name} 会在任务看板中接收任务，并按顺序执行。`
}

function defaultCards(name: string, typeName: string): RoleCard[] {
  return [
    {
      id: newRecordId('card'),
      name: `${name}的角色`,
      tags: typeName ? [typeName] : [],
      content: `你是${name}。\n\n【职责】\n按照人员设置完成分配给你的任务。\n\n【工作原则】\n- 先理解目标，再动手。\n- 执行过程中持续更新工作区里的 STATE.md。\n- 不确定时先查证，不要编造。`,
      updatedAt: Date.now(),
    },
  ]
}

function defaultState(): string {
  return `# 工作状态

- 最后更新：${new Date().toISOString()}
- 当前阶段：准备开始
- 已完成：
- 进行中：
- 下一步：
- 关键文件：

> 本文件由执行会话维护，用来在会话被删除 / 重建后继续上一次的进度。
`
}

function defaultMemory(): string {
  return `# 长期记忆

> 由执行会话按需追加。值得跨会话保留的事实、决定和偏好写在这里。
`
}

/* ============================================================
 * 人员类型
 * ============================================================ */

function typesFileOf(root: string): string {
  return path.join(root, TYPES_FILE_NAME)
}

function normalizeTypes(raw: unknown): PersonType[] {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const out: PersonType[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const o = item as { id?: unknown; name?: unknown }
    const name = str(o.name).replace(/[\u0000-\u001f]/g, '').trim()
    if (!name || name.length > 20) continue
    const key = name.toLowerCase()
    if (seenNames.has(key)) continue
    let id = str(o.id).trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seenIds.has(id)) id = newRecordId('type')
    seenNames.add(key)
    seenIds.add(id)
    out.push({ id, name })
  }
  return out
}

function saveTypesFile(root: string, types: PersonType[]): void {
  writeJsonAtomic(typesFileOf(root), { types, updatedAt: Date.now() })
}

/** 读取类型；文件不存在时写入默认「通用」类型 */
export function loadTypes(root: string = resolvePeopleRoot()): PersonType[] {
  const dir = ensurePeopleRoot(root)
  const file = typesFileOf(dir)
  if (!exists(file)) {
    const seeded = defaultTypes()
    saveTypesFile(dir, seeded)
    return seeded
  }
  const raw = readJsonFile<{ types?: unknown }>(file, { types: [] })
  return normalizeTypes(raw.types)
}

/** 保存类型列表（新增 / 重命名 / 删除由整表覆盖完成），并清理人员上的失效类型引用 */
export function saveTypes(root: string, input: unknown): PersonType[] {
  const dir = ensurePeopleRoot(root)
  if (!Array.isArray(input)) throw new FsError(400, 'types 必须是数组')
  const list = normalizeTypes(input)
  saveTypesFile(dir, list)
  const valid = new Set(list.map((t) => t.id))
  for (const summary of listPeople(root)) {
    if (!summary.typeId || valid.has(summary.typeId)) continue
    try {
      const loaded = loadPerson(root, summary.id)
      loaded.config.typeId = ''
      loaded.config.updatedAt = Date.now()
      saveConfig(loaded)
    } catch {
      /* 单个人员损坏：跳过 */
    }
  }
  return list
}

function typeNameOf(types: PersonType[], typeId: string): string {
  return types.find((t) => t.id === typeId)?.name ?? ''
}

/* ============================================================
 * 人员配置
 * ============================================================ */

interface LoadedPerson {
  id: string
  personDir: string
  defaultWorkspace: string
  profileDir: string
  config: PersonConfig
  cards: RoleCard[]
  norms: string
}

function normalizeConfig(raw: Partial<PersonConfig> | null, id: string): PersonConfig {
  const now = Date.now()
  const name = str(raw?.name).trim() || id
  const modelRaw = (raw?.model ?? {}) as Partial<PersonModelSettings>
  const workspaceRaw = (raw?.workspace ?? {}) as Partial<PersonWorkspaceSettings>
  const statsRaw = (raw?.stats ?? {}) as Partial<PersonStats>
  const platformRaw = str(modelRaw.platform)
  const platform = (PERSON_PLATFORMS as readonly string[]).includes(platformRaw)
    ? (platformRaw as PersonConfig['model']['platform'])
    : 'dsh'
  const workspaceDirRaw = str(workspaceRaw.dir).trim()
  const workspaceDir =
    workspaceDirRaw && path.isAbsolute(workspaceDirRaw) ? path.resolve(workspaceDirRaw) : ''
  return {
    id,
    name,
    typeId: str(raw?.typeId),
    ...(str(raw?.avatarFile) ? { avatarFile: str(raw?.avatarFile) } : {}),
    ...(str(raw?.currentCardId) ? { currentCardId: str(raw?.currentCardId) } : {}),
    createdAt: num(raw?.createdAt) || now,
    updatedAt: num(raw?.updatedAt) || now,
    task: typeof raw?.task === 'string' ? raw.task : defaultTask(name),
    model: {
      platform,
      model: str(modelRaw.model),
      reasoning: str(modelRaw.reasoning),
      permission: str(modelRaw.permission),
    },
    workspace: {
      dir: workspaceDir,
      sessionTitle: str(workspaceRaw.sessionTitle),
      deleteSessionAfterRun: workspaceRaw.deleteSessionAfterRun === true,
      reuseSession: workspaceRaw.reuseSession !== false,
      ...(num(workspaceRaw.builtAt) > 0 ? { builtAt: num(workspaceRaw.builtAt) } : {}),
    },
    stats: {
      runs: num(statsRaw.runs),
      completed: num(statsRaw.completed),
      failed: num(statsRaw.failed),
      ...(num(statsRaw.lastRunAt) > 0 ? { lastRunAt: num(statsRaw.lastRunAt) } : {}),
    },
  }
}

function configPathOf(profileDir: string): string {
  return path.join(profileDir, 'config.json')
}

function cardsPathOf(profileDir: string): string {
  return path.join(profileDir, 'cards.json')
}

function normsPathOf(profileDir: string): string {
  return path.join(profileDir, 'norms.md')
}

function activityPathOf(profileDir: string): string {
  return path.join(profileDir, 'activity.jsonl')
}

function tasksPathOf(profileDir: string): string {
  return path.join(profileDir, TASKS_FILE_NAME)
}

function queuePathOf(personDir: string): string {
  return path.join(personDir, QUEUE_FILE_NAME)
}

function saveConfig(loaded: LoadedPerson): void {
  writeJsonAtomic(configPathOf(loaded.profileDir), loaded.config)
}

function taskTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return (firstLine || '未命名任务').slice(0, 120)
}

function normalizeTasks(raw: unknown): PersonTask[] {
  if (!Array.isArray(raw)) return []
  const allowed = new Set<PersonTaskStatus>([
    'pending',
    'running',
    'completed',
    'failed',
    'stopped',
  ])
  const seen = new Set<string>()
  const out: PersonTask[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Partial<PersonTask>
    let id = str(o.id).trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) id = newRecordId('task')
    seen.add(id)
    const content = str(o.content).slice(0, MAX_TASK_LENGTH)
    const title = str(o.title).trim().slice(0, 120) || taskTitleFromContent(content)
    const status = str(o.status).trim().toLowerCase() as PersonTaskStatus
    out.push({
      id,
      title,
      content,
      status: allowed.has(status) ? status : 'pending',
      createdAt: num(o.createdAt) || Date.now(),
      ...(num(o.startedAt) > 0 ? { startedAt: num(o.startedAt) } : {}),
      ...(num(o.finishedAt) > 0 ? { finishedAt: num(o.finishedAt) } : {}),
      ...(str(o.result) ? { result: str(o.result).slice(0, 20_000) } : {}),
      ...(str(o.error) ? { error: str(o.error).slice(0, 2_000) } : {}),
    })
  }
  return out
}

function readTasks(profileDir: string): PersonTask[] {
  return normalizeTasks(readJsonFile<unknown>(tasksPathOf(profileDir), []))
}

function writeTasks(profileDir: string, tasks: PersonTask[]): void {
  writeJsonAtomic(tasksPathOf(profileDir), tasks)
}

function emptyQueueState(): PersonQueueState {
  return { status: 'idle', total: 0, completed: 0, failed: 0 }
}

function normalizeQueueState(raw: unknown): PersonQueueState {
  if (raw === null || typeof raw !== 'object') return emptyQueueState()
  const o = raw as Partial<PersonQueueState>
  const allowed = new Set<PersonQueueState['status']>([
    'idle',
    'running',
    'stopping',
    'completed',
    'stopped',
    'failed',
  ])
  const status = str(o.status) as PersonQueueState['status']
  return {
    status: allowed.has(status) ? status : 'idle',
    ...(str(o.queueId) ? { queueId: str(o.queueId) } : {}),
    ...(Array.isArray(o.taskIds)
      ? {
          taskIds: o.taskIds.filter(
            (id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id),
          ),
        }
      : {}),
    ...(str(o.currentTaskId) ? { currentTaskId: str(o.currentTaskId) } : {}),
    ...(num(o.currentIndex) > 0 ? { currentIndex: num(o.currentIndex) } : {}),
    total: num(o.total),
    completed: num(o.completed),
    failed: num(o.failed),
    ...(num(o.startedAt) > 0 ? { startedAt: num(o.startedAt) } : {}),
    ...(num(o.finishedAt) > 0 ? { finishedAt: num(o.finishedAt) } : {}),
    ...(str(o.error) ? { error: str(o.error).slice(0, 2_000) } : {}),
  }
}

function readQueueStateRaw(loaded: LoadedPerson): PersonQueueState {
  return normalizeQueueState(readJsonFile<unknown>(queuePathOf(loaded.personDir), null))
}

function writeQueueState(loaded: LoadedPerson, queue: PersonQueueState): void {
  writeJsonAtomic(queuePathOf(loaded.personDir), queue)
}

function taskCountsOf(tasks: PersonTask[]): PersonTaskCounts {
  const counts: PersonTaskCounts = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
  }
  for (const task of tasks) counts[task.status] += 1
  return counts
}

/** 把旧的「职责：/工作原则：」角色卡内容迁移成【职责】/【工作原则】两节。 */
function normalizeCardContent(content: string): string {
  const text = content.replace(/\r\n/g, '\n').trim()
  if (!text || /【职责】|【工作原则】/.test(text)) return text
  const lead: string[] = []
  const duties: string[] = []
  const principles: string[] = []
  let mode: 'lead' | 'duties' | 'principles' = 'lead'
  let foundDuty = false
  let foundPrinciple = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const duty = /^职责(?:是)?[：:]\s*(.*)$/.exec(trimmed)
    const principle = /^工作原则[：:]\s*(.*)$/.exec(trimmed)
    if (duty && !foundDuty) {
      foundDuty = true
      mode = 'duties'
      if (duty[1]?.trim()) duties.push(duty[1]!.trim())
      continue
    }
    if (principle) {
      foundPrinciple = true
      mode = 'principles'
      if (principle[1]?.trim()) principles.push(principle[1]!.trim())
      continue
    }
    if (mode === 'lead') lead.push(line)
    else if (mode === 'duties') duties.push(line)
    else principles.push(line)
  }
  if (!foundDuty && !foundPrinciple) return text
  const clean = (lines: string[]): string =>
    lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '').trim()
  const parts: string[] = []
  const leadText = clean(lead)
  if (leadText) parts.push(leadText)
  if (foundDuty) parts.push(`【职责】\n${clean(duties) || '……'}`)
  if (foundPrinciple) parts.push(`【工作原则】\n${clean(principles) || '……'}`)
  return parts.join('\n\n')
}

function sanitizeCards(raw: unknown): RoleCard[] {
  if (!Array.isArray(raw)) throw new FsError(400, '角色卡必须是数组')
  const seen = new Set<string>()
  const out: RoleCard[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Partial<RoleCard>
    let id = str(o.id).trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) id = newRecordId('card')
    seen.add(id)
    const tags = Array.isArray(o.tags)
      ? o.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 12)
      : []
    out.push({
      id,
      name: str(o.name).trim().slice(0, 60) || '未命名角色卡',
      tags,
      content: normalizeCardContent(str(o.content).slice(0, MAX_CARD_CONTENT)),
      updatedAt: num(o.updatedAt) || Date.now(),
    })
  }
  return out
}

function loadCards(profileDir: string): RoleCard[] {
  const raw = readJsonFile<unknown>(cardsPathOf(profileDir), [])
  try {
    return sanitizeCards(raw)
  } catch {
    return []
  }
}

/** 规范统一 Aurabot 的【小节】格式；旧的 Markdown 标题自动迁移。 */
function normalizeNormsToBracket(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      out.push(`【${heading[1]!.trim()}】`)
    } else {
      out.push(line)
    }
  }
  const text = out.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return text ? `${text}\n` : ''
}

function loadNorms(profileDir: string): string {
  const raw = readTextFile(normsPathOf(profileDir), defaultNorms())
  const normalized = normalizeNormsToBracket(raw)
  if (normalized !== raw) writeTextFile(normsPathOf(profileDir), normalized)
  return normalized
}

function loadPerson(root: string, id: string): LoadedPerson {
  const dir = personDirOf(root, id)
  const defaultWorkspace = path.join(dir, DEFAULT_WORKSPACE_NAME)
  const profileDir = path.join(defaultWorkspace, PROFILE_DIR_NAME)
  const configFile = configPathOf(profileDir)
  if (!exists(configFile)) throw new FsError(404, `人员不存在：${id}`)
  const raw = readJsonFile<Partial<PersonConfig> | null>(configFile, null)
  if (!raw || typeof raw !== 'object') throw new FsError(500, `人员配置损坏：${id}`)
  const config = normalizeConfig(raw, id)
  return {
    id,
    personDir: dir,
    defaultWorkspace,
    profileDir,
    config,
    cards: loadCards(profileDir),
    norms: loadNorms(profileDir),
  }
}

function tryLoadPerson(root: string, id: string): LoadedPerson | null {
  try {
    return loadPerson(root, id)
  } catch {
    return null
  }
}

/** 读取人员并确保当前没有执行中的回合（服务重启留下的 running 会先取消并标记停止） */
function loadPersonIdle(root: string, id: string): LoadedPerson {
  const loaded = loadPerson(root, id)
  readQueueState(loaded)
  readRunState(loaded)
  assertNotRunning(id)
  return loaded
}

/** 任务看板编辑：执行中仍允许增删/排序未执行任务，只禁止操作 running 任务 */
function loadPersonForTaskEdit(root: string, id: string): LoadedPerson {
  const loaded = loadPerson(root, id)
  const queue = readQueueState(loaded)
  if (queue.status === 'running' || queue.status === 'stopping') {
    syncTasksFromWorkspace(loaded)
  }
  return loaded
}

/* ============================================================
 * 动态记录
 * ============================================================ */

function appendActivity(profileDir: string, type: string, text: string): void {
  const file = activityPathOf(profileDir)
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    lines = []
  }
  const entry: PersonActivity = {
    id: newRecordId('act'),
    type,
    text,
    ts: Date.now(),
  }
  lines.push(JSON.stringify(entry))
  if (lines.length > MAX_ACTIVITY) lines = lines.slice(lines.length - MAX_ACTIVITY)
  writeTextFile(file, lines.join('\n') + '\n')
}

function readActivity(profileDir: string, limit = 120): PersonActivity[] {
  let lines: string[] = []
  try {
    lines = fs.readFileSync(activityPathOf(profileDir), 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
  const out: PersonActivity[] = []
  for (const line of lines.slice(-limit)) {
    try {
      const raw = JSON.parse(line) as Partial<PersonActivity>
      if (typeof raw.ts !== 'number' || typeof raw.text !== 'string') continue
      out.push({
        id: str(raw.id) || newRecordId('act'),
        type: str(raw.type) || 'event',
        text: raw.text,
        ts: raw.ts,
      })
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out.reverse()
}

/** 把一次执行的结局追加进工作区 STATE.md，保证即使智能体没写进度也能续接 */
function appendStateNote(loaded: LoadedPerson, run: PersonRunState, text: string): void {
  const dir =
    run.workspaceDir && path.isAbsolute(run.workspaceDir)
      ? run.workspaceDir
      : resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  const file = path.join(dir, 'STATE.md')
  if (!exists(file)) return
  try {
    fs.appendFileSync(
      file,
      `\n\n---\n## 自动执行记录 · ${new Date().toISOString()}\n${text}\n`,
      'utf8',
    )
  } catch {
    /* STATE.md 不可写：不阻塞执行状态更新 */
  }
}

/* ============================================================
 * 工作区路径 / 构建
 * ============================================================ */

function resolveActiveWorkspace(config: PersonConfig, defaultWorkspace: string): string {
  const raw = config.workspace.dir.trim()
  return raw && path.isAbsolute(raw) ? path.resolve(raw) : defaultWorkspace
}

function validateWorkspaceSetting(raw: unknown): string {
  const dir = str(raw).trim()
  if (!dir) return ''
  if (dir.includes('\0') || /[\u0000-\u001f]/.test(dir)) throw new FsError(400, '工作区目录包含非法字符')
  if (!path.isAbsolute(dir)) throw new FsError(400, '工作区目录必须是绝对路径')
  const resolved = path.resolve(dir)
  if (resolved === path.parse(resolved).root) throw new FsError(400, '不能把工作区设置成磁盘根目录')
  return resolved
}

function assertSafeWorkspaceTarget(loaded: LoadedPerson, target: string): void {
  const defaultWs = path.resolve(loaded.defaultWorkspace)
  const resolved = path.resolve(target)
  if (resolved !== defaultWs) {
    const relPeople = path.relative(path.dirname(loaded.personDir), resolved)
    if (relPeople && !relPeople.startsWith('..') && !path.isAbsolute(relPeople)) {
      throw new FsError(400, '工作区不能放在人员数据目录内部')
    }
  }
  if (resolved === path.resolve(loaded.personDir)) {
    throw new FsError(400, '工作区不能直接使用人员目录')
  }
  const insideDefault = path.relative(defaultWs, resolved)
  if (insideDefault && !insideDefault.startsWith('..') && !path.isAbsolute(insideDefault)) {
    throw new FsError(400, '工作区不能放在默认工作区内部')
  }
  const defaultInsideTarget = path.relative(resolved, defaultWs)
  if (defaultInsideTarget && !defaultInsideTarget.startsWith('..') && !path.isAbsolute(defaultInsideTarget)) {
    throw new FsError(400, '工作区不能是默认工作区的上级目录')
  }
}

function movePathDeep(source: string, target: string): void {
  try {
    fs.renameSync(source, target)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  fs.cpSync(source, target, { recursive: true, errorOnExist: true })
  fs.rmSync(source, { recursive: true, force: true })
}

interface MoveResult {
  moved: string[]
  skipped: string[]
}

function moveEntries(sourceDir: string, targetDir: string, skip: ReadonlySet<string>, prefix = ''): MoveResult {
  const result: MoveResult = { moved: [], skipped: [] }
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (!exists(target)) {
      movePathDeep(source, target)
      result.moved.push(rel)
      continue
    }
    if (entry.isDirectory() && isDirectory(target)) {
      const nested = moveEntries(source, target, skip, rel)
      result.moved.push(...nested.moved)
      result.skipped.push(...nested.skipped)
      try {
        if (fs.readdirSync(source).length === 0) fs.rmdirSync(source)
      } catch {
        /* 目录非空或已被移动：忽略 */
      }
      continue
    }
    result.skipped.push(rel)
  }
  return result
}

function agentsMarkdown(
  config: PersonConfig,
  cards: RoleCard[],
  norms: string,
  types: PersonType[],
  queueTasks?: PersonTask[],
): string {
  const typeName = typeNameOf(types, config.typeId) || '未分类'
  const activeCard = cards.find((card) => card.id === config.currentCardId) ?? cards[0]
  const cardText = activeCard
    ? `### ${activeCard.name}\n${
        activeCard.tags.length ? `标签：${activeCard.tags.join('、')}\n` : ''
      }${activeCard.content}`
    : '（暂无角色卡）'
  const taskSection =
    queueTasks && queueTasks.length > 0
      ? `## 任务清单（按顺序执行）
${queueTasks
  .map(
    (task, index) =>
      `### ${index + 1}. ${task.title}\n- id: ${task.id}\n- 初始状态：pending\n\n${task.content}`,
  )
  .join('\n\n')}

## 状态回写
- 你是任务看板的工作者：每次只从 \`TASKS.json\` 领取一个 status=pending 的任务，不要并行。
- 领取任务时先把它的 status 改为 running；完成改为 completed，失败改为 failed，停止改为 stopped，并写入 result / error。
- 每完成一个任务后，重新读取 \`TASKS.json\`，领取下一个 pending 任务；执行期间任务看板可能新增或调整任务，以最新 \`TASKS.json\` 为准。
- \`status\` 只能是 pending / running / completed / failed / stopped；不要修改任务 id、顺序或内容。
- 每完成一个任务更新 STATE.md。
- 全部任务结束后，在 STATE.md 写清最终结果。`
      : `## 当前任务
${config.task.trim() || defaultTask(config.name)}`
  return `# ${config.name} · 工作区行为规范

> 本文件由 Blueprint Studio 的人员页面自动生成；修改人员配置后会自动刷新，请不要直接编辑。
> 会话启动入口：读取本文件，然后完成下方「${queueTasks?.length ? '任务清单' : '当前任务'}」。

## 身份
- 名字：${config.name}
- 类型：${typeName}
- 工作区：${config.workspace.dir || '默认工作区'}

## 角色卡
${cardText}

## 规范
${norms || '（暂无规范）'}

${taskSection}

## 工作协议（跨会话）
1. 每次会话开始，先读 STATE.md；如果存在 memory/MEMORY.md 也一起读。
2. STATE.md 是跨会话、跨重建的唯一进度真源。不要重复 STATE.md 里已经写明的已完成工作。
3. 每完成一个阶段，立即更新 STATE.md：已完成、进行中、下一步、关键文件。
4. 值得长期保留的事实、决定和偏好追加到 memory/MEMORY.md。
5. 不要删除 .person 配置目录；不要修改与本任务无关的文件。
6. 任务完成后，在 STATE.md 中写清最终结果，并给出简短总结。
`
}

function personMarkdown(config: PersonConfig, cards: RoleCard[], types: PersonType[]): string {
  const typeName = typeNameOf(types, config.typeId) || '未分类'
  const activeCard = cards.find((card) => card.id === config.currentCardId) ?? cards[0]
  return `# ${config.name}

- 类型：${typeName}
- 当前角色卡：${activeCard?.name ?? '暂无'}
- 工作区：${config.workspace.dir || '默认工作区'}

详细角色设定与工作协议见 AGENTS.md。
`
}

function writeContextBundle(
  loaded: LoadedPerson,
  dir: string,
  types: PersonType[],
  options: {
    overwriteState?: boolean
    overwriteMemory?: boolean
    queueTasks?: PersonTask[]
  } = {},
): void {
  fs.mkdirSync(dir, { recursive: true })
  const config = loaded.config
  writeTextFile(
    path.join(dir, 'AGENTS.md'),
    agentsMarkdown(config, loaded.cards, loaded.norms, types, options.queueTasks),
  )
  writeTextFile(path.join(dir, 'PERSON.md'), personMarkdown(config, loaded.cards, types))
  writeTextFile(
    path.join(dir, 'TASK.md'),
    options.queueTasks && options.queueTasks.length > 0
      ? `# 任务清单\n\n${options.queueTasks
          .map((task, index) => `${index + 1}. [ ] ${task.title}\n\n${task.content}`)
          .join('\n\n')}\n`
      : `# 当前任务\n\n${config.task || defaultTask(config.name)}\n`,
  )
  const stateFile = path.join(dir, 'STATE.md')
  if (options.overwriteState || !exists(stateFile)) writeTextFile(stateFile, defaultState())
  const memoryDir = path.join(dir, 'memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  const memoryFile = path.join(memoryDir, 'MEMORY.md')
  if (options.overwriteMemory || !exists(memoryFile)) writeTextFile(memoryFile, defaultMemory())
  const readme = path.join(dir, 'README.md')
  if (!exists(readme)) {
    writeTextFile(
      readme,
      `# ${config.name} 的工作区

这个目录由 Blueprint Studio 的人员模块创建。

- AGENTS.md：身份、角色卡、规范、当前任务与工作协议（会话启动入口）
- PERSON.md：人设摘要
- TASK.md：当前任务记录（执行入口是 AGENTS.md）
- TASKS.json：任务队列状态回写文件（执行任务队列时生成）
- STATE.md：跨会话进度（请让执行会话持续更新）
- memory/：长期记忆

删除会话后重新执行时，会从 STATE.md 与 memory/ 续接之前的进度。
`,
    )
  }
}

function activeBundleDirs(loaded: LoadedPerson): string[] {
  const active = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  const dirs = [path.resolve(loaded.defaultWorkspace), active]
  return [...new Set(dirs)]
}

function clearContextFiles(dir: string): void {
  for (const name of ['AGENTS.md', 'PERSON.md', 'TASK.md', 'STATE.md', TASKS_JSON_NAME]) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(path.join(dir, 'memory'), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

/** 生成给 DSH 回写的任务状态文件 */
function writeQueueTasksFile(dir: string, queueId: string, tasks: PersonTask[]): void {
  writeJsonAtomic(path.join(dir, TASKS_JSON_NAME), {
    queueId,
    updatedAt: new Date().toISOString(),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      content: task.content,
      status: task.status,
      result: task.result ?? '',
      error: task.error ?? '',
    })),
  })
}

/** 任务看板结构变化后，把最新任务快照同步给 DSH 正在执行的 TASKS.json */
function mirrorTasksToQueueFile(loaded: LoadedPerson): void {
  const queue = readQueueStateRaw(loaded)
  if (queue.status !== 'running' && queue.status !== 'stopping') return
  const tasks = readTasks(loaded.profileDir)
  const ids = new Set(
    queue.taskIds ??
      tasks
        .filter((task) => task.status === 'pending' || task.status === 'running')
        .map((task) => task.id),
  )
  const queueTasks = tasks.filter((task) => ids.has(task.id))
  const workspace = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  writeQueueTasksFile(workspace, queue.queueId ?? '', queueTasks)
  queue.taskIds = queueTasks.map((task) => task.id)
  queue.total = queueTasks.length
  queue.completed = queueTasks.filter((task) => task.status === 'completed').length
  queue.failed = queueTasks.filter(
    (task) => task.status === 'failed' || task.status === 'stopped',
  ).length
  writeQueueState(loaded, queue)
  const run = readRunStateRaw(loaded)
  if (run.status === 'running' || run.status === 'stopping') {
    run.taskTitle = `任务队列（${queueTasks.length} 个任务）`
    writeRunState(loaded, run)
  }
}

/** 从工作区 TASKS.json 同步 DSH 自己写入的任务状态 */
function syncTasksFromWorkspace(loaded: LoadedPerson): PersonTask[] {
  const workspace = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  const file = path.join(workspace, TASKS_JSON_NAME)
  if (!exists(file)) return readTasks(loaded.profileDir)

  const raw = readJsonFile<unknown>(file, null)
  const list =
    Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
        ? (raw as { tasks: unknown[] }).tasks
        : []
  if (list.length === 0) return readTasks(loaded.profileDir)

  const allowed = new Set<PersonTaskStatus>([
    'pending',
    'running',
    'completed',
    'failed',
    'stopped',
  ])
  const remote = new Map<
    string,
    { status: PersonTaskStatus; result: string; error: string }
  >()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const o = item as { id?: unknown; status?: unknown; result?: unknown; error?: unknown }
    const id = str(o.id)
    const status = str(o.status) as PersonTaskStatus
    if (!id || !allowed.has(status)) continue
    remote.set(id, {
      status,
      result: str(o.result).slice(0, 20_000),
      error: str(o.error).slice(0, 2_000),
    })
  }
  if (remote.size === 0) return readTasks(loaded.profileDir)

  const tasks = readTasks(loaded.profileDir)
  const now = Date.now()
  let changed = false
  for (const task of tasks) {
    const next = remote.get(task.id)
    if (!next) continue
    if (next.status !== task.status) {
      task.status = next.status
      changed = true
      if (next.status === 'running') {
        task.startedAt = task.startedAt ?? now
        delete task.finishedAt
      } else if (next.status === 'pending') {
        delete task.startedAt
        delete task.finishedAt
        delete task.result
        delete task.error
      } else {
        task.startedAt = task.startedAt ?? now
        task.finishedAt = task.finishedAt ?? now
      }
    }
    if (next.result) {
      if (task.result !== next.result) {
        task.result = next.result
        changed = true
      }
    } else if (task.result && next.status === 'pending') {
      delete task.result
      changed = true
    }
    if (next.error) {
      if (task.error !== next.error) {
        task.error = next.error
        changed = true
      }
    } else if (task.error && next.status === 'pending') {
      delete task.error
      changed = true
    }
  }
  if (changed) writeTasks(loaded.profileDir, tasks)

  const queue = readQueueStateRaw(loaded)
  if (queue.status === 'running' || queue.status === 'stopping') {
    const queueIds = new Set(
      queue.taskIds && queue.taskIds.length > 0 ? queue.taskIds : [...remote.keys()],
    )
    const queueTasks = tasks.filter((task) => queueIds.has(task.id))
    if (queueTasks.length > 0) {
      queue.total = queueTasks.length
      queue.completed = queueTasks.filter((task) => task.status === 'completed').length
      queue.failed = queueTasks.filter(
        (task) => task.status === 'failed' || task.status === 'stopped',
      ).length
      const running = queueTasks.find((task) => task.status === 'running')
      if (running) {
        queue.currentTaskId = running.id
        queue.currentIndex = queueTasks.indexOf(running) + 1
      } else {
        delete queue.currentTaskId
        delete queue.currentIndex
      }
      writeQueueState(loaded, queue)
    }
  }
  return tasks
}

export interface WorkspaceBuildResult {
  workspaceDir: string
  moved: string[]
  skipped: string[]
  builtAt: number
}

function buildWorkspaceInternal(loaded: LoadedPerson): WorkspaceBuildResult {
  const types = loadTypes(path.dirname(loaded.personDir))
  const defaultWs = path.resolve(loaded.defaultWorkspace)
  const target = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  assertSafeWorkspaceTarget(loaded, target)
  if (exists(target) && !isDirectory(target)) {
    throw new FsError(400, `工作区不是目录：${target}`)
  }
  fs.mkdirSync(target, { recursive: true })
  if (!isDirectory(target)) throw new FsError(400, `工作区不是目录：${target}`)

  writeContextBundle(loaded, defaultWs, types)
  let moved: string[] = []
  let skipped: string[] = []
  if (target !== defaultWs) {
    const result = moveEntries(defaultWs, target, new Set([PROFILE_DIR_NAME]))
    moved = result.moved
    skipped = result.skipped
    writeContextBundle(loaded, target, types)
  }

  const builtAt = Date.now()
  loaded.config.workspace.builtAt = builtAt
  loaded.config.updatedAt = builtAt
  saveConfig(loaded)
  appendActivity(
    loaded.profileDir,
    'workspace_built',
    target === defaultWs ? '刷新了默认工作区' : `把默认工作区文件移动到 ${target}`,
  )
  return { workspaceDir: target, moved, skipped, builtAt }
}

/** 构建工作区：把默认工作区里除 .person 外的文件移动到设置的工作区 */
export function buildPersonWorkspace(id: string, root: string = resolvePeopleRoot()): WorkspaceBuildResult {
  const dir = ensurePeopleRoot(root)
  return buildWorkspaceInternal(loadPersonIdle(dir, id))
}

/** 重置工作区：清除 AGENTS / PERSON / TASK / STATE / memory，保留人员配置并重新播种 */
export async function resetPersonWorkspace(id: string, root: string = resolvePeopleRoot()): Promise<WorkspaceBuildResult> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonIdle(dir, id)
  const types = loadTypes(dir)
  const active = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  assertSafeWorkspaceTarget(loaded, active)
  const dirs = activeBundleDirs(loaded)
  for (const ws of dirs) clearContextFiles(ws)

  const run = readRunStateRaw(loaded)
  if (run.sessionId) {
    await agentGateway.deleteSession('dsh', run.sessionId).catch(() => undefined)
  }
  const idle: PersonRunState = { status: 'idle' }
  writeRunState(loaded, idle)
  writeQueueState(loaded, emptyQueueState())
  loaded.config.workspace = { ...loaded.config.workspace }
  delete loaded.config.workspace.builtAt
  loaded.config.updatedAt = Date.now()
  saveConfig(loaded)
  for (const ws of dirs) {
    fs.mkdirSync(ws, { recursive: true })
    writeContextBundle(loaded, ws, types, { overwriteState: true, overwriteMemory: true })
  }
  appendActivity(loaded.profileDir, 'workspace_reset', '重置了工作区')
  return {
    workspaceDir: active,
    moved: [],
    skipped: [],
    builtAt: 0,
  }
}

/* ============================================================
 * 记忆
 * ============================================================ */

const MEMORY_TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.log', '.yaml', '.yml'])

function walkMemoryFiles(dir: string, base: string, out: Array<{ name: string; file: string; size: number }>): void {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkMemoryFiles(file, base, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!MEMORY_TEXT_EXT.has(ext)) continue
    try {
      const stat = fs.statSync(file)
      if (stat.size > 2 * 1024 * 1024) continue
      out.push({ name: path.relative(base, file).split(path.sep).join('/'), file, size: stat.size })
    } catch {
      /* 忽略 */
    }
  }
}

function countMemoryLines(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('>') && !line.startsWith('<!--'))
    .length
}

function collectMemory(loaded: LoadedPerson, textLimit: number): PersonMemory {
  const dirs = activeBundleDirs(loaded).map((dir) => path.join(dir, 'memory'))
  const seen = new Set<string>()
  const files: PersonMemoryFile[] = []
  const chunks: string[] = []
  let count = 0
  let updatedAt = 0
  for (const memoryDir of [...new Set(dirs)]) {
    if (!isDirectory(memoryDir)) continue
    const found: Array<{ name: string; file: string; size: number }> = []
    walkMemoryFiles(memoryDir, memoryDir, found)
    for (const item of found) {
      const key = `${item.name}:${item.size}`
      if (seen.has(key)) continue
      seen.add(key)
      const text = readTextFile(item.file)
      if (!text.trim()) continue
      try {
        updatedAt = Math.max(updatedAt, fs.statSync(item.file).mtimeMs)
      } catch {
        /* 忽略 */
      }
      count += countMemoryLines(text)
      files.push({
        name: item.name,
        size: item.size,
        preview: text.slice(0, 400),
      })
      if (textLimit > 0) chunks.push(`## ${item.name}\n${text}`)
    }
  }
  const joined = chunks.join('\n\n')
  return {
    text: textLimit > 0 ? joined.slice(-textLimit) : '',
    files,
    count,
    ...(updatedAt > 0 ? { updatedAt } : {}),
  }
}

/** 清理工作区里的长期记忆 */
export function clearPersonMemory(id: string, root: string = resolvePeopleRoot()): PersonMemory {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonIdle(dir, id)
  for (const ws of activeBundleDirs(loaded)) {
    try {
      fs.rmSync(path.join(ws, 'memory'), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(path.join(loaded.profileDir, 'memory.json'), { force: true })
  } catch {
    /* 忽略 */
  }
  appendActivity(loaded.profileDir, 'memory_cleared', '清理了长期记忆')
  return collectMemory(loaded, 20_000)
}

/** 读取人员详情里的记忆快照 */
export function getPersonMemory(id: string, root: string = resolvePeopleRoot()): PersonMemory {
  const dir = ensurePeopleRoot(root)
  return collectMemory(loadPerson(dir, id), 20_000)
}

/* ============================================================
 * 头像
 * ============================================================ */

function avatarUrlFor(loaded: LoadedPerson): string {
  const file = str(loaded.config.avatarFile)
  if (!file) return ''
  const abs = path.join(loaded.profileDir, path.basename(file))
  if (!exists(abs)) return ''
  try {
    const version = Math.floor(fs.statSync(abs).mtimeMs)
    return `/api/personnel/${encodeURIComponent(loaded.id)}/avatar?v=${version}`
  } catch {
    return ''
  }
}

const AVATAR_MIME: Record<string, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' },
}

export interface AvatarPayload {
  avatarUrl: string
}

/** 保存头像（data URL 或 base64 + mime），写入 .person/avatar.* */
export function savePersonAvatar(
  id: string,
  root: string,
  body: Record<string, unknown>,
): AvatarPayload {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonIdle(dir, id)
  const dataUrl = str(body.dataUrl)
  let mime = str(body.mime).toLowerCase()
  let base64 = str(body.base64)
  if (dataUrl) {
    const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl)
    if (!match) throw new FsError(400, '头像必须是 base64 data URL（png / jpeg / webp / gif）')
    mime = match[1]!.toLowerCase()
    base64 = match[2]!
  }
  const info = AVATAR_MIME[mime === 'image/jpeg' ? 'jpeg' : mime.replace(/^image\//, '')]
  if (!info) throw new FsError(400, '头像格式只支持 png / jpeg / webp / gif')
  const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64')
  if (buffer.length === 0) throw new FsError(400, '头像内容为空')
  if (buffer.length > MAX_AVATAR_BYTES) throw new FsError(413, '头像不能超过 5MB')
  const filename = `avatar.${info.ext}`
  const target = path.join(loaded.profileDir, filename)
  const previous = str(loaded.config.avatarFile)
  fs.mkdirSync(loaded.profileDir, { recursive: true })
  fs.writeFileSync(target, buffer)
  if (previous && previous !== filename) {
    try {
      fs.rmSync(path.join(loaded.profileDir, path.basename(previous)), { force: true })
    } catch {
      /* 忽略 */
    }
  }
  loaded.config.avatarFile = filename
  loaded.config.updatedAt = Date.now()
  saveConfig(loaded)
  appendActivity(loaded.profileDir, 'avatar_changed', '更换了头像')
  return { avatarUrl: avatarUrlFor(loaded) }
}

/** 读取头像文件（供 GET /avatar 输出二进制） */
export function readPersonAvatar(
  id: string,
  root: string = resolvePeopleRoot(),
): { buffer: Buffer; mime: string } {
  const loaded = loadPerson(ensurePeopleRoot(root), id)
  const file = str(loaded.config.avatarFile)
  if (!file) throw new FsError(404, '没有设置头像')
  const abs = path.join(loaded.profileDir, path.basename(file))
  const ext = path.extname(abs).slice(1).toLowerCase()
  const info = AVATAR_MIME[ext === 'jpg' ? 'jpeg' : ext]
  if (!info) throw new FsError(404, '头像文件不存在')
  try {
    return { buffer: fs.readFileSync(abs), mime: info.mime }
  } catch {
    throw new FsError(404, '头像文件不存在')
  }
}

/* ============================================================
 * 运行状态
 * ============================================================ */

/** 本进程内正在执行的人员（personId → runId / starting） */
const activeRuns = new Map<string, string>()
/** 本进程内正在跑队列的人员（personId → queueId） */
const activeQueues = new Map<string, string>()

function runStatePathOf(personDir: string): string {
  return path.join(personDir, 'run.json')
}

function normalizeRunState(raw: unknown): PersonRunState {
  if (raw === null || typeof raw !== 'object') return { status: 'idle' }
  const o = raw as Partial<PersonRunState>
  const allowed = new Set(['idle', 'running', 'stopping', 'completed', 'failed', 'stopped'])
  return {
    status: allowed.has(str(o.status)) ? (str(o.status) as PersonRunState['status']) : 'idle',
    ...(str(o.runId) ? { runId: str(o.runId) } : {}),
    ...(str(o.taskId) ? { taskId: str(o.taskId) } : {}),
    ...(str(o.taskTitle) ? { taskTitle: str(o.taskTitle) } : {}),
    ...(str(o.sessionId) ? { sessionId: str(o.sessionId) } : {}),
    ...(str(o.sessionTitle) ? { sessionTitle: str(o.sessionTitle) } : {}),
    ...(num(o.startedAt) > 0 ? { startedAt: num(o.startedAt) } : {}),
    ...(num(o.finishedAt) > 0 ? { finishedAt: num(o.finishedAt) } : {}),
    ...(str(o.lastReply) ? { lastReply: str(o.lastReply) } : {}),
    ...(str(o.error) ? { error: str(o.error) } : {}),
    ...(str(o.workspaceDir) ? { workspaceDir: str(o.workspaceDir) } : {}),
  }
}

function readRunStateRaw(loaded: LoadedPerson): PersonRunState {
  return normalizeRunState(readJsonFile<unknown>(runStatePathOf(loaded.personDir), null))
}

function writeRunState(loaded: LoadedPerson, run: PersonRunState): void {
  writeJsonAtomic(runStatePathOf(loaded.personDir), run)
}

function readRunState(loaded: LoadedPerson): PersonRunState {
  const run = readRunStateRaw(loaded)
  if (
    (run.status === 'running' || run.status === 'stopping') &&
    activeRuns.get(loaded.id) !== run.runId
  ) {
    if (run.sessionId) {
      void agentGateway.cancelSession('dsh', run.sessionId).catch(() => undefined)
    }
    const stopped: PersonRunState = {
      ...run,
      status: 'stopped',
      finishedAt: Date.now(),
      error: '服务重启或执行已中断',
    }
    writeRunState(loaded, stopped)
    appendStateNote(loaded, stopped, '- 状态：已中断\n- 原因：服务重启或执行状态丢失')
    appendActivity(loaded.profileDir, 'run_stopped', '服务重启，执行已中断')
    return stopped
  }
  return run
}

function readQueueState(loaded: LoadedPerson): PersonQueueState {
  const queue = readQueueStateRaw(loaded)
  if (
    (queue.status === 'running' || queue.status === 'stopping') &&
    activeQueues.get(loaded.id) !== queue.queueId
  ) {
    const now = Date.now()
    const tasks = readTasks(loaded.profileDir)
    let interrupted = 0
    for (const task of tasks) {
      if (task.status !== 'running') continue
      task.status = 'failed'
      task.finishedAt = now
      task.error = '服务重启，任务中断'
      interrupted += 1
    }
    writeTasks(loaded.profileDir, tasks)
    const stopped: PersonQueueState = {
      ...queue,
      status: 'stopped',
      failed: queue.failed + interrupted,
      finishedAt: now,
      error: '服务重启或队列执行中断',
    }
    delete stopped.currentTaskId
    delete stopped.currentIndex
    writeQueueState(loaded, stopped)
    appendActivity(loaded.profileDir, 'queue_stopped', '服务重启，任务队列已中断')
    return stopped
  }
  return queue
}

function assertNotRunning(id: string): void {
  if (activeRuns.has(id) || activeQueues.has(id)) {
    throw new FsError(409, '人员正在执行中，请先停止后再操作')
  }
}

/* ============================================================
 * 列表 / 详情 / CRUD
 * ============================================================ */

function toSummary(loaded: LoadedPerson): PersonSummary {
  const queueBefore = readQueueState(loaded)
  const tasks =
    queueBefore.status === 'running' || queueBefore.status === 'stopping'
      ? syncTasksFromWorkspace(loaded)
      : readTasks(loaded.profileDir)
  const queue = readQueueStateRaw(loaded)
  const run = readRunState(loaded)
  const memory = collectMemory(loaded, 0)
  return {
    id: loaded.id,
    name: loaded.config.name,
    typeId: loaded.config.typeId,
    avatarUrl: avatarUrlFor(loaded),
    createdAt: loaded.config.createdAt,
    updatedAt: loaded.config.updatedAt,
    defaultWorkspace: path.resolve(loaded.defaultWorkspace),
    activeWorkspace: resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace),
    roleCardCount: loaded.cards.length,
    memoryCount: memory.count,
    stats: { ...loaded.config.stats },
    run,
    queue,
    taskCounts: taskCountsOf(tasks),
  }
}

/** 人员列表 */
export function listPeople(root: string = resolvePeopleRoot()): PersonSummary[] {
  const dir = ensurePeopleRoot(root)
  const out: PersonSummary[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue
    const loaded = tryLoadPerson(dir, id)
    if (!loaded) continue
    out.push(toSummary(loaded))
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}

/** 人员详情 */
export function getPerson(id: string, root: string = resolvePeopleRoot()): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPerson(dir, id)
  return {
    ...toSummary(loaded),
    config: loaded.config,
    cards: loaded.cards,
    norms: loaded.norms,
    tasks: readTasks(loaded.profileDir),
    memory: collectMemory(loaded, 20_000),
    activity: readActivity(loaded.profileDir),
  }
}

export interface CreatePersonInput {
  name: string
  typeId?: string
}

/** 新建人员：同步创建默认工作区与配置 */
export function createPerson(root: string, input: CreatePersonInput): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const name = sanitizeName(input.name)
  const types = loadTypes(dir)
  const typeId =
    input.typeId && types.some((t) => t.id === input.typeId) ? input.typeId : (types[0]?.id ?? '')
  const typeName = typeNameOf(types, typeId)
  const id = newPersonId()
  const personDir = personDirOf(dir, id)
  const defaultWorkspace = path.join(personDir, DEFAULT_WORKSPACE_NAME)
  const profileDir = path.join(defaultWorkspace, PROFILE_DIR_NAME)
  fs.mkdirSync(profileDir, { recursive: true })
  const now = Date.now()
  const config: PersonConfig = normalizeConfig(
    {
      id,
      name,
      typeId,
      createdAt: now,
      updatedAt: now,
      task: defaultTask(name),
      model: { platform: 'dsh', model: '', reasoning: '', permission: '' },
      workspace: {
        dir: '',
        sessionTitle: '',
        deleteSessionAfterRun: false,
        reuseSession: true,
      },
      stats: { runs: 0, completed: 0, failed: 0 },
    },
    id,
  )
  const cards = defaultCards(name, typeName)
  config.currentCardId = cards[0]?.id
  const norms = defaultNorms()
  writeJsonAtomic(configPathOf(profileDir), config)
  writeJsonAtomic(cardsPathOf(profileDir), cards)
  writeTextFile(normsPathOf(profileDir), norms)
  writeJsonAtomic(tasksPathOf(profileDir), [])
  writeJsonAtomic(queuePathOf(personDir), emptyQueueState())
  writeJsonAtomic(runStatePathOf(personDir), { status: 'idle' })
  const loaded: LoadedPerson = { id, personDir, defaultWorkspace, profileDir, config, cards, norms }
  writeContextBundle(loaded, defaultWorkspace, types)
  appendActivity(profileDir, 'person_created', `新建了人员「${name}」`)
  return getPerson(id, dir)
}

export interface UpdatePersonInput {
  name?: string
  typeId?: string
  task?: string
  currentCardId?: string
  cards?: unknown
  norms?: string
  model?: Partial<PersonModelSettings>
  workspace?: Partial<PersonWorkspaceSettings>
}

/** 更新人员配置（名称 / 类型 / 任务 / 角色卡 / 规范 / 模型 / 工作区） */
export function updatePerson(id: string, root: string, input: UpdatePersonInput): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonIdle(dir, id)
  const types = loadTypes(dir)
  const now = Date.now()
  const activity: string[] = []

  if (input.name !== undefined) {
    const name = sanitizeName(input.name)
    if (name !== loaded.config.name) {
      loaded.config.name = name
      activity.push(`名称改为「${name}」`)
    }
  }
  if (input.typeId !== undefined) {
    const typeId = str(input.typeId)
    if (typeId && !types.some((t) => t.id === typeId)) throw new FsError(400, '人员类型不存在')
    if (typeId !== loaded.config.typeId) {
      loaded.config.typeId = typeId
      activity.push(`类型改为「${typeNameOf(types, typeId) || '未分类'}」`)
    }
  }
  if (input.task !== undefined) {
    const task = str(input.task).slice(0, MAX_TASK_LENGTH)
    if (task !== loaded.config.task) {
      loaded.config.task = task
      activity.push('更新了当前任务')
    }
  }
  if (input.cards !== undefined) {
    loaded.cards = sanitizeCards(input.cards)
    writeJsonAtomic(cardsPathOf(loaded.profileDir), loaded.cards)
    activity.push('更新了角色卡')
  }
  if (input.currentCardId !== undefined) {
    const cardId = str(input.currentCardId)
    if (cardId && !loaded.cards.some((card) => card.id === cardId)) {
      throw new FsError(400, '当前角色卡不存在')
    }
    loaded.config.currentCardId = cardId || loaded.cards[0]?.id
    activity.push('切换了当前角色卡')
  }
  if (
    loaded.cards.length > 0 &&
    (!loaded.config.currentCardId ||
      !loaded.cards.some((card) => card.id === loaded.config.currentCardId))
  ) {
    loaded.config.currentCardId = loaded.cards[0]!.id
  }
  if (input.norms !== undefined) {
    loaded.norms = normalizeNormsToBracket(str(input.norms).slice(0, MAX_NORMS_LENGTH))
    writeTextFile(normsPathOf(loaded.profileDir), loaded.norms)
    activity.push('更新了规范')
  }
  if (input.model !== undefined) {
    if (input.model === null || typeof input.model !== 'object' || Array.isArray(input.model)) {
      throw new FsError(400, 'model 必须是对象')
    }
    const model: Partial<PersonModelSettings> = input.model
    const platform = str(model.platform) || loaded.config.model.platform
    if (!(PERSON_PLATFORMS as readonly string[]).includes(platform)) {
      throw new FsError(400, `平台必须为：${PERSON_PLATFORMS.join(' | ')}`)
    }
    loaded.config.model = {
      platform: platform as PersonModelSettings['platform'],
      model: model.model !== undefined ? str(model.model) : loaded.config.model.model,
      reasoning: model.reasoning !== undefined ? str(model.reasoning) : loaded.config.model.reasoning,
      permission: model.permission !== undefined ? str(model.permission) : loaded.config.model.permission,
    }
    activity.push('更新了模型设置')
  }
  if (input.workspace !== undefined) {
    if (input.workspace === null || typeof input.workspace !== 'object' || Array.isArray(input.workspace)) {
      throw new FsError(400, 'workspace 必须是对象')
    }
    const workspace: Partial<PersonWorkspaceSettings> = input.workspace
    if (workspace.dir !== undefined) {
      const nextDir = validateWorkspaceSetting(workspace.dir)
      if (nextDir !== loaded.config.workspace.dir) {
        loaded.config.workspace.dir = nextDir
        delete loaded.config.workspace.builtAt
      }
      if (loaded.config.workspace.dir) {
        assertSafeWorkspaceTarget(loaded, loaded.config.workspace.dir)
      }
    }
    if (workspace.sessionTitle !== undefined) {
      loaded.config.workspace.sessionTitle = str(workspace.sessionTitle).slice(0, 120)
    }
    if (workspace.deleteSessionAfterRun !== undefined) {
      loaded.config.workspace.deleteSessionAfterRun = workspace.deleteSessionAfterRun === true
    }
    if (workspace.reuseSession !== undefined) {
      loaded.config.workspace.reuseSession = workspace.reuseSession !== false
    }
    activity.push('更新了工作区设置')
  }

  loaded.config.updatedAt = now
  saveConfig(loaded)
  const active = resolveActiveWorkspace(loaded.config, loaded.defaultWorkspace)
  const defaultWs = path.resolve(loaded.defaultWorkspace)
  const shouldRefreshActive =
    path.resolve(active) === defaultWs ||
    exists(path.join(active, 'AGENTS.md'))
  if (shouldRefreshActive) writeContextBundle(loaded, active, types)
  if (path.resolve(active) !== defaultWs) {
    writeContextBundle(loaded, loaded.defaultWorkspace, types)
  }
  for (const text of activity) appendActivity(loaded.profileDir, 'settings_saved', text)
  return getPerson(id, dir)
}

export interface AddTaskInput {
  title?: string
  content: string
}

/** 向任务看板添加任务（只入列，不执行） */
export function addPersonTask(id: string, root: string, input: AddTaskInput): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonForTaskEdit(dir, id)
  const content = str(input.content).trim()
  if (!content) throw new FsError(400, '任务内容不能为空')
  const tasks = readTasks(loaded.profileDir)
  const task: PersonTask = {
    id: newRecordId('task'),
    title: str(input.title).trim().slice(0, 120) || taskTitleFromContent(content),
    content: content.slice(0, MAX_TASK_LENGTH),
    status: 'pending',
    createdAt: Date.now(),
  }
  tasks.push(task)
  writeTasks(loaded.profileDir, tasks)
  const queue = readQueueStateRaw(loaded)
  if (queue.status === 'running' || queue.status === 'stopping') {
    if (!queue.taskIds) {
      queue.taskIds = tasks
        .filter((item) => item.status === 'pending' || item.status === 'running')
        .map((item) => item.id)
    }
    if (!queue.taskIds.includes(task.id)) queue.taskIds.push(task.id)
    queue.total = queue.taskIds.length
    writeQueueState(loaded, queue)
    mirrorTasksToQueueFile(loaded)
  }
  appendActivity(loaded.profileDir, 'task_added', `添加任务「${task.title}」`)
  return getPerson(id, dir)
}

/** 删除一条任务（执行中的任务不可删除） */
export function deletePersonTask(id: string, root: string, taskId: string): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonForTaskEdit(dir, id)
  const tasks = readTasks(loaded.profileDir)
  const target = tasks.find((task) => task.id === taskId)
  if (!target) throw new FsError(404, '任务不存在')
  if (target.status === 'running') throw new FsError(409, '任务正在执行，不能删除')
  writeTasks(
    loaded.profileDir,
    tasks.filter((task) => task.id !== taskId),
  )
  const queue = readQueueStateRaw(loaded)
  if (queue.taskIds) {
    queue.taskIds = queue.taskIds.filter((item) => item !== taskId)
    queue.total = queue.taskIds.length
    writeQueueState(loaded, queue)
  }
  mirrorTasksToQueueFile(loaded)
  appendActivity(loaded.profileDir, 'task_deleted', `删除任务「${target.title}」`)
  return getPerson(id, dir)
}

/** 调整待执行任务的顺序（只在 pending 任务之间交换） */
export function movePersonTask(
  id: string,
  root: string,
  taskId: string,
  direction: 'up' | 'down',
): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonForTaskEdit(dir, id)
  const tasks = readTasks(loaded.profileDir)
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) throw new FsError(404, '任务不存在')
  if (tasks[index]!.status !== 'pending') throw new FsError(400, '只能调整待执行任务的顺序')
  let swapIndex = -1
  const step = direction === 'up' ? -1 : 1
  for (let i = index + step; i >= 0 && i < tasks.length; i += step) {
    if (tasks[i]!.status === 'pending') {
      swapIndex = i
      break
    }
  }
  if (swapIndex >= 0) {
    const [task] = tasks.splice(index, 1)
    tasks.splice(swapIndex, 0, task!)
    writeTasks(loaded.profileDir, tasks)
    mirrorTasksToQueueFile(loaded)
  }
  return getPerson(id, dir)
}

/** 失败 / 停止的任务重新放回待执行队列 */
export function retryPersonTask(id: string, root: string, taskId: string): PersonDetail {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonForTaskEdit(dir, id)
  const tasks = readTasks(loaded.profileDir)
  const target = tasks.find((task) => task.id === taskId)
  if (!target) throw new FsError(404, '任务不存在')
  if (target.status !== 'failed' && target.status !== 'stopped') {
    throw new FsError(400, '只有失败或已停止的任务可以重试')
  }
  target.status = 'pending'
  delete target.startedAt
  delete target.finishedAt
  delete target.result
  delete target.error
  writeTasks(loaded.profileDir, tasks)
  const queue = readQueueStateRaw(loaded)
  if (queue.status === 'running' || queue.status === 'stopping') {
    if (!queue.taskIds) {
      queue.taskIds = tasks
        .filter((item) => item.status === 'pending' || item.status === 'running')
        .map((item) => item.id)
    }
    if (!queue.taskIds.includes(target.id)) queue.taskIds.push(target.id)
    queue.total = queue.taskIds.length
    writeQueueState(loaded, queue)
    mirrorTasksToQueueFile(loaded)
  }
  appendActivity(loaded.profileDir, 'task_retried', `重新排队任务「${target.title}」`)
  return getPerson(id, dir)
}

/** 删除人员（默认工作区随人员目录删除；外部工作区不会删除） */
export async function deletePerson(id: string, root: string = resolvePeopleRoot()): Promise<void> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPersonIdle(dir, id)
  const run = readRunStateRaw(loaded)
  if (run.sessionId) {
    await agentGateway.deleteSession('dsh', run.sessionId).catch(() => undefined)
  }
  fs.rmSync(loaded.personDir, { recursive: true, force: true })
}

/* ============================================================
 * 执行 / 停止
 * ============================================================ */

/** 启动任务队列：按任务看板顺序依次执行所有 pending 任务 */
export async function runPerson(id: string, root: string = resolvePeopleRoot()): Promise<PersonQueueState> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPerson(dir, id)
  readQueueState(loaded)
  readRunState(loaded)
  assertNotRunning(id)
  const tasks = readTasks(loaded.profileDir)
  const pending = tasks.filter((task) => task.status === 'pending')
  if (pending.length === 0) throw new FsError(400, '没有待执行的任务，请先在任务看板中发布任务')

  const queue: PersonQueueState = {
    status: 'running',
    queueId: newRecordId('queue'),
    taskIds: pending.map((task) => task.id),
    total: pending.length,
    completed: 0,
    failed: 0,
    startedAt: Date.now(),
  }
  activeQueues.set(id, queue.queueId!)
  writeQueueState(loaded, queue)
  appendActivity(loaded.profileDir, 'queue_started', `开始执行任务队列（${pending.length} 个）`)
  void processQueue(id, dir, queue.queueId!)
  return queue
}

/** 队列执行器：一个 DSH 会话执行 AGENTS.md 的整张任务清单，状态由 DSH 回写 TASKS.json */
async function processQueue(id: string, root: string, queueId: string): Promise<void> {
  const loaded = loadPerson(root, id)
  const types = loadTypes(root)
  try {
    const build = buildWorkspaceInternal(loaded)
    const target = build.workspaceDir
    const queueTasks = readTasks(loaded.profileDir).filter((task) => task.status === 'pending')
    if (queueTasks.length === 0) {
      const queue = readQueueStateRaw(loaded)
      queue.status = 'completed'
      queue.completed = 0
      queue.failed = 0
      queue.finishedAt = Date.now()
      delete queue.currentTaskId
      delete queue.currentIndex
      writeQueueState(loaded, queue)
      appendActivity(loaded.profileDir, 'queue_completed', '任务队列没有待执行任务')
      return
    }

    writeQueueTasksFile(target, queueId, queueTasks)
    writeContextBundle(loaded, target, types, { queueTasks })
    writeContextBundle(loaded, loaded.defaultWorkspace, types, { queueTasks })

    let sessionId = ''
    let sessionTitle = ''
    const previous = readRunState(loaded)
    if (
      loaded.config.workspace.reuseSession &&
      previous.sessionId &&
      previous.workspaceDir === target &&
      !isSessionArchived(previous.sessionId)
    ) {
      const status = await agentGateway.sessionStatus('dsh', previous.sessionId).catch(() => null)
      if (status && !status.running) {
        sessionId = previous.sessionId
        sessionTitle = previous.sessionTitle ?? ''
      }
    }
    if (!sessionId) {
      const title =
        loaded.config.workspace.sessionTitle.trim() ||
        `${loaded.config.name} · 任务队列（${queueTasks.length} 个任务）`
      const session = await agentGateway.createSession('dsh', personProjectKey(id), {
        title,
        cwd: target,
        model: loaded.config.model.model,
        reasoning: loaded.config.model.reasoning,
        permissions: loaded.config.model.permission,
        reuse: false,
      })
      sessionId = session.sessionId
      sessionTitle = session.title
    }

    const startedAt = Date.now()
    const runId = newRecordId('run')
    const run: PersonRunState = {
      status: 'running',
      runId,
      taskTitle: `任务队列（${queueTasks.length} 个任务）`,
      sessionId,
      sessionTitle,
      startedAt,
      workspaceDir: target,
    }
    activeRuns.set(id, runId)
    writeRunState(loaded, run)
    loaded.config.stats.runs += queueTasks.length
    loaded.config.stats.lastRunAt = startedAt
    loaded.config.updatedAt = startedAt
    saveConfig(loaded)
    appendActivity(
      loaded.profileDir,
      'run_started',
      `开始执行任务队列（${queueTasks.length} 个任务）`,
    )

    let reply = ''
    let outcome: 'completed' | 'failed' | 'stopped' = 'failed'
    let error = ''
    try {
      const result = await agentGateway.sendMessage({
        platform: 'dsh',
        project: personProjectKey(id),
        sessionId,
        message: PERSON_STARTUP_PROMPT,
        model: loaded.config.model.model || undefined,
        reasoning: loaded.config.model.reasoning || undefined,
        permissions: loaded.config.model.permission || undefined,
        waitForCompletion: true,
        timeoutSec: RUN_TIMEOUT_SEC,
      })
      reply = result.reply
      const after = readQueueStateRaw(loaded)
      if (after.status === 'stopping' || after.status === 'stopped') {
        outcome = 'stopped'
      } else {
        const synced = syncTasksFromWorkspace(loaded)
        const queueIds = new Set(queueTasks.map((task) => task.id))
        const queueSynced = synced.filter((task) => queueIds.has(task.id))
        const unresolved = queueSynced.filter(
          (task) => task.status === 'pending' || task.status === 'running',
        )
        if (unresolved.length > 0) {
          outcome = 'failed'
          error = `智能体未完整回写 TASKS.json 任务状态（剩余 ${unresolved.length} 个）`
        } else {
          outcome = 'completed'
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      const after = readQueueStateRaw(loaded)
      outcome = after.status === 'stopping' || after.status === 'stopped' ? 'stopped' : 'failed'
    }

    let tasks = syncTasksFromWorkspace(loaded)
    const queueState = readQueueStateRaw(loaded)
    const queueIds = new Set(
      queueState.taskIds && queueState.taskIds.length > 0
        ? queueState.taskIds
        : queueTasks.map((task) => task.id),
    )
    let statusChanged = false
    for (const task of tasks) {
      if (!queueIds.has(task.id)) continue
      if (outcome === 'stopped' && task.status === 'running') {
        task.status = 'stopped'
        task.finishedAt = task.finishedAt ?? Date.now()
        task.error = '已手动停止'
        statusChanged = true
      } else if (outcome === 'failed' && task.status === 'running') {
        task.status = 'failed'
        task.finishedAt = task.finishedAt ?? Date.now()
        task.error = error || '任务队列失败'
        statusChanged = true
      }
    }
    if (statusChanged) writeTasks(loaded.profileDir, tasks)

    const queueSynced = tasks.filter((task) => queueIds.has(task.id))
    const completed = queueSynced.filter((task) => task.status === 'completed').length
    const failed = queueSynced.filter(
      (task) => task.status === 'failed' || task.status === 'stopped',
    ).length
    const unresolved = queueSynced.filter(
      (task) => task.status === 'pending' || task.status === 'running',
    ).length
    if (outcome === 'completed' && unresolved > 0) {
      outcome = 'failed'
      error = error || `智能体未完整回写 TASKS.json 任务状态（剩余 ${unresolved} 个）`
    }

    const finishedAt = Date.now()
    const queue = queueState
    queue.status = outcome
    queue.total = queueSynced.length
    queue.completed = completed
    queue.failed = failed
    queue.finishedAt = finishedAt
    if (outcome === 'stopped') queue.error = '已手动停止'
    else if (error) queue.error = error
    else delete queue.error
    delete queue.currentTaskId
    delete queue.currentIndex
    writeQueueState(loaded, queue)

    const runAfter = readRunStateRaw(loaded)
    if (runAfter.runId === runId) {
      const nextRun: PersonRunState = {
        ...runAfter,
        status: outcome,
        taskTitle: `任务队列（${queueSynced.length} 个任务）`,
        finishedAt,
        ...(reply ? { lastReply: reply.slice(0, 20_000) } : {}),
        ...(error ? { error } : outcome === 'stopped' ? { error: '已手动停止' } : {}),
      }
      writeRunState(loaded, nextRun)
      appendStateNote(
        loaded,
        nextRun,
        `- 状态：${
          outcome === 'completed' ? '队列完成' : outcome === 'stopped' ? '队列已停止' : '队列失败'
        }\n- 任务：${queueSynced.length} 个（成功 ${completed} / 失败 ${failed}）${
          error ? `\n- 错误：${error.slice(0, 1200)}` : ''
        }`,
      )
    }
    loaded.config.stats.completed += completed
    loaded.config.stats.failed += failed
    loaded.config.updatedAt = finishedAt
    saveConfig(loaded)
    appendActivity(
      loaded.profileDir,
      outcome === 'completed' ? 'queue_completed' : outcome === 'stopped' ? 'queue_stopped' : 'queue_failed',
      outcome === 'completed'
        ? `任务队列完成（成功 ${completed} / 失败 ${failed}）`
        : outcome === 'stopped'
          ? '任务队列已停止'
          : `任务队列失败：${error || '未知错误'}`,
    )
    if (outcome !== 'stopped' && loaded.config.workspace.deleteSessionAfterRun && sessionId) {
      await agentGateway.deleteSession('dsh', sessionId).catch(() => undefined)
      appendActivity(loaded.profileDir, 'session_archived', '已按设置归档任务队列会话')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const current = readQueueStateRaw(loaded)
    if (current.queueId === queueId) {
      current.status = 'failed'
      current.finishedAt = Date.now()
      current.error = message
      delete current.currentTaskId
      delete current.currentIndex
      writeQueueState(loaded, current)
      appendActivity(loaded.profileDir, 'queue_failed', `任务队列异常：${message}`)
    }
  } finally {
    if (activeQueues.get(id) === queueId) activeQueues.delete(id)
    activeRuns.delete(id)
  }
}

/** 停止任务队列：取消当前任务，剩余 pending 任务保留 */
export async function stopPerson(id: string, root: string = resolvePeopleRoot()): Promise<PersonQueueState> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPerson(dir, id)
  const queue = readQueueState(loaded)
  if (queue.status !== 'running' && queue.status !== 'stopping') return queue
  const stopping: PersonQueueState = { ...queue, status: 'stopping' }
  writeQueueState(loaded, stopping)
  const run = readRunStateRaw(loaded)
  if (run.status === 'running') {
    writeRunState(loaded, { ...run, status: 'stopping' })
  }
  if (run.sessionId) {
    await agentGateway.cancelSession('dsh', run.sessionId).catch(() => undefined)
  }
  return stopping
}

function cleanModelText(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*\r?\n/, '')
    .replace(/\r?\n```\s*$/, '')
    .trim()
}

/** 用人员当前模型跑一次纯文本任务（不读任务看板、不改工作区） */
async function runOneOffModel(
  loaded: LoadedPerson,
  title: string,
  prompt: string,
  timeoutSec = 180,
): Promise<string> {
  const workDir = path.join(loaded.profileDir, '.ai-tmp')
  fs.mkdirSync(workDir, { recursive: true })
  const session = await agentGateway.createSession('dsh', personProjectKey(loaded.id), {
    title: `${loaded.config.name} · ${title}`,
    cwd: workDir,
    model: loaded.config.model.model,
    reasoning: loaded.config.model.reasoning,
    permissions: loaded.config.model.permission,
    reuse: false,
  })
  try {
    const { reply } = await agentGateway.sendMessage({
      platform: 'dsh',
      project: personProjectKey(loaded.id),
      sessionId: session.sessionId,
      message: prompt,
      model: loaded.config.model.model || undefined,
      reasoning: loaded.config.model.reasoning || undefined,
      permissions: loaded.config.model.permission || undefined,
      waitForCompletion: true,
      timeoutSec,
    })
    const text = cleanModelText(reply)
    if (!text) throw new Error('模型没有返回内容')
    return text
  } finally {
    await agentGateway.deleteSession('dsh', session.sessionId).catch(() => undefined)
  }
}

export interface PolishPersonTextInput {
  kind: 'card' | 'norms'
  title?: string
  text: string
  others?: string[]
}

/** AI 润色角色卡 / 规范的一节，使用人员当前模型设置 */
export async function polishPersonText(
  id: string,
  root: string,
  input: PolishPersonTextInput,
): Promise<string> {
  const loaded = loadPersonIdle(ensurePeopleRoot(root), id)
  const kind = input.kind === 'norms' ? '工作规范' : '角色卡'
  const title = str(input.title).trim()
  const text = str(input.text).trim()
  const others = Array.isArray(input.others)
    ? input.others
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, 20)
        .join('、')
    : ''
  const titled = title && title !== '开场' && title !== '前言' ? `「${title}」` : ''
  const source =
    text || `（该小节还没有内容，请根据标题${titled || '当前小节'}写一版符合角色与规范的正文）`
  const prompt = `你是一个人员配置文本润色助手。
请润色下面的${kind}${titled}。

人员：${loaded.config.name}
其他小节：${others || '无'}

要求：
- 保留原意与事实，不要编造不存在的经历、技能或规则。
- 保持原文人称与叙述视角，不要把「你」改成「我」。
- 角色卡要更像具体的人设与职责描述；规范要更清晰、可执行。
- 只输出润色后的正文，不要输出标题、解释、序号或代码块。

${source}`
  try {
    return await runOneOffModel(loaded, `${kind}润色`, prompt, 180)
  } catch (err) {
    throw new FsError(502, `AI 润色失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 用模型合并、去重并整理长期记忆；旧文件移入 memory/.archive */
export async function organizePersonMemory(
  id: string,
  root: string = resolvePeopleRoot(),
): Promise<PersonMemory> {
  const loaded = loadPersonIdle(ensurePeopleRoot(root), id)
  const memory = collectMemory(loaded, 30_000)
  if (!memory.text.trim()) throw new FsError(400, '没有可整理的记忆')
  const prompt = `请整理下面的长期记忆。

人员：${loaded.config.name}

要求：
- 去重、合并表达同一件事的记忆。
- 按主题分组，保留重要事实、偏好、决定和未完成事项。
- 删除明显过时、重复、无价值的内容；不要编造新事实。
- 输出整理后的 Markdown，只输出正文，不要解释或代码块。

${memory.text}`
  let text = ''
  try {
    text = await runOneOffModel(loaded, '整理记忆', prompt, 240)
  } catch (err) {
    throw new FsError(502, `整理记忆失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!text.trim()) throw new FsError(502, '整理记忆失败：模型没有返回内容')

  for (const workspace of activeBundleDirs(loaded)) {
    const memoryDir = path.join(workspace, 'memory')
    fs.mkdirSync(memoryDir, { recursive: true })
    const archiveDir = path.join(
      memoryDir,
      '.archive',
      new Date().toISOString().replace(/[:.]/g, '-'),
    )
    for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
      if (entry.name === '.archive') continue
      fs.mkdirSync(archiveDir, { recursive: true })
      movePathDeep(path.join(memoryDir, entry.name), path.join(archiveDir, entry.name))
    }
    writeTextFile(path.join(memoryDir, 'MEMORY.md'), text.endsWith('\n') ? text : `${text}\n`)
  }
  appendActivity(loaded.profileDir, 'memory_organized', '用模型整理了长期记忆')
  return collectMemory(loaded, 20_000)
}

/* ============================================================
 * HTTP 路由
 * ============================================================ */

export interface PersonnelHttpDeps {
  req: IncomingMessage
  res: ServerResponse
  pathname: string
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void
  peopleRoot?: string
}

function sendAvatar(res: ServerResponse, id: string, root: string): void {
  const { buffer, mime } = readPersonAvatar(id, root)
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

/**
 * 人员 HTTP 路由（由 server/index.ts 在 API 分发处调用）。
 * 返回 true 表示已处理；false 表示不是人员路由。
 */
export async function handlePersonnelRequest(deps: PersonnelHttpDeps): Promise<boolean> {
  const { req, res, pathname, readJson, sendJson } = deps
  if (pathname !== '/api/personnel' && !pathname.startsWith('/api/personnel/')) return false
  const root = ensurePeopleRoot(deps.peopleRoot ?? resolvePeopleRoot())
  const method = req.method ?? 'GET'
  const rest = pathname.slice('/api/personnel'.length).replace(/\/+$/, '')
  const segments = rest
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, people: listPeople(root), types: loadTypes(root) })
      return true
    }
    if (method === 'POST') {
      const body = await readJson(req)
      const person = createPerson(root, {
        name: str(body.name),
        ...(str(body.typeId) ? { typeId: str(body.typeId) } : {}),
      })
      sendJson(res, 201, { ok: true, person })
      return true
    }
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
    return true
  }

  if (segments[0] === 'types' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, types: loadTypes(root) })
      return true
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(req)
      const types = saveTypes(root, body.types)
      sendJson(res, 200, { ok: true, types })
      return true
    }
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
    return true
  }

  const id = assertSafePersonId(segments[0]!)
  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, person: getPerson(id, root) })
      return true
    }
    if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
      const body = await readJson(req)
      const person = updatePerson(id, root, body as UpdatePersonInput)
      sendJson(res, 200, { ok: true, person })
      return true
    }
    if (method === 'DELETE') {
      await deletePerson(id, root)
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
    return true
  }

  const action = segments.slice(1).join('/')
  if (action === 'tasks' && method === 'POST') {
    const body = await readJson(req)
    const person = addPersonTask(id, root, {
      title: str(body.title),
      content: str(body.content),
    })
    sendJson(res, 201, { ok: true, person })
    return true
  }
  if (segments[1] === 'tasks' && segments.length >= 3) {
    const taskId = assertSafePersonId(segments[2]!)
    if (segments.length === 3 && method === 'DELETE') {
      sendJson(res, 200, { ok: true, person: deletePersonTask(id, root, taskId) })
      return true
    }
    if (segments.length === 4 && segments[3] === 'move' && method === 'POST') {
      const body = await readJson(req)
      const direction = str(body.direction) === 'up' ? 'up' : 'down'
      sendJson(res, 200, { ok: true, person: movePersonTask(id, root, taskId, direction) })
      return true
    }
    if (segments.length === 4 && segments[3] === 'retry' && method === 'POST') {
      sendJson(res, 200, { ok: true, person: retryPersonTask(id, root, taskId) })
      return true
    }
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
    return true
  }
  if (action === 'avatar') {
    if (method === 'GET') {
      sendAvatar(res, id, root)
      return true
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await readJson(req)
      sendJson(res, 200, { ok: true, ...savePersonAvatar(id, root, body) })
      return true
    }
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
    return true
  }
  if (action === 'workspace/build' && method === 'POST') {
    sendJson(res, 200, { ok: true, ...buildPersonWorkspace(id, root) })
    return true
  }
  if (action === 'workspace/reset' && method === 'POST') {
    sendJson(res, 200, { ok: true, ...(await resetPersonWorkspace(id, root)) })
    return true
  }
  if (action === 'run' && method === 'POST') {
    sendJson(res, 200, { ok: true, queue: await runPerson(id, root) })
    return true
  }
  if (action === 'stop' && method === 'POST') {
    sendJson(res, 200, { ok: true, queue: await stopPerson(id, root) })
    return true
  }
  if (action === 'polish' && method === 'POST') {
    const body = await readJson(req)
    const text = await polishPersonText(id, root, {
      kind: str(body.kind) === 'norms' ? 'norms' : 'card',
      title: str(body.title),
      text: str(body.text),
      others: Array.isArray(body.others)
        ? body.others.filter((item): item is string => typeof item === 'string')
        : [],
    })
    sendJson(res, 200, { ok: true, text })
    return true
  }
  if (action === 'memory' && method === 'GET') {
    sendJson(res, 200, { ok: true, memory: getPersonMemory(id, root) })
    return true
  }
  if (action === 'memory/organize' && method === 'POST') {
    sendJson(res, 200, { ok: true, memory: await organizePersonMemory(id, root) })
    return true
  }
  if (action === 'memory/clear' && method === 'POST') {
    sendJson(res, 200, { ok: true, memory: clearPersonMemory(id, root) })
    return true
  }

  sendJson(res, 404, { ok: false, message: `未知人员 API：${method} ${pathname}` })
  return true
}
