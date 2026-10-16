/**
 * 视口样式（T1.3）
 *
 * 与渲染器 style.ts 同一交付方式：JS 注入 <style id>（幂等），不用 import './x.css'，
 * 保证 node:test + happy-dom 下可直接挂载冒烟。全部颜色 / 间距 / 圆角 / 字号
 * 引用 src/shell/theme/theme.css 的 token（宿主负责加载），本文件不定义任何颜色字面量。
 */

/** 注入的 <style> 元素 id（幂等注入依据） */
export const VIEWPORT_STYLE_ID = 'bps-ui-viewport-style';

/** 视口样式表（类名前缀 bps-vp-） */
export const VIEWPORT_CSS = `
/* ── 面板骨架 ───────────────────────────────────────── */
.bps-vp{position:relative;display:flex;flex-direction:column;background:var(--bg-canvas);color:var(--text);font-family:var(--font-ui);font-size:var(--font-md);overflow:hidden;outline:none;min-height:0;min-width:0;}
.bps-vp:focus{outline:none;}
.bps-vp:focus-visible{box-shadow:inset 0 0 0 1px var(--focus-ring);}
.bps-vp__surface{position:absolute;inset:0;overflow:hidden;cursor:default;touch-action:none;}
.bps-vp__surface--space{cursor:grab;}
.bps-vp__surface--panning{cursor:grabbing;}
.bps-vp__surface--marquee{cursor:crosshair;}
.bps-vp__canvas{position:absolute;left:0;top:0;transform-origin:0 0;}
.bps-vp__overlay{position:absolute;left:0;top:0;right:0;bottom:0;overflow:visible;pointer-events:none;}

/* ── 选中 / 悬停 / 框选 / 吸附线（画布坐标层）──────── */
.bps-vp__selbox{position:absolute;border:1px solid var(--node-selected);pointer-events:none;}
.bps-vp__hoverbox{position:absolute;border:1px dashed var(--accent);pointer-events:none;}
.bps-vp__marquee{position:absolute;background:var(--selection);border:1px solid var(--accent);pointer-events:none;}
.bps-vp__snapline{position:absolute;background:var(--warning);pointer-events:none;}
.bps-vp__snapline--x{width:1px;}
.bps-vp__snapline--y{height:1px;}

/* ── 浮动工具条 ─────────────────────────────────────── */
.bps-vp__toolbar{position:absolute;top:var(--space-2);right:var(--space-2);z-index:3;display:flex;align-items:center;gap:var(--space-1);background:var(--bg-panel-header);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px var(--space-2);color:var(--text-dim);font-size:var(--font-sm);}
.bps-vp__zoom{min-width:44px;text-align:center;color:var(--text);}
.bps-vp__btn{border:none;background:transparent;color:var(--text);font-size:var(--font-sm);font-family:inherit;border-radius:var(--radius-sm);padding:2px var(--space-2);cursor:pointer;white-space:nowrap;}
.bps-vp__btn:hover{background:var(--bg-input);}
.bps-vp__btn:disabled{color:var(--text-disabled);cursor:default;background:transparent;}
.bps-vp__btn--on{color:var(--accent);}

/* ── 多选对齐工具条 ─────────────────────────────────── */
.bps-vp__aligntoolbar{position:absolute;bottom:var(--space-2);left:50%;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:var(--space-1);background:var(--bg-panel-header);border:1px solid var(--border);border-radius:var(--radius-md);padding:2px var(--space-2);color:var(--text-dim);font-size:var(--font-sm);max-width:calc(100% - var(--space-7));overflow-x:auto;}

/* ── 提示 / 占位 ────────────────────────────────────── */
.bps-vp__hint{position:absolute;top:var(--space-2);left:var(--space-2);z-index:3;background:var(--bg-panel-header);border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px var(--space-2);color:var(--warning);font-size:var(--font-sm);}
.bps-vp__placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-disabled);font-size:var(--font-md);text-align:center;padding:var(--space-4);}

/* ── 右键菜单（添加节点 / 复制 / 删除）──────────────── */
.bps-vp__menu{position:absolute;z-index:5;min-width:200px;max-height:70%;overflow:auto;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:var(--space-1) 0;}
.bps-vp__menu-group{padding:3px var(--space-3);color:var(--text-disabled);font-size:var(--font-xs);}
.bps-vp__menu-item{display:flex;align-items:center;gap:var(--space-2);width:100%;border:none;background:transparent;color:var(--text);font-size:var(--font-sm);font-family:inherit;text-align:left;padding:3px var(--space-3);cursor:pointer;white-space:nowrap;}
.bps-vp__menu-item:hover{background:var(--selection);}
.bps-vp__menu-item:disabled{color:var(--text-disabled);cursor:default;background:transparent;}
.bps-vp__menu-item--danger{color:var(--error);}
.bps-vp__menu-icon{width:16px;text-align:center;color:var(--text-dim);}
`;

/**
 * 幂等注入视口样式表（UIEditorPanel 挂载时调用）。
 * 已存在同 id <style> 则跳过；无 head 的异常文档静默跳过（测试兜底）。
 */
export function ensureViewportStyle(doc: Document): void {
  if (doc.getElementById(VIEWPORT_STYLE_ID)) return;
  const head = doc.head ?? doc.documentElement;
  if (!head) return;
  const style = doc.createElement('style');
  style.id = VIEWPORT_STYLE_ID;
  style.textContent = VIEWPORT_CSS;
  head.appendChild(style);
}
