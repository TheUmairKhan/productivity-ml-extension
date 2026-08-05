# Plan: Upload Pages to Cloudflare R2 + Neon

## Context

The Chrome extension already has Google OAuth wired up against the FastAPI backend (`backend/social_auth.py`, `backend/models.py::User`), which is backed by Neon Postgres via async SQLAlchemy (`backend/db.py`). The two-tower architecture (`mvp_architecture.md`) and the local training pipeline (`plan.md`, `models/train.py`) currently consume pages from a **local SQLite file** (`~/Library/Application Support/mlops/pages.db`). `backend/pages.py` exists but is empty — this is the natural place to add a real upload path.

The user just created a Cloudflare R2 bucket and wants to start persisting the **raw HTML snapshot** of each captured page, uploaded from the extension to the backend, tied to the authenticated user. Multiple users can (rarely) label the same page, so page identity and per-user labels need to be modeled separately.

**R2 vs. Neon — do they need to be "linked"?** No direct coupling is needed. R2 is object storage (blobs only, no query capability); Neon is the source of truth for structured/queryable data. The standard pattern — and what this plan implements — is: upload the HTML blob to R2, then store a small metadata row in Neon that points at it (a `r2_key` string column). Neon never talks to R2 directly; the backend is the only thing that touches both.

## Schema Design

Two new tables in `backend/models.py`, alongside the existing `User`:

- **`Page`** — one row per unique piece of HTML content (deduped by a content hash, since the same URL/content could otherwise be uploaded once per user):
  - `id` (UUID, PK)
  - `url` (String)
  - `content_hash` (String, unique) — sha256 of the HTML, used for dedup and as part of the R2 key; `unique=True` alone already gives Postgres a unique index, no separate `index=True` needed
  - `r2_key` (String) — object key in the R2 bucket
  - `title` (String, nullable)
  - `created_at` (DateTime)
- **`PageLabel`** — join table capturing that a given user has this page, with their label:
  - `id` (UUID, PK)
  - `user_id` (FK → `users.id`)
  - `page_id` (FK → `pages.id`)
  - `label` (String — e.g. `productive` / `waste` / `skip`, matching `LABEL_TO_IDX` in `models/config.py`)
  - `created_at` (DateTime)
  - Unique constraint on `(user_id, page_id)`

This mirrors the two-tower architecture directly: `PageLabel` rows are exactly $I_u$, the set of pages a user has labeled.

## Implementation Steps

1. **R2 credentials** — add to `.env` (R2 is S3-compatible, so `boto3` works against it with a custom endpoint):
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
   - Endpoint is derived as `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`

2. **`backend/requirements.txt`** (doesn't exist yet — create it) — add `boto3` alongside the existing implicit deps (`fastapi`, `fastapi-users`, `sqlalchemy`, `asyncpg`, `python-dotenv`, etc. — capture what's actually installed in the current venv via `pip freeze`).

3. **`backend/storage.py`** (new) — thin R2 client wrapper:
   - `get_r2_client()` — builds a `boto3.client("s3", endpoint_url=..., aws_access_key_id=..., aws_secret_access_key=...)`
   - `upload_html(content: bytes, key: str) -> None` — `put_object` to the bucket with `ContentType: text/html`
   - Keep it synchronous and call it via `run_in_threadpool` (or `anyio.to_thread.run_sync`) from the async route, since boto3 is blocking.

4. **`backend/models.py`** — add `Page` and `PageLabel` SQLAlchemy models as designed above, importing `Base` the same way `User` does.

