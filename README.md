# Facebook Post Scraper

A Chrome extension (Manifest V3) that scrapes Facebook posts as you scroll through your feed or a Page timeline. Captures post content, author, timestamp, permalink, reactions, comments, images, and videos. Images and videos are automatically downloaded while session tokens are still valid.

## Features

- **Auto-scroll & scrape** — automatically scrolls down and captures posts in real-time
- **Pause / Resume / Stop** — full control over scraping sessions; resume picks up where you left off
- **Auto-retry on stall** — if scrolling stalls (e.g. Facebook throttles loading), automatically retries up to 5 times before stopping
- **Soft reset** — after retry exhaustion, automatically pauses then restarts (up to 3 times) before giving up; the counter resets whenever a new post is captured
- **Scroll-back recovery** — detects and recovers from Facebook's virtualized feed scroll jumps to avoid skipping posts; automatically suppresses scroll-back when advancing past fully-scraped areas
- **DOM blackout recovery** — when the extension starves Facebook's JS engine (15s of silence with no DOM mutations), auto-pauses to let the page recover, then resumes
- **Sleep/wake resilience** — detects MacBook sleep via wall-clock drift and gracefully recovers (resets stall counters, skips stale DOM mutations, guards against detached nodes)
- **Full timestamp extraction** — captures exact date and time (e.g. `19 March 2026 at 15:15`) for every post, including posts from months ago, via:
  - CSS character unscrambling for recent posts (Facebook renders timestamp chars as individual spans in a flex container; sorted by position to reconstruct the date)
  - GraphQL XHR interception for older posts (extracts `creation_time` unix timestamps from Facebook's API responses before the page's JavaScript even runs)
- **Image auto-download** — downloads post images to a `fb-scraper/` folder while CDN session tokens are still active
- **Video auto-download** — for inline (native) Facebook video posts, captures the actual MP4 file (HD 720p where available) by intercepting the GraphQL video delivery response; falls back to downloading the poster thumbnail when no MP4 is available
- **Download queue** — sequential downloads with progress tracking, retry for failed downloads
- **Two export modes**:
  - **Export JSON** — raw post data
  - **Export Sanitized** — strips session-specific tokens from CDN URLs (safe to share)
- **Privacy protection** — auto-detects logged-in user's name from the Facebook UI and strips it from exported post text
- **Export-time cleaning pipeline**:
  - User name stripping (full name + individual name parts)
  - Junk artifact removal (scrambled Sponsored text, obfuscated `.com` domains, `m.me` links, leaked reaction/comment counts)
  - Block-level deduplication (detects when Facebook renders the same text twice)
  - Junk timestamp cleanup
- **Text quality**:
  - Auto-expands "See more" links before scraping, with async retry for short captures
  - **Truncated text recovery** — multi-layer rescue chain for posts whose body text is not in `dir="auto"` elements (e.g. photo post captions rendered in `span[dir=none]`): immediate `innerText` fallback at capture time, DupSkip rescue on scroll-back re-encounter, and RetryA fallback
  - Three-layer deduplication: permalink, text prefix, and content hash
  - Strips Facebook UI noise (navigation, button labels, notification panels)
  - Handles scrambled "Sponsored" text obfuscation (including `\u00a0` non-breaking spaces)
- **Performance at scale** — `WeakSet`-based element tracking eliminates redundant DOM walks on 10 000+ element pages; scan cost stays near-constant regardless of how many posts have been scraped
- Supports English and Chinese (Traditional/Simplified) Facebook interfaces

## Installation

