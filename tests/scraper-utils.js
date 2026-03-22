/**
 * Extracted scraping utility functions for unit testing.
 *
 * KEEP IN SYNC with content.js. When fixing a bug:
 *   1. Fix it here first and confirm tests pass
 *   2. Apply the identical change to content.js
 *
 * makeExtractTimestamp(document, getComputedStyle)
 *   document          — the DOM document (jsdom or real browser)
 *   getComputedStyle  — window.getComputedStyle (real browser) or
 *                       jsdom's window.getComputedStyle (tests).
 *                       Tests must use inline style="order:N" on char spans
 *                       because jsdom doesn't compute CSS class rules.
 */

'use strict';

function makeExtractTimestamp(document, getComputedStyle) {
  const TIME_PATTERN = /^(\d+\s*(h|hr|m|min|s|d|w|yr|mo|小時|分鐘|秒|天|週)$|just now|yesterday|today|\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)|[a-z]+ \d{1,2}(,?\s*\d{4})?(\s+at\s+\d|$))/i;
  const CHINESE_DATE = /^\d{1,2}月\d{1,2}日|^\d{4}年\d{1,2}月/;
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
      const fbid = url.searchParams.get('fbid');
      const storyFbid = url.searchParams.get('story_fbid');
      const videoId = url.searchParams.get('v');
      url.search = '';
      if (fbid) url.searchParams.set('fbid', fbid);
      if (storyFbid) url.searchParams.set('story_fbid', storyFbid);
      if (videoId) url.searchParams.set('v', videoId);
      const cleaned = url.toString();
      if (/\/(photo|photos|videos)\/?$/.test(url.pathname) && !fbid && !storyFbid) {
        return '';
      }
      return cleaned;
    } catch {
      return link.href;
    }
  }

  // Returns true for short relative timestamps like "2d", "4w", "13h", "just now".
  // Absolute dates ("March 14, 2025 at 10:30 PM", "3月21日") return false.
  function isRelativeTimestamp(ts) {
    return /^\d+\s*(h|hr|m|min|s|d|w|yr|mo|小時|分鐘|秒|天|週)$|^just now$|^yesterday$|^today$/i.test(ts);
  }

  function isTimestampText(text) {
    if (!text || text.length > 30) return false;
    if (text.startsWith('http') || text.startsWith('May be')) return false;
    if (/shares?|comments?|likes?|reactions?/i.test(text)) return false;
    if (CHINESE_DATE.test(text)) return true;
    if (/[\u4e00-\u9fff]{4,}/.test(text) && !/[小時分鐘秒天週月年日]/.test(text)) return false;
    return TIME_PATTERN.test(text);
  }

  function getTimestampFromLink(link) {
    // Check aria-label FIRST — Facebook stores the full absolute date here
    // (e.g. "March 8, 2025 at 2:30 PM") while visible text shows only the
    // short relative form ("1w", "2w") which is less informative.
    const ariaLabel = link.getAttribute('aria-label') || '';
    if (isTimestampText(ariaLabel)) return ariaLabel;
    // Check direct text
    const text = (link.innerText || link.textContent || '').trim();
    if (isTimestampText(text)) return text;
    // Check nested spans
    for (const span of link.querySelectorAll('span, b')) {
      const spanText = (span.innerText || span.textContent || '').trim();
      if (isTimestampText(spanText)) return spanText;
      const spanTitle = span.getAttribute('title') || '';
      if (isTimestampText(spanTitle)) return spanTitle;
    }
    // Check title attribute on the link
    const title = link.getAttribute('title') || '';
    if (isTimestampText(title)) return title;
    // Check aria-label on child elements
    for (const el of link.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (isTimestampText(label)) return label;
    }
    // Check sibling text nodes (SVG clock icon pattern)
    const parent = link.parentElement;
    if (parent) {
      for (const child of parent.childNodes) {
        if (child.nodeType === 3) {
          const t = child.textContent.trim();
          if (isTimestampText(t)) return t;
        }
      }
    }
    // CSS flex visual-position unscrambling for character-obfuscated links.
    //
    // Facebook scrambles timestamp text by placing each character in its own
    // <span> inside a display:flex container. The visual order is set by CSS
    // class rules (which property varies: `order`, `margin-left`, `transform`,
    // etc.). Dummy/invisible characters are injected and hidden via display:none
    // or visibility:hidden.
    //
    // getBoundingClientRect().left gives the actual rendered left position —
    // works regardless of which CSS property Facebook uses for ordering. Falls
    // back to getComputedStyle().order when off-screen (all rect.left = 0,
    // as in jsdom). In tests, use inline style="order:N" on real chars and
    // style="display:none" on dummy chars — jsdom handles both correctly.
    if (getComputedStyle) {
      const leafChars = [];
      for (const child of link.querySelectorAll('span')) {
        if (child.children.length > 0) continue; // leaf only
        const t = child.textContent;
        if (!t) continue; // skip null/empty; allow whitespace (may be date separator)
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const order = parseInt(cs.order) || 0;
        const left = child.getBoundingClientRect ? child.getBoundingClientRect().left : 0;
        leafChars.push({ text: t, order, left });
      }
      if (leafChars.length > 0) {
        leafChars.sort((a, b) => {
          const ld = a.left - b.left;
          return ld !== 0 ? ld : a.order - b.order;
        });
        const unscrambled = leafChars.map(c => c.text).join('').trim();
        if (unscrambled && isTimestampText(unscrambled)) return unscrambled;
      }
    }
    return '';
  }

  return function extractTimestamp(container) {
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
      for (const anyLink of links) {
        const absTs = getTimestampFromLink(anyLink);
        if (absTs && !isRelativeTimestamp(absTs)) {
          return { timestamp: absTs, permalink };
        }
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
        const text = (link.innerText || link.textContent || '').trim() || ariaLabel;
        const permalink = cleanPermalink(link);
        return { timestamp: text.length < 30 ? text : ariaLabel, permalink };
      }
    }

    // Strategy 4: Search all spans for timestamp-like text
    const spans = container.querySelectorAll('span');
    for (const span of spans) {
      const text = (span.innerText || span.textContent || '').trim();
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

    // Strategy 5: permalink with no timestamp text
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (isPermalinkHref(href)) {
        return { timestamp: '', permalink: cleanPermalink(link) };
      }
    }

    const abbr = container.querySelector('abbr');
    if (abbr) {
      return { timestamp: (abbr.innerText || abbr.textContent || '').trim(), permalink: '' };
    }
    return { timestamp: '', permalink: '' };
  };
}

