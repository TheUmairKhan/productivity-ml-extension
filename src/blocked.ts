export {};

const params = new URLSearchParams(location.search);
const originalUrl = params.get("url") ?? "";
const backUrl = params.get("back") ?? "";

void (async () => {
    const { blocking_enabled = false } = await chrome.storage.local.get("blocking_enabled") as { blocking_enabled?: boolean };
    if (!blocking_enabled && originalUrl) {
        location.replace(originalUrl);
    }
})();

const urlEl = document.getElementById("blocked-url");
if (urlEl) urlEl.textContent = originalUrl;

document.getElementById("go-back")?.addEventListener("click", () => {
    if (backUrl) {
        location.href = backUrl;
    } else {
        chrome.tabs.update({ url: "chrome://newtab" });
    }
});

document.getElementById("proceed")?.addEventListener("click", () => {
    void (async () => {
        const data = await chrome.storage.session.get("block_allowlist") as { block_allowlist?: string[] };
        const allowlist = data.block_allowlist ?? [];
        allowlist.push(originalUrl);
        await chrome.storage.session.set({ block_allowlist: allowlist });
        location.href = originalUrl;
    })();
});
