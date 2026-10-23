// Register Map editor — shared core.
//
// Loaded by BOTH the editor page (/) and the settings page (/settings).
// Classic scripts share one global lexical scope, so every top-level
// binding here is visible to settings.js and app.js — but it must be
// included first in the <script> order.
//
// Owns:
//   - the custom-field type system (parse / format / validate)
//   - the `state` object and its localStorage persistence
//   - the settings <-> YAML projection used by /generate and /upload
//
// State shape:
//   {
//     settings: {
//       addressIncrement: "0x4" | "4" | ...   // hex or decimal, displayed as typed
//       defaultWidth: 32,                     // bits
//       enabledFields: Set<"address"|"width"|"access"|"description"|"reset_value">
//       customFields: [ { key, type, default, options } ]   // see CUSTOM_FIELD_TYPES
//     },
//     registers: [ ... ]                      // editor page only
//   }

const $ = (sel, root = document) => root.querySelector(sel);

// Non-mnemonic register fields the user can toggle on the settings page.
// Mirrors TOGGLEABLE_REGISTER_FIELDS in app.py.
const REGISTER_FIELDS = ["address", "width", "access", "description", "reset_value"];
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

// Placeholder for a "default value" input of a given type.
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
  dirty: false,     // editor page only: registers changed since page load
};

// Restore persisted settings before either page renders anything, so the
// settings page shows stored values and the editor seeds registers with the
// stored defaults. Both pages load this file, so both benefit.
const restoredSettings = loadSettings();
if (restoredSettings) state.settings = restoredSettings;

// ---- Shared UI helpers ----------------------------------------------------

function setStatus(text, kind = "") {
  const el = $("#status");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

// Settings round-trip: the current settings-panel state in the shape written
// under register_map.settings in the YAML.
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

// Apply a settings object received from /upload into the editor. Mutates
// state, persists it, and seeds any register that is missing one of the
// imported custom fields. Callers are responsible for re-rendering their own
// UI afterwards (the settings page calls syncSettingsUI, the editor
// render()). Returns true when anything was applied.
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
        const raw = cf.default == null ? "" : formatCustomValue(cf.default);
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
  return true;
}