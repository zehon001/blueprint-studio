/**
 * 元素实例插入（元素库点击/拖入画布共用，v3 T11.7）
 */
import { getSceneTreeDomain, newUINodeId, runUICommand, useUIEditorStore } from './store'
import { collectNames } from './viewport/commands'
import { uniqueName } from './viewport/geometry'
import type { UINode } from '@/ir/types'

/** 在根节点下插入元素实例；返回新节点 id（失败 null） */
export function insertElementInstance(path: string, suggestedName: string, at: { x: number; y: number }): string | null {
  const asset = getSceneTreeDomain().asset
  if (!asset) return null
  const id = newUINodeId()
  const name = uniqueName(suggestedName, collectNames(asset.root))
  runUICommand(`元素库：添加元素 ${suggestedName}`, (draft) => {
    const root = (draft as { root: UINode }).root
    const node: UINode = {
      id,
      name,
      type: '__element',
      element: path,
      transform: { position: { x: at.x, y: at.y }, size: { w: 320, h: 120 }, rotation: 0 },
      layout: { size: { w: 320, h: 120 } },
      theme: {},
      props: {},
      children: [],
    }
    root.children.push(node)
  })
  useUIEditorStore.getState().setSelection([id])
  return id
}

/** 在根节点下插入预制体实例；返回新节点 id（失败 null） */
export function insertPrefabInstance(path: string, suggestedName: string, at: { x: number; y: number }): string | null {
  const asset = getSceneTreeDomain().asset
  if (!asset) return null
  const id = newUINodeId()
  const name = uniqueName(suggestedName, collectNames(asset.root))
  runUICommand(`元素库：添加预制体 ${suggestedName}`, (draft) => {
    const root = (draft as { root: UINode }).root
    const node: UINode = {
      id,
      name,
      type: 'panel',
      prefab: path,
      transform: { position: { x: at.x, y: at.y }, size: { w: 320, h: 120 }, rotation: 0 },
      layout: { size: { w: 320, h: 120 } },
      theme: {},
      props: {},
      children: [],
    }
    root.children.push(node)
  })
  useUIEditorStore.getState().setSelection([id])
  return id
}

/** 元素库拖拽 MIME（UI 视口 drop 用） */
export const ELEMENT_DRAG_MIME = 'application/x-bps-ui-element'
export const CONTROL_DRAG_MIME = 'application/x-bps-ui-control'
export const PREFAB_DRAG_MIME = 'application/x-bps-ui-prefab'
