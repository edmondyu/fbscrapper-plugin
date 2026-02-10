(() => {
  console.log('[FB Scraper] Content script loaded on:', window.location.href);

  let isActive = false;
  let observer = null;
  let scrollInterval = null;
  const processedHashes = new Set();
  const SCAN_INTERVAL = 2000;

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString();
  }

  // Walk up from a text element to find its post container.
  // The post container is identified as the ancestor div with many children
  // (Facebook wraps each post in a div with 15+ child elements for
  // header, content, reactions, comments, etc.)
  function findPostContainer(el) {
    let p = el;
    for (let i = 0; i < 20; i++) {
      p = p.parentElement;
      if (!p || p === document.body) return null;
      // A post container typically has many direct children (header, body,
      // action bar, reactions, comments section, etc.)
      if (p.children.length >= 10 && p.innerText.length > 100) {
        return p;
      }
    }
    return null;
  }

  // Click "See more" links within a container
  function clickSeeMore(container) {
    const candidates = container.querySelectorAll(
      'div[role="button"], span[role="button"], a[role="link"], span[tabindex="0"], div[tabindex="0"]'
    );
    let clicked = false;
    for (const el of candidates) {
      const text = el.innerText.trim().toLowerCase();
      if (
        text === 'see more' ||
        text === 'see more…' ||
        text === '...see more' ||
        text === '… see more' ||
        text === '顯示更多' ||
        text === '查看更多' ||
        text === '展開'
      ) {
        el.click();
        clicked = true;
      }
    }
    return clicked;
  }

  // Extract all meaningful text from a post container, excluding UI elements
  function extractPostText(container) {
    const dirAutoEls = container.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    const texts = [];

    for (const el of dirAutoEls) {
      const text = el.innerText.trim();
      if (!text || text.length < 2) continue;

      // Skip UI elements: buttons, short labels
      const lower = text.toLowerCase();
      if (/^(like|comment|share|send|reply|see more|hide|follow|suggested for you|sponsored|·|…)$/i.test(lower)) continue;
      if (/^(boost|insights|promote|advertise)/i.test(lower)) continue;
      if (/^(switch into|you're commenting|manage|write a comment)/i.test(lower)) continue;
      if (/^boost this post/i.test(lower)) continue;

      texts.push(text);
    }

    // Deduplicate: remove texts that are substrings of longer texts
    const unique = texts.filter((t, i) =>
      !texts.some((other, j) => j !== i && other.length > t.length && other.includes(t))
    );

    let postText = unique.join('\n');

    // Strip "See more" artifacts
    postText = postText.replace(/…?\s*see more\s*$/i, '').trim();
    postText = postText.replace(/…?\s*顯示更多\s*$/i, '').trim();
    postText = postText.replace(/…?\s*查看更多\s*$/i, '').trim();

    // Strip repeated "Facebook" lines (navigation noise leaking into post text)
    postText = postText.replace(/^(Facebook\n)+/g, '').trim();
    // Strip trailing "Facebook" noise
    postText = postText.replace(/(\nFacebook)+$/g, '').trim();
    // Strip trailing comment/share UI artifacts
    postText = postText.replace(/\n(Photos from .+'s post)(\n.*)*$/i, '').trim();
    postText = postText.replace(/\nm\.me$/i, '').trim();
    // Strip trailing share count artifacts (e.g. "59 shares")
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)$/i, '').trim();
    // Strip "View more comments"
    postText = postText.replace(/\nView more comments$/i, '').trim();

    return postText;
  }

  // Extract author name from a post container
  function extractAuthor(container) {
    // Try headings first
    const headings = container.querySelectorAll('h2, h3, h4');
    for (const h of headings) {
      const text = h.innerText.trim();
      if (text && text.length > 1 && text.length < 100) {
        return text;
      }
    }
    // Try strong > a pattern
    const strongLinks = container.querySelectorAll('strong a, strong');
    for (const el of strongLinks) {
      const text = el.innerText.trim();
      if (text && text.length > 1 && text.length < 100) {
        return text;
      }
    }
    return '';
  }

  // Extract timestamp and permalink from a post container
  function extractTimestamp(container) {
    const links = container.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (
        href.includes('/posts/') ||
        href.includes('/permalink/') ||
        href.includes('story_fbid') ||
        href.includes('/photos/') ||
        href.includes('/videos/') ||
        href.includes('/reel/') ||
        (href.includes('/watch') && href.includes('v='))
      ) {
        const text = link.innerText.trim();
        if (text && text.length < 50 && text.length > 0) {
          let permalink = '';
          try {
            const url = new URL(link.href, 'https://www.facebook.com');
            url.search = '';
            permalink = url.toString();
          } catch {
            permalink = link.href;
          }
          return { timestamp: text, permalink };
        }
      }
    }
    // Fallback: abbr
    const abbr = container.querySelector('abbr');
    if (abbr) {
      return { timestamp: abbr.innerText.trim(), permalink: '' };
    }
    return { timestamp: '', permalink: '' };
  }

  // Extract reactions count
  function extractReactions(container) {
    const els = container.querySelectorAll('[aria-label]');
    for (const el of els) {
      const label = el.getAttribute('aria-label') || '';
      if (/reaction|like|love|haha|wow|sad|angry/i.test(label) && /\d/.test(label)) {
        return label;
      }
    }
    return '';
  }

  // Extract image URLs from a post container
  function extractImages(container) {
    const imgs = container.querySelectorAll('img');
    const urls = [];
    const seen = new Set();
    for (const img of imgs) {
      const src = img.src || '';
      if (!src) continue;
      // Skip tiny icons, emojis, profile pics, and UI elements
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && w < 50 && h > 0 && h < 50) continue;
      // Skip data URIs and tracking pixels
      if (src.startsWith('data:')) continue;
      // Skip emoji images and reaction icons
      if (src.includes('/emoji') || src.includes('/reaction')) continue;
      // Skip profile pictures (typically small, in specific paths)
      if (src.includes('/p50x50/') || src.includes('/p40x40/') || src.includes('/p36x36/')) continue;
      // Keep scontent images (actual post photos/images)
      if (src.includes('scontent') || src.includes('fbcdn.net')) {
        if (!seen.has(src)) {
          seen.add(src);
          urls.push(src);
        }
      }
    }
    return urls;
  }

  // Extract video URLs from a post container
  function extractVideos(container) {
    const urls = [];
    const seen = new Set();

    // 1. Check for <video> elements with direct src
    const videos = container.querySelectorAll('video');
    for (const video of videos) {
      const src = video.getAttribute('src') || '';
      if (src && !src.startsWith('data:') && !src.startsWith('blob:') && !seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
      // Also check <source> children
      const sources = video.querySelectorAll('source');
      for (const source of sources) {
        const ssrc = source.getAttribute('src') || '';
        if (ssrc && !ssrc.startsWith('data:') && !ssrc.startsWith('blob:') && !seen.has(ssrc)) {
          seen.add(ssrc);
          urls.push(ssrc);
        }
      }
    }

    // 2. Check for links to Facebook video pages (/videos/, /reel/, /watch?v=)
    const links = container.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (
        href.includes('/videos/') ||
        href.includes('/reel/') ||
        (href.includes('/watch') && href.includes('v='))
      ) {
        try {
          const url = new URL(link.href, 'https://www.facebook.com');
          url.search = '';
          const clean = url.toString();
          if (!seen.has(clean)) {
            seen.add(clean);
            urls.push(clean);
          }
        } catch {
          if (!seen.has(link.href)) {
            seen.add(link.href);
            urls.push(link.href);
          }
        }
      }
    }

    return urls;
  }

  // Extract comments count
  function extractComments(container) {
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = span.innerText.trim();
      if (/^\d+[kK]?\s*(comments?|則留言|條留言)$/i.test(text)) {
        return text;
      }
    }
    return '';
  }

  // Find all post text elements on the page and process their containers
  function scanForPosts() {
    // Find all dir="auto" elements with meaningful text content
    const allDirAuto = document.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    const seenContainers = new Set();

    let found = 0;
    for (const el of allDirAuto) {
      const text = el.innerText.trim();
      // Must have some real content (not just UI labels)
      if (text.length < 8) continue;
      // Skip known UI patterns
      if (/^(switch into|you're commenting|manage|boost this|write a comment)/i.test(text)) continue;
      if (/^(like|comment|share|send|reply|follow|sponsored)$/i.test(text)) continue;

      // Find the post container for this text element
      const container = findPostContainer(el);
      if (!container) continue;

      // Skip if already processed this container in this scan
      if (seenContainers.has(container)) continue;
      seenContainers.add(container);

      // Skip if already scraped
      if (container.dataset.fbScraperDone) continue;

      // Skip if this container is inside an already-processed container
      // (prevents duplicate text-only captures from inner elements)
      let ancestor = container.parentElement;
      let isNested = false;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.dataset.fbScraperDone) {
          isNested = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (isNested) {
        container.dataset.fbScraperDone = 'true';
        continue;
      }

      found++;
      processPost(container);
    }

    if (found > 0) {
      console.log(`[FB Scraper] Scan found ${found} new post containers`);
    }
  }

  function processPost(container) {
    container.dataset.fbScraperDone = 'true';

    // Click "See more" to expand, then extract after delay
    const clicked = clickSeeMore(container);
    const delay = clicked ? 600 : 0;

    setTimeout(() => {
      // Click again in case expansion revealed more
      if (clicked) clickSeeMore(container);

      const postText = extractPostText(container);
      const author = extractAuthor(container);

      if (!postText && !author) {
        console.log('[FB Scraper] Skipped empty container');
        return;
      }

      // Skip non-post content (notifications panel, nav elements, etc.)
      if (/^(your push notifications|turn on notifications|not now|new see all)/i.test(postText)) {
        console.log('[FB Scraper] Skipped notifications panel');
        return;
      }
      // Skip if postText is just repeated single words (nav/sidebar noise)
      const lines = postText.split('\n').map(l => l.trim()).filter(l => l);
      const uniqueLines = new Set(lines);
      if (uniqueLines.size <= 2 && lines.length > 3) {
        console.log('[FB Scraper] Skipped repetitive content');
        return;
      }

      // Deduplicate
      const key = hashString(author + postText);
      if (processedHashes.has(key)) return;
      processedHashes.add(key);

      const { timestamp, permalink } = extractTimestamp(container);
      const reactions = extractReactions(container);
      const comments = extractComments(container);
      const images = extractImages(container);
      const videos = extractVideos(container);

      const post = {
        author,
        postText,
        timestamp,
        permalink,
        reactions,
        comments,
        images,
        videos,
        scrapedAt: new Date().toISOString(),
      };

      chrome.runtime.sendMessage({ type: 'NEW_POST', post });
      console.log('[FB Scraper] Captured:', author, '|', postText.substring(0, 60) + '...');
    }, delay);
  }

  function startObserver() {
    if (observer) return;

    console.log('[FB Scraper] Starting...');

    // Initial scan
    scanForPosts();

    // MutationObserver for dynamically added content
    observer = new MutationObserver(() => {
      // Debounce: don't scan on every tiny mutation
      clearTimeout(observer._debounce);
      observer._debounce = setTimeout(scanForPosts, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Periodic fallback scanner
    scrollInterval = setInterval(scanForPosts, SCAN_INTERVAL);

    console.log('[FB Scraper] Observer + periodic scanner started');
  }

  function stopObserver() {
    if (observer) {
      clearTimeout(observer._debounce);
      observer.disconnect();
      observer = null;
    }
    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }
    console.log('[FB Scraper] Stopped');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SET_ACTIVE') {
      isActive = msg.active;
      if (isActive) {
        startObserver();
      } else {
        stopObserver();
      }
      sendResponse({ ok: true, active: isActive });
    } else if (msg.type === 'GET_STATUS') {
      sendResponse({ active: isActive });
    }
    return true;
  });
})();
