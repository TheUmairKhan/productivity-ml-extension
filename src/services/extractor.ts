/**
 * TypeScript port of models/semantic_structure/extractor.py.
 *
 * The item tower is only meaningful if this produces the same (token, tag)
 * sequence as the Python extractor the CNN was trained on. A divergence here is
 * silent: embeddings shift, the fitted sigma and z_global no longer describe the
 * vectors being scored, and every metric still looks fine. tests/extractor.test.ts
 * pins this against fixtures generated from Python.
 *
 * That requirement is also why this does NOT use DOMParser. Python's
 * html.parser.HTMLParser is a stream tokenizer with no error recovery: it never
 * implicitly closes a tag, so <p>a<p>b leaves two <p> on its stack. A real DOM
 * parser corrects that structure and would disagree on the innermost open tag,
 * which is exactly what selects a token's structural embedding.
 */

import type { ExtractorConfig, EntityTables } from "../shared/types.js";

export interface TokenTagPair {
    token: string;
    tag: string;
}

// Mirrors _PUNCT_RE: everything outside this class becomes a split point.
const PUNCT_RE = /[^a-z0-9'\-]/g;

// Ports of html.parser's tolerant regexes. These are anchored to actual tag
// structure, which is what lets them fail gracefully: a naive "scan to the next
// unquoted '>'" swallows the rest of the document the moment a tag contains a
// stray apostrophe (<img alt=John's photo>), and real pages are full of those.
// All are sticky so they match at a position, like Python's re.match(s, pos).
const START_TAG_OPEN_RE = /^<[a-zA-Z]/;
const TAG_FIND_RE = /([a-zA-Z][^\t\n\r\f />\x00]*)(?:\s|\/(?!>))*/y;
const ATTR_RE =
    /((?<=['"\s/])[^\s/>][^\s/=>]*)(\s*=+\s*('[^']*'|"[^"]*"|(?!['"])[^>\s]*))?(?:\s|\/(?!>))*/y;
const LOCATE_START_TAG_END_RE =
    /<[a-zA-Z][^\t\n\r\f />\x00]*(?:[\s/]*(?:(?<=['"\s/])[^\s/>][^\s/=>]*(?:\s*=+\s*(?:'[^']*'|"[^"]*"|(?!['"])[^>\s]*)\s*)?(?:\s|\/(?!>))*)*)?\s*/y;
const END_TAG_FIND_RE = /<\/\s*([a-zA-Z][-.a-zA-Z0-9:_]*)\s*>/y;

/** Python's check_for_whole_start_tag: index just past the tag, or -1. Exported for parity tests. */
export function checkForWholeStartTag(html: string, i: number): number {
    LOCATE_START_TAG_END_RE.lastIndex = i;
    const m = LOCATE_START_TAG_END_RE.exec(html);
    if (!m) return -1;

    const j = i + m[0].length;
    const next = html.slice(j, j + 1);
    if (next === ">") return j + 1;
    if (next === "/") return html.startsWith("/>", j) ? j + 2 : -1;
    if (next === "") return -1;
    if (/[a-zA-Z=/]/.test(next)) return -1;

    // End of input inside or before an attribute value: give up on structure
    // and take the next '>' as the boundary.
    const gt = html.indexOf(">", j);
    return gt < 0 ? -1 : gt + 1;
}

// Python's _charref, verbatim.
const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

export function tokenize(text: string): string[] {
    return text.toLowerCase().replace(PUNCT_RE, " ").split(/\s+/).filter(Boolean);
}

/**
 * Port of html.unescape. The named-reference fallback matters: Python looks up
 * the longest prefix present in the html5 table and keeps the remainder, so
 * "&notit;" decodes to "¬it;" rather than staying literal.
 */
export function unescape(text: string, tables: EntityTables): string {
    if (!text.includes("&")) return text;

    return text.replace(CHARREF_RE, (match, ref: string) => {
        if (ref.startsWith("#")) {
            const isHex = ref[1] === "x" || ref[1] === "X";
            const digits = (isHex ? ref.slice(2) : ref.slice(1)).replace(/;$/, "");
            const num = parseInt(digits, isHex ? 16 : 10);
            if (Number.isNaN(num)) return match;

            const replacement = tables.invalid_charrefs[String(num)];
            if (replacement !== undefined) return replacement;
            if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
            if (tables.invalid_codepoints.has(num)) return "";
            return String.fromCodePoint(num);
        }

        const exact = tables.html5[ref];
        if (exact !== undefined) return exact;
        for (let x = ref.length - 1; x > 1; x--) {
            const prefix = tables.html5[ref.slice(0, x)];
            if (prefix !== undefined) return prefix + ref.slice(x);
        }
        return "&" + ref;
    });
}

