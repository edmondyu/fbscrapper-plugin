'use strict';

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const {
  makeExtractTimestamp,
  makeExtractAuthor,
  makeExtractPostText,
  makeExtractPostTextFallback,
  makeFindPostContainer,
} = require('./scraper-utils');

// ─── Minimal test framework ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// Build a DOM from inline HTML and return helpers.
// mockIds: { id: 'text' } — adds hidden elements for aria-labelledby lookups.
// NOTE: jsdom does NOT load external CSS, so CSS-class-based styles won't be
// computed. Use inline style="order:N; display:none" in fixtures to simulate
// what a real browser would compute from Facebook's CSS class rules.
function domFrom(html, mockIds = {}) {
  const mocks = Object.entries(mockIds)
    .map(([id, text]) => `<span id="${id}" style="display:none">${text}</span>`)
    .join('\n');
  const full = `<!DOCTYPE html><html><body>${mocks}${html}</body></html>`;
  const dom = new JSDOM(full, { url: 'https://www.facebook.com/' });
  const { window } = dom;
  const { document } = window;
  // Pass jsdom's getComputedStyle so inline styles are computed correctly
  const extractTimestamp = makeExtractTimestamp(document, window.getComputedStyle.bind(window));
  const extractAuthor = makeExtractAuthor();
  const extractPostText = makeExtractPostText();
  const extractPostTextFallback = makeExtractPostTextFallback();
  const findPostContainer = makeFindPostContainer();
  return { document, extractTimestamp, extractAuthor, extractPostText, extractPostTextFallback, findPostContainer };
}

function loadFixture(filename, mockIds = {}) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', filename), 'utf8');
  return domFrom(html, mockIds);
}

// ─── Basic timestamp extraction ───────────────────────────────────────────────

console.log('\n── Basic timestamp extraction ──────────────────────────────────\n');

{
  // aria-label has full date; visible text is short relative — aria-label wins
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c"><a href="/posts/123456789012" aria-label="March 14, 2025 at 10:30 PM">2w</a></div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('aria-label absolute date wins over short relative text', timestamp === 'March 14, 2025 at 10:30 PM', `got: ${JSON.stringify(timestamp)}`);
}

{
  // Plain relative text on permalink
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c"><a href="/posts/123456789012">2w</a></div>`
  );
  const { timestamp, permalink } = extractTimestamp(doc.getElementById('c'));
  assert('relative timestamp "2w" extracted from permalink text', timestamp === '2w', `got: ${JSON.stringify(timestamp)}`);
  assert('permalink extracted', permalink.includes('/posts/'), `got: ${JSON.stringify(permalink)}`);
}

{
  // Timestamp in title attribute
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c"><a href="/posts/999" title="January 5, 2025 at 6:00 PM">Sponsored</a></div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('timestamp from title attribute', timestamp === 'January 5, 2025 at 6:00 PM', `got: ${JSON.stringify(timestamp)}`);
}

{
  // Chinese relative timestamp
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c"><a href="/posts/555">13小時</a></div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('Chinese relative timestamp "13小時"', timestamp === '13小時', `got: ${JSON.stringify(timestamp)}`);
}

{
  // Chinese date format
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c"><a href="/posts/777">3月21日</a></div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('Chinese date format "3月21日"', timestamp === '3月21日', `got: ${JSON.stringify(timestamp)}`);
}

// ─── CSS flex-order unscrambling ──────────────────────────────────────────────
//
// Facebook scrambles timestamp characters using CSS flexbox `order` property.
// Real chars have specific `order` values; dummy chars are hidden via
// display:none or visibility:hidden.
//
// Tests use inline style="order:N" and style="display:none" to simulate what
// a real browser computes from Facebook's CSS class rules. The SAME code path
// runs in jsdom (inline styles) and production (CSS class rules) — making these
// tests a reliable indicator of production behaviour.

console.log('\n── CSS flex-order unscrambling (obfuscated timestamp) ──────────\n');

