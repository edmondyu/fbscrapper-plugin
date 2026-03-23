// Injected into the main world at document_start (before Facebook's JS runs).
// Facebook uses XMLHttpRequest (not fetch) for GraphQL calls, so we intercept XHR.
(function () {
  if (window._fbScraperInterceptorInstalled) return;
  window._fbScraperInterceptorInstalled = true;

  // CDP test-bridge: helpers that relay commands to the isolated-world content
  // script via postMessage and collect the async response.
  var _cmdListeners = {};
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'FB_SCRAPER_CMD_RESULT') return;
    var resolve = _cmdListeners[e.data.requestId];
    if (resolve) { delete _cmdListeners[e.data.requestId]; resolve(e.data.result); }
  });
  function _sendCmd(cmd, extra) {
    return new Promise(function(resolve) {
      var id = Math.random().toString(36).slice(2);
      _cmdListeners[id] = resolve;
      window.postMessage(Object.assign({ type: 'FB_SCRAPER_CMD', cmd: cmd, requestId: id }, extra || {}), '*');
    });
  }
  window._scraper = {
    start:      function() { window.postMessage({ type: 'FB_SCRAPER_CMD', cmd: 'start' }, '*'); },
    stop:       function() { window.postMessage({ type: 'FB_SCRAPER_CMD', cmd: 'stop' }, '*'); },
    getStorage: function(keys) { return _sendCmd('getStorage', { keys: keys }); },
    clearAll:   function() { return _sendCmd('clearAll'); },
  };

var _origOpen = XMLHttpRequest.prototype.open;
  var _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._fbScraperUrl = typeof url === 'string' ? url : '';
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var url = this._fbScraperUrl || '';
    if (url.indexOf('/api/graphql') !== -1 || url.indexOf('graphql') !== -1) {
      this.addEventListener('load', function () {
        try {
          var text = this.responseText;

          // Extract creation_time unix timestamps
          var reTime = /"creation_time"\s*:\s*(\d{9,11})/g;
          var times = [];
          var m;
          while ((m = reTime.exec(text)) !== null) times.push(parseInt(m[1], 10));
          if (times.length > 0) {
            window.postMessage({ type: 'FB_SCRAPER_CREATION_TIMES', times: times }, '*');
          }

          // Extract video URLs using first_frame_thumbnail as the linking key.
          // Strategy:
          // 1. Collect all progressive_url MP4 URLs with their positions in the response.
          // 2. For each first_frame_thumbnail (poster URL), extract the video ID from
          //    the filename (format: <videoId>_<otherId>_<otherId>_n.jpg).
          // 3. Find progressive_url entries that follow within 15 000 chars — these
          //    belong to the same video delivery node.
          // 4. Distinguish SD vs HD by looking for '720' in the URL.
          var videos = [];
          var reProg = /"progressive_url"\s*:\s*"([^"]+)"/g;
          var progUrls = [];
          var mp;
          while ((mp = reProg.exec(text)) !== null) {
            var pu = mp[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
            if (pu.indexOf('.mp4') !== -1) {
              progUrls.push({ pos: mp.index, url: pu });
            }
          }

          if (progUrls.length > 0) {
            var reThumb = /"first_frame_thumbnail"\s*:\s*"(https:[^"]+\/(\d+)_\d+_\d+[^"]+)"/g;
            var mt;
            while ((mt = reThumb.exec(text)) !== null) {
              var videoId = mt[2];
              var thumbPos = mt.index;
              // Collect progressive_url entries within 15 000 chars after this thumbnail
              var nearby = [];
              for (var ki = 0; ki < progUrls.length; ki++) {
                var diff = progUrls[ki].pos - thumbPos;
                if (diff > 0 && diff < 15000) nearby.push(progUrls[ki].url);
              }
              if (nearby.length === 0) continue;
              var sdU = null, hdU = null;
              for (var ni = 0; ni < nearby.length; ni++) {
                if (nearby[ni].indexOf('720') !== -1) hdU = nearby[ni];
                else sdU = nearby[ni];
              }
              if (!sdU) sdU = nearby[0];
              // Avoid duplicates
              var exists = false;
              for (var vi = 0; vi < videos.length; vi++) {
                if (videos[vi].id === videoId) { exists = true; break; }
              }
              if (!exists) videos.push({ id: videoId, sdUrl: sdU, hdUrl: hdU });
            }
          }

          if (videos.length > 0) {
            window.postMessage({ type: 'FB_SCRAPER_VIDEO_URLS', videos: videos }, '*');
          }
        } catch (e) {}
      });
    }
    return _origSend.apply(this, arguments);
  };
})();
