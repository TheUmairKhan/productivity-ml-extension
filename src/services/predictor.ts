import { PredictionResult, PredictPageRequest, GetPredictionRequest } from "../shared/types.js";
import { isHttpUrl, normalizeUrl } from "./capture.js";
import { MessageType, StorageKey, predictionCacheKey } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";
import { getToken } from "../shared/session.js";
import { stubPredict } from "./prediction-stub.js";

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

    // Prediction only starts once the user is signed in.
    if (!(await getToken())) return null;

    const normalized = normalizeUrl(rawUrl);
    const key = predictionCacheKey(normalized);
    const cached = await chrome.storage.session.get(key);
    let result: PredictionResult;

    if (cached[key]) {
        result = cached[key] as PredictionResult;
    } else {
        result = stubPredict(normalized);
        await chrome.storage.session.set({ [key]: result });
    }

    setBadge(tabId, result.label);

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
