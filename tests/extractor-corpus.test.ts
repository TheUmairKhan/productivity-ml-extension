/**
 * Full-corpus parity: every page the CNN was trained on, Python vs TypeScript.
 *
 * This is the check that actually matters. The committed fixtures exercise each
 * rule in isolation on markup someone wrote deliberately; real pages are where
 * unclosed tags, exotic entities and vendor markup live.
 *
 * Skips unless models/dump_corpus_pairs.py has been run, since the corpus is a
 * local capture store rather than something committed to the repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractPairs } from "../src/services/extractor.js";
import type { EntityTables, ExtractorConfig } from "../src/shared/types.js";

const ROOT = join(import.meta.dirname, "..");
const DUMP = join(ROOT, "tests/fixtures/corpus-pairs.jsonl");

function readJson(path: string): any {
    return JSON.parse(readFileSync(join(ROOT, path), "utf-8"));
}

const rawCfg = readJson("assets/extractor-config.json");
const rawEntities = readJson("assets/entities.json");

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

describe.skipIf(!existsSync(DUMP))("extractor corpus parity", () => {
    it("matches Python on every corpus page", () => {
        const rows = readFileSync(DUMP, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as {
                url: string;
                html_path: string;
                pairs: [string, string][];
            });

        const mismatches: Array<{ url: string; at: number; expected: unknown; actual: unknown }> = [];
        let checked = 0;

        for (const row of rows) {
            if (!existsSync(row.html_path)) continue;
            checked++;

            const actual = extractPairs(readFileSync(row.html_path, "utf-8"), cfg, tables);

            if (actual.length !== row.pairs.length) {
                mismatches.push({
                    url: row.url,
                    at: -1,
                    expected: `${row.pairs.length} pairs`,
                    actual: `${actual.length} pairs`,
                });
                continue;
            }
            for (let i = 0; i < actual.length; i++) {
                if (actual[i].token !== row.pairs[i][0] || actual[i].tag !== row.pairs[i][1]) {
                    mismatches.push({
                        url: row.url,
                        at: i,
                        expected: row.pairs[i],
                        actual: [actual[i].token, actual[i].tag],
                    });
                    break;
                }
            }
        }

        expect(checked).toBeGreaterThan(0);
        if (mismatches.length) {
            console.error(
                `${mismatches.length}/${checked} pages diverge:\n` +
                    JSON.stringify(mismatches.slice(0, 10), null, 2),
            );
        }
        expect(mismatches).toEqual([]);
    }, 120_000);
});
