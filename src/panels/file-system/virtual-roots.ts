/**
 * 文件系统虚拟根
 *
 * 统一文件树显示两层：
 *  - assets：当前项目真实文件（虚拟前缀，不移动磁盘内容；项目库 library/ 照常显示）；
 *  - internal-library：内置库（独立安全根），显示为 functions/ 目录。
 *
 * 本模块只做显示路径 ⇄ 真实路径 / 资产路径的纯映射，不访问网络。
 */
import { joinPosix, normalizePosix } from './paths'
import { sortNodes, sortTree, type FsNode } from './tree-model'

/** 虚拟根（不会与真实项目 / 库路径冲突） */
export const VIRTUAL_ROOT = '@fs'
export const ASSETS_ROOT = `${VIRTUAL_ROOT}/assets`
export const INTERNAL_LIBRARY_ROOT = `${VIRTUAL_ROOT}/internal-library`
/** 内置库函数目录（与真实存储同名） */
export const FUNCTIONS_DIR = 'functions'
export const INTERNAL_FUNCTION_DIR = `${INTERNAL_LIBRARY_ROOT}/${FUNCTIONS_DIR}`

export type VirtualZone = 'root' | 'assets' | 'internal-library'

/** 内置库函数条目（GET /api/library/list 的最小字段） */
export interface BuiltinFunctionEntry {
  name: string
}

export function virtualZoneOf(path: string): VirtualZone | null {
  const p = normalizePosix(path)
  if (p === VIRTUAL_ROOT) return 'root'
  if (p === ASSETS_ROOT || p.startsWith(`${ASSETS_ROOT}/`)) return 'assets'
  if (p === INTERNAL_LIBRARY_ROOT || p.startsWith(`${INTERNAL_LIBRARY_ROOT}/`)) {
    return 'internal-library'
  }
  return null
}

/** displayPath 在 root 下的相对段（root 自身返回 ''） */
function relUnder(path: string, root: string): string {
  return path === root ? '' : path.slice(root.length + 1)
}

/** 项目内相对路径 → 统一文件树显示路径 */
export function displayPathForProjectRel(rel: string): string {
  const p = normalizePosix(rel)
  if (p === '') return ASSETS_ROOT
  return `${ASSETS_ROOT}/${p}`
}

/** 真实项目路径（绝对/安全根相对均可，需带项目文件夹名）→ 显示路径 */
export function displayPathForReal(projectPath: string, realPath: string): string | null {
  const proj = normalizePosix(projectPath)
  const real = normalizePosix(realPath)
  if (real === proj) return ASSETS_ROOT
  if (!proj || !real.startsWith(`${proj}/`)) return null
  return displayPathForProjectRel(real.slice(proj.length + 1))
}

/** 显示路径 → 项目内相对路径；虚拟库根 / 非项目路径返回 null */
export function projectRelPathOfDisplay(displayPath: string): string | null {
  const zone = virtualZoneOf(displayPath)
  if (!zone) return null
  const p = normalizePosix(displayPath)
  if (zone === 'root') return ''
  if (zone === 'assets') return relUnder(p, ASSETS_ROOT)
  return null
}

/** 显示路径 → 真实路径（相对安全根 posix）；内置库 / 虚拟根返回 null */
export function displayToRealPath(projectPath: string, displayPath: string): string | null {
  const rel = projectRelPathOfDisplay(displayPath)
  return rel === null ? null : joinPosix(projectPath, rel)
}

/** 显示路径 → 资产路径（openAssetPanel 参数）；目录 / 虚拟根返回 null */
export function assetPathOfDisplay(displayPath: string): string | null {
  const zone = virtualZoneOf(displayPath)
  if (!zone) return null
  if (zone === 'internal-library') {
    const name = internalLibraryEntryName(displayPath)
    return name ? `@library/functions/${name}` : null
  }
  const rel = projectRelPathOfDisplay(displayPath)
  if (rel === null) return null
  const file = normalizePosix(displayPath)
  if (!/\.[^/]+$/.test(file)) return null
  return rel
}

/** 内置库函数文件 → 条目名（去掉 .fn.json）；非内置库文件返回 null */
export function internalLibraryEntryName(displayPath: string): string | null {
  const p = normalizePosix(displayPath)
  if (!p.startsWith(`${INTERNAL_FUNCTION_DIR}/`)) return null
  const rel = relUnder(p, INTERNAL_FUNCTION_DIR)
  if (rel === '' || rel.includes('/')) return null
  return rel.replace(/\.fn\.json$/i, '')
}

/** 是否内置库函数文件 */
export function isInternalLibraryFile(displayPath: string): boolean {
  return internalLibraryEntryName(displayPath) !== null
}

/** 是否资源库目录（internal-library 及其子目录，不含文件） */
export function isLibraryDirectory(node: FsNode): boolean {
  if (node.type !== 'dir') return false
  return virtualZoneOf(node.path) === 'internal-library'
}

function fileNameOfEntry(entry: BuiltinFunctionEntry): string {
  return entry.name.toLowerCase().endsWith('.fn.json') ? entry.name : `${entry.name}.fn.json`
}

function mapProjectNode(node: FsNode, parentDisplayPath: string): FsNode {
  const path = joinPosix(parentDisplayPath, node.name)
  return {
    ...node,
    path,
    children: node.children.map((child) => mapProjectNode(child, path)),
  }
}

export interface MergedTreeOptions {
  projectName: string
  /** GET /api/tree?path=<项目> 的原始树 */
  projectTree: FsNode
  /** GET /api/library/list?kind=functions 的条目 */
  builtinFunctions: readonly BuiltinFunctionEntry[]
}

/** 构建统一的虚拟根树：assets + internal-library */
export function buildMergedTree(opts: MergedTreeOptions): FsNode {
  const assetsChildren = opts.projectTree.children
    .filter((child) => !(child.type === 'file' && child.name.toLowerCase() === 'project.json'))
    .map((child) => mapProjectNode(child, ASSETS_ROOT))

  const builtinFiles: FsNode[] = opts.builtinFunctions.map((entry) => {
    const name = fileNameOfEntry(entry)
    return {
      name,
      path: `${INTERNAL_FUNCTION_DIR}/${name}`,
      type: 'file',
      ext: 'json',
      children: [],
    }
  })

  return sortTree({
    name: opts.projectName,
    path: VIRTUAL_ROOT,
    type: 'dir',
    ext: '',
    children: [
      {
        name: 'assets',
        path: ASSETS_ROOT,
        type: 'dir',
        ext: '',
        children: sortNodes(assetsChildren),
      },
      {
        name: 'internal-library',
        path: INTERNAL_LIBRARY_ROOT,
        type: 'dir',
        ext: '',
        children: [
          {
            name: FUNCTIONS_DIR,
            path: INTERNAL_FUNCTION_DIR,
            type: 'dir',
            ext: '',
            children: sortNodes(builtinFiles),
          },
        ],
      },
    ],
  })
}

/** 默认展开：根 + 两个分区 + 内置库 functions 目录 */
export function defaultExpandedPaths(): string[] {
  return [
    VIRTUAL_ROOT,
    ASSETS_ROOT,
    INTERNAL_LIBRARY_ROOT,
    INTERNAL_FUNCTION_DIR,
  ]
}
