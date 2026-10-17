/**
 * 插件管理面板 · 纯逻辑层（T6.2 · PLAN §14.2 / docs/v2/adr/004-plugin-manifest.md）
 *
 * 职责（全部为不触 DOM / 不发请求的纯函数，node:test 直测）：
 *  - 状态徽标推导 deriveStatus：清单 + detect 结果 → 四态
 *      未安装（灰） / 已安装·最新（绿） / 可更新（黄） / 自定义（蓝）
 *      + 过渡态 checking（检测中，UI 占位，非四态之一）。
 *    判定规则（ADR-004 定案）：
 *      · 清单无 detect（自定义插件惯例）→ 自定义；
 *      · detect 执行失败 = 未安装；
 *      · installed=false → 未安装；installed=true 且 updatable → 可更新；否则已安装·最新；
 *      · 服务端 updatable 缺省时兜底：version 与 latest 本地比较（compareVersions）。
 *  - compareVersions：点分段数值比较（'1.10' > '1.9'；容忍 'v' 前缀与缺失段）。
 *  - installCommandText：确认对话框展示文本——detect 返回的 cmd 优先，
 *    否则显示安装策略名（中文 + 参数）。
 *  - runPool：并发节流池（首次加载逐项 detect 用，并发 3）。
 */
import type { PluginManifest } from '@/ir/types'

/* ============================================================
 * 状态徽标推导
 * ============================================================ */

/** 状态徽标四态（PLAN §14.2）+ 检测中过渡态 */
export type PluginBadgeState = 'not-installed' | 'up-to-date' | 'updatable' | 'custom'

/** 徽标四态的中文文案与说明 */
export const BADGE_LABEL: Record<PluginBadgeState, string> = {
  'not-installed': '未安装',
  'up-to-date': '已安装·最新',
  updatable: '可更新',
  custom: '自定义',
}

/**
 * 执行器 detect 端点（T6.3 契约，勿 import 其代码，仅按契约消费）：
 * POST /api/plugins/:id/detect?project= → { ok, installed, version?, latest?, updatable, message? }
 */
export interface DetectResult {
  ok: boolean
  /** 是否已安装（detect 执行失败时服务端返回 false，或前端把失败按未安装处理） */
  installed: boolean
  /** 当前版本（versionRegex 解析） */
  version?: string
  /** 最新版本（update.latestVersion 透传） */
  latest?: string
  /** 是否可更新（服务端判定；缺省时前端按 version/latest 本地比较兜底） */
  updatable?: boolean
  /** 附加信息（检测失败原因等，徽标 tooltip 展示） */
  message?: string
  /** 服务端将执行的命令（确认对话框展示；T6.3 可选返回） */
  cmd?: string
}

/** 单插件 detect 状态（组件态的数据形态，渲染与测试共用） */
export type DetectEntry =
  | { phase: 'checking' }
  | { phase: 'settled'; result?: DetectResult; failure?: string }

/** deriveStatus 的输出：徽标状态 + 徽标上展示的版本信息 + 附加消息 */
export interface DerivedStatus {
  state: PluginBadgeState | 'checking'
  /** 当前版本（版本列显示） */
  version?: string
  /** 最新版本（可更新徽标显示 当前版 → 最新版） */
  latest?: string
  /** 附加消息（detect 失败原因等，tooltip） */
  message?: string
}

/**
 * 点分段版本比较：a<b → 负，a>b → 正，相等 → 0。
 * 规则：去 'v'/'V' 前缀；按 '.' 分段；段内转数字比较（NaN 退化为字符串比较）；
 * 缺失段按 0 处理（'35' 与 '35.0' 相等）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^[vV]/, '').split('.')
  const pb = b.trim().replace(/^[vV]/, '').split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0'
    const sb = pb[i] ?? '0'
    const na = Number(sa)
    const nb = Number(sb)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}

/**
 * updatable 兜底判定：服务端给了 updatable 用服务端的；
 * 缺省且 version/latest 齐全时本地比较；信息不全时保守返回 false（不乱报可更新）。
 */
export function resolveUpdatable(result: DetectResult): boolean {
  if (typeof result.updatable === 'boolean') return result.updatable
  if (result.version && result.latest) return compareVersions(result.latest, result.version) > 0
  return false
}

/**
 * 状态徽标推导（ADR-004 §1 版本判定条款的客户端落地）：
 *  - 清单无 detect → 'custom'（自定义插件不做检测，恒显示自定义 + 重载）；
 *  - detect 未回（checking）→ 'checking'（过渡态，行按钮区显示「检测中…」）；
 *  - detect 失败（failure）→ 'not-installed'（失败 = 未安装），message 带原因；
 *  - detect 成功：installed=false → 'not-installed'；
 *    installed=true 且 resolveUpdatable → 'updatable'（返回 version/latest 供徽标显示 当前版 → 最新版）；
 *    否则 → 'up-to-date'。
 */
export function deriveStatus(manifest: Pick<PluginManifest, 'detect'>, detect: DetectEntry): DerivedStatus {
  if (!manifest.detect) return { state: 'custom' }
  if (detect.phase === 'checking') return { state: 'checking' }
  if (detect.failure) return { state: 'not-installed', message: `检测失败：${detect.failure}` }
  const result = detect.result
  if (!result || !result.installed) {
    return { state: 'not-installed', message: result?.message }
  }
  const version = typeof result.version === 'string' && result.version.trim() ? result.version : undefined
  const latest = typeof result.latest === 'string' && result.latest.trim() ? result.latest : undefined
  if (resolveUpdatable(result)) return { state: 'updatable', version, latest, message: result.message }
  return { state: 'up-to-date', version, latest, message: result.message }
}

/* ============================================================
 * 安装命令展示（确认对话框）
 * ============================================================ */

/** 安装策略中文名（策略名兜底展示用） */
export function strategyLabel(strategy: string): string {
  switch (strategy) {
    case 'winget':
      return 'winget 安装'
    case 'npm-global':
      return 'npm 全局安装'
    case 'download-zip':
      return '下载 ZIP 安装'
    case 'custom-cmd':
      return '自定义命令'
    default:
      return strategy
  }
}

/**
 * 确认对话框展示的「将执行命令」文本：
 *  - detect 返回带 cmd → 直接显示该命令；
 *  - 否则 install.strategy = custom-cmd → install.cmd；
 *  - 否则显示策略名 + 参数（执行器 T6.3 按策略生成实际命令）。
 * 无 install 清单返回 null（行内提示手动安装，不弹确认框）。
 */
export function installCommandText(
  manifest: Pick<PluginManifest, 'install'>,
  detect?: DetectResult | null,
): string | null {
  if (detect?.cmd && detect.cmd.trim()) return detect.cmd.trim()
  const install = manifest.install
  if (!install) return null
  if (install.strategy === 'custom-cmd' && install.cmd?.trim()) return install.cmd.trim()
  const args = install.args && install.args.length > 0 ? `（参数：${install.args.join(' ')}）` : ''
  return `安装策略：${strategyLabel(install.strategy)}${args}`
}

/* ============================================================
 * 并发节流池（首次加载逐项 detect：并发 3）
 * ============================================================ */

/**
 * 并发池：最多 limit 个任务同时执行，全部结算后按任务顺序返回
 * PromiseSettledResult 数组（单个任务失败不中断其余任务）。
 * limit < 1 按 1 处理；tasks 为空返回空数组。
 */
export async function runPool<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  if (tasks.length === 0) return results
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, tasks.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++
      if (index >= tasks.length) return
      try {
        const value = await tasks[index]()
        results[index] = { status: 'fulfilled', value }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}
