/**
 * The item tower, on-device.
 *
 * HTML -> extractor -> ONNX encoder -> z_raw -> preprocess -> z_i.
 *
 * The encoder graph is frozen and the preprocessing is applied outside it, so
 * refitting sigma weekly is a params push rather than a new model export.
 *
 * Everything is loaded lazily and cached for the life of the service worker.
 * MV3 tears workers down aggressively, so this reloads more often than it looks;
 * the ORT session is the expensive part and is created at most once per worker.
 */

import * as ort from "onnxruntime-web";

import { htmlToIndices } from "./extractor.js";
import type { EntityTables, ExtractorConfig, GlobalParams } from "../shared/types.js";

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let configPromise: Promise<{
    cfg: ExtractorConfig;
    tables: EntityTables;
    token2idx: Record<string, number>;
}> | null = null;

async function fetchAsset<T>(name: string): Promise<T> {
    const res = await fetch(chrome.runtime.getURL(`assets/${name}`));
    if (!res.ok) throw new Error(`missing asset ${name} (${res.status})`);
    return res.json() as Promise<T>;
}

async function loadConfig() {
    const [rawCfg, rawEntities, token2idx] = await Promise.all([
        fetchAsset<any>("extractor-config.json"),
        fetchAsset<any>("entities.json"),
        fetchAsset<Record<string, number>>("token2idx.json"),
    ]);

    const cfg: ExtractorConfig = {
        max_tokens: rawCfg.max_tokens,
        tag_to_idx: rawCfg.tag_to_idx,
        innertext_tags: new Set(rawCfg.innertext_tags),
        exclude_tags: new Set(rawCfg.exclude_tags),
        void_elements: new Set(rawCfg.void_elements),
        meta_names: new Set(rawCfg.meta_names),
        cdata_elements: new Set(rawCfg.cdata_elements),
    };
    const tables: EntityTables = {
        html5: rawEntities.html5,
        invalid_charrefs: rawEntities.invalid_charrefs,
        invalid_codepoints: new Set<number>(rawEntities.invalid_codepoints),
    };
    return { cfg, tables, token2idx };
}

function getConfig() {
    return (configPromise ??= loadConfig());
}

function getSession(): Promise<ort.InferenceSession> {
    return (sessionPromise ??= (async () => {
        // The WASM binaries ship in the extension package; without this ORT tries
        // to fetch them from a CDN, which the extension CSP blocks.
        ort.env.wasm.wasmPaths = chrome.runtime.getURL("assets/ort/");
        ort.env.wasm.numThreads = 1; // no cross-origin isolation in a service worker
        return ort.InferenceSession.create(chrome.runtime.getURL("assets/jfcnn.onnx"), {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
        });
    })());
}

/**
 * Divide by sigma, then L2 normalize.
 *
 * Rescaling makes the dimensions comparable before the dot product; normalizing
 * puts every page on the unit sphere so a page cannot dominate a centroid by
 * norm alone. Must match preprocess() in backend/preprocessing.py.
 */
export function preprocess(zRaw: Float32Array, sigma: number[]): Float32Array {
    const z = new Float32Array(zRaw.length);
    let norm = 0;
    for (let i = 0; i < zRaw.length; i++) {
        z[i] = zRaw[i] / sigma[i];
        norm += z[i] * z[i];
    }
    norm = Math.max(Math.sqrt(norm), 1e-12);
    for (let i = 0; i < z.length; i++) z[i] /= norm;
    return z;
}

/** Raw HTML -> z_i, ready to dot with the user vector. */
export async function embedHtml(html: string, params: GlobalParams): Promise<Float32Array> {
    const { cfg, tables, token2idx } = await getConfig();
    const { wordIdx, tagIdx } = htmlToIndices(html, token2idx, cfg, tables);

    const session = await getSession();
    const dims = [1, cfg.max_tokens];
    const output = await session.run({
        word_idx: new ort.Tensor("int64", wordIdx, dims),
        tag_idx: new ort.Tensor("int64", tagIdx, dims),
    });

    const zRaw = output["z_raw"].data as Float32Array;
    return preprocess(zRaw, params.sigma);
}

/** Drops the cached session, e.g. after the encoder asset is replaced. */
export function resetItemTower(): void {
    sessionPromise = null;
    configPromise = null;
}
