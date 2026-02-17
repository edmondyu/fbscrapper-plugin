const countEl = document.getElementById('count');
const toggleBtn = document.getElementById('toggleBtn');
const stopBtn = document.getElementById('stopBtn');
const exportSafeBtn = document.getElementById('exportSafeBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const clearBtn = document.getElementById('clearBtn');
const retryBtn = document.getElementById('retryBtn');
const statusEl = document.getElementById('status');
const dlProgressEl = document.getElementById('dlProgress');
const nameInput = document.getElementById('nameInput');
const saveNameBtn = document.getElementById('saveNameBtn');
const detectNameBtn = document.getElementById('detectNameBtn');
const detectedNameEl = document.getElementById('detectedName');

// Sanitize Facebook CDN URLs by stripping session-specific parameters
const SESSION_PARAMS = [
  '_nc_sid', '_nc_ohc', '_nc_oc', '_nc_gid', 'oh', '_nc_cb',
  '_nc_hash', 'ccb', '_nc_zt', 'cfs'
];

function sanitizeCdnUrl(url) {
  try {
    const u = new URL(url);
    for (const param of SESSION_PARAMS) {
      u.searchParams.delete(param);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function sanitizePosts(posts) {
  return posts.map(post => ({
    ...post,
    images: (post.images || []).map(sanitizeCdnUrl),
    videos: (post.videos || []).map(sanitizeCdnUrl),
  }));
}

// Strip logged-in user's name from post text at export time (safety net)
function stripUserNameFromPosts(posts, userName) {
  if (!userName) return posts;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = userName.split(/\s+/).filter(p => p.length >= 2);
  return posts.map(post => {
    let text = post.postText || '';
    // Remove full name
    text = text.replace(new RegExp(escape(userName), 'gi'), '');
    // Remove individual name parts as standalone lines
    for (const part of parts) {
      text = text.replace(new RegExp(`^${escape(part)}$`, 'gmi'), '');
    }
    // Clean up artifacts
    text = text.replace(/^ +$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim();
    return { ...post, postText: text };
  });
}

// Clean common text artifacts from posts at export time
function cleanPostArtifacts(posts) {
  return posts.map(post => {
    let text = post.postText || '';
    // Strip junk .com/.net/.org domains (Facebook obfuscated short links)
    text = text.replace(/^[a-zA-Z0-9]{2,15}\.(com|net|org)\s*$/gm, '');
    // Strip m.me fragments (Messenger links)
    text = text.replace(/^m\.me\s*$/gm, '');
    // Strip trailing bare numbers (reaction/comment counts that leaked)
    text = text.replace(/(\n\d{1,6}){1,3}\s*$/, '');
    // Strip scrambled sponsored text (randomized alphanumeric gibberish)
    text = text.replace(/^[a-zA-Z0-9][a-zA-Z0-9 \u00a0]{20,}$/gm, '');
    // Strip vertical single-char "Sponsored" spelling
    text = text.replace(/^[a-zA-Z]\n[a-zA-Z]\n[a-zA-Z]\n[a-zA-Z]\n[a-zA-Z](\n[a-zA-Z])*$/gm, '');
    // Strip "May be an image..." junk timestamps
    let ts = post.timestamp || '';
    if (ts.startsWith('May be') || ts.length > 30) ts = '';
    // Clean up
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return { ...post, postText: text, timestamp: ts };
  });
}

// Block-level dedup at export time (catches duplicates missed at scrape time)
function dedupPostText(posts) {
  const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return posts.map(post => {
    let text = post.postText || '';
    const fullNorm = normalize(text);
    if (fullNorm.length <= 40) return post;
    const lines = text.split('\n');
    for (let split = 1; split < lines.length; split++) {
      const firstHalf = lines.slice(0, split).join('\n');
      const secondHalf = lines.slice(split).join('\n');
      const normFirst = normalize(firstHalf);
      const normSecond = normalize(secondHalf);
      if (normFirst.length > 20 && normSecond.length > 20) {
        if (normFirst === normSecond) {
          text = firstHalf.split('\n').length >= secondHalf.split('\n').length ? firstHalf : secondHalf;
          break;
        }
        if (normFirst.includes(normSecond) && normSecond.length > normFirst.length * 0.6) {
          text = firstHalf; break;
        }
        if (normSecond.includes(normFirst) && normFirst.length > normSecond.length * 0.6) {
          text = secondHalf; break;
        }
      }
    }
    return { ...post, postText: text.trim() };
  });
}

let scraping = false;
let hasStartedBefore = false;

function updateCount() {
  chrome.runtime.sendMessage({ type: 'GET_COUNT' }, (res) => {
    if (res) countEl.textContent = res.count;
  });
}

function updateDownloadProgress() {
  chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_PROGRESS' }, (res) => {
    if (!res || res.total === 0) {
      dlProgressEl.textContent = '';
      retryBtn.style.display = 'none';
      return;
    }
    let text = `Images: ${res.completed}/${res.total} downloaded`;
    if (res.failed > 0) {
      text += ` (${res.failed} failed)`;
      retryBtn.style.display = '';
    } else {
      retryBtn.style.display = 'none';
    }
    if (res.downloading > 0) {
      text += ' — downloading...';
    }
    dlProgressEl.textContent = text;
  });
}

function updateToggleButton() {
  if (scraping) {
    toggleBtn.textContent = 'Pause';
    toggleBtn.classList.add('active');
    stopBtn.style.display = '';
  } else if (hasStartedBefore) {
    toggleBtn.textContent = 'Resume';
    toggleBtn.classList.remove('active');
    stopBtn.style.display = '';
  } else {
    toggleBtn.textContent = 'Start';
    toggleBtn.classList.remove('active');
    stopBtn.style.display = 'none';
  }
}

function sendToContentScript(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
        if (chrome.runtime.lastError) {
          statusEl.textContent = 'Navigate to facebook.com first';
        }
        return res;
      });
    }
  });
}

