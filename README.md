# Facebook Post Scraper

A Chrome extension (Manifest V3) that scrapes Facebook posts as you scroll through your feed. Captures post content, author, timestamp, permalink, reactions, comments, images, and video links.

## Features

- Scrapes posts in real-time as you scroll your Facebook feed
- Extracts structured data from each post:
  - Author name
  - Full post text (with "See more" auto-expanded)
  - Timestamp and permalink
  - Reaction and comment counts
  - Image URLs (from Facebook CDN)
  - Video page links (`/videos/`, `/reel/`, `/watch`)
- Exports all scraped posts as a JSON file
- Deduplicates posts automatically
- Filters out UI noise, notifications, and navigation elements
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

1. Navigate to [facebook.com](https://www.facebook.com)
2. Click the extension icon in the Chrome toolbar
3. Click **Start Scraping**
4. Scroll through your feed — posts are captured automatically
5. Click **Export JSON** to download the scraped data
6. Click **Clear All** to reset (requires confirmation click)

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
  "scrapedAt": "2026-02-10T16:20:41.881Z"
}
```

## File Structure

```
├── manifest.json    # Extension configuration (Manifest V3)
├── content.js       # Content script — DOM scraping logic
├── background.js    # Service worker — data storage via chrome.storage
├── popup.html       # Extension popup UI
├── popup.js         # Popup interaction logic
└── popup.css        # Popup styling
```

## Limitations

- Only works on `https://www.facebook.com/*`
- Requires manual scrolling to discover new posts (no auto-scroll)
- Video links are page URLs, not direct media files (Facebook does not expose raw video URLs in the DOM)
- Image URLs from Facebook CDN may expire after some time
- Facebook DOM structure may change, which could break selectors

## License

MIT
