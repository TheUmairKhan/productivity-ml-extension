import { PredictionResult, PredictPageRequest, GetPredictionRequest } from "../shared/types.js";
import { isHttpUrl, normalizeUrl, captureHtml } from "./capture.js";
import { MessageType, NativeHost, StorageKey, PREDICTION_TIMEOUT_MS, predictionCacheKey } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";

// Persistent native connection to the predictor host
let port: chrome.runtime.Port | null = null;
const pending = new Map<number, { resolve: (r: PredictionResult) => void; reject: (e: Error) => void }>();
let nextReqId = 0;

function getPort(): chrome.runtime.Port {
    if (!port) {
        port = chrome.runtime.connectNative(NativeHost.PREDICTOR);
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
            return;
        }
        setTimeout(() => {
            if (pending.has(reqId)) {
                pending.delete(reqId);
                reject(new Error("Prediction timeout"));
            }
        }, PREDICTION_TIMEOUT_MS);
    });
}

function setBadge(tabId: number, label: "productive" | "waste"): void {
    const text = label === "productive" ? "P" : "W";
    const color = label === "productive" ? "#0b5" : "#e44";
    chrome.action.setBadgeText({ text, tabId });
    chrome.action.setBadgeBackgroundColor({ color, tabId });
}

export async function predictTab(
    tabId: number,
    rawUrl: string,
    prevUrl?: string,
): Promise<PredictionResult | null> {
    if (!isHttpUrl(rawUrl)) return null;

    const key = predictionCacheKey(normalizeUrl(rawUrl));
    const cached = await chrome.storage.session.get(key);
    let result: PredictionResult;

    if (cached[key]) {
        result = cached[key] as PredictionResult;
    } else {
        const html = await captureHtml(tabId);
        result = await predictHtml(html);
        await chrome.storage.session.set({ [key]: result });
        setBadge(tabId, result.label);
    }

    if (result.label === "waste") {
        await maybeBlockTab(tabId, rawUrl, prevUrl);
    }

    return result;
}

async function maybeBlockTab(tabId: number, rawUrl: string, prevUrl?: string): Promise<void> {
    const stored = await chrome.storage.local.get(StorageKey.BLOCKING_ENABLED) as { blocking_enabled?: boolean };
    if (!stored.blocking_enabled) return;

    const { block_allowlist = [] } = await chrome.storage.session.get(StorageKey.BLOCK_ALLOWLIST) as { block_allowlist?: string[] };
    const norm = normalizeUrl(rawUrl);
    const isAllowed = (block_allowlist as string[]).some(u => normalizeUrl(u) === norm);
    if (isAllowed) return;

    let blockedUrl = chrome.runtime.getURL("blocked.html") + "?url=" + encodeURIComponent(rawUrl);
    if (prevUrl) blockedUrl += "&back=" + encodeURIComponent(prevUrl);
    chrome.tabs.update(tabId, { url: blockedUrl });
}

export async function getCachedPrediction(rawUrl: string): Promise<PredictionResult | null> {
    const key = predictionCacheKey(normalizeUrl(rawUrl));
    const stored = await chrome.storage.session.get(key);
    return (stored[key] as PredictionResult) ?? null;
}

export function registerHandlers(router: MessageRouter): void {
    router.register(MessageType.PREDICT_PAGE, async (msg: PredictPageRequest) => {
        const result = await predictTab(msg.tabId, msg.raw_url);
        return { ok: true, result };
    });
    router.register(MessageType.GET_PREDICTION, async (msg: GetPredictionRequest) => {
        const result = await getCachedPrediction(msg.raw_url);
        return { ok: true, result };
    });
}
