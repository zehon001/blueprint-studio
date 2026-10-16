/**
 * Blueprint Studio v2 —— 插件注册表（T6.1 · Server-Agent）
 *
 * 职责（PLAN §14.1 / docs/v2/adr/004-plugin-manifest.md）：
 *  - 清单 schema 校验 validateManifest（中文错误，单清单失败不炸注册表）
 *  - 清单规范化 normalizeManifest（缺省 description/source 补全、nodes 空数组 OK、节点 kind 缺省 action）
 *  - 三源扫描合并：内置 <repo>/plugins-registry/（随引擎分发）+ 项目级 <project>/plugins/（FS 安全根内）
 *    + 服务端静态目录 <repo>/_plugins-static/；合并去重 by 插件 id，优先级定案（T6.1）：项目 > 静态 > 内置
 *  - HTTP handler（供 index.ts 追加路由调用，也可直测）：
 *      GET /api/plugins?project=<项目>       → { ok, manifests, warnings }
 *      GET /api/plugins/:id?project=<项目>   → { ok, manifest }
 *
 * 明确不做（后续卡，留扩展点）：detect / install / update 执行器（T6.3，将在此模块旁加
 * executor.ts 并追加 POST /api/plugins/:id/detect|install|update 路由）、插件节点动态注册
 * （T6.4，src/nodes/dynamic.ts）、adb 调用实现（T6.5）、飞书 CLI 功能本体（T6.6）。
 *
 * 节点 id 前缀约定：插件节点 id 必须带「插件 id 对应前缀」——取插件 id 的 camelCase 形式
 * 加 '.'（phone-log → 'phoneLog.'、feishu-cli → 'feishuCli.'，与 ADR-004 示例一致）；
 * 兼容字面 `${pluginId}.` 写法。见 pluginNodePrefix / isPluginNodeId。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PluginManifest, PluginNodeSpec } from '../../src/ir/types'
import { mergeManifests } from '../../src/ir/types'
import { repoRoot, resolveProjectScoped } from '../fs'

/* ============================================================
 * 常量
 * ============================================================ */

/** 内置清单目录（相对仓库根，随引擎分发） */
export const BUILTIN_REGISTRY_DIRNAME = 'plugins-registry'

/** 服务端静态目录（相对仓库根；.gitignore 由 PM 维护，目录不存在时该源为空） */
export const STATIC_PLUGINS_DIRNAME = '_plugins-static'

/** 安装策略枚举（与 src/ir/types.ts InstallStrategy 对齐） */
const INSTALL_STRATEGIES: readonly string[] = ['winget', 'npm-global', 'download-zip', 'custom-cmd']

/* ============================================================
 * 节点 id 前缀（插件 id ↔ 节点前缀映射，T6.4 dynamic 注册同样使用）
 * ============================================================ */

/**
 * 插件节点的规范前缀：插件 id 的 kebab/snake → camelCase 后加 '.'。
 * 'phone-log' → 'phoneLog.'；'feishu-cli' → 'feishuCli.'（与 ADR-004 示例一致）。
 */
export function pluginNodePrefix(pluginId: string): string {
  const camel = pluginId.replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase())
  return `${camel}.`
}

/** 节点 id 是否属于该插件（规范 camel 前缀或字面 `${pluginId}.` 均可） */
export function isPluginNodeId(pluginId: string, nodeId: string): boolean {
  return nodeId.startsWith(pluginNodePrefix(pluginId)) || nodeId.startsWith(`${pluginId}.`)
}

/* ============================================================
 * 清单校验（validateManifest：中文错误；一次收集全部问题）
 * ============================================================ */

/** validateManifest 的返回：ok 时 manifest 类型完备可直接使用 */
export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 校验插件清单（结构契约 = src/ir/types.ts PluginManifest / PluginNodeSpec）：
 *  - 必填：id / name / kind / nodes；id 仅允许字母数字下划线中划线（保证前缀映射确定）；
 *  - detect / install / update 可省略，出现则校验子结构
 *    （install.strategy 为 custom-cmd 时必须提供 cmd；versionRegex 必须可编译）；
 *  - 节点：id 必须带插件前缀（isPluginNodeId）、title 必填、inputs/outputs 必为数组、
 *    引脚 id/type 必填（ADR-004 规范化第 1 条：exec 引脚显式写 "type": "exec"）；
 *  - kind = 'event' 的节点（持续流）：不允许 exec 输入引脚、必须有 exec 输出引脚。
 * 不校验清单 JSON 中手写的 source（注册表统一标注覆盖，见 ADR-004）。
 */