1. Clone this repository:
   ```
   git clone git@github.com:edmondyu/fbscrapper-plugin.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder

## Usage

1. Navigate to [facebook.com](https://www.facebook.com) (any feed, Page, or profile)
2. Click the extension icon in the Chrome toolbar
3. Click **Start** — the page auto-scrolls and posts are captured
4. Click **Pause** to pause, **Resume** to continue, **Stop** to end the session
5. Click **Export JSON** or **Export Sanitized** to download the scraped data
6. Click **Retry Failed** if any image downloads failed
7. Click **Clear All** to reset all data (requires confirmation click)

### Name Stripping

The extension auto-detects your logged-in Facebook name from the navigation bar. You can:
- View the detected name in the popup under "Strip name from export"
- Click **Detect** to force re-detection
- Enter a **manual override** if auto-detection fails

The name (and its individual parts) are stripped from exported post text as standalone lines to protect privacy.

## Output Format

Exported JSON contains an array of post objects:

```json
{
  "author": "Page or User Name",
  "postText": "Full post content...",
  "timestamp": "19 March 2026 at 15:15",
  "permalink": "https://www.facebook.com/page/posts/...",
  "reactions": "Like: 582 people",
  "comments": "30 comments",
  "images": ["https://scontent...fbcdn.net/...jpg"],
  "videos": ["https://www.facebook.com/reel/123456"],
  "localFiles": ["fb-scraper/post-0-img-0.jpg"],
  "scrapedAt": "2026-02-10T16:20:41.881Z"
}
```

The **sanitized** export additionally strips session-specific CDN parameters (`_nc_sid`, `_nc_ohc`, `oh`, etc.) from image and video URLs.

## File Structure

```
├── manifest.json    # Extension configuration (Manifest V3)
├── interceptor.js   # Main-world script — XHR interception for GraphQL timestamps
├── content.js       # Content script — DOM scraping, auto-scroll, text extraction
├── background.js    # Service worker — data storage, image download queue
├── popup.html       # Extension popup UI
├── popup.js         # Popup logic, export cleaning pipeline, name detection
├── popup.css        # Popup styling
└── samples/         # Sample exported data for testing
```

## Architecture

### Content Script (`content.js`)
- Runs on all `facebook.com` pages
- Auto-detects logged-in user's name on page load (retries up to 10 times)
- Uses `MutationObserver` + periodic scanning to detect new posts
- Auto-scrolls with stall detection and auto-retry (5 retries, 3s delay each)
- Extracts post data from Facebook's DOM (`dir="auto"` elements, permalink patterns, aria-labels)
- Communicates with background via `chrome.runtime.sendMessage`
- Listens for `FB_SCRAPER_CREATION_TIMES` messages from `interceptor.js` to resolve older post timestamps

### Main-World Interceptor (`interceptor.js`)
- Declared in the manifest as `"world": "MAIN"` + `"run_at": "document_start"`
- Runs in the page's main JavaScript world before **any** of Facebook's code executes
- Patches `XMLHttpRequest.prototype.open/send` to intercept Facebook's GraphQL API responses
- On each `/api/graphql` response:
  - Extracts all `"creation_time"` unix timestamp values and posts them to the content script via `window.postMessage({ type: 'FB_SCRAPER_CREATION_TIMES', ... })`
  - Extracts MP4 video URLs by matching `first_frame_thumbnail` poster URLs (which contain the video ID) to `progressive_url` entries in the same GraphQL video delivery block; posts them via `window.postMessage({ type: 'FB_SCRAPER_VIDEO_URLS', ... })`
- The content script builds a date-keyed map and uses it to resolve date-only timestamps (e.g. `"16 February"`) to full datetime strings (e.g. `"16 February 2026 at 09:04"`)
- If a post is stored before the GraphQL response arrives, it is added to a pending-retry map and updated retroactively when the response arrives

### Background Service Worker (`background.js`)
- Stores posts and download queue in `chrome.storage.local`
- Manages sequential image download queue with pause/resume
- Supports post replacement by permalink or author+prefix matching (for truncated text upgrades)
- Handles `UPDATE_TIMESTAMP` messages to patch a stored post's timestamp once the full datetime becomes available from the XHR interceptor
- Handles `UPDATE_VIDEO` messages to replace a post's poster thumbnail URL with the real MP4 URL and enqueue the video download
- Persists state across service worker restarts

### Popup (`popup.js`)
- Controls scraping (Start/Pause/Resume/Stop)
- Displays post count and download progress
- Export-time cleaning pipeline: name stripping, artifact removal, deduplication
- Name detection UI (auto-detected + manual override)

## Known Issues & Technical Notes

### Facebook's Virtualized Feed
Facebook uses a **virtualized feed** where only a small window of posts (~2000-5000px of vertical content) exist in the DOM at any time. Posts outside the visible window are removed and re-created as the user scrolls. Key implications:

- **Posts must be visible**: A post that was never scrolled into view will never appear in the DOM and cannot be scraped.
- **DOM node recycling**: Facebook reuses the same DOM nodes for different posts. The scraper uses permalink fingerprinting to detect recycled nodes and clear stale marks.
- **Scroll position is unreliable**: The same `scrollY` value can correspond to different posts at different times, because the virtual window shifts as Facebook reorganizes content.

### The Scroll Jump Problem
After scraping a post, the scraper's `clickSeeMore()` expands truncated text. This DOM change triggers Facebook's virtualization engine to **reorganize the feed**, causing sudden scroll position jumps of 1000-3400px forward. The pattern repeats for every 1-2 posts:

1. Auto-scroll advances page by 400px
2. `clickSeeMore()` expands post → DOM height changes
3. Facebook's virtualization reorganizes → scroll jumps forward 1000-3400px
4. Without intervention: posts in the jumped-over area are never in the DOM when scanner runs → **posts skipped**

Posts with longer text (more expansion) tend to cause larger jumps.

**Solution — Scroll-back mechanism**: A scroll event listener detects forward jumps > 800px. When detected:
1. **Immediate scan**: `scanForPosts()` runs to catch any posts visible at the jumped position
2. **Scroll back**: `window.scrollTo()` restores the pre-jump position
3. **Normal scroll resumes**: The 400px auto-scroll re-traverses the area

This results in a one-post-per-jump-back-cycle rhythm after the first few posts — slower but reliable. When an area is fully scraped, scroll-back is automatically suppressed (see below).

### The Stall-Retry Mechanism
The stall detection (6 intervals × 1.5s = 9s with no new posts) and auto-retry (3s pause, up to 5 retries) works in tandem with the scroll-back fix:
1. After the scroll jump + scroll-back cycle, the scraper may not immediately find new posts
2. Stall detection pauses auto-scroll
3. During the 3s retry delay, Facebook's DOM stabilizes
4. When scrolling resumes, posts are cleanly available for scanning

### Scroll-back Suppression
When the scraper has fully scraped an area, scroll-back can trap it in a loop (all containers marked done, but scroll jumps keep pulling it back). The scraper tracks consecutive scans with no new captures. After 4 such scans, scroll-back is suppressed, allowing the scraper to advance to new territory. The counter resets only when genuinely new posts are captured (not just when unmarked containers are found).

### Sleep/Wake Detection
When a MacBook enters sleep mode, Chrome accumulates `setInterval` ticks and fires them in a burst on wake. The scraper detects this via wall-clock drift: if the actual elapsed time since the interval started is far ahead of the expected tick count (> 4× interval), it infers a sleep event. On detection:
- Stall and retry counters are reset to prevent false "no new posts" stops
- Scroll position tracking is reset to prevent false jump detection
- The periodic scanner and MutationObserver skip stale ticks/mutations
- Detached DOM node guards prevent processing containers that were removed during sleep

### DOM Blackout Recovery (v1.4.0)
When the extension runs its scan loop too aggressively, it starves Facebook's JavaScript engine — the page appears frozen and no new DOM mutations arrive for an extended period. The scraper detects this by tracking the timestamp of the last DOM mutation. If 15 seconds pass with no mutations while the scraper is active, it automatically pauses, waits 3 seconds for the page to recover, then resumes. This prevents the scraper from grinding the page to a halt on very long timelines.

### Soft Reset on Retry Exhaustion (v1.4.0)
After exhausting all 5 auto-retries without finding new posts, instead of stopping permanently the scraper performs a **soft reset**: it pauses for 3 seconds then restarts the auto-scroll. Up to 3 soft resets are allowed per session. The soft reset counter resets whenever a genuinely new post is captured, so it does not count against sessions that are progressing normally but encounter occasional dry patches.

### Permalink Cleaning & Deduplication
Facebook's `/photo/` URLs without identifying query parameters (e.g. `fbid`) are not unique permalinks — they are shared across all photo posts on a Page. The scraper rejects these generic paths and preserves identifying params (`fbid`, `story_fbid`, `v`) when cleaning URLs. Posts without unique permalinks are deduplicated via a three-layer approach:
1. **Permalink dedup**: Unique permalink → replace shorter text with longer
2. **Prefix dedup**: `hash(author + first 40 chars)` → catches truncated "See more" captures
3. **Hash dedup**: `hash(author + fullText)` → exact content match

### The "Facebook" Nav Element Problem
Facebook renders a `<div dir="auto">` element containing just the text "Facebook" as part of its navigation. This element shares a DOM container with actual posts. Since the scraper finds post containers by walking up from `dir="auto"` text elements, the "Facebook" text was claiming the container first, blocking the real post from being processed. Fixed by adding "facebook" to the UI text filter.

### Shared Container Problem
On Facebook Pages, adjacent posts by the same author can share a common DOM ancestor. The scraper's `findPostContainer()` walks up from text elements to find post boundaries, but sometimes two posts resolve to the same container. When the first post marks the container as "done", the second post's text elements become orphaned (no valid container).

**Current solution**: A three-pass scan approach:
1. **Main pass**: Standard `findPostContainer()` pipeline — works for most posts
2. **Orphan pass**: After the main scan, looks for `dir="auto"` elements with 100+ characters of uncaptured text where `findPostContainer()` returned null. Walks up to find the nearest ancestor with an uncaptured permalink and processes it through `processPost()`.
3. **Photo-only pass**: Detects posts with no text content (see "Photo-Only Post Detection" below).

### Long Text Safeguard
Posts exceeding 10,000 characters are automatically trimmed to prevent browser performance issues (the block-level deduplication algorithm is O(N² × M) on text length). Trimmed posts are prefixed with `[attention: post text too long, content is trimmed]` and a console warning is logged.

### Post-Extraction Garbage Filtering
Facebook pages contain many non-post elements (notifications, footer text, comment counts, page info) that can slip through container detection. The scraper filters these at the extraction stage by rejecting text matching patterns like notification items (`Unread...`), comment counts (`N comments`), footer text (`Privacy · Terms`), and page details (`Details ... recommend`).

### Truncated Text Recovery (v1.3.0)

Some posts have their body text outside `dir="auto"` elements — for example, photo post captions that Facebook renders in `span[dir=none]` after "See more" expansion. `extractPostText` (which only reads `dir="auto"]`) captures only the short first-line title for these posts (typically < 50 chars).

**Root cause of the 100+ post degradation**: Facebook aggressively virtualizes the DOM for performance. After ~100 posts have been scraped, containers that have scrolled off-screen have their body content stripped from the DOM. By the time the retry chain fires (2 seconds after capture), the container's `dir="auto"` elements contain only the title and `innerText` is also empty.

**Solution — `extractPostTextFallback`**: A fallback function that reads `container.innerText` line-by-line and filters Facebook UI noise. It is called at three points:

1. **Immediate fallback** (at initial capture time, ~400ms after finding the container): fires while the container is still in/near the viewport and content is accessible, before Facebook virtualizes it. If `extractPostText` returns < 50 chars, the fallback is tried immediately and the result is used for the initial `NEW_POST` message if longer.
2. **DupSkip rescue** (when the same container is re-encountered via scroll-back): if stored text is < 50 chars, try again — the container is now back in the viewport.
3. **RetryA fallback rescue** (~2s after capture): last-chance attempt before the retry chain escalates to See More clicking. Guarded by `storedLen` to avoid overwriting a better DupSkip result.

**Preprocessing in `extractPostTextFallback`**:
- Truncates `workingRaw` at `All reactions:` — this is a definitive end-of-content marker and also handles scrambled Facebook obfuscation codes placed on the same line immediately before `All reactions:`.
- Removes `m.me` Messenger links inline (they appear concatenated with the post title, no newline separator).
- Removes `Photos from [Author]'s post` attribution inline.
- Line-level filters cover action bar, timestamps, audience labels, reaction name lists, scrambled alphanumeric codes, and Facebook UI patterns.

