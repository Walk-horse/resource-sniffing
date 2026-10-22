// 资源嗅探 content script
// 职责：扫描页面中的 <video> 元素与网络媒体资源，向 background 上报；
//      接收来自 popup 的全屏 / 画中画 / 播放动作并在页面上下文中执行。
(function () {
  'use strict';

  // 顶层列表只认"主记录"：视频文件与播放列表；分片(.ts/.m4s)归属 playlist，不单列
  const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|m3u8|mpd|avi|mkv|flv|f4v)(\?|#|$)/i;
  const SEG_EXT = /\.(ts|m4s)(\?|#|$)/i;
  const MEDIA_TYPES = /(^video\/|application\/(ogg|mp4|x-mpegURL|vnd\.apple\.mpegurl|dash\+xml|f4v|x-shockwave-flash))/i;

  // 内部视频元素注册表：稳定 id -> <video> 元素
  const registry = new Map();
  let seq = 0;

  function genId() {
    return 'sniff_' + (++seq) + '_' + Date.now().toString(36);
  }

  function collectSources(video) {
    const sources = [];
    const src = video.currentSrc || video.src;
    if (src) sources.push({ src: src, type: 'video' });
    video.querySelectorAll('source').forEach(function (s) {
      if (s.src) sources.push({ src: s.src, type: s.type || '' });
    });
    return sources;
  }

  function snapshotVideo(video) {
    let id = video.__sniffId;
    if (!id || !registry.get(id)) {
      id = genId();
      video.__sniffId = id;
      registry.set(id, video);
      video.classList.add('__sniff_found');
    }
    const sources = collectSources(video);
    const rect = video.getBoundingClientRect();
    return {
      id: id,
      sources: sources,
      primarySrc: sources.length ? sources[0].src : '',
      duration: isFinite(video.duration) ? video.duration : 0,
      width: Math.round(video.videoWidth || rect.width || 0),
      height: Math.round(video.videoHeight || rect.height || 0),
      paused: video.paused,
      muted: video.muted,
      hasVideoEl: true,
      pipSupported: typeof video.requestPictureInPicture === 'function',
      fromNetwork: false
    };
  }

  // 网络资源 url -> 稳定 id（跨扫描保持不变，避免 popup 反复重建）
  const perfIds = new Map();

  function collectPerformanceResources() {
    const found = [];
    const seen = new Set(); // 同一 URL 只保留一条（HLS playlist 会被反复拉取）
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const url = e.name;
        if (seen.has(url)) continue;
        seen.add(url);
        if (SEG_EXT.test(url)) continue; // 分片不作为顶层记录
        if (!(VIDEO_EXT.test(url) || (e.contentType && MEDIA_TYPES.test(e.contentType)))) continue;
        let id = perfIds.get(url);
        if (!id) {
          id = 'net_' + (++seq) + '_' + Date.now().toString(36);
          perfIds.set(url, id);
        }
        found.push({
          id: id,
          sources: [{ src: url, type: e.contentType || '' }],
          primarySrc: url,
          duration: 0,
          width: 0,
          height: 0,
          paused: true,
          muted: false,
          hasVideoEl: false,
          pipSupported: false,
          fromNetwork: true
        });
      }
    } catch (err) { /* ignore */ }
    return found;
  }

  function scan() {
    const videos = Array.prototype.slice.call(document.querySelectorAll('video')).map(snapshotVideo);
    const network = collectPerformanceResources();
    const domUrls = new Set(videos.map(function (v) { return v.primarySrc; }));
    const merged = videos.concat(network.filter(function (n) { return !domUrls.has(n.primarySrc); }));
    report(merged);
  }

  let reportTimer = null;
  function report(list) {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(function () {
      try {
        chrome.runtime.sendMessage({ type: 'VIDEOS_UPDATE', videos: list });
      } catch (e) { /* context invalidated */ }
    }, 150);
  }

  // 监听动态插入的 video（SPA / 延迟加载）
  const observer = new MutationObserver(function (mutations) {
    let changed = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (!m.addedNodes) continue;
      m.addedNodes.forEach(function (n) {
        if (n.nodeName === 'VIDEO') changed = true;
        else if (n.querySelectorAll && n.querySelectorAll('video').length) changed = true;
      });
    }
    if (changed) scan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  scan();
  window.addEventListener('load', scan);
  setTimeout(scan, 1500);
  setTimeout(scan, 4000);
  // 探测正在播放的视频（部分站点延迟插入元素）
  setInterval(function () {
    const playing = Array.prototype.slice.call(document.querySelectorAll('video'))
      .filter(function (v) { return !v.paused && v.currentTime > 0; });
    if (playing.length) scan();
  }, 3000);

  // 执行来自 popup 的动作
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'DO_ACTION') return;
    const video = registry.get(msg.videoId);
    if (!video) {
      sendResponse({ ok: false, error: '未找到对应的视频元素（可能是网络嗅探到的地址）' });
      return;
    }
    try {
      if (msg.action === 'fullscreen') {
        if (video.requestFullscreen) {
          video.requestFullscreen()
            .then(function () { sendResponse({ ok: true }); })
            .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
          return true;
        }
        sendResponse({ ok: false, error: '当前浏览器不支持全屏 API' });
        return;
      }
      if (msg.action === 'pip') {
        if (typeof video.requestPictureInPicture !== 'function') {
          sendResponse({ ok: false, error: '该视频不支持画中画' });
          return;
        }
        // 抖音/腾讯等站点通过该属性禁用画中画，先解除再请求
        try {
          if (video.disablePictureInPicture) video.disablePictureInPicture = false;
          if (video.hasAttribute('disablepictureinpicture')) video.removeAttribute('disablepictureinpicture');
        } catch (e) { /* ignore */ }
        const enter = function () {
          video.requestPictureInPicture()
            .then(function () { sendResponse({ ok: true }); })
            .catch(function (err) {
              let m = (err && err.message) || '画中画被拒绝';
              if (err && err.name === 'NotSupportedError') {
                m = '站点/浏览器拒绝画中画（可能为 DRM 视频或再次被禁用）';
              }
              sendResponse({ ok: false, error: m });
            });
        };
        if (video.paused) {
          // 部分浏览器要求先播放才能进入画中画
          video.play().then(enter).catch(enter);
        } else {
          enter();
        }
        return true;
      }
      if (msg.action === 'play') {
        video.play()
          .then(function () { sendResponse({ ok: true }); })
          .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
      return;
    }
    sendResponse({ ok: false, error: '未知动作: ' + msg.action });
  });

  window.addEventListener('beforeunload', function () {
    try { chrome.runtime.sendMessage({ type: 'VIDEOS_UPDATE', videos: [] }); } catch (e) {}
  });
})();
