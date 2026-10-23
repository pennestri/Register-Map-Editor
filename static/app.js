// Register Map editor — state-driven, no framework.
//
// State shape:
//   {
//     settings: {
//       addressIncrement: "0x4" | "4" | ...   // hex or decimal, displayed as typed
//       defaultWidth: 32,                     // bits
//       enabledFields: Set<"address"|"width"|"access"|"description"|"reset_value">
//       customFields: [ { key, type, default, options } ]   // see CUSTOM_FIELD_TYPES
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

// Custom-field types. `string` is the default and stores values as raw
// strings. `integer` / `float` parse to JS numbers and emit YAML scalars
// unquoted; this is what gives `version: 1` vs `version: "1"`. `select`
// renders a drop-down limited to a user-defined option list. `boolean`
// renders a checkbox and emits a real YAML `true` / `false`.
// Mirrors CUSTOM_FIELD_TYPES in app.py.
const CUSTOM_FIELD_TYPES = ["string", "integer", "float", "select", "boolean"];

// Types whose value control is a <select> rather than a free-text input.
const SELECT_LIKE_TYPES = new Set(["select"]);

// Words accepted as booleans, mirroring _coerce_typed_default() in app.py.
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);

// Normalise a raw options list (array, or a comma/newline separated string
// as typed in the settings UI) into a de-duplicated array of strings.
// Returns [] for anything that isn't an array or string.
function parseOptions(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") list = raw.split(/[,\n;]/);
  else return [];
  const out = [];
  for (const item of list) {
    const s = String(item).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Render an options array back into the comma separated form the settings
// text input edits.
function formatOptions(options) {
  return (Array.isArray(options) ? options : []).join(", ");
}

// Validate `raw` against `type`. Returns { ok, value } where `value` is the
// typed result on success (number for integer/float, boolean for boolean,
// string otherwise) or the original raw string when ok is false. Empty input
// always succeeds with an empty string so the user can leave a field unset.
// `opts.options` is the option list a `select` value is checked against.
function parseTypedValue(raw, type, opts) {
  const s = raw == null ? "" : String(raw);
  if (s === "") return { ok: true, value: "" };
  const t = type || "string";
  if (t === "string") return { ok: true, value: s };
  if (t === "integer") {
    const t2 = s.trim();
    if (!/^-?(0[xX][0-9a-fA-F]+|\d+)$/.test(t2)) return { ok: false, value: s };
    return { ok: true, value: parseInt(t2, 0) };
  }
  if (t === "float") {
    const n = Number(s.trim());
    if (!Number.isFinite(n)) return { ok: false, value: s };
    return { ok: true, value: n };
  }
  if (t === "boolean") {
    const w = s.trim().toLowerCase();
    if (TRUE_WORDS.has(w)) return { ok: true, value: true };
    if (FALSE_WORDS.has(w)) return { ok: true, value: false };
    return { ok: false, value: s };
  }
  if (t === "select") {
    const options = (opts && opts.options) || [];
    if (options.includes(s)) return { ok: true, value: s };
    return { ok: false, value: s };
  }
  return { ok: true, value: s };
}

// Coerce a stored value to a display string. Booleans come back as
// "true"/"false"; numbers as their natural string form ("42", "3.14");
// strings as-is.
function formatCustomValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && !Number.isFinite(v)) return "";
  return String(v);
}

// Read a stored value as a boolean. Returns true/false for anything
// recognisable, or undefined when the value is unset or unparseable.
function storedBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const w = String(v == null ? "" : v).trim().toLowerCase();
  if (w === "") return undefined;
  if (TRUE_WORDS.has(w)) return true;
  if (FALSE_WORDS.has(w)) return false;
  return undefined;
}

// Pick a sensible inputmode hint so mobile keyboards match the type.
function inputmodeForType(type) {
  if (type === "integer") return "numeric";
  if (type === "float") return "decimal";
  return "text";
}

// Placeholder for the settings "default value" input of a given type.
function defaultPlaceholder(type) {
  if (type === "integer") return "0 or 0x10";
  if (type === "float") return "0.0";
  if (type === "boolean") return "true / false";
  if (type === "select") return "default option";
  return "value";
}

