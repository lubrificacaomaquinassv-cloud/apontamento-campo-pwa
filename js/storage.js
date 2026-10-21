const DB_NAME = "campo_sv_v1";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("catalog")) {
        db.createObjectStore("catalog", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("active_turn")) {
        db.createObjectStore("active_turn", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("pending_sync")) {
        db.createObjectStore("pending_sync", { keyPath: "client_turn_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbPut(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const Storage = {
  async saveCatalog(key, data) {
    await idbPut("catalog", { key, data, updated_at: new Date().toISOString() });
  },
  async getCatalog(key) {
    const row = await idbGet("catalog", key);
    return row ? row.data : null;
  },
  async saveActiveTurn(state) {
    await idbPut("active_turn", { key: "current", ...state });
  },
  async getActiveTurn() {
    const row = await idbGet("active_turn", "current");
    return row || null;
  },
  async clearActiveTurn() {
    await idbDelete("active_turn", "current");
  },
};
