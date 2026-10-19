/**
 * Blueprint Studio v3 —— 内置资源库服务端（T11.4 存储/安全根/REST/快照 + T11.6 导出/导入基础）
 *
 * 契约来源：docs/v3/PLAN.md §3.5（库布局 / manifest 形状）、§7.5（导出导入策略）、
 * §7.6（库变更 SSE 事件形状）、§3.8（@library 引用语法）、§4.3（设置里的库路径）。
 *
 * 职责：
 *  - 独立安全根：默认 `%USERPROFILE%\.blueprint-studio\library`（Windows 用 os.homedir()），
 *    环境变量 `BP_LIBRARY_ROOT` 可覆盖；启动与每次操作都校验存在/可读写，且不允许与
 *    项目安全根（server/fs.ts 的 resolveProjectsRoot）重叠（双向包含都拒绝）。
 *  - 目录布局（PLAN §3.5）：
 *      <库根>/elements/*.elem.json
 *      <库根>/styles/*.uss.json
 *      <库根>/functions/*.fn.json
 *      <库根>/.history/<kind>/<条目名>/<ts>.bak      ← 保存前 / 删除前 / 覆盖 / 恢复前快照
 *  - CRUD：listLibrary / readLibraryEntry / writeLibraryEntry / deleteLibraryEntry /
 *    renameLibraryEntry；历史：listLibraryHistory / restoreLibraryHistory。
 *  - 安全：条目名只允许单段文件名主干；拒绝 `..` / 绝对路径 / 盘符 / UNC / 路径分隔符 /
 *    控制字符 / Windows 保留设备名 / 结尾点空格 / 带扩展名 / 跨类型访问，错误消息中文。
 *    解析出的绝对路径再做一次 isPathWithin 兜底（防御未来改动引入的拼接错误）。
 *  - 导出（T11.6）：选中条目 + `@library/*` 依赖闭包 → 最小 store 模式 zip（无第三方依赖，
 *    见下方 Zip 段；可选 deflate 仅用于**读取**外部 zip）+ manifest.json：
 *      { version:1, createdAt, entries:[{ kind, name, sha256 }] }
 *    同时导出 exportLibraryBundle（不落 zip 的 { manifest, files } 目录式形态，便于测试/调试）。
 *  - 导入（T11.6）：Zip Buffer → 校验路径与 manifest 指纹 → 冲突策略 skip / overwrite / rename，
 *    返回逐条明细（imported / skipped / summary）。无 manifest 的 zip 允许导入（verified=false）。
 *  - SSE 数据源（PLAN §7.6）：`librarySubscribers` Set + onLibraryChange 订阅；write/delete/rename/
 *    restore/import 成功后广播 `{ kind, name, action:'saved'|'deleted'|'renamed' }`（rename 额外带 from）。
 *    路由 /api/library/watch 见 server/index.ts（本文件不依赖 HTTP）。
 *
 * 明确不做（后续卡）：
 *  - 改名级联同步引用（§7.4/§11 的 T13.1）——服务端只改文件名，引用修正由校验/编辑器负责；
 *  - 依赖闭包只识别 `@library/<kind>/<name>` 字符串引用（元素/样式可表达；函数按 §3.4 用未限定
 *    函数名 + scope，不构成路径引用，故不纳入闭包）；
 *  - zip 首版只写 store（不压缩）、不写 ZIP64（>4GB / >65535 条目直接拒绝）。读取兼容 store+deflate。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { FsError, historyLimit, isPathWithin, resolveProjectsRoot } from './fs'

/* ============================================================
 * 常量与类型
 * ============================================================ */

/** 库条目类型（PLAN §3.5；目录名即 kind） */
export const LIBRARY_KINDS = ['elements', 'styles', 'functions'] as const
export type LibraryKind = (typeof LIBRARY_KINDS)[number]

/** 各类型的文件扩展名（PLAN §3.7；条目名 = 去掉该后缀的主干） */
export const LIBRARY_EXT: Readonly<Record<LibraryKind, string>> = {
  elements: '.elem.json',
  styles: '.uss.json',
  functions: '.fn.json',
}

/** 中文标签（错误消息用） */
const KIND_LABEL: Readonly<Record<LibraryKind, string>> = {
  elements: '元素',
  styles: '样式表',
  functions: '函数',
}

/** 快照目录（PLAN §3.5；库根下隐藏目录） */
export const LIBRARY_HISTORY_DIR = '.history'

/** 单个库条目内容上限（防御误传巨型文件；库资产均为 JSON 文本） */
export const LIBRARY_ENTRY_MAX_BYTES = 8 * 1024 * 1024

/** zip 读取上限（条目数 / 单条解压后 / 总解压后；防 zip bomb） */
const ZIP_MAX_ENTRIES = 4096
const ZIP_MAX_ENTRY_BYTES = 8 * 1024 * 1024
const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** 条目名最大长度（与 fs.ts 的项目名一致） */
const NAME_MAX = 64

/** Windows 保留设备名（即使带扩展名也拒绝） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 快照时间戳格式（与 fs.ts 一致：20261017-142530-123，可带 -002 序号） */
const HISTORY_TS_RE = /^\d{8}-\d{6}-\d{3}(?:-\d{1,4})?$/

/** `@library/<kind>/<name>` 引用（PLAN §3.8；条目名内不含斜杠） */
const LIBRARY_REF_RE = /^@library\/(elements|styles|functions)\/([^/\\\u0000]+)$/

const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 单条库条目引用 */
export interface LibraryEntryRef {
  kind: LibraryKind
  name: string
}

/** GET /api/library/list 的条目 */
export interface LibraryEntrySummary extends LibraryEntryRef {
  size: number
  mtime: string
}

/** GET /api/library/read 的返回（含指纹，便于客户端缓存失效判断） */
export interface LibraryEntryContent extends LibraryEntrySummary {
  ok: true
  /** 条目文件在库内的 posix 相对路径（如 elements/StatCard.elem.json） */
  path: string
  content: string
  sha256: string
}

/* ============================================================
 * 库根解析与校验（独立安全根）
 * ============================================================ */

/** 默认库根：%USERPROFILE%\.blueprint-studio\library（os.homedir() 在 Windows 即 %USERPROFILE%） */
export function defaultLibraryRoot(): string {
  return path.resolve(path.join(os.homedir(), '.blueprint-studio', 'library'))
}

/**
 * 解析库根（不创建、不校验）：
 * 1. 环境变量 `BP_LIBRARY_ROOT`（测试 / 多环境 / 设置项落盘后的启动参数）
 * 2. 默认 `%USERPROFILE%\.blueprint-studio\library`
 * 设置项 `bps.settings.v1` 存在前端 localStorage，服务端读不到；由启动脚本/环境变量注入。
 */
export function libraryRoot(): string {
  const env = process.env.BP_LIBRARY_ROOT
  if (env && env.trim()) return path.resolve(env.trim())
  return defaultLibraryRoot()
}

