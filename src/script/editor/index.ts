/**
 * Blueprint Studio v2 —— 脚本编辑器公共出口（T3.1）
 *
 * 工作区接入（dock 面板，仿 BlueprintTab / UITab）：
 *   import { ScriptTab } from '@/script/editor';
 *   // src/shell/dock/placeholderPanels.tsx 的中央工作区 switch 中：
 *   case 'script': return <ScriptTab assetPath={active.assetPath} />;
 * 加载（GET /api/file）/ 保存（Ctrl+S → PUT /api/file → 清脏）/ 脏标记
 * （防抖 300ms）均由 ScriptTab 自包含，无需额外接线。
 *
 * 后续任务接线方式：
 *  - T3.2 内建 API：@/script/api 的 scriptTypesExtension() 已在 TS 模式挂载
 *    （ScriptEditor.languageExtensionOf），补全随类型包自动生效；
 *  - T3.5 codegen / T3.8 双视图同步：ViewSwitch 独立导出可直接复用；
 *    ScriptEditor.onReady 暴露 EditorView（诊断 / 同步协议接入点）；
 *  - T3.6 解析器：syntaxDiagnosticsExtension() 空占位替换为 linter()；
 *    ScriptTab 蓝图视图占位面板（BlueprintPlaceholder）替换为
 *    BlueprintEditorPanel 受控渲染（接线点见 ScriptTab.tsx）；
 *  - 只读 codegen 文本：直接复用 <ScriptEditor path value readOnly />。
 */
import './script-editor.css';

export { ScriptTab, type ScriptTabProps } from './ScriptTab';
export {
  ScriptEditor,
  buildScriptExtensions,
  createScriptState,
  makeSaveCommand,
  syntaxDiagnosticsExtension,
  type ScriptEditorProps,
  type ScriptExtensionOptions,
} from './ScriptEditor';
export { ViewSwitch, type ScriptViewKind, type ViewSwitchProps } from './ViewSwitch';
export {
  BlueprintPlaceholder,
  type BlueprintPlaceholderProps,
} from './BlueprintPlaceholder';
export {
  createDraftTracker,
  type DraftTracker,
} from './draft';
export {
  scanScriptAnnotations,
  scriptLanguageOf,
  type ScriptLanguage,
  type ScriptScanSummary,
} from './scan';