5. **`backend/pages.py`** — implement the router:
   - `POST /pages/upload`, protected by fastapi-users' `current_active_user` dependency (same pattern as `GET /users/me` in `backend/main.py`).
   - Request body: `{ url: str, html: str, label: str }`.
   - Logic: hash the HTML (sha256) → look up `Page` by `content_hash`. If missing, upload to R2 under a key like `pages/{content_hash}.html`, insert the `Page` row. Then upsert the `PageLabel` row for `(current_user.id, page.id)` (update `label` if it already exists, matching the "rare but possible" multi-user-same-page case).
   - Return the created/existing `page.id`.
   - Add a `GET /pages/me` (list current user's labeled pages) for easy manual verification.

6. **`backend/main.py`** — register the new `pages` router the same way the auth/users routers are registered.

7. **Table creation** — no Alembic yet (flagged as a known gap in `social_auth_plan.md`); follow the existing pattern of creating tables directly (e.g. `Base.metadata.create_all` at startup or a one-off script), matching how `users` was set up.

## Deviations from the Original Plan (reconciled against the live Neon schema)

Once the `pages`/`page_labels` tables actually existed in Neon, the live schema diverged from what was originally planned above:

- **Dedup key is `url`, not `content_hash`.** The live `pages` table has no `content_hash` or `title` columns — they were never added. Separately, the Rust native host (`mlops-host/src/storage.rs`) already dedupes locally by `url` (`ON CONFLICT(url) DO UPDATE`), not by content. To stay consistent with that, the backend now dedupes on `url` too: `pages.url` is unique, and re-uploading an already-seen URL **overwrites** the existing row's `html`/`r2_key`/`captured_at` rather than creating a new row or being skipped.
  - **Tradeoff being accepted:** if a URL's content changes between captures (edited article, dynamic content, etc.), the old snapshot is lost — there's no history, just the latest capture per URL. The alternative (no uniqueness constraint on `url`, every capture is its own `Page` row) would preserve full history at the cost of an unbounded table and needing `page_id` (not `url`) as the stable reference everywhere downstream (e.g. `PageLabel`, future embeddings). Revisit if training data ever needs multiple snapshots of the same URL over time.
  - **Action required:** the live `pages` table needs a `UNIQUE` constraint added manually (no migration tooling yet): `ALTER TABLE pages ADD CONSTRAINT pages_url_key UNIQUE (url);`
- **`captured_at` is required and client-supplied.** The live table has `captured_at timestamptz NOT NULL` with no default. The TypeScript `PageCapture` type (`src/shared/types.ts`) already produces this value client-side, so `PageUploadRequest` now includes `captured_at`, distinct from `created_at` (server-side insert time, `now()` default).
- **`pages.embedding` (pgvector) exists on the live table but isn't mapped in `backend/models.py` yet.** Nothing reads or writes it until the embedding pipeline (`models/embed.py` per `plan.md`) is wired into the backend — out of scope for the upload path itself.
- **R2 object key is now derived from `sha256(url)`, not `sha256(html)`** — since the key needs to be stable per URL (so re-uploads overwrite the same R2 object, matching the dedup-on-`url` decision), not stable per exact byte-content.

## Files Touched

- `backend/models.py` — add `Page`, `PageLabel`
- `backend/storage.py` — new, R2 client + upload helper
- `backend/pages.py` — implement upload/list routes (currently empty)
- `backend/main.py` — register `pages` router
- `backend/requirements.txt` — new, includes `boto3`
- `.env` — add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

## Verification

1. Start the backend locally (`uvicorn backend.main:app --reload`).
2. Register/log in a test user (existing auth endpoints) to get a bearer token.
3. `POST /pages/upload` with a small HTML sample + `Authorization: Bearer <token>`.
4. Confirm the object appears in the R2 bucket (Cloudflare dashboard or `aws s3 --endpoint-url ... ls`).
5. Confirm rows appear in Neon: query `pages` and `page_labels` tables (via `psql $DATABASE_URL` or a quick script using `backend/db.py`'s session).
6. Re-upload the same HTML from a second test user → confirm `Page` is reused (same `content_hash`/`r2_key`, no duplicate R2 object) and a second `PageLabel` row is created.
7. `GET /pages/me` returns the expected list for each test user.
