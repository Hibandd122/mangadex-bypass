chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "nexus-translate-image",
        title: "Dịch ảnh này (Nexus)",
        contexts: ["image"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "nexus-translate-image") {
        chrome.tabs.sendMessage(tab.id, { action: "translate_single", srcUrl: info.srcUrl });
    }
});