export function validateManifest(raw: unknown): ManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, errors: ['清单必须是 JSON 对象（{...}）'] }
  const o = raw
  const errors: string[] = []

  // ---- 顶层必填字段 ----
  const pluginId = typeof o.id === 'string' ? o.id.trim() : ''
  if (!pluginId) {
    errors.push('缺少必填字段 id（非空字符串）')
  } else if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(pluginId)) {
    errors.push(`id「${pluginId}」只允许字母开头的字母 / 数字 / 下划线 / 中划线（作为节点 id 前缀使用）`)
  }
  if (typeof o.name !== 'string' || !o.name.trim()) errors.push('缺少必填字段 name（非空字符串）')
  if (o.kind !== 'cli' && o.kind !== 'custom') errors.push("kind 必须为 'cli' 或 'custom' 之一")
  if (o.description !== undefined && typeof o.description !== 'string') {
    errors.push('description 必须为字符串（可省略，规范化时补空串）')
  }
  if (!Array.isArray(o.nodes)) errors.push('缺少必填字段 nodes（数组，允许为空）')

  // ---- detect ----
  if (o.detect !== undefined) {
    if (!isPlainObject(o.detect)) {
      errors.push('detect 必须为对象（{ cmd, versionRegex? }）')
    } else {
      if (typeof o.detect.cmd !== 'string' || !o.detect.cmd.trim()) {
        errors.push('detect.cmd 必须为非空字符串（检测命令，如 "adb version"）')
      }
      if (o.detect.versionRegex !== undefined) {
        if (typeof o.detect.versionRegex !== 'string') {
          errors.push('detect.versionRegex 必须为字符串')
        } else {
          try {
            new RegExp(o.detect.versionRegex)
          } catch {
            errors.push(`detect.versionRegex 不是合法正则：${o.detect.versionRegex}`)
          }
        }
      }
    }
  }

  // ---- install ----
  if (o.install !== undefined) {
    if (!isPlainObject(o.install)) {
      errors.push(`install 必须为对象（{ strategy, args?, cmd? }，strategy ∈ ${INSTALL_STRATEGIES.join(' | ')}）`)
    } else {
      if (typeof o.install.strategy !== 'string' || !INSTALL_STRATEGIES.includes(o.install.strategy)) {
        errors.push(`install.strategy 必须为 ${INSTALL_STRATEGIES.join(' | ')} 之一`)
      }
      if (o.install.strategy === 'custom-cmd' && (typeof o.install.cmd !== 'string' || !o.install.cmd.trim())) {
        errors.push("install.strategy 为 'custom-cmd' 时必须提供非空的 install.cmd")
      }
      if (o.install.args !== undefined) {
        if (!Array.isArray(o.install.args) || o.install.args.some((a) => typeof a !== 'string')) {
          errors.push('install.args 必须为字符串数组')
        }
      }
    }
  }

  // ---- update ----
  if (o.update !== undefined) {
    if (!isPlainObject(o.update)) {
      errors.push('update 必须为对象（{ latestVersion, source }）')
    } else {
      if (typeof o.update.latestVersion !== 'string' || !o.update.latestVersion.trim()) {
        errors.push('update.latestVersion 必须为非空字符串')
      }
      if (typeof o.update.source !== 'string' || !o.update.source.trim()) {
        errors.push('update.source 必须为非空字符串（版本信息来源，如 "registry"）')
      }
    }
  }

  // ---- nodes ----
  if (Array.isArray(o.nodes)) {
    o.nodes.forEach((n, i) => validatePluginNode(n, i, pluginId, errors))
  }

  if (errors.length > 0) return { ok: false, errors }

  // 校验通过：重建类型完备的清单（丢弃未声明字段以外的引用风险；节点对象原样保留供 T6.4 使用）
  const manifest: PluginManifest = {
    id: pluginId,
    name: o.name as string,
    kind: o.kind as PluginManifest['kind'],
    description: typeof o.description === 'string' ? o.description : '',
    nodes: o.nodes as PluginNodeSpec[],
  }
  if (isPlainObject(o.detect)) {
    const d: PluginManifest['detect'] = { cmd: o.detect.cmd as string }
    if (typeof o.detect.versionRegex === 'string') d.versionRegex = o.detect.versionRegex
    manifest.detect = d
  }
  if (isPlainObject(o.install)) {
    const it: NonNullable<PluginManifest['install']> = {
      strategy: o.install.strategy as 'winget' | 'npm-global' | 'download-zip' | 'custom-cmd',
    }
    if (Array.isArray(o.install.args)) it.args = o.install.args as string[]
    if (typeof o.install.cmd === 'string') it.cmd = o.install.cmd
    manifest.install = it
  }
  if (isPlainObject(o.update)) {
    manifest.update = { latestVersion: o.update.latestVersion as string, source: o.update.source as string }
  }
  return { ok: true, manifest }
}

