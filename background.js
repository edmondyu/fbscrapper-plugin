let isProcessing = false;
let isPaused = false;

// Serialize post storage writes to prevent race conditions
const postQueue = [];
let isStoringPost = false;

async function drainPostQueue() {
  if (isStoringPost) return;
  isStoringPost = true;
  try {
    while (postQueue.length > 0) {
      const { post, resolve } = postQueue.shift();
      const result = await chrome.storage.local.get({ posts: [] });
      const posts = result.posts;
      const postIndex = posts.length;
      posts.push(post);
      await chrome.storage.local.set({ posts });
      enqueueImages(postIndex, post.images);
      resolve({ ok: true, count: posts.length });
    }
  } finally {
    isStoringPost = false;
  }
}

// Process the download queue one item at a time
async function processQueue() {
  if (isProcessing || isPaused) return;
  isProcessing = true;

  try {
    while (!isPaused) {
      const { downloadQueue = [] } = await chrome.storage.local.get('downloadQueue');
      const next = downloadQueue.find(item => item.status === 'pending');
      if (!next) break;

      // Mark as downloading
      next.status = 'downloading';
      await chrome.storage.local.set({ downloadQueue });

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

      // Persist after each download
      const latest = await chrome.storage.local.get('downloadQueue');
      const queue = latest.downloadQueue || [];
      const idx = queue.findIndex(q => q.url === next.url && q.postIndex === next.postIndex);
      if (idx !== -1) {
        queue[idx] = next;
        await chrome.storage.local.set({ downloadQueue: queue });
      }
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

  const { downloadQueue = [] } = await chrome.storage.local.get('downloadQueue');

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    // Skip if already queued
    if (downloadQueue.some(q => q.url === url)) continue;

    // Determine file extension from URL
    let ext = 'jpg';
    if (url.includes('.png')) ext = 'png';
    else if (url.includes('.webp')) ext = 'webp';
    else if (url.includes('.gif')) ext = 'gif';

    downloadQueue.push({
      postIndex,
      imageIndex: i,
      url,
      filename: `fb-scraper/post-${postIndex}-img-${i}.${ext}`,
      status: 'pending',
    });
  }

  await chrome.storage.local.set({ downloadQueue });
  processQueue();
}

// Record the local filename on the post's localFiles array
async function recordLocalFile(postIndex, imageIndex, filename) {
  const { posts = [] } = await chrome.storage.local.get('posts');
  if (postIndex < posts.length) {
    if (!posts[postIndex].localFiles) {
      posts[postIndex].localFiles = [];
    }
    posts[postIndex].localFiles[imageIndex] = filename;
    await chrome.storage.local.set({ posts });
  }
}

function getDownloadProgress(downloadQueue) {
  const total = downloadQueue.length;
  const completed = downloadQueue.filter(q => q.status === 'done').length;
  const failed = downloadQueue.filter(q => q.status === 'failed').length;
  const downloading = downloadQueue.filter(q => q.status === 'downloading').length;
  const pending = downloadQueue.filter(q => q.status === 'pending').length;
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
    chrome.storage.local.get({ posts: [] }, (result) => {
      const posts = result.posts;
      const idx = posts.findIndex(p => p.permalink && p.permalink === msg.post.permalink);
      if (idx !== -1) {
        posts[idx] = msg.post;
        chrome.storage.local.set({ posts }, () => {
          sendResponse({ ok: true, replaced: true, count: posts.length });
        });
      } else {
        // Permalink not found — treat as new post
        posts.push(msg.post);
        chrome.storage.local.set({ posts }, () => {
          sendResponse({ ok: true, replaced: false, count: posts.length });
        });
      }
    });
    return true;
  }

  if (msg.type === 'GET_POSTS') {
    chrome.storage.local.get({ posts: [] }, (result) => {
      sendResponse({ posts: result.posts });
    });
    return true;
  }

  if (msg.type === 'GET_COUNT') {
    chrome.storage.local.get({ posts: [] }, (result) => {
      sendResponse({ count: result.posts.length });
    });
    return true;
  }

  if (msg.type === 'CLEAR_POSTS') {
    chrome.storage.local.set({ posts: [], downloadQueue: [] }, () => {
      isPaused = false;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'EXPORT_POSTS') {
    chrome.storage.local.get({ posts: [] }, (result) => {
      sendResponse({ posts: result.posts });
    });
    return true;
  }

  if (msg.type === 'AUTO_SCROLL_DONE') {
    chrome.runtime.sendMessage({ type: 'SCROLL_FINISHED' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_DOWNLOAD_PROGRESS') {
    chrome.storage.local.get({ downloadQueue: [] }, (result) => {
      sendResponse(getDownloadProgress(result.downloadQueue));
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
    chrome.storage.local.get({ downloadQueue: [] }, (result) => {
      const queue = result.downloadQueue;
      for (const item of queue) {
        if (item.status === 'failed') {
          item.status = 'pending';
          delete item.error;
        }
      }
      chrome.storage.local.set({ downloadQueue: queue }, () => {
        processQueue();
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});

// On service worker startup, resume any pending downloads
chrome.storage.local.get({ downloadQueue: [] }, (result) => {
  const queue = result.downloadQueue;
  // Reset any items stuck in 'downloading' state (service worker was killed)
  let changed = false;
  for (const item of queue) {
    if (item.status === 'downloading') {
      item.status = 'pending';
      changed = true;
    }
  }
  if (changed) {
    chrome.storage.local.set({ downloadQueue: queue }, () => {
      processQueue();
    });
  } else if (queue.some(q => q.status === 'pending')) {
    processQueue();
  }
});