// Toggle scraping
toggleBtn.addEventListener('click', () => {
  scraping = !scraping;
  if (scraping) hasStartedBefore = true;
  updateToggleButton();
  sendToContentScript({ type: 'SET_ACTIVE', active: scraping });
  // Pause/resume downloads directly via background (don't rely on content script relay)
  chrome.runtime.sendMessage({ type: scraping ? 'RESUME_DOWNLOADS' : 'PAUSE_DOWNLOADS' });
  statusEl.textContent = scraping ? 'Scraping active — auto-scrolling...' : 'Paused';
});

// Stop scraping entirely (end session, keep data)
stopBtn.addEventListener('click', () => {
  scraping = false;
  hasStartedBefore = false;
  updateToggleButton();
  sendToContentScript({ type: 'SET_ACTIVE', active: false });
  // Directly pause downloads in background — don't rely on content script relay
  chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOADS' });
  statusEl.textContent = 'Scraping stopped';
});

// Get the effective user name for stripping (manual input takes priority)
function getStripName(callback) {
  chrome.storage.local.get({ loggedInUserName: '', manualStripName: '' }, (stored) => {
    callback(stored.manualStripName || stored.loggedInUserName);
  });
}

// Full export cleaning pipeline: strip name → clean artifacts → dedup
function cleanForExport(posts, userName) {
  let cleaned = stripUserNameFromPosts(posts, userName);
  cleaned = cleanPostArtifacts(cleaned);
  cleaned = dedupPostText(cleaned);
  return cleaned;
}

// Export sanitized posts as JSON (session tokens stripped from URLs)
exportSafeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_POSTS' }, (res) => {
    if (!res || !res.posts || res.posts.length === 0) {
      statusEl.textContent = 'No posts to export';
      return;
    }
    getStripName((userName) => {
      let posts = cleanForExport(res.posts, userName);
      posts = sanitizePosts(posts);
      const blob = new Blob([JSON.stringify(posts, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fb-posts-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = `Exported ${posts.length} posts (JSON)`;
    });
  });
});