/** 单个插件节点校验（错误追加进 errors，不提前返回） */
function validatePluginNode(n: unknown, index: number, pluginId: string, errors: string[]): void {
  const at = `nodes[${index}]`
  if (!isPlainObject(n)) {
    errors.push(`${at} 必须为对象（NodeSpec 同构）`)
    return
  }
  if (typeof n.id !== 'string' || !n.id.trim()) {
    errors.push(`${at} 缺少 id（非空字符串）`)
  } else if (pluginId && !isPluginNodeId(pluginId, n.id)) {
    errors.push(
      `${at} 的节点 id「${n.id}」必须带插件 id 前缀「${pluginNodePrefix(pluginId)}」（或「${pluginId}.」）`,
    )
  }
  if (typeof n.title !== 'string' || !n.title.trim()) errors.push(`${at} 缺少 title（非空字符串）`)
  if (n.kind !== undefined && n.kind !== 'action' && n.kind !== 'event') {
    errors.push(`${at} 的 kind 必须为 'action' 或 'event'（省略 = 'action'）`)
  }
  validatePins(n.inputs, `${at}.inputs`, errors)
  validatePins(n.outputs, `${at}.outputs`, errors)
  // 持续流事件节点约束（ADR-004 规范化第 3 条）：无 exec 入口、有 exec 出口
  if (n.kind === 'event') {
    const hasExecIn = Array.isArray(n.inputs) && n.inputs.some((p) => isPlainObject(p) && p.type === 'exec')
    const hasExecOut = Array.isArray(n.outputs) && n.outputs.some((p) => isPlainObject(p) && p.type === 'exec')
    if (hasExecIn) errors.push(`${at} 为 event 节点（持续流），不允许 exec 输入引脚`)
    if (!hasExecOut) errors.push(`${at} 为 event 节点（持续流），必须有 exec 输出引脚`)
  }
}

/** 引脚数组校验：每项必须是含非空 id 与 type 的对象（options 出现时须为 { value, label } 数组） */
function validatePins(pins: unknown, at: string, errors: string[]): void {
  if (pins === undefined) {
    errors.push(`${at} 必须为数组（可为空数组；exec 引脚须显式 "type": "exec"）`)
    return
  }
  if (!Array.isArray(pins)) {
    errors.push(`${at} 必须为数组`)
    return
  }
  pins.forEach((p, i) => {
    const pinAt = `${at}[${i}]`
    if (!isPlainObject(p)) {
      errors.push(`${pinAt} 必须为对象（{ id, type, ... }）`)
      return
    }
    if (typeof p.id !== 'string' || !p.id.trim()) errors.push(`${pinAt} 缺少 id（非空字符串）`)
    if (typeof p.type !== 'string' || !p.type.trim()) {
      errors.push(`${pinAt} 缺少 type（必填；exec 引脚须显式 "type": "exec"）`)
    }
    if (p.options !== undefined) {
      if (!Array.isArray(p.options) || p.options.some((op) => !isPlainObject(op) || typeof op.value !== 'string' || typeof op.label !== 'string')) {
        errors.push(`${pinAt} 的 options 必须为 { value, label } 数组`)
      }
    }
  })
}