function defaultSettings() {
  return {
    addressIncrement: "0x4",
    defaultWidth: 32,
    enabledFields: new Set(REGISTER_FIELDS),
    customFields: [], // [{ key, type, default, options }]
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
          .map((cf) => {
            const type = CUSTOM_FIELD_TYPES.includes(cf.type) ? cf.type : "string";
            const options = parseOptions(cf.options);
            // JSON has no integer/float/boolean types, so re-parse the stored
            // default against the declared type instead of keeping it as the
            // string JSON handed back.
            const parsed = parseTypedValue(cf.default, type, { options });
            return {
              key: cf.key,
              type,
              default: parsed.ok ? parsed.value
                                 : (type === "string" ? formatCustomValue(cf.default) : ""),
              options,
            };
          })
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
      customFields: state.settings.customFields.map((cf) => {
        const type = cf.type || "string";
        const entry = { key: cf.key, type, default: cf.default };
        if (SELECT_LIKE_TYPES.has(type)) entry.options = parseOptions(cf.options);
        return entry;
      }),
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
  const cfDef = state.settings.customFields.find((cf) => cf.key === key);
  const fromSettings = Boolean(cfDef);
  const type = cfDef ? (cfDef.type || "string") : "string";
  const row = document.createElement("div");
  row.className = "custom-row";

  const wrap = document.createElement("label");
  const keyEl = document.createElement("span");
  keyEl.className = "custom-key-name";
  keyEl.textContent = key + (fromSettings ? "" : " *");
  wrap.appendChild(keyEl);
  row.appendChild(wrap);

  const control = buildCustomValueControl(reg, key, type, regCardEl);
  row.appendChild(control);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.title = fromSettings
    ? (type === "boolean"
        ? "Leave this field unset (a checkbox can only hold true/false)"
        : "Clear value (delete the field in Settings to remove it everywhere)")
    : "Remove this field from this register";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const r = findRegister(regCardEl);
    if (fromSettings) {
      r[key] = "";
      clearCustomValueControl(control, type);
    } else {
      delete r[key];
      render();
    }
  });
  row.appendChild(remove);

  return row;
}

// Build the value control for a custom field, matching its declared type:
// free text for string/integer/float, a drop-down for select, a checkbox for
// boolean. The returned element is wired straight into the owning register.
function buildCustomValueControl(reg, key, type, regCardEl) {
  const cfDef = state.settings.customFields.find((cf) => cf.key === key);
  const options = cfDef ? parseOptions(cfDef.options) : [];

  if (SELECT_LIKE_TYPES.has(type)) {
    const select = document.createElement("select");
    select.className = "custom-value custom-select";
    select.title = cfDef && options.length
      ? "Pick one of the configured options"
      : "No options configured for this field yet";
    fillSelectOptions(select, options, reg[key]);
    select.addEventListener("change", () => {
      const r = findRegister(regCardEl);
      const parsed = parseTypedValue(select.value, "select", { options });
      // An empty pick means "unset"; anything the dropdown offered is valid.
      r[key] = parsed.ok ? parsed.value : select.value;
    });
    return select;
  }

  if (type === "boolean") {
    const lab = document.createElement("label");
    lab.className = "custom-bool";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = storedBool(reg[key]) === true;
    const text = document.createElement("span");
    text.textContent = storedBool(reg[key]) === true ? "true" : "false";
    lab.title = "Ticks store true, unticked stores false. Use × to leave the field unset.";
    box.addEventListener("change", () => {
      const r = findRegister(regCardEl);
      r[key] = box.checked;
      lab.classList.remove("unset");
      text.textContent = box.checked ? "true" : "false";
    });
    lab.appendChild(box);
    lab.appendChild(text);
    return lab;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "custom-value";
  input.value = formatCustomValue(reg[key]);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.inputMode = inputmodeForType(type);
  input.placeholder = type === "integer" ? "(integer)"
                    : type === "float"   ? "(float)"
                    :                        "(empty)";
  // Surface the type on the input for CSS hooks / tooltips.
  input.dataset.cfType = type;

  // If the stored value isn't valid for the configured type, mark the input
  // so the user can see it (e.g. a leftover string after switching the
  // field's type to integer). We don't auto-correct: the user can decide.
  const initialParsed = parseTypedValue(input.value, type);
  if (input.value !== "" && !initialParsed.ok) input.classList.add("input-error");

  input.addEventListener("input", () => {
    const r = findRegister(regCardEl);
    const raw = input.value;
    if (raw === "") {
      r[key] = "";
      input.classList.remove("input-error");
      return;
    }
    const parsed = parseTypedValue(raw, type);
    if (!parsed.ok) {
      input.classList.add("input-error");
      // Keep the raw string in state so the user doesn't lose their
      // typing — YAML will emit it as a string, which is recoverable.
      r[key] = raw;
      return;
    }
    input.classList.remove("input-error");
    r[key] = parsed.value;
  });
  return input;
}

// Populate a <select> with an "unset" entry plus the configured options.
// A stored value that is no longer in the option list is appended so
// editing the settings never silently drops data; it is flagged as unknown.
function fillSelectOptions(select, options, current) {
  const list = parseOptions(options);
  const cur = current == null ? "" : String(current);
  const orphan = cur !== "" && !list.includes(cur);
  if (orphan) list.push(cur);

  const unset = document.createElement("option");
  unset.value = "";
  unset.textContent = "— not set —";
  select.appendChild(unset);

  for (const opt of list) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt + (opt === cur && orphan ? " (unknown)" : "");
    select.appendChild(o);
  }
  select.value = cur;
}

