/// Fast HTML parser — hand-rolled byte scanner that mirrors Python's
/// `_StructuredParser` / `HTMLParser` behaviour without the overhead of a
/// full HTML5 spec-compliant parser.
///
/// Design: single linear pass over bytes.  No heap-allocated tree, no
/// spec-mandated state machine.  Just the subset of HTML processing that
/// our feature extractor actually needs.
use std::collections::HashSet;
use std::fs;

// ── Constants ───────────────────────────────────────────────────────────────

fn void_elements() -> HashSet<&'static str> {
    [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr",
    ]
    .iter()
    .copied()
    .collect()
}

fn exclude_tags() -> HashSet<&'static str> {
    ["script", "style", "noscript"].iter().copied().collect()
}

fn innertext_tags() -> HashSet<&'static str> {
    [
        "title", "h1", "h2", "h3", "h4", "h5", "strong", "em", "span", "p",
        "table",
    ]
    .iter()
    .copied()
    .collect()
}

fn meta_names() -> HashSet<&'static str> {
    [
        "description",
        "keywords",
        "og:title",
        "og:description",
        "twitter:description",
    ]
    .iter()
    .copied()
    .collect()
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

fn tokenize_text(text: &str) -> impl Iterator<Item = String> + '_ {
    // Lowercase and replace non-[a-z0-9'-] with spaces, then split.
    // Matches Python: re.compile(r"[^a-z0-9'\-]").sub(" ", text.lower()).split()
    let lower = text.to_lowercase();
    // Collect into a String to keep the iterator valid.
    let cleaned: String = lower
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '\'' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect();
    // Return owned strings by collecting first (avoids lifetime issues).
    cleaned
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>()
        .into_iter()
}

// ── Entity decoder ──────────────────────────────────────────────────────────

/// Decode the HTML entities that Python's HTMLParser decodes before passing
/// text to `handle_data`.  Only entities that could affect tokenisation
/// (i.e. those containing alphanumeric characters) matter; the rest become
/// punctuation and are stripped by the tokenizer anyway.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut iter = s.char_indices().peekable();
    while let Some((_, c)) = iter.next() {
        if c != '&' {
            out.push(c);
            continue;
        }
        // Collect potential entity body until ';', ' ', '<', or another '&'
        let mut entity = String::new();
        let mut found_semi = false;
        loop {
            match iter.peek() {
                Some(&(_, ';')) => { iter.next(); found_semi = true; break; }
                Some(&(_, ' ')) | Some(&(_, '<')) | Some(&(_, '&')) | None => break,
                Some(&(_, nc)) => { entity.push(nc); iter.next(); }
            }
        }
        if !found_semi {
            // Not a well-formed entity — emit literally and re-process what we peeked
            out.push('&');
            out.push_str(&entity);
            continue;
        }
        match entity.as_str() {
            "amp"            => out.push('&'),
            "lt"             => out.push('<'),
            "gt"             => out.push('>'),
            "quot"           => out.push('"'),
            "apos"           => out.push('\''),
            "nbsp"           => out.push(' '),
            "ndash" | "mdash" => out.push('-'),
            e if e.starts_with('#') => {
                let n: Option<u32> = if e.get(1..2).map_or(false, |c| c.eq_ignore_ascii_case("x")) {
                    u32::from_str_radix(&e[2..], 16).ok()
                } else {
                    e[1..].parse().ok()
                };
                match n.and_then(char::from_u32) {
                    Some(cp) => out.push(cp),
                    None     => { out.push('&'); out.push_str(&entity); out.push(';'); }
                }
            }
            _ => { out.push('&'); out.push_str(&entity); out.push(';'); }
        }
    }
    out
}

// ── Fast byte-level string helpers ──────────────────────────────────────────

/// Find `needle` in `haystack` starting from `from`, case-insensitively on
/// ASCII.  Returns the byte offset of the match start within `haystack`.
#[inline]
fn find_ascii_ci(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    let n = needle.len();
    if haystack.len() < from + n {
        return None;
    }
    'outer: for i in from..=haystack.len() - n {
        for (j, &nb) in needle.iter().enumerate() {
            if haystack[i + j].to_ascii_lowercase() != nb.to_ascii_lowercase() {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// Advance past `>`, respecting double- and single-quoted attribute values so
/// that a `>` inside an attribute doesn't terminate the tag prematurely.
/// Returns the index of `>` in `bytes`, or `bytes.len()` if not found.
#[inline]
fn find_tag_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    let mut quote: u8 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            return i;
        }
        i += 1;
    }
    bytes.len()
}