/* ============================================================
 * 清单规范化（normalizeManifest：缺省补全；不修改入参，返回副本）
 * ============================================================ */

/**
 * 规范化清单：
 *  - description 缺省补 ''；
 *  - nodes 缺省补 []（空数组 = 合法：无节点的清单仅用于检测/安装，如纯 CLI 挂载）；
 *  - 节点 kind 缺省补 'action'（T6.4 动态注册据此区分持续流节点）；
 *  - source 提供时统一标注（覆盖清单 JSON 中手写的 source——该字段由注册表按发现位置标注）。
 */
export function normalizeManifest(
  manifest: PluginManifest,
  source?: PluginManifest['source'],
): PluginManifest {
  const out: PluginManifest = {
    ...manifest,
    description: manifest.description ?? '',
    nodes: (manifest.nodes ?? []).map((node) => ({
      ...node,
      kind: node.kind ?? 'action',
      inputs: node.inputs ?? [],
      outputs: node.outputs ?? [],
    })),
  }
  if (source) out.source = source
  return out
}

/* ============================================================
 * 三源扫描与合并
 * ============================================================ */

/** 清单来源标记（由注册表按发现位置标注，不在清单 JSON 中手写） */
export type PluginSource = NonNullable<PluginManifest['source']>

const SOURCE_LABEL: Record<PluginSource, string> = {
  builtin: '内置',
  project: '项目',
  static: '静态目录',
}

/** 注册表加载结果 */
export interface RegistryLoadResult {
  /** 三源合并去重后的清单（source 已标注；同 id 高优先级源整体覆盖） */
  manifests: PluginManifest[]
  /** 单文件解析失败 / 校验失败的告警（跳过该文件，不炸注册表） */
  warnings: string[]
  /** 实际扫描的三源目录（绝对路径；project 仅在传入项目时出现） */
  sources: { builtin: string; project?: string; static?: string }
}

export interface LoadRegistryOptions {
  /** 项目安全根（同 /api/file 等的安全根，通常传 PROJECTS_ROOT） */
  projectsRoot: string
  /** 项目（相对安全根的项目文件夹名，如 'MyTool'；缺省 = 只列内置 + 静态目录） */
  projectPath?: string | null
  /** 测试 / 特殊部署用：覆盖内置清单目录（缺省 <repo>/plugins-registry/） */
  builtinDir?: string
  /** 测试 / 特殊部署用：覆盖静态目录（缺省 <repo>/_plugins-static/） */
  staticDir?: string
}

/**
 * 加载三源注册表：
 *  1. 内置 <repo>/plugins-registry/*.json（随引擎分发）
 *  2. 项目级 <project>/plugins/*.json（经 resolveProjectScoped 校验在 FS 安全根内且为有效项目）
 *  3. 服务端静态目录 <repo>/_plugins-static/*.json（.gitignore 由 PM 维护）
 *
 * 单个文件损坏 / 校验失败 → 记入 warnings 并跳过，不影响其余清单；
 * 合并去重 by 插件 id，优先级（T6.1 定案）：项目 > 静态 > 内置（同 id 项目级覆盖内置）。
 * mergeManifests 为先到先得语义，故按优先级从高到低传入 lists。
 */
export async function loadPluginRegistry(options: LoadRegistryOptions): Promise<RegistryLoadResult> {
  const builtinDir = options.builtinDir ?? path.join(repoRoot(), BUILTIN_REGISTRY_DIRNAME)
  const staticDir = options.staticDir ?? path.join(repoRoot(), STATIC_PLUGINS_DIRNAME)
  const warnings: string[] = []

  const builtin = scanManifestDir(builtinDir, 'builtin', warnings)
  const staticManifests = scanManifestDir(staticDir, 'static', warnings)

  let projectManifests: PluginManifest[] = []
  let projectPluginsDir: string | undefined
  const projectRaw = typeof options.projectPath === 'string' ? options.projectPath.trim() : ''
  if (projectRaw) {
    // 项目必须位于安全根内且含 project.json（与其他 FS API 同一校验，非法路径抛 FsError）
    const scope = resolveProjectScoped(options.projectsRoot, projectRaw)
    projectPluginsDir = path.join(scope.projectDir, 'plugins')
    projectManifests = scanManifestDir(projectPluginsDir, 'project', warnings)
  }

  const manifests = mergeManifests([projectManifests, staticManifests, builtin])
  return {
    manifests,
    warnings,
    sources: {
      builtin: builtinDir,
      ...(projectPluginsDir ? { project: projectPluginsDir } : {}),
      static: staticDir,
    },
  }
}

