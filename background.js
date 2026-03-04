let isProcessing = false;
let isPaused = false;

// ── In-memory cache ──────────────────────────────────────────────────
// Posts and downloadQueue are kept in memory to avoid per-post
// read-modify-write cycles on chrome.storage.local.  Storage is
// flushed on a debounced timer (every 2 seconds after last change)
// so that even 200+ posts don't degrade performance.
let _posts = null;           // null = not yet loaded
let _downloadQueue = null;   // null = not yet loaded
let _postsFlushTimer = null;
let _queueFlushTimer = null;
const FLUSH_DELAY = 2000;    // ms after last change before writing to storage

async function getPosts() {
  if (_posts === null) {
    const result = await chrome.storage.local.get({ posts: [] });
    _posts = result.posts;
  }
  return _posts;
}

async function getDownloadQueue() {
  if (_downloadQueue === null) {
    const result = await chrome.storage.local.get({ downloadQueue: [] });
    _downloadQueue = result.downloadQueue;
  }
  return _downloadQueue;
}

function schedulePostsFlush() {
  if (_postsFlushTimer) clearTimeout(_postsFlushTimer);
  _postsFlushTimer = setTimeout(() => {
    _postsFlushTimer = null;
    if (_posts !== null) {
      chrome.storage.local.set({ posts: _posts });
    }
  }, FLUSH_DELAY);
}

function scheduleQueueFlush() {
  if (_queueFlushTimer) clearTimeout(_queueFlushTimer);
  _queueFlushTimer = setTimeout(() => {
    _queueFlushTimer = null;
    if (_downloadQueue !== null) {
      chrome.storage.local.set({ downloadQueue: _downloadQueue });
    }
  }, FLUSH_DELAY);
}

async function flushAll() {
  if (_postsFlushTimer) { clearTimeout(_postsFlushTimer); _postsFlushTimer = null; }
  if (_queueFlushTimer) { clearTimeout(_queueFlushTimer); _queueFlushTimer = null; }
  const writes = {};
  if (_posts !== null) writes.posts = _posts;
  if (_downloadQueue !== null) writes.downloadQueue = _downloadQueue;
  if (Object.keys(writes).length > 0) {
    await chrome.storage.local.set(writes);
  }
}

// ── Post queue (serialize writes to in-memory array) ─────────────────
const postQueue = [];
let isStoringPost = false;

async function drainPostQueue() {
  if (isStoringPost) return;
  isStoringPost = true;
  try {
    const posts = await getPosts();
    while (postQueue.length > 0) {
      const { post, resolve } = postQueue.shift();
      const postIndex = posts.length;
      posts.push(post);
      enqueueImages(postIndex, post.images);
      resolve({ ok: true, count: posts.length });
    }
    schedulePostsFlush();
  } finally {
    isStoringPost = false;
  }
}

// ── Download queue processing ────────────────────────────────────────
async function processQueue() {
  if (isProcessing || isPaused) return;
  isProcessing = true;

  try {
    const queue = await getDownloadQueue();
    while (!isPaused) {
      const next = queue.find(item => item.status === 'pending');
      if (!next) break;

      // Mark as downloading
      next.status = 'downloading';
      scheduleQueueFlush();

      try {
        await downloadFile(next.url, next.filename);
        next.status = 'done';
        // Record the local filename on the post object
        await recordLocalFile(next.postIndex, next.imageIndex, next.filename);
      } catch (err) {
        console.error('[FB Scraper] Download failed:', next.filename, err);
        next.status = 'failed';
        next.error = err.message || String(err);
      }

      scheduleQueueFlush();
    }
  } finally {
    isProcessing = false;
  }
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!downloadId) {
          reject(new Error('Download failed to start'));
          return;
        }

        // Listen for completion
        function onChanged(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(onChanged);
              resolve();
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(onChanged);
              reject(new Error(delta.error?.current || 'Download interrupted'));
            }
          }
        }
        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
  });
}

// Enqueue images from a post for download
async function enqueueImages(postIndex, images) {
  if (!images || images.length === 0) return;

  const queue = await getDownloadQueue();
  const { downloadFolder = 'fb-scraper' } = await chrome.storage.local.get('downloadFolder');
  const folder = downloadFolder || 'fb-scraper';

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    // Skip if already queued
    if (queue.some(q => q.url === url)) continue;

    // Determine file extension from URL
    let ext = 'jpg';
    if (url.includes('.png')) ext = 'png';
    else if (url.includes('.webp')) ext = 'webp';
    else if (url.includes('.gif')) ext = 'gif';

    queue.push({
      postIndex,
      imageIndex: i,
      url,
      filename: `${folder}/post-${postIndex}-img-${i}.${ext}`,
      status: 'pending',
    });
  }

  scheduleQueueFlush();
  processQueue();
}