{
  // "1d": DOM order [d(order:2), 1(order:1)] → sorted by order → "1d"
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <a href="/posts/pfbid123">
        <span style="display:flex">
          <span style="order:2">d</span>
          <span style="order:1">1</span>
          <span style="display:none">x</span>
          <span style="display:none">y</span>
        </span>
      </a>
    </div>`
  );
  const { timestamp, permalink } = extractTimestamp(doc.getElementById('c'));
  assert('flex unscrambling: 2-char "1d" reconstructed from scrambled DOM order', timestamp === '1d', `got: ${JSON.stringify(timestamp)}`);
  assert('flex unscrambling: permalink extracted', permalink.includes('/posts/'), `got: ${JSON.stringify(permalink)}`);
}

{
  // "13h": DOM order [h(order:3), 3(order:2), 1(order:1)] → sorted → "13h"
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <a href="/posts/pfbid456">
        <span style="display:flex">
          <span style="order:3">h</span>
          <span style="order:2">3</span>
          <span style="order:1">1</span>
          <span style="display:none">a</span>
          <span style="display:none">b</span>
          <span style="visibility:hidden">c</span>
        </span>
      </a>
    </div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('flex unscrambling: 3-char "13h" reconstructed, dummy chars excluded', timestamp === '13h', `got: ${JSON.stringify(timestamp)}`);
}

{
  // "2w" with all dummies hidden: only real chars remain
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <a href="/posts/pfbidabc">
        <span style="display:flex">
          <span style="order:2">w</span>
          <span style="display:none">z</span>
          <span style="order:1">2</span>
          <span style="visibility:hidden">q</span>
        </span>
      </a>
    </div>`
  );
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert('flex unscrambling: "2w" reconstructed, display:none and visibility:hidden dummies excluded', timestamp === '2w', `got: ${JSON.stringify(timestamp)}`);
}

// ─── getBoundingClientRect visual-position path ──────────────────────────────
//
// The production fix sorts chars by getBoundingClientRect().left instead of
// getComputedStyle().order — because Facebook may use margin-left, transform,
// or any CSS property for visual ordering (not necessarily `order`).
//
// jsdom always returns rect.left=0 for all elements (no layout engine), so the
// flex-order tests above only exercise the ORDER fallback path. These tests mock
// getBoundingClientRect on individual spans to explicitly test the LEFT path.

console.log('\n── getBoundingClientRect visual-position unscrambling ──────────\n');

{
  // "1d": DOM order [d, 1, x(hidden), y(hidden)] — NO inline order styles.
  // Mock left positions: d.left=20, 1.left=10 → sorted by left → "1d"
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <a href="/posts/pfbid123">
        <span style="display:flex">
          <span>d</span>
          <span>1</span>
          <span style="display:none">x</span>
          <span style="display:none">y</span>
        </span>
      </a>
    </div>`
  );
  // Inner leaf spans (excluding the flex container span itself)
  const leafSpans = [...doc.querySelectorAll('#c a span span')];
  // leafSpans[0]='d' visually after '1'; leafSpans[1]='1' visually first
  leafSpans[0].getBoundingClientRect = () => ({ left: 20, top: 5, right: 30, bottom: 15, width: 10, height: 10 });
  leafSpans[1].getBoundingClientRect = () => ({ left: 10, top: 5, right: 20, bottom: 15, width: 10, height: 10 });
  // leafSpans[2] & [3] are display:none — filtered before getBoundingClientRect is called
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert(
    'getBoundingClientRect path: "1d" reconstructed from left positions (no inline order styles)',
    timestamp === '1d',
    `got: ${JSON.stringify(timestamp)}`
  );
}

{
  // "13h": DOM order [h, 3, 1, a(hidden), b(hidden)] — NO inline order styles.
  // Mock left positions: h.left=30, 3.left=20, 1.left=10 → sorted → "13h"
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <a href="/posts/pfbid456">
        <span style="display:flex">
          <span>h</span>
          <span>3</span>
          <span>1</span>
          <span style="display:none">a</span>
          <span style="visibility:hidden">b</span>
        </span>
      </a>
    </div>`
  );
  const leafSpans = [...doc.querySelectorAll('#c a span span')];
  leafSpans[0].getBoundingClientRect = () => ({ left: 30, top: 5, right: 40, bottom: 15, width: 10, height: 10 });
  leafSpans[1].getBoundingClientRect = () => ({ left: 20, top: 5, right: 30, bottom: 15, width: 10, height: 10 });
  leafSpans[2].getBoundingClientRect = () => ({ left: 10, top: 5, right: 20, bottom: 15, width: 10, height: 10 });
  // leafSpans[3] display:none, leafSpans[4] visibility:hidden — filtered before mock called
  const { timestamp } = extractTimestamp(doc.getElementById('c'));
  assert(
    'getBoundingClientRect path: "13h" reconstructed, hidden dummies excluded',
    timestamp === '13h',
    `got: ${JSON.stringify(timestamp)}`
  );
}

