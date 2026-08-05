import { PredictionResult, PredictPageRequest, GetPredictionRequest, PageLabel } from "../shared/types.js";
import { captureHtml, isHttpUrl, normalizeUrl } from "./capture.js";
import { MessageType, StorageKey, predictionCacheKey } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";
import { getToken } from "../shared/session.js";
import { embedHtml } from "./item-tower.js";
import { ensureParams } from "./params.js";
import { addLabel, loadAccumulators, scoreProbability, seedFromServer, userVector } from "./user-tower.js";

function setBadge(tabId: number, label: PageLabel): void {
    const text = label === "productive" ? "P" : "W";
    const color = label === "productive" ? "#0b5" : "#e44";
    chrome.action.setBadgeText({ text, tabId });
    chrome.action.setBadgeBackgroundColor({ color, tabId });
}

/**
 * Score a page with the two towers, entirely on-device.
 *
 * The page HTML is read, encoded and discarded here; nothing about it is sent
 * anywhere. The only network calls in this path are for the global params and
 * the initial accumulator seed, both of which are cached.
 */
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
    let result: PredictionResult | null = (cached[key] as PredictionResult) ?? null;

    const params = await ensureParams();
    if (!params) return null; // never fitted, and nothing cached

    // A params refit changes what the same page scores, so cached verdicts from
    // an older version are stale by definition.
    if (result && result.params_version !== params.version) result = null;

    if (!result) {
        result = await scorePage(tabId, params);
        if (!result) return null;
        await chrome.storage.session.set({ [key]: result });
    }

    setBadge(tabId, result.label);

    if (result.label === "waste") {
        await maybeBlockTab(tabId, rawUrl, prevUrl);
    }

    return result;
}

async function scorePage(
    tabId: number,
    params: Awaited<ReturnType<typeof ensureParams>>,
): Promise<PredictionResult | null> {
    if (!params) return null;
    try {
        const d = params.z_global.length;
        await seedFromServer(d);

        const html = await captureHtml(tabId);
        const zItem = await embedHtml(html, params);
        const zUser = userVector(await loadAccumulators(d), params);
        const { score, probability } = scoreProbability(zUser, zItem, params);

        return {
            label: probability >= params.threshold ? "waste" : "productive",
            p_waste: probability,
            p_productive: 1 - probability,
            score,
            params_version: params.version,
        };
    } catch {
        // Capture is blocked on chrome:// pages, the web store, and PDFs, and the
        // encoder can fail to load. No verdict is the right answer -- guessing
        // here would block pages on nothing.
        return null;
    }
}

/**
 * Fold a user's label into the user tower immediately.
 *
 * Takes the HTML the caller already captured rather than re-reading the tab:
 * labeling happens on the page the user is looking at, and a second capture
 * could return different content.
 *
 * Applied on label rather than on upload, so personalization is immediate and
 * so pages the user never donates still count toward their own vector.
 */
export async function recordLabel(html: string, label: PageLabel): Promise<void> {
    const params = await ensureParams();
    if (!params) return;
    try {
        const d = params.z_global.length;
        await seedFromServer(d);
        await addLabel(await embedHtml(html, params), label);

        // Every cached verdict was computed against the previous user vector.
        const keys = Object.keys(await chrome.storage.session.get(null))
            .filter((k) => k.startsWith("pred:"));
        if (keys.length) await chrome.storage.session.remove(keys);
    } catch {
        // A missed accumulator update costs a little personalization, not
        // correctness -- the label is still staged and the server recomputes.
    }
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