/** 沿已存在祖先做 realpath 展开（目标可能尚不存在；用于重叠校验防符号链接绕过） */
function realpathLoose(abs: string): string {
  let probe = path.resolve(abs)
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...suffix)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return path.resolve(abs)
      suffix.unshift(path.basename(probe))
      probe = parent
    }
  }
}

/**
 * 库根与项目安全根不得重叠（双向包含都拒绝；Windows 大小写不敏感由 path.relative 承担）。
 * 独立安全根是 PLAN §3.5 / §7.3 的硬性边界：库与项目必须互不可越。
 */
export function assertLibraryRootSeparate(libRoot: string, projectsRoot: string = resolveProjectsRoot()): void {
  const lib = realpathLoose(libRoot)
  const proj = realpathLoose(projectsRoot)
  if (isPathWithin(lib, proj) || isPathWithin(proj, lib)) {
    throw new FsError(
      403,
      `库根与项目安全根重叠：库根=${path.resolve(libRoot)}，项目根=${path.resolve(projectsRoot)}` +
        '（资源库必须使用独立目录，不能位于项目根内、也不能包含项目根）',
    )
  }
}

/**
 * 确保库根可用：校验不与项目根重叠 → 创建库根与四个标准子目录（elements/styles/functions/.history）
 * → 校验存在、是目录、可读写。返回绝对路径。
 * 服务端启动时调用一次；每次库操作内部也会调用（PLAN §3.5「每次库操作时校验存在/可写」）。
 */
export function ensureLibraryRoot(root: string = libraryRoot()): string {
  const abs = path.resolve(root)
  assertLibraryRootSeparate(abs)
  try {
    fs.mkdirSync(abs, { recursive: true })
  } catch (e) {
    throw new FsError(500, `无法创建库根：${abs}（${errorMessage(e)}）`)
  }
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch (e) {
    throw new FsError(500, `库根不可访问：${abs}（${errorMessage(e)}）`)
  }
  if (!st.isDirectory()) throw new FsError(500, `库根不是目录：${abs}`)
  try {
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    throw new FsError(500, `库根不可读写（请检查目录权限）：${abs}`)
  }
  for (const sub of [...LIBRARY_KINDS, LIBRARY_HISTORY_DIR]) {
    const subAbs = path.join(abs, sub)
    try {
      fs.mkdirSync(subAbs, { recursive: true })
    } catch (e) {
      throw new FsError(500, `无法创建库子目录：${subAbs}（${errorMessage(e)}）`)
    }
    // 符号链接 / junction 逃逸：子目录真实路径必须仍在库根真实路径内（与 fs.ts 安全根同理）
    if (!isPathWithin(realpathLoose(abs), realpathLoose(subAbs))) {
      throw new FsError(403, `库子目录越权（符号链接 / junction 指向库外）：${subAbs}`)
    }
  }
  return abs
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ============================================================
 * 名称 / 类型校验（所有入口统一，中文错误）
 * ============================================================ */

/** 校验并归一化 kind（未知类型 400；跨类型访问不会落到别的目录） */
export function normalizeLibraryKind(raw: unknown): LibraryKind {
  if (typeof raw !== 'string' || !(LIBRARY_KINDS as readonly string[]).includes(raw)) {
    throw new FsError(400, `kind 必须为：${LIBRARY_KINDS.join(' | ')}`)
  }
  return raw as LibraryKind
}

/**
 * 校验条目名（= 文件主干）：
 *  - 字符串、trim 后非空、≤64 字符；
 *  - 拒绝路径分隔符 / Windows 非法字符 / 控制字符 / NUL；
 *  - 拒绝 `..`（路径上跳）、`.`、以点开头（隐藏文件）、结尾点/空格（Windows 会吞掉）；
 *  - 拒绝 Windows 保留设备名、带库扩展名的名字（避免 `x.elem.json.elem.json`）。
 * 允许中文、空格、括号、连字符、内部单点（如 `my.card`）。
 */
export function validateLibraryName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FsError(400, '条目名必须为字符串')
  if (raw.includes('\0')) throw new FsError(400, '条目名含非法字符（NUL）')
  const name = raw.trim()
  if (!name) throw new FsError(400, '条目名不能为空')
  if (name.length > NAME_MAX) throw new FsError(400, `条目名过长（≤${NAME_MAX} 字符）`)
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new FsError(400, `条目名非法（不允许 . / .. 等路径语义）：${name}`)
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new FsError(400, `条目名含非法字符（\\ / : * ? " < > | 或控制字符）：${name}`)
  }
  if (name.startsWith('.')) throw new FsError(400, `条目名不能以点开头：${name}`)
  if (/[. ]$/.test(name)) throw new FsError(400, `条目名不能以点或空格结尾：${name}`)
  if (WINDOWS_RESERVED.test(name)) throw new FsError(400, `条目名使用了 Windows 保留设备名：${name}`)
  for (const kind of LIBRARY_KINDS) {
    if (name.toLowerCase().endsWith(LIBRARY_EXT[kind])) {
      throw new FsError(400, `条目名不带扩展名（应填主干，如 base，而非 base${LIBRARY_EXT[kind]}）：${name}`)
    }
  }
  return name
}

/* ============================================================
 * 条目路径解析（大小写不敏感定位，跨平台一致）
 * ============================================================ */

function entryKey(kind: LibraryKind, name: string): string {
  return `${kind}/${name.toLowerCase()}`
}

/** 库内条目的 posix 相对路径（如 elements/StatCard.elem.json） */
function entryRelPath(kind: LibraryKind, name: string): string {
  return `${kind}/${name}${LIBRARY_EXT[kind]}`
}

/**
 * 在类型目录内按「文件名大小写不敏感」查找条目文件。
 * Windows 文件系统天然不敏感；Linux/macOS 大小写敏感，这里统一按不敏感语义定位，
 * 避免 `/read?name=base` 在大小写不同的库上 404。返回实际绝对路径（不存在则 null）。
 */
function findEntryFile(kindDir: string, name: string, ext: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(kindDir)
  } catch {
    return null
  }
  const want = `${name}${ext}`.toLowerCase()
  for (const n of names) {
    if (n.toLowerCase() !== want) continue
    const abs = path.join(kindDir, n)
    try {
      // lstat：符号链接（含指向库外的文件链接）不视为库条目，避免读写穿透
      if (fs.lstatSync(abs).isFile()) return abs
    } catch {
      /* 竞态：继续找 */
    }
  }
  return null
}

/** 从文件名还原条目主干（扩展名大小写不敏感） */
function stemOf(fileName: string, kind: LibraryKind): string {
  const ext = LIBRARY_EXT[kind]
  return fileName.toLowerCase().endsWith(ext) ? fileName.slice(0, -ext.length) : fileName
}

/** 导出用：求条目绝对路径（纯词法 + 越界兜底；不要求已存在） */
export function libraryEntryPath(kindInput: unknown, nameInput: unknown, root: string = libraryRoot()): string {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  const absRoot = ensureLibraryRoot(root)
  const abs = path.join(absRoot, kind, `${name}${LIBRARY_EXT[kind]}`)
  if (!isPathWithin(absRoot, abs)) throw new FsError(403, `库条目路径越权：${entryRelPath(kind, name)}`)
  return abs
}