**Known remaining issues** (< 1% of posts):
- A small number of posts may still contain irrelevant fragments (e.g. Facebook attribution text that slipped past the inline preprocessing, or reaction/comment section content on unusual DOM layouts).
- A small number of posts may appear as duplicates when REPLACE_POST matching fails (background.js couldn't match the post by permalink, creating a second entry instead of replacing the first).

### Photo-Only Post Detection (v1.2.0)

Photo-only posts (posts with just an image and no text) were invisible to the main scanner because:

1. **No qualifying `dir="auto"` text**: The main scan iterates `dir="auto"` elements looking for text >= 8 characters. In photo-only posts, the only `dir="auto"` elements contain the word "Facebook" (anti-scraping padding), which is filtered by the UI text filter at the scan entry point.
2. **Author name uses `dir="ltr"`**: The author heading (e.g. `<h2>林妙茵Miu</h2>`) uses `dir="ltr"`, not `dir="auto"`, so it never enters the scanner's element loop.
3. **No text for container discovery**: Since the main scan finds post containers by walking UP from text elements, and there are no qualifying text elements, the container is never discovered.

#### Facebook's Anti-Scraping DOM Padding

Photo-only posts have a distinctive DOM structure:
- The post container has **20+ direct children**
- ~20 of these are `<div aria-hidden="true">` blocks, each containing a `<blockquote>` with `<span dir="auto">Facebook</span>` — **anti-scraping padding** designed to confuse text-based scrapers
- Each padding block also has `data-0` through `data-19` attributes and a hidden `role="button"` element
- The **"Sponsored" label is obfuscated**: individual `<span>` elements each contain a single character (e.g. `>S</span>`, `>p</span>`, `>o</span>`...) with CSS class-based reordering to visually spell "Sponsored" while being unreadable to scrapers
- The **profile picture** is rendered as an SVG `<image xlink:href="scontent...">`, NOT an HTML `<img>` tag — so `img[src*="scontent"]` selectors do not match

#### The Solution: Third-Pass "Facebook" Element Walk-Up

The third pass uses the very "Facebook" text that the main scan filters out as an **entry point**:

1. **Find "Facebook" elements**: Iterate all `dir="auto"` elements, looking for those with text exactly "Facebook"
2. **Walk up to post boundary**: From each "Facebook" element, walk up the DOM (max 10 levels) to find the first ancestor with `children.length >= 10` — this reaches the post container with its 20+ anti-scraping padding children
3. **Validate as a real post**: The container must have:
   - An author heading (`h2`, `h3`, or `h4`)
   - A post permalink (`/posts/`, `/photo/`, or `/videos/` link)
4. **Overlap guard**: Check that no element already in `seenContainers` (from the main scan) is a descendant of this container. This prevents re-processing regular text posts (whose inner containers were already captured by the main scan). This check must use `seenContainers` (populated synchronously) rather than DOM markers (`data-fb-scraper-done`), because `processPost` sets markers asynchronously inside `setTimeout`.
5. **Process**: Pass the container to `processPost()`, which extracts the author name from the `<h2>` heading and the permalink from the link — post text is empty (all "Facebook" padding filtered by `extractPostText`).

#### The Duplicate Text / Short URL Problem

When the third pass finds a container that is a LARGER ancestor of an already-captured post (rather than the photo-only post), the larger container includes extra DOM content like link preview URLs (e.g. `NR42jdCK.com`, `c9kozB5P.com`, `1G59eKq.com`). This produces duplicated post text with junk short URLs inserted. The overlap guard (step 4 above) prevents this by skipping containers that already have captured posts inside them. Additionally, "facebook" was added to the `extractPostText` filter to ensure the anti-scraping "Facebook" padding text is excluded from extracted post content.

### Scan Performance at Scale (v1.3.0)

At 300+ posts the Facebook page DOM contains 10 000+ `dir="auto"` elements. The scan loop previously called `findPostContainer()` (a DOM tree walk) on thousands of already-evaluated elements every 1.2 seconds, causing visible slowdown.

**Solution — `_scanSeenElements` WeakSet**: A module-level `WeakSet` records every `dir="auto"` element after it has been fully evaluated (regardless of outcome). On subsequent scans the element is skipped in O(1) before any text read or DOM walk. Because it is a `WeakSet`, elements that Facebook removes (DOM virtualization) are garbage-collected automatically.

- Before: ~3 800 `findPostContainer` calls per scan at 300 posts.
- After: ~50 calls per scan (only truly new elements from Facebook's infinite scroll).

The MutationObserver debounce also scales: 300ms → 800ms (after 150 posts) → 1 500ms (after 300 posts) to batch the burst of mutations Facebook generates when loading new posts.

### Full Timestamp Extraction (v1.5.0 + v1.6.0)

Facebook does not expose plain-text timestamps directly in the DOM for most posts. Two techniques are used depending on post age:

#### CSS Character Unscrambling (v1.5.0) — for recent posts

Facebook renders timestamp strings as individual `<span>` leaf elements inside a flex container, with CSS `order` and `margin` properties controlling visual order. Noise characters are interleaved at a different vertical position.

The scraper's `getTimestampFromLink` function:
1. Tries `aria-labelledby` (a hidden `<span id="...">` with plain-English text, e.g. `"2 days ago"` or `"19 March at 15:15"`)
2. Falls back to `aria-label`, then `innerText`
3. As a last resort, performs **CSS unscrambling**:
   - Collects all leaf `<span>` elements from the timestamp link
   - Calls `getBoundingClientRect()` on each to get `top`, `left`, and reads CSS `order`
   - Sorts by `top → left → CSS order` to reconstruct visual reading order
   - Joins the characters and extracts the date prefix with a regex
4. A relative label from `aria-labelledby` (e.g. `"2 days ago"`) is saved as a fallback; the scraper continues to attempt CSS unscrambling to recover the absolute date

**Key bug fixed**: `getBoundingClientRect()` must be called once and both `rect.top` and `rect.left` stored together. An earlier version stored `left` from the rect but used a stale local variable for `top`, leaving `top: undefined` in each entry. The sort `a.top - b.top` then computed `NaN`, breaking the sort entirely and producing garbled text.

#### XHR Interception for `creation_time` (v1.6.0) — for older posts

For posts older than ~4 weeks, Facebook's `aria-labelledby` span contains only the date (`"16 February"`) without the time. The CSS-unscrambled text is similarly date-only for old posts. The full datetime only exists in Facebook's React/Relay store, loaded from GraphQL.

**Investigation findings**:
- Facebook uses `XMLHttpRequest` (not `fetch`) for all GraphQL calls — `window.fetch` interception captures zero requests
- Facebook's Relay framework saves a reference to `XMLHttpRequest` at **boot time** — any patch applied after Facebook's code runs is ignored
- The full `creation_time` unix timestamp is present in plaintext in the GraphQL JSON response body (e.g. `"creation_time":1773837477`)

**Solution — `interceptor.js`**:

```
manifest.json → content_scripts:
  { "js": ["interceptor.js"], "run_at": "document_start", "world": "MAIN" }
```

- Declared as a content script with `"world": "MAIN"` and `"run_at": "document_start"` — Chrome injects it into the page's main JavaScript world before any of Facebook's scripts execute, bypassing page CSP
- Patches `XMLHttpRequest.prototype.open` (to record the request URL) and `XMLHttpRequest.prototype.send` (to attach a `load` listener)
- On each GraphQL response, extracts all `"creation_time"` values and posts them to the content script via `window.postMessage({ type: 'FB_SCRAPER_CREATION_TIMES', times: [...] })`

**Content script side**:
- Listens for `FB_SCRAPER_CREATION_TIMES` messages and builds `_creationTimesByDate`: a map from date key (`"16 February"`) to an array of unix timestamps, sorted newest-first
- When `extractTimestamp` returns a date-only string, `lookupCreationTime` matches by date and returns the full `formatCreationTime(unixTs)` string
- **Race condition handling**: if `processPost` runs before the XHR response's `postMessage` is processed, the post is added to `_pendingTimestampPosts`. When the next batch of creation_times arrives, all pending posts are retried and an `UPDATE_TIMESTAMP` message is sent to background.js to patch the stored record retroactively

**Why inline `<script>` injection fails**: Facebook's CSP blocks inline scripts injected via `document.createElement('script')`. The `"world": "MAIN"` manifest approach bypasses CSP because Chrome itself injects the script, not the page.

**Why `document_idle` is too late**: Even if CSP were not a concern, injecting at `document_idle` (after the page has loaded) means Facebook's Relay framework has already saved its XHR reference. Patching `XMLHttpRequest.prototype` at that point has no effect on in-flight or future Relay requests.

### Inline Video MP4 Download (v1.9.0)

Facebook inline (native) video posts use MSE/blob delivery — no direct video URL exists in the DOM. The `<video>` element has no `src` attribute; only a `poster` thumbnail URL (from the `t15.5256` CDN path) is accessible.

**How MP4 URLs are extracted**:

The same XHR interceptor (`interceptor.js`) that captures timestamps also intercepts the GraphQL video delivery response:

1. **Collect `progressive_url` entries** — scan the GraphQL response for all `progressive_url` fields that contain `.mp4` URLs, recording their byte positions
2. **Match via `first_frame_thumbnail`** — for each `first_frame_thumbnail` field (which contains the poster filename, e.g. `562486158_..._n.jpg`), extract the video ID from the filename and find any `progressive_url` entries that appear within 15 000 characters after it in the same response block
3. **SD vs HD** — URLs containing `720` in the path are classified as HD (720p, ~484 kbps); others as SD (~154 kbps). The HD URL is preferred
4. **`FB_SCRAPER_VIDEO_URLS` postMessage** — sends `{ id: videoId, sdUrl, hdUrl }` to the content script

**Content script matching**:
- When a video post is scraped, `registerVideoIds` extracts the video ID from the poster URL and registers it in `_pendingVideoIdPosts` (keyed by video ID)
- When `FB_SCRAPER_VIDEO_URLS` arrives, the content script looks up the pending post and sends `UPDATE_VIDEO` to background.js
- **Race condition**: if the GraphQL response arrives before the post is scraped, the URL is cached in `_receivedVideoUrls`; `registerVideoIds` checks this cache immediately and sends `UPDATE_VIDEO` as soon as the post is stored (in the `sendMessage` response callback)

**Background**:
- `UPDATE_VIDEO` handler finds the post by permalink, author+prefix, or by searching for the video ID in the stored poster URL
- Replaces `post.videos[0]` with the MP4 URL and enqueues the download as `post-N-vid-0.mp4`

### Key Architectural Insights
1. **Work WITH Facebook's virtualization, not against it**: Use `scrollBy` (relative) rather than `scrollTo` (absolute). Let Facebook manage its DOM window, but recover when it jumps.
2. **The virtual window is ~3000-4000px**: Facebook keeps roughly this much content rendered. Scroll jumps of similar magnitude confirm this — they represent the entire window shifting.
3. **`clickSeeMore` is the trigger**: The DOM expansion from clicking "See more" triggers the virtualization reorganization.
4. **Failed approaches**: Using `scrollTo` with absolute targets fights the virtualization. Pause-only on jump detection (no scroll-back) leaves the page past missed posts. Reducing scroll speed doesn't help — the jumps are caused by DOM changes, not scroll speed.
5. **Facebook uses XHR not fetch**: Despite being a modern React/Relay application, Facebook's data layer uses `XMLHttpRequest` for GraphQL calls. `window.fetch` interception captures zero of these requests.
6. **`document_start` is mandatory for XHR patching**: Relay saves its XHR reference at module initialization, which runs during page load — before `document_idle`. Any interceptor installed after the page has begun executing will be silently ignored by Relay.

## Limitations

- Only works on `https://www.facebook.com/*`
- **Inline (native) video posts** download the actual MP4 file via GraphQL interception
- **Shared/linked videos** (posts that embed another page's video): only the poster thumbnail is downloaded; the Facebook watch URL is preserved in the export JSON for manual access. Facebook does not include MP4 delivery data in feed GraphQL for shared videos — it only loads when the user clicks play
- Image URLs from Facebook CDN require active session tokens — images are auto-downloaded during scraping to avoid expiry
- Facebook DOM structure may change, which could break selectors
- Some older posts may show only a date without a time (e.g. `"16 February"`) if the GraphQL feed response for that scroll position did not include `creation_time` (e.g. the response was not captured before the post was processed)
- Auto-scroll may stall on very long timelines; the extension auto-retries but may eventually stop
- **Post ordering**: Posts may occasionally appear out of order in the CSV due to timing differences between the main scan and the third-pass photo-only detection
- **Posts deep in the feed** may be missed if Facebook's virtualized feed removes them from the DOM before the scanner processes them
- **Irrelevant fragments in post text** (< 1% of posts): Facebook attribution text (`Photos from X's post`), Messenger links (`m.me/...`), or reaction/comment section content may appear in captured text when they share a DOM line with post content and slip past the inline preprocessing filters in `extractPostTextFallback`.
- **Duplicate posts** (< 1% of posts): When `REPLACE_POST` matching fails (background.js cannot find the original entry by permalink), a second CSV entry is created for the same post — one with the short initial capture, one with the rescued full text.

## License

MIT
