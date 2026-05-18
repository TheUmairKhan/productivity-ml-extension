import { PageCapture, PageLabel } from "../shared/types.js";

// Tracking and analytics params stripped during normalization
const TRACKING_PARAMS = new Set([
    "gclid", "dclid", "gbraid", "wbraid",
    "fbclid", "msclkid", "twclid", "igshid", "ttclid", "li_fat_id",
    "mc_cid", "mc_eid", "mkt_tok", "oly_anon_id", "oly_enc_id", "_hsenc", "_hsmi",
    "referrer", "spm", "scid", "s_kwcid",
]);

export function normalizeUrl(rawUrl: string): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return rawUrl;
    }

    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    url.hash = "";

    const params = url.searchParams;
    params.forEach((_, key) => {
        const k = key.toLowerCase();
        if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) {
            params.delete(key);
        }
    });

    const path = url.pathname || "/";
    const query = params.toString();

    return query ? `${host}${path}?${query}` : `${host}${path}`;
}

export function isHttpUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

export async function captureHtml(tabId: number): Promise<string> {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML,
    });
    const html = results[0]?.result as string | undefined;
    if (!html) throw new Error("HTML capture failed.");
    return html;
}

async function captureScreenshot(): Promise<string> {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 80 });
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) throw new Error("Screenshot capture failed (unexpected data URL format).");
    const base64 = dataUrl.slice(commaIdx + 1);
    if (!base64) throw new Error("Screenshot capture failed (empty base64).");
    return base64;
}

export async function pageCapture(raw_url: string, tabId: number, label: PageLabel): Promise<PageCapture | null> {
    if (!isHttpUrl(raw_url)) return null;
    const url = normalizeUrl(raw_url);
    const captured_at = new Date().toISOString();
    const [html, screenshot] = await Promise.all([captureHtml(tabId), captureScreenshot()]);
    return { raw_url, url, html, screenshot, captured_at, label };
}