/** 解析已存在条目（404 中文错误） */
function resolveExistingEntry(
  root: string,
  kind: LibraryKind,
  name: string,
): { abs: string; name: string } {
  const kindDir = path.join(root, kind)
  const abs = findEntryFile(kindDir, name, LIBRARY_EXT[kind])
  if (!abs) throw new FsError(404, `${KIND_LABEL[kind]}条目不存在：${name}`)
  return { abs, name: stemOf(path.basename(abs), kind) }
}

/* ============================================================
 * .history 快照（保存前 / 删除前 / 覆盖前；沿用 fs.ts 的命名与上限思路）
 * ============================================================ */

/** 历史目录：<库根>/.history/<kind>/<条目名>/（条目名已单段，无注入面） */
function libraryHistoryDir(root: string, kind: LibraryKind, name: string): string {
  return path.join(path.resolve(root), LIBRARY_HISTORY_DIR, kind, name)
}

/** 快照时间戳；同毫秒冲突追加 -002 / -003（字典序 = 时间序） */
function uniqueHistoryTs(dir: string): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const p3 = (n: number): string => String(n).padStart(3, '0')
  const base =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${p3(d.getMilliseconds())}`
  if (!fs.existsSync(path.join(dir, `${base}.bak`))) return base
  for (let i = 2; i < 10000; i++) {
    const cand = `${base}-${String(i).padStart(3, '0')}`
    if (!fs.existsSync(path.join(dir, `${cand}.bak`))) return cand
  }
  throw new FsError(500, '同一毫秒内快照数超出上限（异常高频写入）')
}

function listSnapshotNames(dir: string): string[] {
  const keyOf = (name: string): [string, number] => {
    const ts = name.slice(0, -'.bak'.length)
    const m = /^(\d{8}-\d{6}-\d{3})(?:-(\d+))?$/.exec(ts)
    return m ? [m[1]!, Number(m[2] ?? 0)] : [ts, 0]
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.bak'))
      .sort((a, b) => {
        const [ta, sa] = keyOf(a)
        const [tb, sb] = keyOf(b)
        if (ta !== tb) return ta < tb ? -1 : 1
        return sa - sb
      })
  } catch {
    return []
  }
}

/** 按上限淘汰最旧快照（保留最新 limit 份） */
function pruneHistory(dir: string, limit: number): void {
  const keep = Math.max(1, limit)
  const names = listSnapshotNames(dir)
  for (let i = 0; i < names.length - keep; i++) {
    try {
      fs.rmSync(path.join(dir, names[i]), { force: true })
    } catch {
      /* 淘汰失败不阻断主流程 */
    }
  }
}

/** 给一个已存在的条目文件做快照；返回快照时间戳（上限经 BP_HISTORY_LIMIT 配置） */
function snapshotEntry(root: string, kind: LibraryKind, entryName: string, fileAbs: string): string {
  const dir = libraryHistoryDir(root, kind, entryName)
  fs.mkdirSync(dir, { recursive: true })
  // 历史目录也可能是符号链接 / junction：只在库根真实路径内写快照
  if (!isPathWithin(realpathLoose(root), realpathLoose(dir))) {
    throw new FsError(403, `库快照目录越权（符号链接 / junction 指向库外）：${dir}`)
  }
  const ts = uniqueHistoryTs(dir)
  fs.copyFileSync(fileAbs, path.join(dir, `${ts}.bak`))
  pruneHistory(dir, historyLimit())
  return ts
}

/** 历史目录名按大小写不敏感查找（条目改名大小写 / 删除后仍可查历史） */
function findChildDirIgnoreCase(parentDir: string, name: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(parentDir)
  } catch {
    return null
  }
  for (const n of names) {
    if (n.toLowerCase() !== name.toLowerCase()) continue
    const abs = path.join(parentDir, n)
    try {
      if (fs.statSync(abs).isDirectory()) return abs
    } catch {
      /* 竞态 */
    }
  }
  return null
}

/* ============================================================
 * 库变更事件（SSE 数据源，PLAN §7.6）
 * ============================================================ */

export type LibraryChangeAction = 'saved' | 'deleted' | 'renamed'

/** 广播给 /api/library/watch 订阅者的事件（PLAN §7.6 形状；rename 额外带 from） */
export interface LibraryChangeEvent extends LibraryEntryRef {
  action: LibraryChangeAction
  /** 仅 action='renamed'：旧条目名 */
  from?: string
}

export type LibraryChangeListener = (event: LibraryChangeEvent) => void

/** 订阅者集合（index.ts 的 SSE 处理器直接 add/delete；也可用 onLibraryChange） */
export const librarySubscribers = new Set<LibraryChangeListener>()

/** 订阅库变更；返回取消订阅函数 */
export function onLibraryChange(listener: LibraryChangeListener): () => void {
  librarySubscribers.add(listener)
  return () => {
    librarySubscribers.delete(listener)
  }
}

/** 广播库变更（订阅者异常被吞掉，绝不影响主流程） */
export function broadcastLibraryEvent(event: LibraryChangeEvent): void {
  for (const listener of [...librarySubscribers]) {
    try {
      listener(event)
    } catch {
      /* 单个订阅者异常不影响其它订阅者与写操作 */
    }
  }
}

export function librarySubscriberCount(): number {
  return librarySubscribers.size
}

/* ============================================================
 * 列表 / 读
 * ============================================================ */

/** 列出某类型下的全部条目（按自然序排序；非法名 / 目录 / 其它扩展名忽略） */
export function listLibrary(kindInput: unknown, root: string = libraryRoot()): LibraryEntrySummary[] {
  const kind = normalizeLibraryKind(kindInput)
  const absRoot = ensureLibraryRoot(root)
  return listEntriesIn(absRoot, kind)
}

/** 内部列表（root 已 ensure） */
function listEntriesIn(root: string, kind: LibraryKind): LibraryEntrySummary[] {
  const dir = path.join(root, kind)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const ext = LIBRARY_EXT[kind]
  const out: LibraryEntrySummary[] = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.toLowerCase().endsWith(ext)) continue
    const name = ent.name.slice(0, -ext.length)
    try {
      validateLibraryName(name)
    } catch {
      continue // 外部手工放入的非法名：不在库列表暴露（仍可用文件系统修正）
    }
    let st: fs.Stats
    try {
      st = fs.statSync(path.join(dir, ent.name))
    } catch {
      continue
    }
    out.push({ kind, name, size: st.size, mtime: st.mtime.toISOString() })
  }
  out.sort((a, b) => COLLATOR.compare(a.name, b.name))
  return out
}

/** 读取单个条目（文本；同时返回 sha256 供客户端缓存失效 / manifest 对照） */
export function readLibraryEntry(
  kindInput: unknown,
  nameInput: unknown,
  root: string = libraryRoot(),
): LibraryEntryContent {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  const absRoot = ensureLibraryRoot(root)
  const found = resolveExistingEntry(absRoot, kind, name)
  const buf = fs.readFileSync(found.abs)
  const st = fs.statSync(found.abs)
  return {
    ok: true,
    kind,
    name: found.name,
    path: entryRelPath(kind, found.name),
    content: buf.toString('utf8'),
    size: st.size,
    mtime: st.mtime.toISOString(),
    sha256: sha256Hex(buf),
  }
}

/* ============================================================
 * 写 / 删除 / 改名
 * ============================================================ */

export interface LibraryWriteResult extends LibraryEntryRef {
  ok: true
  /** 库内 posix 相对路径 */
  path: string
  size: number
  sha256: string
  /** 新建为 true；覆盖为 false */
  created: boolean
  /** 覆盖前快照时间戳；新建为 null */
  snapshotTs: string | null
}

/**
 * 写入条目（PUT/POST /api/library/write；导入内部也走这里）。
 * 覆盖已存在条目时先做 .history 快照（新建不产生快照）；写成功广播 saved。
 * content 只接受字符串（库资产为 JSON 文本）；最大 8MB。不做 JSON schema 校验——
 * 条目内容由元素/样式/函数编辑器与后续校验器（T13.1）负责。
 */
export function writeLibraryEntry(
  kindInput: unknown,
  nameInput: unknown,
  content: unknown,
  root: string = libraryRoot(),
): LibraryWriteResult {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  if (typeof content !== 'string') {
    throw new FsError(400, 'content 必须为字符串（资源库条目为 JSON 文本）')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > LIBRARY_ENTRY_MAX_BYTES) {
    throw new FsError(413, `条目内容过大（${bytes} 字节 > 上限 ${LIBRARY_ENTRY_MAX_BYTES}）`)
  }
  return writeEntryBuffer(root, kind, name, Buffer.from(content, 'utf8'))
}

/** 写缓冲（导入保留 zip 内的原始字节，避免字符串往返改变指纹） */
function writeEntryBuffer(rootInput: string, kind: LibraryKind, name: string, buf: Buffer): LibraryWriteResult {
  const absRoot = ensureLibraryRoot(rootInput)
  const kindDir = path.join(absRoot, kind)
  const existing = findEntryFile(kindDir, name, LIBRARY_EXT[kind])
  const target = existing ?? path.join(kindDir, `${name}${LIBRARY_EXT[kind]}`)
  if (!isPathWithin(absRoot, target)) throw new FsError(403, `库条目路径越权：${entryRelPath(kind, name)}`)
  // 目标是符号链接时不写入（findEntryFile 已排除链接作为条目；这里防「链接占位」穿透写库外）
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink()) {
      throw new FsError(403, `库条目路径是符号链接，拒绝写入：${entryRelPath(kind, name)}`)
    }
    if (st.isDirectory()) {
      throw new FsError(400, `目标路径是目录，不能作为库条目写入：${entryRelPath(kind, name)}`)
    }
  } catch (e) {
    if (e instanceof FsError) throw e
    /* 不存在：正常新建 */
  }
  const actualName = existing ? stemOf(path.basename(existing), kind) : name
  const snapshotTs = existing ? snapshotEntry(absRoot, kind, actualName, existing) : null
  try {
    fs.writeFileSync(target, buf)
  } catch (e) {
    throw new FsError(500, `写入${KIND_LABEL[kind]}条目失败：${actualName}（${errorMessage(e)}）`)
  }
  broadcastLibraryEvent({ kind, name: actualName, action: 'saved' })
  return {
    ok: true,
    kind,
    name: actualName,
    path: entryRelPath(kind, actualName),
    size: buf.length,
    sha256: sha256Hex(buf),
    created: !existing,
    snapshotTs,
  }
}

export interface LibraryDeleteResult extends LibraryEntryRef {
  ok: true
  /** 删除前快照时间戳（删除后仍可经 /restore 找回） */
  snapshotTs: string
}

/** 删除条目（删除前快照；不存在 404；成功后广播 deleted） */
export function deleteLibraryEntry(
  kindInput: unknown,
  nameInput: unknown,
  root: string = libraryRoot(),
): LibraryDeleteResult {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  const absRoot = ensureLibraryRoot(root)
  const found = resolveExistingEntry(absRoot, kind, name)
  const snapshotTs = snapshotEntry(absRoot, kind, found.name, found.abs)
  try {
    fs.rmSync(found.abs)
  } catch (e) {
    throw new FsError(500, `删除${KIND_LABEL[kind]}条目失败：${found.name}（${errorMessage(e)}）`)
  }
  broadcastLibraryEvent({ kind, name: found.name, action: 'deleted' })
  return { ok: true, kind, name: found.name, snapshotTs }
}

export interface LibraryRenameResult extends LibraryEntryRef {
  ok: true
  /** 旧名 */
  from: string
  path: string
  /** 同名 no-op 时为 false */
  moved: boolean
  /** overwrite:true 且目标已存在时，被覆盖目标的删除前快照 */
  replacedSnapshotTs?: string
}

/**
 * 重命名条目（同类型内；跨类型禁止）。
 * - `to` 已存在：默认 409；`overwrite:true` 时先给目标做删除前快照再覆盖；
 * - 仅大小写不同：视为同一条目改名（Windows rename 支持）；
 * - 服务端只改文件名，引用级联（§7.4）由 T13.1 校验器/编辑器负责。
 */
export function renameLibraryEntry(
  kindInput: unknown,
  fromInput: unknown,
  toInput: unknown,
  options: { overwrite?: boolean; root?: string } = {},
): LibraryRenameResult {
  const kind = normalizeLibraryKind(kindInput)
  const fromName = validateLibraryName(fromInput)
  const toName = validateLibraryName(toInput)
  const absRoot = ensureLibraryRoot(options.root ?? libraryRoot())
  const src = resolveExistingEntry(absRoot, kind, fromName)
  const dstPath = path.join(absRoot, kind, `${toName}${LIBRARY_EXT[kind]}`)
  if (!isPathWithin(absRoot, dstPath)) throw new FsError(403, `库条目路径越权：${entryRelPath(kind, toName)}`)
  const samePath = path.resolve(src.abs).toLowerCase() === path.resolve(dstPath).toLowerCase()
  if (src.abs === dstPath) {
    return { ok: true, kind, name: src.name, from: src.name, path: entryRelPath(kind, src.name), moved: false }
  }
  const dstExisting = samePath ? src.abs : findEntryFile(path.join(absRoot, kind), toName, LIBRARY_EXT[kind])
  let replacedSnapshotTs: string | undefined
  if (dstExisting && !samePath) {
    if (options.overwrite !== true) {
      throw new FsError(409, `目标${KIND_LABEL[kind]}条目已存在：${toName}（可传 overwrite: true 覆盖）`)
    }
    replacedSnapshotTs = snapshotEntry(absRoot, kind, stemOf(path.basename(dstExisting), kind), dstExisting)
    fs.rmSync(dstExisting)
  }
  try {
    fs.renameSync(src.abs, dstPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw new FsError(500, `重命名${KIND_LABEL[kind]}条目失败：${src.name} → ${toName}（${errorMessage(e)}）`)
    }
    fs.copyFileSync(src.abs, dstPath) // 跨卷兜底
    fs.rmSync(src.abs)
  }
  broadcastLibraryEvent({ kind, name: toName, action: 'renamed', from: src.name })
  return {
    ok: true,
    kind,
    name: toName,
    from: src.name,
    path: entryRelPath(kind, toName),
    moved: true,
    ...(replacedSnapshotTs ? { replacedSnapshotTs } : {}),
  }
}

/* ============================================================
 * 历史列表 / 恢复
 * ============================================================ */

export interface LibraryHistoryEntry {
  ts: string
  size: number
  mtime: string
}

export interface LibraryHistoryResult extends LibraryEntryRef {
  ok: true
  /** 新 → 旧 */
  entries: LibraryHistoryEntry[]
}

/** 列出条目快照（文件已删除也可查；条目名大小写不敏感匹配历史目录） */
export function listLibraryHistory(
  kindInput: unknown,
  nameInput: unknown,
  root: string = libraryRoot(),
): LibraryHistoryResult {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  const absRoot = ensureLibraryRoot(root)
  const kindHistDir = path.join(absRoot, LIBRARY_HISTORY_DIR, kind)
  const dir = findChildDirIgnoreCase(kindHistDir, name) ?? libraryHistoryDir(absRoot, kind, name)
  const entries: LibraryHistoryEntry[] = []
  for (const fileName of listSnapshotNames(dir)) {
    try {
      const st = fs.statSync(path.join(dir, fileName))
      entries.push({ ts: fileName.slice(0, -'.bak'.length), size: st.size, mtime: st.mtime.toISOString() })
    } catch {
      /* 竞态：快照刚被淘汰 */
    }
  }
  entries.reverse()
  return { ok: true, kind, name, entries }
}

export interface LibraryRestoreResult extends LibraryEntryRef {
  ok: true
  /** 被恢复的快照时间戳 */
  ts: string
  /** 恢复前给当前条目做的快照（当前条目不存在时为 null） */
  preRestoreTs: string | null
  size: number
}

/**
 * 按快照恢复条目（POST /api/library/restore，body: { kind, name, ts }）。
 * 条目本体可不存在（误删恢复）；恢复前若存在先留快照，因此恢复本身可撤销。
 * 成功后广播 saved（客户端据此失效缓存）。
 */
export function restoreLibraryHistory(
  kindInput: unknown,
  nameInput: unknown,
  tsInput: unknown,
  root: string = libraryRoot(),
): LibraryRestoreResult {
  const kind = normalizeLibraryKind(kindInput)
  const name = validateLibraryName(nameInput)
  if (typeof tsInput !== 'string' || !HISTORY_TS_RE.test(tsInput)) {
    throw new FsError(400, 'ts 必须为快照时间戳（如 20261017-142530-123，可经 /api/library/history 查询）')
  }
  const ts = tsInput
  const absRoot = ensureLibraryRoot(root)
  const kindHistDir = path.join(absRoot, LIBRARY_HISTORY_DIR, kind)
  const histDir = findChildDirIgnoreCase(kindHistDir, name)
  const snapPath = histDir ? path.join(histDir, `${ts}.bak`) : ''
  if (!snapPath || !fs.existsSync(snapPath)) {
    throw new FsError(404, `快照不存在：${KIND_LABEL[kind]} ${name} @ ${ts}`)
  }
  const kindDir = path.join(absRoot, kind)
  const existing = findEntryFile(kindDir, name, LIBRARY_EXT[kind])
  const target = existing ?? path.join(kindDir, `${name}${LIBRARY_EXT[kind]}`)
  const actualName = existing ? stemOf(path.basename(existing), kind) : name
  // 先读出快照内容：恢复前快照可能触发上限淘汰，把「本次要恢复的快照」本身删掉（上限较小时可复现）
  const snapshotBytes = fs.readFileSync(snapPath)
  let preRestoreTs: string | null = null
  if (existing) preRestoreTs = snapshotEntry(absRoot, kind, actualName, existing)
  fs.writeFileSync(target, snapshotBytes)
  const size = fs.statSync(target).size
  broadcastLibraryEvent({ kind, name: actualName, action: 'saved' })
  return { ok: true, kind, name: actualName, ts, preRestoreTs, size }
}

/* ============================================================
 * 导出：依赖闭包 + manifest 指纹（T11.6 · PLAN §7.5）
 * ============================================================ */

export interface LibraryManifestEntry extends LibraryEntryRef {
  sha256: string
}

/** manifest 形状（PLAN §3.5；字段名与顺序锁定） */
export interface LibraryManifest {
  version: 1
  createdAt: string
  entries: LibraryManifestEntry[]
}

/** 目录式导出结果中的一个文件（导出 zip 时同名写入 <kind>/<name><ext>） */
export interface LibraryBundleFile extends LibraryEntryRef {
  /** zip 内路径（posix，如 elements/StatCard.elem.json） */
  path: string
  content: Buffer
  size: number
  sha256: string
}

export interface LibraryBundle {
  ok: true
  manifest: LibraryManifest
  files: LibraryBundleFile[]
  /** 依赖闭包中缺失的引用（导出仍成功，客户端可提示） */
  missing: LibraryEntryRef[]
}

export interface LibraryExportOptions {
  /** undefined / null = 全部条目；[] = 空包；[{kind,name}] = 选中条目 */
  entries?: unknown
  /** 是否带上 `@library/*` 依赖闭包（默认 true） */
  includeDependencies?: unknown
  root?: string
}

