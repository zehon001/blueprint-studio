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
  /** 项目内样式表路径（ui/styles/*.uss.json） */
  projectStyles?: Iterable<string>
  /** 项目内预制体路径（ui/prefabs/*.ui.json） */
  projectPrefabs?: Iterable<string>
  /** 内置库清单（离线时省略 -> 跳过 ref-library-missing） */
  library?: LibraryManifestLite
  /** 可解析的项目/全局函数名（省略则跳过作用于项目/全局的 ref-function-missing） */
  externalFunctions?: Iterable<string>
  /** 校验上下文：内置库资产不得引用项目资产（PLAN §7.3） */
  scope?: 'project' | 'library'
}

function issue(
  code: string,
  message: string,
  extra: Pick<Partial<ValidationIssue>, 'nodeId' | 'edgeId' | 'graphName'> = {},
): ValidationIssue {
  return { code, severity: 'error', message, graphName: '', ...extra }
}

/** 校验一个 UI 资产树（先序，稳定输出） */
export function validateUIAssetRefs(input: UIAssetValidationInput): ValidationIssue[] {
  const { asset, styleClasses } = input
  const projectElements = input.projectElements ? new Set(input.projectElements) : null
  const projectStyles = input.projectStyles ? new Set(input.projectStyles) : null
  const projectPrefabs = input.projectPrefabs ? new Set(input.projectPrefabs) : null
  const libElements = input.library?.elements ? new Set(input.library.elements) : null
  const libStyles = input.library?.styles ? new Set(input.library.styles) : null
  const out: ValidationIssue[] = []

  // 资产 styles 引用：@library 缺失 / 项目样式表文件不存在
  for (const ref of asset.styles ?? []) {
    if (ref.startsWith('@library/styles/')) {
      const name = ref.slice('@library/styles/'.length)
      if (libStyles && !libStyles.has(name)) {
        out.push(issue('ref-library-missing', `样式表引用的内置库条目不存在：${name}`))
      }
    } else if (input.scope === 'library') {
      out.push(issue('ref-element-boundary', `内置资产不得引用项目样式表：${ref}`))
    } else if (projectStyles && !projectStyles.has(ref)) {
      out.push(issue('ref-style-missing', `样式表文件不存在：${ref}`))
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
      } else if (input.scope === 'library') {
        out.push(
          issue('ref-element-boundary', `内置元素不得引用项目元素：${node.element}`, {
            nodeId: node.id,
          }),
        )
      } else if (projectElements && !projectElements.has(node.element)) {
        out.push(
          issue('ref-element-boundary', `节点「${node.name}」引用的项目元素不存在：${node.element}`, {
            nodeId: node.id,
          }),
        )
      }
    }
    if (node.prefab) {
      if (input.scope === 'library') {
        out.push(
          issue('ref-element-boundary', `内置资产不得引用项目预制体：${node.prefab}`, {
            nodeId: node.id,
          }),
        )
      } else if (projectPrefabs && !projectPrefabs.has(node.prefab)) {
        out.push(
          issue('ref-element-boundary', `节点「${node.name}」引用的预制体不存在：${node.prefab}`, {
            nodeId: node.id,
          }),
        )
      }
    }
    for (const c of node.children ?? []) walk(c)
  }
  walk(asset.root)

  // ---- 图内引用（内嵌蓝图；graphName/nodeId 供 ValidationBar 跳转）----
  const names = new Set<string>()
  const collectNames = (n: UINode): void => {
    names.add(n.name)
    for (const c of n.children ?? []) collectNames(c)
  }
  collectNames(asset.root)
  const vars = new Set((asset.variables ?? []).map((v) => v.name))
  const external = input.externalFunctions ? new Set(input.externalFunctions) : null
  for (const [graphName, graph] of Object.entries(asset.graphs ?? {})) {
    for (const node of graph.nodes ?? []) {
      if (node.type === 'var.get' || node.type === 'var.set') {
        const name = String(node.params?.varName ?? '')
        if (name && !vars.has(name)) {
          out.push(
            issue('ref-variable-missing', `变量引用不存在：${name}`, {
              nodeId: node.id,
              graphName,
            }),
          )
        }
      }
      if (node.type === 'flow.call') {
        const target = String(node.params?.function ?? node.params?.graph ?? '')
        const scope = String(node.params?.scope ?? 'auto')
        if (target) {
          const inBlueprint = !!asset.graphs?.[target]
          if (scope === 'blueprint' && !inBlueprint) {
            out.push(
              issue('ref-function-missing', `蓝图函数引用不存在：${target}`, {
                nodeId: node.id,
                graphName,
              }),
            )
          } else if (scope === 'auto' && !inBlueprint) {
            // auto：蓝图 → 项目 → 全局；离线时不误报项目/全局
            if (external && !external.has(target)) {
              out.push(
                issue('ref-function-missing', `函数引用不存在（蓝图/项目/全局）：${target}`, {
                  nodeId: node.id,
                  graphName,
                }),
              )
            }
          } else if (
            (scope === 'project' || scope === 'global') &&
            external &&
            !external.has(target)
          ) {
            out.push(
              issue('ref-function-missing', `${scope === 'project' ? '全项目' : '全局'}函数引用不存在：${target}`, {
                nodeId: node.id,
                graphName,
              }),
            )
          }
        }
      }
      // 节点选择器：ui.get 的 target 参数 + 所有 UI 访问器未连线的 name 引脚
      if (node.type === 'ui.get') {
        const target = String(node.params?.target ?? '')
        if (target && !names.has(target)) {
          out.push(
            issue('ref-node-missing', `ui.get 目标节点不存在：${target}`, {
              nodeId: node.id,
              graphName,
            }),
          )
        }
      }
      if (
        ['ui.getValue', 'ui.setValue', 'ui.setText', 'ui.setVisible', 'ui.listSetItems', 'ui.setTitle'].includes(
          node.type,
        )
      ) {
        const namePin = String(node.pinDefaults?.name ?? '')
        const wired = (graph.edges ?? []).some((e) => e.kind === 'data' && e.to.node === node.id && e.to.pin === 'name')
        if (namePin && !wired && !names.has(namePin)) {
          out.push(
            issue('ref-node-missing', `${node.type} 引用的节点不存在：${namePin}`, {
              nodeId: node.id,
              graphName,
            }),
          )
        }
      }
      if (node.type === 'ui.getProp' || node.type === 'ui.setProp') {
        const target = String(node.params?.nodeName ?? node.pinDefaults?.name ?? '')
        if (target && !names.has(target)) {
          out.push(
            issue('ref-node-missing', `节点引用不存在：${target}`, {
              nodeId: node.id,
              graphName,
            }),
          )
        }
      }
    }
  }
  return out
}
