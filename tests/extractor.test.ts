/**
 * Pins src/services/extractor.ts against the Python reference.
 *
 * Fixtures come from models/gen_extractor_fixtures.py, so the expectations are
 * whatever html.parser actually does rather than what anyone believes it does.
 * Regenerate them whenever the Python extractor changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractPairs, tokenize, unescape } from "../src/services/extractor.js";
import type { EntityTables, ExtractorConfig } from "../src/shared/types.js";

const ROOT = join(import.meta.dirname, "..");

function readJson(path: string): any {
    return JSON.parse(readFileSync(join(ROOT, path), "utf-8"));
}

const rawCfg = readJson("assets/extractor-config.json");
const rawEntities = readJson("assets/entities.json");
const fixtures = readJson("tests/fixtures/extractor-cases.json");

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

describe("extractor parity with Python", () => {
    for (const c of fixtures.cases as Array<{
        name: string;
        html: string;
        pairs: [string, string][];
    }>) {
        it(c.name, () => {
            const actual = extractPairs(c.html, cfg, tables).map(
                (p) => [p.token, p.tag] as [string, string],
            );
            expect(actual).toEqual(c.pairs);
        });
    }
});

describe("tokenize", () => {
    it("keeps apostrophes and hyphens, drops other punctuation", () => {
        expect(tokenize("Don't split hyphen-word, but drop periods.")).toEqual([
            "don't", "split", "hyphen-word", "but", "drop", "periods",
        ]);
    });

    it("returns nothing for whitespace-only input", () => {
        expect(tokenize("   \n\t ")).toEqual([]);
    });
});

describe("unescape", () => {
    it("leaves text without an ampersand untouched", () => {
        expect(unescape("plain text", tables)).toBe("plain text");
    });

    it("decodes named and numeric references", () => {
        expect(unescape("&amp;&lt;&gt;", tables)).toBe("&<>");
        expect(unescape("&#72;&#x57;", tables)).toBe("HW");
    });

    it("falls back to the longest matching prefix", () => {
        // The case that motivates the loop: "not" matches, "it;" is remainder.
        expect(unescape("&notit;", tables)).toBe("¬it;");
    });

    it("leaves unknown references literal", () => {
        expect(unescape("&nosuchentity;", tables)).toBe("&nosuchentity;");
    });
});

describe("config sanity", () => {
    it("agrees with the fixture generator on the truncation limit", () => {
        expect(cfg.max_tokens).toBe(fixtures.max_tokens);
    });

    it("maps every innertext tag plus meta_desc to a structural index", () => {
        for (const tag of [...cfg.innertext_tags, "meta_desc"]) {
            expect(cfg.tag_to_idx[tag]).toBeGreaterThan(0);
        }
    });
});
