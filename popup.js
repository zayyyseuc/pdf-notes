// popup.js
// 流程：用户选择PDF → FileReader读成base64 → 直接写入chrome.storage.local → 打开viewer

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideError() {
  document.getElementById('error-msg').style.display = 'none';
}
function setProgress(pct, text) {
  document.getElementById('progress-wrap').style.display = 'block';
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = text;
}
function hideProgress() {
  document.getElementById('progress-wrap').style.display = 'none';
}

// 生成稳定的 key（用文件名，不用 blob URL）
function makeKey(fileName) {
  let h = 0;
  for (let i = 0; i < fileName.length; i++) {
    h = Math.imul(31, h) + fileName.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

async function openPdfFile(file) {
  hideError();
  if (!file) return;

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) { showError('请选择 .pdf 格式的文件'); return; }

  const MAX_MB = 40;
  if (file.size > MAX_MB * 1024 * 1024) {
    showError(`文件过大（${(file.size/1024/1024).toFixed(1)}MB），请选择 ${MAX_MB}MB 以内的文件`);
    return;
  }

  const btn = document.getElementById('open-btn');
  btn.disabled = true;
  document.getElementById('btn-text').textContent = '读取中…';
  setProgress(5, '正在读取文件…');

  try {
    // Step 1: 把文件读成 base64 data URL
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('文件读取失败，请重试'));
      reader.onprogress = e => {
        if (e.lengthComputable) {
          setProgress(5 + Math.round(e.loaded / e.total * 55), 
            `读取中… ${(e.loaded/1024/1024).toFixed(1)}/${(e.total/1024/1024).toFixed(1)} MB`);
        }
      };
      reader.readAsDataURL(file);
    });

    setProgress(65, '正在保存到本地存储…');

    const hash     = makeKey(file.name);
    const fileKey  = 'pdffile_' + hash;
    const notesKey = 'pdf_'     + hash;

    // Step 2: 直接写入 chrome.storage.local（不经过 background 中转）
    // 这样可以确保数据真的写进去了，并且能捕获错误
    await new Promise((resolve, reject) => {
      const payload = {
        [fileKey]: {
          fileName: file.name,
          fileData: dataUrl,      // "data:application/pdf;base64,XXXX..."
          storedAt: Date.now(),
        }
      };
      chrome.storage.local.set(payload, () => {
        if (chrome.runtime.lastError) {
          reject(new Error('存储失败：' + chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    setProgress(85, '验证存储…');

    // Step 3: 立刻读回来验证确实存进去了
    const verify = await new Promise(resolve => {
      chrome.storage.local.get(fileKey, result => resolve(result[fileKey]));
    });

    if (!verify || !verify.fileData) {
      throw new Error('存储验证失败：数据写入后无法读回，文件可能太大');
    }

    setProgress(100, '即将打开…');

    // Step 4: 打开 viewer，传入 key
    const viewerUrl = chrome.runtime.getURL('viewer.html')
      + '?fileKey='  + encodeURIComponent(fileKey)
      + '&notesKey=' + encodeURIComponent(notesKey)
      + '&name='     + encodeURIComponent(file.name);

    chrome.tabs.create({ url: viewerUrl });
    window.close();

  } catch (err) {
    hideProgress();
    btn.disabled = false;
    document.getElementById('btn-text').textContent = '选择 PDF 文件…';
    showError('❌ ' + err.message);
  }
}

// ── 按钮事件 ──────────────────────────────────────────────────
document.getElementById('open-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) openPdfFile(e.target.files[0]);
});

// ── 拖拽 ─────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) openPdfFile(e.dataTransfer.files[0]);
});
dropZone.addEventListener('click', () => document.getElementById('file-input').click());

// ── 统计 ──────────────────────────────────────────────────────
chrome.storage.local.get(null, data => {
  const el       = document.getElementById('stats');
  const noteKeys = Object.keys(data || {}).filter(k => k.startsWith('pdf_'));
  const total    = noteKeys.reduce((s, k) => s + (Array.isArray(data[k]) ? data[k].length : 0), 0);

  if (noteKeys.length === 0) {
    el.innerHTML = '<div class="empty-stat">还没有批注过任何 PDF</div>';
  } else {
    el.innerHTML = `
      <div class="stat-row"><span>已批注 PDF</span><span class="stat-val">${noteKeys.length} 个</span></div>
      <div class="stat-row"><span>笔记总数</span><span class="stat-val">${total} 条</span></div>
    `;
  }
});