// ─── Strategy 1b: prefer absolute date over relative when both present ────────
//
// Facebook's DOM has two timestamp-related links:
//   1. A non-permalink link (href="?__cft__...") with flex-obfuscated absolute date
//   2. A permalink link (/posts/pfbid...) with plain-text relative date ("2d")
//
// Strategy 1 finds the permalink → "2d" (relative). It then scans all links for
// an absolute date. The non-permalink obfuscated link, sorted by getBoundingClientRect,
// yields "March 14, 2025 at 10:30 PM" which is returned instead, keeping the
// permalink from the /posts/ link.

console.log('\n── Strategy 1b: absolute date preferred over relative ──────────\n');

{
  // DOM: non-permalink link with scrambled chars first, then permalink with "2d".
  // Chars in non-permalink: DOM order [P(left:30), M(left:10), a(left:20)] → sorted → "Map"
  // We use a realistic-looking absolute date: "March 14, 2025 at 10:30 PM"
  // For simplicity, test with a short absolute date that matches TIME_PATTERN:
  // "14 March" → matches \d{1,2}\s+(january|...|march|...)
  // DOM order: [h(left:40), c(left:30), r(left:20), a(left:10), M(left:50), space(left:15), 1(left:60), 4(left:70)]
  // sorted by left → [a, r, space, c, h, M, 1, 4] → wait, that doesn't make "14 March"
  //
  // Simpler: "14 March" chars = ['1','4',' ','M','a','r','c','h']
  // Assign left positions matching visual order: 1→10, 4→20, ' '→30, M→40, a→50, r→60, c→70, h→80
  // DOM order we'll scramble: [M, c, 1, h, 4, a, r, ' ']
  const { document: doc, extractTimestamp } = domFrom(
    `<div id="c">
      <span aria-hidden="true"> · </span>
      <a href="?__cft__[0]=abc123" role="link">
        <span style="display:flex">
          <span>M</span>
          <span>c</span>
          <span>1</span>
          <span>h</span>
          <span>4</span>
          <span>a</span>
          <span>r</span>
          <span> </span>
        </span>
      </a>
      <a href="/posts/pfbid0dBmmcVSTDhRxas">2d</a>
    </div>`
  );
  // Mock getBoundingClientRect: visual order is "14 March"
  // chars in DOM order: M, c, 1, h, 4, a, r, ' '
  // desired visual left positions: 1→10, 4→20, ' '→30, M→40, a→50, r→60, c→70, h→80
  const leafSpans = [...doc.querySelectorAll('#c a[href^="?"] span span')];
  const leftForChar = { M: 40, c: 70, '1': 10, h: 80, '4': 20, a: 50, r: 60, ' ': 30 };
  leafSpans.forEach(s => {
    const ch = s.textContent;
    const l = leftForChar[ch] || 0;
    s.getBoundingClientRect = () => ({ left: l, top: 5, right: l + 10, bottom: 15, width: 10, height: 10 });
  });
  const { timestamp, permalink } = extractTimestamp(doc.getElementById('c'));
  assert(
    'Strategy 1b: absolute date "14 March" preferred over relative "2d"',
    timestamp === '14 March',
    `got: ${JSON.stringify(timestamp)}`
  );
  assert(
    'Strategy 1b: permalink from /posts/ link preserved',
    permalink.includes('/posts/'),
    `got: ${JSON.stringify(permalink)}`
  );
}

// ─── Real fixture: 【一位議員的建議】 post ─────────────────────────────────────
//
// This fixture uses the actual captured outerHTML from Facebook.
// jsdom CANNOT load Facebook's external CSS, so CSS-class-based flex ordering
// is NOT computed — only inline styles are. The real fixture therefore cannot
// fully validate the getComputedStyle code path.
//
// What this test DOES validate (without any mocking):
//   - No crash on real-world HTML
//   - Strategy 5 falls through to provide a permalink even without a timestamp
//
// Full validation of the obfuscated timestamp fix requires testing in the real
// browser (reload extension, scrape the post, check the CSV).

console.log('\n── Real fixture: 【一位議員的建議】 post ───────────────────────────\n');