/** 解析导出选择（未知形状 400；去重，保留首次顺序） */
function normalizeExportEntries(raw: unknown): LibraryEntryRef[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new FsError(400, 'entries 必须为数组（[{ kind, name }]）')
  const out: LibraryEntryRef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new FsError(400, 'entries 的每一项必须为 { kind, name }')
    }
    const obj = item as Record<string, unknown>
    const kind = normalizeLibraryKind(obj.kind)
    const name = validateLibraryName(obj.name)
    const key = entryKey(kind, name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, name })
  }
  return out
}

/** 从任何 JSON 字符串值中收集 `@library/<kind>/<name>` 引用（深度上限 64 防恶意递归） */
export function collectLibraryRefs(value: unknown, depth = 0): LibraryEntryRef[] {
  if (depth > 64) return []
  if (typeof value === 'string') {
    const m = LIBRARY_REF_RE.exec(value)
    if (!m) return []
    try {
      return [{ kind: normalizeLibraryKind(m[1]), name: validateLibraryName(m[2]) }]
    } catch {
      return [] // 非法引用名不纳入闭包（校验器会另行报错）
    }
  }
  if (Array.isArray(value)) {
    const out: LibraryEntryRef[] = []
    for (const item of value) out.push(...collectLibraryRefs(item, depth + 1))
    return out
  }
  if (value && typeof value === 'object') {
    const out: LibraryEntryRef[] = []
    for (const item of Object.values(value as Record<string, unknown>)) {
      out.push(...collectLibraryRefs(item, depth + 1))
    }
    return out
  }
  return []
}

