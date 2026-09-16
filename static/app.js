// Register Map editor — state-driven, no framework.
//
// State shape:
//   {
//     settings: {
//       addressIncrement: "0x4" | "4" | ...   // hex or decimal, displayed as typed
//       defaultWidth: 32,                     // bits
//       enabledFields: Set<"address"|"width"|"access"|"description"|"reset_value">
//     },
//     registers: [ { address, mnemonic, width, access, description,
//                    reset_value, bits: [ {position, name, width,
//                    access, description, reset_value} ] } ]
//   }

const $ = (sel, root = document) => root.querySelector(sel);

const ACCESS_VALUES = new Set(["r", "w", "rw", ""]);

// ---- Settings -------------------------------------------------------------

// Non-mnemonic register fields the user can toggle on the settings panel.
const REGISTER_FIELDS = ["address", "width", "access", "description", "reset_value"];
const MNEMONIC_KEY = "mnemonic";
const SETTINGS_STORAGE_KEY = "register-map-editor:settings";

// Top-level keys we treat as "standard" on a register. Anything outside this
// set is a user-defined custom field and is preserved verbatim on export.
const STANDARD_REGISTER_KEYS = new Set([
  "address", "mnemonic", "width", "access", "description", "reset_value", "bits",
]);

const CF_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defaultSettings() {
  return {
    addressIncrement: "0x4",
    defaultWidth: 32,
    enabledFields: new Set(REGISTER_FIELDS),
    customFields: [], // [{ key, default }]
  };
}

// Parse a register-map address or increment: accepts "0xN" (hex) or "N" (dec).
// Returns NaN on failure so callers can fall back to a default.
function parseAddrNum(s) {
  if (typeof s !== "string") return NaN;
  const t = s.trim();
  if (!t) return NaN;
  const hex = /^0x([0-9a-f]+)$/i.exec(t);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return Number.isFinite(n) ? n : NaN;
  }
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return NaN;
}

// Format a numeric address back to the canonical "0xXXXXXXXX" string.
function formatAddr(n) {
  if (!Number.isFinite(n)) return "0x00000000";
  const v = Math.max(0, n);
  return "0x" + v.toString(16).toUpperCase().padStart(8, "0");
}

function getEffectiveAddrIncrement() {
  const n = parseAddrNum(state.settings.addressIncrement);
  return Number.isFinite(n) ? n : 4;
}

function getEffectiveDefaultWidth() {
  const n = Number(state.settings.defaultWidth);
  if (!Number.isFinite(n) || n < 1) return 32;
  return Math.min(1024, Math.max(1, Math.floor(n)));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const base = defaultSettings();
    const enabled = Array.isArray(data.enabledFields)
      ? data.enabledFields.filter((k) => REGISTER_FIELDS.includes(k))
      : [...base.enabledFields];
    const customFields = Array.isArray(data.customFields)
      ? data.customFields
          .filter((cf) =>
            cf && typeof cf === "object" &&
            typeof cf.key === "string" && CF_KEY_RE.test(cf.key) &&
            !STANDARD_REGISTER_KEYS.has(cf.key))
          .map((cf) => ({ key: cf.key, default: cf.default == null ? "" : String(cf.default) }))
      : [];
    return {
      addressIncrement: typeof data.addressIncrement === "string"
        ? data.addressIncrement
        : base.addressIncrement,
      defaultWidth: Number.isFinite(Number(data.defaultWidth))
        ? Number(data.defaultWidth)
        : base.defaultWidth,
      enabledFields: new Set(enabled),
      customFields,
    };
  } catch (e) {
    return null;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      addressIncrement: state.settings.addressIncrement,
      defaultWidth: state.settings.defaultWidth,
      enabledFields: [...state.settings.enabledFields],
      customFields: state.settings.customFields.map((cf) => ({ key: cf.key, default: cf.default })),
    }));
  } catch (e) { /* localStorage disabled or quota exceeded */ }
}

// ---- State ----------------------------------------------------------------

const state = {
  settings: defaultSettings(),
  registers: [],
};

