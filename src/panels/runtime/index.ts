/**
 * 运行模块出口（运行面板已移除）
 *
 * RuntimeHost 以隐藏 iframe 承载运行，输出并入控制台；defaultPanels 不再注册
 * `runtime` 面板，历史布局中的 runtime 页签会被 normalize 剔除。
 */
export { RuntimeHost, buildEmbedRuntimeUrl, buildExternalRuntimeUrl } from './RuntimeHost'
export {
  useRuntimeStore,
  type RuntimeTarget,
} from './store'
