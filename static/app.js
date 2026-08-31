// Register Map editor — state-driven, no framework.
//
// State shape:
//   { registers: [ { address, mnemonic, width, access, description,
//                    reset_value, bits: [ {position, name, width,
//                    access, description, reset_value} ] } ] }

const $ = (sel, root = document) => root.querySelector(sel);

const ACCESS_VALUES = new Set(["r", "w", "rw", ""]);

const state = { registers: [] };

const registerTpl = $("#register-tpl");
const bitTpl = $("#bit-tpl");

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function newRegister(overrides = {}) {
  const index = state.registers.length;
  const stride = 4;
  return Object.assign({
    address: "0x" + (index * stride).toString(16).toUpperCase().padStart(8, "0"),
    mnemonic: "",
    width: 32,
    access: "rw",
    description: "",
    reset_value: "",
    bits: [],
  }, overrides);
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

  // Bind scalar fields.
  node.querySelectorAll("[data-bind]").forEach((input) => {
    const key = input.dataset.bind;
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

  // Bits.
  const bitsEl = node.querySelector("[data-role=bits]");
  reg.bits.forEach((bit) => bitsEl.appendChild(renderBit(bit, node)));

  return node;
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
  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registers: state.registers }),
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
// form knows which keys to display.
function normalizeRegister(r) {
  const mnemonic = r.mnemonic ?? r.name ?? "";
  const out = {
    address: r.address ?? "",
    mnemonic,
    width: r.width ?? 32,
    access: ACCESS_VALUES.has(r.access) ? r.access : "rw",
    description: r.description ?? "",
    reset_value: r.reset_value ?? "",
    bits: Array.isArray(r.bits) ? r.bits.map(normalizeBit) : [],
  };
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