const registerTpl = $("#register-tpl");
const bitTpl = $("#bit-tpl");

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function newRegister(overrides = {}) {
  // Default address = previous register's address + settings.addressIncrement.
  // Falls back to 0x00000000 when no prior register exists or its address
  // isn't a parseable hex/decimal number.
  const inc = getEffectiveAddrIncrement();
  let baseNum = 0;
  if (state.registers.length > 0) {
    const last = state.registers[state.registers.length - 1];
    const prev = parseAddrNum(last && last.address);
    if (Number.isFinite(prev)) baseNum = Math.max(0, prev + inc);
  }
  const reg = {
    address: formatAddr(baseNum),
    mnemonic: "",
    width: getEffectiveDefaultWidth(),
    access: "rw",
    description: "",
    reset_value: "",
    bits: [],
  };
  // Apply settings-defined custom fields as defaults. We don't overwrite
  // an explicit override — the caller may want to seed a register from a
  // YAML that already specified those keys.
  for (const cf of state.settings.customFields) {
    if (!cf.key) continue;
    if (!(cf.key in overrides)) reg[cf.key] = cf.default ?? "";
  }
  return Object.assign(reg, overrides);
}

function newBit(overrides = {}) {
  return Object.assign({
    position: 0,
    width: 1,
    name: "",
    access: "",
    description: "",
    reset_value: "",
  }, overrides);
}

function findRegister(cardEl) {
  const cards = [...document.querySelectorAll("[data-role=register]")];
  return state.registers[cards.indexOf(cardEl)];
}

function findBit(rowEl, regCardEl) {
  const rows = [...regCardEl.querySelectorAll("[data-role=bit]")];
  const reg = findRegister(regCardEl);
  return reg.bits[rows.indexOf(rowEl)];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const root = $("#registers");
  root.innerHTML = "";

  if (state.registers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No registers yet. Click “+ Add register” to start.";
    root.appendChild(empty);
    return;
  }

  state.registers.forEach((reg, i) => root.appendChild(renderRegister(reg, i)));
}

function renderRegister(reg, index) {
  const node = registerTpl.content.firstElementChild.cloneNode(true);
  node.querySelector("[data-role=index]").textContent = "#" + (index + 1);

  // Bind scalar fields. Hide any field that the user disabled in settings
  // (mnemonic is always shown because it's the register identifier).
  node.querySelectorAll("[data-bind]").forEach((input) => {
    const key = input.dataset.bind;
    if (key !== MNEMONIC_KEY && !state.settings.enabledFields.has(key)) {
      const wrapper = input.closest("label");
      if (wrapper) wrapper.hidden = true;
      else input.hidden = true;
      return;
    }
    if (!(key in reg)) return; // bind to bits only on the bit row
    if (input.type === "number") input.value = reg[key] ?? "";
    else if (input.tagName === "SELECT") input.value = reg[key] ?? "rw";
    else input.value = reg[key] ?? "";

    input.addEventListener("input", () => {
      const r = findRegister(node);
      r[key] = coerce(input, key);
    });
  });

  // Wire buttons.
  node.querySelector("[data-action=add-bit]").addEventListener("click", () => {
    const r = findRegister(node);
    r.bits.push(newBit({ position: nextBitPosition(r) }));
    render();
  });
  node.querySelector("[data-action=remove-register]").addEventListener("click", () => {
    const idx = [...document.querySelectorAll("[data-role=register]")].indexOf(node);
    if (idx >= 0) state.registers.splice(idx, 1);
    render();
  });

  // Custom fields (settings-defined first, then any extras on the register).
  const cfHost = node.querySelector("[data-role=custom-fields]");
  if (cfHost) renderCustomFields(reg, cfHost, node);

  // Bits.
  const bitsEl = node.querySelector("[data-role=bits]");
  reg.bits.forEach((bit) => bitsEl.appendChild(renderBit(bit, node)));

  return node;
}

function renderCustomFields(reg, host, regCardEl) {
  host.innerHTML = "";
  const shown = new Set();
  // Settings-defined fields first (in definition order).
  for (const cf of state.settings.customFields) {
    if (!cf.key) continue;
    if (!(cf.key in reg)) reg[cf.key] = cf.default ?? "";
    host.appendChild(renderCustomFieldRow(reg, cf.key, regCardEl));
    shown.add(cf.key);
  }
  // Then any extra non-standard top-level keys preserved from YAML upload.
  for (const k of Object.keys(reg)) {
    if (shown.has(k)) continue;
    if (STANDARD_REGISTER_KEYS.has(k)) continue;
    host.appendChild(renderCustomFieldRow(reg, k, regCardEl));
  }
}

