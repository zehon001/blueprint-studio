/**
 * Blueprint Studio v2 —— 项目 FS API（T0.2 · Server-Agent）
 *
 * 职责（对应 PLAN §3 / §4.1、docs/v2/adr/002-project-file.md）：
 *  - 安全根解析（默认 <repo>/_projects/；可用环境变量 BP_PROJECTS_ROOT 或 repo 根
 *    projects.workspace.json 的 projectsRoot 字段覆盖——该文件由 T0.6 维护，本期只读）
 *  - 路径安全：先 resolve 再校验在安全根内，拒绝 ../ 上跳 / 绝对路径 / 盘符 / UNC /
 *    NUL 字符 / 符号链接逃逸；Windows 路径大小写不敏感
 *  - 项目列表 / 从模板新建项目（templates/ 目录即模板，递归复制 + 模板变量替换）
 *  - 项目内文件 CRUD / 移动重命名（move）/ 外部路径导入（import）
 *  - 目录树读取（隐藏 .history）
 *  - .history 自动快照（T7.4）：文件覆盖 / 删除 / 恢复前自动留存旧内容到 <项目>/.history/
 *    （每文件快照数有上限，超出淘汰最旧；上限经环境变量 BP_HISTORY_LIMIT 配置），并提供
 *    列出快照（listHistory）与按快照恢复（restoreHistory）的数据源，路由见 ../server/index.ts
 *  - 文件监视：原生 fs.watch（Windows 支持 recursive）+ 轮询兜底，防抖 200ms
 *
 * 不做（后续卡）：esbuild 转译（T3.3，已由 ./transpile.ts 承接）、插件执行（T6.3）、
 * WS 调试协议（T5.4）、最近项目列表持久化（T0.6）。
 *
 * 路径参数约定：所有 /api/tree /api/file /api/move /api/import 的 path 均为
 * 「相对安全根的 posix 相对路径」，第一段为项目文件夹名（如 `MyTool/ui/main.ui.json`）。
 * 服务端无「当前项目」状态，天然支持多项目并存与跨项目资产移动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectFile } from '../src/ir/types'

/* ============================================================
 * 常量
 * ============================================================ */

/** 引擎版本（模板 project.json 的 engineVersion 默认值；与 package.json version 对齐） */
export const ENGINE_VERSION = '3.0.0'

/** 项目标准子目录（PLAN §4.1）：新建项目时确保全部存在 */
export const PROJECT_DIRS = ['ui', 'logic', 'assets', 'plugins', '.history'] as const

/** 目录树 / 监视中隐藏的目录名（.history 为 T7.4 快照目录） */
const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set(['.history'])

/** .history 自动快照目录名（T7.4；保留目录：不可经文件级写 API 直接触碰） */
const HISTORY_DIR_NAME = '.history'

/**
 * 相对 posix 路径中是否含有隐藏段（.history）——SSE watch 事件过滤用（T7.4）：
 * 快照写入由服务端自动完成，不应对客户端产生「文件变化」事件（文件树会把它当普通文件合并）。
 */
export function isHiddenRelPath(relPosix: string): boolean {
  return relPosix.split('/').some((seg) => HIDDEN_DIR_NAMES.has(seg))
}

/** 内置项目模板（templates/ 下的目录名） */
export const TEMPLATES = ['empty', 'log-analyzer'] as const
export type TemplateId = (typeof TEMPLATES)[number]

const IS_WIN = process.platform === 'win32'

/** Windows 保留设备名（即使带扩展名也拒绝） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/* ============================================================
 * 错误类型（HTTP 语义直接内建，index.ts 据此映射状态码）
 * ============================================================ */

/** 带 HTTP 状态码的 FS 错误（400 参数错误 / 403 越权 / 404 不存在 / 409 冲突） */
export class FsError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FsError'
    this.status = status
  }
}

/* ============================================================
 * 安全根
 * ============================================================ */

/** 仓库根目录（server/ 的上一级；不依赖进程 cwd） */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * 解析项目安全根（优先级从高到低）：
 * 1. 环境变量 `BP_PROJECTS_ROOT`
 * 2. repo 根 `projects.workspace.json` 的 `projectsRoot` 字段（T0.6 写入，本期只读）
 * 3. 默认 `<repo>/_projects/`（需 PM 在 .gitignore 增加 `_projects/`）
 */
export function resolveProjectsRoot(): string {
  const env = process.env.BP_PROJECTS_ROOT
  if (env && env.trim()) return path.resolve(env.trim())
  try {
    const raw = fs.readFileSync(path.join(repoRoot(), 'projects.workspace.json'), 'utf8')
    const cfg = JSON.parse(raw) as { projectsRoot?: unknown }
    if (typeof cfg.projectsRoot === 'string' && cfg.projectsRoot.trim()) {
      return path.resolve(cfg.projectsRoot.trim())
    }
  } catch {
    /* 文件不存在或非法 → 使用默认根 */
  }
  return path.join(repoRoot(), '_projects')
}

/** 确保安全根目录存在（不存在则创建），返回其绝对路径 */
export function ensureProjectsRoot(root: string = resolveProjectsRoot()): string {
  fs.mkdirSync(root, { recursive: true })
  return path.resolve(root)
}

/* ============================================================
 * 路径安全（DoD：越权路径被拒）
 * ============================================================ */

/**
 * 目标是否在 root 内（含 root 本身）。
 * 用 path.relative 判定：Windows 的 path.win32.relative 天然大小写不敏感，
 * Linux/macOS 保持大小写敏感，无需手动 toLowerCase。
 */
export function isPathWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (rel === '') return true
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false
  return !path.isAbsolute(rel)
}

/** 转 posix 相对路径（相对 root），供响应体使用 */
export function toPosixRel(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/')
}

