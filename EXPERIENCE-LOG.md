# Performance & Stability Experience Log (post-v1.2.0)

## Session Summary
After v1.2.0 (photo-only post detection), several performance and stability issues emerged when scraping 200+ posts. This log documents the root causes found and fixes applied.

---

## Issue 1: Excessive Scroll-back in Later Stages (200+ posts)
**Symptom**: CSV shows 207 entries scraped, but UI is stuck at ~150th post. Visual inspection shows the page scrolling back repeatedly.

**Root Causes**:
1. **Early permalink dedup mismatch**: The quick permalink check in `scanForPosts` stripped ALL query params (`qUrl.search = ''`), but `cleanPermalink` in `extractTimestamp` preserves `fbid`, `story_fbid`, `v`. The quick check never matched stored permalinks → recycled DOM nodes were re-processed every scan cycle.
2. **Scroll-back suppression threshold too high**: Threshold of 4 empty scans before suppression was too slow to engage.

**Fixes**:
- Quick permalink check now mirrors `cleanPermalink` logic (preserves identifying params)
- Lowered scroll-back suppress threshold: 4 → 3 empty scans
- Added 5-second cooldown after suppression to prevent re-engagement
- Wake detection resets cooldown

---

## Issue 2: Truncated Post Text (only first line captured, especially after 100+ posts)
**Symptom**: Posts captured with only the first few words/characters.

**Root Cause**: Facebook's virtualization removes the container during the 600ms "See more" delay. The baseline text capture (before delay) may itself be truncated if the post hasn't fully rendered yet.

**Fixes**:
- Mid-delay capture at 300ms: extracts text at the halfway point before virtualization is likely to remove the container
- Best-of-three selection: mid-delay > baseline > nothing
- Allow re-processing of short captures (<200 chars): early permalink dedup skips them so the same post can be re-captured with full text later
- Pre-captured timestamp/permalink as fallback when container is detached

---

## Issue 3: False Wake Detection (post-200+ posts)
**Symptom**: Console log shows "Wake detected (wall drift: 6s)" firing repeatedly, even when the system is NOT sleeping. Stall counters reset in a loop → scraper can't advance.

**Root Cause**: The old wake detection used **cumulative clock drift** (`wallElapsed > expectedElapsed + SCROLL_INTERVAL * 4`). With 16,842 `dir="auto"` elements, each scan took ~1.5s. Over many ticks, cumulative drift from slow scans exceeded the 6s threshold, falsely triggering wake detection. Each false wake reset `stallCount` and `_consecutiveEmptyScans` → scraper trapped in stall→reset→stall loop.

**Fix**: Changed to **per-tick gap** detection. Only trigger wake when a single gap between consecutive ticks exceeds 15s (actual sleep), not when small delays accumulate.

---

## Issue 4: Facebook UI Freezing / Blackout (200+ posts)
**Symptom**: Facebook UI stops rendering, shows skeleton loading placeholders, auto-scroll stops working. After stopping the scraper, Facebook resumes normally.

**Root Cause**: `el.innerText` in the scan loop forces a **synchronous layout reflow** for every call. With 16,842 elements scanned every 1.2s = ~14,000 forced reflows/second. This starved Facebook's own rendering pipeline of CPU time.

**Fixes**:
- Replaced `innerText` with `textContent` in scan loop filter (pure string read, no reflow)
- Replaced `innerText` with `textContent` in second and third pass loops
- Replaced `innerText`/`textContent` length checks in `findPostContainer` with `hasSubstantialText()` using TreeWalker (early bailout, no string concatenation)

---

## Issue 5: Tab Crash (OOM) at 250+ posts
**Symptom**: Chrome tab crashes with "Aw, Snap!" error.

**Root Cause**: After replacing `innerText` with `textContent` in `findPostContainer`, `p.textContent.length` near the DOM root concatenated ALL descendant text into a single multi-megabyte string. Called ~5,600 times per scan, with walk-ups reaching 10-20 levels deep, this created dozens of multi-MB temporary strings per scan → out-of-memory crash.

**Fixes**:
- Created `hasSubstantialText(el, minLength)` function using TreeWalker — sums text node lengths with early bailout at threshold. Never creates a concatenated string.
- Scoped `querySelectorAll` to the feed container (`[data-virtualized]` parent) instead of entire document — reduces element count from 16,842 to ~200
- Added scan throttle: 2-second minimum gap between scans after 150+ posts
- Increased MutationObserver debounce from 300ms to 1000ms after 150+ posts
- Made `extractTimestamp` baseline capture lazy (only when "See more" delay > 0)

