/**
 * 脚本草稿状态层（T3.1 · 纯逻辑，node:test 可直接加载）
 *
 * 职责：ScriptEditor 的 change 回调 → workspace markDirty 之间的节流层——
 * 编辑器每次击键都会回调文本，防抖 300ms 只向工作区标脏一次（DoD 口径），
 * 同时持有「最新草稿文本」供保存链取用（避免为保存而维护 React 状态）。
 *
 * 语义：
 *  - notifyChange：记最新文本 + 防抖触发 onDirty（文本回到基线时不触发）；
 *  - reset：保存成功后调用，把基线推进到已保存文本，草稿态清零；
 *  - hasDraft：最新文本 ≠ 基线（有未保存修改）。
 */
/** 草稿跟踪器（ScriptEditor change 回调与工作区标脏之间的节流层） */
export interface DraftTracker {
  /** 编辑器 change 回调：记最新文本并防抖标脏 */
  notifyChange(text: string): void
  /** 保存成功后调用：基线推进到已保存文本，草稿态清零 */
  reset(text?: string): void
  /** 是否存在未保存草稿（最新文本 ≠ 基线） */
  hasDraft(): boolean
  /** 当前最新草稿文本（保存链取用） */
  text(): string
  /** 立即触发挂起的标脏回调（测试用） */
  flush(): void
  /** 取消挂起定时器（组件卸载用） */
  dispose(): void
}

/** 创建草稿跟踪器（防抖默认 300ms，测试可传小值） */
export function createDraftTracker(
  initialText: string,
  onDirty: (text: string) => void,
  debounceMs = 300,
): DraftTracker {
  let baseline = initialText // 最近一次加载 / 保存已确认的文本
  let current = initialText // 编辑器最新草稿文本
  let timer: ReturnType<typeof setTimeout> | null = null

  // 触发前先摘除挂起定时器：fire 既可能由定时器到期调用（clear 自身无害），
  // 也可能由 flush() 手动调用（必须真正取消挂起定时器，否则防抖残留在事件循环里，
  // dispose/保存后仍会再次触发 onDirty——测试抓出的孤儿定时器缺陷）
  const fire = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (current !== baseline) onDirty(current)
  }

  return {
    notifyChange(text) {
      current = text
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      timer = setTimeout(fire, debounceMs)
    },
    reset(text) {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      baseline = text ?? current
      current = text ?? current
    },
    hasDraft: () => current !== baseline,
    text: () => current,
    flush() {
      if (timer !== null) fire()
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
