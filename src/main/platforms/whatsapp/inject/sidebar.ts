export const whatsappSidebarScript = String.raw`
(() => {
  if (window.__RT_SIDEBAR_INSTALLED__) return;
  window.__RT_SIDEBAR_INSTALLED__ = true;
  const doc = document, key = 'hellodog:whatsapp-chat-list-width';
  let layout, handle, scheduled = false, dragging = false, dragWidth;
  const owned = new Map(), drawerStyles = new Map(), drawerRoots = new Set(), writtenStyles = new WeakMap();
  const rect = node => node.getBoundingClientRect();
  const css = node => getComputedStyle(node);
  const floating = node => ['absolute', 'fixed'].includes(css(node).position);
  const visible = node => node?.isConnected && rect(node).width >= 180 && rect(node).height >= 200 && css(node).visibility !== 'hidden' && css(node).display !== 'none';
  const saved = () => { try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; } };
  const persist = width => { try { localStorage.setItem(key, String(Math.round(width))); } catch {} };
  const set = (ledger, node, name, value) => {
    if (!ledger.has(node)) ledger.set(node, new Map());
    const props = ledger.get(node), old = props.get(name);
    const current = node.style.getPropertyValue(name), priority = node.style.getPropertyPriority(name);
    // React can replace inline styles while a drawer is open. Restore the most
    // recent native value, and never undo a later change made by the platform.
    if (!old || current !== old.applied || priority !== 'important') props.set(name, { value: current, priority, applied: value });
    else old.applied = value;
    if (current !== value || priority !== 'important') { node.style.setProperty(name, value, 'important'); writtenStyles.set(node, node.style.cssText); }
  };
  const restore = (ledger, keep = new Set()) => {
    for (const [node, props] of ledger) {
      if (keep.has(node) && node.isConnected) continue;
      for (const [name, old] of props) if (node.style.getPropertyValue(name) === old.applied && node.style.getPropertyPriority(name) === 'important') {
        if (old.value) node.style.setProperty(name, old.value, old.priority); else node.style.removeProperty(name);
        writtenStyles.set(node, node.style.cssText);
      }
      ledger.delete(node);
    }
  };
  const fill = (node, width) => {
    // Percentage widths on positioned descendants can resolve against the
    // whole app, not the visible sidebar wrapper. Use the measured column
    // width in that case without introducing a new containing block.
    const size = floating(node) ? width + 'px' : '100%';
    for (const [name, value] of Object.entries({ width: size, 'min-width': '0px', 'max-width': size, 'box-sizing': 'border-box', 'flex-basis': 'auto' })) set(owned, node, name, value);
  };
  const locate = () => {
    const side = doc.querySelector('#side'), main = doc.querySelector('#main');
    if (!visible(side)) return null;
    if (main && visible(main) && !side.contains(main)) {
      let column = side;
      while (column.parentElement && column.parentElement !== doc.body && !column.parentElement.contains(main)) column = column.parentElement;
      const root = column.parentElement;
      if (!root?.contains(main) || column === doc.body) return null;
      let content = main;
      while (content.parentElement && content.parentElement !== root) content = content.parentElement;
      return { side, main, column, content, root };
    }
    // Home has no #main. Only a real row of adjacent, in-flow columns is a
    // resize target. An absolute archive portal is not the conversation pane.
    let result = null;
    for (let node = side, depth = 0; node && node !== doc.body && depth < 12; node = node.parentElement, depth++) {
      const root = node.parentElement;
      if (!root || !['flex', 'inline-flex'].includes(css(root).display) || !['row', 'row-reverse'].includes(css(root).flexDirection)) continue;
      const r = rect(node);
      const content = Array.from(root.children).find(other => other !== node && !other.hasAttribute('data-rt-ui') && visible(other) && rect(other).left >= r.right - 2 && Math.abs(rect(other).top - r.top) < 100 && (!floating(other) || css(other).position === 'absolute' && other.offsetParent === root));
      if (content && visible(node)) result = { side, column: node, content, root };
    }
    return result;
  };
  // WhatsApp has shipped both in-flow and absolutely anchored conversation
  // panes. Support the latter only when its containing block is the same row;
  // never move a portal or infer an offset from a different coordinate system.
  const anchored = value => css(value.content).position === 'absolute' && value.content.offsetParent === value.root && css(value.content).transform === 'none';
  const resizable = value => value && ['flex', 'inline-flex'].includes(css(value.root).display) && css(value.root).flexDirection === 'row' && !floating(value.column) && (!floating(value.content) || anchored(value)) && (!value.main || !floating(value.main) || value.main === value.content || value.main.offsetParent && value.content.contains(value.main.offsetParent));
  const limits = () => ({ min: 240, max: Math.max(240, Math.min(660, rect(layout.root).width - 320)) });
  const aligned = () => {
    const s = rect(layout.side), c = rect(layout.column), m = rect(layout.main || layout.content), root = rect(layout.root);
    return Math.abs(s.right - c.right) <= 2 && Math.abs(m.left - s.right) <= 3 && m.right <= root.right + 2 && m.width >= 318;
  };
  const apply = value => {
    if (!resizable(layout)) { restore(owned); return null; }
    const bounds = limits(), width = Math.max(bounds.min, Math.min(bounds.max, value));
    for (const [name, item] of Object.entries({ width: width + 'px', 'flex-basis': width + 'px', 'flex-grow': '0', 'flex-shrink': '0', 'min-width': bounds.min + 'px', 'max-width': bounds.max + 'px', 'box-sizing': 'border-box' })) set(owned, layout.column, name, item);
    for (let node = layout.side; node && node !== layout.column; node = node.parentElement) fill(node, width);
    set(owned, layout.content, 'min-width', '0px');
    set(owned, layout.content, 'flex-basis', '0px');
    set(owned, layout.content, 'flex-grow', '1');
    set(owned, layout.content, 'flex-shrink', '1');
    if (anchored(layout)) {
      set(owned, layout.content, 'left', (rect(layout.column).right - rect(layout.root).left - layout.root.clientLeft) + 'px');
      set(owned, layout.content, 'right', '0px');
      set(owned, layout.content, 'width', 'auto');
      set(owned, layout.content, 'max-width', 'none');
    }
    for (let node = layout.main; node && node !== layout.content; node = node.parentElement) fill(node, rect(layout.content).width);
    // A flex-looking ancestor may contain a positioned pane with an independent
    // offset. In that case leave the native layout intact, including its border.
    if (!aligned()) { restore(owned); return null; }
    return width;
  };
  const syncDrawers = () => {
    const keep = new Set();
    drawerRoots.clear();
    if (!layout) { restore(drawerStyles); return; }
    const side = rect(layout.side);
    const candidates = new Set();
    let budget = 240;
    const visit = (node, depth) => {
      if (budget-- <= 0 || depth > 5 || !node?.isConnected || node === handle || node.contains(layout.side) || node.contains(layout.main || layout.content)) return;
      if (node.matches('[role="dialog"], [aria-modal="true"], [role="menu"], [data-rt-ui]')) return;
      const r = rect(node), style = css(node);
      const parent = node.offsetParent;
      const anchorLeft = style.position === 'absolute' && parent ? rect(parent).left + parent.clientLeft - parent.scrollLeft + node.offsetLeft : r.left;
      // Left drawers may be siblings of the entire app layout, not descendants
      // of #side. Inspect only siblings along that path, never message content.
      if (floating(node) && style.display !== 'none' && style.visibility !== 'hidden' && r.width >= 180 && r.height >= Math.max(200, side.height * .65) && Math.abs(anchorLeft - side.left) <= 24 && Math.abs(r.top - side.top) <= 100 && r.width < Math.max(side.width + 40, innerWidth * .8)) candidates.add(node);
      for (const child of node.children) visit(child, depth + 1);
    };
    for (let node = layout.side, depth = 0; node?.parentElement && depth < 12; node = node.parentElement, depth++) {
      for (const sibling of node.parentElement.children) if (sibling !== node && sibling !== handle && !sibling.contains(layout.main || layout.content)) { drawerRoots.add(sibling); visit(sibling, 0); }
      if (node.parentElement === doc.body) break;
    }
    for (const node of candidates) {
      keep.add(node);
      // Width only: never introduce a containing block, move a drawer, remove
      // its transition, or alter z-index/pointer handling.
      const width = Math.round(side.width) + 'px';
      for (const name of ['width', 'max-width']) set(drawerStyles, node, name, width);
      set(drawerStyles, node, 'min-width', '0px');
      set(drawerStyles, node, 'box-sizing', 'border-box');
    }
    restore(drawerStyles, keep);
  };
  const syncHandle = () => {
    if (!handle || !layout) return;
    const s = rect(layout.side);
    // The handle is a transparent viewport overlay. It must not change the
    // positioned ancestors used by WhatsApp, or leave a border in the chat.
    Object.assign(handle.style, { left: (s.right - 3) + 'px', top: s.top + 'px', height: s.height + 'px' });
    handle.setAttribute('aria-valuenow', String(Math.round(s.width)));
    handle.setAttribute('aria-valuemax', String(limits().max));
  };
  const removeHandle = () => { handle?.remove(); handle = null; dragging = false; };
  const createHandle = () => {
    handle = doc.createElement('div');
    handle.setAttribute('data-rt-ui', 'sidebar-resize'); handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', '调整 WhatsApp 聊天列表宽度'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-valuemin', '240'); handle.tabIndex = 0;
    Object.assign(handle.style, { position: 'fixed', width: '6px', zIndex: '20', cursor: 'col-resize', touchAction: 'none', background: 'transparent', border: '0', outline: 'none', boxShadow: 'none', padding: '0', margin: '0' });
    const focusMark = doc.createElement('span'); focusMark.setAttribute('aria-hidden', 'true');
    Object.assign(focusMark.style, { position: 'absolute', left: '2px', top: 'calc(50% - 18px)', height: '36px', width: '2px', borderRadius: '2px', background: '#91bcae', opacity: '0', pointerEvents: 'none' });
    handle.appendChild(focusMark);
    handle.onfocus = () => { focusMark.style.opacity = handle.matches(':focus-visible') ? '1' : '0'; };
    handle.onblur = () => { focusMark.style.opacity = '0'; };
    handle.onpointerenter = () => { handle.style.background = '#7ba7b340'; };
    handle.onpointerleave = () => { if (!dragging) handle.style.background = 'transparent'; };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      focusMark.style.opacity = '0';
      event.preventDefault(); event.stopPropagation(); dragging = true; dragWidth = rect(layout.side).width;
      try { handle.setPointerCapture?.(event.pointerId); } catch { dragging = false; }
    });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      const width = apply(event.clientX - rect(layout.side).left);
      if (width !== null) dragWidth = width;
      syncDrawers(); syncHandle();
    });
    const stop = () => { if (!dragging) return; dragging = false; if (Number.isFinite(dragWidth)) persist(dragWidth); if (handle) handle.style.background = 'transparent'; schedule(); };
    handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop); handle.addEventListener('lostpointercapture', stop);
    handle.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const width = apply(event.key === 'Home' ? 340 : rect(layout.side).width + (event.key === 'ArrowLeft' ? -16 : 16));
      if (width !== null) persist(width);
      syncDrawers(); syncHandle();
    };
    handle.ondblclick = () => { try { localStorage.removeItem(key); } catch {} restore(owned); if (!aligned()) apply(rect(layout.side).width); syncDrawers(); syncHandle(); };
    doc.body.appendChild(handle);
  };
  let watched = new Set();
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const watch = () => {
    const next = new Set([doc.documentElement, layout?.side, layout?.column, layout?.content, layout?.main, ...drawerStyles.keys()].filter(Boolean));
    for (const node of watched) if (!next.has(node)) resizeObserver?.unobserve(node);
    for (const node of next) if (!watched.has(node)) resizeObserver?.observe(node);
    watched = next;
  };
  const install = () => {
    scheduled = false;
    if (dragging && layout?.side.isConnected && layout?.content.isConnected && handle?.isConnected) return;
    dragging = false;
    if (handle && !handle.isConnected) handle = null;
    const next = locate();
    if (!next || !layout || next.side !== layout.side || next.column !== layout.column || next.content !== layout.content || next.main !== layout.main) {
      restore(owned); restore(drawerStyles); removeHandle(); layout = next;
    }
    if (!layout) { watch(); return; }
    const desired = saved();
    let safe = resizable(layout);
    if (desired) safe = apply(desired) !== null;
    else {
      // An inner #side may be narrower than its native fixed-width wrapper.
      // The old early alignment check disabled resizing precisely when it was
      // needed, leaving the wrapper's border as a second line in the chat.
      safe = safe && (aligned() || apply(rect(layout.side).width) !== null);
    }
    if (safe) { if (!handle) createHandle(); } else removeHandle();
    syncDrawers(); syncHandle(); watch();
  };
  const schedule = () => {
    if (!doc.defaultView || doc.defaultView.document !== doc || !doc.documentElement?.isConnected || scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(install); else setTimeout(install, 16);
  };
  new MutationObserver(records => {
    // Ignore our own styles and ordinary message attribute changes. Sidebar
    // visibility can change via class/style without mounting any new elements.
    if (records.some(record => record.type === 'childList' || record.target !== handle && !(record.attributeName === 'style' && writtenStyles.get(record.target) === record.target.style.cssText) && (watched.has(record.target) || record.target.contains(layout?.side || doc.querySelector('#side')) || record.target.contains(layout?.main || doc.querySelector('#main')) || Array.from(drawerRoots).some(node => node.contains(record.target))))) schedule();
  }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  doc.addEventListener('transitionend', schedule, true);
  addEventListener('resize', schedule);
  install();
})();
`;
