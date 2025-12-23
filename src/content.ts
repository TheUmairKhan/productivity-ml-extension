chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "CAPTURE_HTML") return;

    sendResponse({
        ok: true, 
        html: document.documentElement.outerHTML
    });
});