{
  try {
    // Load fixture WITHOUT any mock elements — reflects real production state
    const { document: doc, extractTimestamp } = loadFixture('obfuscated-timestamp.html');
    const container = doc.querySelector('body > div');
    if (!container) {
      assert('fixture: post container found in body', false, 'no <div> in body');
    } else {
      const { timestamp, permalink } = extractTimestamp(container);
      // jsdom cannot compute CSS-class-based flex order, so timestamp may be empty here.
      // The flex unscrambling unit tests above validate the code path correctly.
      assert(
        'fixture: permalink extracted (Strategy 5 fallback)',
        permalink.includes('/posts/'),
        `got: ${JSON.stringify(permalink)}`
      );
      console.log(`  INFO  fixture timestamp: ${JSON.stringify(timestamp)} (empty is expected in jsdom — CSS not loaded)`);
    }
  } catch (e) {
    assert('fixture: loaded without error', false, e.message);
  }
}

// ─── Author extraction ────────────────────────────────────────────────────────

console.log('\n── Author extraction ───────────────────────────────────────────\n');

{
  // h3 heading — highest priority
  const { document: doc, extractAuthor } = domFrom(
    `<div id="c"><div><h3>John Doe</h3><a href="/john.doe">John Doe</a></div></div>`
  );
  const author = extractAuthor(doc.getElementById('c'));
  assert('author from h3 heading', author === 'John Doe', `got: ${JSON.stringify(author)}`);
}

{
  // strong > a fallback when no heading
  const { document: doc, extractAuthor } = domFrom(
    `<div id="c"><div><strong><a href="/jane.smith">Jane Smith</a></strong></div></div>`
  );
  const author = extractAuthor(doc.getElementById('c'));
  assert('author from strong>a when no heading', author === 'Jane Smith', `got: ${JSON.stringify(author)}`);
}

{
  // No author elements → empty string
  const { document: doc, extractAuthor } = domFrom(
    `<div id="c"><div dir="auto">Some post content with no author markup.</div></div>`
  );
  const author = extractAuthor(doc.getElementById('c'));
  assert('author returns empty string when no heading or strong', author === '', `got: ${JSON.stringify(author)}`);
}

{
  // Fixture: text-post — h3 author extracted
  try {
    const { document: doc, extractAuthor } = loadFixture('text-post.html');
    const container = doc.getElementById('post-container');
    const author = extractAuthor(container);
    assert('fixture text-post: author "John Doe" from h3', author === 'John Doe', `got: ${JSON.stringify(author)}`);
  } catch (e) {
    assert('fixture text-post: author extraction', false, e.message);
  }
}

// ─── Post text extraction (dir="auto" elements) ───────────────────────────────

console.log('\n── Post text extraction (extractPostText) ──────────────────────\n');

{
  // Basic post text collected from dir="auto" elements
  const { document: doc, extractPostText } = domFrom(
    `<div id="c">
      <div dir="auto">Hello world, this is the first paragraph.</div>
      <div dir="auto">Second paragraph with more content here.</div>
    </div>`
  );
  const text = extractPostText(doc.getElementById('c'));
  assert('basic: dir="auto" text collected', text.includes('Hello world'), `got: ${JSON.stringify(text)}`);
  assert('basic: second paragraph included', text.includes('Second paragraph'), `got: ${JSON.stringify(text)}`);
}

{
  // UI labels filtered out
  const { document: doc, extractPostText } = domFrom(
    `<div id="c">
      <div dir="auto">Real post content about interesting things.</div>
      <div dir="auto">Like</div>
      <div dir="auto">Comment</div>
      <div dir="auto">Share</div>
      <div dir="auto">See more</div>
    </div>`
  );
  const text = extractPostText(doc.getElementById('c'));
  assert('filter: "Like/Comment/Share" UI labels excluded', !text.includes('Like') && !text.includes('Comment'), `got: ${JSON.stringify(text)}`);
  assert('filter: "See more" stripped', !text.toLowerCase().includes('see more'), `got: ${JSON.stringify(text)}`);
  assert('filter: real content preserved', text.includes('Real post content'), `got: ${JSON.stringify(text)}`);
}

{
  // Scrambled obfuscation codes filtered out (long alphanumeric with no punctuation)
  const { document: doc, extractPostText } = domFrom(
    `<div id="c">
      <div dir="auto">Legitimate post text that should be kept.</div>
      <div dir="auto">aBcDeF1234567890ghiJklMnOpQrStUv</div>
    </div>`
  );
  const text = extractPostText(doc.getElementById('c'));
  assert('filter: scrambled FB code stripped', !text.includes('aBcDeF1234567890'), `got: ${JSON.stringify(text)}`);
  assert('filter: real text preserved alongside scrambled code', text.includes('Legitimate post text'), `got: ${JSON.stringify(text)}`);
}