function renderCustomFieldRow(reg, key, regCardEl) {
  const fromSettings = state.settings.customFields.some((cf) => cf.key === key);
  const row = document.createElement("div");
  row.className = "custom-row";

  const wrap = document.createElement("label");
  const keyEl = document.createElement("span");
  keyEl.className = "custom-key-name";
  keyEl.textContent = key;
  wrap.appendChild(keyEl);
  row.appendChild(wrap);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "custom-value";
  input.value = reg[key] == null ? "" : String(reg[key]);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "(empty)";
  input.addEventListener("input", () => {
    const r = findRegister(regCardEl);
    r[key] = input.value;
  });
  row.appendChild(input);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.title = fromSettings
    ? "Clear value (delete the field in Settings to remove it everywhere)"
    : "Remove this field from this register";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const r = findRegister(regCardEl);
    if (fromSettings) {
      r[key] = "";
      input.value = "";
    } else {
      delete r[key];
      render();
    }
  });
  row.appendChild(remove);

  return row;
}

function renderBit(bit, regCardEl) {
  const row = bitTpl.content.firstElementChild.cloneNode(true);
  row.querySelectorAll("[data-bind]").forEach((input) => {
    const key = input.dataset.bind;
    if (input.type === "number") input.value = bit[key] ?? "";
    else if (input.tagName === "SELECT") input.value = bit[key] ?? "";
    else input.value = bit[key] ?? "";

    input.addEventListener("input", () => {
      const b = findBit(row, regCardEl);
      b[key] = coerce(input, key);
    });
  });
  row.querySelector("[data-action=remove-bit]").addEventListener("click", () => {
    const rows = [...regCardEl.querySelectorAll("[data-role=bit]")];
    const idx = rows.indexOf(row);
    const reg = findRegister(regCardEl);
    if (idx >= 0) reg.bits.splice(idx, 1);
    render();
  });
  return row;
}

function nextBitPosition(reg) {
  if (!reg.bits || reg.bits.length === 0) return 0;
  return Math.max(...reg.bits.map((b) => Number(b.position) || 0)) + 1;
}