class StructuredParser {
    private stack: string[] = [];
    private excludeDepth = 0;
    private cdataElem: string | null = null;
    readonly pairs: TokenTagPair[] = [];

    constructor(
        private readonly cfg: ExtractorConfig,
        private readonly tables: EntityTables,
    ) {}

    private get full(): boolean {
        return this.pairs.length >= this.cfg.max_tokens;
    }

    handleStartTag(tag: string, attrs: Map<string, string>): void {
        if (tag === "meta") {
            const name = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
            if (this.cfg.meta_names.has(name)) {
                for (const tok of tokenize(attrs.get("content") ?? "")) {
                    if (this.full) return;
                    this.pairs.push({ token: tok, tag: "meta_desc" });
                }
            }
            return; // void element -- never pushed
        }

        if (this.cfg.void_elements.has(tag)) return;
        if (this.cfg.exclude_tags.has(tag)) this.excludeDepth++;
        this.stack.push(tag);
    }

    handleEndTag(tag: string): void {
        if (this.cfg.void_elements.has(tag)) return;
        if (this.cfg.exclude_tags.has(tag)) {
            this.excludeDepth = Math.max(0, this.excludeDepth - 1);
        }
        // Python scans from the top for the matching name and removes only that
        // entry, leaving anything opened above it on the stack. Unmatched end
        // tags are dropped entirely.
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i] === tag) {
                this.stack.splice(i, 1);
                break;
            }
        }
    }

    handleData(data: string): void {
        if (this.full) return;
        if (this.excludeDepth > 0 || this.stack.length === 0) return;

        const top = this.stack[this.stack.length - 1];
        if (!this.cfg.innertext_tags.has(top)) return;

        for (const tok of tokenize(data)) {
            this.pairs.push({ token: tok, tag: top });
            if (this.full) return;
        }
    }

    /**
     * Port of HTMLParser.goahead.
     *
     * cdataElem mirrors Python's own state rather than being inferred from the
     * stack: inside <script>/<style> nothing is markup, so a "<div>" in a JS
     * string never reaches the tag stack, and the text is handed over without
     * character-reference decoding.
     */
    feed(html: string): void {
        let i = 0;
        const n = html.length;

        while (i < n) {
            let j: number;
            if (this.cdataElem === null) {
                j = html.indexOf("<", i);
                if (j < 0) {
                    this.handleData(unescape(html.slice(i), this.tables));
                    return;
                }
            } else {
                // Python's `interesting` becomes </\s*elem while in CDATA mode.
                const re = new RegExp(`</\\s*${this.cdataElem}`, "i");
                const m = re.exec(html.slice(i));
                if (!m) {
                    this.handleData(html.slice(i));
                    return;
                }
                j = i + m.index;
            }

            if (j > i) {
                this.handleData(
                    this.cdataElem === null
                        ? unescape(html.slice(i, j), this.tables)
                        : html.slice(i, j),
                );
            }
            if (j >= n) return;

            let k: number;
            if (START_TAG_OPEN_RE.test(html.slice(j, j + 2))) {
                k = this.parseStartTag(html, j);
            } else if (html.startsWith("</", j)) {
                k = this.parseEndTag(html, j);
            } else if (html.startsWith("<!--", j)) {
                const end = html.indexOf("-->", j + 4);
                k = end < 0 ? -1 : end + 3;
            } else if (html.startsWith("<![", j)) {
                const end = html.indexOf("]]>", j + 3);
                k = end < 0 ? -1 : end + 3;
            } else if (html.startsWith("<?", j) || html.startsWith("<!", j)) {
                const end = html.indexOf(">", j + 2);
                k = end < 0 ? -1 : end + 1;
            } else if (j + 1 < n) {
                this.handleData("<");
                k = j + 1;
            } else {
                return;
            }

            // Python breaks out of the loop on an incomplete construct; with the
            // whole document in hand there is nothing more to wait for.
            if (k < 0) return;
            i = Math.max(k, j + 1);
        }
    }

    /** Port of parse_starttag. Returns the index just past the tag, or -1. */
    private parseStartTag(html: string, i: number): number {
        const endpos = checkForWholeStartTag(html, i);
        if (endpos < 0) return endpos;

        TAG_FIND_RE.lastIndex = i + 1;
        const nameMatch = TAG_FIND_RE.exec(html);
        if (!nameMatch) return endpos;

        const tag = nameMatch[1].toLowerCase();
        let k = TAG_FIND_RE.lastIndex;

        const attrs = new Map<string, string>();
        while (k < endpos) {
            ATTR_RE.lastIndex = k;
            const m = ATTR_RE.exec(html);
            if (!m) break;

            let value = m[3];
            if (value !== undefined) {
                const q = value[0];
                if ((q === "'" && value.endsWith("'")) || (q === '"' && value.endsWith('"'))) {
                    value = value.slice(1, -1);
                }
                if (value) value = unescape(value, this.tables);
            }
            attrs.set(m[1].toLowerCase(), value ?? "");

            if (ATTR_RE.lastIndex === k) break; // zero-width match; no progress
            k = ATTR_RE.lastIndex;
        }

        // Anything left over that is not the tag terminator means this was never
        // a tag. Python emits the whole span as text, and so must we, or the
        // token streams diverge on malformed markup.
        const end = html.slice(k, endpos).trim();
        if (end !== ">" && end !== "/>") {
            this.handleData(html.slice(i, endpos));
            return endpos;
        }

        if (end.endsWith("/>")) {
            // handle_startendtag: start immediately followed by end.
            this.handleStartTag(tag, attrs);
            this.handleEndTag(tag);
        } else {
            this.handleStartTag(tag, attrs);
            if (this.cfg.cdata_elements.has(tag)) this.cdataElem = tag;
        }
        return endpos;
    }

    /** Port of parse_endtag. Returns the index just past the tag, or -1. */
    private parseEndTag(html: string, i: number): number {
        const gt = html.indexOf(">", i + 1);
        if (gt < 0) return -1;
        const gtpos = gt + 1;

        END_TAG_FIND_RE.lastIndex = i;
        const m = END_TAG_FIND_RE.exec(html);

        if (!m) {
            if (this.cdataElem !== null) {
                this.handleData(html.slice(i, gtpos));
                return gtpos;
            }
            TAG_FIND_RE.lastIndex = i + 2;
            const nameMatch = TAG_FIND_RE.exec(html);
            if (!nameMatch) {
                // '</>' is dropped; anything else is a bogus comment.
                return html.startsWith("</>", i) ? i + 3 : gtpos;
            }
            const closed = html.indexOf(">", TAG_FIND_RE.lastIndex);
            this.handleEndTag(nameMatch[1].toLowerCase());
            return closed < 0 ? gtpos : closed + 1;
        }

        const elem = m[1].toLowerCase();
        if (this.cdataElem !== null && elem !== this.cdataElem) {
            this.handleData(html.slice(i, gtpos));
            return gtpos;
        }

        this.handleEndTag(elem);
        this.cdataElem = null;
        return i + m[0].length;
    }
}

export function extractPairs(
    html: string,
    cfg: ExtractorConfig,
    tables: EntityTables,
): TokenTagPair[] {
    const parser = new StructuredParser(cfg, tables);
    parser.feed(html);
    return parser.pairs;
}

/**
 * Raw HTML -> the two int32 index arrays the ONNX encoder takes.
 * Padding is index 0 in both; unknown tokens are 1 (<UNK>).
 */
export function htmlToIndices(
    html: string,
    token2idx: Record<string, number>,
    cfg: ExtractorConfig,
    tables: EntityTables,
): { wordIdx: BigInt64Array; tagIdx: BigInt64Array } {
    const pairs = extractPairs(html, cfg, tables);
    const wordIdx = new BigInt64Array(cfg.max_tokens);
    const tagIdx = new BigInt64Array(cfg.max_tokens);

    const limit = Math.min(pairs.length, cfg.max_tokens);
    for (let i = 0; i < limit; i++) {
        wordIdx[i] = BigInt(token2idx[pairs[i].token] ?? 1);
        tagIdx[i] = BigInt(cfg.tag_to_idx[pairs[i].tag] ?? 0);
    }
    return { wordIdx, tagIdx };
}