{
  // Duplicate substrings deduplicated (shorter is substring of longer)
  const { document: doc, extractPostText } = domFrom(
    `<div id="c">
      <div dir="auto">Short title</div>
      <div dir="auto">Short title with expanded content below it.</div>
    </div>`
  );
  const text = extractPostText(doc.getElementById('c'));
  // The shorter "Short title" is a substring of the longer — only the longer survives
  assert('dedup: substring of longer text removed', !text.includes('Short title\nShort title'), `got: ${JSON.stringify(text)}`);
  assert('dedup: longer text retained', text.includes('Short title with expanded content'), `got: ${JSON.stringify(text)}`);
}

{
  // Fixture: text-post — full text extracted, action bar excluded
  try {
    const { document: doc, extractPostText } = loadFixture('text-post.html');
    const container = doc.getElementById('post-container');
    const text = extractPostText(container);
    assert('fixture text-post: post body extracted', text.includes('main post content'), `got: ${JSON.stringify(text)}`);
    assert('fixture text-post: action bar (Like/Comment/Share) excluded', !/^(Like|Comment|Share)$/m.test(text), `got: ${JSON.stringify(text)}`);
  } catch (e) {
    assert('fixture text-post: extractPostText', false, e.message);
  }
}

{
  // Fixture: photo-post — real content kept, garbage filtered
  try {
    const { document: doc, extractPostText } = loadFixture('photo-post.html');
    const container = doc.getElementById('post-container');
    const text = extractPostText(container);
    assert('fixture photo-post: caption kept', text.includes('Beautiful sunset'), `got: ${JSON.stringify(text)}`);
    assert('fixture photo-post: scrambled code stripped', !text.includes('aBcDeF1234567890'), `got: ${JSON.stringify(text)}`);
    assert('fixture photo-post: m.me/path link stripped', !text.includes('m.me'), `got: ${JSON.stringify(text)}`);
  } catch (e) {
    assert('fixture photo-post: extractPostText', false, e.message);
  }
}

{
  // Photo attribution "Photos from X's post" stripped when trailing at end
  const { document: doc, extractPostText } = domFrom(
    `<div id="c">
      <div dir="auto">Nice photo caption here.</div>
      <div dir="auto">Photos from Jane Smith's post</div>
    </div>`
  );
  const text = extractPostText(doc.getElementById('c'));
  assert("filter: 'Photos from X's post' trailing attribution stripped", !text.toLowerCase().includes("photos from jane smith's post"), `got: ${JSON.stringify(text)}`);
  assert("filter: caption before photo attribution kept", text.includes('Nice photo caption'), `got: ${JSON.stringify(text)}`);
}

// ─── Fallback text extraction (innerText line-by-line) ───────────────────────

console.log('\n── Fallback text extraction (extractPostTextFallback) ──────────\n');

{
  // Basic fallback: gets content even without dir="auto"
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c"><span>Photo caption without dir=auto attribute here.</span></div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), '', '');
  assert('fallback: text without dir=auto captured', text.includes('Photo caption'), `got: ${JSON.stringify(text)}`);
}

{
  // Fallback stops at action bar line
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c">Good post content.
Like
Comment
Share</div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), '', '');
  assert('fallback: stops at action bar "Like"', !text.includes('Like'), `got: ${JSON.stringify(text)}`);
  assert('fallback: content before action bar kept', text.includes('Good post content'), `got: ${JSON.stringify(text)}`);
}

{
  // Fallback skips author name line
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c">Jane Smith
Great caption for the photo today.
Like</div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), 'Jane Smith', '');
  assert('fallback: author name line skipped', !text.includes('Jane Smith'), `got: ${JSON.stringify(text)}`);
  assert('fallback: caption kept when author name filtered', text.includes('Great caption'), `got: ${JSON.stringify(text)}`);
}

{
  // Fallback: anchorText used to skip Facebook navigation noise at top
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c">FacebookFacebookHome
News Feed
Real post caption starts here.
Like</div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), '', 'Real post caption');
  assert('fallback: anchorText skips FB navigation noise', !text.includes('FacebookFacebook'), `got: ${JSON.stringify(text)}`);
  assert('fallback: content after anchor kept', text.includes('Real post caption'), `got: ${JSON.stringify(text)}`);
}

