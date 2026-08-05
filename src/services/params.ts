/**
 * Cache of the global parameters served by GET /params.
 *
 * These change roughly weekly and are identical for every user, so the device
 * holds them in chrome.storage.local and refreshes on a slow cadence. Scoring
 * must keep working offline, so a stale cache is always preferred to no cache --
 * a failed refresh is not a failed prediction.
 */

import { API_BASE_URL, PARAMS_REFRESH_MS, StorageKey } from "../shared/constants.js";
import type { GlobalParams } from "../shared/types.js";
import { getGlobalParams } from "./api.js";

interface CachedParams {
    params: GlobalParams;
    fetchedAt: number;
}

export async function getCachedParams(): Promise<GlobalParams | null> {
    const stored = await chrome.storage.local.get(StorageKey.GLOBAL_PARAMS);
    return (stored[StorageKey.GLOBAL_PARAMS] as CachedParams | undefined)?.params ?? null;
}

/**
 * Current parameters, refreshing only when the cache is stale or absent.
 *
 * Returns null only when there is nothing cached *and* the fetch failed -- the
 * one case where the device genuinely cannot score.
 */
export async function ensureParams(force = false): Promise<GlobalParams | null> {
    const stored = await chrome.storage.local.get(StorageKey.GLOBAL_PARAMS);
    const cached = stored[StorageKey.GLOBAL_PARAMS] as CachedParams | undefined;

    const fresh = cached && Date.now() - cached.fetchedAt < PARAMS_REFRESH_MS;
    if (fresh && !force) return cached!.params;

    try {
        const params = await getGlobalParams();
        await chrome.storage.local.set({
            [StorageKey.GLOBAL_PARAMS]: { params, fetchedAt: Date.now() } satisfies CachedParams,
        });
        return params;
    } catch {
        // Offline, signed out, or no active params fitted yet. Keep scoring with
        // whatever we already have.
        return cached?.params ?? null;
    }
}

/**
 * Refitting sigma or z_global invalidates cached predictions, since the same
 * page now scores differently. Callers clear the prediction cache when this
 * reports a change.
 */
export async function paramsVersionChanged(previous: number | undefined): Promise<boolean> {
    const params = await getCachedParams();
    return params !== null && previous !== undefined && params.version !== previous;
}

export { API_BASE_URL };
