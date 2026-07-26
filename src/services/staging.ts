import {
    MAX_HTML_BYTES, STAGING_DB_NAME, STAGING_DB_VERSION, STORE_HTML, STORE_META,
} from "../shared/constants.js";
import type { PageLabel, StagedPageMeta } from "../shared/types.js";

/**
 * Two object stores, deliberately. The popup lists staged pages on every open; if the
 * multi-MB HTML lived in the same record, listing would deserialize tens of MB just to render
 * a count. `staged_html` is only ever touched by the uploader.
 *
 * IndexedDB transactions auto-commit once the microtask queue drains, so nothing here may
 * await a non-IDB promise mid-transaction. The uploader reads HTML, closes the transaction,
 * fetches, then deletes in a fresh one.
 */

let dbPromise: Promise<IDBDatabase> | null = null;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
}

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(STAGING_DB_NAME, STAGING_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_META)) {
                const meta = db.createObjectStore(STORE_META, { keyPath: "id" });
                meta.createIndex("by_url", "url", { unique: false });
                meta.createIndex("by_status", "status", { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_HTML)) {
                db.createObjectStore(STORE_HTML, { keyPath: "id" });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // Don't cache a handle that has been closed out from under us.
            db.onclose = () => { dbPromise = null; };
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    }).catch((e) => {
        dbPromise = null;
        throw e;
    });

    return dbPromise;
}

export async function stagePage(rec: {
    raw_url: string;
    url: string;
    title: string;
    label: PageLabel;
    captured_at: string;
    html: string;
}): Promise<StagedPageMeta> {
    const html_bytes = new Blob([rec.html]).size;
    if (html_bytes > MAX_HTML_BYTES) {
        throw new Error(`Page is too large to stage (${Math.round(html_bytes / 1e6)} MB).`);
    }

    const db = await openDb();
    const tx = db.transaction([STORE_META, STORE_HTML], "readwrite");
    const metaStore = tx.objectStore(STORE_META);
    const htmlStore = tx.objectStore(STORE_HTML);

    // Dedupe by normalized URL, mirroring the backend's upsert on the unique `pages.url`.
    // Re-donating a page (e.g. to correct its label) replaces the staged copy.
    const existing = await promisify(metaStore.index("by_url").getAllKeys(rec.url));
    for (const key of existing) {
        metaStore.delete(key);
        htmlStore.delete(key);
    }

    const meta: StagedPageMeta = {
        id: crypto.randomUUID(),
        raw_url: rec.raw_url,
        url: rec.url,
        title: rec.title,
        label: rec.label,
        captured_at: rec.captured_at,
        html_bytes,
        status: "pending",
        attempts: 0,
    };
    metaStore.put(meta);
    htmlStore.put({ id: meta.id, html: rec.html });

    await txDone(tx);
    return meta;
}

export async function listStaged(): Promise<StagedPageMeta[]> {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readonly");
    const all = await promisify(tx.objectStore(STORE_META).getAll() as IDBRequest<StagedPageMeta[]>);
    return all.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
}

export async function countStaged(): Promise<number> {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readonly");
    return promisify(tx.objectStore(STORE_META).count());
}

export async function getStagedHtml(id: string): Promise<string | null> {
    const db = await openDb();
    const tx = db.transaction(STORE_HTML, "readonly");
    const rec = await promisify(tx.objectStore(STORE_HTML).get(id) as IDBRequest<{ html: string } | undefined>);
    return rec?.html ?? null;
}

export async function nextPending(): Promise<StagedPageMeta | null> {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readonly");
    const pending = await promisify(
        tx.objectStore(STORE_META).index("by_status").getAll("pending") as IDBRequest<StagedPageMeta[]>,
    );
    if (pending.length === 0) return null;
    return pending.sort((a, b) => a.captured_at.localeCompare(b.captured_at))[0]!;
}

export async function updateStaged(id: string, patch: Partial<StagedPageMeta>): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readwrite");
    const store = tx.objectStore(STORE_META);
    const current = await promisify(store.get(id) as IDBRequest<StagedPageMeta | undefined>);
    if (current) store.put({ ...current, ...patch });
    await txDone(tx);
}

export async function removeStaged(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([STORE_META, STORE_HTML], "readwrite");
    tx.objectStore(STORE_META).delete(id);
    tx.objectStore(STORE_HTML).delete(id);
    await txDone(tx);
}

export async function clearStaged(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([STORE_META, STORE_HTML], "readwrite");
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_HTML).clear();
    await txDone(tx);
}

/** Recovery after a service-worker kill: anything left mid-flight becomes retryable. */
export async function resetInFlight(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readwrite");
    const store = tx.objectStore(STORE_META);
    const stuck = await promisify(
        store.index("by_status").getAll("uploading") as IDBRequest<StagedPageMeta[]>,
    );
    for (const rec of stuck) store.put({ ...rec, status: "pending" });
    await txDone(tx);
}

/** Clears the error/attempt state on a failed record so the next batch picks it up again. */
export async function retryStaged(id: string): Promise<void> {
    await updateStaged(id, { status: "pending", attempts: 0, error: undefined });
}
