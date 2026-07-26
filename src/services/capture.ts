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

