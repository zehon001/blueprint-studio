/**
 * 函数作用域徽标（f 图标）
 *
 * 局部函数（蓝图资产内）/ 内置库函数 / 项目库函数 三种作用域用不同颜色的
 * 「f」徽标区分；样式在全局 ui.css（.fn-badge），本组件不 import CSS，
 * 保证 node:test 可直接挂载。
 */
export type FnScope = 'local' | 'builtin' | 'project'

export function FnBadge({ scope, title }: { scope: FnScope; title?: string }) {
  return (
    <span className={`fn-badge fn-badge--${scope}`} title={title} aria-hidden>
      f
    </span>
  )
}
