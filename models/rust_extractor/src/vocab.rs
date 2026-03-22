/// Vocabulary building and embedding matrices — mirrors Python's build_corpus_vocab.
use crate::parser::parse_html;
use ndarray::Array2;
use rand_distr::{Distribution, Normal};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};

pub const NUM_TAGS: usize = 12;
pub const STRUCTURAL_TAGS: &[&str] = &[
    "title", "meta_desc", "h1", "h2", "h3", "h4", "h5", "strong", "em",
    "span", "p", "table",
];


/// Mirrors build_corpus_vocab(records, glove_path, n, m).
///
/// Returns (token2idx, word_matrix [V, K], struct_matrix [NUM_TAGS+1, N]).
pub fn build_vocab(
    html_paths: &[String],
    glove_path: &str,
    n: usize,
    m: usize,
) -> (HashMap<String, usize>, Array2<f32>, Array2<f32>) {
    // ── Stage 1: collect corpus tokens from all pages ──────────────────────
    let mut corpus_tokens: HashSet<String> = HashSet::new();
    for path in html_paths {
        for (tok, _) in parse_html(path, m) {
            corpus_tokens.insert(tok);
        }
    }

    // ── Stage 2: single-pass GloVe load ───────────────────────────────────
    let file = File::open(glove_path).expect("GloVe file not found");
    let reader = BufReader::new(file);
    let mut lines = reader.lines();

    // Infer K from first line; also capture the first word if it's in corpus
    let mut glove_vecs: HashMap<String, Vec<f32>> = HashMap::new();
    let k;
    if let Some(Ok(first_line)) = lines.next() {
        let parts: Vec<&str> = first_line.split(' ').collect();
        k = parts.len() - 1;
        if corpus_tokens.contains(parts[0]) {
            let vec: Vec<f32> = parts[1..].iter().map(|s| s.parse().unwrap_or(0.0)).collect();
            glove_vecs.insert(parts[0].to_owned(), vec);
        }
    } else {
        panic!("GloVe file is empty");
    }

    for line in lines.flatten() {
        let mut parts = line.splitn(2, ' ');
        let word = match parts.next() {
            Some(w) => w.to_owned(),
            None => continue,
        };
        if !corpus_tokens.contains(&word) {
            continue;
        }
        let rest = match parts.next() {
            Some(r) => r,
            None => continue,
        };
        let vec: Vec<f32> = rest.split(' ').map(|s| s.parse().unwrap_or(0.0)).collect();
        if vec.len() == k {
            glove_vecs.insert(word, vec);
        }
    }

    // ── Stage 3: build token2idx ───────────────────────────────────────────
    let mut sorted_tokens: Vec<String> = corpus_tokens.into_iter().collect();
    sorted_tokens.sort();

    let mut token2idx: HashMap<String, usize> = HashMap::new();
    token2idx.insert("<PAD>".to_owned(), 0);
    token2idx.insert("<UNK>".to_owned(), 1);
    for (i, tok) in sorted_tokens.iter().enumerate() {
        token2idx.insert(tok.clone(), i + 2);
    }

    let vocab_size = token2idx.len();

    // ── Stage 4: word_matrix [V, K] ───────────────────────────────────────
    let mut word_matrix = Array2::<f32>::zeros((vocab_size, k));
    let mut known_vecs: Vec<Vec<f32>> = Vec::new();

    for (tok, &idx) in &token2idx {
        if let Some(vec) = glove_vecs.get(tok) {
            for (j, &v) in vec.iter().enumerate() {
                word_matrix[[idx, j]] = v;
            }
            known_vecs.push(vec.clone());
        }
    }

    // UNK row = mean of all known GloVe vectors
    if !known_vecs.is_empty() {
        let n_known = known_vecs.len() as f32;
        let mut unk_row = vec![0.0f32; k];
        for vec in &known_vecs {
            for (j, &v) in vec.iter().enumerate() {
                unk_row[j] += v;
            }
        }
        for j in 0..k {
            word_matrix[[1, j]] = unk_row[j] / n_known;
        }
    }

    let coverage = known_vecs.len() as f32 / (vocab_size - 2).max(1) as f32 * 100.0;
    println!(
        "Vocab: {} tokens | GloVe coverage: {}/{} ({:.1}%)",
        vocab_size,
        known_vecs.len(),
        vocab_size - 2,
        coverage
    );

    // ── Stage 5: struct_matrix [NUM_TAGS+1, N] — Gaussian N(0, 1/√N) ──────
    let std_dev = 1.0 / (n as f32).sqrt();
    let normal = Normal::new(0.0f32, std_dev).unwrap();
    let mut rng = rand::thread_rng();

    let mut struct_matrix = Array2::<f32>::zeros((NUM_TAGS + 1, n));
    for i in 1..=NUM_TAGS {
        for j in 0..n {
            struct_matrix[[i, j]] = normal.sample(&mut rng);
        }
    }
    // Row 0 stays zeros (PAD)

    (token2idx, word_matrix, struct_matrix)
}
