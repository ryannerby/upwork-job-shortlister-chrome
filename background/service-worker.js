// Service worker - tab operations and message routing

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openTabs') {
    openTabsStaggered(message.urls);
    sendResponse({ ok: true });
  }
  return true;
});

async function openTabsStaggered(urls) {
  for (let i = 0; i < urls.length; i++) {
    chrome.tabs.create({ url: urls[i], active: i === 0 });
    if (i < urls.length - 1) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
}