/**
 * 把「相对安全根的路径」解析为绝对路径，并做全部安全校验：
 * 拒绝 NUL / 绝对路径 / 盘符 / UNC / `..` 上跳 / 符号链接逃逸。
 * 空串与 `.` 表示安全根本身。
 */
export function resolveSafePath(root: string, relPath: string): string {
  if (typeof relPath !== 'string') throw new FsError(400, 'path 必须为字符串')
  if (relPath.includes('\0')) throw new FsError(400, 'path 含非法字符（NUL）')
  const unified = relPath.trim().replace(/\\/g, '/')
  if (unified === '' || unified === '.') return path.resolve(root)
  if (path.posix.isAbsolute(unified) || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) {
    throw new FsError(403, `路径越权：不允许绝对路径 / 盘符 / UNC（${relPath}）`)
  }
  const norm = path.posix.normalize(unified)
  if (norm === '..' || norm.startsWith('../')) {
    throw new FsError(403, `路径越权：不允许上跳（${relPath}）`)
  }
  const abs = path.resolve(root, norm)
  if (!isPathWithin(root, abs)) throw new FsError(403, `路径越权：超出安全根（${relPath}）`)
  assertRealPathWithin(root, abs)
  return abs
}

/**
 * 对已解析路径做 realpath 校验（防符号链接逃逸）：
 * 目标可能尚不存在，因此沿父目录向上找到最近的已存在祖先，realpath 后重新校验前缀。
 */
function assertRealPathWithin(root: string, abs: string): void {
  let rootReal = path.resolve(root)
  try {
    rootReal = fs.realpathSync(rootReal)
  } catch {
    /* 根尚不存在（如测试临时目录未建）→ 用词法路径 */
  }
  let probe = abs
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      if (!isPathWithin(rootReal, real)) {
        throw new FsError(403, `路径越权：符号链接逃逸（${toPosixRel(root, abs)}）`)
      }
      return
    } catch (e) {
      if (e instanceof FsError) throw e
      const parent = path.dirname(probe)
      if (parent === probe) return // 已到盘符根仍不存在：放弃校验
      probe = parent
    }
  }
}

/* ============================================================
 * 项目作用域（项目即文件夹：project.json 存在即视为项目）
 * ============================================================ */

/** 已解析到「某个项目内」的路径 */
export interface ProjectScope {
  /** 项目文件夹名（即 /api/projects 返回的 path） */
  projectName: string
  projectDir: string
  /** 项目内相对路径（posix；'' 表示项目根本身） */
  relInProject: string
  /** 绝对路径 */
  abs: string
}

/**
 * 解析「项目内」路径：安全根内 + 第一段是含 project.json 的项目目录。
 * 所有文件级 API（tree/file/move/import 目标）都经此校验，
 * 防止在安全根内项目之外随意落文件。
 */
export function resolveProjectScoped(root: string, relPath: string): ProjectScope {
  const abs = resolveSafePath(root, relPath)
  const segs = toPosixRel(root, abs).split('/').filter(Boolean)
  if (segs.length === 0) {
    throw new FsError(400, '路径必须位于某个项目内（安全根本身不是项目）')
  }
  const projectName = segs[0]
  const projectDir = path.join(path.resolve(root), projectName)
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) {
    throw new FsError(404, `不是有效项目（缺少 project.json）：${projectName}`)
  }
  return { projectName, projectDir, relInProject: segs.slice(1).join('/'), abs }
}

/* ============================================================
 * 项目列表 / 新建（模板脚手架）
 * ============================================================ */

/** /api/projects 的条目 */
export interface ProjectSummary {
  /** 显示名（project.json.name；解析失败回落为文件夹名） */
  name: string
  /** 项目文件夹名（相对安全根，posix） */
  path: string
  mainUI: string | null
  engineVersion: string | null
  /** project.json 修改时间（ISO；项目损坏时为目录 mtime） */
  mtime: string | null
  /** project.json 缺失/损坏时为 true（仍列出，便于用户发现坏项目） */
  broken?: boolean
}

/** 扫描安全根列出项目（只有含 project.json 的目录才算项目） */
export function listProjects(root: string): ProjectSummary[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ProjectSummary[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(path.resolve(root), ent.name)
    const pfPath = path.join(dir, 'project.json')
    if (!fs.existsSync(pfPath)) continue // 文件夹即项目：无 project.json 不算项目
    let pfMtime: string | null = null
    try {
      pfMtime = fs.statSync(pfPath).mtime.toISOString()
    } catch {
      /* 读不到时间就留空 */
    }
    try {
      const pf = JSON.parse(fs.readFileSync(pfPath, 'utf8')) as Partial<ProjectFile>
      out.push({
        name: typeof pf.name === 'string' && pf.name ? pf.name : ent.name,
        path: ent.name,
        mainUI: typeof pf.mainUI === 'string' ? pf.mainUI : null,
        engineVersion: typeof pf.engineVersion === 'string' ? pf.engineVersion : null,
        mtime: pfMtime ?? dirMtime(dir),
      })
    } catch {
      out.push({
        name: ent.name,
        path: ent.name,
        mainUI: null,
        engineVersion: null,
        mtime: pfMtime ?? dirMtime(dir),
        broken: true,
      })
    }
  }
  out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
  return out
}

function dirMtime(dir: string): string {
  try {
    return fs.statSync(dir).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

/** 项目名合法性校验（Windows 语义：非法字符 / 保留名 / 结尾点空格等），返回清理后的名字 */
export function validateProjectName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FsError(400, '项目名必须为字符串')
  // Windows 会吞掉结尾的点和空格，主动去除避免「存在但找不到」的歧义
  const name = raw.trim().replace(/[. ]+$/, '')
  if (!name) throw new FsError(400, '项目名不能为空')
  if (name.length > 64) throw new FsError(400, '项目名过长（≤64 字符）')
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new FsError(400, '项目名含非法字符（\\ / : * ? " < > | 或控制字符）')
  }
  if (name.startsWith('.')) throw new FsError(400, '项目名不能以点开头')
  if (WINDOWS_RESERVED.test(name)) throw new FsError(400, `项目名使用了 Windows 保留设备名：${name}`)
  return name
}

