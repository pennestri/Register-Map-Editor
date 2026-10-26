// Register Map editor — editor page.
//
// Owns the register list, the bit rows and the toolbar (save, upload,
// export). The project's registers live on the server; this page edits a
// local copy and writes it back when you press Save.
//
// Expects core.js to be loaded first (it supplies the type helpers, `state`,
// the server plumbing and the dirty-tracking).

const ACCESS_VALUES = new Set(["r", "w", "rw", ""]);
const MNEMONIC_KEY = "mnemonic";

const registerTpl = $("#register-tpl");
const bitTpl = $("#bit-tpl");

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

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

  // One broken register must not hide all the others.
  state.registers.forEach((reg, i) => {
    try {
      root.appendChild(renderRegister(reg, i));
    } catch (err) {
      console.error(`Register #${i + 1} could not be rendered.`, err);
      const broken = document.createElement("div");
      broken.className = "reg-card reg-broken";
      broken.textContent = `Register #${i + 1} could not be shown: ${err.message}`;
      root.appendChild(broken);
    }
  });
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

  // Bits. A register that was stored without any bit rows has no 'bits'
  // key at all, so never assume it is there.
  const bitsEl = node.querySelector("[data-role=bits]");
  const bits = Array.isArray(reg.bits) ? reg.bits : [];
  reg.bits = bits;
  bits.forEach((bit) => bitsEl.appendChild(renderBit(bit, node)));

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

// Write the edited registers back to the server.
async function saveProject() {
  if (!state.project) {
    setStatus("No project is loaded, so there is nothing to save. Reload the page.", "err");
    reportProblem("No project is loaded, so saving is disabled. Reload the page (F5).");
    return;
  }
  const btn = $("#save");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const res = await apiPost(state.project.save_url, { registers: state.registers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || describeFailure(res));
    }
    const data = await res.json();
    markSaved();
    setStatus(`Saved ${data.register_count} register(s).`, "ok");
  } catch (err) {
    setStatus("Save failed: " + err.message, "err");
  } finally {
    if (btn) { btn.textContent = "Save"; btn.disabled = !state.dirty; }
  }
}

// Download what is on screen, saved or not: the registers are projected the
// same way the YAML export projects them, then handed to the server which
// renders the YAML.
async function downloadYaml() {
  if (!state.project) return;
  if (state.registers.length === 0) {
    setStatus("Add at least one register before exporting.", "warn");
    return;
  }
  const btn = $("#generate");
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  try {
    const res = await apiPost(state.project.export_url, {
      registers: state.registers.map(projectForExport),
      settings: projectSettings(),
    });
    if (!res.ok) throw new Error(describeFailure(res));
    const blob = await res.blob();
    triggerDownload(blob, yamlFilename());
    setStatus(`Exported ${state.registers.length} register(s) to YAML.`, "ok");
  } catch (err) {
    setStatus("Export failed: " + err.message, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Download YAML"; }
  }
}

function yamlFilename() {
  const name = (state.project && state.project.name) || "register_map";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (slug || "register_map") + ".yaml";
}

// Replace the project's registers with an uploaded YAML file. The server
// does the parsing; on success the page reloads so the editor shows exactly
// what was stored.
async function uploadYaml(file) {
  if (!file || !state.project) return;
  setStatus("Parsing " + file.name + "…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await apiPostForm(state.project.import_url, fd);
    if (res.redirected) {
      window.location.assign(res.url);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.reload();
  } catch (err) {
    setStatus("Upload failed: " + err.message, "err");
  }
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
  checkProjectLoaded();
  $("#add-register").addEventListener("click", addRegister);
  $("#clear-all").addEventListener("click", clearAll);
  $("#save").addEventListener("click", saveProject);
  $("#generate").addEventListener("click", downloadYaml);
  $("#upload-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    uploadYaml(file);
    e.target.value = ""; // allow re-uploading the same file
  });

  updateSaveState();
  render();
});
