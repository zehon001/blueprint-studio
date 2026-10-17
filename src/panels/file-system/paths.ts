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
export type AssetOpenKind = 'ui' | 'blueprint' | 'script'

export function assetKindOf(fileName: string): AssetOpenKind | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.ui.json')) return 'ui'
  if (lower.endsWith('.bp.json')) return 'blueprint'
  if (lower.endsWith('.ts') || lower.endsWith('.py')) return 'script'
  return null
}

/** 扩展名图标字符（树行左侧的等宽小徽标；目录行用折叠箭头，不在此列） */
export function extLabelOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.ui.json')) return 'UI'
  if (lower.endsWith('.bp.json')) return 'BP'
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

/** 新建文件模板类别：.ui.json / .bp.json 用确定性模板，其余为空文本 */
export type NewFileTemplate = 'ui' | 'bp' | 'text'

export function newFileTemplateOf(fileName: string): NewFileTemplate {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.ui.json')) return 'ui'
  if (lower.endsWith('.bp.json')) return 'bp'
  return 'text'
}

/** 资产名（去掉 .ui.json / .bp.json / 单扩展名后的主干；空主干回落文件名本身） */
export function assetStemOf(fileName: string): string {
  const base = baseName(fileName)
  const stem = base.replace(/\.(ui|bp)\.json$/i, '').replace(/\.[^.]+$/, '')
  return stem || base
}

/** 新建 .ui.json 的空 UI 资产（单 panel 根节点；结构对齐 src/ui-editor/schema 的 panel 默认值与 templates/empty） */
export function uiAssetTemplate(name: string): string {
  const asset = {
    version: 2,
    name,
    root: {
      id: 'panel_root',
      name: 'root',
      type: 'panel',
      transform: { position: { x: 0, y: 0 }, size: { w: 400, h: 300 }, rotation: 0 },
      theme: {},
      props: { padding: 8 },
      children: [],
    },
  }
  return `${JSON.stringify(asset, null, 2)}\n`
}

/** 新建 .bp.json 的空 IR 资产（结构对齐 src/ir/types.ts 的 IRAsset） */
export function bpAssetTemplate(name: string): string {
  const asset = {
    version: 2,
    name,
    entry: 'bind',
    graphs: { bind: { nodes: [], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
  return `${JSON.stringify(asset, null, 2)}\n`
}

/** 按文件名决定新建文件内容：.ui.json / .bp.json 用模板，其余空文本（经 PUT /api/file 写入） */
export function contentForNewFile(fileName: string): string {
  const kind = newFileTemplateOf(fileName)
  if (kind === 'ui') return uiAssetTemplate(assetStemOf(fileName))
  if (kind === 'bp') return bpAssetTemplate(assetStemOf(fileName))
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
