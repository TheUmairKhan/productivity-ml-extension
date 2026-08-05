/**
 * The user tower: four running accumulators and a shrinkage rule.
 *
 * There is no model here and nothing to train. A new label costs one vector add
 * and one increment, which is the whole reason personalization can be immediate
 * and local -- no retraining anywhere in this path.
 *
 * Port of the reference implementation in backend/preprocessing.py; the two must
 * agree, since the server fits kappa against the same formula.
 */

import { StorageKey } from "../shared/constants.js";
import type { GlobalParams, PageLabel, UserAccumulators } from "../shared/types.js";
import { getUserEmbeddings } from "./api.js";

/** Positive = "waste" = block, matching LABEL_TO_IDX in models/config.py. */
function isPositive(label: PageLabel): boolean {
    return label === "waste";
}

function zeros(d: number): number[] {
    return new Array(d).fill(0);
}

export function emptyAccumulators(d: number): UserAccumulators {
    return { s_pos: zeros(d), n_pos: 0, s_neg: zeros(d), n_neg: 0 };
}

export async function loadAccumulators(d: number): Promise<UserAccumulators> {
    const stored = await chrome.storage.local.get(StorageKey.USER_ACCUMULATORS);
    const acc = stored[StorageKey.USER_ACCUMULATORS] as UserAccumulators | undefined;
    if (!acc || acc.s_pos?.length !== d || acc.s_neg?.length !== d) {
        return emptyAccumulators(d);
    }
    return acc;
}

async function saveAccumulators(acc: UserAccumulators): Promise<void> {
    await chrome.storage.local.set({ [StorageKey.USER_ACCUMULATORS]: acc });
}

/** O(1) update. z must already be preprocessed (divided by sigma, L2 normalized). */
export async function addLabel(z: Float32Array, label: PageLabel): Promise<void> {
    const acc = await loadAccumulators(z.length);
    const sum = isPositive(label) ? acc.s_pos : acc.s_neg;
    for (let i = 0; i < z.length; i++) sum[i] += z[i];
    if (isPositive(label)) acc.n_pos++;
    else acc.n_neg++;
    await saveAccumulators(acc);
}

/**
 * Seed the accumulators from the server's class centroids.
 *
 * A centroid times its count is the sum that produced it, which is why
 * GET /users/me/embeddings returns the counts. Without this a reinstall or a
 * second device would start cold even though the server knows better.
 *
 * Only seeds when local state is empty: the device is authoritative once it has
 * labels of its own, because it also counts pages the user never donated.
 */
export async function seedFromServer(d: number): Promise<boolean> {
    const acc = await loadAccumulators(d);
    if (acc.n_pos > 0 || acc.n_neg > 0) return false;

    const remote = await getUserEmbeddings();
    if (remote.n_productive === 0 && remote.n_waste === 0) return false;

    const seeded = emptyAccumulators(d);
    if (remote.waste && remote.n_waste > 0) {
        seeded.s_pos = remote.waste.map((v) => v * remote.n_waste);
        seeded.n_pos = remote.n_waste;
    }
    if (remote.productive && remote.n_productive > 0) {
        seeded.s_neg = remote.productive.map((v) => v * remote.n_productive);
        seeded.n_neg = remote.n_productive;
    }
    await saveAccumulators(seeded);
    return true;
}

/**
 * z_u = w*(mean_pos - mean_neg) + (1-w)*z_global
 *
 * w uses the harmonic effective count, the right sample size for a difference of
 * two means and zero whenever either class is empty. So a user with no labels
 * and a user who has only ever labeled one way both collapse to exactly
 * z_global -- the global classifier -- with no special-casing.
 */
export function userVector(acc: UserAccumulators, params: GlobalParams): Float32Array {
    const d = params.z_global.length;
    const z = new Float32Array(d);

    if (acc.n_pos <= 0 || acc.n_neg <= 0) {
        z.set(params.z_global);
        return z;
    }

    const nEff = (2 * acc.n_pos * acc.n_neg) / (acc.n_pos + acc.n_neg);
    const w = nEff / (nEff + params.kappa);
    for (let i = 0; i < d; i++) {
        const delta = acc.s_pos[i] / acc.n_pos - acc.s_neg[i] / acc.n_neg;
        z[i] = w * delta + (1 - w) * params.z_global[i];
    }
    return z;
}

/** Dot the towers and calibrate. Returns P(block). */
export function scoreProbability(
    zUser: Float32Array,
    zItem: Float32Array,
    params: GlobalParams,
): { score: number; probability: number } {
    let s = 0;
    for (let i = 0; i < zItem.length; i++) s += zUser[i] * zItem[i];
    return { score: s, probability: 1 / (1 + Math.exp(-(params.a * s + params.b))) };
}

export async function resetAccumulators(): Promise<void> {
    await chrome.storage.local.remove(StorageKey.USER_ACCUMULATORS);
}
