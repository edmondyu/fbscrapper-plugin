# Facebook Post Scraper

A Chrome extension (Manifest V3) that scrapes Facebook posts as you scroll through your feed or a Page timeline. Captures post content, author, timestamp, permalink, reactions, comments, images, and video links. Images are automatically downloaded while session tokens are still valid.

## Features

- **Auto-scroll & scrape** — automatically scrolls down and captures posts in real-time
- **Pause / Resume / Stop** — full control over scraping sessions; resume picks up where you left off
- **Auto-retry on stall** — if scrolling stalls (e.g. Facebook throttles loading), automatically retries up to 5 times before stopping
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

## Limitations

- Only works on `https://www.facebook.com/*`
- Video links are page URLs, not direct media files (Facebook does not expose raw video URLs in the DOM)
- Image URLs from Facebook CDN require active session tokens — images are auto-downloaded during scraping to avoid expiry
- Facebook DOM structure may change, which could break selectors
- Timestamp extraction depends on Facebook's DOM patterns; some posts may have missing timestamps depending on the page layout
- Auto-scroll may stall on very long timelines; the extension auto-retries but may eventually stop

## License

MIT
