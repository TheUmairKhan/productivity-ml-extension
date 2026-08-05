/**
 * End-to-end item tower: HTML -> extractor -> ONNX, against Python -> PyTorch.
 *
 * The other suites each pin one link (extractor vs html.parser, ONNX graph vs
 * PyTorch). This pins the chain, which is where wiring mistakes live: index
 * dtype, padding, truncation, tensor layout. If this passes, a page embeds to
 * the same vector on-device as it does in the fitting job -- which is the whole
 * premise the shipped sigma, z_global and calibration rest on.
 *
 * Skips unless assets/ has been generated (models/export_onnx.py then
 * models/export_client_assets.py).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web";

import { htmlToIndices } from "../src/services/extractor.js";
import { preprocess } from "../src/services/item-tower.js";
import type { EntityTables, ExtractorConfig } from "../src/shared/types.js";

const ROOT = join(import.meta.dirname, "..");
const ONNX = join(ROOT, "assets/jfcnn.onnx");
const FIXTURES = join(ROOT, "tests/fixtures/embedding-cases.json");

const ready = existsSync(ONNX) && existsSync(FIXTURES);

// float32 through the wasm backend vs PyTorch on the same weights; the export
// gate itself measured 1.2e-6, and the fixtures are rounded to 6 decimals.
const TOL = 1e-4;

describe.skipIf(!ready)("item tower end-to-end parity", () => {
    let session: ort.InferenceSession;
    let cfg: ExtractorConfig;
    let tables: EntityTables;
    let token2idx: Record<string, number>;
    let fixtures: any;

    beforeAll(async () => {
        const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf-8"));
        const rawCfg = readJson("assets/extractor-config.json");
        const rawEntities = readJson("assets/entities.json");
        token2idx = readJson("assets/token2idx.json");
        fixtures = readJson("tests/fixtures/embedding-cases.json");

        cfg = {
            max_tokens: rawCfg.max_tokens,
            tag_to_idx: rawCfg.tag_to_idx,
            innertext_tags: new Set(rawCfg.innertext_tags),
            exclude_tags: new Set(rawCfg.exclude_tags),
            void_elements: new Set(rawCfg.void_elements),
            meta_names: new Set(rawCfg.meta_names),
            cdata_elements: new Set(rawCfg.cdata_elements),
        };
        tables = {
            html5: rawEntities.html5,
            invalid_charrefs: rawEntities.invalid_charrefs,
            invalid_codepoints: new Set<number>(rawEntities.invalid_codepoints),
        };

        session = await ort.InferenceSession.create(readFileSync(ONNX), {
            executionProviders: ["wasm"],
        });
    }, 120_000);

    it("exposes the expected graph signature", () => {
        // Copy before sorting: session.inputNames is the live array ORT uses to
        // map feed names onto input slots, and sorting it in place silently
        // swaps word_idx and tag_idx for every later run() on this session.
        expect([...session.inputNames].sort()).toEqual(["tag_idx", "word_idx"]);
        expect([...session.outputNames]).toEqual(["z_raw"]);
    });

    it("indexes tokens identically to Python", () => {
        for (const c of fixtures.cases) {
            const { wordIdx, tagIdx } = htmlToIndices(c.html, token2idx, cfg, tables);
            expect([...wordIdx.slice(0, 24)].map(Number), c.name).toEqual(c.word_idx_head);
            expect([...tagIdx.slice(0, 24)].map(Number), c.name).toEqual(c.tag_idx_head);

            const nonZero = [...wordIdx].filter((v) => v !== 0n).length;
            expect(nonZero, c.name).toBe(c.n_tokens);
        }
    });

    it("truncates at max_tokens", () => {
        const c = fixtures.cases.find((c: any) => c.name === "truncation");
        const { wordIdx } = htmlToIndices(c.html, token2idx, cfg, tables);
        expect(wordIdx.length).toBe(fixtures.max_tokens);
        expect(c.n_tokens).toBe(fixtures.max_tokens);
    });

    it("embeds every fixture to the same vector as PyTorch", async () => {
        for (const c of fixtures.cases) {
            const { wordIdx, tagIdx } = htmlToIndices(c.html, token2idx, cfg, tables);
            const dims = [1, cfg.max_tokens];
            const out = await session.run({
                word_idx: new ort.Tensor("int64", wordIdx, dims),
                tag_idx: new ort.Tensor("int64", tagIdx, dims),
            });

            const actual = out["z_raw"].data as Float32Array;
            expect(actual.length, c.name).toBe(fixtures.dim);

            let maxAbs = 0;
            for (let i = 0; i < actual.length; i++) {
                maxAbs = Math.max(maxAbs, Math.abs(actual[i] - c.z_raw[i]));
            }
            expect(maxAbs, `${c.name}: max|ts - py| = ${maxAbs}`).toBeLessThan(TOL);
        }
    }, 120_000);

    it("preprocessing yields unit vectors for real embeddings", async () => {
        const c = fixtures.cases[0];
        const sigma = new Array(fixtures.dim).fill(1).map((_, i) => 0.5 + (i % 7) * 0.1);
        const z = preprocess(Float32Array.from(c.z_raw), sigma);
        expect(Math.abs(Math.hypot(...z) - 1)).toBeLessThan(1e-5);
    });
});
