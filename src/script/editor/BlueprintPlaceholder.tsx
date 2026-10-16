/**
 * 蓝图视图占位面板（T3.1 · 显式占位，不虚报）
 *
 * 职责：脚本资产切到「蓝图视图」时的渲染面。PLAN §10 设计为该脚本的 IR 经
 * BlueprintEditorPanel 受控渲染，但 IR 解析器（T3.6）未交付——本期显示占位：
 *   - 显式标注归属卡：「脚本 IR 解析由 T3.6 提供」；
 *   - 已知信息（scan.ts 正则粗扫）：资产名 / 事件数（@on）/ 暴露变量数（@expose）。
 *
 * 接线点（T3.6 交付后）：ScriptTab 以 parser-ts.ts 产出 IRAsset 替换本占位面板：
 *   <BlueprintEditorPanel asset={parsedIR} assetPath={assetPath} onSave={...} />
 * 本组件可整体删除（粗扫信息将随真实 IR 变得多余）。
 *
 * 注意：本组件不 import .css（node:test 需直接加载本文件；样式在 index.ts 统一挂）。
 */
import { scanScriptAnnotations } from './scan'

export interface BlueprintPlaceholderProps {
  /** 资产路径（占位标题展示） */
  assetPath: string
  /** 脚本源码（最近已知文本：加载内容或最新草稿） */
  source: string
  /** 脚本是否存在未保存草稿（与切换条互锁提示一致） */
  scriptDirty?: boolean
}

/** 蓝图视图占位面板（T3.6 解析器交付前的显式占位） */
export function BlueprintPlaceholder({ assetPath, source, scriptDirty = false }: BlueprintPlaceholderProps) {
  const name = assetPath.replace(/.*[/\\]/, '')
  const scan = scanScriptAnnotations(source)
  return (
    <div className="script-bp-placeholder">
      <div className="script-bp-placeholder-card">
        <div className="script-bp-placeholder-title">蓝图视图（占位）</div>
        <div className="script-bp-placeholder-badge" role="status">
          脚本 IR 解析由 T3.6 提供
        </div>
        <dl className="script-bp-placeholder-rows">
          <div className="script-bp-placeholder-row">
            <dt>资产</dt>
            <dd>{name || '(未命名)'}</dd>
          </div>
          <div className="script-bp-placeholder-row">
            <dt>事件（@on）</dt>
            <dd>
              {scan.eventCount}
              {scan.eventNames.length > 0 ? `：${scan.eventNames.join('、')}` : ''}
            </dd>
          </div>
          <div className="script-bp-placeholder-row">
            <dt>暴露变量（@expose）</dt>
            <dd>
              {scan.exposedCount}
              {scan.exposedNames.filter(Boolean).length > 0
                ? `：${scan.exposedNames.filter(Boolean).join('、')}`
                : ''}
            </dd>
          </div>
        </dl>
        <div className="script-bp-placeholder-note">
          受控子集解析器（T3.6）交付后，本视图将渲染该脚本解析出的 IR
          （BlueprintEditorPanel 受控）；
          {scriptDirty ? '当前脚本草稿未保存，以上信息基于最近已知文本。' : '以上信息来自正则粗扫（注释/字符串中的注解会误计）。'}
        </div>
      </div>
    </div>
  )
}