{
  // Fallback: "All reactions:" truncation removes engagement noise on same line
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c">This is the actual caption.
All reactions: 42 · 7 comments · 2 shares</div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), '', '');
  assert('fallback: truncated at "All reactions:"', !text.includes('All reactions'), `got: ${JSON.stringify(text)}`);
  assert('fallback: caption before "All reactions:" kept', text.includes('actual caption'), `got: ${JSON.stringify(text)}`);
}

{
  // Fallback: scrambled codes (long alphanumeric) filtered
  const { document: doc, extractPostTextFallback } = domFrom(
    `<div id="c">Actual caption text.
aBcDeF1234567890ghiJklMnOpQr
Like</div>`
  );
  const text = extractPostTextFallback(doc.getElementById('c'), '', '');
  assert('fallback: scrambled code line filtered', !text.includes('aBcDeF'), `got: ${JSON.stringify(text)}`);
  assert('fallback: real caption kept', text.includes('Actual caption text'), `got: ${JSON.stringify(text)}`);
}

// ─── Post container discovery ─────────────────────────────────────────────────

console.log('\n── Post container discovery (findPostContainer) ────────────────\n');

{
  // data-virtualized parent: direct child of virtualized container returned
  const { document: doc, findPostContainer } = domFrom(
    `<div data-virtualized="true">
      <div id="post">
        <h3>Author</h3>
        <a href="/posts/111">2d</a>
        <div dir="auto">Post content text here.</div>
      </div>
    </div>`
  );
  const inner = doc.querySelector('#post div[dir="auto"]');
  const container = findPostContainer(inner);
  assert('container: virtualized feed — direct child returned', container && container.id === 'post', `got: ${container && container.id}`);
}

{
  // Many-children heuristic: ≥10 children with substantial text
  const children = Array.from({ length: 12 }, (_, i) =>
    i === 0 ? `<h3>Author Name</h3>` :
    i === 1 ? `<a href="/posts/${i}">2d</a>` :
    `<div>item ${i} with some text content here</div>`
  ).join('');
  const { document: doc, findPostContainer } = domFrom(
    `<div id="outer"><div id="post">${children}</div></div>`
  );
  const leaf = doc.querySelector('#post a[href]');
  const container = findPostContainer(leaf);
  assert('container: many-children heuristic finds parent with ≥10 children', container !== null, `got: null`);
}

{
  // Non-post container (notifications panel) is rejected
  const { document: doc, findPostContainer } = domFrom(
    `<div id="outer">
      <div id="notif-panel" aria-label="Notifications">
        <h3>Author</h3>
        <a href="/posts/notif1">notification link</a>
        <div>notif item</div><div>notif item</div><div>notif item</div>
        <div>notif item</div><div>notif item</div><div>notif item</div>
        <div>notif item</div><div>notif item</div><div>notif item</div>
        <div>notif item</div><div>notif item text content here for substantial check</div>
      </div>
    </div>`
  );
  const leaf = doc.querySelector('#notif-panel a[href]');
  const container = findPostContainer(leaf);
  // Notifications panel is rejected; no virtualized parent; fallback may return null or outer
  assert('container: notifications panel (aria-label=Notifications) rejected', container === null || container.id !== 'notif-panel', `got: ${container && container.id}`);
}

// ─── Timestamp tests using older-post fixture ─────────────────────────────────

console.log('\n── Fixture: older post with date-only timestamp ────────────────\n');

{
  try {
    const { document: doc, extractTimestamp, extractPostText } = loadFixture('older-post.html');
    const container = doc.getElementById('post-container');

    const { timestamp, permalink } = extractTimestamp(container);
    assert(
      'fixture older-post: date-only timestamp "16 February" recognised',
      timestamp === '16 February',
      `got: ${JSON.stringify(timestamp)}`
    );
    assert(
      'fixture older-post: permalink extracted from /posts/ link',
      permalink.includes('/posts/'),
      `got: ${JSON.stringify(permalink)}`
    );

    const text = extractPostText(container);
    assert(
      'fixture older-post: post body extracted',
      text.includes('older post content'),
      `got: ${JSON.stringify(text)}`
    );
    assert(
      'fixture older-post: action bar excluded from text',
      !/^(Like|Comment|Share)$/m.test(text),
      `got: ${JSON.stringify(text)}`
    );
  } catch (e) {
    assert('fixture older-post: loaded without error', false, e.message);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Result: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) process.exit(1);
