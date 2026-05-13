import { PageLabel, PredictionResult } from "./types.js";
import { isHttpUrl, normalizeUrl, pageCapture, captureHtml } from "./capture.js";
import { sendToLocalHost, queryPageStatus } from "./messaging.js";

// --- Prediction port (persistent connectNative) ---

const PREDICTOR_HOST = "com.predictor";
let port: chrome.runtime.Port | null = null;
const pending = new Map<number, { resolve: (r: PredictionResult) => void; reject: (e: Error) => void }>();
let nextReqId = 0;

function getPort(): chrome.runtime.Port {
    if (!port) {
        port = chrome.runtime.connectNative(PREDICTOR_HOST);
        port.onMessage.addListener((msg) => {
            const cb = pending.get(msg.reqId);
            if (!cb) return;
            pending.delete(msg.reqId);
            if (msg.error) cb.reject(new Error(msg.error));
            else cb.resolve(msg as PredictionResult);
        });
        port.onDisconnect.addListener(() => { port = null; });
    }
    return port;
}

function predictHtml(html: string): Promise<PredictionResult> {
    return new Promise((resolve, reject) => {
        const reqId = nextReqId++;
        pending.set(reqId, { resolve, reject });
        try {
            getPort().postMessage({ type: "predict", reqId, html });
        } catch (e) {
            pending.delete(reqId);
            reject(e as Error);
        }
        setTimeout(() => {
            if (pending.has(reqId)) {
                pending.delete(reqId);
                reject(new Error("Prediction timeout"));
            }
        }, 30_000);
    });
}

async function predictTab(tabId: number, rawUrl: string, prevUrl?: string): Promise<PredictionResult | null> {
    if (!isHttpUrl(rawUrl)) return null;
    const key = "pred:" + normalizeUrl(rawUrl);

    const cached = await chrome.storage.session.get(key);
    let result: PredictionResult;

    if (cached[key]) {
        result = cached[key] as PredictionResult;
    } else {
        const html = await captureHtml(tabId);
        result = await predictHtml(html);
        await chrome.storage.session.set({ [key]: result });

        const text = result.label === "productive" ? "P" : "W";
        const color = result.label === "productive" ? "#0b5" : "#e44";
        chrome.action.setBadgeText({ text, tabId });
        chrome.action.setBadgeBackgroundColor({ color, tabId });
    }

    if (result.label === "waste") {
        const { blocking_enabled = false } = await chrome.storage.local.get("blocking_enabled") as { blocking_enabled?: boolean };
        if (blocking_enabled) {
            const { block_allowlist = [] } = await chrome.storage.session.get("block_allowlist") as { block_allowlist?: string[] };
            const norm = normalizeUrl(rawUrl);
            const isAllowed = (block_allowlist as string[]).some(u => normalizeUrl(u) === norm);
            if (!isAllowed) {
                let blockedUrl = chrome.runtime.getURL("blocked.html") + "?url=" + encodeURIComponent(rawUrl);
                if (prevUrl) blockedUrl += "&back=" + encodeURIComponent(prevUrl);
                chrome.tabs.update(tabId, { url: blockedUrl });
            }
        }
    }

    return result;
}

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type === "LABEL_PAGE") {
            const tabId: number | undefined = msg.tabId;
            const raw_url: string | undefined = msg.raw_url;
            const label: PageLabel | undefined = msg.label;

            if (!tabId || !raw_url || !label) {
                sendResponse({ ok: false, error: "Missing fields." });
                return;
            }

            const capture = await pageCapture(raw_url, tabId, label);
            if (!capture) {
                sendResponse({ ok: false, error: "Capture failed or URL not allowed." });
                return;
            }
            capture.label = label;

            await sendToLocalHost(capture);

            sendResponse({ ok: true });
        } else if (msg?.type === "GET_PAGE_STATUS") {
            const raw_url: string | undefined = msg.raw_url;
            if (!raw_url) {
                sendResponse({ ok: false, label: null, error: "Missing raw_url." });
                return;
            }

            const response = await queryPageStatus(raw_url);
            sendResponse(response);
        } else if (msg?.type === "PREDICT_PAGE") {
            const tabId: number | undefined = msg.tabId;
            const raw_url: string | undefined = msg.raw_url;
            if (!tabId || !raw_url) { sendResponse({ ok: false }); return; }
            const result = await predictTab(tabId, raw_url);
            sendResponse({ ok: true, result });
        } else if (msg?.type === "GET_PREDICTION") {
            const raw_url: string | undefined = msg.raw_url;
            if (!raw_url) { sendResponse({ ok: true, result: null }); return; }
            const key = "pred:" + normalizeUrl(raw_url);
            const stored = await chrome.storage.session.get(key);
            sendResponse({ ok: true, result: stored[key] ?? null });
        } else if (msg?.type === "GET_BLOCKING") {
            const { blocking_enabled = false } = await chrome.storage.local.get("blocking_enabled") as { blocking_enabled?: boolean };
            sendResponse({ ok: true, blocking_enabled });
        } else if (msg?.type === "SET_BLOCKING") {
            const enabled: boolean = msg.enabled ?? false;
            await chrome.storage.local.set({ blocking_enabled: enabled });
            sendResponse({ ok: true });
        }
    })().catch((e) => {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
    });
    return true;
});