// ── Attribute extractor for <meta> tags ─────────────────────────────────────

/// Given the raw bytes of a tag (without `<` and `>`), extract the value of
/// `attr_name` (case-insensitive).  Returns an owned String or empty string.
fn get_attr(tag_bytes: &[u8], attr_name: &[u8]) -> String {
    // Find 'attr_name' followed by optional whitespace, '=', then a value.
    let mut i = 0;
    while i < tag_bytes.len() {
        // Skip whitespace
        while i < tag_bytes.len() && tag_bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= tag_bytes.len() {
            break;
        }
        // Collect attribute name
        let name_start = i;
        while i < tag_bytes.len()
            && !tag_bytes[i].is_ascii_whitespace()
            && tag_bytes[i] != b'='
            && tag_bytes[i] != b'>'
        {
            i += 1;
        }
        let name_bytes = &tag_bytes[name_start..i];

        // Skip whitespace
        while i < tag_bytes.len() && tag_bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i < tag_bytes.len() && tag_bytes[i] == b'=' {
            i += 1; // skip '='
            // Skip whitespace
            while i < tag_bytes.len() && tag_bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            // Read value
            let (value, next_i) = if i < tag_bytes.len()
                && (tag_bytes[i] == b'"' || tag_bytes[i] == b'\'')
            {
                let q = tag_bytes[i];
                i += 1;
                let start = i;
                while i < tag_bytes.len() && tag_bytes[i] != q {
                    i += 1;
                }
                let v = std::str::from_utf8(&tag_bytes[start..i]).unwrap_or("").to_owned();
                i += 1; // skip closing quote
                (v, i)
            } else {
                // Unquoted value
                let start = i;
                while i < tag_bytes.len()
                    && !tag_bytes[i].is_ascii_whitespace()
                    && tag_bytes[i] != b'>'
                {
                    i += 1;
                }
                let v = std::str::from_utf8(&tag_bytes[start..i]).unwrap_or("").to_owned();
                (v, i)
            };
            i = next_i;

            // Check if attribute name matches
            if name_bytes.len() == attr_name.len()
                && name_bytes
                    .iter()
                    .zip(attr_name.iter())
                    .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
            {
                return value;
            }
        }
        // No '=' → boolean attribute; skip it
    }
    String::new()
}

// ── Main parser ─────────────────────────────────────────────────────────────

