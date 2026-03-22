/// Per-page feature matrix construction — mirrors Python's extract_page.
use crate::parser::parse_html;
use ahash::AHashMap;
use ndarray::{Array1, Array2, ArrayView2};
use std::sync::OnceLock;

// ── Static tag→index map (built once, reused across all calls) ─────────────

static TAG2IDX: OnceLock<AHashMap<&'static str, usize>> = OnceLock::new();

fn get_tag2idx() -> &'static AHashMap<&'static str, usize> {
    TAG2IDX.get_or_init(|| {
        crate::vocab::STRUCTURAL_TAGS
            .iter()
            .enumerate()
            .map(|(i, &tag)| (tag, i + 1))
            .collect()
    })
}

/// Mirrors extract_page(html_path, token2idx, word_matrix, struct_matrix, m).
///
/// Accepts pre-owned AHashMap and ArrayView2 (no clones at call-site).
/// Returns (R, omega [M, K+N], mask [M]).
pub fn extract_page_inner(
    html_path: &str,
    token2idx: &AHashMap<String, usize>,
    word_matrix: ArrayView2<f32>,
    struct_matrix: ArrayView2<f32>,
    m: usize,
) -> (Vec<(String, Array1<f32>, Array1<f32>)>, Array2<f32>, Array1<bool>) {
    let pairs = parse_html(html_path, m);
    let l = pairs.len();
    let k = word_matrix.ncols();
    let n = struct_matrix.ncols();
    let kn = k + n;
    let tag2idx = get_tag2idx();

    let mut omega = Array2::<f32>::zeros((m, kn));
    let mut mask = Array1::<bool>::from_elem(m, false);
    let mut r: Vec<(String, Array1<f32>, Array1<f32>)> = Vec::with_capacity(l);

    // Fast path: both source matrices are C-contiguous (always true for numpy defaults).
    // Use copy_from_slice which compiles to a single memcpy per row.
    if let (Some(word_sl), Some(struct_sl), Some(omega_sl)) = (
        word_matrix.as_slice(),
        struct_matrix.as_slice(),
        omega.as_slice_mut(),
    ) {
        for i in 0..l {
            let tok_idx = *token2idx.get(pairs[i].0.as_str()).unwrap_or(&1);
            let tag_idx = *tag2idx.get(pairs[i].1.as_str()).unwrap_or(&0);
            let dst = i * kn;

            // Fill omega row: [word_vec | struct_vec]
            omega_sl[dst..dst + k].copy_from_slice(&word_sl[tok_idx * k..(tok_idx + 1) * k]);
            omega_sl[dst + k..dst + kn]
                .copy_from_slice(&struct_sl[tag_idx * n..(tag_idx + 1) * n]);
            mask[i] = true;

            // Build R by slicing the already-filled omega row — avoids a second lookup
            r.push((
                pairs[i].0.clone(),
                Array1::from_vec(omega_sl[dst..dst + k].to_vec()),
                Array1::from_vec(omega_sl[dst + k..dst + kn].to_vec()),
            ));
        }
    } else {
        // Fallback for non-contiguous arrays (shouldn't occur with standard numpy input)
        for i in 0..l {
            let tok_idx = *token2idx.get(pairs[i].0.as_str()).unwrap_or(&1);
            let tag_idx = *tag2idx.get(pairs[i].1.as_str()).unwrap_or(&0);
            let word_row = word_matrix.row(tok_idx);
            let struct_row = struct_matrix.row(tag_idx);
            omega.row_mut(i).slice_mut(ndarray::s![..k]).assign(&word_row);
            omega.row_mut(i).slice_mut(ndarray::s![k..]).assign(&struct_row);
            mask[i] = true;
            r.push((pairs[i].0.clone(), word_row.to_owned(), struct_row.to_owned()));
        }
    }

    (r, omega, mask)
}
