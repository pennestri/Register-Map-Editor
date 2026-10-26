// Register Map editor — shared core.
//
// Loaded by both the editor page and the settings page. Classic scripts
// share one global lexical scope, so every top-level binding here is
// visible to editor.js and settings.js — but core.js must be included first.
//
// The project (registers + settings) lives on the server. Each page gets
// its copy embedded in a <script id="project-data" type="application/json">
// block and writes changes back with fetch().
//
// Owns:
//   - the custom-field type system (parse / format / validate)
//   - the `state` object
//   - the settings <-> JSON projection used by the save and export endpoints

const $ = (sel, root = document) => root.querySelector(sel);

// Non-mnemonic register fields the user can toggle on the settings page.
// Mirrors TOGGLEABLE_REGISTER_FIELDS in registermap/yamlio.py.
const REGISTER_FIELDS = ["address", "width", "access", "description", "reset_value"];

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
// Mirrors CUSTOM_FIELD_TYPES in registermap/yamlio.py.
const CUSTOM_FIELD_TYPES = ["string", "integer", "float", "select", "boolean"];

// Types whose value control is a <select> rather than a free-text input.
const SELECT_LIKE_TYPES = new Set(["select"]);

// Words accepted as booleans, mirroring coerce_typed_default() in yamlio.py.
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);

// ---- Type system ---------------------------------------------------------

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

// Turn the settings the server sent into the shape the editor works with.
function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const enabled = Array.isArray(raw.enabled_fields)
    ? raw.enabled_fields.filter((k) => REGISTER_FIELDS.includes(k))
    : [...base.enabledFields];
  const customFields = (Array.isArray(raw.custom_fields) ? raw.custom_fields : [])
    .filter((cf) =>
      cf && typeof cf === "object" &&
      typeof cf.key === "string" && CF_KEY_RE.test(cf.key) &&
      !STANDARD_REGISTER_KEYS.has(cf.key))
    .map((cf) => {
      const type = CUSTOM_FIELD_TYPES.includes(cf.type) ? cf.type : "string";
      const options = parseOptions(cf.options);
      const parsed = parseTypedValue(cf.default, type, { options });
      return {
        key: cf.key,
        type,
        default: parsed.ok ? parsed.value
                           : (type === "string" ? formatCustomValue(cf.default) : ""),
        options,
      };
    });
  return {
    addressIncrement: typeof raw.address_increment === "string"
      ? raw.address_increment
      : base.addressIncrement,
    defaultWidth: Number.isFinite(Number(raw.default_width))
      ? Number(raw.default_width)
      : base.defaultWidth,
    enabledFields: new Set(enabled),
    customFields,
  };
}

// ---- Project data --------------------------------------------------------

// Read the project the server embedded in this page. A parse failure is
// recorded rather than thrown: the page still has to render, and the error
// has to reach the user instead of leaving a dead Save button behind.
function readProjectData() {
  const el = document.getElementById("project-data");
  if (!el) return { project: null, settings: {}, registers: [], error: null };
  try {
    const data = JSON.parse(el.textContent);
    if (!data || typeof data !== "object") {
      return { project: null, settings: {}, registers: [], error: "malformed" };
    }
    return {
      project: data.project || null,
      settings: data.settings || {},
      registers: Array.isArray(data.registers) ? data.registers : [],
      error: null,
    };
  } catch (e) {
    console.error("Could not read the embedded project data.", e);
    return { project: null, settings: {}, registers: [], error: "unreadable" };
  }
}

const PROJECT_DATA = readProjectData();

const state = {
  project: PROJECT_DATA.project || null,
  settings: normalizeSettings(PROJECT_DATA.settings),
  registers: PROJECT_DATA.registers,
  dirty: false,     // there are unsaved changes
  problem: PROJECT_DATA.error,   // why the page can't work, if it can't
};

// Show a problem where the user will actually see it.
function reportProblem(message) {
  let banner = document.getElementById("page-problem");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "page-problem";
    banner.className = "page-problem";
    (document.body || document.documentElement).appendChild(banner);
  }
  banner.textContent = message;
  banner.hidden = false;
}