function coerce(input, key) {
  const raw = input.value;
  if (input.type === "number") {
    if (raw === "") return "";
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (input.tagName === "SELECT") return raw; // access enum
  if (key === "width") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Toolbar actions
// ---------------------------------------------------------------------------

function setStatus(text, kind = "") {
  const el = $("#status");
  el.hidden = false;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function addRegister() {
  state.registers.push(newRegister());
  render();
}

function clearAll() {
  if (state.registers.length === 0) return;
  if (!confirm("Remove all registers?")) return;
  state.registers = [];
  render();
}

async function downloadYaml() {
  if (state.registers.length === 0) {
    setStatus("Add at least one register before exporting.", "warn");
    return;
  }
  const payload = state.registers.map(projectForExport);
  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registers: payload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    triggerDownload(blob, "register_map.yaml");
    setStatus(`Exported ${state.registers.length} register(s) to register_map.yaml.`, "ok");
  } catch (exc) {
    setStatus("Export failed: " + exc.message, "err");
  }
}

async function uploadYaml(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  setStatus("Parsing " + file.name + "…");
  try {
    const res = await fetch("/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const regs = (data.registers || []).map(normalizeRegister);
    state.registers = regs;
    render();
    setStatus(`Loaded ${regs.length} register(s) from ${file.name}.`, "ok");
  } catch (exc) {
    setStatus("Upload failed: " + exc.message, "err");
  }
}

// When we read YAML back, we get whatever the user had — normalize so the
// form knows which keys to display. Unknown top-level keys are preserved
// as user-defined custom fields so they round-trip cleanly.
function normalizeRegister(r) {
  const mnemonic = r.mnemonic ?? r.name ?? "";
  const out = {
    address: r.address ?? "",
    mnemonic,
    width: r.width ?? 32,
    access: ACCESS_VALUES.has(r.access) ? r.access : "rw",
    description: r.description ?? "",
    reset_value: r.reset_value ?? "",
  };
  for (const [k, v] of Object.entries(r)) {
    if (STANDARD_REGISTER_KEYS.has(k)) continue;
    out[k] = v;
  }
  out.bits = Array.isArray(r.bits) ? r.bits.map(normalizeBit) : [];
  return out;
}

function normalizeBit(b) {
  return {
    position: b.position ?? 0,
    width: b.width ?? 1,
    name: b.name ?? "",
    access: ACCESS_VALUES.has(b.access) ? b.access : "",
    description: b.description ?? "",
    reset_value: b.reset_value ?? "",
  };
}

// ---- Settings: custom fields sub-section --------------------------------

function renderSettingsCustomFields() {
  const list = $("#settings-cf-list");
  if (!list) return;
  list.innerHTML = "";
  const cfs = state.settings.customFields;
  if (cfs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-mini";
    empty.textContent = "No custom fields defined. Add one below to make it appear on every register.";
    list.appendChild(empty);
    return;
  }
  for (const cf of cfs) list.appendChild(renderSettingsCustomFieldRow(cf));
}

function renderSettingsCustomFieldRow(cf) {
  const row = document.createElement("div");
  row.className = "settings-cf-row";

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.value = cf.key;
  keyInput.placeholder = "field name";
  keyInput.spellcheck = false;
  keyInput.autocomplete = "off";
  keyInput.addEventListener("input", () => {
    const newKey = keyInput.value.trim();
    if (!newKey || !CF_KEY_RE.test(newKey)) return; // ignore intermediate invalid
    if (newKey === cf.key) return;
    if (state.settings.customFields.some((x) => x !== cf && x.key === newKey)) {
      setStatus(`Custom field '${newKey}' is already defined.`, "warn");
      return;
    }
    const oldKey = cf.key;
    cf.key = newKey;
    for (const r of state.registers) {
      if (oldKey in r) {
        r[newKey] = r[oldKey];
        delete r[oldKey];
      }
    }
    saveSettings();
    renderSettingsCustomFields();
    render();
  });
  row.appendChild(keyInput);

  const defInput = document.createElement("input");
  defInput.type = "text";
  defInput.value = cf.default == null ? "" : String(cf.default);
  defInput.placeholder = "default value";
  defInput.spellcheck = false;
  defInput.autocomplete = "off";
  defInput.addEventListener("input", () => {
    cf.default = defInput.value;
    saveSettings();
    // Default applies to NEW registers only; existing values are preserved.
  });
  row.appendChild(defInput);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.title = "Remove this field from every register";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const idx = state.settings.customFields.indexOf(cf);
    if (idx < 0) return;
    if (!confirm(`Remove custom field "${cf.key}" from every register?`)) return;
    state.settings.customFields.splice(idx, 1);
    saveSettings();
    for (const r of state.registers) delete r[cf.key];
    renderSettingsCustomFields();
    render();
  });
  row.appendChild(remove);

  return row;
}

// Export projection: drop register fields the user has hidden in the
// settings panel. Mnemonic is always included. Custom fields (defined in
// settings or carried over from a YAML upload) are emitted in definition
// order, followed by any ad-hoc extras. Bit fields always go last.
function projectForExport(reg) {
  const standardOrder = ["address", MNEMONIC_KEY, "width", "access", "description", "reset_value"];
  const out = {};
  for (const key of standardOrder) {
    if (key === MNEMONIC_KEY || state.settings.enabledFields.has(key)) {
      if (reg[key] != null && reg[key] !== "") out[key] = reg[key];
    }
  }
  const emitted = new Set(Object.keys(out));
  // Settings-defined custom fields, in definition order.
  for (const cf of state.settings.customFields) {
    if (!cf.key) continue;
    const v = reg[cf.key];
    if (v != null && v !== "") {
      out[cf.key] = v;
      emitted.add(cf.key);
    }
  }
  // Any extra non-standard keys preserved from upload. (Standard keys
  // hidden by field-toggles stay hidden; only true custom fields are
  // picked up here.)
  for (const [k, v] of Object.entries(reg)) {
    if (STANDARD_REGISTER_KEYS.has(k)) continue;
    if (emitted.has(k)) continue;
    if (k === "bits") continue;
    if (v == null || v === "") continue;
    out[k] = v;
  }
  if (Array.isArray(reg.bits) && reg.bits.length) out.bits = reg.bits;
  return out;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // ---- Settings panel wiring -------------------------------------------
  // Restore persisted settings (must happen before the first newRegister()
  // call so the seed register honours them).
  const restored = loadSettings();
  if (restored) state.settings = restored;

  const addrIncInput = $("#setting-addr-inc");
  const defaultWidthInput = $("#setting-default-width");
  const fieldCheckboxes = document.querySelectorAll("[data-setting-field]");
  const cfList = $("#settings-cf-list");
  const newCfKey = $("#new-cf-key");
  const newCfDefault = $("#new-cf-default");

  function syncSettingsUI() {
    addrIncInput.value = state.settings.addressIncrement;
    defaultWidthInput.value = state.settings.defaultWidth;
    fieldCheckboxes.forEach((cb) => {
      cb.checked = state.settings.enabledFields.has(cb.dataset.settingField);
    });
    renderSettingsCustomFields();
  }
  syncSettingsUI();

  addrIncInput.addEventListener("input", () => {
    state.settings.addressIncrement = addrIncInput.value;
    saveSettings();
  });

  defaultWidthInput.addEventListener("input", () => {
    const n = Number(defaultWidthInput.value);
    state.settings.defaultWidth =
      Number.isFinite(n) && n >= 1 ? Math.min(1024, Math.floor(n)) : 32;
    saveSettings();
  });

  fieldCheckboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.settingField;
      if (cb.checked) state.settings.enabledFields.add(key);
      else state.settings.enabledFields.delete(key);
      saveSettings();
      render(); // re-render so existing register cards reflect the toggle
    });
  });

  $("#settings-reset").addEventListener("click", () => {
    if (!confirm("Reset register-map settings to defaults?")) return;
    // Drop any keys from every register that the previous settings had
    // defined as custom fields, so the editor matches the default schema.
    const previousKeys = new Set(
      state.settings.customFields.map((cf) => cf.key).filter(Boolean)
    );
    state.settings = defaultSettings();
    if (previousKeys.size > 0) {
      for (const r of state.registers) {
        for (const k of previousKeys) delete r[k];
      }
    }
    syncSettingsUI();
    saveSettings();
    render();
  });

  // ---- Custom-fields sub-section -----------------------------------------
  $("#add-cf").addEventListener("click", () => {
    const key = newCfKey.value.trim();
    const def = newCfDefault.value;
    if (!key) { setStatus("Custom field name is required.", "warn"); newCfKey.focus(); return; }
    if (!CF_KEY_RE.test(key)) {
      setStatus("Field name must be a valid identifier (letters, digits, underscore).", "warn");
      newCfKey.focus();
      return;
    }
    if (STANDARD_REGISTER_KEYS.has(key)) {
      setStatus(`'${key}' is a reserved name (use a different key).`, "warn");
      newCfKey.focus();
      return;
    }
    if (state.settings.customFields.some((cf) => cf.key === key)) {
      setStatus(`Custom field '${key}' is already defined.`, "warn");
      newCfKey.focus();
      return;
    }
    state.settings.customFields.push({ key, default: def });
    saveSettings();
    for (const r of state.registers) {
      if (!(key in r)) r[key] = def;
    }
    newCfKey.value = "";
    newCfDefault.value = "";
    renderSettingsCustomFields();
    render();
  });
  newCfKey.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#add-cf").click(); } });
  newCfDefault.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#add-cf").click(); } });

  // ---- Toolbar wiring ---------------------------------------------------
  $("#add-register").addEventListener("click", addRegister);
  $("#clear-all").addEventListener("click", clearAll);
  $("#generate").addEventListener("click", downloadYaml);
  $("#upload-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    uploadYaml(file);
    e.target.value = ""; // allow re-uploading the same file
  });

  // Seed with one register so the page isn't empty on first load.
  state.registers = [newRegister({ mnemonic: "CTRL" })];
  render();
});
