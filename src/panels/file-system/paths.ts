/**
 * 文件系统面板 —— posix 路径与文件名工具（T0.7）
 *
 * 路径约定（与服务端契约一致，见 server/fs.ts 头注释）：
 *  - 面板内部一律使用「相对安全根的 posix 相对路径」，首段 = 项目文件夹名；
 *  - 工作区 openAsset 的 assetPath 为「项目内相对路径」（见 src/shell/workspace-store.ts），
 *    两者的换算在面板组件内完成；
 *  - 用户在导入弹窗输入的 Windows 绝对路径只透传给服务端 /api/import，不参与本模块运算。
 */

/** 归一化 posix 相对路径：反斜杠转斜杠、折叠连续斜杠、去首尾装饰（保留 'MyTool/ui' 形态） */
export function normalizePosix(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
}

/** 拼接 posix 相对路径（空段与 '.' 忽略） */
export function joinPosix(...parts: string[]): string {
  return normalizePosix(parts.filter((p) => p !== '' && p !== '.').join('/'))
}

/**
 * 父目录路径：'MyTool/ui/x.json' → 'MyTool/ui'；'MyTool' → ''（'' = 安全根本身，无法再上跳）。
 */
export function parentOf(p: string): string {
  const norm = normalizePosix(p)
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? '' : norm.slice(0, idx)
}

/** 末段名（文件或目录名） */
export function baseName(p: string): string {
  const norm = normalizePosix(p)
  const idx = norm.lastIndexOf('/')
  return idx < 0 ? norm : norm.slice(idx + 1)
}

/** 小写扩展名（不含点；'main.ui.json' → 'json'，与 server/fs.ts extOf 一致） */
export function extOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

/** 双击打开的资产类型（PLAN §6.2；.ui.json 优先于裸 .json 判定） */
export type AssetOpenKind = 'ui' | 'blueprint' | 'script' | 'element' | 'style' | 'function'

export function assetKindOf(fileName: string): AssetOpenKind | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.elem.json')) return 'element'
  if (lower.endsWith('.uss.json')) return 'style'
  if (lower.endsWith('.fn.json')) return 'function'
  if (lower.endsWith('.ui.json')) return 'ui'
  if (lower.endsWith('.bp.json')) return 'blueprint'
  if (lower.endsWith('.ts') || lower.endsWith('.py')) return 'script'
  return null
}

/** 双扩展名资产后缀（最长后缀优先；v3 PLAN §3.7） */
export const ASSET_SUFFIXES = ['.ui.json', '.bp.json', '.elem.json', '.uss.json', '.fn.json'] as const

/** 文件名的双扩展名后缀（无则 ''；大小写不敏感） */
export function assetSuffixOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  for (const suffix of ASSET_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffix
  }
  return ''
}

/**
 * 资产显示主名（v3 T8.4）：双扩展名去后缀；脚本/未知文件保留完整名。
 * 例：main.ui.json → main；app.uss.json → app；a.b.ts → a.b.ts；report.final.json → report.final.json
 */
export function displayNameOf(fileName: string): string {
  const suffix = assetSuffixOf(fileName)
  if (!suffix) return fileName
  return fileName.slice(0, fileName.length - suffix.length) || fileName
}

/** 文件名的单扩展名（含点；无则 ''），用于重命名时保留 */
export function extensionOf(fileName: string): string {
  const suffix = assetSuffixOf(fileName)
  if (suffix) return suffix
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot) : ''
}

/** 扩展名图标字符（树行左侧的等宽小徽标；目录行用折叠箭头，不在此列） */
export function extLabelOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.ui.json')) return 'UI'
  if (lower.endsWith('.bp.json')) return 'BP'
  if (lower.endsWith('.elem.json')) return 'EL'
  if (lower.endsWith('.uss.json')) return 'ST'
  if (lower.endsWith('.fn.json')) return 'FN'
  switch (extOf(lower)) {
    case 'ts':
      return 'TS'
    case 'py':
      return 'PY'
    case 'js':
      return 'JS'
    case 'json':
      return '{}'
    case 'txt':
    case 'log':
    case 'md':
      return 'TXT'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return 'IMG'
    default:
      return extOf(lower) ? extOf(lower).slice(0, 3).toUpperCase() : 'F'
  }
}

/** 新建文件模板类别：v3 资产用确定性骨架，其余为空文本 */
export type NewFileTemplate = 'ui' | 'bp' | 'elem' | 'uss' | 'fn' | 'text'

export function newFileTemplateOf(fileName: string): NewFileTemplate {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.elem.json')) return 'elem'
  if (lower.endsWith('.uss.json')) return 'uss'
  if (lower.endsWith('.fn.json')) return 'fn'
  if (lower.endsWith('.ui.json')) return 'ui'
  if (lower.endsWith('.bp.json')) return 'bp'
  return 'text'
}

/** 资产名（去掉双扩展名 / 单扩展名后的主干；空主干回落文件名本身） */
export function assetStemOf(fileName: string): string {
  const base = baseName(fileName)
  const suffix = assetSuffixOf(base)
  const stem = suffix
    ? base.slice(0, base.length - suffix.length)
    : base.replace(/\.[^.]+$/, '')
  return stem || base
}

/** 新建资产事件图的入口节点（event.start = BeginPlay） */
function newStartEventNode(): Record<string, unknown> {
  return { id: 'n_start', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 120, y: 120 } }
}