// The editor and the settings page both need a project. Without one the
// Save buttons cannot work, so say so instead of failing quietly.
function checkProjectLoaded() {
  if (state.problem === "unreadable") {
    reportProblem("This page could not read the project data. Reload it (F5) — if it keeps happening, the server is serving an outdated version of the page.");
    return false;
  }
  if (state.problem === "malformed" || (!state.project && document.getElementById("project-data"))) {
    reportProblem("This page has no project loaded, so saving is disabled. Reload it (F5).");
    return false;
  }
  return true;
}

// ---- Server plumbing -----------------------------------------------------

function csrfToken() {
  // The token rendered into the page is the most reliable source: the
  // cookie can be missing (cleared, or set on another host name).
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta && meta.content) return meta.content;
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

// Turn a failed response into a message that says what to do about it.
function describeFailure(res) {
  if (res.status === 403) {
    return "the server rejected the request (HTTP 403). Reload the page (F5) and save again — this is usually a stale page or a missing cookie.";
  }
  if (res.status === 404) {
    return "the project no longer exists (HTTP 404). Go back to the dashboard.";
  }
  return `HTTP ${res.status}`;
}

// POST a JSON body. Returns the raw Response so callers can pick the status
// and the body apart.
function apiPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": csrfToken(),
    },
    body: JSON.stringify(body),
  });
}

// POST a multipart body (file upload). The Accept header makes the server
// answer with JSON errors instead of a re-displayed form.
function apiPostForm(url, formData) {
  return fetch(url, {
    method: "POST",
    headers: { "X-CSRFToken": csrfToken(), "Accept": "application/json" },
    body: formData,
  });
}

// ---- Save state ----------------------------------------------------------

function setStatus(text, kind = "") {
  const el = $("#status");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function updateSaveState() {
  const el = $("#save-state");
  if (el) {
    const text = state.dirty ? "unsaved changes" : "saved";
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("dirty", state.dirty);
  }
  // The editor saves the registers, the settings page saves the settings.
  const saveBtn = $("#save");
  if (saveBtn) saveBtn.disabled = !state.dirty;
  const settingsBtn = $("#save-settings");
  if (settingsBtn) settingsBtn.disabled = !state.dirty;
}

function markDirty() {
  state.dirty = true;
  updateSaveState();
}

function markSaved() {
  state.dirty = false;
  updateSaveState();
}

// Any edit makes the page dirty; leaving a dirty page asks first.
document.addEventListener("input", markDirty, true);
document.addEventListener("change", markDirty, true);
document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest("[data-action]")) markDirty();
}, true);
window.addEventListener("beforeunload", (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---- Settings persistence ------------------------------------------------

// The settings page does NOT save on every keystroke: changes stay local
// until you press Save. The revision counter makes sure a slow response
// never overwrites newer edits.
let settingsRevision = 0;

function markSettingsDirty() {
  settingsRevision++;
  markDirty();
}

async function saveSettingsNow() {
  if (!state.project || !state.project.settings_save_url) {
    setStatus("No project is loaded, so there is nothing to save. Reload the page.", "err");
    reportProblem("No project is loaded, so saving is disabled. Reload the page (F5).");
    return;
  }
  const revision = settingsRevision;
  const btn = $("#save-settings");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const res = await apiPost(state.project.settings_save_url, {
      settings: projectSettings(),
    });
    if (!res.ok) throw new Error(describeFailure(res));
    const data = await res.json();
    // Only adopt the server's coerced copy if nothing changed meanwhile.
    if (revision === settingsRevision) {
      state.settings = normalizeSettings(data.settings);
    }
    markSaved();
    setStatus("Settings saved.", "ok");
  } catch (err) {
    setStatus("Could not save settings: " + err.message, "err");
  } finally {
    if (btn) { btn.textContent = "Save settings"; btn.disabled = !state.dirty; }
  }
}

// Settings round-trip: the current settings-panel state in the shape the
// server stores (and the YAML carries).
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
