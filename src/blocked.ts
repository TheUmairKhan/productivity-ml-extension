import { StorageKey } from "./shared/constants.js";

async function init(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const originalUrl = params.get("url") ?? "";
    const backUrl = params.get("back") ?? "";

    const stored = await chrome.storage.local.get(StorageKey.BLOCKING_ENABLED) as { blocking_enabled?: boolean };
    if (!stored.blocking_enabled && originalUrl) {
        location.replace(originalUrl);
        return;
    }

    const urlEl = document.getElementById("blocked-url");
    if (urlEl) urlEl.textContent = originalUrl;

    document.getElementById("go-back")?.addEventListener("click", () => {
        if (backUrl) {
            location.href = backUrl;
        } else {
            chrome.tabs.update({ url: "chrome://newtab" });
        }
    });

    document.getElementById("proceed")?.addEventListener("click", () => void addToAllowlistAndProceed(originalUrl));
}

async function addToAllowlistAndProceed(originalUrl: string): Promise<void> {
    const data = await chrome.storage.session.get(StorageKey.BLOCK_ALLOWLIST) as { block_allowlist?: string[] };
    const allowlist = data.block_allowlist ?? [];
    allowlist.push(originalUrl);
    await chrome.storage.session.set({ [StorageKey.BLOCK_ALLOWLIST]: allowlist });
    location.href = originalUrl;
}

void init();
