const DB_NAME = "resit";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("expenses")) {
        const store = db.createObjectStore("expenses", { keyPath: "id", autoIncrement: true });
        store.createIndex("byDate", "date");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return getDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

const DB = {
  addExpense(exp) { return tx("expenses", "readwrite", s => s.add(exp)); },
  updateExpense(exp) { return tx("expenses", "readwrite", s => s.put(exp)); },
  deleteExpense(id) { return tx("expenses", "readwrite", s => s.delete(id)); },
  getAllExpenses() {
    return getDB().then(db => new Promise((resolve, reject) => {
      const req = db.transaction("expenses").objectStore("expenses").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  },
  getSetting(key, fallback) {
    return getDB().then(db => new Promise((resolve) => {
      const req = db.transaction("settings").objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => resolve(fallback);
    }));
  },
  setSetting(key, value) { return tx("settings", "readwrite", s => s.put({ key, value })); },
  eraseAll() {
    return getDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(["expenses", "settings"], "readwrite");
      t.objectStore("expenses").clear();
      t.objectStore("settings").clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }
};
