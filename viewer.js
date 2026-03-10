// ============================================================
// viewer.js — PDF查看器主逻辑
// ============================================================

// PDF.js worker 路径（使用本地文件，避免 CSP 问题）
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
}

// ── 全局状态 ─────────────────────────────────────────────────
const State = {
  pdfDoc:      null,   // PDF.js 文档对象
  totalPages:  0,
  currentPage: 1,
  scale:       1.4,
  fileKey:     '',     // storage 中 PDF 文件的键
  pdfKey:      '',     // storage 中笔记的键
  fileName:    '',
  notes:       [],
  renderedPages: {},   // { pageNum: { page, viewport, wrapper } }
  pendingSelection: null, // 用户选中文字后暂存的选区信息
};

// ── 入口 ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  showLoading();

  const params   = new URLSearchParams(window.location.search);
  const fileKey  = params.get('fileKey');
  const notesKey = params.get('notesKey');
  const fileName = decodeURIComponent(params.get('name') || 'PDF文档');

  if (!fileKey) {
    hideLoading();
    showError('参数缺失，请重新从扩展图标选择文件打开。');
    return;
  }

  State.fileKey  = fileKey;
  State.pdfKey   = notesKey || fileKey;
  State.fileName = fileName;
  document.title = fileName + ' — PDF笔记';
  document.getElementById('file-name').textContent = fileName;

  // 从 storage 取 PDF 文件内容（base64）
  // 直接从 chrome.storage.local 读取（不经过 background 中转，更可靠）
  const entry = await new Promise(resolve => {
    chrome.storage.local.get(fileKey, result => resolve(result[fileKey] || null));
  });

  if (!entry || !entry.fileData) {
    hideLoading();
    showError('找不到文件数据。\n\n请关闭此页面，重新点击扩展图标选择 PDF 文件。');
    return;
  }

  // 读取历史笔记
  await loadNotes();

  // base64 DataURL → Uint8Array
  // entry.fileData 格式: "data:application/pdf;base64,XXXXX..."
  const b64    = entry.fileData.includes(',') ? entry.fileData.split(',')[1] : entry.fileData;
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // 加载 PDF
  const ok = await loadPDF(bytes);
  if (!ok) return;

  bindToolbar();
  bindSelectionListener();
  bindColorMenu();
  renderPanel();
  hideLoading();
  setTimeout(() => showToast('💡 选中文字即可高亮并添加笔记'), 1200);
});

