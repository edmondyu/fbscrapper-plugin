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
  const MAX_STALL = 6; // Pause auto-scroll after 6 intervals with no new posts
  const MAX_AUTO_RETRY = 5; // Auto-retry up to 5 times before truly stopping
  const AUTO_RETRY_DELAY = 3000; // Wait 3 seconds before retrying
  const processedHashes = new Set();
  const processedPermalinks = new Map(); // permalink -> text length of best capture
  const processedPrefixes = new Map(); // hash(author + first 40 chars) -> { textLength, hash }
  // WeakSet of dir="auto" elements already evaluated by the scan loop.
  // Allows O(1) skip on subsequent scans — avoids calling findPostContainer
  // (a DOM-tree walk) for thousands of already-processed elements every 1.2s.
  // WeakSet holds references weakly so GC'd (Facebook-removed) nodes are freed.
  const _scanSeenElements = new WeakSet();
  // Map from date key ("16 February") to sorted array of unix timestamps (newest first)
  // populated by intercepting Facebook's GraphQL feed responses.
  const _creationTimesByDate = new Map();
  const SCAN_INTERVAL = 900;
  const SCROLL_INTERVAL = 1000;

  // Cached dir="auto" element count from last scan — used to scale throttle/debounce
  // with DOM size (spam-heavy pages can have 5000+ matching elements).
  let _lastDirAutoCount = 0;
  // Highest scrollY reached — persisted to storage so the scraper can resume from
  // the same position after a page blank-out or manual reload.
  let _scrollHighWaterMark = 0;
  let _lastPersistedWatermark = 0;
  // Fast-forward mode: scroll at 4× speed through already-scraped content until we
  // reach the previous session's watermark, then drop back to normal speed.
  let _fastForwardMode = false;
  let _resumeTargetWatermark = 0;
  // DOM silence detector state
  let _silenceInterval = null;
  let _lastMutationTime = Date.now();

  // Posts that were saved with a date-only timestamp and need a retry once
  // creation_time data arrives from the GraphQL response.
  // Map: permalink -> rawDate (e.g. "16 February")
  const _pendingTimestampPosts = new Map();

  // Map: videoId (string) -> { permalink, matchPrefix, matchAuthor }
  // Populated when a post with a video poster URL is captured.
  // Consumed when FB_SCRAPER_VIDEO_URLS arrives with the actual MP4 URL.
  const _pendingVideoIdPosts = new Map();

  // Cache: videoId (string) -> mp4Url
  // Populated when FB_SCRAPER_VIDEO_URLS arrives before processPost runs.
  // Checked immediately in registerVideoIds so the race condition is handled.
  const _receivedVideoUrls = new Map();

  // Extract the video ID from a poster URL (t15.5256 CDN).
  // Poster filename format: "<videoId>_<otherId>_<otherId>_n.jpg"
  // Returns the first numeric segment, or null.
  function extractVideoIdFromPosterUrl(url) {
    const m = url.match(/\/(\d+)_\d+_\d+_n\.jpg/);
    return m ? m[1] : null;
  }

  // Register video IDs for a newly captured post so that when the GraphQL
  // video URL arrives later we can match it back to this post.
  // If the URL already arrived (race condition), sends UPDATE_VIDEO immediately.
  function registerVideoIds(videos, permalink, matchPrefix, matchAuthor) {
    for (const posterUrl of videos) {
      const videoId = extractVideoIdFromPosterUrl(posterUrl);
      if (!videoId) continue;
      const cached = _receivedVideoUrls.get(videoId);
      if (cached) {
        // GraphQL already arrived — fire UPDATE_VIDEO right away
        const msg = { type: 'UPDATE_VIDEO', videoId, mp4Url: cached };
        if (permalink) msg.permalink = permalink;
        if (matchPrefix) { msg.matchPrefix = matchPrefix; msg.matchAuthor = matchAuthor; }
        chrome.runtime.sendMessage(msg).catch(() => {});
      } else {
        _pendingVideoIdPosts.set(videoId, { permalink, matchPrefix, matchAuthor });
      }
    }
  }

  // CDP test-bridge: allow main-world evaluate_script to send commands to the
  // isolated-world content script via postMessage.
  window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data || e.data.type !== 'FB_SCRAPER_CMD') return;
    const cmd = e.data.cmd;
    if (cmd === 'start') { isActive = true; startObserver(); startAutoScroll(); }
    else if (cmd === 'stop') { isActive = false; }
    else if (cmd === 'getStorage') {
      chrome.storage.local.get(e.data.keys || ['posts', 'downloadQueue'], function(r) {
        window.postMessage({ type: 'FB_SCRAPER_CMD_RESULT', requestId: e.data.requestId, result: r }, '*');
      });
    }
    else if (cmd === 'clearAll') {
      chrome.storage.local.set({ posts: [], downloadQueue: [] }, function() {
        window.postMessage({ type: 'FB_SCRAPER_CMD_RESULT', requestId: e.data.requestId, result: 'cleared' }, '*');
      });
    }
  });

  // Listen for creation_time batches and video URL batches from the main-world interceptor.
  window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data) return;

    // ── Video URL updates ────────────────────────────────────────────────────
    if (e.data.type === 'FB_SCRAPER_VIDEO_URLS') {
      for (const { id, sdUrl, hdUrl } of e.data.videos) {
        const mp4Url = hdUrl || sdUrl;
        if (!mp4Url) continue;
        // Always cache so registerVideoIds can use it if processPost runs later
        _receivedVideoUrls.set(id, mp4Url);
        const pending = _pendingVideoIdPosts.get(id);
        if (!pending) continue;
        _pendingVideoIdPosts.delete(id);
        const msg = { type: 'UPDATE_VIDEO', videoId: id, mp4Url };
        if (pending.permalink) msg.permalink = pending.permalink;
        if (pending.matchPrefix) { msg.matchPrefix = pending.matchPrefix; msg.matchAuthor = pending.matchAuthor; }
        chrome.runtime.sendMessage(msg).catch(() => {});
      }
      return;
    }

    if (e.data.type !== 'FB_SCRAPER_CREATION_TIMES') return;
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    for (const ts of e.data.times) {
      const d = new Date(ts * 1000);
      const key = d.getDate() + ' ' + MONTHS[d.getMonth()];
      if (!_creationTimesByDate.has(key)) _creationTimesByDate.set(key, []);
      _creationTimesByDate.get(key).push(ts);
    }
    // Keep each date bucket sorted newest-first so lookups consume in feed order
    for (const [, arr] of _creationTimesByDate) arr.sort((a, b) => b - a);
    // Retry any posts that were stored with a date-only timestamp
    if (_pendingTimestampPosts.size > 0) {
      for (const [permalink, rawDate] of Array.from(_pendingTimestampPosts)) {
        const full = lookupCreationTime(rawDate);
        if (full) {
          _pendingTimestampPosts.delete(permalink);
          chrome.runtime.sendMessage({
            type: 'UPDATE_TIMESTAMP',
            permalink,
            oldTimestamp: rawDate,
            newTimestamp: full
          });
        }
      }
    }
  });

  // Detect the logged-in user's display name from Facebook's UI
  function detectLoggedInUser() {
    if (loggedInUserName) return loggedInUserName;

    // Method 1: Profile link in navigation (aria-label="Your profile")
    // Facebook renders this as <a> on home feed but <div> on Page timelines
    const profileLink = document.querySelector('[aria-label="Your profile"], [aria-label="你的個人檔案"], [aria-label="你的个人主页"]');
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

    // Method 3: Search page's inline <script> tags for viewer data
    // Facebook embeds the logged-in user's name in JSON data within script elements
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.length < 50) continue;
      const m = text.match(/"viewer"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{2,50})"/);
      if (m && m[1]) {
        loggedInUserName = m[1].trim();
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

  // Cheap check for whether a DOM element contains at least minLength chars
  // of text.  Uses a TreeWalker that stops as soon as the threshold is met —
  // never builds a full concatenated string.  Safe to call on large containers
  // near the DOM root where textContent would produce multi-MB strings.
  function hasSubstantialText(el, minLength) {
    let total = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      total += node.nodeValue.length;
      if (total >= minLength) return true;
    }
    return false;
  }

  // Walk up from a text element to find its post container.
  // Facebook uses a virtualized feed (data-virtualized attribute) where each
  // direct child is one post.  We stop just below that boundary so each post
  // gets its own container.  For pages without virtualization we fall back to
  // the original "many children" heuristic.
  function findPostContainer(el) {
    let p = el;
    let lastCandidate = null;
    for (let i = 0; i < 20; i++) {
      p = p.parentElement;
      if (!p || p === document.body) break;

      // If the parent is a virtualized feed container, p is a direct feed
      // child — return it (or the best candidate found so far inside it)
      if (p.parentElement && p.parentElement.hasAttribute('data-virtualized')) {
        return lastCandidate || p;
      }

      // Original heuristic: container with many children.
      // Use hasSubstantialText instead of p.innerText.length — innerText
      // forces a layout reflow, and textContent on large containers builds
      // a multi-MB string.  TreeWalker bails out early at the threshold.
      if (p.children.length >= 10 && hasSubstantialText(p, 100)) {
        if (isNonPostContainer(p)) continue;
        if (p.querySelector('a[href]') === null) continue;
        return lastCandidate || p;
      }

      if (p.children.length >= 3 && p.querySelector('a[href]') && hasSubstantialText(p, 20)) {
        const hasAuthor = p.querySelector('h2, h3, h4, h5, h6, strong');
        if (hasAuthor) {
          if (!lastCandidate || p.children.length > lastCandidate.children.length) {
            lastCandidate = p;
          }
        }
      }
    }
    return lastCandidate || null;
  }

  // Detect containers that are NOT posts (notifications, nav bars, sidebars)
  // Uses only fast attribute checks — avoids expensive innerText access
  function isNonPostContainer(el) {
    // Check aria-label for known non-post sections (fast attribute read)
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(notifications?|chats?|contacts|messenger|bookmarks|shortcuts)$/i.test(ariaLabel)) return true;

    // Check for notification panel markers via direct child text nodes or specific elements
    if (el.querySelector('[aria-label="Notifications"], [aria-label="通知"], [aria-label="Your notifications"]')) return true;

    // Check first direct child's textContent (cheap — not full innerText)
    const firstChild = el.firstElementChild;
    if (firstChild) {
      const firstText = firstChild.textContent.substring(0, 80).trim();
      if (/^(your push notifications|你的推播通知|turn on notifications)/i.test(firstText)) return true;
      // Navigation sidebar: first child is all "Facebook" repeated
      if (/^(Facebook\s*){5,}/.test(firstText)) return true;
    }

    return false;
  }

  // Text patterns that match "See more" buttons in various languages
  const SEE_MORE_TEXTS = new Set([
    'see more', 'see more…', '...see more', '… see more',
    '顯示更多', '查看更多', '展開', '展開全文', '顯示全文', '閱讀更多',
  ]);

  // Click "See more" links within a container
  function clickSeeMore(container) {
    let clicked = false;

    // Strategy 1: elements with interactive attributes (original approach)
    const interactive = container.querySelectorAll(
      'div[role="button"], span[role="button"], a[role="link"], span[tabindex="0"], div[tabindex="0"]'
    );
    for (const el of interactive) {
      const text = el.innerText.trim().toLowerCase();
      if (SEE_MORE_TEXTS.has(text)) {
        el.click();
        clicked = true;
      }
    }

    // Strategy 2: if nothing found, try any leaf element whose only text
    // is a "See more" pattern (Facebook sometimes omits role/tabindex)
    if (!clicked) {
      const allEls = container.querySelectorAll('div, span, a');
      for (const el of allEls) {
        if (el.children.length > 1) continue;
        const text = el.innerText.trim().toLowerCase();
        if (SEE_MORE_TEXTS.has(text)) {
          el.click();
          clicked = true;
          break; // click only one to avoid side effects
        }
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
      if (/^(like|comment|share|send|reply|see more|hide|follow|suggested for you|sponsored|facebook|·|…)$/i.test(lower)) continue;
      if (/^(boost|insights|promote|advertise)/i.test(lower)) continue;
      if (/^(switch into|you're commenting|manage|write a comment)/i.test(lower)) continue;
      if (/^boost this post/i.test(lower)) continue;
      // Skip page header / profile section labels that leak into post containers
      if (/^(send message|message|like page|follow page|get directions|call now|shop now|book now|sign up|learn more|watch more|contact us)$/i.test(lower)) continue;
      if (/^(personal blog|public figure|politician|musician|actor|director|artist|writer|journalist|news|media|business|brand|community|organisation|nonprofit)$/i.test(lower)) continue;

      texts.push(text);
    }

    // Deduplicate: remove exact duplicates and texts that are substrings of longer texts
    const unique = texts.filter((t, i) => {
      // Remove exact duplicates (keep first occurrence only)
      if (texts.indexOf(t) !== i) return false;
      // Remove texts that are substrings of longer texts
      return !texts.some((other, j) => j !== i && other.length > t.length && other.includes(t));
    });

    let postText = unique.join('\n');

    // Strip "See more" artifacts (anywhere in text, not just end)
    postText = postText.replace(/…?\s*see more\s*/gi, '').trim();
    postText = postText.replace(/…?\s*See more…?\s*/g, '').trim();
    postText = postText.replace(/…?\s*顯示更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*查看更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*展開\s*/gi, '').trim();
    postText = postText.replace(/…?\s*展開全文\s*/gi, '').trim();
    postText = postText.replace(/…?\s*顯示全文\s*/gi, '').trim();
    postText = postText.replace(/…?\s*閱讀更多\s*/gi, '').trim();

    // Strip repeated "Facebook" lines (navigation noise leaking into post text)
    postText = postText.replace(/^(Facebook\n)+/g, '').trim();
    // Strip trailing "Facebook" noise
    postText = postText.replace(/(\nFacebook)+$/g, '').trim();

    // Strip scrambled "Sponsored" labels (obfuscated strings like "soptSrendogc34m...")
    // These contain mixed letters+digits with no punctuation, often with \xa0 (non-breaking space)
    postText = postText.replace(/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0]{20,}$/gm, '').trim();

    // Strip junk short URLs from link previews (random 4-10 char domains).
    // Three patterns needed:
    //   1. Standalone line:  "NR42jdCK.com" on its own line
    //   2. Trailing suffix:  "【Title】NR42jdCK.com" at end of line
    //   3. Inline (middle):  "【Title】NR42jdCK.com 【Title】" — URL between two
    //      copies of the post title.  Replace with newline so the line-level
    //      dedup below can eliminate the resulting duplicate.
    postText = postText.replace(/^[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s*$/gm, '').trim();
    postText = postText.replace(/\s*[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s*$/gm, '').trim();
    postText = postText.replace(/\s+[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s+/g, '\n').trim();

    // Strip m.me fragments (Messenger links) — standalone, trailing, or inline.
    // Handles bare "m.me" and paths like "m.me/pagename".
    postText = postText.replace(/^m\.me(\/\S*)?\s*$/gm, '').trim();
    postText = postText.replace(/\s*m\.me(\/\S*)?\s*$/gm, '').trim();
    postText = postText.replace(/\s+m\.me(\/\S*)?\s+/g, '\n').trim();

    // Strip page header noise: "PageName Personal blog Send message" or
    // "PageName Public figure Message" trailing on a post title line.
    // This leaks in when the post container is large enough to include
    // the page profile section above the feed.
    postText = postText.replace(/\s+(personal blog|public figure|politician|musician|actor|writer|journalist|news|media|business|community|nonprofit)\s+(send message|message|follow|like page)\s*$/gi, '').trim();
    postText = postText.replace(/\n.*?(personal blog|public figure|politician|musician|actor|writer|journalist|news|media|business|community|nonprofit).*?(send message|message).*$/gi, '').trim();

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

  // Fallback text extraction using container.innerText line-by-line.
  // Used when dir="auto" elements don't hold the full text (e.g. photo post captions
  // that Facebook renders outside dir="auto" elements after "See more" expansion).
  // anchorText: the already-captured partial text used to locate where the post
  // content begins within innerText, to skip navigation noise that precedes it.
  // Posts need not have a title structure — anchorText may be any fragment from
  // the beginning of the post as captured by extractPostText.
  function extractPostTextFallback(container, authorName, anchorText) {
    const raw = (container.innerText || '').trim();
    if (!raw) return '';

    let workingRaw = raw;

    // When navigation noise is present, anchor to the already-captured fragment
    // so we skip repeated "Facebook" navigation links and sidebar content above the post.
    if (raw.includes('FacebookFacebook') || raw.length > 10000) {
      if (!anchorText || anchorText.length < 2) return '';
      const startIdx = raw.indexOf(anchorText);
      if (startIdx < 0) return '';
      workingRaw = raw.substring(startIdx);
      // Still unreasonably large after the slice — wrong container
      if (workingRaw.length > 10000) return '';
    }

    // Preprocess workingRaw before line-splitting to remove Facebook UI patterns
    // that appear INLINE (no newline separator) within the container's innerText.

    // Truncate at "All reactions:" — everything from here onwards is Facebook
    // engagement UI. This also catches scrambled obfuscation codes that Facebook
    // places on the same line immediately before "All reactions:".
    const reactIdx = workingRaw.search(/all reactions?:/i);
    if (reactIdx >= 0) workingRaw = workingRaw.substring(0, reactIdx);

    // Remove m.me Messenger links — appear inline with the post title (no newline).
    workingRaw = workingRaw.replace(/m\.me(\/\S*)?\s*/g, '');

    // Remove photo/video attribution — "Photos from [Author]'s post" appears
    // inline with captions on photo posts (no newline before it).
    workingRaw = workingRaw.replace(/(?:photos?|videos?) from [^\n]*post/gi, '');

    workingRaw = workingRaw.trim();
    if (!workingRaw) return '';

    const lines = workingRaw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const texts = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Stop at the Facebook action bar — everything after is noise
      if (/^(like|comment|share|send|讚好|留言|分享)$/.test(lower)) break;
      // Combined action bar on one line: "Like · Comment · Share"
      if (/like.{0,5}comment.{0,5}share/i.test(lower) && lower.length < 60) break;
      if (/^(most relevant|all comments|view more comments|write a comment)$/i.test(lower)) break;
      // Skip author name (already stored separately)
      if (authorName && line === authorName) continue;
      // Same filters as extractPostText
      if (/^(like|comment|share|send|reply|see more|hide|follow|suggested for you|sponsored|facebook|·|…)$/i.test(lower)) continue;
      if (/^(boost|insights|promote|advertise)/i.test(lower)) continue;
      if (/^(switch into|you're commenting|manage|write a comment)/i.test(lower)) continue;
      if (/^boost this post/i.test(lower)) continue;
      if (/^(send message|message|like page|follow page|get directions|call now|shop now|book now|sign up|learn more|watch more|contact us)$/i.test(lower)) continue;
      if (/^(personal blog|public figure|politician|musician|actor|director|artist|writer|journalist|news|media|business|brand|community|organisation|nonprofit)$/i.test(lower)) continue;
      if (line.length < 2) continue;
      // Scrambled obfuscated strings (FB tracking codes, sponsored noise)
      if (/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0\t]{20,}$/.test(line)) continue;
      if (/^\d+\s*(hr|min|h|m|d|w|sec|s)s?\s*(ago)?$/i.test(lower)) continue; // timestamps
      if (/^(public|friends|only me|custom|followers)$/i.test(lower)) continue; // audience
      if (/^(you,?\s|you and |\d+ others$)/.test(lower)) continue; // reaction counts
      if (/^\d+\s*(reactions?|comments?|shares?|views?)$/.test(lower)) continue;
      // Facebook photo/video attribution lines (standalone — inline case handled above)
      if (/^photos? from .+post$/i.test(lower)) continue;
      if (/^videos? from .+post$/i.test(lower)) continue;
      // Reaction name lists: "1K Name1, Name2 and 1K others"
      if (/\band \d+[kK]? others$/i.test(lower)) continue;
      // Messenger shortlink (standalone — inline case handled above)
      if (/^m\.me(\/\S+)?$/i.test(lower)) continue;
      texts.push(line);
    }

    // Deduplicate (same as extractPostText)
    const unique = texts.filter((t, i) => {
      if (texts.indexOf(t) !== i) return false;
      return !texts.some((other, j) => j !== i && other.length > t.length && other.includes(t));
    });

    let postText = unique.join('\n');

    // Apply same cleanup regexes as extractPostText
    postText = postText.replace(/…?\s*see more\s*/gi, '').trim();
    postText = postText.replace(/…?\s*顯示更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*查看更多\s*/gi, '').trim();
    postText = postText.replace(/…?\s*展開\s*/gi, '').trim();
    postText = postText.replace(/…?\s*展開全文\s*/gi, '').trim();
    postText = postText.replace(/…?\s*顯示全文\s*/gi, '').trim();
    postText = postText.replace(/…?\s*閱讀更多\s*/gi, '').trim();
    postText = postText.replace(/^(Facebook\n)+/g, '').trim();
    postText = postText.replace(/(\nFacebook)+$/g, '').trim();
    postText = postText.replace(/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0]{20,}$/gm, '').trim();
    postText = postText.replace(/^[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s*$/gm, '').trim();
    postText = postText.replace(/\s*[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s*$/gm, '').trim();
    postText = postText.replace(/^m\.me\s*$/gm, '').trim();
    postText = postText.replace(/\s*m\.me\s*$/gm, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(comments?|則留言|條留言)\n[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)\n[\s\S]*$/i, '').trim();
    postText = stripLoggedInUser(postText);
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
    const TIME_PATTERN = /^(\d+\s*(h|hr|m|min|s|d|w|yr|mo|小時|分鐘|秒|天|週)$|just now|yesterday|today|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|about\s+(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago|\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)|[a-z]+ \d{1,2}(,?\s*\d{4})?(\s+at\s+\d|$))/i;

    // Chinese date formats: "1月5日", "2023年12月23日", "12月23日 上午10:30"
    const CHINESE_DATE = /^\d{1,2}月\d{1,2}日|^\d{4}年\d{1,2}月/;

    // Permalink URL patterns
    const PERMALINK_PATTERNS = [
      '/posts/', '/permalink/', 'story_fbid', '/photos/', '/photo/',
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
        // Preserve identifying query params (fbid, story_fbid, v) before stripping
        const fbid = url.searchParams.get('fbid');
        const storyFbid = url.searchParams.get('story_fbid');
        const videoId = url.searchParams.get('v');
        url.search = '';
        // Re-add identifying params so the permalink remains unique
        if (fbid) url.searchParams.set('fbid', fbid);
        if (storyFbid) url.searchParams.set('story_fbid', storyFbid);
        if (videoId) url.searchParams.set('v', videoId);
        const cleaned = url.toString();
        // Reject generic paths that aren't unique identifiers
        // e.g. "https://www.facebook.com/photo/" with no fbid
        if (/\/(photo|photos|videos)\/?$/.test(url.pathname) && !fbid && !storyFbid) {
          return '';
        }
        return cleaned;
      } catch {
        return link.href;
      }
    }

    function isRelativeTimestamp(ts) {
      return /^\d+\s*(h|hr|m|min|s|d|w|yr|mo|小時|分鐘|秒|天|週)$|^just now$|^yesterday$|^today$|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|^about\s+(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.test(ts);
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
      // Check aria-labelledby — FB uses this for scrambled timestamps.
      // A child span carries aria-labelledby pointing to a hidden <span id="...">
      // that holds the plain-English label (e.g. "2 days ago", "about an hour ago",
      // or an absolute date for older posts). Return immediately if absolute; save
      // relative and keep looking so the CSS unscrambling can find the full date.
      let ariaLabelledByFallback = '';
      for (const el of link.querySelectorAll('[aria-labelledby]')) {
        const labelId = el.getAttribute('aria-labelledby');
        const labelEl = labelId && document.getElementById(labelId);
        if (labelEl) {
          const label = labelEl.textContent.trim();
          if (isTimestampText(label)) {
            if (!isRelativeTimestamp(label)) return label;
            if (!ariaLabelledByFallback) ariaLabelledByFallback = label;
          }
        }
      }
      // Check aria-label — Facebook stores the full absolute date here
      // (e.g. "March 8, 2025 at 2:30 PM") while visible text shows only the
      // short relative form ("1w", "2w") which is less informative.
      const ariaLabel = link.getAttribute('aria-label') || '';
      if (isTimestampText(ariaLabel)) return ariaLabel;
      // Check direct text
      const text = link.innerText.trim();
      if (isTimestampText(text)) return text;
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
      // CSS flex visual-position unscrambling for character-obfuscated links.
      // Facebook scrambles timestamp text by placing each character in its own
      // <span> inside a display:flex container. The visual order is set by CSS
      // class rules (which property varies: `order`, `margin-left`, `transform`,
      // etc.). Dummy/invisible characters are injected and hidden via display:none
      // or visibility:hidden.
      //
      // getBoundingClientRect().left gives the actual rendered left position —
      // works regardless of which CSS property Facebook uses for ordering. Falls
      // back to getComputedStyle().order when off-screen (rect.left = 0 for all).
      {
        const leafChars = [];
        for (const child of link.querySelectorAll('span')) {
          if (child.children.length > 0) continue; // leaf only
          const t = child.textContent;
          if (!t) continue; // skip null/empty; allow whitespace (may be date separator)
          const cs = window.getComputedStyle(child);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const order = parseInt(cs.order) || 0;
          const rect = child.getBoundingClientRect();
          const left = rect.left;
          const top = rect.top;
          leafChars.push({ text: t, order, left, top });
        }
        if (leafChars.length > 0) {
          // Sort by top row first, then left within each row, then CSS order as tiebreaker.
          // This handles all FB flex layouts:
          //   row-flex: same top, different lefts → left gives reading order
          //   column-flex: same left, different tops → top gives reading order
          //   hybrid: real chars at one top row + noise chars at another → top separates them
          leafChars.sort((a, b) => {
            const td = a.top - b.top;
            if (td !== 0) return td;
            const ld = a.left - b.left;
            return ld !== 0 ? ld : a.order - b.order;
          });
          const unscrambled = leafChars.map(c => c.text).join('').trim();
          if (unscrambled && isTimestampText(unscrambled)) return unscrambled;
          // The sorted string may have real date at the front with noise chars appended.
          // Try to extract a leading date substring.
          const tsPrefix = unscrambled.match(/^\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+at\s+\d{1,2}:\d{2})?/i)
            || unscrambled.match(/^(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?/i);
          if (tsPrefix) return tsPrefix[0];
        }
      }
      return ariaLabelledByFallback;
    }

    const links = container.querySelectorAll('a[href]');

    // Strategy 1: Permalink link with timestamp.
    // If the timestamp is only a short relative form ("2d", "4w", etc.), scan ALL
    // links for an absolute date — Facebook often puts the flex-obfuscated absolute
    // date on a non-permalink link (e.g. href="?__cft__...") that precedes the
    // plain-text relative link in the DOM.
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!isPermalinkHref(href)) continue;
      const ts = getTimestampFromLink(link);
      if (!ts) continue;
      const permalink = cleanPermalink(link);
      if (!isRelativeTimestamp(ts)) return { timestamp: ts, permalink };
      // Relative timestamp found — scan all links for a better absolute date.
      for (const l of links) {
        const lts = getTimestampFromLink(l);
        if (lts && !isRelativeTimestamp(lts)) return { timestamp: lts, permalink };
      }
      return { timestamp: ts, permalink };
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
      // Skip video thumbnails (t15.5256 CDN path) — these are captured by extractVideos instead
      if (src.includes('t15.5256')) continue;
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

    // 1. Check for <video> elements — capture poster URL for inline videos (MSE/blob playback
    //    means no downloadable src is available; poster is the only stable DOM reference)
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
      // Capture poster attribute (video thumbnail) — Facebook inline videos use MSE/blob so
      // there is no direct video URL in the DOM; the poster is the only stable reference.
      const poster = video.getAttribute('poster') || '';
      if (poster && !poster.startsWith('data:') && !seen.has(poster)) {
        seen.add(poster);
        urls.push(poster);
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
          // For /watch?v= URLs, preserve the v= parameter (it IS the video identifier)
          // Only strip tracking params (__cft__, __tn__, etc.)
          if (href.includes('/watch') && href.includes('v=')) {
            const v = url.searchParams.get('v');
            url.search = '';
            if (v) url.searchParams.set('v', v);
          } else {
            url.search = '';
          }
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
  let _lastScanTime = 0;
  function scanForPosts() {
    if (!isActive) return;
    // Throttle scans after 150+ posts to give Facebook's rendering pipeline
    // CPU time.  At 150+ posts the DOM has grown large and each scan is
    // noticeably heavier, even with textContent.  Before 150 posts scans are
    // fast enough that no throttle is needed.
    const nowScan = Date.now();
    // DOM-size-aware throttle: large DOM (from spam-heavy pages) → less frequent scans.
    // _lastDirAutoCount is updated at the end of each scan so the NEXT scan uses it.
    const minScanGap = _lastDirAutoCount > 10000 ? 8000 :
                       _lastDirAutoCount > 3000  ? 5000 :
                       _lastDirAutoCount > 1000  ? 3000 :
                       processedHashes.size > 150 ? 2000 : 0;
    if (nowScan - _lastScanTime < minScanGap) return;
    _lastScanTime = nowScan;

    // Find all dir="auto" elements with meaningful text content
    const allDirAuto = document.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    const seenContainers = new Set();

    let found = 0;
    let skipReasons = { short: 0, ui: 0, noContainer: 0, seen: 0, done: 0, checked: 0, nested: 0 };
    for (const el of allDirAuto) {
      // Fast-path: skip elements fully evaluated in any previous scan.
      // Avoids the expensive findPostContainer DOM walk for 10 000+ already-seen
      // elements every 1.2 s.  New DOM nodes added by Facebook's infinite scroll
      // are not in the WeakSet and will be processed normally.
      if (_scanSeenElements.has(el)) { skipReasons.seen++; continue; }

      // Use textContent (not innerText) for the filter check.
      // innerText triggers a synchronous layout reflow on every call.
      // With 10000+ elements this causes Facebook's UI to freeze and
      // eventually crash the tab.  textContent is a pure string read —
      // no layout, no reflow.  Per-post extraction still uses innerText.
      const text = el.textContent.trim();
      // Must have some real content (not just UI labels)
      if (text.length < 8) { _scanSeenElements.add(el); skipReasons.short++; continue; }
      // Skip known UI patterns
      if (/^(switch into|you're commenting|manage|boost this|write a comment)/i.test(text)) { _scanSeenElements.add(el); skipReasons.ui++; continue; }
      if (/^(like|comment|share|send|reply|follow|sponsored|facebook)$/i.test(text)) { _scanSeenElements.add(el); skipReasons.ui++; continue; }

      // Find the post container for this text element
      const container = findPostContainer(el);
      if (!container) { _scanSeenElements.add(el); skipReasons.noContainer++; continue; }

      // Skip if already processed this container in this scan
      if (seenContainers.has(container)) { skipReasons.seen++; continue; }
      seenContainers.add(container);

      // Skip if already scraped or already checked (rejected sidebar/non-post)
      if (container.dataset.fbScraperDone) { _scanSeenElements.add(el); skipReasons.done++; continue; }
      if (container.dataset.fbScraperChecked) { _scanSeenElements.add(el); skipReasons.checked++; continue; }

      // Skip if this container is inside an already-scraped post container
      // (prevents duplicate text-only captures from inner elements)
      // Only check fbScraperDone (confirmed posts), NOT fbScraperChecked (rejected sidebars)
      // IMPORTANT: ignore large containers (>= 8 children) as nesting boundaries —
      // these are page-level wrappers, not individual posts. If one was accidentally
      // marked as done, it must not block all sibling posts inside it.
      let ancestor = container.parentElement;
      let isNested = false;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.dataset.fbScraperDone && ancestor.children.length < 8) {
          isNested = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (isNested) {
        container.dataset.fbScraperDone = 'true';
        _scanSeenElements.add(el);
        skipReasons.nested++;
        continue;
      }

      found++;
      _scanSeenElements.add(el);
      processPost(container);
    }

    if (found > 0) {
      console.log(`[FB Scraper] Scan found ${found} new post containers | emptyScanStreak: ${_consecutiveEmptyScans}`);
    }
    // Only reset consecutive empty scan counter when genuinely new posts
    // were captured since the last scan. processPost runs asynchronously
    // (via setTimeout for clickSeeMore), so we compare against the count
    // at the START of this scan, reflecting captures from the previous scan.
    // This prevents scroll-back from re-engaging when the scraper keeps
    // finding re-rendered old posts in new DOM nodes (Facebook virtualization).
    const currentCaptures = processedHashes.size;
    if (currentCaptures > _lastCapturedCount) {
      _consecutiveEmptyScans = 0;
      _lastCapturedCount = currentCaptures;
    } else {
      _consecutiveEmptyScans++;
    }
    if (found === 0 && stallCount >= MAX_STALL - 2) {
      // Log skip reasons when approaching stall to diagnose why nothing is found
      console.log(`[FB Scraper] Scan found 0 new containers (stall: ${stallCount}/${MAX_STALL}) | emptyScanStreak: ${_consecutiveEmptyScans} | dirAuto: ${allDirAuto.length} | skips: short=${skipReasons.short} ui=${skipReasons.ui} noContainer=${skipReasons.noContainer} seen=${skipReasons.seen} done=${skipReasons.done} checked=${skipReasons.checked} nested=${skipReasons.nested}`);
    }

    // Second and third passes are edge-case recovery (orphan posts, photo-only posts).
    // On large DOM pages (spam-heavy feeds with 60k+ dir="auto" elements), each pass
    // calls textContent.trim() on every element with no WeakSet short-circuit,
    // blocking the main thread for hundreds of ms and starving Facebook's render pipeline.
    // Skip both passes when the DOM exceeds the threshold — first-pass + WeakSet handles
    // the overwhelming majority of posts and the performance gain outweighs the <1% miss rate.
    if (_lastDirAutoCount <= 5000) {

    // Second pass: look for dir="auto" elements with substantial text that
    // the main pipeline missed (findPostContainer returned null because all
    // ancestors were already marked).  These are posts nested inside another
    // post's container due to Facebook's DOM structure.
    for (const el of allDirAuto) {
      const text = el.textContent.trim();
      if (text.length < 100) continue;
      // Only process elements where findPostContainer would return null
      const container = findPostContainer(el);
      if (container) continue;  // main pipeline handles this
      // Check if this text is already captured
      let alreadyCaptured = false;
      for (const [, capturedLen] of processedPermalinks) {
        if (capturedLen >= text.length * 0.5) { alreadyCaptured = true; break; }
      }
      if (alreadyCaptured) continue;
      // Walk up to find the nearest ancestor with an uncaptured permalink
      let postParent = el;
      for (let k = 0; k < 20; k++) {
        postParent = postParent.parentElement;
        if (!postParent || postParent === document.body) { postParent = null; break; }
        const link = postParent.querySelector('a[href*="/posts/"], a[href*="/photo/"], a[href*="/videos/"]');
        if (link) break;
      }
      if (!postParent || seenContainers.has(postParent)) continue;
      // Use cheap href-only scan instead of full extractTimestamp for dedup check.
      const permalink = quickPermalink(postParent);
      if (!permalink || processedPermalinks.has(permalink)) continue;
      // This is a genuinely missed post — process it
      seenContainers.add(postParent);
      console.log('[FB Scraper] Processing orphan post:', text.substring(0, 50));
      processPost(postParent);
    }

    // Third pass: detect photo-only posts that have no substantial text.
    // These posts are invisible to the main scan because all their dir="auto"
    // elements contain only "Facebook" anti-scraping padding (< 8 chars or
    // filtered), and the author name uses dir="ltr" not dir="auto".
    //
    // DOM fingerprint (see DOM-NOTES.md):
    //   - Post container has 20+ direct children
    //   - ~20 aria-hidden divs with <blockquote><span dir="auto">Facebook</span>
    //   - <h2> heading with author name (dir="ltr")
    //   - Permalink: a[href*="/posts/"] or a[href*="/photo/"]
    //   - Profile pic is SVG <image>, NOT <img> — don't use img selector
    //
    // Strategy: find "Facebook" dir="auto" elements, walk up to the first
    // large ancestor (children >= 10), verify it has a heading AND permalink.
    for (const el of allDirAuto) {
      const text = el.textContent.trim();
      if (text.toLowerCase() !== 'facebook') continue;

      // Walk up to find the first large container (children >= 10)
      let container = null;
      let walker = el;
      for (let i = 0; i < 10; i++) {
        walker = walker.parentElement;
        if (!walker || walker === document.body) break;
        if (walker.children.length >= 10) {
          container = walker;
          break;
        }
      }
      if (!container) continue;
      if (seenContainers.has(container)) continue;
      if (container.dataset.fbScraperDone) continue;
      if (container.dataset.fbScraperChecked) continue;

      // Skip if the main scan already captured a post INSIDE this container.
      // The "Facebook" padding exists in ALL posts, not just photo-only ones.
      // For regular text posts, the main scan uses a smaller inner container
      // (via findPostContainer's lastCandidate). We can't rely on DOM markers
      // here because processPost sets them asynchronously (inside setTimeout).
      // Instead, check if any container already in seenContainers (populated
      // synchronously by the main scan) is a descendant of this container.
      let alreadyCaptured = false;
      for (const seen of seenContainers) {
        if (container.contains(seen)) { alreadyCaptured = true; break; }
      }
      if (alreadyCaptured) continue;

      // Must have an author heading (h2/h3/h4) AND a post permalink
      if (!container.querySelector('h2, h3, h4')) continue;
      if (!container.querySelector('a[href*="/posts/"], a[href*="/photo/"], a[href*="/videos/"]')) continue;

      // Must not be a sidebar/nav container
      if (isNonPostContainer(container)) continue;

      // Check nesting — same logic as main scan
      let ancestor = container.parentElement;
      let isNested = false;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.dataset.fbScraperDone && ancestor.children.length < 8) {
          isNested = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (isNested) continue;

      seenContainers.add(container);
      console.log('[FB Scraper] Third pass: processing photo-only post candidate');
      processPost(container);
    }

    } // end: if (_lastDirAutoCount <= 5000) — skip recovery passes on large DOM

    // Cache element count for next scan's throttle/debounce calculation
    _lastDirAutoCount = allDirAuto.length;
  }

  // Cheap permalink extraction — reads only href attributes, no innerText/layout reflows.
  // Returns the raw href of the first permalink-shaped link found in the container.
  function quickPermalink(container) {
    const PATTERNS = ['/posts/', '/permalink/', 'story_fbid', '/photos/', '/photo/', '/videos/', '/reel/', 'pfbid'];
    const links = container.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (PATTERNS.some(p => href.includes(p))) return href;
    }
    return '';
  }

  // Re-find a post container when the original has been detached by Facebook's
  // virtualization. Searches the live DOM for an anchor matching the permalink path,
  // then walks up to the enclosing post container.
  function findContainerByPermalink(hrefOrUrl) {
    if (!hrefOrUrl) return null;
    let pathPart;
    try {
      // Handle both full URLs and relative paths ("/posts/123")
      pathPart = new URL(hrefOrUrl, 'https://www.facebook.com').pathname;
      if (!pathPart || pathPart === '/') return null;
      const allLinks = document.querySelectorAll('a[href]');
      for (const link of allLinks) {
        if (!(link.getAttribute('href') || '').includes(pathPart)) continue;
        let walker = link;
        for (let i = 0; i < 15; i++) {
          walker = walker.parentElement;
          if (!walker || walker === document.body) { walker = null; break; }
          if (walker.children.length >= 10 &&
              walker.querySelector('div[dir="auto"], span[dir="auto"]') &&
              !isNonPostContainer(walker)) {
            return walker;
          }
        }
      }
    } catch {}
    return null;
  }

  // Format a unix timestamp as "D Month YYYY at HH:MM" (local time).
  function formatCreationTime(unixTs) {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const d = new Date(unixTs * 1000);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' at ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Look up the full datetime for a date-only timestamp string (e.g. "16 February").
  // Consumes the matching entry so each lookup returns a distinct post time.
  function lookupCreationTime(dateOnlyStr) {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const m = dateOnlyStr.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i);
    if (!m) return '';
    const day = parseInt(m[1], 10);
    const monthName = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    const key = day + ' ' + monthName;
    const bucket = _creationTimesByDate.get(key);
    if (!bucket || bucket.length === 0) return '';
    // Consume the newest-first entry (feeds are newest-first as we scroll down)
    const ts = bucket.shift();
    if (bucket.length === 0) _creationTimesByDate.delete(key);
    return formatCreationTime(ts);
  }

  function processPost(container) {
    if (!isActive) return;

    // Pre-capture permalink href before any DOM mutation.
    // Used both to skip redundant See More clicks and to re-find detached containers.
    const prePermalink = quickPermalink(container);

    // Skip See More if this post was already captured with substantial text.
    // Facebook re-renders virtualized posts in fresh DOM nodes — these will
    // pass the WeakSet/fbScraperDone check (new node) but already have good text.
    // Skipping the click saves DOM mutations and avoids CPU spikes on spam pages.
    const prevCapturedLen = prePermalink ? (processedPermalinks.get(prePermalink) || 0) : 0;
    const clicked = prevCapturedLen >= 100 ? false : clickSeeMore(container);
    const delay = clicked ? 200 : 0;

    setTimeout(() => {
      // Guard: if scraping was stopped during the delay, abort
      if (!isActive) return;

      // Guard: if the container was detached from the DOM, try to re-find it by
      // permalink. Facebook virtualizes the feed and may replace a DOM node
      // during or after a "See more" click (re-rendering causes detachment).
      let activeContainer = container;
      if (!document.contains(container)) {
        if (prePermalink) {
          const refound = findContainerByPermalink(prePermalink);
          if (refound) {
            console.log('[FB Scraper] Re-found detached container via permalink:', prePermalink);
            activeContainer = refound;
            clickSeeMore(activeContainer);
          } else {
            console.log('[FB Scraper] Skipped detached container (permalink not found in DOM)');
            return;
          }
        } else {
          console.log('[FB Scraper] Skipped detached container (DOM node removed, no permalink)');
          return;
        }
      }

      // Click again in case expansion revealed more
      if (clicked) clickSeeMore(activeContainer);

      let postText = extractPostText(activeContainer);
      const author = extractAuthor(activeContainer);

      // Safeguard: trim extremely long posts to prevent performance issues
      const MAX_POST_LENGTH = 10000;
      if (postText && postText.length > MAX_POST_LENGTH) {
        console.warn('[FB Scraper] Post text extremely long (' + postText.length + ' chars), trimming to ' + MAX_POST_LENGTH);
        postText = '[attention: post text too long, content is trimmed] ' + postText.substring(0, MAX_POST_LENGTH);
      }

      // Immediate innerText fallback: try while the container is still in/near the
      // viewport — before Facebook virtualizes the DOM node off-screen (which strips
      // body content from containers that have scrolled far up the page, making
      // later retries see only the title). This handles posts where dir="auto"
      // elements only hold a short title but the full body is in container.innerText.
      if (postText.length >= 3 && postText.length < 50) {
        const immediateText = extractPostTextFallback(activeContainer, author, postText);
        if (immediateText.length > postText.length) {
          console.log('[FB Scraper] Immediate fallback: ' + postText.length + ' -> ' + immediateText.length + ' | "' + author.substring(0, 25) + '"');
          postText = immediateText;
        }
      }

      if (!postText && !author) {
        console.log('[FB Scraper] Skipped empty container');
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }

      // Skip non-post content (notifications panel, nav elements, etc.)
      if (/^(your push notifications|turn on notifications|not now|new see all|notifications\n)/i.test(postText)) {
        console.log('[FB Scraper] Skipped notifications panel');
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }
      if (/notifications?\s*(are\s+)?off/i.test(author)) {
        console.log('[FB Scraper] Skipped notification header:', author);
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }
      if ((postText.match(/\bUnread/gi) || []).length >= 3) {
        console.log('[FB Scraper] Skipped notification list (multiple Unread entries)');
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }
      if (/^(details|contact info|photos|intro|about|friends|videos|reels|check-ins|music|posts)$/i.test(author)) {
        console.log('[FB Scraper] Skipped sidebar section:', author);
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }
      if (/\d+[kK]?\s*likes?\s*[•·]\s*\d+[kK]?\s*followers?/i.test(postText)) {
        console.log('[FB Scraper] Skipped sidebar (likes/followers pattern)');
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }
      const lines = postText.split('\n').map(l => l.trim()).filter(l => l);
      const uniqueLines = new Set(lines);
      if (uniqueLines.size <= 2 && lines.length > 3) {
        console.log('[FB Scraper] Skipped repetitive content');
        activeContainer.dataset.fbScraperChecked = 'true';
        return;
      }

      // Mark container as done so it's not re-processed.
      if (activeContainer.children.length >= 8) {
        activeContainer.dataset.fbScraperChecked = 'true';
      } else {
        activeContainer.dataset.fbScraperDone = 'true';
      }

      const { timestamp: rawTimestamp, permalink } = extractTimestamp(activeContainer);
      // If only a date was captured (no time), look up the full datetime from
      // creation_time unix timestamps intercepted from Facebook's GraphQL responses.
      let timestamp = rawTimestamp;
      if (rawTimestamp && !/\bat\b/i.test(rawTimestamp) &&
          /\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/i.test(rawTimestamp)) {
        const full = lookupCreationTime(rawTimestamp);
        if (full) timestamp = full;
      }

      // Reject non-post content (notifications, footer, comment counts)
      const trimmedText = postText.trim();
      if (/^Unread/i.test(trimmedText)) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/^\d+\s*comments?$/i.test(trimmedText)) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/^(· Privacy|Privacy\s+·\s+Terms)/i.test(trimmedText)) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/^\d+% recommend\b/i.test(trimmedText)) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/^Details\b/i.test(trimmedText) && /\b(recommend|contact info|privacy|terms)\b/i.test(trimmedText)) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/\b(added to (?:his|her|their) story)\b/i.test(trimmedText) && trimmedText.length < 100) { activeContainer.dataset.fbScraperChecked = 'true'; return; }
      if (/\b(sent messages? to)\b/i.test(trimmedText) && trimmedText.length < 100) { activeContainer.dataset.fbScraperChecked = 'true'; return; }

      // Deduplicate by permalink — allow longer text to replace shorter
      let isReplacement = false;
      let replaceMatchPrefix = '';
      if (permalink && processedPermalinks.has(permalink)) {
        const prevLen = processedPermalinks.get(permalink);
        if (postText.length <= prevLen) {
          console.log('[FB Scraper] Skipped permalink dup:', permalink, '| text:', postText.substring(0, 40) + '...', '| len:', postText.length, '<=', prevLen);
          // For short stored text, try innerText-based fallback before giving up.
          // Photo post captions and some other posts don't put the full text in
          // dir="auto" elements, so extractPostText misses the body.
          if (prevLen >= 3 && prevLen < 50) {
            const fallbackText = extractPostTextFallback(activeContainer, author, postText);
            if (fallbackText.length > prevLen) {
              console.log('[FB Scraper] DupSkip rescued via innerText: ' + prevLen + ' -> ' + fallbackText.length + ' chars | "' + author.substring(0, 25) + '"');
              processedPermalinks.set(permalink, fallbackText.length);
              const rescuedPost = {
                author,
                postText: fallbackText,
                timestamp,
                permalink,
                reactions: extractReactions(activeContainer),
                comments: extractComments(activeContainer),
                images: extractImages(activeContainer),
                videos: extractVideos(activeContainer),
                scrapedAt: new Date().toISOString(),
              };
              chrome.runtime.sendMessage({ type: 'REPLACE_POST', post: rescuedPost }).catch(() => {});
            }
          }
          activeContainer.dataset.fbScraperDone = 'true';
          return;
        }
        console.log('[FB Scraper] Replacing truncated capture (permalink) for', permalink,
          '(', prevLen, '->', postText.length, 'chars)');
        isReplacement = true;
      }

      // Deduplicate by text prefix — catches truncated "See more" captures
      // (e.g. "【Title】m.me" vs full expanded text starting with "【Title】...")
      const PREFIX_LEN = 40;
      const prefixKey = hashString(author + postText.substring(0, PREFIX_LEN));
      const existingPrefix = processedPrefixes.get(prefixKey);
      if (existingPrefix && !isReplacement) {
        if (postText.length <= existingPrefix.textLength) {
          console.log('[FB Scraper] Skipped prefix dup:', author, '|', postText.substring(0, 40) + '...', '| len:', postText.length, '<=', existingPrefix.textLength);
          if (existingPrefix.textLength >= 3 && existingPrefix.textLength < 50) {
            const fallbackText = extractPostTextFallback(activeContainer, author, postText);
            if (fallbackText.length > existingPrefix.textLength) {
              console.log('[FB Scraper] PrefixDup rescued via innerText: ' + existingPrefix.textLength + ' -> ' + fallbackText.length + ' | "' + author.substring(0, 25) + '"');
              processedHashes.delete(existingPrefix.hash);
              const newHash = hashString(author + fallbackText);
              processedHashes.add(newHash);
              processedPrefixes.set(prefixKey, { textLength: fallbackText.length, hash: newHash });
              if (permalink) processedPermalinks.set(permalink, fallbackText.length);
              const rescuedPost = {
                author, postText: fallbackText, timestamp, permalink,
                reactions: extractReactions(activeContainer),
                comments: extractComments(activeContainer),
                images: extractImages(activeContainer),
                videos: extractVideos(activeContainer),
                scrapedAt: new Date().toISOString(),
              };
              const rescueMsg = { type: 'REPLACE_POST', post: rescuedPost };
              rescueMsg.matchPrefix = postText.substring(0, PREFIX_LEN);
              rescueMsg.matchAuthor = author;
              chrome.runtime.sendMessage(rescueMsg).catch(() => {});
            }
          }
          activeContainer.dataset.fbScraperDone = 'true';
          return;
        }
        // New text is longer — replace the truncated capture
        console.log('[FB Scraper] Replacing truncated capture (prefix) for', author,
          '|', postText.substring(0, 40) + '...', '(', existingPrefix.textLength, '->', postText.length, 'chars)');
        // Remove the old hash so the new one passes the hash check
        processedHashes.delete(existingPrefix.hash);
        isReplacement = true;
        replaceMatchPrefix = postText.substring(0, PREFIX_LEN);
      }

      const key = hashString(author + postText);
      if (processedHashes.has(key)) {
        console.log('[FB Scraper] Skipped hash dup:', author, '|', postText.substring(0, 40) + '...', '| permalink:', permalink || 'none');
        activeContainer.dataset.fbScraperDone = 'true';
        return;
      }
      // For short captures (<200 chars) where a permalink is known, skip the hash
      // and prefix registrations. Different posts in a series can share the same
      // truncated title (e.g. 【水晶晶 之延伸閱讀篇】), causing hash/prefix collisions
      // that silently drop the second post. Permalink dedup is sufficient to detect
      // true same-post duplicates; hash/prefix are only needed when there's no permalink.
      const isShortWithPermalink = postText.length < 200 && !!permalink;
      if (!isShortWithPermalink) {
        processedHashes.add(key);
        processedPrefixes.set(prefixKey, { textLength: postText.length, hash: key });
      }
      if (permalink) processedPermalinks.set(permalink, postText.length);

      const reactions = extractReactions(activeContainer);
      const comments = extractComments(activeContainer);
      const images = extractImages(activeContainer);
      const videos = extractVideos(activeContainer);

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

      const msg = { type: isReplacement ? 'REPLACE_POST' : 'NEW_POST', post };
      if (isReplacement && replaceMatchPrefix) {
        msg.matchPrefix = replaceMatchPrefix;
        msg.matchAuthor = author;
      }
      chrome.runtime.sendMessage(msg, () => {
        // Post is now confirmed stored in background — safe to send UPDATE_VIDEO
        // without racing against the NEW_POST write.
        if (videos.length > 0) {
          const PREFIX_LEN = 40;
          registerVideoIds(videos, permalink, postText.substring(0, PREFIX_LEN), author);
        }
      });
      console.log('[FB Scraper] Captured:', author, '|', postText.substring(0, 40) + '...');
      // If the timestamp is still date-only (creation_time not yet received), register
      // the post for a retry update when the GraphQL response arrives.
      if (timestamp === rawTimestamp && rawTimestamp && !/\bat\b/i.test(rawTimestamp) &&
          /\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/i.test(rawTimestamp) &&
          permalink) {
        _pendingTimestampPosts.set(permalink, rawTimestamp);
      }

      // If See More was clicked, retry after 2000ms to catch expansions that
      // need more time (e.g. Facebook XHR-fetches the full text on busy networks).
      // Jitter (0–400ms) spreads concurrent retries across time to prevent
      // layout-reflow bursts that freeze the UI when many posts are processed.
      if (clicked && !isReplacement) {
        const retryPrefixKey = prefixKey;
        const jitter = Math.floor(Math.random() * 150);
        setTimeout(() => {
          // Re-find the container if detached (Facebook re-rendering)
          let retryContainer = activeContainer;
          const attached = document.contains(retryContainer);
          if (!attached) {
            const retryPermalink = permalink || prePermalink;
            if (retryPermalink) {
              const refound = findContainerByPermalink(retryPermalink);
              if (refound) {
                retryContainer = refound;
              } else {
                console.log('[FB Scraper] RetryA: DETACHED+LOST | no refound in DOM | initial=' + postText.length + ' | "' + author.substring(0, 25) + '"');
                return;
              }
            } else {
              console.log('[FB Scraper] RetryA: DETACHED+NOPERMALINK | initial=' + postText.length + ' | "' + author.substring(0, 25) + '"');
              return;
            }
          }

          // Read current text WITHOUT clicking first. If expansion already completed
          // during the wait, send replacement immediately with no DOM mutation.
          let retryText = extractPostText(retryContainer);
          if (retryText.length > MAX_POST_LENGTH) {
            retryText = '[attention: post text too long, content is trimmed] ' + retryText.substring(0, MAX_POST_LENGTH);
          }
          console.log('[FB Scraper] RetryA: attached=' + attached + ' | initial=' + postText.length + ' | now=' + retryText.length + ' | "' + author.substring(0, 25) + '"');
          if (retryText.length > postText.length) {
            const retryPost = { ...post, postText: retryText, scrapedAt: new Date().toISOString() };
            if (permalink) processedPermalinks.set(permalink, retryText.length);
            const retryHash = hashString(author + retryText);
            processedHashes.add(retryHash);
            processedPrefixes.set(retryPrefixKey, { textLength: retryText.length, hash: retryHash });
            const retryMsg = { type: 'REPLACE_POST', post: retryPost };
            if (!permalink) {
              retryMsg.matchPrefix = postText.substring(0, PREFIX_LEN);
              retryMsg.matchAuthor = author;
            }
            chrome.runtime.sendMessage(retryMsg);
            return;
          }

          // Text unchanged via dir="auto" — try innerText fallback first.
          // Catches posts whose caption is not in dir="auto" after expansion.
          // Guard: postText.length >= 3 excludes photo-only posts (empty text).
          // Also check the currently stored length: DupSkip may have already rescued
          // this post with a longer result, so only fire if we can beat what's stored.
          const storedLen = (permalink && processedPermalinks.get(permalink)) || postText.length;
          if (postText.length >= 3 && postText.length < 50) {
            const fallbackText = extractPostTextFallback(retryContainer, author, postText);
            if (fallbackText.length > postText.length && fallbackText.length > storedLen) {
              console.log('[FB Scraper] RetryA fallback rescued: ' + postText.length + ' -> ' + fallbackText.length + ' | "' + author.substring(0, 25) + '"');
              const retryPost = { ...post, postText: fallbackText, scrapedAt: new Date().toISOString() };
              if (permalink) processedPermalinks.set(permalink, fallbackText.length);
              const retryHash = hashString(author + fallbackText);
              processedHashes.add(retryHash);
              processedPrefixes.set(retryPrefixKey, { textLength: fallbackText.length, hash: retryHash });
              const retryMsg = { type: 'REPLACE_POST', post: retryPost };
              if (!permalink) { retryMsg.matchPrefix = postText.substring(0, PREFIX_LEN); retryMsg.matchAuthor = author; }
              chrome.runtime.sendMessage(retryMsg);
              return;
            }
          }

          // Text still unchanged — try clicking See More again (succeeds if this is a
          // refound fresh container that hasn't been clicked yet).
          const retryClicked = clickSeeMore(retryContainer);
          console.log('[FB Scraper] RetryA: button=' + retryClicked + ' | waiting for expansion | "' + author.substring(0, 25) + '"');

          // Wait for expansion: longer if no button (XHR may still be completing).
          const secondWait = retryClicked ? 1200 : 1500;
          setTimeout(() => {
            // Refind if detached during second wait
            let retryContainer2 = retryContainer;
            if (!document.contains(retryContainer2)) {
              const retryPermalink2 = permalink || prePermalink;
              if (retryPermalink2) {
                const refound2 = findContainerByPermalink(retryPermalink2);
                if (refound2) retryContainer2 = refound2;
                else {
                  console.log('[FB Scraper] RetryB: DETACHED+LOST | initial=' + postText.length + ' | "' + author.substring(0, 25) + '"');
                  return;
                }
              } else {
                console.log('[FB Scraper] RetryB: DETACHED+NOPERMALINK | initial=' + postText.length + ' | "' + author.substring(0, 25) + '"');
                return;
              }
            }
            let retryText2 = extractPostText(retryContainer2);
            if (retryText2.length > MAX_POST_LENGTH) {
              retryText2 = '[attention: post text too long, content is trimmed] ' + retryText2.substring(0, MAX_POST_LENGTH);
            }
            console.log('[FB Scraper] RetryB: initial=' + postText.length + ' | final=' + retryText2.length + ' | ' + (retryText2.length > postText.length ? 'FIXED' : 'still-waiting') + ' | "' + author.substring(0, 25) + '"');
            if (retryText2.length > postText.length) {
              const retryPost = { ...post, postText: retryText2, scrapedAt: new Date().toISOString() };
              if (permalink) processedPermalinks.set(permalink, retryText2.length);
              const retryHash = hashString(author + retryText2);
              processedHashes.add(retryHash);
              processedPrefixes.set(retryPrefixKey, { textLength: retryText2.length, hash: retryHash });
              const retryMsg = { type: 'REPLACE_POST', post: retryPost };
              if (!permalink) {
                retryMsg.matchPrefix = postText.substring(0, PREFIX_LEN);
                retryMsg.matchAuthor = author;
              }
              chrome.runtime.sendMessage(retryMsg);
            } else {
              // Expansion still not complete — RetryA clicked a freshly re-rendered button
              // and the XHR is still in flight. Wait 3s more and read one final time.
              setTimeout(() => {
                let retryContainer3 = retryContainer2;
                if (!document.contains(retryContainer3)) {
                  const rp3 = permalink || prePermalink;
                  if (rp3) {
                    const r3 = findContainerByPermalink(rp3);
                    if (r3) retryContainer3 = r3; else return;
                  } else return;
                }
                let retryText3 = extractPostText(retryContainer3);
                if (retryText3.length > MAX_POST_LENGTH) {
                  retryText3 = '[attention: post text too long, content is trimmed] ' + retryText3.substring(0, MAX_POST_LENGTH);
                }
                console.log('[FB Scraper] RetryC: initial=' + postText.length + ' | final=' + retryText3.length + ' | ' + (retryText3.length > postText.length ? 'FIXED' : 'GAVE_UP') + ' | "' + author.substring(0, 25) + '"');
                if (retryText3.length <= postText.length) {
                  // Diagnostic: find all elements in container with substantial text to identify which element type holds expanded text
                  const allEls = retryContainer3.querySelectorAll('*');
                  const suspects = [];
                  for (const el of allEls) {
                    if (el.children.length > 0) continue; // leaf nodes only
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t.length > 40) {
                      suspects.push(el.tagName.toLowerCase() + '[dir=' + (el.getAttribute('dir') || 'none') + '] len=' + t.length + ' :: ' + t.substring(0, 80));
                    }
                  }
                  console.log('[FB Scraper] RetryC DOM suspects (' + suspects.length + '):\n' + suspects.slice(0, 10).join('\n'));
                }
                if (retryText3.length > postText.length) {
                  const retryPost = { ...post, postText: retryText3, scrapedAt: new Date().toISOString() };
                  if (permalink) processedPermalinks.set(permalink, retryText3.length);
                  const retryHash = hashString(author + retryText3);
                  processedHashes.add(retryHash);
                  processedPrefixes.set(retryPrefixKey, { textLength: retryText3.length, hash: retryHash });
                  const retryMsg = { type: 'REPLACE_POST', post: retryPost };
                  if (!permalink) {
                    retryMsg.matchPrefix = postText.substring(0, PREFIX_LEN);
                    retryMsg.matchAuthor = author;
                  }
                  chrome.runtime.sendMessage(retryMsg);
                }
              }, 3000);
            }
          }, secondWait);
        }, 2000 + jitter);
      }
    }, delay);
  }

  // Restore processedHashes from storage so resumed sessions skip already-scraped posts.
  // Also loads the compact archivedPermalinks index so archived posts are not re-scraped
  // even after their full data was removed from chrome.storage.local.
  function restoreStateFromStorage() {
    return new Promise((resolve) => {
      // Load both current posts and the archived permalink index in one call
      chrome.storage.local.get({ posts: [], archivedPermalinks: [] }, (result) => {
        const PREFIX_LEN = 40;

        // Archived posts: only permalink known; use sentinel length so they're
        // never replaced (any re-encountered capture will be shorter).
        for (const permalink of (result.archivedPermalinks || [])) {
          if (permalink) processedPermalinks.set(permalink, 99999);
        }

        // Current (non-archived) posts: full dedup state
        for (const post of (result.posts || [])) {
          const author = post.author || '';
          const text = post.postText || '';
          const key = hashString(author + text);
          processedHashes.add(key);
          if (post.permalink) {
            const len = text.length;
            const prev = processedPermalinks.get(post.permalink) || 0;
            if (len > prev) processedPermalinks.set(post.permalink, len);
          }
          const prefixKey = hashString(author + text.substring(0, PREFIX_LEN));
          const existing = processedPrefixes.get(prefixKey);
          if (!existing || text.length > existing.textLength) {
            processedPrefixes.set(prefixKey, { textLength: text.length, hash: key });
          }
        }

        console.log('[FB Scraper] Restored', processedHashes.size, 'hashes,',
          processedPermalinks.size, 'permalinks (incl.',
          (result.archivedPermalinks || []).length, 'archived),',
          processedPrefixes.size, 'prefixes');
        resolve();
      });
    });
  }

  // Scroll-back state (declared here so wake detection in startAutoScroll can reset it)
  let _prevScrollY = window.scrollY;
  let _scrollBackTarget = -1;
  let _consecutiveEmptyScans = 0; // tracks how many scans found 0 new captures
  let _lastCapturedCount = 0; // tracks processedHashes.size for empty scan detection
  const SCROLL_BACK_SUPPRESS_THRESHOLD = 4; // disable scroll-back after this many empty scans

  // Detect large scroll jumps from Facebook's virtualization.
  // When a forward jump > 800px is detected, immediately scan to catch
  // posts that may be briefly visible, then scroll back so the normal
  // scroll can re-traverse the skipped area.
  window.addEventListener('scroll', () => {
    if (!isActive) { _prevScrollY = window.scrollY; return; }
    const curY = window.scrollY;

    // Track the highest scroll position reached for resume-after-blank-out.
    // Persist to storage when it grows by >5000px to survive page reloads.
    if (curY > _scrollHighWaterMark) {
      _scrollHighWaterMark = curY;
      if (_scrollHighWaterMark - _lastPersistedWatermark > 5000) {
        _lastPersistedWatermark = _scrollHighWaterMark;
        chrome.storage.local.set({ scrollHighWaterMark: _scrollHighWaterMark });
      }
    }

    const delta = curY - _prevScrollY;
    if (delta > 800) {
      // Large forward jump — scan immediately
      scanForPosts();

      // Suppress scroll-back during fast-forward — we're intentionally jumping
      // through already-scraped content and don't need to re-traverse it.
      // Also suppress when recent scans are finding nothing new.
      if (!_fastForwardMode && _consecutiveEmptyScans < SCROLL_BACK_SUPPRESS_THRESHOLD) {
        console.log('[FB Scraper] Scroll jump +' + delta + ', scanning & scrolling back');
        _scrollBackTarget = _prevScrollY;
        requestAnimationFrame(() => {
          if (_scrollBackTarget >= 0) {
            window.scrollTo({ top: _scrollBackTarget, behavior: 'instant' });
            _scrollBackTarget = -1;
          }
        });
      } else {
        console.log('[FB Scraper] Scroll jump +' + delta + ', scanning (scroll-back suppressed, advancing to new area)');
      }
    }
    _prevScrollY = curY;
  }, { passive: true });

  function startAutoScroll() {
    if (autoScrollInterval) return;
    let expectedTickCount = 0;
    const scrollStartTime = Date.now();
    autoScrollInterval = setInterval(() => {
      expectedTickCount++;
      const now = Date.now();
      const wallElapsed = now - scrollStartTime;
      const expectedElapsed = expectedTickCount * SCROLL_INTERVAL;

      // Wake detection: if wall clock is far ahead of expected ticks,
      // the system slept and Chrome is firing accumulated ticks in a burst
      if (wallElapsed > expectedElapsed + SCROLL_INTERVAL * 4) {
        // Fast-forward the tick counter to match wall clock, absorbing the burst
        expectedTickCount = Math.ceil(wallElapsed / SCROLL_INTERVAL);
        console.log('[FB Scraper] Wake detected (wall drift: ' + Math.round((wallElapsed - expectedElapsed) / 1000) + 's), resetting counters | posts so far:', processedHashes.size, '| scrollY:', Math.round(window.scrollY));
        stallCount = 0;
        autoRetryCount = 0;
        _consecutiveEmptyScans = 0;
        _lastCapturedCount = processedHashes.size;
        lastPostCount = processedHashes.size;
        lastDocHeight = document.documentElement.scrollHeight;
        _prevScrollY = window.scrollY; // prevent false scroll-jump detection
        return; // skip this tick, let Facebook stabilize
      }

      // Fast-forward through already-scraped content at 4× speed.
      // Runs BEFORE stall detection — during fast-forward we expect no new posts
      // (all deduped) so stall counters must not fire.
      if (_fastForwardMode) {
        if (window.scrollY >= _resumeTargetWatermark - 2000) {
          _fastForwardMode = false;
          // Reset stall baseline so normal scraping starts with a clean slate
          stallCount = 0;
          lastPostCount = processedHashes.size;
          lastDocHeight = document.documentElement.scrollHeight;
          console.log('[FB Scraper] Fast-forward complete at scrollY:', Math.round(window.scrollY), '— switching to normal scan');
        } else {
          window.scrollBy({ top: 2000, behavior: 'instant' });
          return; // skip stall detection entirely during fast-forward
        }
      }

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
        if (stallCount === MAX_STALL - 2) {
          console.log(`[FB Scraper] Approaching stall (${stallCount}/${MAX_STALL}) | posts: ${currentCount} | scrollY: ${Math.round(window.scrollY)} | docHeight: ${currentDocHeight} | atBottom: ${window.innerHeight + window.scrollY >= currentDocHeight - 100}`);
        }
        if (stallCount >= MAX_STALL) {
          clearInterval(autoScrollInterval);
          autoScrollInterval = null;

          if (autoRetryCount < MAX_AUTO_RETRY) {
            autoRetryCount++;
            // Diagnostic: log state at stall to understand why scanner found nothing
            const markedDone = document.querySelectorAll('[data-fb-scraper-done]').length;
            const markedChecked = document.querySelectorAll('[data-fb-scraper-checked]').length;
            const allDirAutoCount = document.querySelectorAll('div[dir="auto"], span[dir="auto"]').length;
            console.log(`[FB Scraper] Stalled — auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} in ${AUTO_RETRY_DELAY / 1000}s... | posts: ${processedHashes.size} | scrollY: ${Math.round(window.scrollY)} | docHeight: ${currentDocHeight} | dirAuto: ${allDirAutoCount} | markedDone: ${markedDone} | markedChecked: ${markedChecked}`);
            setTimeout(() => {
              if (!isActive) return; // Don't retry if user paused/stopped
              stallCount = 0;
              lastDocHeight = document.documentElement.scrollHeight;
              startAutoScroll();
            }, AUTO_RETRY_DELAY);
          } else {
            console.log('[FB Scraper] No new posts after ' + MAX_AUTO_RETRY + ' retries, stopping auto-scroll | scrollY: ' + Math.round(window.scrollY) + ' | docHeight: ' + document.documentElement.scrollHeight);
            chrome.runtime.sendMessage({ type: 'AUTO_SCROLL_DONE' });
          }
          return;
        }
      }

      // Normal scroll speed — 500px per 1000ms tick.
      // scroll-back handles any FB jump > 800px.
      window.scrollBy({ top: 500, behavior: 'smooth' });
    }, SCROLL_INTERVAL);
  }

  async function startObserver() {
    if (observer) return;

    console.log('[FB Scraper] Starting...');

    // Restore state from storage to avoid re-scraping posts
    await restoreStateFromStorage();
    _lastCapturedCount = processedHashes.size;

    // Restore scroll watermark and jump to where we left off.
    // This lets the scraper resume after a blank-out or manual page reload
    // without re-scanning from the top.
    await new Promise((resolve) => {
      chrome.storage.local.get({ scrollHighWaterMark: 0 }, (r) => {
        const saved = r.scrollHighWaterMark || 0;
        if (saved > 1000) {
          _scrollHighWaterMark = saved;
          _lastPersistedWatermark = saved;
          _resumeTargetWatermark = saved;
          _fastForwardMode = true;
          console.log('[FB Scraper] Fast-forward mode: will scroll at 4× speed until watermark', saved, 'px');
        }
        resolve();
      });
    });

    // Resume downloads in background
    chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOADS' });

    // Initial scan
    scanForPosts();

    // MutationObserver for dynamically added content
    let mutationLastTime = Date.now();
    observer = new MutationObserver(() => {
      const now = Date.now();
      const gap = now - mutationLastTime;
      mutationLastTime = now;
      _lastMutationTime = now; // update for silence detector

      // Skip burst of mutations after wake — DOM is stale
      if (gap > 10000) {
        console.log('[FB Scraper] MutationObserver wake detected (gap: ' + Math.round(gap / 1000) + 's), skipping stale mutations');
        return;
      }

      // Debounce: don't scan on every tiny mutation.
      // Scale up with DOM element count (spam-heavy pages) and post count.
      const debounceMs = _lastDirAutoCount > 10000 ? 5000 :
                         _lastDirAutoCount > 3000  ? 3000 :
                         processedHashes.size > 300 ? 1500 :
                         processedHashes.size > 150 ? 800 : 300;
      clearTimeout(observer._debounce);
      observer._debounce = setTimeout(scanForPosts, debounceMs);
    });

    // Scope the observer to the feed container when available — observing just
    // the feed element instead of the full body dramatically reduces mutation
    // events from the sidebar, navbar, and notifications on large DOM pages.
    const feedRoot = document.querySelector('div[role="feed"]') || document.body;
    observer.observe(feedRoot, { childList: true, subtree: true });

    // DOM silence detector: if the feed stops mutating for 15s while still active
    // and not at the bottom, nudge the scroll to unblock Facebook's infinite scroll.
    _lastMutationTime = Date.now();
    _silenceInterval = setInterval(() => {
      if (!isActive) return;
      const silence = Date.now() - _lastMutationTime;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;
      if (silence > 15000 && !atBottom) {
        console.log('[FB Scraper] 15s DOM silence detected, nudging scroll to unblock feed...');
        window.scrollBy({ top: -300, behavior: 'smooth' });
        setTimeout(() => window.scrollBy({ top: 500, behavior: 'smooth' }), 600);
        _lastMutationTime = Date.now(); // prevent rapid re-nudging
      }
    }, 5000);

    // Periodic fallback scanner (with wake detection)
    let scanLastTickTime = Date.now();
    scrollInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - scanLastTickTime;
      scanLastTickTime = now;

      if (elapsed > SCAN_INTERVAL * 5) {
        console.log('[FB Scraper] Scanner wake detected (gap: ' + Math.round(elapsed / 1000) + 's), skipping stale tick');
        return; // skip this tick — DOM is likely stale
      }
      scanForPosts();
    }, SCAN_INTERVAL);

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
    if (_silenceInterval) {
      clearInterval(_silenceInterval);
      _silenceInterval = null;
    }
    stallCount = 0;
    autoRetryCount = 0;
    // Pause downloads when scraping is paused
    chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOADS' });
    console.log('[FB Scraper] Stopped (isActive:', isActive, ')');
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
