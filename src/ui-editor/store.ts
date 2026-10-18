/**
 * UI 编辑共享 store（PM 集成胶水 · T1.3/T1.4/T1.5 的共同契约）
 *
 * 职责：当前 UI 资产（*.ui.json）的加载/保存 + 树选择态 + 场景树命令域封装。
 *
 * 域模型裁定（ADR-005 补充说明）：整个 UIAsset 挂在 'scene-tree' 命令域——
 * 树重排（T1.4）、检视器属性修改（T1.5）、视口移动（T1.3）都是同一资产的
 * 结构性变更，必须在同一个域内产生可重放的 immer 补丁；拆成 'inspector'
 * 域会导致一个资产横跨两个域、补丁无法组合。'inspector' 域保留给将来的
 * 检视器自身状态（如批量编辑缓冲）。撤销历史 label 中带上来源前缀
 * （「检视器：」「视口：」「树：」）以弥补域合并后的可读性。
 *
 * 选择态（selection）不属于命令栈：选中本身不可撤销（Godot 习惯）。
 */
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { Draft } from 'immer'
import type { UIAsset, UINode } from '@/ir/types'
import { registerDomainState, runCommand, useEditorStore } from '@/shell/commands'
import {
  clearPrefabCache,
  prefetchPrefabs,
  setPrefabLoaderContext,
} from './prefab'
import { parseStyleSheet, type StyleSheet } from './styles'
import {
  clearElementCache,
  findElementCycle,
  getCachedElement,
  prefetchElements,
  setElementLoaderContext,
} from './element'

/* ---------------- 命令域（scene-tree 持有资产） ---------------- */

export interface SceneTreeDomainState {
  /** 当前 UI 资产（未加载为 null） */
  asset: UIAsset | null
}

let domainRegistered = false
function ensureDomain(): void {
  if (!domainRegistered) {
    registerDomainState<SceneTreeDomainState>('scene-tree', { asset: null })
    domainRegistered = true
  }
}

/** 在 scene-tree 域内执行一个针对当前 UI 资产的命令（无资产时静默忽略并返回 changed=false） */
export function runUICommand(label: string, recipe: (asset: Draft<UINode> | UIAsset) => void): void {
  ensureDomain()
  runCommand<SceneTreeDomainState>('scene-tree', label, (draft) => {
    if (draft.asset) recipe(draft.asset)
  })
}

/* ---------------- 编辑器 store（非命令态） ---------------- */

export type UIEditorStatus = 'idle' | 'loading' | 'ready' | 'error'

interface UIEditorState {
  projectPath: string | null
  assetPath: string | null
  status: UIEditorStatus
  message: string
  /** 当前选中节点 id 列表（树内唯一 id；多选 = 框选/Shift） */
  selection: string[]
  /** v3 T11.1：本资产已应用的样式表（按 asset.styles 顺序） */
  styleSheets: StyleSheet[]
  /** 打开 UI 资产（加载入 scene-tree 域） */
  openUIAsset: (projectPath: string, assetPath: string) => Promise<void>
  /** 保存当前资产（JSON.stringify → PUT /api/file）；成功返回 true */
  saveUIAsset: () => Promise<boolean>
  /** 设置选中集 */
  setSelection: (ids: string[]) => void
  /** 追加选中（Shift 多选） */
  addSelection: (ids: string[]) => void
  /** 清空选中 */
  clearSelection: () => void
  /** 关闭（清空资产与选中） */
  close: () => void
}

/** 最小结构校验：JSON → UIAsset（缺字段给中文错误） */
export function parseUIAsset(text: string): UIAsset {
  const raw = JSON.parse(text) as Partial<UIAsset>
  if (!raw || typeof raw !== 'object') throw new Error('UI 资产格式错误：根节点不是对象')
  // v3 过渡期：接受 2（v2 兼容层）与 3；T13.2 版本门禁收口后只接受 3
  if (raw.version !== 2 && raw.version !== 3) {
    throw new Error(`UI 资产版本不识别：${String(raw.version)}（支持 2/3）`)
  }
  if (!raw.root || typeof raw.root !== 'object') throw new Error('UI 资产缺少 root 节点')
  return raw as UIAsset
}

