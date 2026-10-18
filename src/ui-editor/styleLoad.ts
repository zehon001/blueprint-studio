/**
 * 样式表引用装载（v3 T11.1/T11.5）
 *
 * 统一解析项目相对路径与 `@library/styles/<name>`；编辑视口与运行视图共用。
 * 缺失/非法样式表不阻断资产打开（由引用完整性校验报 ref-style-missing）。
 */
import { parseStyleSheet, type StyleSheet } from './styles'

/** 单个样式表引用 → 文本（@library 走资源库服务） */
export async function fetchStyleSheetText(
  projectPath: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = ref.startsWith('@library/styles/')
    ? `/api/library/read?kind=styles&name=${encodeURIComponent(ref.slice('@library/styles/'.length))}`
    : `/api/file?path=${encodeURIComponent(`${projectPath}/${ref}`)}`
  const r = await fetchImpl(url)
  const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
  if (!j.ok || typeof j.content !== 'string') throw new Error(j.message ?? `样式表读取失败：${ref}`)
  return j.content
}

/** 按 styles 数组顺序装载全部样式表（失败项跳过，不阻断） */
export async function loadStyleSheets(
  projectPath: string,
  refs: readonly string[] | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<StyleSheet[]> {
  const out: StyleSheet[] = []
  for (const ref of refs ?? []) {
    try {
      out.push(parseStyleSheet(await fetchStyleSheetText(projectPath, ref, fetchImpl)))
    } catch {
      /* 缺失不阻断；校验器报 ref-style-missing */
    }
  }
  return out
}
