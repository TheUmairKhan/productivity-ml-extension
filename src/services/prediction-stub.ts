import type { PredictionResult } from "../shared/types.js";

function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Placeholder for the real classifier: a 50/50 coin flip seeded by the normalized URL.
 *
 * Seeding (rather than Math.random) means a given site keeps its verdict across browser
 * restarts, when the chrome.storage.session prediction cache is wiped. Without that, a site
 * allowlisted yesterday flips today and Focus mode looks broken.
 */
export function stubPredict(normalizedUrl: string): PredictionResult {
    const seed = fnv1a(normalizedUrl);
    const label = (seed & 1) === 0 ? "productive" : "waste";
    // Second, decorrelated draw for the confidence, in [0.5, 1).
    const conf = 0.5 + (fnv1a(`c:${normalizedUrl}`) / 0x100000000) * 0.5;
    return {
        label,
        p_productive: label === "productive" ? conf : 1 - conf,
        p_waste: label === "waste" ? conf : 1 - conf,
    };
}
