# Guided Walkthrough: Google Sign-In for the Extension

## Context

The extension (Manifest V3, `manifest.json` + `popup.ts`) currently has no login UI at all — auth lives entirely in the backend (`backend/`), which is FastAPI + `fastapi-users` v15 with JWT bearer tokens (`backend/auth.py`), a plain `User` table with only the standard fastapi-users columns (`backend/models.py`), and email/password endpoints wired in `backend/main.py`. Postgres is Neon, secrets come from `.env` via `python-dotenv`.

You want to add Google sign-in on top of this (Apple is out of scope now). You'll implement it yourself — this plan is the walkthrough: console setup steps and what to build.

**Chosen architecture:** since you're Google-only now, use `chrome.identity.getAuthToken()` instead of `launchWebAuthFlow` — it's the Chrome-native flow: no redirect URI/`chromiumapp.org` handling, no fragment parsing, no nonce bookkeeping. Chrome mints a token for whichever Google account the user is already signed into the browser with. The extension gets back an **access token**, POSTs it to a new backend endpoint, and the backend validates it against Google, finds-or-creates a `User`, and returns your existing JWT format — so nothing downstream of login (`current_active_user`, `/users/me`) needs to change.

## 1. Google Cloud Console

1. console.cloud.google.com → new/existing project → OAuth consent screen (in the newer UI: "Branding" under Google Auth Platform) → External, add app name + support email, scopes `openid email profile` (all non-sensitive, no verification needed). Leave in "Testing" while you build.
2. Go to **Clients** (newer UI, under Google Auth Platform) or **APIs & Services → Credentials** (classic UI) → Create Client/Credentials → OAuth client ID → **Chrome Extension** as the application type (this is the right type now, since `getAuthToken` is exactly what it's built for).
3. It will ask for your **Item ID / Application ID** — this is your extension's ID. You need it before creating the client, so load the extension unpacked first (or pin a `"key"` field in `manifest.json` for a deterministic ID — see gotcha below) and copy the ID from `chrome://extensions`.
4. Copy the generated **Client ID**.

**Gotcha — extension ID stability:** the Chrome Extension client type binds directly to your extension's ID. That ID can change across "Load unpacked" reinstalls and again once published, unless you pin a `"key"` field in `manifest.json`. Pin it now so you don't have to re-register the client later.

## 2. Backend changes

New module `backend/social_auth.py`:
- `POST /auth/google`, accepting `{"access_token": str}` and returning `{"access_token": ..., "token_type": "bearer"}` — same response shape as `/auth/jwt/login` (unfortunately-overloaded field name; consider naming the incoming field `google_access_token` in your request body to avoid confusion with the JWT you return).
- Wire into `backend/main.py` next to the existing routers: `app.include_router(social_auth_router, prefix="/auth", tags=["auth"])`.

**Verify Google's token:** `getAuthToken` returns an OAuth **access token**, not an ID token, so `google.oauth2.id_token.verify_oauth2_token` (which expects a signed ID token/JWT) doesn't apply here. Instead, call Google's userinfo endpoint server-side with the token: `GET https://www.googleapis.com/oauth2/v3/userinfo` with `Authorization: Bearer <access_token>`. A successful response (200) with an `email`/`sub` in the body proves the token is valid and gives you the identity; a 401 means it's invalid/expired. Use `httpx` (already available via the FastAPI/async stack) for this call — no new dependency needed for verification itself.

**Find-or-create user** — add one nullable column, `google_sub`, to `User` in `backend/models.py` (you'll need to hand-run an `ALTER TABLE` against Neon, or set up Alembic — there's no migration tooling in the repo yet, decide which before writing this). Lookup order in a helper like `get_or_create_google_user(session, sub, email)`:
1. Match by `google_sub` — return if found.
2. Else match by `email` if present — backfill `google_sub` (handles a user who signed up with password first, then uses Google sign-in with the same email) — return if found.
3. Else create a new `User` via `SQLAlchemyUserDatabase` (from `get_user_db` in `auth.py`) with a random unusable password (`PasswordHelper().hash(secrets.token_urlsafe(32))`), `is_active=True`, `is_verified=True` (trust Google's own email verification).

**Issue the JWT:** don't route through `fastapi_users.get_auth_router`'s login (it expects password credentials). Instead call `get_jwt_strategy()` from `backend/auth.py` directly and `await strategy.write_token(user)` — structurally identical to a normal login token, works with the existing `current_active_user` dependency untouched.

## 3. Extension changes

`manifest.json`:
- Add `"identity"` to `permissions`.
- Add the `"oauth2"` key (this is what `getAuthToken` reads): `{"client_id": "<your Client ID>.apps.googleusercontent.com", "scopes": ["openid", "email", "profile"]}`.
- Add a pinned `"key"` field for extension-ID stability (see gotcha above) — needed both for the Chrome Web Store listing later and to keep the Google Console client's registered ID matching your dev build.

`src/popup.ts`: add a "Sign in with Google" button. Handler:
- `chrome.identity.getAuthToken({interactive: true}, (token) => {...})` (or the promise form if you're targeting a Chrome version that supports it) to get the access token.
- POST `{access_token: token}` (naming it distinctly from your own JWT) to `/auth/google`.
- Store the returned JWT in `chrome.storage.local` (add a new `StorageKey`, consistent with the existing pattern for `BLOCKING_ENABLED`).
- Any future authenticated backend calls read this token and send `Authorization: Bearer <token>`.
- Note: if a sign-in ever needs to be revoked/switched to a different Google account, you'll want `chrome.identity.removeCachedAuthToken` before re-requesting — `getAuthToken` caches aggressively.

## 4. New dependencies

No `requirements.txt` exists for `backend/` yet (only `models/requirements.txt`) — create one now rather than relying on the ad-hoc-installed venv, listing what's already implicitly relied on (`fastapi`, `fastapi-users`, `sqlalchemy`, `asyncpg`, `python-dotenv`, `httpx`). No new package is needed for Google verification since you're using a plain HTTP call to the userinfo endpoint rather than JWT/ID-token verification.

## Verification

1. Start the backend locally, hit `POST /auth/google` with a captured access token (log it once from the extension during manual testing) and confirm you get back a JWT that works against `GET /users/me` with `Authorization: Bearer <token>`.
2. Load the extension unpacked, click the sign-in button, confirm `getAuthToken` returns a token without a redirect prompt (assuming the user is already signed into Chrome) and it round-trips to the backend successfully.
3. Test the find-or-create paths: a brand-new Google login (creates a user), and a Google login matching an existing password-based account's email (backfills `google_sub` instead of duplicating).