// Reset a value control back to "unset". The × button on a settings-defined
// field calls this. A checkbox can't hold an empty value, so its caption
// switches to the unset marker and the row dims until the box is clicked
// again.
function clearCustomValueControl(control, type) {
  if (type === "boolean") {
    control.checked = false;
    const lab = control.closest("label");
    if (lab) {
      lab.classList.add("unset");
      const text = lab.querySelector("span");
      if (text) text.textContent = "— not set —";
    }
    return;
  }
  if (control.tagName === "SELECT") {
    control.value = "";
    return;
  }
  control.value = "";
  control.classList.remove("input-error");
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
  const payload = {
    registers: state.registers.map(projectForExport),
    settings: projectSettings(),
  };
  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    // Apply settings from the file if it carried any. A missing / null
    // `settings` field means the file is older or hand-written: leave the
    // editor's current settings untouched.
    let settingsApplied = false;
    if (data.settings && typeof data.settings === "object" && Object.keys(data.settings).length > 0) {
      settingsApplied = applyImportedSettings(data.settings);
    }
    render();
    if (settingsApplied) {
      setStatus(`Loaded ${regs.length} register(s) and applied settings from ${file.name}.`, "ok");
    } else {
      setStatus(`Loaded ${regs.length} register(s) from ${file.name}.`, "ok");
    }
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

// ---- Settings: custom fields sub-section -------------------------------

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

  const typeSelect = document.createElement("select");
  typeSelect.title = "Field type";
  for (const t of CUSTOM_FIELD_TYPES) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    if (t === (cf.type || "string")) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", () => {
    const newType = typeSelect.value;
    cf.type = newType;
    // Keep an option list around so switching back to select isn't a
    // re-typing exercise; it is only exported while type === "select".
    if (newType === "select" && parseOptions(cf.options).length === 0) {
      cf.options = cf.default ? [String(cf.default)] : [];
    }
    // Re-validate the existing default against the new type.
    const parsed = parseTypedValue(cf.default, newType, { options: cf.options });
    if (parsed.ok) {
      cf.default = parsed.value;
    } else {
      cf.default = "";
      setStatus(`Default value for "${cf.key}" is invalid for type ${newType}; cleared.`, "warn");
    }
    if (newType === "select" && parseOptions(cf.options).length === 0) {
      setStatus(`"${cf.key}" needs at least one option before a value can be set.`, "warn");
    }
    saveSettings();
    renderSettingsCustomFields();
    render();
  });
  row.appendChild(typeSelect);

  // Option list — only rendered for select fields; every other type lets the
  // default control stretch across the options column instead.
  const type = cf.type || "string";
  const isSelect = SELECT_LIKE_TYPES.has(type);
  if (isSelect) {
    const optInput = document.createElement("input");
    optInput.type = "text";
    optInput.className = "cf-options";
    optInput.value = formatOptions(cf.options);
    optInput.placeholder = "option a, option b";
    optInput.title = "Comma separated list of allowed values";
    optInput.spellcheck = false;
    optInput.autocomplete = "off";
    optInput.addEventListener("input", () => {
      const opts = parseOptions(optInput.value);
      cf.options = opts;
      // A default outside the new list can no longer be selected; flag it
      // instead of silently dropping the value.
      if (cf.default !== "" && !opts.includes(cf.default)) {
        optInput.classList.add("input-error");
        optInput.title = `Default "${formatCustomValue(cf.default)}" is not one of the options`;
      } else {
        optInput.classList.remove("input-error");
        optInput.title = "";
      }
      saveSettings();
      render(); // refresh the drop-downs on every register card
    });
    row.appendChild(optInput);
  }
  row.appendChild(buildSettingsDefaultControl(cf, !isSelect));

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

