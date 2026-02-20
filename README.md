# Facebook Post Scraper

A Chrome extension (Manifest V3) that scrapes Facebook posts as you scroll through your feed or a Page timeline. Captures post content, author, timestamp, permalink, reactions, comments, images, and video links. Images are automatically downloaded while session tokens are still valid.

## Features

- **Auto-scroll & scrape** — automatically scrolls down and captures posts in real-time
- **Pause / Resume / Stop** — full control over scraping sessions; resume picks up where you left off
- **Auto-retry on stall** — if scrolling stalls (e.g. Facebook throttles loading), automatically retries up to 5 times before stopping
- **Scroll-back recovery** — detects and recovers from Facebook's virtualized feed scroll jumps to avoid skipping posts
- **Image auto-download** — downloads post images to a `fb-scraper/` folder while CDN session tokens are still active
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
  - Auto-expands "See more" links before scraping
  - Line-level and block-level deduplication
  - Strips Facebook UI noise (navigation, button labels, notification panels)
  - Handles scrambled "Sponsored" text obfuscation (including `\u00a0` non-breaking spaces)
- **Timestamp extraction** — 5-strategy approach to find timestamps from various Facebook DOM patterns, including Chinese date formats
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
  "timestamp": "2h",
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
- Auto-scrolls with stall detection and auto-retry (5 retries, 5s delay each)
- Extracts post data from Facebook's DOM (`dir="auto"` elements, permalink patterns, aria-labels)
- Communicates with background via `chrome.runtime.sendMessage`

### Background Service Worker (`background.js`)
- Stores posts and download queue in `chrome.storage.local`
- Manages sequential image download queue with pause/resume
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

This results in a one-post-per-jump-back-cycle rhythm after the first few posts — slower but 100% reliable.

### The Stall-Retry Mechanism
The stall detection (8 intervals × 2.5s = 20s with no new posts) and auto-retry (5s pause, up to 5 retries) works in tandem with the scroll-back fix:
1. After the scroll jump + scroll-back cycle, the scraper may not immediately find new posts
2. Stall detection pauses auto-scroll
3. During the 5s retry delay, Facebook's DOM stabilizes
4. When scrolling resumes, posts are cleanly available for scanning

### The "Facebook" Nav Element Problem
Facebook renders a `<div dir="auto">` element containing just the text "Facebook" as part of its navigation. This element shares a DOM container with actual posts. Since the scraper finds post containers by walking up from `dir="auto"` text elements, the "Facebook" text was claiming the container first, blocking the real post from being processed. Fixed by adding "facebook" to the UI text filter.

### Shared Container Problem
On Facebook Pages, adjacent posts by the same author can share a common DOM ancestor. The scraper's `findPostContainer()` walks up from text elements to find post boundaries, but sometimes two posts resolve to the same container. When the first post marks the container as "done", the second post's text elements become orphaned (no valid container).

**Current solution**: A two-pass scan approach:
1. **Main pass**: Standard `findPostContainer()` pipeline — works for most posts
2. **Orphan pass**: After the main scan, looks for `dir="auto"` elements with 100+ characters of uncaptured text where `findPostContainer()` returned null. Walks up to find the nearest ancestor with an uncaptured permalink and processes it through `processPost()`.

### Long Text Safeguard
Posts exceeding 10,000 characters are automatically trimmed to prevent browser performance issues (the block-level deduplication algorithm is O(N² × M) on text length). Trimmed posts are prefixed with `[attention: post text too long, content is trimmed]` and a console warning is logged.

### Post-Extraction Garbage Filtering
Facebook pages contain many non-post elements (notifications, footer text, comment counts, page info) that can slip through container detection. The scraper filters these at the extraction stage by rejecting text matching patterns like notification items (`Unread...`), comment counts (`N comments`), footer text (`Privacy · Terms`), and page details (`Details ... recommend`).

### Key Architectural Insights
1. **Work WITH Facebook's virtualization, not against it**: Use `scrollBy` (relative) rather than `scrollTo` (absolute). Let Facebook manage its DOM window, but recover when it jumps.
2. **The virtual window is ~3000-4000px**: Facebook keeps roughly this much content rendered. Scroll jumps of similar magnitude confirm this — they represent the entire window shifting.
3. **`clickSeeMore` is the trigger**: The DOM expansion from clicking "See more" triggers the virtualization reorganization.
4. **Failed approaches**: Using `scrollTo` with absolute targets fights the virtualization. Pause-only on jump detection (no scroll-back) leaves the page past missed posts. Reducing scroll speed doesn't help — the jumps are caused by DOM changes, not scroll speed.

## Limitations

- Only works on `https://www.facebook.com/*`
- Video links are page URLs, not direct media files (Facebook does not expose raw video URLs in the DOM)
- Image URLs from Facebook CDN require active session tokens — images are auto-downloaded during scraping to avoid expiry
- Facebook DOM structure may change, which could break selectors
- Timestamp extraction depends on Facebook's DOM patterns; some posts may have missing timestamps depending on the page layout
- Auto-scroll may stall on very long timelines; the extension auto-retries but may eventually stop
- **Photo-only posts** (no text content) may be skipped since the scraper relies on `dir="auto"` text elements for post detection
- **Posts deep in the feed** may be missed if Facebook's virtualized feed removes them from the DOM before the scanner processes them

## License

MIT