---

## Key Lessons Learned

### Performance
1. **`innerText` is extremely expensive** — forces synchronous layout reflow. Never use it in hot loops. Use `textContent` for filtering.
2. **`textContent` is dangerous on large containers** — concatenates ALL descendant text. Near DOM root, this creates multi-MB strings. Use TreeWalker with early bailout instead.
3. **`querySelectorAll` scope matters** — querying the entire document returns elements from nav, sidebar, chat panels. Scope to the feed container for 99% reduction.
4. **Cumulative drift is unreliable for wake detection** — slow scans cause gradual drift that triggers false positives. Use per-tick gap instead.

### Facebook's Behavior
5. **Facebook's virtualized feed has ~16,000+ `dir="auto"` elements** on the full page (not all in the feed).
6. **Facebook shows skeleton placeholders** when content delivery is throttled — this is server-side rate limiting, not a scraper bug.
7. **Facebook's inactivity detection** blacks out the page when it detects automated scrolling with no real user interaction. User must occasionally move mouse.

### Architecture
8. **Three-tier capture strategy for "See more" expansion**: baseline (before click) → mid-delay (300ms) → final (600ms). Best-of-three selection handles virtualization at any point.
9. **Early permalink dedup must mirror `cleanPermalink` exactly** — mismatched URL cleaning causes dedup failures.
10. **Short captures (<200 chars) should not block re-processing** — the same post may reappear in a fresh DOM node with full text available.

---

## Current State of Uncommitted Changes

### content.js
- `hasSubstantialText()` function (TreeWalker-based text presence check)
- `findPostContainer` uses `hasSubstantialText` instead of `textContent.length`
- Feed-scoped `querySelectorAll` via `[data-virtualized]` parent
- `textContent` in scan loop and 2nd/3rd pass (was `innerText`)
- Scan throttle (2s gap after 150+ posts)
- MutationObserver adaptive debounce (1s after 150+ posts)
- Per-tick gap wake detection (was cumulative drift)
- Scanner wake threshold: 15s (was `SCAN_INTERVAL * 5`)
- Early `closest('[data-fb-scraper-done]')` filter before `findPostContainer`
- Early permalink dedup mirrors `cleanPermalink` (preserves fbid, story_fbid, v)
- Short capture re-processing (skip only if prevLen >= 200)
- Scroll-back suppress threshold: 3 (was 4)
- 5-second scroll-back cooldown after suppression
- Baseline text capture + mid-delay capture at 300ms
- Lazy `extractTimestamp` baseline (only when delay > 0)
- Null-safe baselineTimestamp fallback

### background.js
- In-memory cache for posts and downloadQueue
- Debounced 2-second flush to `chrome.storage.local`
- `flushAll()` on export, GET_POSTS, AUTO_SCROLL_DONE, CLEAR_POSTS

---

## Test Checklist for Next Session
1. First 50 posts: verify all captured correctly with full text
2. Posts 50-150: verify no truncation, scroll-back working
3. Posts 150-250: verify no UI freezing, no false wake detection
4. Posts 250+: verify no tab crash, Facebook UI remains responsive
5. Photo-only posts: verify still captured (3rd pass)
6. Sleep/wake: verify recovery works with new 15s threshold
7. Export: verify sanitized export works, name stripping works

---

## CRITICAL: What Caused the Regression (commit 5e731fd, reverted)

Only 1 post scraped instead of hundreds after applying performance fixes.

**Root cause**: Scoping `querySelectorAll` to the feed container:
```javascript
const feedContainer = document.querySelector('[data-virtualized]');
const scope = (feedContainer && feedContainer.parentElement) || document;
```
Assumed `[data-virtualized]` exists and its `parentElement` is the right scope.
In practice the attribute may not exist, or parentElement may be too narrow — causing nearly all posts to be missed.

**Lesson**: Never change the querySelectorAll scope without verifying the exact DOM structure first in the browser console. The `[data-virtualized]` attribute may only exist on individual feed items, not the container, or may not exist at all depending on page type.

**Safe approach**: Keep `document.querySelectorAll(...)`. Focus optimizations on reducing per-element work (textContent vs innerText, early filters) but do NOT change query scope without DOM verification.
