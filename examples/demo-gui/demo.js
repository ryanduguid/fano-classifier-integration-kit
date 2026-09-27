// Fano Classifier — demo GUI JS module
// Plain ES module; no build step; no framework. Tested in modern Chromium + Firefox.
// Author: ClawDog (mc13-2026-06-25).
// The key stays in the input, with best-effort localStorage persistence.
// Requests use the configured endpoint and reject redirects; the key is not logged.

/** Preset payloads — mirror examples/canonical-fixtures/. */
const PRESETS = {
  "bank-accounts": {
    label: "KC1 · Bank Accounts",
    entity: "company",
    lines: [
      probeLine("Bank Accounts", "sbrm_0000", "current_assets", 100.0),
      balancingLine(),
    ],
  },
  "drawings": {
    label: "KC2 · Drawings (firewall polarity)",
    entity: "company",
    lines: [
      probeLine("Drawings", "sbrm_0000", "current_assets", 100.0),
      balancingLine(),
    ],
  },
  "loans-beneficiaries": {
    label: "KC6 · Loans to Beneficiaries (sub-floor)",
    entity: "company",
    lines: [
      probeLine("Loans to Beneficiaries", "sbrm_0000", "current_assets", 100.0),
      balancingLine(),
    ],
  },
};

function probeLine(description, predicted_code, source_topology, amount) {
  return {
    description,
    predicted_code,
    source_topology,
    confidence: 0.5,
    amount,
  };
}

function balancingLine() {
  return {
    description: "Sales Income",
    predicted_code: "sbrm_4110",
    source_topology: "revenue",
    confidence: 0.95,
    amount: -100.0,
  };
}

/** ============================================================================
 * DOM wiring
 * ========================================================================= */

const els = {
  baseUrl: document.getElementById("base-url"),
  apiKey: document.getElementById("api-key"),
  entity: document.getElementById("entity"),
  linesTbody: document.querySelector("#lines tbody"),
  addLine: document.getElementById("add-line"),
  fire: document.getElementById("fire"),
  netBalance: document.getElementById("net-balance"),
  statusLine: document.getElementById("status-line"),
  results: document.getElementById("results"),
  rawResponse: document.getElementById("raw-response"),
  rawPayload: document.getElementById("raw-payload"),
};

// Restore last-used inputs from localStorage (BYO key UX).
const LS_KEYS = {
  baseUrl: "fano-demo:base-url",
  apiKey: "fano-demo:api-key",
};
for (const name of ["baseUrl", "apiKey"]) {
  try {
    const saved = localStorage.getItem(LS_KEYS[name]);
    if (saved) els[name].value = saved;
  } catch {
    // Storage can be denied by browser policy; manual input still works.
  }
  els[name].addEventListener("change", () => {
    try {
      localStorage.setItem(LS_KEYS[name], els[name].value);
    } catch {
      // Keep the current input usable when persistence is unavailable.
    }
  });
}

// Initial preset load.
loadPreset("drawings");

els.addLine.addEventListener("click", () => {
  addLineRow(probeLine("", "sbrm_0000", "current_assets", 0));
});
els.fire.addEventListener("click", fire);

document.querySelectorAll("button.preset").forEach((btn) => {
  btn.addEventListener("click", () => loadPreset(btn.dataset.preset));
});

/** ============================================================================
 * Lines table
 * ========================================================================= */

function loadPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.entity.value = preset.entity;
  els.linesTbody.innerHTML = "";
  preset.lines.forEach(addLineRow);
  recomputeNetBalance();
}

function addLineRow(line) {
  const tr = document.createElement("tr");
  const TOPOLOGIES = [
    "current_assets", "non_current_assets",
    "current_liabilities", "non_current_liabilities",
    "equity", "revenue", "expenses",
  ];
  tr.innerHTML = `
    <td><input type="text" class="line-desc" value="${escapeHtml(line.description)}"></td>
    <td><input type="text" class="line-code" value="${escapeHtml(line.predicted_code)}" pattern="^sbrm_\\d+$"></td>
    <td>
      <select class="line-topo">
        ${TOPOLOGIES.map((t) => `<option value="${t}"${t === line.source_topology ? " selected" : ""}>${t}</option>`).join("")}
      </select>
    </td>
    <td><input type="number" class="line-conf" min="0" max="1" step="0.01" value="${line.confidence}"></td>
    <td><input type="number" class="line-amount" step="0.01" value="${line.amount}"></td>
    <td><button class="line-remove danger" type="button">×</button></td>
  `;
  tr.querySelector(".line-remove").addEventListener("click", () => {
    tr.remove();
    recomputeNetBalance();
  });
  tr.querySelector(".line-amount").addEventListener("input", recomputeNetBalance);
  els.linesTbody.appendChild(tr);
  recomputeNetBalance();
}

function readLines() {
  return Array.from(els.linesTbody.querySelectorAll("tr")).map((tr) => ({
    description: tr.querySelector(".line-desc").value,
    predicted_code: tr.querySelector(".line-code").value,
    source_topology: tr.querySelector(".line-topo").value,
    confidence: parseFloat(tr.querySelector(".line-conf").value || "0"),
    amount: parseFloat(tr.querySelector(".line-amount").value || "0"),
  }));
}