// Convert posts array to CSV string
function postsToCSV(posts) {
  const columns = ['author', 'postText', 'timestamp', 'permalink', 'reactions', 'comments', 'images', 'videos', 'scrapedAt'];
  function escapeCSV(value) {
    const str = String(value == null ? '' : value);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }
  const header = columns.map(escapeCSV).join(',');
  const rows = posts.map(post =>
    columns.map(col => {
      const val = post[col];
      if (Array.isArray(val)) return escapeCSV(val.join(' '));
      return escapeCSV(val);
    }).join(',')
  );
  return header + '\n' + rows.join('\n');
}

// Export sanitized posts as CSV
exportCsvBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_POSTS' }, (res) => {
    if (!res || !res.posts || res.posts.length === 0) {
      statusEl.textContent = 'No posts to export';
      return;
    }
    getStripName((userName) => {
      let posts = cleanForExport(res.posts, userName);
      posts = sanitizePosts(posts);
      const csv = postsToCSV(posts);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fb-posts-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = `Exported ${posts.length} posts (CSV)`;
    });
  });
});

// Retry failed downloads
retryBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RETRY_FAILED' }, () => {
    statusEl.textContent = 'Retrying failed downloads...';
  });
});

// Clear all stored posts (confirm() doesn't work in extension popups)
let clearPending = false;
let clearTimer = null;

clearBtn.addEventListener('click', () => {
  if (!clearPending) {
    clearPending = true;
    clearBtn.textContent = 'Confirm Clear?';
    clearBtn.classList.add('btn-confirm');
    clearTimer = setTimeout(() => {
      clearPending = false;
      clearBtn.textContent = 'Clear All';
      clearBtn.classList.remove('btn-confirm');
    }, 3000);
  } else {
    clearTimeout(clearTimer);
    clearPending = false;
    clearBtn.textContent = 'Clear All';
    clearBtn.classList.remove('btn-confirm');
    chrome.runtime.sendMessage({ type: 'CLEAR_POSTS' }, () => {
      updateCount();
      updateDownloadProgress();
      hasStartedBefore = false;
      scraping = false;
      updateToggleButton();
      statusEl.textContent = 'All posts and downloads cleared';
    });
  }
});

// Check current status from content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Navigate to facebook.com to start';
        return;
      }
      if (res) {
        scraping = res.active;
        if (scraping) hasStartedBefore = true;
        updateToggleButton();
        if (scraping) statusEl.textContent = 'Scraping active — auto-scrolling...';
      }
    });
  }
});

// Check if there are existing posts (to show Resume instead of Start)
chrome.runtime.sendMessage({ type: 'GET_COUNT' }, (res) => {
  if (res && res.count > 0) {
    hasStartedBefore = true;
    updateToggleButton();
  }
});

// Listen for auto-scroll completion
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCROLL_FINISHED') {
    statusEl.textContent = 'Auto-scroll finished — no more new posts found';
  }
});

// Name detection and manual override
detectNameBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      statusEl.textContent = 'Navigate to facebook.com first';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'DETECT_NAME' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusEl.textContent = 'Could not detect — make sure you are on facebook.com';
        return;
      }
      if (res.name) {
        detectedNameEl.textContent = res.name;
        chrome.storage.local.set({ loggedInUserName: res.name });
        statusEl.textContent = `Detected: "${res.name}"`;
      } else {
        statusEl.textContent = 'Could not detect name — try refreshing Facebook';
      }
    });
  });
});

saveNameBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  chrome.storage.local.set({ manualStripName: name }, () => {
    statusEl.textContent = name ? `Manual override: "${name}"` : 'Manual override cleared';
  });
});

// Load saved names on popup open
chrome.storage.local.get({ manualStripName: '', loggedInUserName: '' }, (stored) => {
  detectedNameEl.textContent = stored.loggedInUserName || '(not detected yet)';
  nameInput.value = stored.manualStripName || '';
});

// Initial updates
updateCount();
updateDownloadProgress();

// Refresh count and download progress periodically while popup is open
setInterval(() => {
  updateCount();
  updateDownloadProgress();
}, 2000);