// ── 与 background.js 通信的统一函数 ──────────────────────────
function msgBackground(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// ── 加载并渲染 PDF ────────────────────────────────────────────
async function loadPDF(pdfBytes) {
  try {
    State.pdfDoc = await pdfjsLib.getDocument({
      data:        pdfBytes,
      cMapUrl:     chrome.runtime.getURL('cmaps/'),
      cMapPacked:  true,
    }).promise;

    State.totalPages = State.pdfDoc.numPages;
    document.getElementById('total-pages').textContent = State.totalPages;
    document.getElementById('page-input').max = State.totalPages;

    await buildPagePlaceholders();
    await renderPage(1);
    if (State.totalPages >= 2) await renderPage(2);
    if (State.totalPages >= 3) await renderPage(3);
    setupLazyRender();
    return true;

  } catch (e) {
    hideLoading();
    showError('PDF 加载失败：' + e.message);
    return false;
  }
}

// 为每一页创建占位 div
async function buildPagePlaceholders() {
  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  for (let i = 1; i <= State.totalPages; i++) {
    const div = document.createElement('div');
    div.className       = 'page-wrapper';
    div.id              = 'page-' + i;
    div.dataset.page    = i;
    div.style.cssText   = 'width:800px;min-height:1050px;background:#fff;';
    container.appendChild(div);
  }
}

// 渲染单页
async function renderPage(n) {
  if (State.renderedPages[n]) return;
  const wrapper = document.getElementById('page-' + n);
  if (!wrapper) return;

  const page     = await State.pdfDoc.getPage(n);
  const viewport = page.getViewport({ scale: State.scale });

  wrapper.style.width     = viewport.width  + 'px';
  wrapper.style.minHeight = viewport.height + 'px';
  wrapper.innerHTML       = '';

  // 层1：Canvas（PDF 内容）
  const canvas  = document.createElement('canvas');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  wrapper.appendChild(canvas);

  // 层2：文字层（透明，用于文字选择）
  const textDiv = document.createElement('div');
  textDiv.className = 'text-layer';
  textDiv.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;`;

  // renderTextLayer API 在不同版本写法不同，兼容两种
  const textContent = await page.getTextContent();
  try {
    // 新版 API（3.x）
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container:         textDiv,
      viewport:          viewport,
      textDivs:          [],
    });
    await (task.promise || task);
  } catch(e) {
    // 旧版 fallback
    try {
      await pdfjsLib.renderTextLayer({
        textContent,
        container:  textDiv,
        viewport,
        textDivs:   [],
      }).promise;
    } catch(e2) { /* 文字层失败不影响主功能 */ }
  }
  wrapper.appendChild(textDiv);

  // 层3：高亮层
  const hlDiv = document.createElement('div');
  hlDiv.className = 'highlight-layer';
  hlDiv.id        = 'hl-layer-' + n;
  wrapper.appendChild(hlDiv);

  State.renderedPages[n] = { page, viewport, wrapper };
  restorePageNotes(n);
}

// 懒加载：滚动到哪里才渲染哪里
function setupLazyRender() {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const n = parseInt(e.target.dataset.page);
        renderPage(n);
        State.currentPage = n;
        document.getElementById('page-input').value = n;
      }
    });
  }, { threshold: 0.05, rootMargin: '400px 0px' });

  document.querySelectorAll('.page-wrapper').forEach(d => obs.observe(d));
}

// ── 工具栏按钮 ────────────────────────────────────────────────
function bindToolbar() {
  document.getElementById('prev-page').onclick = () => goToPage(State.currentPage - 1);
  document.getElementById('next-page').onclick = () => goToPage(State.currentPage + 1);
  document.getElementById('page-input').onchange = e => goToPage(parseInt(e.target.value));
  document.getElementById('zoom-in').onclick  = () => changeZoom(0.15);
  document.getElementById('zoom-out').onclick = () => changeZoom(-0.15);
  document.getElementById('btn-toggle-panel').onclick = togglePanel;
  document.getElementById('btn-close-panel').onclick  = togglePanel;
}

function goToPage(n) {
  n = Math.max(1, Math.min(n, State.totalPages));
  State.currentPage = n;
  document.getElementById('page-input').value = n;
  const el = document.getElementById('page-' + n);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function changeZoom(delta) {
  State.scale = Math.max(0.5, Math.min(3, State.scale + delta));
  document.getElementById('zoom-level').textContent = Math.round(State.scale * 100) + '%';
  State.renderedPages = {};
  await buildPagePlaceholders();
  await renderPage(State.currentPage);
  setupLazyRender();
}

function togglePanel() {
  document.getElementById('notes-panel').classList.toggle('panel-hidden');
}

// ── 文字选择 → 颜色菜单 ───────────────────────────────────────
function bindSelectionListener() {
  document.addEventListener('mouseup', e => {
    if (e.target.closest('.note-card') || e.target.closest('#highlight-menu')) return;
    setTimeout(() => checkSelection(), 10);
  });
}

function checkSelection() {
  const sel  = window.getSelection();
  const text = sel.toString().trim();
  if (text.length < 2) { closeMenu(); return; }

  const range   = sel.getRangeAt(0);
  const wrapper = range.startContainer.parentElement?.closest('.page-wrapper');
  if (!wrapper) { closeMenu(); return; }

  const pageNum  = parseInt(wrapper.dataset.page);
  const selRect  = range.getBoundingClientRect();
  const pageRect = wrapper.getBoundingClientRect();

  State.pendingSelection = {
    text, pageNum,
    hlRect:  { x: selRect.left - pageRect.left, y: selRect.top - pageRect.top,
                w: selRect.width, h: selRect.height || 18 },
    notePos: { x: wrapper.offsetWidth + 20, y: Math.max(0, selRect.top - pageRect.top - 10) },
  };

  showMenu(selRect);
}

function showMenu(r) {
  const menu = document.getElementById('highlight-menu');
  menu.style.display = 'block';
  let left = r.left + r.width / 2 - 110;
  let top  = r.bottom + 8;
  if (left + 220 > window.innerWidth) left = window.innerWidth - 230;
  if (left < 8) left = 8;
  if (top  + 70 > window.innerHeight) top = r.top - 65;
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}

function closeMenu() {
  document.getElementById('highlight-menu').style.display = 'none';
}

function bindColorMenu() {
  document.querySelectorAll('.color-dot').forEach(btn => {
    btn.onclick = () => createNote(btn.dataset.color);
  });
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#highlight-menu')) closeMenu();
  });
}

// ── 创建笔记 ──────────────────────────────────────────────────
function createNote(color) {
  if (!State.pendingSelection) return;
  const { text, pageNum, hlRect, notePos } = State.pendingSelection;

  const note = {
    id:        'n' + Date.now(),
    pageNum, text, color,
    content:   '',
    collapsed: false,
    hlRect, notePos,
    createdAt: new Date().toISOString(),
  };

  State.notes.push(note);
  window.getSelection().removeAllRanges();
  closeMenu();
  State.pendingSelection = null;

  renderNote(note);
  renderPanel();
  saveNotes();
}

// ── 渲染一条笔记（高亮 + 卡片或悬浮球）──────────────────────
function renderNote(note) {
  const info = State.renderedPages[note.pageNum];
  if (!info) return;
  drawHighlight(note, info.wrapper);
  note.collapsed ? renderBall(note, info.wrapper) : renderCard(note, info.wrapper);
}

function drawHighlight(note, wrapper) {
  const layer = document.getElementById('hl-layer-' + note.pageNum);
  if (!layer) return;
  document.getElementById('hl-' + note.id)?.remove();

  const el = document.createElement('div');
  el.className = 'hl-mark';
  el.id        = 'hl-' + note.id;
  el.style.cssText = `left:${note.hlRect.x}px;top:${note.hlRect.y}px;
    width:${note.hlRect.w}px;height:${note.hlRect.h}px;background:${note.color};`;
  el.onclick = () => toggleCollapse(note);
  layer.appendChild(el);
}

function renderCard(note, wrapper) {
  wrapper.querySelector('#card-' + note.id)?.remove();
  wrapper.querySelector('#ball-' + note.id)?.remove();

  const tpl  = document.getElementById('tpl-note-card');
  const card = tpl.content.cloneNode(true).querySelector('.note-card');
  card.id    = 'card-' + note.id;
  card.style.cssText = `position:absolute;left:${note.notePos.x}px;top:${note.notePos.y}px;`;

  card.querySelector('.card-color-dot').style.background = note.color;
  card.querySelector('.card-page-label').textContent = '第 ' + note.pageNum + ' 页';
  card.querySelector('.card-quote').textContent       = note.text;
  const ta = card.querySelector('.card-textarea');
  ta.value = note.content;

  // 折叠
  card.querySelector('.btn-collapse').onclick = () => {
    note.collapsed = true;
    card.remove();
    renderBall(note, wrapper);
    updateNote(note);
  };
  // 删除
  card.querySelector('.btn-delete').onclick = () => {
    if (confirm('确定删除这条笔记？')) deleteNote(note.id);
  };
  // 保存
  const btnSave = card.querySelector('.btn-save');
  btnSave.onclick = () => {
    note.content = ta.value;
    updateNote(note);
    renderPanel();
    btnSave.textContent = '已保存 ✓';
    setTimeout(() => btnSave.textContent = '保存', 1500);
  };
  // 失去焦点自动保存
  ta.onblur = () => { note.content = ta.value; updateNote(note); renderPanel(); };

  makeDraggable(card, note);
  wrapper.appendChild(card);
}

function renderBall(note, wrapper) {
  wrapper.querySelector('#card-' + note.id)?.remove();
  wrapper.querySelector('#ball-' + note.id)?.remove();

  const tpl  = document.getElementById('tpl-float-ball');
  const ball = tpl.content.cloneNode(true).querySelector('.float-ball');
  ball.id    = 'ball-' + note.id;
  ball.style.cssText = `position:absolute;
    left:${note.hlRect.x + note.hlRect.w + 6}px;
    top:${note.hlRect.y - 4}px;
    background:${note.color};`;
  ball.title = note.content ? note.content.substring(0, 60) : '点击展开笔记';

  let dragged = false;
  ball.onclick = () => { if (!dragged) { note.collapsed = false; renderCard(note, wrapper); updateNote(note); } };
  makeDraggable(ball, note, () => { dragged = true; }, () => { setTimeout(() => dragged = false, 60); });
  wrapper.appendChild(ball);
}

function toggleCollapse(note) {
  const info = State.renderedPages[note.pageNum];
  if (!info) return;
  note.collapsed = !note.collapsed;
  note.collapsed ? renderBall(note, info.wrapper) : renderCard(note, info.wrapper);
  updateNote(note);
}

// ── 拖拽 ──────────────────────────────────────────────────────
function makeDraggable(el, note, onStart, onEnd) {
  let dragging = false, ox, oy, sl, st;
  el.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
    dragging = true; ox = e.clientX; oy = e.clientY;
    sl = parseInt(el.style.left) || 0; st = parseInt(el.style.top) || 0;
    e.preventDefault(); onStart?.();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    el.style.left = (sl + e.clientX - ox) + 'px';
    el.style.top  = (st + e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    note.notePos = { x: parseInt(el.style.left), y: parseInt(el.style.top) };
    updateNote(note); onEnd?.();
  });
}

// ── 笔记 CRUD ─────────────────────────────────────────────────
function updateNote(note) {
  const i = State.notes.findIndex(n => n.id === note.id);
  if (i !== -1) State.notes[i] = note;
  saveNotes();
}

function deleteNote(id) {
  const note = State.notes.find(n => n.id === id);
  if (!note) return;
  document.getElementById('hl-' + id)?.remove();
  const info = State.renderedPages[note.pageNum];
  if (info) {
    info.wrapper.querySelector('#card-' + id)?.remove();
    info.wrapper.querySelector('#ball-' + id)?.remove();
  }
  State.notes = State.notes.filter(n => n.id !== id);
  saveNotes(); renderPanel();
}

function restorePageNotes(n) {
  State.notes.filter(note => note.pageNum === n).forEach(note => renderNote(note));
}

// ── 右侧面板 ─────────────────────────────────────────────────
function renderPanel() {
  const list = document.getElementById('notes-list');
  if (State.notes.length === 0) {
    list.innerHTML = '<div class="empty-hint">还没有笔记<br><small>选中文字即可开始批注</small></div>';
    return;
  }
  const sorted = [...State.notes].sort((a, b) => a.pageNum - b.pageNum);
  list.innerHTML = '';
  sorted.forEach(note => {
    const item = document.createElement('div');
    item.className = 'panel-item';
    item.innerHTML = `
      <div class="pi-top">
        <span class="pi-dot" style="background:${note.color}"></span>
        <span class="pi-page">第 ${note.pageNum} 页</span>
      </div>
      <div class="pi-quote">${esc(note.text)}</div>
      <div class="pi-content ${note.content ? '' : 'pi-empty'}">${note.content ? esc(note.content) : '(暂无笔记)'}</div>
    `;
    item.onclick = () => {
      goToPage(note.pageNum);
      setTimeout(() => {
        const info = State.renderedPages[note.pageNum];
        if (info && note.collapsed) { note.collapsed = false; renderCard(note, info.wrapper); updateNote(note); }
        const hl = document.getElementById('hl-' + note.id);
        if (hl) { hl.classList.add('hl-flash'); setTimeout(() => hl.classList.remove('hl-flash'), 1500); }
      }, 400);
    };
    list.appendChild(item);
  });
}

// ── Storage ───────────────────────────────────────────────────
async function saveNotes() {
  return new Promise(resolve => {
    chrome.storage.local.set({ [State.pdfKey]: State.notes }, resolve);
  });
}

async function loadNotes() {
  return new Promise(resolve => {
    chrome.storage.local.get(State.pdfKey, result => {
      const notes = result[State.pdfKey];
      if (Array.isArray(notes)) State.notes = notes;
      resolve();
    });
  });
}

// ── 工具函数 ──────────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showLoading() {
  if (document.getElementById('loading-overlay')) return;
  const d = document.createElement('div');
  d.id = 'loading-overlay';
  d.innerHTML = '<div class="spinner"></div><p>正在加载 PDF…</p>';
  document.body.appendChild(d);
}

function hideLoading() { document.getElementById('loading-overlay')?.remove(); }

function showError(msg) {
  hideLoading();
  document.getElementById('pdf-container').innerHTML =
    `<div class="error-box">📄<br><b>无法加载 PDF</b><br><small>${esc(msg)}</small></div>`;
}

function showToast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.style.opacity = '0', 2500);
  setTimeout(() => t.remove(), 3000);
}