pub fn parse_html(html_path: &str, max_tokens: usize) -> Vec<(String, String)> {
    let content = match fs::read(html_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    parse_bytes(&content, max_tokens)
}

/// Core parser — operates on raw bytes so it can handle non-UTF-8 inputs
/// gracefully (like Python's `errors="replace"` open mode).
fn parse_bytes(content: &[u8], max_tokens: usize) -> Vec<(String, String)> {
    let void_set    = void_elements();
    let exclude_set = exclude_tags();
    let inner_set   = innertext_tags();
    let meta_set    = meta_names();

    let mut pairs: Vec<(String, String)> = Vec::with_capacity(max_tokens);
    let mut stack: Vec<String> = Vec::new();
    let mut exclude_depth: usize = 0;

    let mut i = 0usize;

    while i < content.len() {
        if pairs.len() >= max_tokens {
            break;
        }

        if content[i] != b'<' {
            // ── Text node ───────────────────────────────────────────────────
            let text_start = i;
            while i < content.len() && content[i] != b'<' {
                i += 1;
            }
            if exclude_depth > 0 || stack.is_empty() {
                continue;
            }
            let top = stack.last().unwrap();
            if !inner_set.contains(top.as_str()) {
                continue;
            }
            // Decode bytes to string, replacing invalid UTF-8 (mirrors Python errors="replace")
            let raw = String::from_utf8_lossy(&content[text_start..i]);
            let decoded = decode_entities(&raw);
            for tok in tokenize_text(&decoded) {
                pairs.push((tok, top.clone()));
                if pairs.len() >= max_tokens {
                    return pairs;
                }
            }
            continue;
        }

        // ── Tag ─────────────────────────────────────────────────────────────
        i += 1; // skip '<'
        if i >= content.len() {
            break;
        }

        // Comment: <!-- ... -->
        if content[i..].starts_with(b"!--") {
            if let Some(end) = find_ascii_ci(content, i + 3, b"-->") {
                i = end + 3;
            } else {
                i = content.len();
            }
            continue;
        }

        // DOCTYPE / processing instruction — skip to '>'
        if content[i] == b'!' || content[i] == b'?' {
            let end = find_tag_end(content, i);
            i = end + 1;
            continue;
        }

        let is_end_tag = content[i] == b'/';
        if is_end_tag {
            i += 1;
        }

        // Collect tag name
        let name_start = i;
        while i < content.len()
            && !content[i].is_ascii_whitespace()
            && content[i] != b'>'
            && content[i] != b'/'
        {
            i += 1;
        }
        let name_raw = match std::str::from_utf8(&content[name_start..i]) {
            Ok(s) => s.to_lowercase(),
            Err(_) => {
                let end = find_tag_end(content, i);
                i = end + 1;
                continue;
            }
        };

        let tag_end = find_tag_end(content, i);
        let tag_inner = &content[name_start..tag_end]; // everything after '<[/]' up to '>'
        let is_self_closing = tag_end > 0 && content[tag_end - 1] == b'/';

        if is_end_tag {
            // End tag
            let name = name_raw.as_str();
            if void_set.contains(name) {
                i = tag_end + 1;
                continue;
            }
            if exclude_set.contains(name) {
                exclude_depth = exclude_depth.saturating_sub(1);
            }
            // Pop matching tag from stack (reverse search for malformed HTML)
            if let Some(pos) = stack.iter().rposition(|t| t == name) {
                stack.remove(pos);
            }
        } else {
            // Start tag
            let name = name_raw.as_str();

            if name == "meta" {
                // Extract content from description/og meta tags
                let name_attr = get_attr(tag_inner, b"name");
                let prop_attr = get_attr(tag_inner, b"property");
                let attr_name = if !name_attr.is_empty() {
                    name_attr.to_lowercase()
                } else {
                    prop_attr.to_lowercase()
                };
                if meta_set.contains(attr_name.as_str()) {
                    let content_attr = get_attr(tag_inner, b"content");
                    let decoded = decode_entities(&content_attr);
                    for tok in tokenize_text(&decoded) {
                        pairs.push((tok, "meta_desc".to_owned()));
                        if pairs.len() >= max_tokens {
                            i = tag_end + 1;
                            return pairs;
                        }
                    }
                }
                i = tag_end + 1;
                continue; // void — never push stack
            }

            if void_set.contains(name) || is_self_closing {
                i = tag_end + 1;
                continue;
            }

            // Raw block tags: scan directly to matching </tagname> so that
            // JS/CSS content containing '<' doesn't confuse the tag parser.
            if name == "script" || name == "style" || name == "noscript" {
                let close_pat = format!("</{name}");
                i = tag_end + 1;
                if let Some(close_pos) = find_ascii_ci(content, i, close_pat.as_bytes()) {
                    // Skip to the '>' that ends the close tag
                    let gt = find_tag_end(content, close_pos + close_pat.len());
                    i = gt + 1;
                } else {
                    i = content.len();
                }
                continue;
            }

            stack.push(name_raw);
        }

        i = tag_end + 1;
    }

    pairs
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_entities() {
        assert_eq!(decode_entities("hello &amp; world"), "hello & world");
        assert_eq!(decode_entities("&lt;tag&gt;"), "<tag>");
        assert_eq!(decode_entities("no entities"), "no entities");
        assert_eq!(decode_entities("&#39;"), "'");
        assert_eq!(decode_entities("&#x27;"), "'");
    }

    #[test]
    fn test_tokenize() {
        let toks: Vec<_> = tokenize_text("Hello, World!").collect();
        assert_eq!(toks, vec!["hello", "world"]);
        let toks2: Vec<_> = tokenize_text("multi-head attention").collect();
        assert_eq!(toks2, vec!["multi-head", "attention"]);
    }

    #[test]
    fn test_basic_parse() {
        let html = b"<html><body><p>Hello world</p></body></html>";
        let pairs = parse_bytes(html, 100);
        assert_eq!(pairs, vec![("hello".to_owned(), "p".to_owned()), ("world".to_owned(), "p".to_owned())]);
    }

    #[test]
    fn test_script_excluded() {
        let html = b"<html><body><script>var x = 1;</script><p>visible</p></body></html>";
        let pairs = parse_bytes(html, 100);
        assert_eq!(pairs, vec![("visible".to_owned(), "p".to_owned())]);
    }

    #[test]
    fn test_meta_desc() {
        let html = br#"<html><head><meta name="description" content="Great page here"></head><body></body></html>"#;
        let pairs = parse_bytes(html, 100);
        assert_eq!(pairs, vec![
            ("great".to_owned(), "meta_desc".to_owned()),
            ("page".to_owned(), "meta_desc".to_owned()),
            ("here".to_owned(), "meta_desc".to_owned()),
        ]);
    }
}