/**
 * 从模板新建项目（POST /api/projects）：
 * 1. 校验项目名与模板 id；2. 拒绝重名（大小写不敏感，跨平台一致）；
 * 3. 递归复制模板目录并替换模板变量（{{PROJECT_NAME}} / {{ENGINE_VERSION}}）；
 * 4. 确保 PLAN §4.1 的五个标准子目录存在。
 */
export function createProject(root: string, rawName: unknown, template: unknown): ProjectSummary {
  const name = validateProjectName(rawName)
  if (typeof template !== 'string' || !(TEMPLATES as readonly string[]).includes(template)) {
    throw new FsError(400, `template 必须为：${TEMPLATES.join(' | ')}`)
  }
  fs.mkdirSync(root, { recursive: true })
  const projectDir = path.join(path.resolve(root), name)
  if (fs.existsSync(projectDir) || hasCaseInsensitiveSibling(root, name)) {
    throw new FsError(409, `同名项目已存在：${name}`)
  }
  const tplDir = path.join(repoRoot(), 'templates', template)
  if (!fs.existsSync(tplDir)) throw new FsError(500, `模板缺失：templates/${template}`)
  copyTemplateDir(tplDir, projectDir, {
    '{{PROJECT_NAME}}': name,
    '{{ENGINE_VERSION}}': ENGINE_VERSION,
  })
  for (const dir of PROJECT_DIRS) fs.mkdirSync(path.join(projectDir, dir), { recursive: true })
  const pf = readProjectFileLoose(projectDir)
  return {
    name: pf.name ?? name,
    path: name,
    mainUI: pf.mainUI ?? null,
    engineVersion: pf.engineVersion ?? null,
    mtime: new Date().toISOString(),
  }
}

/** 大小写不敏感的重名检查（Windows 文件系统本就不敏感；跨平台保持一致行为） */
function hasCaseInsensitiveSibling(root: string, name: string): boolean {
  const lower = name.toLowerCase()
  try {
    return fs.readdirSync(root).some((n) => n.toLowerCase() === lower)
  } catch {
    return false
  }
}

function readProjectFileLoose(projectDir: string): Partial<ProjectFile> {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')) as Partial<ProjectFile>
  } catch {
    return {}
  }
}

/** 递归复制模板目录；文本文件做模板变量替换，二进制原样复制 */
function copyTemplateDir(srcDir: string, destDir: string, vars: Record<string, string>): void {
  fs.mkdirSync(destDir, { recursive: true })
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name)
    const dest = path.join(destDir, ent.name)
    if (ent.isDirectory()) {
      copyTemplateDir(src, dest, vars)
    } else if (ent.isFile()) {
      const buf = fs.readFileSync(src)
      if (isTextBuffer(buf)) {
        let text = buf.toString('utf8')
        for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v)
        fs.writeFileSync(dest, text, 'utf8')
      } else {
        fs.writeFileSync(dest, buf)
      }
    }
  }
}

/** 粗判是否为文本（前 8KB 不含 NUL 即按文本处理，模板目录内文件均为项目自有文件） */
function isTextBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

/* ============================================================
 * 文件 CRUD / 移动 / 导入
 * ============================================================ */

/** GET /api/file：读文本返回 utf8，二进制返回 base64（encoding 字段区分） */
export function readFileSafe(
  root: string,
  relPath: string,
): {
  ok: true
  path: string
  name: string
  ext: string
  encoding: 'utf8' | 'base64'
  content: string
  size: number
  mtime: string
} {
  const scope = resolveProjectScoped(root, relPath)
  if (scope.relInProject === '') throw new FsError(400, 'path 必须指向项目内文件（项目根不是文件）')
  let st: fs.Stats
  try {
    st = fs.statSync(scope.abs)
  } catch {
    throw new FsError(404, `文件不存在：${scope.relInProject}`)
  }
  if (st.isDirectory()) throw new FsError(400, '目标是目录，请用 /api/tree 读取')
  const buf = fs.readFileSync(scope.abs)
  const isText = isTextBuffer(buf)
  return {
    ok: true,
    path: toPosixRel(root, scope.abs),
    name: path.basename(scope.abs),
    ext: extOf(scope.abs),
    encoding: isText ? 'utf8' : 'base64',
    content: isText ? buf.toString('utf8') : buf.toString('base64'),
    size: st.size,
    mtime: st.mtime.toISOString(),
  }
}

/** PUT /api/file：写入文本文件，父目录不存在则自动创建；目标已是目录则拒绝 */
export function writeFileSafe(
  root: string,
  relPath: unknown,
  content: unknown,
): { path: string; size: number; snapshotTs?: string } {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new FsError(400, 'path 必须为非空字符串')
  if (typeof content !== 'string') throw new FsError(400, 'content 必须为字符串（二进制请走 /api/import）')
  const scope = resolveProjectScoped(root, relPath)
  if (scope.relInProject === '') throw new FsError(400, 'path 必须指向项目内文件')
  assertNotHistoryPath(scope.relInProject) // T7.4：.history 由服务端管理，不可经文件 API 直写
  if (fs.existsSync(scope.abs) && fs.statSync(scope.abs).isDirectory()) {
    throw new FsError(400, `目标是目录，不能作为文件写入：${scope.relInProject}`)
  }
  // T7.4 保存前快照：覆盖已存在文件时先把旧内容留存 .history（新建文件不产生快照）
  const snapshotTs = snapshotFile(scope)
  fs.mkdirSync(path.dirname(scope.abs), { recursive: true })
  fs.writeFileSync(scope.abs, content, 'utf8')
  return {
    path: toPosixRel(root, scope.abs),
    size: Buffer.byteLength(content, 'utf8'),
    snapshotTs: snapshotTs ?? undefined,
  }
}

