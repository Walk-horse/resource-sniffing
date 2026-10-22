'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const metaEl = document.getElementById('meta');

const expanded = new Set();          // 已展开分片列表的 vid
const segState = {};                 // vid -> { loading|segments|error|mpd }
let lastData = { videos: [] };       // 缓存最近一次数据，用于重渲染

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0]);
    });
  });
}

function formatDur(s) {
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () {
      flash('已复制分片地址');
    }, function () { flash('复制失败'); });
  } else {
    flash('当前环境不支持复制');
  }
}

function render(data) {
  lastData = data || { videos: [] };
  const videos = lastData.videos || [];
  countEl.textContent = videos.length + ' 个视频';
  metaEl.textContent = lastData.title ? lastData.title : (lastData.url || '');
  metaEl.title = lastData.url || '';
  listEl.innerHTML = '';
  if (!videos.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  videos.forEach(function (v) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.vid = v.id;

    const info = document.createElement('div');
    info.className = 'info';

    const title = document.createElement('div');
    title.className = 'title';
    let label;
    if (v.hasVideoEl) {
      label = v.primarySrc ? hostOf(v.primarySrc) : '(内嵌视频元素)';
    } else {
      label = hostOf(v.primarySrc) + ' · 网络资源';
    }
    title.textContent = label;
    title.title = v.primarySrc;

    const sub = document.createElement('div');
    sub.className = 'sub';
    const segmented = /\.(m3u8|mpd)(\?|#|$)/i.test(v.primarySrc);
    const parts = [];
    if (v.width && v.height) parts.push(v.width + '×' + v.height);
    if (v.duration) parts.push(formatDur(v.duration));
    if (v.fromNetwork) parts.push('网络嗅探');
    if (!v.hasVideoEl) parts.push('无 DOM 元素');
    if (segmented) parts.push('分片流 · 点「分片」查看');
    if (v.paused === false) parts.push('播放中');
    sub.textContent = parts.join(' · ');

    info.appendChild(title);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (v.hasVideoEl && v.pipSupported) actions.appendChild(mkBtn('画中画', 'pip', v));
    if (v.hasVideoEl) actions.appendChild(mkBtn('全屏', 'fullscreen', v));
    if (segmented) {
      actions.appendChild(mkBtn('分片', 'segments', v));
    } else {
      actions.appendChild(mkBtn('下载', 'download', v));
    }

    // 分片列表面板：仅展开时显示
    const panel = document.createElement('div');
    panel.className = 'segs';
    if (expanded.has(v.id)) {
      panel.style.display = 'block';
      const st = segState[v.id];
      if (!st) {
        panel.innerHTML = '<div class="seg-msg">加载分片中…</div>';
        loadSegs(v);
      } else if (st.loading) {
        panel.innerHTML = '<div class="seg-msg">加载分片中…</div>';
      } else if (st.error) {
        panel.innerHTML = '<div class="seg-msg err">' + escapeHtml(st.error) + '</div>';
      } else if (st.mpd) {
        panel.innerHTML = '<div class="seg-msg err">DASH(.mpd) 分片需专用工具解析，暂不支持列表展示</div>';
      } else if (!st.segments.length) {
        panel.innerHTML = '<div class="seg-msg err">未解析到分片（可能是加密流或需登录）</div>';
      } else {
        const ul = document.createElement('ul');
        ul.className = 'seg-list';
        st.segments.forEach(function (u, i) {
          const sli = document.createElement('li');
          const idx = document.createElement('span');
          idx.className = 'seg-idx';
          idx.textContent = (i + 1);
          const uu = document.createElement('span');
          uu.className = 'seg-url';
          uu.textContent = u;
          uu.title = u;
          const cp = document.createElement('button');
          cp.className = 'seg-copy';
          cp.textContent = '复制';
          cp.addEventListener('click', function () { copyText(u); });
          const op = document.createElement('a');
          op.className = 'seg-open';
          op.textContent = '打开';
          op.href = u;
          op.target = '_blank';
          op.rel = 'noopener';
          sli.appendChild(idx);
          sli.appendChild(uu);
          sli.appendChild(cp);
          sli.appendChild(op);
          ul.appendChild(sli);
        });
        panel.appendChild(ul);
      }
    } else {
      panel.style.display = 'none';
    }

    li.appendChild(info);
    li.appendChild(actions);
    li.appendChild(panel);
    listEl.appendChild(li);
  });
}

function mkBtn(label, action, v) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'btn ' + action;
  b.addEventListener('click', function () { onAction(action, v); });
  return b;
}

async function onAction(action, v) {
  const tab = await getActiveTab();
  if (!tab) return;
  if (action === 'download') {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: v.primarySrc }, function (resp) {
      if (chrome.runtime.lastError) {
        flash('下载失败：' + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) flash((resp && resp.error) ? resp.error : '下载失败');
    });
    return;
  }
  if (action === 'segments') {
    if (expanded.has(v.id)) {
      expanded.delete(v.id);
    } else {
      expanded.add(v.id);
      if (!segState[v.id]) loadSegs(v);
    }
    render(lastData);
    return;
  }
  chrome.runtime.sendMessage(
    { type: 'ACTION', tabId: tab.id, videoId: v.id, action: action },
    function (resp) {
      if (chrome.runtime.lastError) {
        flash('页面未就绪：' + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) {
        flash((resp && resp.error) ? resp.error : '操作失败');
      }
    }
  );
}

function loadSegs(v) {
  segState[v.id] = { loading: true };
  getActiveTab().then(function (tab) {
    const referer = tab ? tab.url : '';
    chrome.runtime.sendMessage(
      { type: 'FETCH_SEGMENTS', url: v.primarySrc, referer: referer },
      function (resp) {
        if (chrome.runtime.lastError) {
          segState[v.id] = { error: chrome.runtime.lastError.message };
          render(lastData);
          return;
        }
        if (!resp || !resp.ok) {
          segState[v.id] = { error: (resp && resp.error) ? resp.error : '解析失败' };
        } else {
          segState[v.id] = { segments: resp.segments || [], mpd: !!resp.mpd };
        }
        render(lastData);
      }
    );
  });
}

function flash(msg, dur) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, dur || 2600);
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, render);
}

document.getElementById('refresh').addEventListener('click', refresh);
refresh();

// popup 停留期间持续拉取，捕获延迟出现的视频（保留展开/分片状态）
let timer = setInterval(refresh, 2000);
