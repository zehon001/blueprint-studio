/**
 * Blueprint Studio v2 —— 双视图同步协议状态机（T3.8，PLAN §10「保存者胜 / 过期提示重载」）
 *
 * 职责：脚本资产（单一逻辑资产双视图，D3）的蓝图视图 ⇄ 脚本视图同步协议，实现为
 * **纯状态机**（不依赖 React / zustand / fetch，node:test 可直接加载）；
 * ScriptTab.tsx 消费本机：状态渲染提示条与横幅，effects 落地为编辑器内容覆写，
 * 写盘（PUT /api/file）与 codegen/parse 副作用留在 ScriptTab（本文件只管协议）。
 *
 * 协议（PLAN §10）：
 *  - 任一视图保存成功 → 推进已保存基线 savedText（保存者胜，不做字符级合并）；
 *    脚本保存 → IR 基线更新（蓝图视图基于新 IR 重新解析）；蓝图保存 → codegen 覆盖
 *    写盘 .ts 源码 → 脚本视图重载 CodeMirror 内容。
 *  - 保存失败 → 状态不变（草稿 / 蓝图修改原样保留，DoD：无脏丢失），ScriptTab 弹 toast。
 *  - 脏冲突横幅（派生，见 scriptDraftPending / blueprintDirtyPending）：
 *    · 脚本视图有未保存草稿时切到蓝图视图 → 提示「脚本有未保存修改，蓝图将基于
 *      已保存版本渲染」+「以草稿解析」（blueprintBase='draft'）/「放弃草稿」；
 *    · 蓝图视图有未保存修改时切回脚本视图 → 提示「蓝图已修改（未保存）」+
 *      「应用并覆盖脚本」（codegen 写回编辑器草稿）/「丢弃蓝图修改」。
 *
 * 语义要点（对应 viewStateMachine 各转换，sync.test.ts 逐一锁定）：
 *  - editScript 携带编辑器全文，机器对比自身基线判脏（text ≠ savedText → 草稿；
 *    撤销回基线 → 自动清脏），横幅不误报；
 *  - saveScriptOk / saveBlueprintOk 都会把 blueprintBase 复位为 'saved'（另一视图
 *    切回时基于最新已保存基线重新解析 = 过期即重载）；
 *  - saveBlueprintOk 额外清 scriptDirty：蓝图保存覆盖写盘 = 保存者胜，滞留的脚本
 *    草稿被丢弃（编辑器内容经 effect 重载为写盘文本）；
 *  - applyBlueprintToScript 把 blueprintDirty 移交为 scriptDirty（蓝图修改以 codegen
 *    文本形态进入编辑器草稿，尚未写盘），blueprintBase 复位（蓝图侧不再持有未保存修改）。
 */

/** 视图（与 ViewSwitch 的 ScriptViewKind 同形；此处独立声明避免测试拉入 React 组件） */
export type SyncView = 'blueprint' | 'script'

/** 同步协议状态 */
export interface SyncState {
  /** 当前视图 */
  view: SyncView
  /** 已保存基线文本（磁盘确认内容；两视图共同的「保存者」基准） */
  savedText: string
  /** 脚本视图有未保存草稿（草稿文本由 ScriptTab 编辑器持有，机器只记布尔） */
  scriptDirty: boolean
  /** 蓝图视图有未保存修改（编辑后 IR 尚未 codegen 写盘） */
  blueprintDirty: boolean
  /** 蓝图当前基准：'saved' = 已保存版本；'draft' = 脚本草稿（「以草稿解析」后） */
  blueprintBase: 'saved' | 'draft'
}

/** 状态机副作用（ScriptTab 落地为编辑器内容覆写；机器本身不触碰编辑器） */
export type SyncEffect =
  /**
   * 编辑器整体替换为**已确认**文本（草稿清零）：
   * 「放弃草稿」用 savedText；蓝图保存写盘成功后用 codegen 文本（脚本视图重载）。
   */
  | { type: 'setScriptConfirmed'; text: string }
  /**
   * 编辑器整体替换为**草稿**文本（相对磁盘未保存，编辑器恢复脏态）：
   * 「应用并覆盖脚本」把蓝图修改以 codegen 文本写回编辑器草稿。
   */
  | { type: 'setScriptDraft'; text: string }

/** 同步协议事件（ScriptTab 的 UI 动作 / 保存结果） */
export type SyncEvent =
  /** 切换视图（保存者胜协议不阻止切换，脏冲突经横幅提示） */
  | { type: 'switchView'; view: SyncView }
  /**
   * 脚本视图编辑（击键 / 撤销；text = 编辑器当前全文）。机器对比自身基线判脏：
   * text ≠ savedText → 草稿；撤销回基线 → 自动清脏（防抖标脏仍由 ScriptTab 负责）。
   */
  | { type: 'editScript'; text: string }
  /** 蓝图视图编辑（BlueprintEditorPanel store dirty 时由 ScriptTab 上报） */
  | { type: 'editBlueprint' }
  /** 「以草稿解析」：蓝图基准改为脚本草稿（草稿本身仍未保存） */
  | { type: 'parseScriptDraftAsBlueprint' }
  /** 「放弃草稿」：丢弃脚本草稿，用已保存版本（编辑器重置为 savedText） */
  | { type: 'discardScriptDraft' }
  /** 脚本视图保存成功（PUT /api/file 确认；text = 写盘内容） */
  | { type: 'saveScriptOk'; text: string }
  /** 脚本视图保存失败（PUT 409 / 网络错误；草稿保留，ScriptTab 弹 toast） */
  | { type: 'saveScriptFail' }
  /** 蓝图视图保存成功（codegen 文本覆盖写盘确认；text = 写盘内容） */
  | { type: 'saveBlueprintOk'; text: string }
  /** 蓝图视图保存失败（codegen 失败 / PUT 失败；蓝图修改保留） */
  | { type: 'saveBlueprintFail' }
  /** 「应用并覆盖脚本」：蓝图修改以 codegen 文本写回编辑器草稿（未写盘） */
  | { type: 'applyBlueprintToScript'; text: string }
  /** 「丢弃蓝图修改」：蓝图侧未保存修改作废（蓝图基于已保存版本重新解析） */
  | { type: 'discardBlueprintChanges' }