/** DELETE /api/file：删除文件或目录（递归）；禁止删除项目根本身 */
export function deletePathSafe(
  root: string,
  relPath: string,
): { path: string; kind: 'file' | 'dir'; snapshotTs?: string } {
  const scope = resolveProjectScoped(root, relPath)
  if (scope.relInProject === '') {
    throw new FsError(400, '不能删除项目根目录（删除项目属项目管理器职责，后续卡处理）')
  }
  assertNotHistoryPath(scope.relInProject) // T7.4：禁止经 DELETE 清空 .history 快照
  let st: fs.Stats
  try {
    st = fs.statSync(scope.abs)
  } catch {
    throw new FsError(404, `路径不存在：${scope.relInProject}`)
  }
  // T7.4：删除普通文件前留一份快照（DoD「文件级误删可从快照恢复」——
  // 文件删除后仍可经 /api/history/restore 按快照找回；目录删除不做递归快照）
  const snapshotTs = st.isFile() ? snapshotFile(scope) : null
  fs.rmSync(scope.abs, { recursive: true, force: false })
  return { path: toPosixRel(root, scope.abs), kind: st.isDirectory() ? 'dir' : 'file', snapshotTs: snapshotTs ?? undefined }
}

/** POST /api/move：移动 / 重命名（body: { from, to, overwrite? }），支持跨项目 */
export function movePath(
  root: string,
  body: { from?: unknown; to?: unknown; overwrite?: unknown },
): { path: string; moved: boolean } {
  const fromStr = typeof body.from === 'string' ? body.from : ''
  const toStr = typeof body.to === 'string' ? body.to : ''
  if (!fromStr.trim() || !toStr.trim()) throw new FsError(400, 'from / to 必须为非空字符串')
  const src = resolveProjectScoped(root, fromStr)
  if (src.relInProject === '') throw new FsError(400, '不能整体移动 / 重命名项目目录')
  assertNotHistoryPath(src.relInProject) // T7.4：不得把快照移出 .history
  const dst = resolveProjectScoped(root, toStr)
  if (dst.relInProject === '') throw new FsError(400, '目标不能是项目目录本身')
  assertNotHistoryPath(dst.relInProject) // T7.4：不得向 .history 内移动 / 重命名
  const sameTarget =
    src.abs.toLowerCase() === dst.abs.toLowerCase() || (!IS_WIN && src.abs === dst.abs)
  if (sameTarget) return { path: toPosixRel(root, dst.abs), moved: false } // 同名 move = no-op
  if (!fs.existsSync(src.abs)) throw new FsError(404, `源路径不存在：${src.relInProject}`)
  if (isPathWithin(src.abs, dst.abs)) throw new FsError(400, '不能把目录移动到其自身内部')
  if (fs.existsSync(dst.abs)) {
    if (body.overwrite !== true) {
      throw new FsError(409, `目标已存在：${dst.relInProject}（可传 overwrite: true 覆盖）`)
    }
    fs.rmSync(dst.abs, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(dst.abs), { recursive: true })
  try {
    fs.renameSync(src.abs, dst.abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyAny(src.abs, dst.abs) // 跨卷兜底：复制后删除
    fs.rmSync(src.abs, { recursive: true, force: true })
  }
  return { path: toPosixRel(root, dst.abs), moved: true }
}

/** 通用复制（文件 / 目录递归；符号链接跟随其指向的内容） */
function copyAny(src: string, dest: string): void {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      copyAny(path.join(src, ent.name), path.join(dest, ent.name))
    }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

/* ============================================================
 * .history 自动快照（T7.4 · 保存前快照 / 删除前快照 / 恢复）
 * ============================================================ */

/** 每文件保留的快照数默认上限（快照上限可配：经环境变量 BP_HISTORY_LIMIT 覆盖） */
export const HISTORY_LIMIT_DEFAULT = 20

/**
 * 快照时间戳（即快照文件名主干）：`20261017-142530-123`；同一毫秒内多次快照时追加
 * 零填充序号 `-002`（保证文件名字典序 = 时间序，淘汰最旧时无需解析时间）。
 * 恢复端点回传的 ts 必须匹配本格式（天然排除路径分隔符 / 上跳，防注入）。
 */
const HISTORY_TS_RE = /^\d{8}-\d{6}-\d{3}(?:-\d{1,4})?$/

/**
 * 解析快照上限（每文件保留份数）。
 * 配置方式选型说明：沿用本文件既有的「环境变量优先」模式（同 BP_PROJECTS_ROOT——
 * 安全根就是经环境变量配置的），快照上限是服务端全局策略而非单项目属性，
 * 因此不放进 project.json（那个文件用户随时会改写，且历史越多的项目越不该被它约束）。
 * 环境变量 `BP_HISTORY_LIMIT`：正整数生效；缺失 / 非整数 / <1 一律回落默认 20。
 */
export function historyLimit(): number {
  const raw = process.env.BP_HISTORY_LIMIT
  if (raw && raw.trim()) {
    const n = Number(raw.trim())
    if (Number.isInteger(n) && n >= 1) return n
  }
  return HISTORY_LIMIT_DEFAULT
}

/**
 * 项目内相对路径是否位于保留快照目录 .history（任意层级段命中即算——
 * .history 在目录树任何层级都隐藏，且 Windows 文件系统大小写不敏感，
 * 故统一按小写比较拒绝 `.HISTORY` 等变体经文件 API 写入真实快照目录）。
 */
export function isHistoryPath(relInProject: string): boolean {
  return relInProject.split('/').some((seg) => seg.toLowerCase() === HISTORY_DIR_NAME)
}

/** 保留目录守卫：文件级写 API（写 / 删 / 移动两端 / 导入目标）不得直接触碰 .history */
function assertNotHistoryPath(relInProject: string): void {
  if (isHistoryPath(relInProject)) {
    throw new FsError(403, `.history 为自动快照目录（由服务端管理），不可经文件 API 直接写入：${relInProject}`)
  }
}

/** 快照目录：<项目>/.history/<项目内相对路径>/（relInProject 逐段展开，保持子目录层级） */
function historyDirFor(projectDir: string, relInProject: string): string {
  return path.join(projectDir, HISTORY_DIR_NAME, ...relInProject.split('/'))
}

/** 生成当前时刻的快照时间戳；同毫秒冲突时追加零填充序号 -002 / -003（保证字典序=时间序） */
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

/** 快照目录内的 .bak 文件名（按时间序升序 = 文件名字典序；子目录与非 .bak 忽略） */
function listSnapshotNames(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return [] // 目录不存在 / 不可读：无快照
  }
  return names.filter((n) => n.endsWith('.bak')).sort()
}

/** 按上限淘汰最旧快照（保留最新 limit 份；limit 至少 1） */
function pruneHistory(dir: string, limit: number): void {
  const keep = Math.max(1, limit)
  const names = listSnapshotNames(dir)
  for (let i = 0; i < names.length - keep; i++) {
    try {
      fs.rmSync(path.join(dir, names[i]), { force: true })
    } catch {
      /* 淘汰失败不阻断主流程（下次快照再试） */
    }
  }
}

/**
 * 给项目内一个已存在的文件做快照（保存前 / 删除前 / 恢复前调用）。
 * 目标不存在（新建）或不是普通文件 → 不产生快照，返回 null；
 * 否则把当前内容复制到 .history 对应层级目录并按上限淘汰最旧，返回快照时间戳。
 */
export function snapshotFile(scope: ProjectScope, limit: number = historyLimit()): string | null {
  let st: fs.Stats
  try {
    st = fs.statSync(scope.abs)
  } catch {
    return null // 文件不存在（新建写入）：无旧内容可快照
  }
  if (!st.isFile()) return null
  const dir = historyDirFor(scope.projectDir, scope.relInProject)
  fs.mkdirSync(dir, { recursive: true })
  const ts = uniqueHistoryTs(dir)
  fs.copyFileSync(scope.abs, path.join(dir, `${ts}.bak`))
  pruneHistory(dir, limit)
  return ts
}

/** GET /api/history 的条目（ts 供恢复端点回传；新 → 旧排序） */
export interface HistoryEntry {
  ts: string
  /** 快照字节数 */
  size: number
  /** 快照文件修改时间（ISO） */
  mtime: string
}

/**
 * 列出项目内某文件的全部快照（GET /api/history）。
 * 文件本体已删除也可查（误删恢复的入口）；path 约定与 /api/file 一致
 * （相对安全根、首段 = 项目文件夹名）。快照位于 .history 下，本身不可查。
 */
export function listHistory(root: string, relPath: string): { path: string; entries: HistoryEntry[] } {
  const scope = resolveProjectScoped(root, relPath)
  if (scope.relInProject === '') throw new FsError(400, 'path 必须指向项目内文件')
  if (isHistoryPath(scope.relInProject)) throw new FsError(400, '.history 为自动快照目录，不提供历史查询')
  const dir = historyDirFor(scope.projectDir, scope.relInProject)
  const entries: HistoryEntry[] = []
  for (const name of listSnapshotNames(dir)) {
    const abs = path.join(dir, name)
    try {
      const st = fs.statSync(abs)
      entries.push({ ts: name.slice(0, -'.bak'.length), size: st.size, mtime: st.mtime.toISOString() })
    } catch {
      /* 竞态（快照刚被淘汰）：跳过 */
    }
  }
  entries.reverse() // 新 → 旧
  return { path: toPosixRel(root, scope.abs), entries }
}

/** POST /api/history/restore 的返回（preRestoreTs 非空 = 恢复前内容可再经恢复找回） */
export interface RestoreResult {
  ok: true
  /** 恢复目标（相对安全根，posix） */
  path: string
  /** 被恢复的快照时间戳 */
  ts: string
  /** 恢复前给当前文件做的快照时间戳；当前文件不存在（误删恢复）时为 null */
  preRestoreTs: string | null
  /** 恢复后文件字节数 */
  size: number
}

/**
 * 用指定快照覆盖当前文件（POST /api/history/restore，body: { path, ts }）。
 * - 文件本体可以不存在（误删恢复）：直接从快照重建；
 * - 恢复前若当前文件存在，先为它做一份快照（与保存前快照同一机制、同一上限），
 *   因此恢复本身可撤销（再恢复到 preRestoreTs 即回退）；
 * - ts 经格式校验（排除路径分隔符与上跳），路径经 resolveProjectScoped 全量安全校验。
 */
export function restoreHistory(root: string, relPath: string, ts: unknown): RestoreResult {
  if (typeof ts !== 'string' || !HISTORY_TS_RE.test(ts)) {
    throw new FsError(400, 'ts 必须为快照时间戳（如 20261017-142530-123，可经 GET /api/history 查询）')
  }
  const scope = resolveProjectScoped(root, relPath)
  if (scope.relInProject === '') throw new FsError(400, 'path 必须指向项目内文件')
  assertNotHistoryPath(scope.relInProject) // 不允许把快照内容恢复进 .history 自身
  const snapPath = path.join(historyDirFor(scope.projectDir, scope.relInProject), `${ts}.bak`)
  if (!fs.existsSync(snapPath)) {
    throw new FsError(404, `快照不存在：${scope.relInProject} @ ${ts}`)
  }
  let preRestoreTs: string | null = null
  if (fs.existsSync(scope.abs)) {
    if (fs.statSync(scope.abs).isDirectory()) {
      throw new FsError(400, `恢复目标是目录，不能被文件覆盖：${scope.relInProject}`)
    }
    preRestoreTs = snapshotFile(scope) // 恢复前先留存当前内容（可撤销）
  }
  fs.mkdirSync(path.dirname(scope.abs), { recursive: true })
  fs.copyFileSync(snapPath, scope.abs)
  return {
    ok: true,
    path: toPosixRel(root, scope.abs),
    ts,
    preRestoreTs,
    size: fs.statSync(scope.abs).size,
  }
}

/* ============================================================
 * 目录树
 * ============================================================ */

/** 目录树节点（GET /api/tree 的返回结构，PLAN/TASKBOARD T0.2 约定） */
export interface TreeNode {
  name: string
  /** 相对安全根的 posix 路径 */
  path: string
  type: 'dir' | 'file'
  /** 小写扩展名（不含点；目录为 ''，如 main.ui.json → 'json'） */
  ext: string
  children: TreeNode[]
}

/** 读目录树（隐藏 .history）；path 必须是项目内目录 */
export function readTree(root: string, relPath: string): TreeNode {
  const scope = resolveProjectScoped(root, relPath)
  let st: fs.Stats
  try {
    st = fs.statSync(scope.abs)
  } catch {
    throw new FsError(404, `目录不存在：${scope.relInProject || scope.projectName}`)
  }
  if (!st.isDirectory()) throw new FsError(400, 'tree 的 path 必须是目录')
  return buildTreeNode(path.resolve(root), scope.abs)
}

const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function buildTreeNode(rootAbs: string, dir: string): TreeNode {
  const node: TreeNode = {
    name: path.basename(dir),
    path: toPosixRel(rootAbs, dir),
    type: 'dir',
    ext: '',
    children: [],
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return node // 权限或竞态：返回空目录
  }
  const dirs: TreeNode[] = []
  const files: TreeNode[] = []
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (HIDDEN_DIR_NAMES.has(ent.name)) continue
      dirs.push(buildTreeNode(rootAbs, path.join(dir, ent.name)))
    } else if (ent.isFile()) {
      const abs = path.join(dir, ent.name)
      files.push({ name: ent.name, path: toPosixRel(rootAbs, abs), type: 'file', ext: extOf(ent.name), children: [] })
    }
    // 符号链接等特殊类型忽略（防环）
  }
  dirs.sort((a, b) => COLLATOR.compare(a.name, b.name))
  files.sort((a, b) => COLLATOR.compare(a.name, b.name))
  node.children = [...dirs, ...files]
  return node
}