// ─── Author extraction ────────────────────────────────────────────────────────

function makeExtractAuthor() {
  return function extractAuthor(container) {
    const headings = container.querySelectorAll('h2, h3, h4');
    for (const h of headings) {
      const text = (h.innerText || h.textContent || '').trim();
      if (text && text.length > 1 && text.length < 100) return text;
    }
    const strongLinks = container.querySelectorAll('strong a, strong');
    for (const el of strongLinks) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text && text.length > 1 && text.length < 100) return text;
    }
    return '';
  };
}

// ─── Post text extraction ─────────────────────────────────────────────────────
//
// loggedInUser: optional name to strip (protects privacy in exports).
// In tests, pass '' to disable stripping and keep assertions simple.

function makeExtractPostText({ loggedInUser = '' } = {}) {
  function stripLoggedInUser(text) {
    if (!loggedInUser) return text;
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = text.replace(new RegExp(escape(loggedInUser), 'gi'), '');
    const parts = loggedInUser.split(/\s+/).filter(p => p.length >= 2);
    for (const part of parts) {
      result = result.replace(new RegExp(`^${escape(part)}$`, 'gmi'), '');
    }
    result = result.replace(/^ +$/gm, '');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/  +/g, ' ');
    return result.trim();
  }

  return function extractPostText(container) {
    const dirAutoEls = container.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    const texts = [];

    for (const el of dirAutoEls) {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length < 2) continue;

      const lower = text.toLowerCase();
      if (/^(like|comment|share|send|reply|see more|hide|follow|suggested for you|sponsored|facebook|·|…)$/i.test(lower)) continue;
      if (/^(boost|insights|promote|advertise)/i.test(lower)) continue;
      if (/^(switch into|you're commenting|manage|write a comment)/i.test(lower)) continue;
      if (/^boost this post/i.test(lower)) continue;
      if (/^(send message|message|like page|follow page|get directions|call now|shop now|book now|sign up|learn more|watch more|contact us)$/i.test(lower)) continue;
      if (/^(personal blog|public figure|politician|musician|actor|director|artist|writer|journalist|news|media|business|brand|community|organisation|nonprofit)$/i.test(lower)) continue;

      texts.push(text);
    }

    const unique = texts.filter((t, i) => {
      if (texts.indexOf(t) !== i) return false;
      return !texts.some((other, j) => j !== i && other.length > t.length && other.includes(t));
    });

    let postText = unique.join('\n');

    postText = postText.replace(/…?\s*see more\s*/gi, '').trim();
    postText = postText.replace(/…?\s*See more…?\s*/g, '').trim();
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
    postText = postText.replace(/\s+[a-zA-Z0-9]{2,15}\.(com|net|org|me|io|co)\s+/g, '\n').trim();
    postText = postText.replace(/^m\.me(\/\S*)?\s*$/gm, '').trim();
    postText = postText.replace(/\s*m\.me(\/\S*)?\s*$/gm, '').trim();
    postText = postText.replace(/\s+m\.me(\/\S*)?\s+/g, '\n').trim();
    postText = postText.replace(/\s+(personal blog|public figure|politician|musician|actor|writer|journalist|news|media|business|community|nonprofit)\s+(send message|message|follow|like page)\s*$/gi, '').trim();
    postText = postText.replace(/\n.*?(personal blog|public figure|politician|musician|actor|writer|journalist|news|media|business|community|nonprofit).*?(send message|message).*$/gi, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(comments?|則留言|條留言)\n[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)\n[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n\d+[kK]?\s*(shares?|次分享)$/i, '').trim();
    postText = postText.replace(/\nView more comments[\s\S]*$/i, '').trim();
    postText = postText.replace(/\n(Photos from .+'s post)(\n.*)*$/i, '').trim();
    postText = postText.replace(/(\n\d{1,6}){1,3}\s*$/, '').trim();

    postText = stripLoggedInUser(postText);
    postText = postText.replace(/\n{3,}/g, '\n\n').trim();

    const paragraphs = postText.split('\n');
    const deduped = [];
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) { deduped.push(p); continue; }
      if (deduped.some(d => d.trim() === trimmed)) continue;
      deduped.push(p);
    }
    postText = deduped.join('\n').trim();

    const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const fullNorm = normalize(postText);
    if (fullNorm.length > 40) {
      const lines = postText.split('\n');
      for (let split = 1; split < lines.length; split++) {
        const firstHalf = lines.slice(0, split).join('\n');
        const secondHalf = lines.slice(split).join('\n');
        const normFirst = normalize(firstHalf);
        const normSecond = normalize(secondHalf);
        if (normFirst.length > 20 && normSecond.length > 20) {
          if (normFirst === normSecond) {
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

    postText = postText.replace(/\n{3,}/g, '\n\n').trim();
    return postText;
  };
}

// ─── Fallback post text extraction ───────────────────────────────────────────

function makeExtractPostTextFallback({ loggedInUser = '' } = {}) {
  function stripLoggedInUser(text) {
    if (!loggedInUser) return text;
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = text.replace(new RegExp(escape(loggedInUser), 'gi'), '');
    const parts = loggedInUser.split(/\s+/).filter(p => p.length >= 2);
    for (const part of parts) {
      result = result.replace(new RegExp(`^${escape(part)}$`, 'gmi'), '');
    }
    result = result.replace(/^ +$/gm, '');
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/  +/g, ' ');
    return result.trim();
  }

  return function extractPostTextFallback(container, authorName, anchorText) {
    const raw = ((container.innerText || container.textContent) || '').trim();
    if (!raw) return '';

    let workingRaw = raw;

    if (raw.includes('FacebookFacebook') || raw.length > 10000) {
      if (!anchorText || anchorText.length < 2) return '';
      const startIdx = raw.indexOf(anchorText);
      if (startIdx < 0) return '';
      workingRaw = raw.substring(startIdx);
      if (workingRaw.length > 10000) return '';
    }

    const reactIdx = workingRaw.search(/all reactions?:/i);
    if (reactIdx >= 0) workingRaw = workingRaw.substring(0, reactIdx);

    workingRaw = workingRaw.replace(/m\.me(\/\S*)?\s*/g, '');
    workingRaw = workingRaw.replace(/(?:photos?|videos?) from [^\n]*post/gi, '');
    workingRaw = workingRaw.trim();
    if (!workingRaw) return '';

    const lines = workingRaw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const texts = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (/^(like|comment|share|send|讚好|留言|分享)$/.test(lower)) break;
      if (/like.{0,5}comment.{0,5}share/i.test(lower) && lower.length < 60) break;
      if (/^(most relevant|all comments|view more comments|write a comment)$/i.test(lower)) break;
      if (authorName && line === authorName) continue;
      if (/^(like|comment|share|send|reply|see more|hide|follow|suggested for you|sponsored|facebook|·|…)$/i.test(lower)) continue;
      if (/^(boost|insights|promote|advertise)/i.test(lower)) continue;
      if (/^(switch into|you're commenting|manage|write a comment)/i.test(lower)) continue;
      if (/^boost this post/i.test(lower)) continue;
      if (/^(send message|message|like page|follow page|get directions|call now|shop now|book now|sign up|learn more|watch more|contact us)$/i.test(lower)) continue;
      if (/^(personal blog|public figure|politician|musician|actor|director|artist|writer|journalist|news|media|business|brand|community|organisation|nonprofit)$/i.test(lower)) continue;
      if (line.length < 2) continue;
      if (/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0\t]{20,}$/.test(line)) continue;
      if (/^\d+\s*(hr|min|h|m|d|w|sec|s)s?\s*(ago)?$/i.test(lower)) continue;
      if (/^(public|friends|only me|custom|followers)$/i.test(lower)) continue;
      if (/^(you,?\s|you and |\d+ others$)/.test(lower)) continue;
      if (/^\d+\s*(reactions?|comments?|shares?|views?)$/.test(lower)) continue;
      if (/^photos? from .+post$/i.test(lower)) continue;
      if (/^videos? from .+post$/i.test(lower)) continue;
      if (/\band \d+[kK]? others$/i.test(lower)) continue;
      if (/^m\.me(\/\S+)?$/i.test(lower)) continue;
      texts.push(line);
    }

    const unique = texts.filter((t, i) => {
      if (texts.indexOf(t) !== i) return false;
      return !texts.some((other, j) => j !== i && other.length > t.length && other.includes(t));
    });

    let postText = unique.join('\n');

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
  };
}

// ─── Post container discovery ─────────────────────────────────────────────────

function makeFindPostContainer() {
  function hasSubstantialText(el, minLength) {
    const doc = el.ownerDocument;
    let total = 0;
    const walker = doc.createTreeWalker(el, 0x4 /* NodeFilter.SHOW_TEXT */, null);
    let node;
    while ((node = walker.nextNode())) {
      total += node.nodeValue.length;
      if (total >= minLength) return true;
    }
    return false;
  }

  function isNonPostContainer(el) {
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(notifications?|chats?|contacts|messenger|bookmarks|shortcuts)$/i.test(ariaLabel)) return true;
    if (el.querySelector('[aria-label="Notifications"], [aria-label="通知"], [aria-label="Your notifications"]')) return true;
    const firstChild = el.firstElementChild;
    if (firstChild) {
      const firstText = firstChild.textContent.substring(0, 80).trim();
      if (/^(your push notifications|你的推播通知|turn on notifications)/i.test(firstText)) return true;
      if (/^(Facebook\s*){5,}/.test(firstText)) return true;
    }
    return false;
  }

  return function findPostContainer(el) {
    let p = el;
    let lastCandidate = null;
    const body = el.ownerDocument.body;
    for (let i = 0; i < 20; i++) {
      p = p.parentElement;
      if (!p || p === body) break;

      if (p.parentElement && p.parentElement.hasAttribute('data-virtualized')) {
        return lastCandidate || p;
      }

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
  };
}

module.exports = {
  makeExtractTimestamp,
  makeExtractAuthor,
  makeExtractPostText,
  makeExtractPostTextFallback,
  makeFindPostContainer,
};