/**
 * 从资产图中收集按名调用的全局函数（flow.call { function, scope:'global' }）。
 * §3.4 的函数引用不是路径，无法靠 collectLibraryRefs 字符串扫描；导出闭包需单独收集。
 */
export function collectGlobalFunctionRefs(value: unknown, depth = 0): LibraryEntryRef[] {
  if (depth > 64) return []
  if (Array.isArray(value)) {
    const out: LibraryEntryRef[] = []
    for (const item of value) out.push(...collectGlobalFunctionRefs(item, depth + 1))
    return out
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: LibraryEntryRef[] = []
    if (obj.type === 'flow.call') {
      const params = (obj.params ?? {}) as Record<string, unknown>
      const fn = typeof params.function === 'string' ? params.function : ''
      if (fn && params.scope === 'global') {
        try {
          out.push({ kind: 'functions', name: validateLibraryName(fn) })
        } catch {
          /* 非法函数名由校验器报错 */
        }
      }
    }
    for (const item of Object.values(obj)) out.push(...collectGlobalFunctionRefs(item, depth + 1))
    return out
  }
  return []
}

/** 解析库文件 JSON 并收集引用（非 JSON / 损坏文件 → 无依赖，不阻断导出） */
function collectRefsFromBuffer(buf: Buffer): LibraryEntryRef[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(buf.toString('utf8'))
  } catch {
    return []
  }
  return [...collectLibraryRefs(parsed), ...collectGlobalFunctionRefs(parsed)]
}

