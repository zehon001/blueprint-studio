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
 *         AGENTS.md                      DSH 会话读取的身份 / 角色卡 / 规范 / 工作协议
 *         PERSON.md
 *         TASK.md
 *         STATE.md                     跨会话进度（构建时只在缺失时生成，绝不覆盖）
 *         memory/MEMORY.md             长期记忆
 *
 * 「构建工作区」会把默认工作区里除 .person 外的文件移动到用户设置的工作区；
 * 执行时会先构建，再创建 / 复用 DSH 会话并把角色卡、规范、任务与 STATE.md 读入上下文。
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
  type PersonRunState,
  type PersonStats,
  type PersonSummary,
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
const MAX_ACTIVITY = 500
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const MAX_CARD_CONTENT = 50_000
const MAX_TASK_LENGTH = 30_000
const MAX_NORMS_LENGTH = 50_000
const MAX_PROMPT_STATE = 12_000
const MAX_PROMPT_MEMORY = 6_000
const RUN_TIMEOUT_SEC = 7_200

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
  return `# 工作规范

## 怎么操作文件
- 所有产出都放在当前工作区里，不要写到工作区之外。
- 修改文件前先读取原内容，避免凭记忆覆盖。
- 不要删除与当前任务无关的文件；需要清理时先说明原因。
- 大文件先搜索再局部读取，不要一次性把整个仓库读进上下文。

## 怎么使用工具
- 优先使用当前环境可用的文件、终端与搜索工具完成任务。
- 命令失败时先读错误输出，再决定重试或换方案，不要静默忽略失败。
- 执行有副作用的命令前，先确认目标路径与影响范围。
- 需要联网或调用外部服务时，先检查配置是否齐全。

## 工作状态
- 每次开始先读 TASK.md 和 STATE.md，接着上次的进度继续。
- 每完成一个阶段，就把已完成、进行中、下一步写回 STATE.md。
- 值得长期记住的事实写进 memory/MEMORY.md。
`
}

function defaultTask(name: string): string {
  return `请履行「${name}」的职责，推进当前工作。

步骤：
1. 阅读 AGENTS.md、PERSON.md，确认角色与规范。
2. 阅读 TASK.md 和 STATE.md，确认要做什么、已经做到哪一步。
3. 继续推进未完成的工作，不要从头重复已经完成的内容。
4. 每完成一个阶段更新 STATE.md，任务完成后写清最终结果。`
}

