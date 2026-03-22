mod features;
mod parser;
mod vocab;

use ahash::AHashMap;
use features::extract_page_inner;
use ndarray::Array2;
use numpy::{PyArray1, PyArray2, PyReadonlyArray2, ToPyArray};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyTuple};

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Convert a Python token2idx dict to an AHashMap once.
fn pydict_to_token_map(token2idx: &Bound<PyDict>) -> PyResult<AHashMap<String, usize>> {
    let mut map = AHashMap::with_capacity(token2idx.len());
    for (k, v) in token2idx.iter() {
        map.insert(k.extract::<String>()?, v.extract::<usize>()?);
    }
    Ok(map)
}

fn r_to_pylist<'py>(
    py: Python<'py>,
    r: Vec<(String, ndarray::Array1<f32>, ndarray::Array1<f32>)>,
) -> PyResult<Bound<'py, PyList>> {
    let py_r = PyList::empty_bound(py);
    for (tok, word_vec, struct_vec) in r {
        let tuple = PyTuple::new_bound(
            py,
            &[
                tok.into_py(py),
                word_vec.to_pyarray_bound(py).into_py(py),
                struct_vec.to_pyarray_bound(py).into_py(py),
            ],
        );
        py_r.append(tuple)?;
    }
    Ok(py_r)
}

// ── Extractor class — pay setup cost once, call extract_page many times ────

/// Cached extractor. Construct once per vocab, then call `extract_page`
/// repeatedly without rebuilding the token map or cloning the embedding matrices.
///
///   ex = rust_extractor.Extractor(token2idx, word_matrix, struct_matrix)
///   R, omega, mask = ex.extract_page(html_path, M)
#[pyclass]
struct Extractor {
    token2idx: AHashMap<String, usize>,
    word_matrix: Array2<f32>,
    struct_matrix: Array2<f32>,
}

#[pymethods]
impl Extractor {
    #[new]
    fn new(
        token2idx: &Bound<PyDict>,
        word_matrix: PyReadonlyArray2<f32>,
        struct_matrix: PyReadonlyArray2<f32>,
    ) -> PyResult<Self> {
        Ok(Self {
            token2idx: pydict_to_token_map(token2idx)?,
            word_matrix: word_matrix.as_array().to_owned(),
            struct_matrix: struct_matrix.as_array().to_owned(),
        })
    }

    fn extract_page<'py>(
        &self,
        py: Python<'py>,
        html_path: &str,
        m: usize,
    ) -> PyResult<(Bound<'py, PyList>, Bound<'py, PyArray2<f32>>, Bound<'py, PyArray1<bool>>)> {
        let (r, omega, mask) = extract_page_inner(
            html_path,
            &self.token2idx,
            self.word_matrix.view(),
            self.struct_matrix.view(),
            m,
        );
        Ok((r_to_pylist(py, r)?, omega.to_pyarray_bound(py), mask.to_pyarray_bound(py)))
    }
}

// ── Free functions (backward-compatible, kept for correctness tests) ────────

#[pyfunction]
fn parse_html_py<'py>(
    py: Python<'py>,
    html_path: &str,
    max_tokens: usize,
) -> PyResult<Bound<'py, PyList>> {
    let pairs = parser::parse_html(html_path, max_tokens);
    let py_list = PyList::empty_bound(py);
    for (tok, tag) in pairs {
        let tuple = PyTuple::new_bound(py, &[tok.into_py(py), tag.into_py(py)]);
        py_list.append(tuple)?;
    }
    Ok(py_list)
}

#[pyfunction]
fn build_corpus_vocab<'py>(
    py: Python<'py>,
    records: &Bound<'py, PyList>,
    glove_path: &str,
    n: usize,
    m: usize,
) -> PyResult<(Bound<'py, PyDict>, Bound<'py, PyArray2<f32>>, Bound<'py, PyArray2<f32>>)> {
    let html_paths: Vec<String> = records
        .iter()
        .map(|item| {
            let tuple = item.downcast::<PyTuple>()?;
            tuple.get_item(1)?.extract::<String>()
        })
        .collect::<PyResult<_>>()?;

    let (token2idx, word_matrix, struct_matrix) =
        vocab::build_vocab(&html_paths, glove_path, n, m);

    let py_dict = PyDict::new_bound(py);
    for (tok, idx) in &token2idx {
        py_dict.set_item(tok, idx)?;
    }

    Ok((
        py_dict,
        word_matrix.to_pyarray_bound(py),
        struct_matrix.to_pyarray_bound(py),
    ))
}

/// Convenience wrapper — rebuilds the token map on every call.
/// Use `Extractor` for repeated calls to the same vocab.
#[pyfunction]
fn extract_page<'py>(
    py: Python<'py>,
    html_path: &str,
    token2idx: &Bound<'py, PyDict>,
    word_matrix: PyReadonlyArray2<'py, f32>,
    struct_matrix: PyReadonlyArray2<'py, f32>,
    m: usize,
) -> PyResult<(Bound<'py, PyList>, Bound<'py, PyArray2<f32>>, Bound<'py, PyArray1<bool>>)> {
    let token_map = pydict_to_token_map(token2idx)?;
    let (r, omega, mask) = extract_page_inner(
        html_path,
        &token_map,
        word_matrix.as_array(),
        struct_matrix.as_array(),
        m,
    );
    Ok((r_to_pylist(py, r)?, omega.to_pyarray_bound(py), mask.to_pyarray_bound(py)))
}

#[pymodule]
fn rust_extractor(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Extractor>()?;
    m.add_function(wrap_pyfunction!(build_corpus_vocab, m)?)?;
    m.add_function(wrap_pyfunction!(extract_page, m)?)?;
    m.add_function(wrap_pyfunction!(parse_html_py, m)?)?;
    Ok(())
}
