/**
 * 资源库函数资产模板（新建函数弹窗用）
 *
 * 函数图骨架与蓝图内新建一致（函数入口 + 函数出口，见 functionAsset.ts）。
 */
import { functionSkeletonNodes } from '@/blueprint/functionAsset'

/** 函数资产 JSON（version 3 契约：单图 + 空签名 + 入口/出口骨架） */
export function functionShellOf(name: string): string {
  return JSON.stringify(
    {
      version: 3,
      kind: 'function',
      scope: 'global',
      name,
      params: [],
      returns: [],
      graph: { nodes: functionSkeletonNodes(), edges: [] },
    },
    null,
    2,
  )
}