// Record the local filename on the post's localFiles array
async function recordLocalFile(postIndex, imageIndex, filename) {
  const posts = await getPosts();
  if (postIndex < posts.length) {
    if (!posts[postIndex].localFiles) {
      posts[postIndex].localFiles = [];
    }
    posts[postIndex].localFiles[imageIndex] = filename;
    schedulePostsFlush();
  }
}

function getDownloadProgress(queue) {
  const total = queue.length;
  const completed = queue.filter(q => q.status === 'done').length;
  const failed = queue.filter(q => q.status === 'failed').length;
  const downloading = queue.filter(q => q.status === 'downloading').length;
  const pending = queue.filter(q => q.status === 'pending').length;
  return { total, completed, failed, downloading, pending };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NEW_POST') {
    new Promise((resolve) => {
      postQueue.push({ post: msg.post, resolve });
      drainPostQueue();
    }).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'REPLACE_POST') {
    // Replace a previously captured truncated post with an expanded version
    getPosts().then((posts) => {
      // Strategy 1: match by permalink
      let idx = -1;
      if (msg.post.permalink) {
        idx = posts.findIndex(p => p.permalink && p.permalink === msg.post.permalink);
      }
      // Strategy 2: match by author + text prefix (for posts without unique permalink)
      if (idx === -1 && msg.matchPrefix && msg.matchAuthor) {
        idx = posts.findIndex(p =>
          p.author === msg.matchAuthor &&
          p.postText && p.postText.substring(0, msg.matchPrefix.length) === msg.matchPrefix
        );
      }
      if (idx !== -1) {
        posts[idx] = msg.post;
        schedulePostsFlush();
        sendResponse({ ok: true, replaced: true, count: posts.length });
      } else {
        // Match not found — treat as new post
        posts.push(msg.post);
        schedulePostsFlush();
        sendResponse({ ok: true, replaced: false, count: posts.length });
      }
    });
    return true;
  }

  if (msg.type === 'GET_POSTS') {
    // Flush first so popup always sees up-to-date data
    flushAll().then(() => {
      getPosts().then((posts) => {
        sendResponse({ posts });
      });
    });
    return true;
  }

  if (msg.type === 'GET_COUNT') {
    getPosts().then((posts) => {
      sendResponse({ count: posts.length });
    });
    return true;
  }

  if (msg.type === 'CLEAR_POSTS') {
    _posts = [];
    _downloadQueue = [];
    isPaused = false;
    chrome.storage.local.set({ posts: [], downloadQueue: [] }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'EXPORT_POSTS') {
    // Flush to storage before export to ensure consistency
    flushAll().then(() => {
      getPosts().then((posts) => {
        sendResponse({ posts });
      });
    });
    return true;
  }

  if (msg.type === 'AUTO_SCROLL_DONE') {
    // Scraping stopped — flush in-memory data to storage immediately
    // so nothing is lost if the service worker is terminated
    flushAll().then(() => {
      chrome.runtime.sendMessage({ type: 'SCROLL_FINISHED' }).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'GET_DOWNLOAD_PROGRESS') {
    getDownloadQueue().then((queue) => {
      sendResponse(getDownloadProgress(queue));
    });
    return true;
  }

  if (msg.type === 'PAUSE_DOWNLOADS') {
    isPaused = true;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RESUME_DOWNLOADS') {
    isPaused = false;
    processQueue();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RETRY_FAILED') {
    getDownloadQueue().then((queue) => {
      for (const item of queue) {
        if (item.status === 'failed') {
          item.status = 'pending';
          delete item.error;
        }
      }
      scheduleQueueFlush();
      processQueue();
      sendResponse({ ok: true });
    });
    return true;
  }
});

// On service worker startup, resume any pending downloads
getDownloadQueue().then((queue) => {
  let changed = false;
  for (const item of queue) {
    if (item.status === 'downloading') {
      item.status = 'pending';
      changed = true;
    }
  }
  if (changed) {
    scheduleQueueFlush();
  }
  if (queue.some(q => q.status === 'pending')) {
    processQueue();
  }
});
