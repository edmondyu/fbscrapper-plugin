# Facebook Photo-Only Post DOM Structure Notes

## Context
The 4th post on https://www.facebook.com/lammiuyan is a photo-only post (no text, just one image).
This post is invisible to the main scraper scan because it has no `dir="auto"` text elements
other than "Facebook" anti-scraping padding.

## DOM Hierarchy (outside-in)
```
div > div > div.x1yztbdb > div.x1n2onr6 > div > div > div.x1a2a7pz
  > div.x78zum5[data-virtualized="false"]     ← feed container wrapper
    > div.x9f619                               ← feed item wrapper
      > div (card with border-radius style)    ← visual card
        > div                                  ← THE POST CONTAINER (20+ direct children)
```

## Post Container Direct Children
1. Empty `<div></div>` (first child)
2. ~20x `<div aria-hidden="true" data-0="0" ... data-19="19">` — anti-scraping padding
   - Each contains: `<blockquote><span dir="auto"><span>Facebook</span></span></blockquote>`
   - Each also has a hidden `role="button" tabindex="-1"` div
3. Nested `<div>` wrappers leading to actual post content (author, photo, actions)

## Author Section
- `<h2>` heading with text "林妙茵Miu" — EXISTS within the post container
- Author name link: `<a href="https://www.facebook.com/lammiuyan?__cft__...">` with `role="link"`
- Author name span uses `dir="ltr"` (NOT `dir="auto"`)
- `aria-label="林妙茵Miu"` on the profile link
- `data-ad-rendering-role="profile_name"` on container div

## Profile Picture
- Rendered as SVG: `<svg><image xlink:href="https://scontent-...jpg" /></svg>`
- NOT an HTML `<img>` tag — `img[src*="scontent"]` selector does NOT match
- Size: 40x40px

## Post Permalink
- `/posts/pfbid0XFRTkbmY5fwxBEqx3ZEqk7PxbeQD4tJj652Q5LbWKHVv6RNL4Vpxucxbyz7mrLnal`
- Also has a `/photo/?fbid=1285758803603882` link (for the photo itself)

## Obfuscated "Sponsored" Label
- Individual `<span>` elements each containing a single character
- Uses CSS class-based obfuscation to visually spell "Sponsored"
- Characters: s, S, p, d, t, e, r, n, o, etc. in separate spans
- Has scrambled decoy characters mixed in (digits, letters)

## Why Main Scan Misses This Post
1. All `dir="auto"` elements contain text "Facebook" → filtered at line 640
2. Author name uses `dir="ltr"` → not in `allDirAuto` query results
3. No substantial text (>= 8 chars) in any `dir="auto"` element besides "Facebook"

## Key Selectors That DO Work
- `container.querySelector('h2')` → finds author heading
- `container.querySelector('a[href*="/posts/"]')` → finds permalink
- `container.querySelector('[aria-hidden="true"] blockquote')` → finds anti-scraping padding

## Key Selectors That DO NOT Work
- `container.querySelector('img[src*="scontent"]')` → profile pic is SVG `<image>`, not `<img>`
- `container.querySelectorAll('div[dir="auto"]')` → only returns "Facebook" padding spans
