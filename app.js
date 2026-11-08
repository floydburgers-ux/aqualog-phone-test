
const DB_NAME = "AquaLogDatabase";
const DB_VERSION = 2;
let db;
let syncTimer = null;
let syncInFlight = false;

const measurementFields = {
  temperature: "mTemp",
  ph: "mPh",
  kh: "mKh",
  gh: "mGh",
  no2: "mNo2",
  no3: "mNo3",
  po4: "mPo4",
  nh: "mNh",
  k: "mK",
  fe: "mFe",
  tds: "mTds",
  ec: "mEc"
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("measurements")) {
        const store = database.createObjectStore(
          "measurements",
          { keyPath: "id", autoIncrement: true }
        );
        store.createIndex("date", "date");
      }

      if (!database.objectStoreNames.contains("maintenance")) {
        database.createObjectStore(
          "maintenance",
          { keyPath: "id", autoIncrement: true }
        );
      }

      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore(
          "settings",
          { keyPath: "key" }
        );
      }

      if (!database.objectStoreNames.contains("doses")) {
        const store = database.createObjectStore("doses", { keyPath: "id", autoIncrement: true });
        store.createIndex("date", "date");
        store.createIndex("product", "product");
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function saveRecord(storeName, record) {
  return new Promise((resolve, reject) => {
    record.syncId ||= createSyncId();
    record.updatedAt ||= new Date().toISOString();
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).add(record);

    const recordId = () => request.result;
    transaction.oncomplete = () => {
      resolve(recordId());
      schedulePiSync();
    };
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function createSyncId() {
  return globalThis.crypto?.randomUUID?.() || "aql-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getSetting(key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("settings", "readonly");
    const request = transaction.objectStore("settings").get(key);

    request.onsuccess = () => resolve(request.result?.value);
    request.onerror = () => reject(request.error);
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("settings", "readwrite");
    const request = transaction.objectStore("settings").put({ key, value, updatedAt: new Date().toISOString() });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function prepareSyncRecords() {
  for (const name of ["measurements", "maintenance", "doses"]) {
    const records = await getAll(name);
    const missing = records.filter(record => !record.syncId || !record.updatedAt);
    if (!missing.length) continue;
    const transaction = db.transaction(name, "readwrite");
    for (const record of missing) transaction.objectStore(name).put({
      ...record,
      syncId: record.syncId || createSyncId(),
      updatedAt: record.updatedAt || new Date().toISOString()
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  const settings = await getAll("settings");
  const missingSettings = settings.filter(setting => !setting.updatedAt);
  if (missingSettings.length) {
    const transaction = db.transaction("settings", "readwrite");
    for (const setting of missingSettings) transaction.objectStore("settings").put({ ...setting, updatedAt: new Date().toISOString() });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

function localDateTime() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function showPage(page) {
  document.querySelectorAll(".page").forEach(element => {
    element.classList.remove("active");
  });

  document.getElementById(page).classList.add("active");

  if (page === "geschiedenis") renderHistory();
  if (page === "onderhoud") renderMaintenance();
  if (page === "dashboard") renderDashboard();
  if (page === "voeding") renderDosing();
}

document.getElementById("measurementForm").addEventListener("submit", async event => {
  event.preventDefault();

  const measurement = {
    date: document.getElementById("date").value,
    source: "manual",
    notes: document.getElementById("notes").value.trim(),
    values: {}
  };

  for (const [key, elementId] of Object.entries(measurementFields)) {
    const value = document.getElementById(elementId).value;
    measurement.values[key] = value === "" ? null : Number(value);
  }

  try {
    await saveRecord("measurements", measurement);
    event.target.reset();
    document.getElementById("date").value = localDateTime();

    await renderDashboard();
    await renderHistory();

    alert("Je watermeting is opgeslagen!");
    showPage("dashboard");
  } catch (error) {
    alert("Opslaan mislukt: " + error.message);
  }
});

async function renderDashboard() {
  const tankName = await getSetting("tankName");
  const microDose = await getSetting("microDose");
  const macroDose = await getSetting("macroDose");
  document.getElementById("dashboardTitle").textContent = tankName || "Mijn aquarium";
  document.getElementById("dashboardMicroDose").textContent =
    (microDose ?? 17) + " ml";
  document.getElementById("dashboardMacroDose").textContent =
    (macroDose ?? 17) + " ml";

  await renderStockSummary();

  const records = await getAll("measurements");
  records.sort((a, b) => b.date.localeCompare(a.date));

  const latest = records[0];

  const display = (id, value, unit = "") => {
    document.getElementById(id).textContent =
      value === null || value === undefined ? "-- " + unit : value + " " + unit;
  };

  if (!latest) {
    display("temperature", null, "°C");
    display("ph", null);
    display("kh", null, "°dKH");
    display("no3", null, "ppm");
    document.getElementById("lastActivity").textContent =
      "Nog geen metingen geregistreerd.";
    return;
  }

  const v = latest.values;

  display("temperature", v.temperature, "°C");
  display("ph", v.ph);
  display("kh", v.kh, "°dKH");
  display("no3", v.no3, "ppm");

  document.getElementById("lastActivity").textContent =
    "Laatste meting: " + new Date(latest.date).toLocaleString("nl-NL");
}

function numberSetting(key, fallback) {
  return getSetting(key).then(value => Number.isFinite(Number(value)) ? Number(value) : fallback);
}

async function renderStockSummary() {
  const [microStock, macroStock, microDose, macroDose, threshold, doses] = await Promise.all([
    numberSetting("microStock", 0), numberSetting("macroStock", 0),
    numberSetting("microDose", 17), numberSetting("macroDose", 17),
    numberSetting("lowStockDays", 7), getAll("doses")
  ]);
  const last = { micro: null, macro: null };
  doses.sort((a, b) => b.date.localeCompare(a.date));
  for (const dose of doses) if (last[dose.product] === null) last[dose.product] = dose;
  const stocks = { micro: microStock, macro: macroStock };
  const daily = { micro: microDose, macro: macroDose };
  for (const product of ["micro", "macro"]) {
    const days = daily[product] > 0 ? Math.floor(stocks[product] / daily[product]) : null;
    const name = product === "micro" ? "Micro" : "Macro";
    const stockEl = document.getElementById(product + "StockSummary");
    const daysEl = document.getElementById(product + "DaysSummary");
    if (stockEl) stockEl.textContent = stocks[product] + " ml";
    if (daysEl) daysEl.textContent = days === null ? "Dagdosering is 0 ml" : days + (days === 1 ? " dag voorraad" : " dagen voorraad");
    const pageStockEl = document.getElementById("dosing" + name + "StockSummary");
    const pageDaysEl = document.getElementById("dosing" + name + "DaysSummary");
    if (pageStockEl) pageStockEl.textContent = stocks[product] + " ml";
    if (pageDaysEl) pageDaysEl.textContent = days === null ? "dagdosering is 0 ml" : days + (days === 1 ? " dag voorraad" : " dagen voorraad");
    const alertEl = document.getElementById(product + "StockAlert");
    if (alertEl) {
      const low = stocks[product] <= 0 || (days !== null && days <= threshold);
      alertEl.hidden = !low;
      alertEl.textContent = stocks[product] <= 0 ? name + ": voorraad op. Vul de voorraad aan in Instellingen." : name + ": nog ongeveer " + days + " dagen voorraad.";
    }
    const doseEl = document.getElementById(product + "LastDose");
    if (doseEl) doseEl.textContent = last[product] ? new Date(last[product].date).toLocaleString("nl-NL") + " · " + last[product].amount + " ml" : "Nog geen dosering geregistreerd";
  }
}

document.getElementById("dosingForm").addEventListener("submit", async event => {
  event.preventDefault();
  const product = document.getElementById("doseProduct").value;
  const amount = Number(document.getElementById("doseAmount").value);
  const date = document.getElementById("doseDate").value;
  if (!Number.isFinite(amount) || amount <= 0 || !date) return alert("Vul een geldige hoeveelheid en datum in.");
  const stockKey = product + "Stock";
  const stock = await numberSetting(stockKey, 0);
  if (amount > stock && !confirm(`De geregistreerde dosering (${amount} ml) is groter dan de voorraad (${stock} ml). Toch opslaan?`)) return;
  try {
    await saveRecord("doses", { date, product, amount, note: document.getElementById("doseNote").value.trim(), schemaVersion: 1 });
    await setSetting(stockKey, Math.max(0, Math.round((stock - amount) * 100) / 100));
    event.target.reset();
    document.getElementById("doseDate").value = localDateTime();
    document.getElementById("doseAmount").value = await numberSetting(product + "Dose", 17);
    await renderDosing();
    await renderDashboard();
  } catch (error) { alert("Dosering opslaan mislukt: " + error.message); }
});

document.getElementById("doseProduct").addEventListener("change", async event => {
  const dose = await numberSetting(event.target.value + "Dose", 17);
  document.getElementById("doseAmount").value = dose;
});

async function renderDosing() {
  if (!db) return;
  const records = await getAll("doses");
  records.sort((a, b) => b.date.localeCompare(a.date));
  const container = document.getElementById("dosingHistory");
  container.replaceChildren();
  if (!records.length) { container.innerHTML = '<p class="muted">Nog geen doseringen geregistreerd.</p>'; }
  for (const record of records) {
    const entry = document.createElement("article"); entry.className = "entry";
    const heading = document.createElement("h3"); heading.textContent = (record.product === "micro" ? "Micro" : "Macro") + " · " + record.amount + " ml"; entry.appendChild(heading);
    const date = document.createElement("p"); date.textContent = new Date(record.date).toLocaleString("nl-NL"); entry.appendChild(date);
    if (record.note) { const note = document.createElement("p"); note.textContent = record.note; entry.appendChild(note); }
    container.appendChild(entry);
  }
  await renderStockSummary();
}

async function renderHistory() {
  const records = await getAll("measurements");
  records.sort((a, b) => b.date.localeCompare(a.date));

  const container = document.getElementById("history");

  if (!records.length) {
    container.innerHTML = '<p class="muted">Nog geen metingen opgeslagen.</p>';
    return;
  }

  container.replaceChildren();

  for (const record of records) {
    const entry = document.createElement("article");
    entry.className = "entry";

    const heading = document.createElement("h3");
    heading.textContent = new Date(record.date).toLocaleString("nl-NL");
    entry.appendChild(heading);

    const names = {
      temperature: "Temperatuur",
      ph: "pH",
      kh: "KH",
      gh: "GH",
      no2: "NO2",
      no3: "NO3",
      po4: "PO4",
      nh: "NH3/NH4",
      k: "Kalium",
      fe: "IJzer",
      tds: "TDS",
      ec: "EC"
    };

    for (const [key, value] of Object.entries(record.values)) {
      if (value !== null) {
        const p = document.createElement("p");
        p.textContent = names[key] + ": " + value;
        entry.appendChild(p);
      }
    }

    if (record.notes) {
      const note = document.createElement("p");
      note.textContent = "Opmerking: " + record.notes;
      entry.appendChild(note);
    }

    container.appendChild(entry);
  }
}

document.getElementById("maintenanceForm").addEventListener("submit", async event => {
  event.preventDefault();

  const record = {
    date: document.getElementById("maintenanceDate").value,
    type: document.getElementById("maintenanceType").value,
    notes: document.getElementById("maintenanceNotes").value.trim()
  };

  try {
    await saveRecord("maintenance", record);
    event.target.reset();
    document.getElementById("maintenanceDate").value =
      localDateTime().slice(0, 10);

    await renderMaintenance();
    alert("Onderhoud opgeslagen!");
  } catch (error) {
    alert("Opslaan mislukt: " + error.message);
  }
});

async function renderMaintenance() {
  const records = await getAll("maintenance");
  records.sort((a, b) => b.date.localeCompare(a.date));

  const container = document.getElementById("maintenanceHistory");
  container.replaceChildren();

  for (const record of records) {
    const entry = document.createElement("article");
    entry.className = "entry";

    const heading = document.createElement("h3");
    heading.textContent = record.type;
    entry.appendChild(heading);

    const date = document.createElement("p");
    date.textContent = record.date;
    entry.appendChild(date);

    if (record.notes) {
      const note = document.createElement("p");
      note.textContent = record.notes;
      entry.appendChild(note);
    }

    container.appendChild(entry);
  }
}

async function saveSettings() {
  const settings = {
    tankName: document.getElementById("tankName").value,
    targetPh: Number(document.getElementById("targetPh").value),
    targetTemp: Number(document.getElementById("targetTemp").value),
    microDose: Number(document.getElementById("microDose").value),
    macroDose: Number(document.getElementById("macroDose").value),
    microStock: Number(document.getElementById("microStock").value),
    macroStock: Number(document.getElementById("macroStock").value),
    lowStockDays: Number(document.getElementById("lowStockDays").value)
  };

  if (Object.values(settings).some(value => typeof value === "number" && (!Number.isFinite(value) || value < 0))) {
    alert("Gebruik voor hoeveelheden en voorraad een geldig getal van 0 of hoger."); return;
  }

  for (const [key, value] of Object.entries(settings)) {
    await setSetting(key, value);
  }

  await renderDashboard();
  await renderDosing();
  schedulePiSync();

  alert("Instellingen opgeslagen!");
}

async function loadSettings() {
  const keys = ["tankName", "targetPh", "targetTemp", "microDose", "macroDose", "microStock", "macroStock", "lowStockDays"];

  for (const key of keys) {
    const value = await getSetting(key);
    if (value !== undefined) {
      document.getElementById(key).value = value;
    }
  }
}

async function exportData() {
  const data = {
    app: "AquaLog",
    version: 1,
    format: "aqualog-backup",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    storage: { engine: "IndexedDB", database: DB_NAME, localOnly: true },
    migration: { entities: ["measurements", "maintenance", "doses", "settings"], idStrategy: "local-auto-increment; preserve exported ids" },
    measurements: await getAll("measurements"),
    maintenance: await getAll("maintenance"),
    doses: await getAll("doses"),
    settings: (await getAll("settings")).filter(item => !DEVICE_ONLY_SETTINGS.has(item.key))
  };

  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "AquaLog-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  link.click();
  URL.revokeObjectURL(url);
}

async function importData() {
  const input = document.getElementById("importFile");
  const file = input.files[0];

  if (!file) {
    alert("Selecteer eerst een back-upbestand.");
    return;
  }

  if (!confirm("Let op: importeren vervangt de bestaande gegevens. Maak eerst een back-up. Doorgaan?")) return;

  try {
    const data = JSON.parse(await file.text());

    if (data.app !== "AquaLog" || !Array.isArray(data.measurements) ||
        !Array.isArray(data.maintenance) || !Array.isArray(data.settings)) {
      throw new Error("Dit is geen geldige AquaLog-back-up.");
    }

    const transaction = db.transaction(
      ["measurements", "maintenance", "doses", "settings"],
      "readwrite"
    );

    for (const name of ["measurements", "maintenance", "doses", "settings"]) {
      transaction.objectStore(name).clear();
    }

    for (const record of data.measurements) {
      transaction.objectStore("measurements").put(record);
    }

    for (const record of data.maintenance) {
      transaction.objectStore("maintenance").put(record);
    }

    for (const record of (data.doses || [])) transaction.objectStore("doses").put(record);

    for (const record of data.settings) {
      transaction.objectStore("settings").put(record);
    }

    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await loadSettings();
    await renderDashboard();
    await renderHistory();
    await renderMaintenance();
    await renderDosing();

    alert("Back-up succesvol teruggezet!");
    input.value = "";
  } catch (error) {
    alert("Importeren mislukt: " + error.message);
  }
}

const DEVICE_ONLY_SETTINGS = new Set(["syncApiUrl", "syncToken"]);

async function syncSettingsFromForm() {
  await setSetting("syncApiUrl", document.getElementById("syncApiUrl").value.trim().replace(/\/+$/, ""));
  await setSetting("syncToken", document.getElementById("syncToken").value.trim());
}

function setSyncStatus(message) {
  const status = document.getElementById("syncStatus");
  const indicator = document.getElementById("syncIndicator");
  if (status) status.textContent = message;
  if (indicator) indicator.textContent = message.startsWith("Gesynchroniseerd") ? "● Pi bijgewerkt" :
    message.startsWith("Lokaal bewaard") ? "● Lokaal bewaard · Pi wacht" :
    message.startsWith("Niet verbonden") || message.startsWith("Synchronisatie mislukt") ? "● Lokaal · Pi niet bereikbaar" :
    message.startsWith("Verbonden") ? "● Pi verbonden" : "● " + message;
}

function schedulePiSync() {
  if (syncTimer) clearTimeout(syncTimer);
  getSetting("syncApiUrl").then(url => {
    if (!url) return;
    setSyncStatus("Lokaal bewaard · Pi synchroniseert zo…");
    syncTimer = setTimeout(() => syncWithRaspberry(), 350);
  }).catch(() => {});
}

async function raspberryRequest(path, options = {}) {
  const baseUrl = (await getSetting("syncApiUrl") || "").replace(/\/+$/, "");
  const token = await getSetting("syncToken") || "";
  if (!baseUrl) throw new Error("Vul eerst het HTTPS-adres van de Raspberry Pi in.");
  if (!token) throw new Error("Vul eerst de API-sleutel in die op de Raspberry Pi is ingesteld.");
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Verbinding mislukt (HTTP ${response.status}).`);
  return body;
}

async function testRaspberryConnection() {
  setSyncStatus("Verbinding testen…");
  try {
    await syncSettingsFromForm();
    const health = await raspberryRequest("/api/health");
    setSyncStatus(`Verbonden met AquaLog Pi API v${health.apiVersion || "?"}.`);
  } catch (error) { setSyncStatus("Niet verbonden: " + error.message); }
}

async function syncWithRaspberry() {
  if (syncInFlight) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncWithRaspberry, 500);
    return;
  }
  syncInFlight = true;
  setSyncStatus("Lokale gegevens voorbereiden…");
  try {
    await syncSettingsFromForm();
    await prepareSyncRecords();
    const settings = (await getAll("settings")).filter(item => !DEVICE_ONLY_SETTINGS.has(item.key));
    setSyncStatus("Synchroniseren…");
    const snapshot = await raspberryRequest("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        client: "AquaLog PWA",
        entities: {
          measurements: await getAll("measurements"),
          maintenance: await getAll("maintenance"),
          doses: await getAll("doses"),
          settings
        }
      })
    });
    await mergeRemoteSnapshot(snapshot.entities || {});
    await loadSettings();
    await renderDashboard();
    await renderHistory();
    await renderMaintenance();
    await renderDosing();
    const count = ["measurements", "maintenance", "doses"].reduce((sum, name) => sum + (snapshot.entities?.[name]?.length || 0), 0);
    setSyncStatus(`Gesynchroniseerd · ${count} aquariumregistraties · ${new Date().toLocaleString("nl-NL")}`);
  } catch (error) { setSyncStatus("Synchronisatie mislukt: " + error.message); }
  finally { syncInFlight = false; }
}

async function mergeRemoteSnapshot(entities) {
  for (const name of ["measurements", "maintenance", "doses"]) {
    const local = await getAll(name);
    const bySyncId = new Map(local.map(record => [record.syncId, record]));
    const transaction = db.transaction(name, "readwrite");
    const store = transaction.objectStore(name);
    for (const remote of entities[name] || []) {
      if (!remote.syncId) continue;
      const current = bySyncId.get(remote.syncId);
      if (current && String(current.updatedAt || "") >= String(remote.updatedAt || "")) continue;
      if (current) store.put({ ...remote, id: current.id });
      else {
        const { id, ...withoutLocalId } = remote;
        store.add(withoutLocalId);
      }
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  const localSettings = new Map((await getAll("settings")).map(setting => [setting.key, setting]));
  const transaction = db.transaction("settings", "readwrite");
  const settingStore = transaction.objectStore("settings");
  for (const remote of entities.settings || []) {
    if (!remote.key || DEVICE_ONLY_SETTINGS.has(remote.key)) continue;
    const current = localSettings.get(remote.key);
    if (!current || String(current.updatedAt || "") < String(remote.updatedAt || "")) settingStore.put(remote);
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function loadSyncSettings() {
  document.getElementById("syncApiUrl").value = await getSetting("syncApiUrl") || "";
  document.getElementById("syncToken").value = await getSetting("syncToken") || "";
}

document.getElementById("testSyncButton").addEventListener("click", testRaspberryConnection);
document.getElementById("syncNowButton").addEventListener("click", syncWithRaspberry);
window.addEventListener("online", schedulePiSync);

async function initialize() {
  try {
    await openDatabase();

    document.getElementById("date").value = localDateTime();
    document.getElementById("maintenanceDate").value =
      localDateTime().slice(0, 10);

    await loadSettings();
    await loadSyncSettings();
    await renderDashboard();
    await renderHistory();
    await renderMaintenance();
    document.getElementById("doseDate").value = localDateTime();
    document.getElementById("doseAmount").value = await numberSetting("microDose", 17);
    await renderDosing();
    if (await getSetting("syncApiUrl")) schedulePiSync();

    console.log("AquaLog database gestart.");
  } catch (error) {
    alert("AquaLog kon niet worden gestart: " + error.message);
  }
}

initialize();

const chartNames = {
  ph: "pH",
  temperature: "Temperatuur",
  kh: "KH",
  gh: "GH",
  no2: "NO2",
  no3: "NO3",
  po4: "PO4",
  nh: "NH3/NH4",
  k: "Kalium",
  fe: "IJzer",
  tds: "TDS",
  ec: "EC"
};

async function renderChart() {
  const canvas = document.getElementById("waterChart");
  if (!canvas || !db) return;

  const ctx = canvas.getContext("2d");
  const parameter = document.getElementById("chartParameter").value;
  const period = document.getElementById("chartPeriod").value;

  let records = await getAll("measurements");

  if (period !== "all") {
    const cutoff = Date.now() - Number(period) * 86400000;
    records = records.filter(r => new Date(r.date).getTime() >= cutoff);
  }

  records = records
    .filter(r => r.values[parameter] !== null &&
                 r.values[parameter] !== undefined &&
                 Number.isFinite(r.values[parameter]))
    .sort((a, b) => a.date.localeCompare(b.date));

  const info = document.getElementById("chartInfo");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(280, rect.width);
  const height = Math.max(200, rect.height);
  const ratio = window.devicePixelRatio || 1;

  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  ctx.clearRect(0, 0, width, height);

  if (!records.length) {
    info.textContent = "Geen metingen beschikbaar voor deze periode.";
    return;
  }

  const values = records.map(r => r.values[parameter]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = { left: 42, right: 15, top: 20, bottom: 35 };

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const range = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const low = min - range * 0.15;
  const high = max + range * 0.15;

  ctx.font = "11px Arial";
  ctx.textAlign = "right";
  ctx.fillStyle = "#91aaa8";
  ctx.strokeStyle = "#29454b";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = padding.top + plotHeight * i / 4;
    const value = high - (high - low) * i / 4;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(value.toFixed(2), padding.left - 6, y + 4);
  }

  const points = records.map((record, index) => ({
    x: padding.left + (records.length === 1 ? plotWidth / 2 :
      plotWidth * index / (records.length - 1)),
    y: padding.top + plotHeight -
      ((record.values[parameter] - low) / (high - low)) * plotHeight
  }));

  if (points.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = "#36c4b2";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";

    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });

    ctx.stroke();
  }

  points.forEach(point => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#36c4b2";
    ctx.fill();
  });

  ctx.textAlign = "center";
  ctx.fillStyle = "#91aaa8";

  const firstDate = new Date(records[0].date);
  const lastDate = new Date(records[records.length - 1].date);

  ctx.fillText(firstDate.toLocaleDateString("nl-NL"),
    padding.left, height - 10);

  if (records.length > 1) {
    ctx.fillText(lastDate.toLocaleDateString("nl-NL"),
      width - padding.right, height - 10);
  }

  info.textContent =
    records.length + " metingen | Minimum: " + min +
    " | Maximum: " + max + " | Laatste: " + values.at(-1);
}

document.getElementById("chartParameter")
  .addEventListener("change", renderChart);

document.getElementById("chartPeriod")
  .addEventListener("change", renderChart);

window.addEventListener("resize", () => {
  if (document.getElementById("grafieken").classList.contains("active")) {
    renderChart();
  }
});

const originalShowPage = showPage;

showPage = function(page) {
  originalShowPage(page);

  if (page === "grafieken") {
    renderChart();
  }
};