export const useUIEditorStore = create<UIEditorState>()((set, get) => ({
  projectPath: null,
  assetPath: null,
  status: 'idle',
  message: '',
  selection: [],
  styleSheets: [],

  openUIAsset: async (projectPath, assetPath) => {
    ensureDomain()
    set({ projectPath, assetPath, status: 'loading', message: '', selection: [] })
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(`${projectPath}/${assetPath}`)}`)
      const json = (await r.json()) as { ok: boolean; content?: string; message?: string }
      if (!json.ok) {
        set({ status: 'error', message: json.message ?? '加载失败' })
        return
      }
      const asset = parseUIAsset(String(json.content ?? ''))
      // v3 T11.1：装载 asset.styles 声明的样式表（项目相对路径；@library/* 待 T11.4 服务接入）
      const styleSheets: StyleSheet[] = []
      for (const ref of asset.styles ?? []) {
        if (ref.startsWith('@library/')) continue
        try {
          const sr = await fetch(`/api/file?path=${encodeURIComponent(`${projectPath}/${ref}`)}`)
          const sj = (await sr.json()) as { ok: boolean; content?: string }
          if (sj.ok) styleSheets.push(parseStyleSheet(String(sj.content ?? '')))
        } catch {
          /* 样式缺失不阻断打开（校验器在 T13.1 报 ref-style-missing） */
        }
      }
      // ADR-009（T7.3）：打开资产即重建预制体缓存并预取树内全部预制体（含嵌套）——
      // 「每次打开/刷新重新拉取」就是预制体改动反射到引用处的机制；拉取失败静默
      // （渲染期占位 + 补拉兜底，不阻断打开）。
      setPrefabLoaderContext({ projectPath })
      clearPrefabCache()
      await prefetchPrefabs(asset.root)
      // v3 T11.2：元素实例预取 + 循环检测（缺失占位不阻断打开）
      setElementLoaderContext({ projectPath })
      clearElementCache()
      await prefetchElements(asset.root)
      const elementCycle = findElementCycle(asset.root, (p) => getCachedElement(p))
      if (elementCycle) throw new Error(elementCycle)
      // 装载非编辑：经 registerDomainState 替换域状态（不入 undo 栈 → 不置脏标记），
      // 并剔除该域旧历史（旧资产的补丁对新资产不再适用）
      registerDomainState<SceneTreeDomainState>('scene-tree', { asset })
      set({ status: 'ready', message: '', styleSheets })
    } catch (err) {
      set({ status: 'error', message: `解析失败：${err instanceof Error ? err.message : String(err)}` })
    }
  },

  saveUIAsset: async () => {
    ensureDomain()
    const { assetPath } = get()
    const asset = getSceneTreeDomain().asset
    if (!assetPath || !asset) return false
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${get().projectPath}/${assetPath}`, content: JSON.stringify(asset, null, 2) }),
      })
      const json = (await r.json()) as { ok: boolean; message?: string }
      if (!json.ok) {
        set({ message: `保存失败：${json.message ?? ''}` })
        return false
      }
      return true
    } catch (err) {
      set({ message: `保存失败：${String(err)}` })
      return false
    }
  },

  setSelection: (ids) => set({ selection: ids }),
  addSelection: (ids) => set((s) => ({ selection: [...new Set([...s.selection, ...ids])] })),
  clearSelection: () => set({ selection: [] }),

  close: () => {
    ensureDomain()
    // 卸载同理非编辑（见 openUIAsset 注释）：替换域状态不置脏
    registerDomainState<SceneTreeDomainState>('scene-tree', { asset: null })
    set({ projectPath: null, assetPath: null, status: 'idle', message: '', selection: [], styleSheets: [] })
  },
}))

/** React hook：订阅 scene-tree 域状态（资产/未挂载返回空壳，组件随域变更重渲染） */
/** 稳定的空域快照（useSyncExternalStore 要求同一引用；不可每次新建对象） */
const EMPTY_SCENE_TREE: SceneTreeDomainState = { asset: null }

export function useSceneTreeDomain(): SceneTreeDomainState {
  ensureDomain()
  return useEditorStore((s) => (s.domains['scene-tree'] as SceneTreeDomainState | undefined) ?? EMPTY_SCENE_TREE)
}

/** 非订阅读取（命令/事件处理器内用） */
export function getSceneTreeDomain(): SceneTreeDomainState {
  ensureDomain()
  return (useEditorStore.getState().domains['scene-tree'] as SceneTreeDomainState | undefined) ?? { asset: null }
}

/** 递归查找节点（返回节点本体或 null） */
export function findUINode(root: UINode, id: string): UINode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findUINode(c, id)
    if (hit) return hit
  }
  return null
}

/** 递归收集子树全部节点 id（含根） */
export function collectUINodeIds(root: UINode, out: string[] = []): string[] {
  out.push(root.id)
  for (const c of root.children) collectUINodeIds(c, out)
  return out
}

/** 新建节点的默认 id（nanoid 短格式，资产内唯一性由调用方兜底校验） */
export function newUINodeId(): string {
  return `n_${nanoid(8)}`
}