// The "default value" cell of a settings custom-field row. Free-text for
// string/integer/float, a fixed three-way select for boolean, and a select
// over the configured options for select fields. `spanTwo` stretches the
// control over the options column when the row has no options editor.
function buildSettingsDefaultControl(cf, spanTwo) {
  const type = cf.type || "string";

  if (type === "boolean") {
    const sel = document.createElement("select");
    sel.className = "cf-default" + (spanTwo ? " span2" : "");
    sel.title = "Default value for newly added registers";
    for (const pair of [["", "— not set —"], ["true", "true"], ["false", "false"]]) {
      const o = document.createElement("option");
      o.value = pair[0];
      o.textContent = pair[1];
      sel.appendChild(o);
    }
    const cur = storedBool(cf.default);
    sel.value = cur === undefined ? "" : String(cur);
    sel.addEventListener("change", () => {
      const b = storedBool(sel.value);
      cf.default = b === undefined ? "" : b;
      saveSettings();
    });
    return sel;
  }

  if (SELECT_LIKE_TYPES.has(type)) {
    const sel = document.createElement("select");
    sel.className = "cf-default";
    sel.title = "Default value for newly added registers";
    fillSelectOptions(sel, parseOptions(cf.options), cf.default);
    sel.addEventListener("change", () => {
      const parsed = parseTypedValue(sel.value, "select", { options: cf.options });
      cf.default = parsed.ok ? parsed.value : "";
      saveSettings();
    });
    return sel;
  }

  const defInput = document.createElement("input");
  defInput.type = "text";
  defInput.className = "cf-default" + (spanTwo ? " span2" : "");
  defInput.value = formatCustomValue(cf.default);
  defInput.placeholder = defaultPlaceholder(type);
  defInput.inputMode = inputmodeForType(type);
  defInput.spellcheck = false;
  defInput.autocomplete = "off";
  defInput.addEventListener("input", () => {
    const parsed = parseTypedValue(defInput.value, type, { options: cf.options });
    if (!parsed.ok) {
      defInput.classList.add("input-error");
      defInput.title = `Not a valid ${type}`;
      return;
    }
    defInput.classList.remove("input-error");
    defInput.title = "";
    cf.default = parsed.value;
    // Default applies to NEW registers only; existing values are preserved.
    saveSettings();
  });
  return defInput;
}

// Trigger re-sync of settings inputs (address increment, default width,
// field toggles, custom-fields list) from `state.settings`. Safe to call
// from anywhere; looks the inputs up in the DOM each invocation.
function syncSettingsUI() {
  const addrIncInput = $("#setting-addr-inc");
  const defaultWidthInput = $("#setting-default-width");
  const fieldCheckboxes = document.querySelectorAll("[data-setting-field]");
  if (addrIncInput) addrIncInput.value = state.settings.addressIncrement;
  if (defaultWidthInput) defaultWidthInput.value = state.settings.defaultWidth;
  fieldCheckboxes.forEach((cb) => {
    cb.checked = state.settings.enabledFields.has(cb.dataset.settingField);
  });
  renderSettingsCustomFields();
}

// Settings round-trip: serialize the current settings panel state to the
// shape written under register_map.settings in the YAML, and apply a
// settings object received from /upload back into the editor.
function projectSettings() {
  return {
    address_increment: state.settings.addressIncrement,
    default_width: state.settings.defaultWidth,
    enabled_fields: [...state.settings.enabledFields],
    custom_fields: state.settings.customFields.map((cf) => {
      const type = cf.type || "string";
      const entry = { key: cf.key, type, default: cf.default };
      // Options only matter for select fields; keeping the YAML tight.
      if (SELECT_LIKE_TYPES.has(type)) entry.options = parseOptions(cf.options);
      return entry;
    }),
  };
}