function defaultCards(name: string, typeName: string): RoleCard[] {
  return [
    {
      id: newRecordId('card'),
      name: `${name}的角色`,
      tags: typeName ? [typeName] : [],
      content: `你是${name}。\n职责是：按照人员设置完成分配给你的任务。\n\n工作原则：\n- 先理解目标，再动手。\n- 执行过程中持续更新工作区里的 STATE.md。\n- 不确定时先查证，不要编造。`,
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

function saveConfig(loaded: LoadedPerson): void {
  writeJsonAtomic(configPathOf(loaded.profileDir), loaded.config)
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
      content: str(o.content).slice(0, MAX_CARD_CONTENT),
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

function loadNorms(profileDir: string): string {
  return readTextFile(normsPathOf(profileDir), defaultNorms())
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
  readRunState(loaded)
  assertNotRunning(id)
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

function agentsMarkdown(config: PersonConfig, cards: RoleCard[], norms: string, types: PersonType[]): string {
  const typeName = typeNameOf(types, config.typeId) || '未分类'
  const cardText = cards.length
    ? cards
        .map(
          (card) =>
            `### ${card.name}\n${card.tags.length ? `标签：${card.tags.join('、')}\n` : ''}${card.content}`,
        )
        .join('\n\n')
    : '（暂无角色卡）'
  return `# ${config.name} · 工作区行为规范

> 本文件由 Blueprint Studio 的人员页面自动生成；修改人员配置后会自动刷新。

## 身份
- 名字：${config.name}
- 类型：${typeName}
- 工作区：${config.workspace.dir || '默认工作区'}

## 角色卡
${cardText}

## 规范
${norms || '（暂无规范）'}

## 工作协议（跨会话）
1. 每次会话开始，先读本文件、PERSON.md、TASK.md、STATE.md；如果存在 memory/MEMORY.md 也一起读。
2. STATE.md 是跨会话、跨重建的唯一进度真源。不要重复 STATE.md 里已经写明的已完成工作。
3. 每完成一个阶段，立即更新 STATE.md：已完成、进行中、下一步、关键文件。
4. 值得长期保留的事实、决定和偏好追加到 memory/MEMORY.md。
5. 不要删除 .person 配置目录；不要修改与本任务无关的文件。
6. 任务完成后，在 STATE.md 中写清最终结果，并给出简短总结。
`
}

function personMarkdown(config: PersonConfig, cards: RoleCard[], types: PersonType[]): string {
  const typeName = typeNameOf(types, config.typeId) || '未分类'
  const cardNames = cards.map((c) => c.name).join('、') || '暂无'
  return `# ${config.name}

- 类型：${typeName}
- 角色卡：${cardNames}
- 工作区：${config.workspace.dir || '默认工作区'}

详细角色设定与工作协议见 AGENTS.md。
`
}

function writeContextBundle(
  loaded: LoadedPerson,
  dir: string,
  types: PersonType[],
  options: { overwriteState?: boolean; overwriteMemory?: boolean } = {},
): void {
  fs.mkdirSync(dir, { recursive: true })
  const config = loaded.config
  writeTextFile(path.join(dir, 'AGENTS.md'), agentsMarkdown(config, loaded.cards, loaded.norms, types))
  writeTextFile(path.join(dir, 'PERSON.md'), personMarkdown(config, loaded.cards, types))
  writeTextFile(path.join(dir, 'TASK.md'), `# 当前任务\n\n${config.task || defaultTask(config.name)}\n`)
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

- AGENTS.md：身份、角色卡、规范与工作协议
- PERSON.md：人设摘要
- TASK.md：当前任务
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
  for (const name of ['AGENTS.md', 'PERSON.md', 'TASK.md', 'STATE.md']) {
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

function memoryPromptText(loaded: LoadedPerson): string {
  return collectMemory(loaded, MAX_PROMPT_MEMORY).text
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

function assertNotRunning(id: string): void {
  if (activeRuns.has(id)) throw new FsError(409, '人员正在执行中，请先停止后再操作')
}

/* ============================================================
 * 列表 / 详情 / CRUD
 * ============================================================ */

function toSummary(loaded: LoadedPerson): PersonSummary {
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
  const norms = defaultNorms()
  writeJsonAtomic(configPathOf(profileDir), config)
  writeJsonAtomic(cardsPathOf(profileDir), cards)
  writeTextFile(normsPathOf(profileDir), norms)
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
  if (input.norms !== undefined) {
    loaded.norms = str(input.norms).slice(0, MAX_NORMS_LENGTH)
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

function formatCardsForPrompt(cards: RoleCard[]): string {
  if (cards.length === 0) return '（暂无角色卡）'
  return cards
    .map(
      (card) =>
        `## ${card.name}\n${card.tags.length ? `标签：${card.tags.join('、')}\n` : ''}${card.content}`,
    )
    .join('\n\n')
}

/** 构造执行提示词：角色卡、规范、任务、STATE 与记忆都进入上下文 */
export function composeRunPrompt(
  config: PersonConfig,
  cards: RoleCard[],
  norms: string,
  stateText: string,
  memoryText: string,
): string {
  const state = stateText.trim() || '（还没有 STATE.md，请从任务开始并创建进度记录）'
  const memory = memoryText.trim() || '（暂无长期记忆）'
  return `你是「${config.name}」。

## 你的角色卡
${formatCardsForPrompt(cards)}

## 你的工作规范
${norms.trim() || '（暂无规范）'}

## 当前任务
${config.task.trim() || defaultTask(config.name)}

## 当前进度（STATE.md）
${state}

## 长期记忆
${memory}

## 开工要求
1. 先读取当前工作区的 AGENTS.md、PERSON.md、TASK.md、STATE.md；存在 memory/MEMORY.md 时也读取。
2. 会话可能已经被删除并重建。不要从头重做 STATE.md 中已经完成的内容，接着上次的进度继续。
3. 每完成一个阶段，立即更新 STATE.md（已完成、进行中、下一步、关键文件）。
4. 值得长期保留的事实追加到 memory/MEMORY.md。
5. 完成任务后，在 STATE.md 写清最终结果，并给出简短总结。`
}

function buildResultForLoaded(loaded: LoadedPerson): WorkspaceBuildResult {
  return buildWorkspaceInternal(loaded)
}

/** 开始执行：构建工作区 → 创建 / 复用 DSH 会话 → 发送任务 */
export async function runPerson(id: string, root: string = resolvePeopleRoot()): Promise<PersonRunState> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPerson(dir, id)
  readRunState(loaded)
  assertNotRunning(id)
  activeRuns.set(id, 'starting')
  try {
    // 先读一次运行状态：若服务重启留下 running 状态，会在这里取消孤儿会话并标记停止
    const previous = readRunState(loaded)
    const build = buildResultForLoaded(loaded)
    const target = build.workspaceDir
    let sessionId = ''
    if (
      loaded.config.workspace.reuseSession &&
      previous.sessionId &&
      previous.workspaceDir === target &&
      !isSessionArchived(previous.sessionId)
    ) {
      const status = await agentGateway.sessionStatus('dsh', previous.sessionId).catch(() => null)
      if (status && !status.running) sessionId = previous.sessionId
    }
    let sessionTitle = previous.sessionTitle ?? ''
    if (!sessionId) {
      const types = loadTypes(dir)
      const typeName = typeNameOf(types, loaded.config.typeId)
      const title =
        loaded.config.workspace.sessionTitle.trim() ||
        `${loaded.config.name} · ${typeName || '执行'}`
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

    const stateText = readTextFile(path.join(target, 'STATE.md')).slice(-MAX_PROMPT_STATE)
    const prompt = composeRunPrompt(
      loaded.config,
      loaded.cards,
      loaded.norms,
      stateText,
      memoryPromptText(loaded),
    )
    const runId = newRecordId('run')
    const startedAt = Date.now()
    const run: PersonRunState = {
      status: 'running',
      runId,
      sessionId,
      sessionTitle,
      startedAt,
      workspaceDir: target,
    }
    activeRuns.set(id, runId)
    writeRunState(loaded, run)
    loaded.config.stats.runs += 1
    loaded.config.stats.lastRunAt = startedAt
    loaded.config.updatedAt = startedAt
    saveConfig(loaded)
    appendActivity(loaded.profileDir, 'run_started', `开始执行（${sessionTitle || sessionId}）`)

    void agentGateway
      .sendMessage({
        platform: 'dsh',
        project: personProjectKey(id),
        sessionId,
        message: prompt,
        model: loaded.config.model.model || undefined,
        reasoning: loaded.config.model.reasoning || undefined,
        permissions: loaded.config.model.permission || undefined,
        waitForCompletion: true,
        timeoutSec: RUN_TIMEOUT_SEC,
      })
      .then(({ reply }) => finishRun(id, dir, runId, 'completed', reply, ''))
      .catch((err: unknown) =>
        finishRun(id, dir, runId, 'failed', '', err instanceof Error ? err.message : String(err)),
      )
      .finally(() => {
        if (activeRuns.get(id) === runId) activeRuns.delete(id)
      })
    return run
  } catch (err) {
    activeRuns.delete(id)
    if (err instanceof FsError) throw err
    throw new FsError(502, `启动 DSH 会话失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function finishRun(
  id: string,
  root: string,
  runId: string,
  outcome: 'completed' | 'failed',
  reply: string,
  error: string,
): void {
  const loaded = tryLoadPerson(root, id)
  if (!loaded) return
  const current = readRunStateRaw(loaded)
  if (current.runId !== runId) return
  if (current.status === 'stopped') return
  const finalStatus = current.status === 'stopping' ? 'stopped' : outcome
  const finishedAt = Date.now()
  const next: PersonRunState = {
    ...current,
    status: finalStatus,
    finishedAt,
    ...(reply ? { lastReply: reply.slice(0, 20_000) } : {}),
    ...(error ? { error } : {}),
  }
  writeRunState(loaded, next)

  if (finalStatus === 'completed') {
    appendStateNote(
      loaded,
      next,
      `- 状态：已完成\n- 会话：${next.sessionTitle || next.sessionId || '—'}\n- 最后回复：${
        reply.trim().slice(0, 1200) || '（无回复）'
      }`,
    )
    loaded.config.stats.completed += 1
    appendActivity(loaded.profileDir, 'run_completed', '执行完成')
  } else if (finalStatus === 'failed') {
    appendStateNote(
      loaded,
      next,
      `- 状态：失败\n- 错误：${(error || '未知错误').slice(0, 1200)}`,
    )
    loaded.config.stats.failed += 1
    appendActivity(loaded.profileDir, 'run_failed', `执行失败：${error || '未知错误'}`)
  } else {
    appendStateNote(loaded, next, `- 状态：已停止\n- 原因：${(error || '手动停止').slice(0, 1200)}`)
    appendActivity(loaded.profileDir, 'run_stopped', '已停止执行')
  }
  loaded.config.updatedAt = finishedAt
  saveConfig(loaded)

  if (
    finalStatus !== 'stopped' &&
    loaded.config.workspace.deleteSessionAfterRun &&
    next.sessionId
  ) {
    const sessionId = next.sessionId
    next.sessionId = undefined
    writeRunState(loaded, next)
    void agentGateway
      .deleteSession('dsh', sessionId)
      .then(() => appendActivity(loaded.profileDir, 'session_archived', '已按设置归档本次会话'))
      .catch(() => undefined)
  }
}

/** 停止执行：取消 DSH 会话里的当前回合 */
export async function stopPerson(id: string, root: string = resolvePeopleRoot()): Promise<PersonRunState> {
  const dir = ensurePeopleRoot(root)
  const loaded = loadPerson(dir, id)
  const run = readRunState(loaded)
  if (run.status !== 'running' && run.status !== 'stopping') return run
  const stopping: PersonRunState = { ...run, status: 'stopping' }
  writeRunState(loaded, stopping)
  let error = ''
  if (run.sessionId) {
    try {
      await agentGateway.cancelSession('dsh', run.sessionId)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  const current = readRunStateRaw(loaded)
  if (current.runId !== run.runId || current.status !== 'stopping') {
    return current
  }
  const stopped: PersonRunState = {
    ...current,
    status: 'stopped',
    finishedAt: Date.now(),
    error: error ? `停止请求失败：${error}（会话可能仍在运行）` : '已手动停止',
  }
  writeRunState(loaded, stopped)
  appendStateNote(
    loaded,
    stopped,
    `- 状态：已停止\n- 原因：${stopped.error || '手动停止'}`,
  )
  appendActivity(loaded.profileDir, 'run_stopped', error ? `停止请求失败：${error}` : '已手动停止执行')
  activeRuns.delete(id)
  return stopped
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
    sendJson(res, 200, { ok: true, run: await runPerson(id, root) })
    return true
  }
  if (action === 'stop' && method === 'POST') {
    sendJson(res, 200, { ok: true, run: await stopPerson(id, root) })
    return true
  }
  if (action === 'memory' && method === 'GET') {
    sendJson(res, 200, { ok: true, memory: getPersonMemory(id, root) })
    return true
  }
  if (action === 'memory/clear' && method === 'POST') {
    sendJson(res, 200, { ok: true, memory: clearPersonMemory(id, root) })
    return true
  }

  sendJson(res, 404, { ok: false, message: `未知人员 API：${method} ${pathname}` })
  return true
}
