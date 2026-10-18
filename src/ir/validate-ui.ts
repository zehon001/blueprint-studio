/**
 * UIAsset v3 引用完整性校验（v3 T13.1 · PLAN §11）
 *
 * 与 IR 校验器分离：这里做跨文件/库清单校验（样式类、元素引用、库条目）。
 * 输入为已装载资产 + 已解析样式类集合 + 可选库清单；离线时调用方跳过库缺失。
 */
import type { UIAsset, UINode } from './types'
import type { ValidationIssue } from './validate'

export interface LibraryManifestLite {
  elements?: Iterable<string>
  styles?: Iterable<string>
  functions?: Iterable<string>
}

export interface UIAssetValidationInput {
  asset: UIAsset
  /** 已应用样式表中全部类名（union） */
  styleClasses: ReadonlySet<string>
  /** 项目内元素路径（ui/elements/*.elem.json） */
  projectElements?: Iterable<string>
  /** 内置库清单（离线时省略 -> 跳过 ref-library-missing） */
  library?: LibraryManifestLite
}

function issue(
  code: string,
  message: string,
  extra: Pick<Partial<ValidationIssue>, 'nodeId' | 'edgeId'> = {},
): ValidationIssue {
  return { code, severity: 'error', message, graphName: '', ...extra }
}

/** 校验一个 UI 资产树（先序，稳定输出） */
export function validateUIAssetRefs(input: UIAssetValidationInput): ValidationIssue[] {
  const { asset, styleClasses } = input
  const projectElements = input.projectElements ? new Set(input.projectElements) : null
  const libElements = input.library?.elements ? new Set(input.library.elements) : null
  const libStyles = input.library?.styles ? new Set(input.library.styles) : null
  const out: ValidationIssue[] = []

  // 资产 styles 引用：@library/styles/<name> 缺失；项目相对路径由装载层处理
  for (const ref of asset.styles ?? []) {
    if (ref.startsWith('@library/styles/')) {
      const name = ref.slice('@library/styles/'.length)
      if (libStyles && !libStyles.has(name)) {
        out.push(issue('ref-library-missing', `样式表引用的内置库条目不存在：${name}`))
      }
    }
  }

  const walk = (node: UINode): void => {
    for (const cls of node.classes ?? []) {
      if (!styleClasses.has(cls)) {
        out.push(
          issue('ref-style-missing', `节点「${node.name}」挂的样式类不存在：.${cls}`, {
            nodeId: node.id,
          }),
        )
      }
    }
    if (node.element) {
      if (node.element.startsWith('@library/elements/')) {
        const name = node.element.slice('@library/elements/'.length)
        if (libElements && !libElements.has(name)) {
          out.push(
            issue('ref-library-missing', `节点「${node.name}」引用的内置元素不存在：${name}`, {
              nodeId: node.id,
            }),
          )
        }
      } else if (projectElements && !projectElements.has(node.element)) {
        out.push(
          issue('ref-element-boundary', `节点「${node.name}」引用的项目元素不存在：${node.element}`, {
            nodeId: node.id,
          }),
        )
      }
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(asset.root)
  return out
}
