/**
 * 脚本注解粗扫（T3.1 · 纯函数，node:test 可直接加载）
 *
 * 职责：对脚本源码做正则粗扫，提取占位信息（蓝图视图占位面板用）：
 *   - @on('start') / @on('btnFetch', 'pressed') → 事件挂载数量与事件名
 *   - @expose({ type: 'string', default: 'x' }) → 暴露变量数量与字段名
 *
 * 边界（不虚报）：这是**占位级**粗扫，不是解析器（T3.6 交付受控子集解析器后
 * 被替换）——注释 / 字符串中的 @on/@expose 会误计；@expose 字段名为尽力捕获
 * （跳过装饰器括号参数后取下一个 `字段名:` 标识符，失败则不列出）。
 */

/** 脚本语言（由资产扩展名决定，PLAN §9.1：.ts / .py） */
export type ScriptLanguage = 'ts' | 'py'

/** 由资产路径判断脚本语言：.py → Python，其余（.ts/.tsx）按 TS 处理 */
export function scriptLanguageOf(path: string): ScriptLanguage {
  return /\.py$/i.test(path) ? 'py' : 'ts'
}

/** 粗扫结果（蓝图视图占位面板的已知信息） */
export interface ScriptScanSummary {
  /** 事件挂载数（@on 出现次数） */
  eventCount: number
  /** 暴露变量数（@expose 出现次数） */
  exposedCount: number
  /** 事件名列表（@on 首个字符串参数；解析失败的不列入） */
  eventNames: string[]
  /** 暴露变量名列表（尽力捕获；失败的位置以 '' 占位，保持与数量对应） */
  exposedNames: string[]
}

/** @on 装饰器：捕获首参字符串（'start' / "btnFetch" / `tick`） */
const ON_RE = /@on\s*\(\s*(['"`])([^'"`\\]*)\1/g

/** @expose 装饰器：有参 @expose({...}) 与无参 @expose 都计入 */
const EXPOSE_RE = /@expose\b/g

/** 类字段声明（跟在 @expose 之后的 `字段名:` 标识符） */
const FIELD_RE = /([A-Za-z_$][\w$]*)\s*\??\s*:/

/**
 * 跳过从 openIdx（指向 '('）开始的成对括号，返回其后第一个字符的下标。
 * 未闭合时返回字符串长度（尽力而为，不抛错）。
 */
function skipBalancedParens(src: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return src.length
}

/** 从装饰器结束位置向后找最近的字段声明名（窗口 400 字符，防跨类误捕） */
function findFieldNameAfter(src: string, from: number): string {
  const window = src.slice(from, from + 400)
  const m = FIELD_RE.exec(window)
  return m ? (m[1] as string) : ''
}

/** 粗扫脚本源码中的 @on / @expose（占位信息级，非解析器） */
export function scanScriptAnnotations(source: string): ScriptScanSummary {
  const text = typeof source === 'string' ? source : ''
  const eventNames: string[] = []
  ON_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ON_RE.exec(text)) !== null) {
    eventNames.push(m[2] ?? '')
    ON_RE.lastIndex = m.index + m[0].length // 处理零宽匹配兜底
  }

  const exposedNames: string[] = []
  EXPOSE_RE.lastIndex = 0
  while ((m = EXPOSE_RE.exec(text)) !== null) {
    // @expose(...) 有参：跳过参数括号后再找字段名；无参：直接从装饰器后找
    let searchFrom = m.index + m[0].length
    if (text[searchFrom] !== undefined && /^\s*\(/.test(text.slice(searchFrom))) {
      const openIdx = text.indexOf('(', searchFrom)
      if (openIdx >= 0) searchFrom = skipBalancedParens(text, openIdx)
    }
    exposedNames.push(findFieldNameAfter(text, searchFrom))
  }

  return {
    eventCount: eventNames.length,
    exposedCount: exposedNames.length,
    eventNames,
    exposedNames,
  }
}
