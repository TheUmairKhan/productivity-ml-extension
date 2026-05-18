import { MessageType, StorageKey } from "./shared/constants.js";
import { SetBlockingRequest } from "./shared/types.js";
import { MessageRouter } from "./shared/message-router.js";
import { isHttpUrl } from "./services/capture.js";
import { predictTab } from "./services/predictor.js";
import * as predictor from "./services/predictor.js";
import * as nativeHost from "./services/native-host.js";

// --- Tab URL tracking (used to populate "back" URL when blocking a navigation) ---

const currentTabUrl = new Map<number, string>();

chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
        if (tab.id !== undefined && tab.url && isHttpUrl(tab.url)) {
            currentTabUrl.set(tab.id, tab.url);
        }
    }
});

chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined && tab.openerTabId !== undefined) {
        const openerUrl = currentTabUrl.get(tab.openerTabId);
        if (openerUrl) currentTabUrl.set(tab.id, openerUrl);
    }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "complete" && tab.url && isHttpUrl(tab.url)) {
        const prev = currentTabUrl.get(tabId);
        currentTabUrl.set(tabId, tab.url);
        predictTab(tabId, tab.url, prev).catch(console.error);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => currentTabUrl.delete(tabId));

// --- Message router ---

const router = new MessageRouter();

predictor.registerHandlers(router);
nativeHost.registerHandlers(router);

router.register(MessageType.GET_BLOCKING, async () => {
    const stored = await chrome.storage.local.get(StorageKey.BLOCKING_ENABLED) as { blocking_enabled?: boolean };
    return { ok: true, blocking_enabled: stored.blocking_enabled ?? false };
});

router.register(MessageType.SET_BLOCKING, async (msg: SetBlockingRequest) => {
    await chrome.storage.local.set({ [StorageKey.BLOCKING_ENABLED]: msg.enabled });
    return { ok: true };
});

router.listen();
