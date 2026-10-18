/**
 * 活动面板保存分发（v3）
 *
 * 多个资产 tab 同时打开时，全局 file.save 不能由「最后挂载的面板」独占；
 * 各编辑器按 dock 面板 id 注册保存函数，快捷键/顶栏保存统一投递给 activePanelId。
 */
type SaveHandler = () => void | boolean | Promise<void | boolean>

const handlers = new Map<string, SaveHandler>()

export function registerSaveHandler(panelId: string, handler: SaveHandler): () => void {
  handlers.set(panelId, handler)
  return () => {
    if (handlers.get(panelId) === handler) handlers.delete(panelId)
  }
}

/** 执行指定面板的保存（未注册返回 false） */
export function runSaveHandler(panelId: string | null | undefined): Promise<boolean> {
  if (!panelId) return Promise.resolve(false)
  const handler = handlers.get(panelId)
  if (!handler) return Promise.resolve(false)
  return Promise.resolve(handler()).then((r) => r !== false)
}
