/**
 * Blueprint Studio v2 —— 脚本内建 API 公共出口（T3.2）
 *
 * （本文件已替换 T3.1 的临时验证桩——桩只导出 scriptTypesExtension 空实现，
 *  本出口保持同名同签名导出，T3.1 的 `import { scriptTypesExtension } from '@/script/api'`
 *  无需改动即获得真实补全扩展。）
 *
 * 三个消费面：
 *  - T3.1 脚本编辑器（咬合点）：`import { scriptTypesExtension } from '@/script/api'`
 *    加进 CodeMirror 扩展列表，即得内建全局 + 成员补全（签名 detail / 文档 info）；
 *    用户脚本的类型环境文件为 ./types.d.ts（T3.1 把该路径注入编辑器 TS 环境）。
 *  - T3.3 转译执行链（沙箱全局）：`import { createScriptGlobals } from '@/script/api'`，
 *    按 ScriptGlobalsOptions 接线 UiHandle / RuntimeHandle 构造脚本执行环境。
 *  - 蓝图⇄脚本互转（T3.4/T3.6）：ScriptGlobals 接口即受控子集可引用的全局清单真源。
 */
export {
  createScriptGlobals,
  knownUIAttrNames,
  PLUGIN_BRIDGE_MISSING,
  type ScriptGlobalsOptions,
} from './ts';
export {
  makeScriptCompletionSource,
  scriptCompletionSource,
  scriptTypesExtension,
  type ScriptCompletionOptions,
} from './completion';
export type {
  ConvertApi,
  LogRow,
  PluginNamespace,
  PluginsAccessor,
  ScriptEventHandler,
  ScriptGlobals,
  UIAccessor,
  UIAttrName,
  UIListRow,
  UINodeAttrs,
  VarsAccessor,
} from './types';

// T4.2: createScriptGlobalsPy —— Python 侧同构内建全局（snake_case 别名：ui/vars/emit/
// on_event/plugins/print/convert/format/delay）届时在此导出，与 TS 侧共享同一运行语义。
// 本期（T3.2）不做实现——PLAN §9.2「Python 对等」属 T4.x 范围。