function recomputeNetBalance() {
  const lines = readLines();
  const net = lines.reduce((sum, l) => sum + (Number.isFinite(l.amount) ? l.amount : 0), 0);
  const balanced = Math.abs(net) <= 0.01;
  els.netBalance.textContent = `net_balance = ${net.toFixed(2)} (${balanced ? "balanced ✓" : "UNBALANCED — Fano will reject with 400"})`;
  els.netBalance.classList.toggle("balanced", balanced);
  els.netBalance.classList.toggle("unbalanced", !balanced);
}

/** ============================================================================
 * Fire request
 * ========================================================================= */

async function fire() {
  const baseUrl = els.baseUrl.value.replace(/\/$/, "");
  const apiKey = els.apiKey.value.trim();
  const entity = els.entity.value;
  const lines = readLines();

  if (!apiKey) {
    setStatus("fail", "API key required (X-API-Key header).");
    return;
  }
  if (!lines.length) {
    setStatus("fail", "At least one line required.");
    return;
  }

  const payload = {
    entity_structure: entity,
    lines,
  };

  els.rawPayload.textContent = JSON.stringify(payload, null, 2);
  els.results.innerHTML = "";
  els.rawResponse.textContent = "";
  setStatus("pending", `POST ${baseUrl}/ingest/trial_balance …`);
  els.fire.disabled = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const t0 = performance.now();
    let resp, bodyText;
    try {
      resp = await fetch(`${baseUrl}/ingest/trial_balance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "error",
      });
      bodyText = await resp.text();
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - t0);
      setStatus("fail", controller.signal.aborted
        ? `Request timed out after ${elapsedMs}ms. Check the endpoint and retry.`
        : `Network error after ${elapsedMs}ms: ${err.message}\nFor blocked browser requests, see Browser connection at the top of the page.`);
      return;
    }
    const elapsedMs = Math.round(performance.now() - t0);

    els.rawResponse.textContent = bodyText;
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_) {
      parsed = null;
    }

    if (resp.status !== 200) {
      setStatus("fail", `HTTP ${resp.status} in ${elapsedMs}ms: ${parsed?.detail || bodyText.slice(0, 200)}`);
      return;
    }

    if (parsed?.status !== "success" || typeof parsed.equilibrium_valid !== "boolean"
        || !Array.isArray(parsed.results) || parsed.results.length !== lines.length
        || parsed.results.some((row) => !isWireRow(row))) {
      setStatus("fail", "The response has an invalid envelope, row family or result count. Inspect the raw response.");
      return;
    }
    renderResults(parsed.results);
    setStatus("ok", `HTTP 200 in ${elapsedMs}ms · equilibrium_valid=${parsed.equilibrium_valid} · ${parsed.results.length} result rows`);
  } catch {
    els.results.innerHTML = "";
    setStatus("fail", "The response could not be displayed. Inspect the raw response and retry.");
  } finally {
    clearTimeout(timeoutId);
    els.fire.disabled = false;
  }
}

function isWireRow(row) {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    && typeof row.operator_hint_predicted_code === "string"
    && typeof row.cascade_topology === "string" && !("cascade" in row);
}

function setStatus(kind, msg) {
  els.statusLine.className = "";
  els.statusLine.classList.add(kind);
  els.statusLine.textContent = msg;
}

/** ============================================================================
 * Render results
 * ========================================================================= */

function renderResults(results) {
  els.results.innerHTML = "";
  results.forEach((r) => {
    const card = document.createElement("div");
    const status = ["accepted_fact", "draft_fact", "quarantine"].includes(r.fano_status)
      ? r.fano_status : "unknown";
    card.classList.add("result-card", status);

    const badge = `<span class="status-badge ${status}">${status}</span>`;
    const confDisplay = typeof r.confidence === "number" ? r.confidence.toFixed(3) : String(r.confidence);

    card.innerHTML = `
      <div class="desc">${escapeHtml(r.description ?? "(no description)")}  ${badge}</div>
      <div class="grid">
        <span class="label">predicted_code</span> <span>${escapeHtml(r.predicted_code ?? "")}</span>
        <span class="label">confidence</span> <span>${escapeHtml(confDisplay)}</span>
        <span class="label">cascade_topology</span> <span>${escapeHtml(r.cascade_topology ?? "")}</span>
        ${r.quarantine_reason ? `<span class="label">quarantine_reason</span> <span>${escapeHtml(r.quarantine_reason)}</span>` : ""}
        ${r.operator_hint_predicted_code ? `<span class="label">operator_hint</span> <span>${escapeHtml(r.operator_hint_predicted_code)} (${escapeHtml(r.operator_hint_source_topology ?? "")})</span>` : ""}
      </div>
    `;
    els.results.appendChild(card);
  });
}

/** ============================================================================
 * Helpers
 * ========================================================================= */

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}
