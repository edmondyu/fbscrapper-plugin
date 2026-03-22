// Injected into the main world at document_start (before Facebook's JS runs).
// Facebook uses XMLHttpRequest (not fetch) for GraphQL calls, so we intercept XHR.
(function () {
  if (window._fbScraperInterceptorInstalled) return;
  window._fbScraperInterceptorInstalled = true;

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
          var re = /"creation_time"\s*:\s*(\d{9,11})/g;
          var times = [];
          var m;
          while ((m = re.exec(text)) !== null) times.push(parseInt(m[1], 10));
          if (times.length > 0) {
            window.postMessage({ type: 'FB_SCRAPER_CREATION_TIMES', times: times }, '*');
          }
        } catch (e) {}
      });
    }
    return _origSend.apply(this, arguments);
  };
})();
