/**
 * 检视器「样式类 / 匹配选择器」区（v3 T11.5）
 *
 * 展示：本资产应用的样式表、节点挂载的类、实际命中的类（表内声明顺序）与
 * 每类提供的属性键；对应 UIToolkit Inspector 的 StyleSheet / Style Class List /
 * Matching Selectors 信息架构。
 */
import { findUINode, runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import type { StyleResolution, StyleSheet } from '@/ui-editor/styles'

export function StyleClassSection(props: {
  nodeId: string
  nodeClasses: readonly string[]
  sheets: readonly StyleSheet[]
  resolution: StyleResolution
}) {
  const { asset } = useSceneTreeDomain()
  const { nodeId, nodeClasses, sheets, resolution } = props
  if (sheets.length === 0 && nodeClasses.length === 0) return null

  const removeClass = (className: string): void => {
    if (!asset) return
    runUICommand(`检视器：移除样式类 ${className}`, (draft) => {
      const n = findUINode((draft as typeof asset).root, nodeId)
      if (!n) return
      n.classes = (n.classes ?? []).filter((c) => c !== className)
    })
  }

  const inlineCount = Object.values(resolution.sources).filter((s) => s.kind === 'inline').length

  return (
    <div className="insp-group insp-style-group">
      <div className="insp-group-head insp-flex-head">
        <span className="insp-caret">▾</span>
        <span className="insp-group-title">样式类</span>
        <span className="insp-count">{nodeClasses.length}</span>
      </div>
      <div className="insp-group-body">
        <div className="insp-style-row">
          <span className="insp-flex-label">样式表</span>
          <span className="insp-style-sheets">
            {sheets.length === 0 ? (
              <span className="insp-note">（未应用）</span>
            ) : (
              sheets.map((s, i) => (
                <span key={i} className="insp-chip" title={`styles[${i}]`}>
                  表 {i + 1} · {Object.keys(s.classes).length} 类
                </span>
              ))
            )}
          </span>
        </div>
        <div className="insp-style-row">
          <span className="insp-flex-label">挂载的类</span>
          <span className="insp-style-sheets">
            {nodeClasses.length === 0 ? (
              <span className="insp-note">（无）</span>
            ) : (
              nodeClasses.map((c) => (
                <span key={c} className="insp-chip insp-chip--class">
                  .{c}
                  <button
                    type="button"
                    className="insp-chip-x"
                    title={`移除样式类 .${c}`}
                    onClick={() => removeClass(c)}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </span>
        </div>
        {resolution.classes.length > 0 ? (
          <div className="insp-style-row">
            <span className="insp-flex-label">匹配选择器</span>
            <span className="insp-style-sheets">
              {resolution.classes.map((hit) => {
                const keys = [
                  ...Object.keys(hit.def.props ?? {}),
                  ...Object.keys(hit.def.layout ?? {}).map((k) => `layout.${k}`),
                  ...Object.keys(hit.def.container ?? {}).map((k) => `container.${k}`),
                ]
                return (
                  <span key={`${hit.sheetIndex}:${hit.className}`} className="insp-chip" title={keys.join(', ')}>
                    .{hit.className} → {keys.length} 项
                  </span>
                )
              })}
            </span>
          </div>
        ) : null}
        {inlineCount > 0 ? (
          <div className="insp-style-row">
            <span className="insp-flex-label">内联覆盖</span>
            <span className="insp-note">{inlineCount} 项（检视器修改写为内联覆盖）</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
