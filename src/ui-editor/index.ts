/**
 * UI 编辑器公共出口（T1.3）
 *
 * 工作区接线（PM，与 BlueprintTab 同构的 UITab 包装层）：
 *   import { UIEditorPanel, useUIEditorStore } from '@/ui-editor';
 *   // tab 挂载时按项目上下文加载资产（store 负责 GET /api/file + scene-tree 域装载）：
 *   await useUIEditorStore.getState().openUIAsset(project.path, 'ui/main.ui.json');
 *   <UIEditorPanel />   // 视口自动随 scene-tree 域资产渲染；选择态/命令均走共享 store
 *
 * 后续任务接线方式：
 *  - T1.4 UI 树面板：useSceneTreeDomain()（asset）+ useUIEditorStore（selection）联动；
 *    删除 / 复制复用 '@/ui-editor/viewport' 的 commands（同一命令域，撤销语义一致）；
 *  - T1.5 检视器：getUISchema / defaultPropsFor（'@/ui-editor/schema'）+ setSelection 联动；
 *    位置属性编辑可复用 viewport/commands 的 commitMoves（「视口：」前缀改用「检视器：」由调用方传 label）。
 */
export { UIEditorPanel } from './viewport';
export { useUIEditorStore, useSceneTreeDomain } from './store';
