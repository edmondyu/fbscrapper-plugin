chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NEW_POST') {
    chrome.storage.local.get({ posts: [] }, (result) => {
      const posts = result.posts;
      posts.push(msg.post);
      chrome.storage.local.set({ posts }, () => {
        sendResponse({ ok: true, count: posts.length });
      });
    });
    return true; // async response
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
    chrome.storage.local.set({ posts: [] }, () => {
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
});