function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return ext.startsWith('.') ? ext.slice(1) : ''
}

/* ============================================================
 * 外部导入（服务端本地能力：源可读任意路径，目标必须在项目内）
 * ============================================================ */

export interface ImportResult {
  ok: true
  /** 实际落盘位置（相对安全根，posix；冲突时自动加 " (n)" 后缀） */
  target: string
  files: number
  bytes: number
  /** 目标已存在而改名时为 true */
  renamed: boolean
}

/**
 * POST /api/import：把本地任意文件夹 / 文件复制入项目。
 * sourcePath 必须为绝对路径（前端文件对话框返回值），允许位于安全根外（只读）；
 * targetDir 必须在项目内。目标重名不覆盖，自动加 ` (2)` / ` (3)` 后缀防数据丢失。
 */
export function importIntoProject(root: string, targetDir: unknown, sourcePath: unknown): ImportResult {
  if (typeof targetDir !== 'string' || !targetDir.trim()) throw new FsError(400, 'targetDir 必须为非空字符串')
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new FsError(400, 'sourcePath 必须为非空字符串')
  if (sourcePath.includes('\0')) throw new FsError(400, 'sourcePath 含非法字符')
  if (!path.isAbsolute(sourcePath)) throw new FsError(400, 'sourcePath 必须为绝对路径（文件对话框返回值）')
  const target = resolveProjectScoped(root, targetDir)
  assertNotHistoryPath(target.relInProject) // T7.4：导入目标不得位于 .history（含深层同名段）
  let srcSt: fs.Stats
  try {
    srcSt = fs.statSync(sourcePath)
  } catch {
    throw new FsError(404, `源路径不存在：${sourcePath}`)
  }
  let dest = path.join(target.abs, path.basename(sourcePath))
  let renamed = false
  if (fs.existsSync(dest)) {
    dest = uniqueSibling(dest)
    renamed = true
  }
  const counter = { files: 0, bytes: 0 }
  if (srcSt.isDirectory()) {
    copyCounted(sourcePath, dest, counter)
  } else if (srcSt.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(sourcePath, dest)
    counter.files = 1
    counter.bytes = srcSt.size
  } else {
    throw new FsError(400, '源路径既不是文件也不是目录')
  }
  return { ok: true, target: toPosixRel(root, dest), files: counter.files, bytes: counter.bytes, renamed }
}

