import { PageCapture, PageLabel } from "./types";

function normalizeUrl(rawUrl: string): string {
    let url: URL
    try {
        url = new URL(rawUrl);
    } catch {
        return rawUrl;
    }

    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    url.hash = "";

    const dropExact = new Set([
    "gclid", "dclid", "gbraid", "wbraid",
    "fbclid", "msclkid", "twclid", "igshid", "ttclid", "li_fat_id",
    "mc_cid", "mc_eid", "mkt_tok", "oly_anon_id", "oly_enc_id", "_hsenc", "_hsmi",
    "referrer", "spm", "scid", "s_kwcid",
    ]);

    const params = url.searchParams;
    params.forEach((_, key) => {
        const k = key.toLowerCase();
        if (k.startsWith("utm_") || dropExact.has(k)) {
            params.delete(key);
        }
    });

    const path = url.pathname || "/";
    const query = params.toString()

    return query ? `${host}${path}?${query}` : `${host}${path}`;
}


function isoNowUtc(): string {
    return new Date().toISOString();
}


async function captureHtml(tabId: number): Promise<string | null> {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "CAPTURE_HTML",
      });
  
      if (resp?.ok && typeof resp.html === "string") {
        return resp.html;
      }
    } catch {
      // content script not injected / not allowed
    }
  
    return null;
  }
  


async function captureScreenshot(): Promise<string | null> {
    try {
        const screenshot = await chrome.tabs.captureVisibleTab({format: 'png'});
        return screenshot
    } catch (error) {
        console.error('Screenshot failed:', error);
        return null;
    }
}


function isHttpUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }
  

async function pageCapture(raw_url: string, tabId: number): Promise<PageCapture | null> {
    if (!isHttpUrl(raw_url)) return null;
    const url = normalizeUrl(raw_url);
    const date = isoNowUtc();
    const [html, screenshot] = await Promise.all([
        captureHtml(tabId),
        captureScreenshot()
    ]);

    const capture: PageCapture = {
        raw_url,
        url,
        label: "skip",
      };
      if (html) capture.html = html;
      if (screenshot) capture.screenshot = screenshot;

    return capture;
}


async function storeCapture(capture: PageCapture): Promise<void> {
    const key = `capture:${capture.url}`;
    await chrome.storage.local.set({ [key]: capture });
}


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type !== "LABEL_PAGE") return;

        const tabId: number | undefined = msg.tabId;
        const raw_url: string | undefined = msg.raw_url;
        const label: PageLabel | undefined = msg.label;

        if (!tabId || !raw_url || !label) {
            sendResponse({ ok: false, error: "Missing fields." });
            return;
        }

        const capture = await pageCapture(raw_url, tabId);
        if (!capture) {
            sendResponse({ ok: false, error: "Capture failed or URL not allowed." });
            return;
        }
        
        capture.label = label;

        await storeCapture(capture);

        sendResponse( { ok: true} )
    })().catch((e) => {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
    });
    return true;
});