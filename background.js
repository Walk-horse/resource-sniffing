// 资源嗅探 background service worker
// 职责：按 tabId/frameId 缓存视频列表；响应 popup 的 GET_VIDEOS / ACTION / DOWNLOAD / FETCH_SEGMENTS 请求。
// content script 注入所有 frame（all_frames），iframe 里的视频（如腾讯视频播放器）也可控。
const state = {}; // tabId -> { frames: { frameId: { videos: [] } }, url, title }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'DOWNLOAD') {
    const url = msg.url;
    if (!url) { sendResponse({ ok: false, error: '无下载地址' }); return; }
    let name = 'video_' + Date.now() + '.mp4';
    try {
      const u = new URL(url);
      let n = decodeURIComponent(u.pathname.split('/').pop() || '');
      n = n.split('?')[0];
      if (/\.(mp4|webm|ogg|ogv|mov|m4v|flv|f4v|ts|mkv|avi)$/i.test(n)) name = n;
    } catch (e) { /* 用默认名 */ }
    chrome.downloads.download({ url: url, filename: name, saveAs: false }, function (dlId) {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, id: dlId });
    });
    return true; // 异步响应
  }

  if (msg.type === 'FETCH_SEGMENTS') {
    fetchSegments(msg.url, msg.referer)
      .then(function (segs) {
        sendResponse({
          ok: true,
          segments: segs,
          mpd: /\.(mpd)(\?|#|$)/i.test(msg.url)
        });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: errMsg(err) });
      });
    return true; // 异步响应
  }

  if (msg.type === 'VIDEOS_UPDATE') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    const frameId = sender.frameId != null ? sender.frameId : 0;
    if (!state[tabId]) state[tabId] = { frames: {}, url: '', title: '' };
    if (!state[tabId].frames) state[tabId].frames = {};
    state[tabId].frames[frameId] = { videos: msg.videos || [] };
    if (frameId === 0) {
      state[tabId].url = sender.tab ? sender.tab.url : '';
      state[tabId].title = sender.tab ? sender.tab.title : '';
    }
    return;
  }

  if (msg.type === 'GET_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      const st = tab ? state[tab.id] : null;
      const videos = [];
      let url = '', title = '';
      if (st) {
        url = st.url || '';
        title = st.title || '';
        const frameIds = Object.keys(st.frames || {})
          .map(Number)
          .sort(function (a, b) { return a - b; }); // 主 frame 优先
        frameIds.forEach(function (fid) {
          (st.frames[fid].videos || []).forEach(function (v) {
            videos.push(v);
          });
        });
      }
      sendResponse({ videos: videos, url: url, title: title });
    });
    return true; // 异步响应
  }

  if (msg.type === 'ACTION') {
    const tabId = msg.tabId;
    // 定位视频所在的 frame，定向投递，避免其他 frame 抢答「未找到」
    let frameId = 0;
    const st = state[tabId];
    if (st && st.frames) {
      Object.keys(st.frames).some(function (fid) {
        const list = st.frames[fid].videos || [];
        if (list.some(function (v) { return v.id === msg.videoId; })) {
          frameId = Number(fid);
          return true;
        }
        return false;
      });
    }
    chrome.tabs.sendMessage(tabId, {
      type: 'DO_ACTION',
      videoId: msg.videoId,
      action: msg.action
    }, { frameId: frameId }, function (res) {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: '页面未注入嗅探脚本：' + chrome.runtime.lastError.message });
        return;
      }
      sendResponse(res || { ok: false, error: '无响应' });
    });
    return true; // 异步响应
  }
});

// 清理：tab 关闭 / 导航时清空缓存
chrome.tabs.onRemoved.addListener(function (tabId) {
  delete state[tabId];
});
chrome.tabs.onUpdated.addListener(function (tabId) {
  if (state[tabId]) state[tabId].frames = {};
});

// ---- m3u8 分片解析（HLS）----
function errMsg(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err || '未知错误';
  return err.message || err.reason || String(err) || '未知错误';
}

function resolveUri(p, base) {
  try { return new URL(p, base).href; } catch (e) { return p; }
}

async function fetchSegments(url, referer, depth) {
  depth = depth || 0;
  const headers = {};
  if (referer) {
    headers['Referer'] = referer;
    try { headers['Origin'] = new URL(referer).origin; } catch (e) { /* ignore */ }
  }
  let resp;
  try {
    resp = await fetch(url, { headers: headers });
  } catch (e) {
    throw new Error('拉取失败：' + errMsg(e));
  }
  if (!resp.ok) throw new Error('拉取失败 HTTP ' + resp.status);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charAt(0) === '#') {
      // 变体 playlist（master）：下一行是其地址，递归拉取第一层
      if (line.indexOf('#EXT-X-STREAM-INF') === 0 && depth < 1 && lines[i + 1] && lines[i + 1].charAt(0) !== '#') {
        return fetchSegments(resolveUri(lines[i + 1], url), referer, depth + 1);
      }
      continue;
    }
    segs.push(resolveUri(line, url));
  }
  return segs;
}