/** 同名冲突时生成 `name (2).ext` 形式的不冲突目标 */
function uniqueSibling(dest: string): string {
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const base = path.basename(dest, ext)
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(cand)) return cand
  }
  throw new FsError(500, '无法生成不冲突的目标名')
}

function copyCounted(src: string, dest: string, counter: { files: number; bytes: number }): void {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      copyCounted(path.join(src, ent.name), path.join(dest, ent.name), counter)
    }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    counter.files++
    counter.bytes += st.size
  }
}

/* ============================================================
 * 文件监视（SSE 数据源）
 * ============================================================ */

/** 监视事件（推给 SSE 客户端的形态；path 相对监视目录，posix） */
export interface FsChangeEvent {
  type: 'add' | 'unlink' | 'change'
  path: string
  /** 目录删除时无法判定，字段省略 */
  kind?: 'file' | 'dir'
}

export interface WatchOptions {
  /** 防抖窗口毫秒数（默认 200，卡片要求） */
  debounceMs?: number
  /** 轮询兜底间隔毫秒数（默认 1000） */
  pollIntervalMs?: number
  /** 测试用：强制轮询模式 */
  forcePoll?: boolean
}

export interface WatchHandle {
  close(): void
}

/**
 * 监视目录变更（含子目录）：
 * - 优先原生 fs.watch recursive（Windows / macOS 支持）；不可用或报错时自动降级轮询快照 diff
 * - 事件防抖 200ms：同一批 flush 内同一路径只保留最新状态，add/unlink/change 由 flush 时的
 *   实际 stat 结果判定（避免 fs.watch 的 rename 语义歧义）
 */
