(() => {
  console.log('[FB Scraper] Content script loaded on:', window.location.href);

  let isActive = false;
  let observer = null;
  let scrollInterval = null;
  let autoScrollInterval = null;
  let stallCount = 0;
  let lastPostCount = 0;
  let lastDocHeight = 0;
  let autoRetryCount = 0;
  let loggedInUserName = '';
  const MAX_STALL = 8; // Pause auto-scroll after 8 intervals with no new posts
  const MAX_AUTO_RETRY = 5; // Auto-retry up to 5 times before truly stopping
  const AUTO_RETRY_DELAY = 5000; // Wait 5 seconds before retrying
  const processedHashes = new Set();
  const SCAN_INTERVAL = 2000;
  const SCROLL_INTERVAL = 2500;

  // Detect the logged-in user's display name from Facebook's UI
  function detectLoggedInUser() {
    if (loggedInUserName) return loggedInUserName;

    // Method 1: Profile link in navigation (aria-label="Your profile")
    const profileLink = document.querySelector('a[aria-label="Your profile"], a[aria-label="你的個人檔案"], a[aria-label="你的个人主页"]');
    if (profileLink) {
      // The text inside, or the image alt, or the nearby span
      const img = profileLink.querySelector('img');
      if (img && img.alt && img.alt.length > 1 && img.alt.length < 60) {
        loggedInUserName = img.alt.trim();
        persistUserName(loggedInUserName);
        return loggedInUserName;
      }
      const span = profileLink.querySelector('span');
      if (span && span.innerText.trim().length > 1) {
        loggedInUserName = span.innerText.trim();
        persistUserName(loggedInUserName);
        return loggedInUserName;
      }
    }

    // Method 2: "What's on your mind" composer placeholder with user name
    const composers = document.querySelectorAll('[aria-label]');
    for (const el of composers) {
      const label = el.getAttribute('aria-label') || '';
      const match = label.match(/What.s on your mind,\s*(.+)\?/i) ||
                    label.match(/(.+)，你在想什麼？/) ||
                    label.match(/(.+)，在想些什么？/);
      if (match && match[1]) {
        loggedInUserName = match[1].trim();
        persistUserName(loggedInUserName);
        return loggedInUserName;
      }
    }

    return '';
  }

  // Save detected user name to storage so export-time cleanup can use it
  function persistUserName(name) {
    chrome.storage.local.set({ loggedInUserName: name });
  }

  // Strip the logged-in user's name from text to protect privacy
  function stripLoggedInUser(text) {
    const name = detectLoggedInUser();
    if (!name) return text;
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = text;
    // Remove the full name
    result = result.replace(new RegExp(escape(name), 'gi'), '');
    // Also remove individual name parts (first name, last name) as standalone lines
    // Users often sign posts with just their first name
    const parts = name.split(/\s+/).filter(p => p.length >= 2);
    for (const part of parts) {
      // Only remove as standalone line to avoid stripping common words from post content
      result = result.replace(new RegExp(`^${escape(part)}$`, 'gmi'), '');
    }
    // Clean up artifacts: empty lines, double spaces left behind
    result = result.replace(/^ +$/gm, '');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/  +/g, ' ');
    return result.trim();
  }

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

    // Strip "See more" artifacts (anywhere in text, not just end)
    postText = postText.replace(/…?\s*see more\s*/gi, '').trim();
    postText = postText.replace(/…?\s*See more…?\s*/g, '').trim();
    postText = postText.replace(/…?\s*顯示更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*查看更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*展開\s*/gi, '').trim();

    // Strip repeated "Facebook" lines (navigation noise leaking into post text)
    postText = postText.replace(/^(Facebook\n)+/g, '').trim();
    // Strip trailing "Facebook" noise
    postText = postText.replace(/(\nFacebook)+$/g, '').trim();

    // Strip scrambled "Sponsored" labels (obfuscated strings like "soptSrendogc34m...")
    // These contain mixed letters+digits with no punctuation, often with \xa0 (non-breaking space)
    postText = postText.replace(/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0]{20,}$/gm, '').trim();

    // Strip junk short URLs from link previews (random 4-10 char domains)
    postText = postText.replace(/^[a-zA-Z0-9]{2,15}\.(com|net|org)\s*$/gm, '').trim();

    // Strip m.me fragments (Messenger links) anywhere
    postText = postText.replace(/^m\.me\s*$/gm, '').trim();

    // Strip comment/share section that leaked into post text
    // This catches: "N comments", "N shares", "View more comments", commenter text
    postText = postText.replace(/\n\d+[kK]?\s*(comments?|則留言|條留言)\n[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)\n[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)$/i, '').trim();
    postText = postText.replace(/\nView more comments[\s\S]*$/i, '').trim();

    // Strip trailing comment/share UI artifacts
    postText = postText.replace(/\n(Photos from .+'s post)(\n.*)*$/i, '').trim();

    // Strip trailing bare numbers (reaction/comment counts leaking from UI)
    postText = postText.replace(/(\n\d{1,6}){1,3}\s*$/, '').trim();

    // Strip logged-in user's name to protect privacy (before dedup so name between halves doesn't block matching)
    postText = stripLoggedInUser(postText);

    // Clean up blank lines created by stripping
    postText = postText.replace(/\n{3,}/g, '\n\n').trim();

    // Line-level dedup: remove lines that already appeared earlier
    const paragraphs = postText.split('\n');
    const deduped = [];
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) { deduped.push(p); continue; }
      if (deduped.some(d => d.trim() === trimmed)) continue;
      deduped.push(p);
    }
    postText = deduped.join('\n').trim();

    // Block-level dedup: detect when a large portion of the text appears twice
    // (Facebook sometimes renders a compact version + a line-broken version)
    const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const fullNorm = normalize(postText);
    if (fullNorm.length > 40) {
      // Try splitting at each newline and check if the second half is a
      // whitespace-normalized duplicate of the first half
      const lines = postText.split('\n');
      for (let split = 1; split < lines.length; split++) {
        const firstHalf = lines.slice(0, split).join('\n');
        const secondHalf = lines.slice(split).join('\n');
        const normFirst = normalize(firstHalf);
        const normSecond = normalize(secondHalf);
        // If one half contains the other (after normalization), keep the longer original
        if (normFirst.length > 20 && normSecond.length > 20) {
          if (normFirst === normSecond) {
            // Identical halves — keep whichever has more line breaks (more readable)
            postText = firstHalf.split('\n').length >= secondHalf.split('\n').length ? firstHalf : secondHalf;
            break;
          }
          if (normFirst.includes(normSecond) && normSecond.length > normFirst.length * 0.6) {
            postText = firstHalf;
            break;
          }
          if (normSecond.includes(normFirst) && normFirst.length > normSecond.length * 0.6) {
            postText = secondHalf;
            break;
          }
        }
      }
    }

    // Final cleanup
    postText = postText.replace(/\n{3,}/g, '\n\n').trim();

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
    // Patterns that look like a timestamp
    const TIME_PATTERN = /^(\d+\s*(h|hr|m|min|s|d|w|yr|mo|小時|分鐘|秒|天|週)$|just now|yesterday|today|\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)|[a-z]+ \d{1,2}(,?\s*\d{4})?(\s+at\s+\d|$))/i;

    // Chinese date formats: "1月5日", "2023年12月23日", "12月23日 上午10:30"
    const CHINESE_DATE = /^\d{1,2}月\d{1,2}日|^\d{4}年\d{1,2}月/;

    // Permalink URL patterns
    const PERMALINK_PATTERNS = [
      '/posts/', '/permalink/', 'story_fbid', '/photos/',
      '/videos/', '/reel/', 'pfbid',
    ];

    function isPermalinkHref(href) {
      return PERMALINK_PATTERNS.some(p => href.includes(p)) ||
        (href.includes('/groups/') && /\/\d{10,}/.test(href)) ||
        (href.includes('/watch') && href.includes('v='));
    }

    function cleanPermalink(link) {
      try {
        const url = new URL(link.href, 'https://www.facebook.com');
        url.search = '';
        return url.toString();
      } catch {
        return link.href;
      }
    }

    function isTimestampText(text) {
      if (!text || text.length > 30) return false;
      // Reject obvious non-timestamps
      if (text.startsWith('http') || text.startsWith('May be')) return false;
      if (/shares?|comments?|likes?|reactions?/i.test(text)) return false;
      // Chinese date formats
      if (CHINESE_DATE.test(text)) return true;
      // Chinese text that isn't a time unit or date
      if (/[\u4e00-\u9fff]{4,}/.test(text) && !/[小時分鐘秒天週月年日]/.test(text)) return false;
      return TIME_PATTERN.test(text);
    }

    // Extract timestamp from a link element — checks text, aria-label, nested spans, use-sibling text
    function getTimestampFromLink(link) {
      // Check direct text
      const text = link.innerText.trim();
      if (isTimestampText(text)) return text;
      // Check aria-label
      const ariaLabel = link.getAttribute('aria-label') || '';
      if (isTimestampText(ariaLabel)) return ariaLabel;
      // Check nested spans
      for (const span of link.querySelectorAll('span, b')) {
        const spanText = span.innerText.trim();
        if (isTimestampText(spanText)) return spanText;
        const spanTitle = span.getAttribute('title') || '';
        if (isTimestampText(spanTitle)) return spanTitle;
      }
      // Check title attribute on the link
      const title = link.getAttribute('title') || '';
      if (isTimestampText(title)) return title;
      // Check aria-label on child elements (Facebook nests timestamp in hidden spans)
      for (const el of link.querySelectorAll('[aria-label]')) {
        const label = el.getAttribute('aria-label') || '';
        if (isTimestampText(label)) return label;
      }
      // Check <use> sibling text (SVG clock icon followed by timestamp text)
      const parent = link.parentElement;
      if (parent) {
        for (const child of parent.childNodes) {
          if (child.nodeType === 3) { // text node
            const t = child.textContent.trim();
            if (isTimestampText(t)) return t;
          }
        }
      }
      return '';
    }

    const links = container.querySelectorAll('a[href]');

    // Strategy 1: Permalink link with timestamp
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (isPermalinkHref(href)) {
        const ts = getTimestampFromLink(link);
        if (ts) return { timestamp: ts, permalink: cleanPermalink(link) };
      }
    }

    // Strategy 2: Any link whose text looks like a timestamp
    for (const link of links) {
      const ts = getTimestampFromLink(link);
      if (ts) {
        const href = link.getAttribute('href') || '';
        const permalink = isPermalinkHref(href) ? cleanPermalink(link) : '';
        return { timestamp: ts, permalink };
      }
    }

    // Strategy 3: aria-label containing full date info on any element
    for (const link of links) {
      const ariaLabel = link.getAttribute('aria-label') || '';
      if (ariaLabel && /\d{1,2},?\s*\d{4}|at \d{1,2}:\d{2}|\d+ (hour|minute|day|week)/i.test(ariaLabel) && ariaLabel.length < 40) {
        const text = link.innerText.trim() || ariaLabel;
        const permalink = cleanPermalink(link);
        return { timestamp: text.length < 30 ? text : ariaLabel, permalink };
      }
    }

    // Strategy 4: Search all spans for timestamp-like text
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = span.innerText.trim();
      if (isTimestampText(text)) {
        let permalink = '';
        const parentLink = span.closest('a[href]');
        if (parentLink) {
          const href = parentLink.getAttribute('href') || '';
          if (isPermalinkHref(href)) permalink = cleanPermalink(parentLink);
        }
        return { timestamp: text, permalink };
      }
      const title = span.getAttribute('title') || '';
      if (isTimestampText(title)) {
        return { timestamp: title, permalink: '' };
      }
    }

    // Strategy 5: Find permalink even if we can't find timestamp text
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (isPermalinkHref(href)) {
        return { timestamp: '', permalink: cleanPermalink(link) };
      }
    }

    // Fallback: abbr element (older Facebook layout)
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
      // Skip link preview proxy images (not directly downloadable)
      if (src.includes('safe_image.php') || src.includes('/external')) continue;
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
      console.log('[FB Scraper] Captured:', author, '|', postText.substring(0, 40) + '...');
    }, delay);
  }

  // Restore processedHashes from storage so resumed sessions skip already-scraped posts
  function restoreStateFromStorage() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_POSTS' }, (res) => {
        if (res && res.posts) {
          for (const post of res.posts) {
            const key = hashString((post.author || '') + (post.postText || ''));
            processedHashes.add(key);
          }
          console.log('[FB Scraper] Restored', processedHashes.size, 'hashes from storage');
        }
        resolve();
      });
    });
  }

  function startAutoScroll() {
    if (autoScrollInterval) return;
    autoScrollInterval = setInterval(() => {
      const currentCount = processedHashes.size;
      const currentDocHeight = document.documentElement.scrollHeight;

      if (currentCount > lastPostCount) {
        // New posts found — reset stall and retry counters
        stallCount = 0;
        autoRetryCount = 0;
        lastPostCount = currentCount;
        lastDocHeight = currentDocHeight;
      } else if (currentDocHeight > lastDocHeight) {
        // Page grew but posts not yet processed — partial reset
        stallCount = Math.max(0, stallCount - 1);
        lastDocHeight = currentDocHeight;
      } else {
        stallCount++;
        if (stallCount >= MAX_STALL) {
          clearInterval(autoScrollInterval);
          autoScrollInterval = null;

          if (autoRetryCount < MAX_AUTO_RETRY) {
            autoRetryCount++;
            console.log(`[FB Scraper] Stalled — auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} in ${AUTO_RETRY_DELAY / 1000}s...`);
            setTimeout(() => {
              if (!isActive) return; // Don't retry if user paused/stopped
              stallCount = 0;
              lastDocHeight = document.documentElement.scrollHeight;
              startAutoScroll();
            }, AUTO_RETRY_DELAY);
          } else {
            console.log('[FB Scraper] No new posts after ' + MAX_AUTO_RETRY + ' retries, stopping auto-scroll');
            chrome.runtime.sendMessage({ type: 'AUTO_SCROLL_DONE' });
          }
          return;
        }
      }

      // Scroll further when stalling
      const scrollAmount = stallCount > 5 ? 1500 : 800;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }, SCROLL_INTERVAL);
  }

  async function startObserver() {
    if (observer) return;

    console.log('[FB Scraper] Starting...');

    // Restore state from storage to avoid re-scraping posts
    await restoreStateFromStorage();

    // Resume downloads in background
    chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOADS' });

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

    // Auto-scroll: smoothly scroll down to trigger Facebook's infinite scroll
    stallCount = 0;
    autoRetryCount = 0;
    lastPostCount = processedHashes.size;
    lastDocHeight = document.documentElement.scrollHeight;
    startAutoScroll();

    console.log('[FB Scraper] Observer + periodic scanner + auto-scroll started');
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
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval);
      autoScrollInterval = null;
    }
    stallCount = 0;
    // Pause downloads when scraping is paused
    chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOADS' });
    console.log('[FB Scraper] Paused');
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
    } else if (msg.type === 'DETECT_NAME') {
      // Force re-detection (clear cache so it tries again)
      loggedInUserName = '';
      const name = detectLoggedInUser();
      sendResponse({ name });
    }
    return true;
  });

  // Auto-detect logged-in user's name on page load.
  // The Facebook nav bar takes a moment to render, so retry a few times.
  let nameDetectAttempts = 0;
  function tryDetectName() {
    if (loggedInUserName) return; // already found
    const name = detectLoggedInUser();
    if (name) {
      console.log('[FB Scraper] Auto-detected user name:', name);
      return;
    }
    nameDetectAttempts++;
    if (nameDetectAttempts < 10) {
      setTimeout(tryDetectName, 2000);
    }
  }
  // Start detection after a short delay to let Facebook's UI render
  setTimeout(tryDetectName, 1500);
})();