/** 新建 .ui.json 的空 UI 资产（单 panel 根节点；结构对齐 src/ui-editor/schema 的 panel 默认值与 templates/empty） */
export function uiAssetTemplate(name: string): string {
  const asset = {
    version: 3,
    kind: 'scene',
    name,
    styles: [],
    root: {
      id: 'panel_root',
      name: 'root',
      type: 'panel',
      layout: { position: 'relative', size: { w: '100%', h: '100%' } },
      container: { direction: 'column', gap: 4, padding: { t: 8, r: 8, b: 8, l: 8 } },
      transform: { position: { x: 0, y: 0 }, size: { w: 400, h: 300 }, rotation: 0 },
      theme: {},
      props: {},
      children: [],
    },
    graphs: {
      event: { kind: 'event', nodes: [newStartEventNode()], edges: [], comments: [] },
    },
    layout: {},
    variables: [],
    events: [],
  }
  return `${JSON.stringify(asset, null, 2)}\n`
}

/** 新建 .bp.json 的空 IR 资产（结构对齐 src/ir/types.ts 的 IRAsset） */
export function bpAssetTemplate(name: string): string {
  const asset = {
    version: 3,
    name,
    entry: 'bind',
    graphs: { bind: { nodes: [newStartEventNode()], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
  return `${JSON.stringify(asset, null, 2)}\n`
}

/** 新建元素资产骨架（v3 ElementAsset；traits/事件/数据绑定由元素设置编辑） */
export function elementAssetTemplate(name: string): string {
  const asset = {
    version: 3,
    kind: 'element',
    name,
    traits: [],
    styles: [],
    root: {
      id: 'element_root',
      name: 'root',
      type: 'vbox',
      layout: { position: 'relative', size: { w: 320, h: 160 } },
      container: { direction: 'column', gap: 4, padding: { t: 8, r: 8, b: 8, l: 8 } },
      transform: { position: { x: 0, y: 0 }, size: { w: 320, h: 160 }, rotation: 0 },
      theme: {},
      props: {},
      children: [],
    },
    graphs: {
      event: { kind: 'event', nodes: [newStartEventNode()], edges: [], comments: [] },
    },
    layout: {},
    variables: [],
    events: [],
  }
  return `${JSON.stringify(asset, null, 2)}\n`
}

/** 新建样式表骨架 */
export function styleAssetTemplate(name: string): string {
  return `${JSON.stringify({ version: 1, classes: { [name]: { props: {} } } }, null, 2)}\n`
}

/** 新建函数资产骨架（项目/全局由创建入口决定 scope；这里给 project 默认） */
export function functionAssetTemplate(name: string, scope: 'project' | 'global' = 'project'): string {
  return `${JSON.stringify(
    {
      version: 3,
      kind: 'function',
      scope,
      name,
      params: [],
      returns: [],
      graph: { nodes: [], edges: [] },
    },
    null,
    2,
  )}\n`
}

/** 按文件名决定新建文件内容：v3 资产用模板，其余空文本（经 PUT /api/file 写入） */
export function contentForNewFile(fileName: string): string {
  const kind = newFileTemplateOf(fileName)
  const name = assetStemOf(fileName)
  if (kind === 'ui') return uiAssetTemplate(name)
  if (kind === 'bp') return bpAssetTemplate(name)
  if (kind === 'elem') return elementAssetTemplate(name)
  if (kind === 'uss') return styleAssetTemplate(name)
  if (kind === 'fn') return functionAssetTemplate(name)
  return ''
}

/** 文件 / 目录名合法性（与服务端 validateProjectName 同规则的文件级子集），返回错误提示或 null */
export function validateFileName(raw: string): string | null {
  const name = raw.trim().replace(/[. ]+$/, '')
  if (!name) return '名称不能为空'
  if (name.length > 255) return '名称过长（不超过 255 字符）'
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return '名称不能包含 \\ / : * ? " < > | 或控制字符'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    return `名称使用了 Windows 保留设备名：${name}`
  }
  return null
}

/**
 * 在已有兄弟名中生成不冲突的名字（同名时追加 ` (2)` / ` (3)` 后缀，与 server/fs.ts
 * uniqueSibling 同形；大小写不敏感比较，跨平台行为一致）。新建文件 / 文件夹与
 * 拖入导入命名都用它（PUT /api/file 会静默覆盖同名文件，必须先去重）。
 * 双扩展名资产（.ui.json / .bp.json）后缀加在主干上：a.ui.json → a (2).ui.json。
 */
export function dedupeName(existing: readonly string[], desired: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  if (!taken.has(desired.toLowerCase())) return desired
  const doubleExt = desired.match(/\.(ui|bp)\.json$/i)
  const base = doubleExt && doubleExt.index !== undefined ? desired.slice(0, doubleExt.index) : desired
  const ext = doubleExt
    ? desired.slice(doubleExt.index)
    : desired.lastIndexOf('.') > 0
      ? desired.slice(desired.lastIndexOf('.'))
      : ''
  for (let i = 2; i < 1000; i++) {
    const cand = `${base} (${i})${ext}`
    if (!taken.has(cand.toLowerCase())) return cand
  }
  return desired
}

/* ============================================================
 * .history 历史快照展示工具（T7.4）
 * ============================================================ */

/**
 * 快照时间戳 → 展示文本：'20261017-142530-123' → '2026-10-17 14:25:30.123'；
 * 同毫秒冲突序号（-002）显示为 '…123 ·2'；非法时间戳原样返回（服务端契约变化时兜底）。
 */
export function historyTsLabel(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})(?:-(\d+))?$/.exec(ts)
  if (!m) return ts
  const [, y, mo, d, h, mi, s, ms, seq] = m
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}${seq ? ` ·${Number(seq)}` : ''}`
}

/** 字节数展示（1024 进制）：B / KB / MB；≥10 取整，<10 保留 1 位小数；非法输入 '?' */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}