export function watchPath(
  dir: string,
  onChange: (events: FsChangeEvent[]) => void,
  options: WatchOptions = {},
): WatchHandle {
  const absDir = path.resolve(dir)
  const debounceMs = options.debounceMs ?? 200
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  /** 防抖窗口内按路径合并事件标志（rename 常伴随 change 一起到达：新建=两者，修改=仅 change） */
  let pending = new Map<string, { rename: boolean; change: boolean }>()
  let timer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let closed = false
  let lastSnapshot: Map<string, { mtimeMs: number; isDir: boolean }> | null = null

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  const record = (rawPath: string, ev: 'rename' | 'change'): void => {
    const rel = rawPath.split(path.sep).join('/')
    const flags = pending.get(rel) ?? { rename: false, change: false }
    if (ev === 'rename') flags.rename = true
    else flags.change = true
    pending.set(rel, flags)
    schedule()
  }

  const flush = (): void => {
    timer = null
    if (closed) {
      pending.clear()
      return
    }
    const events: FsChangeEvent[] = []
    for (const [rel, flags] of pending) {
      let exists = false
      let isDir = false
      try {
        const st = fs.statSync(path.join(absDir, rel))
        exists = true
        isDir = st.isDirectory()
      } catch {
        /* 已删除 / 竞态 */
      }
      const event: FsChangeEvent = {
        // 存在且出现过 rename → 新建/移入（add）；仅 change → 修改；不存在 → 删除
        type: !exists ? 'unlink' : flags.rename ? 'add' : 'change',
        path: rel,
      }
      if (exists) event.kind = isDir ? 'dir' : 'file'
      events.push(event)
    }
    pending = new Map()
    if (events.length > 0) onChange(events)
  }

  /** 快照 diff（轮询一跳；也用于 fs.watch filename=null 时的兜底） */
  const pollTick = (): void => {
    if (closed) return
    const snap = snapshotDir(absDir)
    if (lastSnapshot) {
      for (const [rel, info] of snap) {
        const prev = lastSnapshot.get(rel)
        if (!prev) record(rel, 'rename')
        else if (!info.isDir && prev.mtimeMs !== info.mtimeMs) record(rel, 'change')
      }
      for (const rel of lastSnapshot.keys()) if (!snap.has(rel)) record(rel, 'rename')
    }
    lastSnapshot = snap
  }

  const startPolling = (): void => {
    if (closed || pollTimer) return
    pollTimer = setInterval(pollTick, pollIntervalMs)
  }

  if (options.forcePoll) {
    lastSnapshot = snapshotDir(absDir) // 基线：不回放已有文件
    startPolling()
  } else {
    try {
      watcher = fs.watch(absDir, { recursive: true }, (event, filename) => {
        if (closed) return
        if (filename === null) {
          pollTick() // 文件名不可知：快照 diff 兜底
          return
        }
        record(String(filename), event)
      })
      watcher.on('error', () => {
        // 监视根被删除，或平台不支持 recursive（如部分 Linux）→ 降级轮询
        watcher?.close()
        watcher = null
        if (closed) return
        if (!fs.existsSync(absDir)) {
          closed = true
          onChange([{ type: 'unlink', path: '', kind: 'dir' }])
          return
        }
        lastSnapshot = snapshotDir(absDir)
        startPolling()
      })
    } catch {
      lastSnapshot = snapshotDir(absDir)
      startPolling()
    }
  }

  return {
    close(): void {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      watcher?.close()
      watcher = null
      pending.clear()
    },
  }
}

/** 目录快照：relPosix → { mtimeMs, isDir }（跳过不可读项；符号链接不跟随） */
function snapshotDir(
  dir: string,
  base = dir,
  out: Map<string, { mtimeMs: number; isDir: boolean }> = new Map(),
): Map<string, { mtimeMs: number; isDir: boolean }> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    const rel = toPosixRel(base, abs)
    if (ent.isDirectory()) {
      out.set(rel, { mtimeMs: 0, isDir: true })
      snapshotDir(abs, base, out)
    } else if (ent.isFile()) {
      try {
        out.set(rel, { mtimeMs: fs.statSync(abs).mtimeMs, isDir: false })
      } catch {
        /* 竞态：跳过 */
      }
    }
  }
  return out
}

/* ============================================================
 * 整文件夹导入为项目（POST /api/projects/import-folder · T0.6 项目管理器）
 * ============================================================ */

export interface ImportFolderResult {
  ok: true
  /** 新导入的项目摘要（path = 安全根内的项目文件夹名） */
  project: ProjectSummary
  /** 复制的文件数 / 字节数 */
  files: number
  bytes: number
  /** 目标重名自动改名（`xxx (2)`）时为 true */
  renamed: boolean
  /** 源不含 project.json、由服务端补脚手架时为 true */
  scaffolded: boolean
}

