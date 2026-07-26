import { MessageType, StorageKey } from "./shared/constants.js";
import { SetBlockingRequest, SetPomodoro, UploadState } from "./shared/types.js";
import { MessageRouter } from "./shared/message-router.js";
import { isHttpUrl } from "./services/capture.js";
import { predictTab } from "./services/predictor.js";
import * as predictor from "./services/predictor.js";
import * as auth from "./services/auth.js";
import * as donations from "./services/donations.js";
import * as uploader from "./services/uploader.js";
import { resetInFlight } from "./services/staging.js";

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

// --- Recovery after a service-worker restart ---

async function recover(): Promise<void> {
    await resetInFlight();
    const s = await chrome.storage.local.get(StorageKey.UPLOAD_STATE);
    const state = s[StorageKey.UPLOAD_STATE] as UploadState | undefined;
    if (state?.running) {
        await chrome.storage.local.set({
            [StorageKey.UPLOAD_STATE]: { ...state, running: false, currentUrl: undefined },
        });
    }
}

chrome.runtime.onStartup.addListener(() => void recover().catch(console.error));
chrome.runtime.onInstalled.addListener(() => void recover().catch(console.error));

// --- Message router ---

const router = new MessageRouter();

predictor.registerHandlers(router);
auth.registerHandlers(router);
donations.registerHandlers(router);
uploader.registerHandlers(router);

router.register(MessageType.SET_BLOCKING, async (msg: SetBlockingRequest) => {
    await chrome.storage.local.set({ [StorageKey.BLOCKING_ENABLED]: msg.enabled });
    return { ok: true };
});

router.register(MessageType.SET_POMODORO, async (msg: SetPomodoro) => {
    if (msg.enabled && msg.durationMinutes) {
        chrome.alarms.create("pomodoro", { delayInMinutes: msg.durationMinutes });
        await chrome.storage.local.set({
            [StorageKey.POMODORO_ENABLED]: true,
            [StorageKey.BLOCKING_ENABLED]: true,
        });
    } else {
        chrome.alarms.clear("pomodoro");
        await chrome.storage.local.set({
            [StorageKey.POMODORO_ENABLED]: false,
            [StorageKey.BLOCKING_ENABLED]: false,
        });
    }
    return { ok: true };
});

chrome.alarms.onAlarm.addListener(async (alarm: { name: string }) => {
    if (alarm.name === "pomodoro") {
        await chrome.storage.local.set({
            [StorageKey.POMODORO_ENABLED]: false,
            [StorageKey.BLOCKING_ENABLED]: false,
        });
    }
});

router.listen();
