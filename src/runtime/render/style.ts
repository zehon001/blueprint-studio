/**
 * 渲染器结构样式（T1.2）
 *
 * 约束（任务卡）：渲染器只写「结构样式 + var(--token) 引用」，全部颜色 / 间距 / 圆角 /
 * 字体取自 src/shell/theme/theme.css 的 token（该表由运行窗口宿主 T1.6 / 编辑器外壳加载）；
 * 本文件不定义任何颜色字面量，也不声明 token 本身。
 *
 * 交付方式：renderUI() 首次调用时把这份 CSS 以 <style id> 注入 document.head（幂等），
 * 编辑器视口（T1.3）与运行窗口（T1.6）因此无需各自接线样式，保证两态渲染一致。
 * 不用 import './x.css' 是因为渲染器要在 node:test + happy-dom 下直接单测（tsx 无法加载 css）。
 */

/** 注入的 <style> 元素 id（幂等注入依据） */
export const UI_RENDER_STYLE_ID = 'bps-ui-render-style';

/** 渲染器结构样式表（颜色一律 var(--token)） */
export const UI_RENDER_CSS = `
/* ── 根 ─────────────────────────────────────────────── */
.bps-ui-root{position:relative;font-family:var(--font-ui);font-size:var(--font-md);color:var(--text);line-height:1.5;}
.bps-ui-root .bps-node{box-sizing:border-box;}
.bps-ui-root--edit{user-select:none;-webkit-user-select:none;}
.bps-ui-root--edit button{cursor:default;}
.bps-ui-root button,.bps-ui-root input,.bps-ui-root select,.bps-ui-root textarea{font:inherit;color:inherit;margin:0;}
.bps-ui-root button{cursor:pointer;}

/* ── 节点通用 ───────────────────────────────────────── */
.bps-node{transform-origin:50% 50%;}

/* ── 容器 ───────────────────────────────────────────── */
.bps-vbox{display:flex;flex-direction:column;}
.bps-hbox{display:flex;flex-direction:row;}
.bps-grid{display:grid;}
.bps-panel{display:flex;flex-direction:column;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden;}
.bps-panel-title{flex:none;background:var(--bg-panel-header);padding:2px var(--space-2);font-size:var(--font-sm);color:var(--text-dim);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bps-panel-body{position:relative;flex:1 1 auto;min-height:0;min-width:0;}
.bps-scroll{position:relative;}
.bps-tabs{display:flex;flex-direction:column;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden;}
.bps-tabbar{display:flex;flex:none;background:var(--bg-panel-header);border-bottom:1px solid var(--border);overflow-x:auto;}
.bps-tab{flex:none;border:none;background:transparent;color:var(--text-dim);padding:3px 10px;font-size:var(--font-sm);border-right:1px solid var(--border);white-space:nowrap;}
.bps-tab--active{background:var(--bg-panel);color:var(--text);box-shadow:inset 0 -2px 0 var(--accent);}
.bps-tabbody{position:relative;flex:1 1 auto;min-height:0;min-width:0;}
.bps-split{display:flex;}
.bps-split--horizontal{flex-direction:row;}
.bps-split--vertical{flex-direction:column;}
/* 分隔条视觉（T1.7）：第二窗格边缘 1px 分隔线（静态比例；拖动调节不在本卡范围） */
.bps-split--horizontal > .bps-split-pane--second{border-left:1px solid var(--border-strong);}
.bps-split--vertical > .bps-split-pane--second{border-top:1px solid var(--border-strong);}

/* ── 显示 ───────────────────────────────────────────── */
.bps-label{overflow:hidden;}
.bps-label--clip{white-space:nowrap;text-overflow:ellipsis;}
.bps-label--wrap{white-space:pre-wrap;word-break:break-word;}
.bps-richtext{overflow:auto;}
.bps-md{overflow:auto;}
.bps-md h1,.bps-md h2,.bps-md h3,.bps-md h4,.bps-md h5,.bps-md h6{margin:6px 0 4px;line-height:1.3;}
.bps-md p{margin:4px 0;}
.bps-md code{font-family:var(--font-mono);font-size:var(--font-sm);background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0 4px;}
.bps-md pre{background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-2);overflow:auto;margin:6px 0;}
.bps-md pre code{background:none;border:none;padding:0;}
.bps-md blockquote{margin:6px 0;padding:2px var(--space-2);border-left:3px solid var(--border-strong);color:var(--text-dim);}
.bps-md a{color:var(--accent);}
.bps-md hr{border:none;border-top:1px solid var(--border-strong);margin:8px 0;}
.bps-md ul,.bps-md ol{margin:4px 0;padding-left:20px;}
.bps-img{display:block;}
.bps-sep{border:none;background:var(--border-strong);margin:0;flex:none;}
.bps-progress{position:relative;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;}
.bps-progress-fill{position:absolute;left:0;top:0;bottom:0;background:var(--accent);}
.bps-progress-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:var(--font-xs);color:var(--text);}

/* ── 输入 ───────────────────────────────────────────── */
.bps-btn{border:1px solid var(--border);background:var(--bg-input);color:var(--text);border-radius:var(--radius-sm);padding:0 var(--space-3);white-space:nowrap;}
.bps-btn--primary{background:var(--accent);border-color:var(--accent);}
.bps-btn--secondary{background:var(--bg-input);}
.bps-btn--ghost{background:transparent;border-color:var(--border-strong);}
.bps-btn--danger{background:var(--error);border-color:var(--error);}
.bps-input{background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 6px;min-width:0;outline:none;}
.bps-input:focus{border-color:var(--focus-ring);}
.bps-input::placeholder{color:var(--text-disabled);}
.bps-textedit{resize:none;}
.bps-check{display:inline-flex;align-items:center;gap:6px;}
.bps-check input{accent-color:var(--accent);margin:0;}
.bps-slider{accent-color:var(--accent);padding:0;border:none;background:transparent;min-width:0;}
.bps-spin{display:inline-flex;align-items:stretch;}
.bps-spin .bps-input{flex:1 1 auto;width:auto;}
.bps-spin-suffix{display:inline-flex;align-items:center;padding:0 6px;color:var(--text-dim);font-size:var(--font-sm);}

/* ── 数据（list / table / tree）──────────────────────── */
.bps-list,.bps-tableview{overflow:auto;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-md);}
.bps-lgrid{display:grid;align-items:center;}
.bps-lhead{position:sticky;top:0;z-index:1;background:var(--bg-panel-header);border-bottom:1px solid var(--border);}
.bps-lhead .bps-lcell{color:var(--text-dim);font-size:var(--font-sm);}
.bps-lcell{padding:2px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.bps-lrow{border-bottom:1px solid var(--border);}
.bps-lrow--sel{background:var(--selection);}
.bps-lbadge{display:inline-block;padding:0 6px;border-radius:var(--radius-sm);line-height:1.5;}
.bps-lcount{margin-left:6px;color:var(--accent);font-size:var(--font-sm);}
.bps-lgroup{display:flex;align-items:center;gap:4px;padding:2px 6px;background:var(--bg-panel-header);color:var(--text-dim);font-size:var(--font-sm);border-bottom:1px solid var(--border);}
.bps-lcaret{flex:none;width:12px;text-align:center;}
.bps-lgmeta{color:var(--text-disabled);font-size:var(--font-xs);}
.bps-lmerged{border-bottom:1px dashed var(--border);color:var(--text-dim);}
.bps-lmerged .bps-lcell{color:var(--text-dim);}
.bps-lempty{padding:var(--space-2);color:var(--text-disabled);}

/* list 真视觉合并（T1.7 · rowspan）：有合并列时行体为整体网格，行容器 display:contents
   参与同一网格，合并条目的单元格 grid-row:span N 跨行占位（内联样式写入）。
   仅作用于 list 的合并模式；table 与无合并 list 保持行级网格结构。 */
.bps-lbody--grid{display:grid;}
.bps-lbody--grid > .bps-lrow{display:contents;}
.bps-lbody--grid > .bps-lrow .bps-lcell{border-bottom:1px solid var(--border);}
.bps-lbody--grid .bps-lrow--sel .bps-lcell{background:var(--selection);}
.bps-lcell--span{align-self:stretch;display:flex;align-items:center;gap:4px;}
.bps-lbody--grid > .bps-lgroup,.bps-lbody--grid > .bps-lempty,.bps-lbody--grid > .bps-lmerged{grid-column:1 / -1;}

/* T7.6 list 虚拟滚动（行数 > LIST_VIRTUAL_THRESHOLD，见 src/perf/thresholds.ts）：
   行体为相对定位占位容器（显式总高 = 槽位计划总高），行 / 组头 / 合并块绝对定位按槽位
   top 排布（内联样式写入）；行体本身不再是网格容器（.bps-lbody--grid 已移除）。 */
.bps-lbody--virtual{position:relative;}
.bps-lbody--virtual > .bps-lrow,.bps-lbody--virtual > .bps-lgroup,.bps-lbody--virtual > .bps-lmerged{position:absolute;left:0;right:0;}
.bps-tree{overflow:auto;padding:2px 0;}
.bps-treeitem{display:flex;align-items:center;gap:2px;padding:1px 4px;white-space:nowrap;}
.bps-treeitem--sel{background:var(--selection);}
.bps-treecaret{flex:none;width:14px;text-align:center;color:var(--text-dim);}

/* ── 未知类型兜底 ───────────────────────────────────── */
.bps-unknown-tag{color:var(--text-disabled);font-size:var(--font-sm);}

/* ── 预制体占位（T7.3 · ADR-009：缓存未命中 / 循环引用 / 超深的就地中文提示） ── */
.bps-prefab-placeholder{display:flex;align-items:center;gap:6px;min-width:80px;padding:4px 10px;background:var(--bg-input);border:1px dashed var(--border-strong);border-radius:var(--radius-sm);color:var(--text-dim);font-size:var(--font-sm);overflow:hidden;}
.bps-prefab-placeholder-icon{flex:none;}
.bps-prefab-placeholder-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`;

/**
 * 幂等注入渲染器样式表（renderUI 首次渲染时调用）。
 * 已存在同 id <style> 则跳过；无 head 的异常文档静默跳过（测试兜底）。
 */
export function ensureRenderStyle(doc: Document): void {
  if (doc.getElementById(UI_RENDER_STYLE_ID)) return;
  const head = doc.head ?? doc.documentElement;
  if (!head) return;
  const style = doc.createElement('style');
  style.id = UI_RENDER_STYLE_ID;
  style.textContent = UI_RENDER_CSS;
  head.appendChild(style);
}