/**
 * 导出为 { manifest, files }（目录式基础形态；不写 zip）。
 * 选择为空/缺省 = 全部；显式选中条目必须存在（404）；依赖闭包缺失只记入 missing。
 */
export function exportLibraryBundle(options: LibraryExportOptions = {}): LibraryBundle {
  const absRoot = ensureLibraryRoot(options.root ?? libraryRoot())
  const includeDeps = options.includeDependencies !== false
  const selected = normalizeExportEntries(options.entries)
  const queue: LibraryEntryRef[] = []
  const seen = new Set<string>()
  const queueRef = (ref: LibraryEntryRef): void => {
    const key = entryKey(ref.kind, ref.name)
    if (seen.has(key)) return
    seen.add(key)
    queue.push(ref)
  }
  if (selected === undefined) {
    for (const kind of LIBRARY_KINDS) for (const entry of listEntriesIn(absRoot, kind)) queueRef(entry)
  } else {
    for (const ref of selected) {
      const found = resolveExistingEntry(absRoot, ref.kind, ref.name) // 显式选择不存在 → 404
      queueRef({ kind: ref.kind, name: found.name })
    }
  }
  const files: LibraryBundleFile[] = []
  const missing: LibraryEntryRef[] = []
  const missingKeys = new Set<string>()
  const recordMissing = (ref: LibraryEntryRef): void => {
    const key = entryKey(ref.kind, ref.name)
    if (missingKeys.has(key)) return
    missingKeys.add(key)
    missing.push(ref)
  }
  while (queue.length > 0) {
    const ref = queue.shift() as LibraryEntryRef
    const found = findEntryFile(path.join(absRoot, ref.kind), ref.name, LIBRARY_EXT[ref.kind])
    if (!found) {
      recordMissing(ref)
      continue
    }
    const content = fs.readFileSync(found)
    const actualName = stemOf(path.basename(found), ref.kind)
    files.push({
      kind: ref.kind,
      name: actualName,
      path: entryRelPath(ref.kind, actualName),
      content,
      size: content.length,
      sha256: sha256Hex(content),
    })
    if (!includeDeps) continue
    for (const dep of collectRefsFromBuffer(content)) {
      const key = entryKey(dep.kind, dep.name)
      if (seen.has(key)) continue
      if (!findEntryFile(path.join(absRoot, dep.kind), dep.name, LIBRARY_EXT[dep.kind])) {
        seen.add(key)
        recordMissing(dep)
        continue
      }
      queueRef(dep)
    }
  }
  files.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || COLLATOR.compare(a.name, b.name))
  missing.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || COLLATOR.compare(a.name, b.name))
  const entries: LibraryManifestEntry[] = files.map((f) => ({ kind: f.kind, name: f.name, sha256: f.sha256 }))
  return {
    ok: true,
    manifest: { version: 1, createdAt: new Date().toISOString(), entries },
    files,
    missing,
  }
}

function kindOrder(kind: LibraryKind): number {
  return LIBRARY_KINDS.indexOf(kind)
}

export interface LibraryZipExport extends LibraryBundle {
  zip: Buffer
  entryCount: number
  bytes: number
}

/**
 * 导出 zip：manifest.json（root）+ 条目文件（<kind>/<name><ext>）。
 * 自写 store 模式 zip（不压缩、无第三方依赖）；条目/大小超过首版上限时 413。
 */
export function exportLibraryZip(options: LibraryExportOptions = {}): LibraryZipExport {
  const bundle = exportLibraryBundle(options)
  const manifestJson = JSON.stringify(bundle.manifest, null, 2) + '\n'
  const zipFiles: ZipFileInput[] = [
    { path: 'manifest.json', content: Buffer.from(manifestJson, 'utf8') },
    ...bundle.files.map((f) => ({ path: f.path, content: f.content })),
  ]
  const zip = createZipArchive(zipFiles)
  return {
    ...bundle,
    zip,
    entryCount: bundle.files.length,
    bytes: zip.length,
  }
}

/* ============================================================
 * 导入：zip → 校验 → 冲突策略（T11.6 · PLAN §7.5）
 * ============================================================ */

export type LibraryImportPolicy = 'skip' | 'overwrite' | 'rename'

export interface LibraryImportOptions {
  /** 冲突策略：缺省 skip（保守，不覆盖本地库） */
  policy?: unknown
  root?: string
}

export interface LibraryImportItem extends LibraryEntryRef {
  action: 'created' | 'overwritten' | 'renamed'
  /** action='renamed' 时的最终条目名 */
  to?: string
}

export interface LibraryImportSkipped extends LibraryEntryRef {
  reason: string
}

export interface LibraryImportSummary {
  created: number
  overwritten: number
  renamed: number
  skipped: number
}

export interface LibraryImportResult {
  ok: true
  policy: LibraryImportPolicy
  /** zip 内 manifest（无 manifest 的 zip 为 null） */
  manifest: LibraryManifest | null
  /** manifest 存在且全部指纹校验通过 */
  verified: boolean
  imported: LibraryImportItem[]
  skipped: LibraryImportSkipped[]
  summary: LibraryImportSummary
}

