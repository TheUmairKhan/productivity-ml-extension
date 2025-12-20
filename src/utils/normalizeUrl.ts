export function normalizeUrl(rawUrl: string): string {
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