/**
 * 扫描一个清单目录（顶层 *.json，不递归），返回带 source 标注的规范化清单。
 * 目录不存在 / 不可读 → 空数组（该源为空）；单文件解析失败或校验失败 → warning 并跳过。
 * 同一来源内重复插件 id → 保留文件名靠前者（确定性），记 warning。
 */
function scanManifestDir(dir: string, source: PluginSource, warnings: string[]): PluginManifest[] {
  if (!fs.existsSync(dir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    warnings.push(`${SOURCE_LABEL[source]}清单目录不可读（已按空处理）${dir}：${messageOf(e)}`)
    return []
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name)
    .sort()
  const out: PluginManifest[] = []
  const seen = new Map<string, string>() // 插件 id → 首个文件名
  for (const name of files) {
    const abs = path.join(dir, name)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch (e) {
      warnings.push(`${SOURCE_LABEL[source]}清单 ${name} 解析失败，已跳过：${messageOf(e)}`)
      continue
    }
    const v = validateManifest(raw)
    if (!v.ok) {
      warnings.push(`${SOURCE_LABEL[source]}清单 ${name} 校验失败，已跳过：${v.errors.join('；')}`)
      continue
    }
    const manifest = normalizeManifest(v.manifest, source)
    const firstFile = seen.get(manifest.id)
    if (firstFile) {
      warnings.push(
        `${SOURCE_LABEL[source]}清单中存在重复插件 id「${manifest.id}」（${firstFile} 与 ${name}），保留 ${firstFile}`,
      )
      continue
    }
    seen.set(manifest.id, name)
    out.push(manifest)
  }
  return out
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ============================================================
 * HTTP handler（index.ts 追加路由调用；直调可测，无需起 socket）
 * ============================================================ */

/** 路由处理结果（index.ts 据此 sendJson；null = 非本模块路由，继续后续匹配） */
export interface PluginRouteResult {
  status: number
  payload: unknown
}

/**
 * /api/plugins 路由分发（仅 GET；其余方法返回 null 交给 index.ts 的 404 兜底，
 * T6.3 执行器在此追加 POST /api/plugins/:id/detect|install|update 扩展点）：
 *  - GET /api/plugins?project=<项目>      → { ok, manifests, warnings }
 *  - GET /api/plugins/:id?project=<项目>  → { ok, manifest }（含节点；404 = 插件不存在）
 *
 * project 缺省 = 只列内置 + 静态目录；project 非法（越权 / 非有效项目）抛 FsError，
 * 由 index.ts 统一 catch 转为 { ok: false, message } 与对应状态码。
 */
export async function handlePluginsRequest(
  method: string,
  pathname: string,
  query: URLSearchParams,
  projectsRoot: string,
  options?: Pick<LoadRegistryOptions, 'builtinDir' | 'staticDir'>,
): Promise<PluginRouteResult | null> {
  if (method !== 'GET') return null

  if (pathname === '/api/plugins') {
    const result = await loadPluginRegistry({ projectsRoot, projectPath: query.get('project'), ...options })
    return { status: 200, payload: { ok: true, manifests: result.manifests, warnings: result.warnings } }
  }

  if (pathname.startsWith('/api/plugins/')) {
    const rawId = pathname.slice('/api/plugins/'.length)
    let id: string
    try {
      id = decodeURIComponent(rawId)
    } catch {
      return { status: 400, payload: { ok: false, message: `插件 id 编码非法：${rawId}` } }
    }
    if (!id.trim()) return null // /api/plugins/ 空 id → 交回 404 兜底
    const result = await loadPluginRegistry({ projectsRoot, projectPath: query.get('project'), ...options })
    const manifest = result.manifests.find((m) => m.id === id)
    if (!manifest) {
      return { status: 404, payload: { ok: false, message: `插件不存在：${id}` } }
    }
    return { status: 200, payload: { ok: true, manifest } }
  }

  return null
}