function normalizeImportPolicy(raw: unknown): LibraryImportPolicy {
  if (raw === undefined || raw === null || raw === '') return 'skip'
  if (raw === 'skip' || raw === 'overwrite' || raw === 'rename') return raw
  throw new FsError(400, '导入冲突策略必须为：skip（跳过）| overwrite（覆盖）| rename（并存改名）')
}

/** 解析 manifest.json（形状锁定；版本 / 名称 / 指纹格式非法均 400） */
function parseManifest(buf: Buffer): LibraryManifest {
  let raw: unknown
  try {
    raw = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new FsError(400, 'manifest.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FsError(400, 'manifest.json 必须是对象')
  }
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) throw new FsError(400, `manifest.version 必须为 1（实际 ${String(obj.version)}）`)
  if (typeof obj.createdAt !== 'string' || !obj.createdAt.trim()) {
    throw new FsError(400, 'manifest.createdAt 必须为非空 ISO 时间字符串')
  }
  if (!Array.isArray(obj.entries)) throw new FsError(400, 'manifest.entries 必须为数组')
  const entries: LibraryManifestEntry[] = []
  const seen = new Set<string>()
  for (const item of obj.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new FsError(400, 'manifest.entries 的每一项必须为 { kind, name, sha256 }')
    }
    const e = item as Record<string, unknown>
    const kind = normalizeLibraryKind(e.kind)
    const name = validateLibraryName(e.name)
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256)) {
      throw new FsError(400, `manifest 条目的 sha256 非法（应为 64 位十六进制）：${kind}/${name}`)
    }
    const key = entryKey(kind, name)
    if (seen.has(key)) throw new FsError(400, `manifest 条目重复：${kind}/${name}`)
    seen.add(key)
    entries.push({ kind, name, sha256: e.sha256.toLowerCase() })
  }
  return { version: 1, createdAt: obj.createdAt, entries }
}

/** 解析 zip 内条目路径（只允许 <kind>/<name><ext>；拒绝上跳 / 绝对路径 / 跨类型扩展名） */
function parseZipEntryPath(entryPath: string): LibraryEntryRef {
  if (!entryPath || entryPath.includes('\0')) {
    throw new FsError(400, `zip 条目路径含非法字符：${entryPath}`)
  }
  // 兼容 Windows 压缩工具（如 PowerShell Compress-Archive）写出的反斜杠分隔：
  // 先归一化为 posix 再走同一套严格校验（`..\..\x` 归一化后仍会被段数/上跳规则拒绝）。
  const normalized = entryPath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new FsError(403, `zip 条目路径越权（绝对路径 / 盘符 / UNC）：${entryPath}`)
  }
  const segs = normalized.split('/')
  if (segs.length !== 2 || !segs[0] || !segs[1]) {
    throw new FsError(403, `zip 条目路径越权（只允许 <kind>/<name><ext>）：${entryPath}`)
  }
  const kind = normalizeLibraryKind(segs[0])
  const ext = LIBRARY_EXT[kind]
  if (!segs[1].toLowerCase().endsWith(ext)) {
    throw new FsError(400, `zip 条目扩展名与类型不匹配（${kind} 应为 ${ext}）：${entryPath}`)
  }
  const name = validateLibraryName(segs[1].slice(0, -ext.length))
  return { kind, name }
}