/**
 * 把本地任意文件夹整体导入为一个新项目（项目管理器「导入项目」）：
 *  - sourcePath 必须为绝对路径且是**目录**（文件路径拒绝 400）；允许位于安全根外（只读语义，
 *    与 /api/import 一致）；
 *  - name 缺省时用源文件夹名；目标重名不覆盖，自动 ` (2)` / ` (3)` 后缀；
 *  - 源含 project.json → 整体复制入安全根；
 *  - 源不含 project.json → 复制后按 PLAN §4.1 补脚手架：缺失标准目录补齐 +
 *    最小 project.json（mainUI 探测 ui/*.ui.json 的第一个，没有则新建空 main.ui.json）。
 */
export function importProjectFolder(root: string, sourcePath: unknown, name?: unknown): ImportFolderResult {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new FsError(400, 'sourcePath 必须为非空字符串')
  }
  if (sourcePath.includes('\0')) throw new FsError(400, 'sourcePath 含非法字符（NUL）')
  if (!path.isAbsolute(sourcePath)) {
    throw new FsError(400, 'sourcePath 必须为绝对路径（本地文件夹路径）')
  }
  let srcSt: fs.Stats
  try {
    srcSt = fs.statSync(sourcePath)
  } catch {
    throw new FsError(404, `源路径不存在：${sourcePath}`)
  }
  if (!srcSt.isDirectory()) throw new FsError(400, `源路径不是文件夹：${sourcePath}`)

  // 目标名：优先显式 name，否则源文件夹名；统一走项目名合法性校验
  const rawName = typeof name === 'string' && name.trim() ? name : path.basename(path.resolve(sourcePath))
  const targetName = validateProjectName(rawName)

  fs.mkdirSync(root, { recursive: true })
  let dest = path.join(path.resolve(root), targetName)
  let renamed = false
  if (fs.existsSync(dest) || hasCaseInsensitiveSibling(root, targetName)) {
    dest = uniqueProjectDir(dest)
    renamed = true
  }

  const counter = { files: 0, bytes: 0 }
  copyTreeCounted(path.resolve(sourcePath), dest, counter)

  const hadProjectFile = fs.existsSync(path.join(dest, 'project.json'))
  if (!hadProjectFile) scaffoldProject(dest, targetName)

  const pf = readProjectFileLoose(dest)
  const folder = toPosixRel(root, dest)
  return {
    ok: true,
    project: {
      name: typeof pf.name === 'string' && pf.name ? pf.name : path.basename(dest),
      path: folder,
      mainUI: typeof pf.mainUI === 'string' ? pf.mainUI : null,
      engineVersion: typeof pf.engineVersion === 'string' ? pf.engineVersion : null,
      mtime: new Date().toISOString(),
    },
    files: counter.files,
    bytes: counter.bytes,
    renamed,
    scaffolded: !hadProjectFile,
  }
}

/** 项目目录重名时生成 `name (2)` / `name (3)` 形式的不冲突目录（整个名字追加后缀，不拆扩展名） */
function uniqueProjectDir(dest: string): string {
  const dir = path.dirname(dest)
  const base = path.basename(dest)
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})`)
    if (!fs.existsSync(cand) && !hasCaseInsensitiveSibling(dir, `${base} (${i})`)) return cand
  }
  throw new FsError(500, '无法生成不冲突的项目目录名')
}

/** 递归复制目录并统计文件数 / 字节数（跳过符号链接等特殊条目防环，与 buildTreeNode 处理一致） */
function copyTreeCounted(src: string, dest: string, counter: { files: number; bytes: number }): void {
  fs.mkdirSync(dest, { recursive: true })
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return // 源目录不可读：返回已复制部分（statSync 已确认顶层目录存在）
  }
  for (const ent of entries) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      copyTreeCounted(s, d, counter)
    } else if (ent.isFile()) {
      const st = fs.statSync(s)
      fs.copyFileSync(s, d)
      counter.files++
      counter.bytes += st.size
    }
    // 符号链接等特殊类型忽略（源可能含 node_modules junction 等，防环）
  }
}

/**
 * 源文件夹缺 project.json 时补最小脚手架（PLAN §4.1）：
 * 标准目录补齐 → 探测 mainUI → 写最小 project.json（无任何 ui/*.ui.json 时新建空 main.ui.json）。
 */
function scaffoldProject(projectDir: string, name: string): void {
  for (const dir of PROJECT_DIRS) fs.mkdirSync(path.join(projectDir, dir), { recursive: true })
  let mainUI = detectMainUI(projectDir)
  if (!mainUI) {
    mainUI = 'ui/main.ui.json'
    fs.mkdirSync(path.dirname(path.join(projectDir, mainUI)), { recursive: true })
    fs.writeFileSync(path.join(projectDir, mainUI), JSON.stringify(EMPTY_MAIN_UI, null, 2), 'utf8')
  }
  const pf: ProjectFile = {
    name,
    mainUI,
    engineVersion: ENGINE_VERSION,
    plugins: {},
  }
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(pf, null, 2), 'utf8')
}

/** mainUI 探测：ui/ 目录下第一个 *.ui.json（按 COLLATOR 排序保证确定性），没有则 null */
function detectMainUI(projectDir: string): string | null {
  const uiDir = path.join(projectDir, 'ui')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(uiDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ui.json'))
    .map((e) => e.name)
    .sort((a, b) => COLLATOR.compare(a, b))
  return candidates.length > 0 ? `ui/${candidates[0]}` : null
}

/** 补脚手架时新建的空 main.ui.json（结构与 templates/empty 的 UI 资产一致） */
const EMPTY_MAIN_UI = {
  version: 2,
  name: 'main',
  root: {
    id: 'ui_root',
    name: 'root',
    type: 'vbox',
    transform: { position: { x: 0, y: 0 }, size: { w: 960, h: 640 }, rotation: 0 },
    theme: { padding: 8 },
    props: { spacing: 4 },
    children: [],
  },
}
