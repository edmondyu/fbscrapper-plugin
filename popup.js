const countEl = document.getElementById('count');
const toggleBtn = document.getElementById('toggleBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');

let scraping = false;

function updateCount() {
  chrome.runtime.sendMessage({ type: 'GET_COUNT' }, (res) => {
    if (res) countEl.textContent = res.count;
  });
}

function updateToggleButton() {
  if (scraping) {
    toggleBtn.textContent = 'Stop Scraping';
    toggleBtn.classList.add('active');
  } else {
    toggleBtn.textContent = 'Start Scraping';
    toggleBtn.classList.remove('active');
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
  updateToggleButton();
  sendToContentScript({ type: 'SET_ACTIVE', active: scraping });
  statusEl.textContent = scraping ? 'Scraping active... scroll to capture posts' : 'Scraping paused';
});

// Export posts as JSON
exportBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_POSTS' }, (res) => {
    if (!res || !res.posts || res.posts.length === 0) {
      statusEl.textContent = 'No posts to export';
      return;
    }
    const blob = new Blob([JSON.stringify(res.posts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fb-posts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Exported ${res.posts.length} posts`;
  });
});

// Clear all stored posts (confirm() doesn't work in extension popups)
let clearPending = false;
let clearTimer = null;

clearBtn.addEventListener('click', () => {
  if (!clearPending) {
    // First click: ask for confirmation
    clearPending = true;
    clearBtn.textContent = 'Confirm Clear?';
    clearBtn.classList.add('btn-confirm');
    // Reset after 3 seconds if not confirmed
    clearTimer = setTimeout(() => {
      clearPending = false;
      clearBtn.textContent = 'Clear All';
      clearBtn.classList.remove('btn-confirm');
    }, 3000);
  } else {
    // Second click: actually clear
    clearTimeout(clearTimer);
    clearPending = false;
    clearBtn.textContent = 'Clear All';
    clearBtn.classList.remove('btn-confirm');
    chrome.runtime.sendMessage({ type: 'CLEAR_POSTS' }, () => {
      updateCount();
      statusEl.textContent = 'All posts cleared';
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
        updateToggleButton();
        if (scraping) statusEl.textContent = 'Scraping active... scroll to capture posts';
      }
    });
  }
});

// Initial count
updateCount();

// Refresh count periodically while popup is open
setInterval(updateCount, 2000);