/** 生成并存改名（`name (2)` / `name (3)`…；避开本次导入已占用的名字） */
function uniqueImportName(
  root: string,
  kind: LibraryKind,
  baseName: string,
  reserved: Set<string>,
): string {
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`
    const keep = Math.max(1, NAME_MAX - suffix.length)
    const head =
      (baseName.length > keep ? baseName.slice(0, keep) : baseName).replace(/[. ]+$/, '') || 'entry'
    const cand = `${head}${suffix}`
    const key = entryKey(kind, cand)
    if (reserved.has(key)) continue
    if (findEntryFile(path.join(root, kind), cand, LIBRARY_EXT[kind])) continue
    reserved.add(key)
    return cand
  }
  throw new FsError(500, '无法生成不冲突的库条目名（同类型条目过多）')
}

/**
 * 导入 zip（POST /api/library/import）。
 * 流程：解析 zip（拒绝目录项 / 加密 / 非法路径 / 重复条目）→ 若有 manifest 校验清单一致性与
 * sha256 指纹 → 统一预校验全部目标名 → 逐条按策略落库（写前快照 + saved 广播）。
 * 原子性说明：先完成全部校验再写；单个写入失败会留下已写入的前序条目（首版不做事务回滚）。
 */
export function importLibraryZip(zipData: Buffer, options: LibraryImportOptions = {}): LibraryImportResult {
  if (!Buffer.isBuffer(zipData)) throw new FsError(400, '导入数据必须为 zip Buffer')
  const policy = normalizeImportPolicy(options.policy)
  const absRoot = ensureLibraryRoot(options.root ?? libraryRoot())
  const archiveFiles = readZipArchive(zipData)

  const seenPaths = new Set<string>()
  let manifest: LibraryManifest | null = null
  const entries: Array<LibraryEntryRef & { content: Buffer }> = []
  const entryByKey = new Map<string, LibraryEntryRef & { content: Buffer }>()
  for (const file of archiveFiles) {
    if (file.path === 'manifest.json') {
      if (manifest) throw new FsError(400, 'zip 内含多个 manifest.json')
      manifest = parseManifest(file.content)
      continue
    }
    const ref = parseZipEntryPath(file.path)
    const key = entryKey(ref.kind, ref.name)
    if (seenPaths.has(key)) throw new FsError(400, `zip 条目重复（大小写不敏感）：${file.path}`)
    seenPaths.add(key)
    const item = { ...ref, content: file.content }
    entries.push(item)
    entryByKey.set(key, item)
  }

  if (manifest) {
    const manifestKeys = new Set<string>()
    for (const m of manifest.entries) {
      const key = entryKey(m.kind, m.name)
      if (manifestKeys.has(key)) throw new FsError(400, `manifest 条目重复：${m.kind}/${m.name}`)
      manifestKeys.add(key)
      const actual = entryByKey.get(key)
      if (!actual) throw new FsError(400, `manifest 列出的条目在 zip 中缺失：${m.kind}/${m.name}`)
      const sum = sha256Hex(actual.content)
      if (sum !== m.sha256) {
        throw new FsError(
          400,
          `库条目指纹校验失败：${m.kind}/${m.name}（manifest=${m.sha256.slice(0, 12)}…，实际=${sum.slice(0, 12)}…）`,
        )
      }
    }
    for (const e of entries) {
      if (!manifestKeys.has(entryKey(e.kind, e.name))) {
        throw new FsError(400, `zip 条目未在 manifest 中列出：${e.kind}/${e.name}`)
      }
    }
  }

  entries.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || COLLATOR.compare(a.name, b.name))
  const reserved = new Set<string>()
  const imported: LibraryImportItem[] = []
  const skipped: LibraryImportSkipped[] = []
  const summary: LibraryImportSummary = { created: 0, overwritten: 0, renamed: 0, skipped: 0 }
  for (const ref of entries) {
    const existing = findEntryFile(path.join(absRoot, ref.kind), ref.name, LIBRARY_EXT[ref.kind])
    if (!existing) {
      writeEntryBuffer(absRoot, ref.kind, ref.name, ref.content)
      imported.push({ kind: ref.kind, name: ref.name, action: 'created' })
      summary.created++
      continue
    }
    if (policy === 'skip') {
      skipped.push({ kind: ref.kind, name: ref.name, reason: '目标条目已存在（策略 skip）' })
      summary.skipped++
      continue
    }
    if (policy === 'overwrite') {
      writeEntryBuffer(absRoot, ref.kind, ref.name, ref.content)
      imported.push({ kind: ref.kind, name: ref.name, action: 'overwritten' })
      summary.overwritten++
      continue
    }
    const to = uniqueImportName(absRoot, ref.kind, ref.name, reserved)
    writeEntryBuffer(absRoot, ref.kind, to, ref.content)
    imported.push({ kind: ref.kind, name: ref.name, action: 'renamed', to })
    summary.renamed++
  }
  return { ok: true, policy, manifest, verified: manifest !== null, imported, skipped, summary }
}

/* ============================================================
 * 最小 zip 读写（首版零依赖；写 store，读兼容 store + deflate）
 * ============================================================ */

export interface ZipFileInput {
  /** zip 内路径（posix；调用方保证；导入校验路径更严格） */
  path: string
  content: Buffer
}

export interface ZipFileOutput {
  path: string
  content: Buffer
}

/** CRC32 查表（IEEE 802.3，zip 用） */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { date, time }
}

/**
 * 生成 store 模式（不压缩）zip。UTF-8 文件名（通用标志位 bit 11）。
 * 首版限制：条目数 ≤65535、单条目与总大小 <4GB（不写 ZIP64）。
 */
export function createZipArchive(files: readonly ZipFileInput[]): Buffer {
  if (files.length > 0xffff) {
    throw new FsError(413, `zip 条目数超出首版上限（${files.length} > 65535）`)
  }
  const { date, time } = dosDateTime(new Date())
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0
  for (const file of files) {
    if (file.content.length > 0xffffffff - 30) {
      throw new FsError(413, `zip 条目过大（首版不支持 ZIP64）：${file.path}`)
    }
    const nameBuf = Buffer.from(file.path, 'utf8')
    const crc = crc32(file.content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 名称
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.content.length, 18)
    local.writeUInt32LE(file.content.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBuf, file.content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.content.length, 20)
    central.writeUInt32LE(file.content.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuf)
    offset += local.length + nameBuf.length + file.content.length
  }
  const centralSize = centralChunks.reduce((n, b) => n + b.length, 0)
  if (offset > 0xffffffff || centralSize > 0xffffffff) {
    throw new FsError(413, '导出内容过大（首版 zip 不支持 ZIP64，>4GB）')
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, ...centralChunks, eocd])
}

function findEocdOffset(data: Buffer): number {
  const min = Math.max(0, data.length - 22 - 0xffff)
  for (let i = data.length - 22; i >= min; i--) {
    if (data.readUInt32LE(i) !== 0x06054b50) continue
    const commentLen = data.readUInt16LE(i + 20)
    if (i + 22 + commentLen <= data.length) return i
  }
  throw new FsError(400, '不是合法的 zip（缺少中央目录结尾）')
}

/**
 * 读取 zip（store + deflate；拒绝加密 / 未知压缩 / 越界偏移 / CRC 不符 / zip bomb）。
 * 返回条目内容（按中央目录顺序；目录项忽略）。
 */
export function readZipArchive(data: Buffer): ZipFileOutput[] {
  if (!Buffer.isBuffer(data) || data.length < 22) {
    throw new FsError(400, '不是合法的 zip（文件过小）')
  }
  const eocd = findEocdOffset(data)
  const total = data.readUInt16LE(eocd + 10)
  const cdSize = data.readUInt32LE(eocd + 12)
  const cdOffset = data.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new FsError(400, 'zip 含 ZIP64 结构（首版不支持）')
  }
  if (total > ZIP_MAX_ENTRIES) throw new FsError(413, `zip 条目数过多（${total} > ${ZIP_MAX_ENTRIES}）`)
  if (cdOffset + cdSize > data.length) throw new FsError(400, 'zip 中央目录偏移越界')
  const out: ZipFileOutput[] = []
  let p = cdOffset
  let totalBytes = 0
  for (let i = 0; i < total; i++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) {
      throw new FsError(400, 'zip 中央目录损坏')
    }
    const flags = data.readUInt16LE(p + 8)
    const method = data.readUInt16LE(p + 10)
    const crc = data.readUInt32LE(p + 16)
    const compSize = data.readUInt32LE(p + 20)
    const uncompSize = data.readUInt32LE(p + 24)
    const nameLen = data.readUInt16LE(p + 28)
    const extraLen = data.readUInt16LE(p + 30)
    const commentLen = data.readUInt16LE(p + 32)
    const localOffset = data.readUInt32LE(p + 42)
    if (p + 46 + nameLen > data.length) throw new FsError(400, 'zip 中央目录条目越界')
    const rawName = data.subarray(p + 46, p + 46 + nameLen)
    const entryPath = rawName.toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if ((flags & 0x1) !== 0) throw new FsError(400, `zip 含加密条目：${entryPath}`)
    if (uncompSize > ZIP_MAX_ENTRY_BYTES) {
      throw new FsError(413, `zip 条目解压后过大（>${ZIP_MAX_ENTRY_BYTES}）：${entryPath}`)
    }
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new FsError(400, `zip 本地文件头损坏：${entryPath}`)
    }
    const localNameLen = data.readUInt16LE(localOffset + 26)
    const localExtraLen = data.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > data.length) throw new FsError(400, `zip 条目数据越界：${entryPath}`)
    const raw = data.subarray(dataStart, dataStart + compSize)
    if (entryPath.endsWith('/')) continue // 目录项
    let content: Buffer
    if (method === 0) {
      content = Buffer.from(raw)
    } else if (method === 8) {
      try {
        content = inflateRawSync(raw)
      } catch {
        throw new FsError(400, `zip 条目解压失败：${entryPath}`)
      }
    } else {
      throw new FsError(400, `zip 条目压缩方式不支持（method=${method}）：${entryPath}`)
    }
    if (content.length !== uncompSize) throw new FsError(400, `zip 条目大小不符：${entryPath}`)
    if (crc !== 0 && crc32(content) !== crc) throw new FsError(400, `zip 条目 CRC32 校验失败：${entryPath}`)
    totalBytes += content.length
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
      throw new FsError(413, `zip 解压总量过大（>${ZIP_MAX_TOTAL_BYTES}）`)
    }
    out.push({ path: entryPath, content })
  }
  return out
}

/* ============================================================
 * 小工具
 * ============================================================ */

/** sha256 十六进制小写（manifest 指纹） */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