/** 一次转换的结果：新状态 + 需要落地到编辑器的副作用 */
export interface SyncTransition {
  state: SyncState
  effects: SyncEffect[]
}

/** 初始同步状态（资产加载 / 重载完成时调用；两视图干净、基准为已保存版本） */
export function initSyncState(savedText: string): SyncState {
  return { view: 'script', savedText, scriptDirty: false, blueprintDirty: false, blueprintBase: 'saved' }
}

/** 派生：蓝图视图是否显示「脚本有未保存修改」提示条（基准仍是已保存版本时才需要选择） */
export function scriptDraftPending(s: SyncState): boolean {
  return s.view === 'blueprint' && s.scriptDirty && s.blueprintBase === 'saved'
}

/** 派生：脚本视图是否显示「蓝图已修改（未保存）」提示条 */
export function blueprintDirtyPending(s: SyncState): boolean {
  return s.view === 'script' && s.blueprintDirty
}

/**
 * 双视图同步协议状态机（纯函数）：(state, event) → { state, effects }。
 * 转换语义见文件头；未列出的字段在转换中保持不变。
 */
export function viewStateMachine(s: SyncState, e: SyncEvent): SyncTransition {
  switch (e.type) {
    /* ---------- 视图切换（不阻止，脏冲突经横幅提示；无字段额外变化） ---------- */
    case 'switchView':
      if (e.view === s.view) return { state: s, effects: [] };
      return { state: { ...s, view: e.view }, effects: [] };

    /* ---------- 编辑（编辑事件携带全文，机器对比基线判脏） ---------- */
    case 'editScript':
      return { state: { ...s, scriptDirty: e.text !== s.savedText }, effects: [] };
    case 'editBlueprint':
      return { state: { ...s, blueprintDirty: true }, effects: [] };

    /* ---------- 脏冲突选择（蓝图视图横幅） ---------- */
    case 'parseScriptDraftAsBlueprint':
      // 以草稿解析：蓝图基准改为脚本草稿；草稿仍未保存（scriptDirty 保持），横幅撤下
      return { state: { ...s, blueprintBase: 'draft' }, effects: [] };
    case 'discardScriptDraft':
      // 放弃草稿：编辑器重置为已保存版本（草稿清零），蓝图基准回到已保存版本
      return {
        state: { ...s, scriptDirty: false, blueprintBase: 'saved' },
        effects: [{ type: 'setScriptConfirmed', text: s.savedText }],
      };

    /* ---------- 脚本视图保存（保存者胜：基线推进，蓝图基于新 IR） ---------- */
    case 'saveScriptOk':
      return {
        state: { ...s, savedText: e.text, scriptDirty: false, blueprintBase: 'saved' },
        effects: [],
      };
    case 'saveScriptFail':
      // 保存失败：状态不变（草稿保留，DoD 无脏丢失）
      return { state: s, effects: [] };

    /* ---------- 蓝图视图保存（codegen 覆盖写盘；脚本视图重载） ---------- */
    case 'saveBlueprintOk':
      // 保存者胜：蓝图写盘成功 → 脚本草稿一并失效（编辑器经 effect 重载为写盘文本）
      return {
        state: {
          ...s,
          savedText: e.text,
          scriptDirty: false,
          blueprintDirty: false,
          blueprintBase: 'saved',
        },
        effects: [{ type: 'setScriptConfirmed', text: e.text }],
      };
    case 'saveBlueprintFail':
      // 保存失败：蓝图修改保留（DoD 无脏丢失），横幅在切回脚本视图时仍可见
      return { state: s, effects: [] };

    /* ---------- 脏冲突选择（脚本视图横幅） ---------- */
    case 'applyBlueprintToScript':
      // 蓝图修改移交为脚本草稿（codegen 文本进编辑器，尚未写盘 → 恢复脏态）
      return {
        state: { ...s, scriptDirty: true, blueprintDirty: false, blueprintBase: 'saved' },
        effects: [{ type: 'setScriptDraft', text: e.text }],
      };
    case 'discardBlueprintChanges':
      // 丢弃蓝图修改：蓝图基于已保存版本重新解析（下次进入蓝图视图时生效）
      return { state: { ...s, blueprintDirty: false, blueprintBase: 'saved' }, effects: [] };

    default: {
      // 穷尽性守卫（编译期漏事件在此报错）
      const unreachable: never = e;
      void unreachable;
      return { state: s, effects: [] };
    }
  }
}