function applyImportedSettings(s) {
  if (!s || typeof s !== "object") return false;
  const base = defaultSettings();
  const newSettings = {
    addressIncrement: (() => {
      const inc = s.address_increment;
      if (typeof inc === "string" && inc.trim()) return inc.trim();
      if (typeof inc === "number" && Number.isFinite(inc)) return String(Math.trunc(inc));
      return base.addressIncrement;
    })(),
    defaultWidth: Number.isFinite(Number(s.default_width))
      ? Math.min(1024, Math.max(1, Math.floor(Number(s.default_width))))
      : base.defaultWidth,
    enabledFields: (() => {
      if (!Array.isArray(s.enabled_fields)) return new Set(base.enabledFields);
      if (s.enabled_fields.length === 0) return new Set(); // explicit "hide all"
      const filtered = s.enabled_fields.filter((k) => REGISTER_FIELDS.includes(k));
      // All entries were bogus — ignore and fall back to defaults.
      return new Set(filtered.length > 0 ? filtered : base.enabledFields);
    })(),
    customFields: (Array.isArray(s.custom_fields) ? s.custom_fields : [])
      .filter((cf) =>
        cf && typeof cf === "object" &&
        typeof cf.key === "string" && CF_KEY_RE.test(cf.key) &&
        !STANDARD_REGISTER_KEYS.has(cf.key))
      .map((cf) => {
        const type = CUSTOM_FIELD_TYPES.includes(cf.type) ? cf.type : "string";
        // Re-coerce the default against the declared type so the in-memory
        // state matches what the YAML actually said.
        const raw = cf.default == null ? "" : (typeof cf.default === "string"
          ? cf.default
          : formatCustomValue(cf.default));
        const options = parseOptions(cf.options);
        const parsed = parseTypedValue(raw, type, { options });
        return {
          key: cf.key,
          type,
          default: parsed.ok ? parsed.value : (type === "string" ? raw : ""),
          options,
        };
      }),
  };
  state.settings = newSettings;

  // For every existing register: if it lacks one of the imported custom
  // fields, populate it with the imported default. Existing values are
  // preserved (we don't overwrite user-edited data on the round trip).
  const importedDefaults = new Map(
    newSettings.customFields.map((cf) => [cf.key, cf.default ?? ""])
  );
  for (const r of state.registers) {
    for (const [k, def] of importedDefaults) {
      if (!(k in r)) r[k] = def;
    }
  }

  saveSettings();
  syncSettingsUI(); // refresh the panels to reflect the new state.
  return true;
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
  const newCfType = $("#new-cf-type");
  const newCfOptions = $("#new-cf-options");
  const newCfDefault = $("#new-cf-default");

  // syncSettingsUI is hoisted at the top level so applyImportedSettings
  // (also top-level) can call it after a YAML upload.
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
  const newCfTypeNow = () =>
    CUSTOM_FIELD_TYPES.includes(newCfType.value) ? newCfType.value : "string";

  // Keep the add-form in step with the picked type: the options box only
  // exists for select fields, and the default input's hint changes.
  function syncNewCfForm() {
    const t = newCfTypeNow();
    const isSelect = SELECT_LIKE_TYPES.has(t);
    newCfOptions.hidden = !isSelect;
    newCfDefault.placeholder = defaultPlaceholder(t);
    newCfDefault.inputMode = inputmodeForType(t);
    newCfDefault.classList.remove("input-error");
    newCfOptions.classList.remove("input-error");
  }
  syncNewCfForm();

  const validateNewCfDefault = () => {
    const t = newCfTypeNow();
    const options = parseOptions(newCfOptions.value);
    const parsed = parseTypedValue(newCfDefault.value, t, { options });
    newCfDefault.classList.toggle("input-error",
      !parsed.ok && newCfDefault.value !== "");
    newCfOptions.classList.toggle("input-error",
      SELECT_LIKE_TYPES.has(t) && options.length === 0);
    return parsed;
  };

  $("#add-cf").addEventListener("click", () => {
    const key = newCfKey.value.trim();
    const type = newCfTypeNow();
    const isSelect = SELECT_LIKE_TYPES.has(type);
    const options = isSelect ? parseOptions(newCfOptions.value) : [];
    const defRaw = newCfDefault.value;
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
    if (isSelect && options.length === 0) {
      setStatus("A select field needs at least one option.", "warn");
      newCfOptions.focus();
      return;
    }
    const parsed = parseTypedValue(defRaw, type, { options });
    if (!parsed.ok) {
      setStatus(isSelect
        ? `Default value must be one of: ${options.join(", ")}`
        : `Default value is not a valid ${type}.`, "warn");
      newCfDefault.focus();
      return;
    }
    state.settings.customFields.push({ key, type, default: parsed.value, options });
    saveSettings();
    for (const r of state.registers) {
      if (!(key in r)) r[key] = parsed.value;
    }
    newCfKey.value = "";
    newCfOptions.value = "";
    newCfDefault.value = "";
    syncNewCfForm();
    renderSettingsCustomFields();
    render();
  });
  // Live-validate the Add-form's default value as the user changes type.
  newCfType.addEventListener("change", () => {
    syncNewCfForm();
    validateNewCfDefault();
  });
  newCfDefault.addEventListener("input", validateNewCfDefault);
  newCfOptions.addEventListener("input", validateNewCfDefault);
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
