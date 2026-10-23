export function consolePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment desk</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #12110e;
      --ink: #f4efe4;
      --muted: #b3a694;
      --line: #3c3428;
      --panel: #1c1914;
      --panel-2: #262119;
      --brass: #e2a84a;
      --brass-ink: #2a1c08;
      --ok: #8fceab;
      --warn: #e2c07a;
      --bad: #e3927a;
      --info: #9eb7d4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(1200px 500px at 10% -10%, #2a2418 0%, transparent 55%),
        var(--bg);
      color: var(--ink);
      font: 16px/1.45 "Segoe UI", "Helvetica Neue", sans-serif;
    }
    header, main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      padding: 28px 0 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-family: Palatino, "Palatino Linotype", "Iowan Old Style", serif;
      font-size: 2rem;
      font-weight: 600;
      letter-spacing: -0.03em;
    }
    .lede { margin: 4px 0 0; color: var(--muted); }
    .tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    a.docs {
      color: var(--ink);
      text-decoration: none;
      border-bottom: 1px solid var(--brass);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 999px;
      padding: 6px 10px;
      color: var(--muted);
      font-size: 0.85rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
    .pill.ok .dot { background: var(--ok); }
    .pill.bad .dot { background: var(--bad); }
    main {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 20px;
      padding: 22px 0 48px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
    }
    h2 { margin: 0 0 12px; font-size: 1.05rem; }
    label { display: block; margin: 12px 0 6px; color: var(--muted); font-size: 0.85rem; }
    input, select, button {
      font: inherit;
      color: var(--ink);
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      width: 100%;
    }
    button {
      width: auto;
      cursor: pointer;
      background: var(--brass);
      color: var(--brass-ink);
      border: 0;
      font-weight: 650;
    }
    button.ghost {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
      font-weight: 500;
    }
    button:disabled { opacity: 0.55; cursor: wait; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row > * { flex: 1; }
    .hint { color: var(--muted); font-size: 0.82rem; margin: 8px 0 0; }
    .banner {
      display: none;
      margin: 0 0 14px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #3a241d;
      color: #f6d2c6;
    }
    .banner.show { display: block; }
    .ledger-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .empty, .loading { color: var(--muted); margin: 8px 0 0; }
    ul.payments { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }
    li.payment {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 16px;
      padding: 12px;
      border-radius: 12px;
      background: var(--panel-2);
      border: 1px solid var(--line);
    }
    .title { font-weight: 650; }
    .meta { color: var(--muted); font-size: 0.85rem; }
    .amount { font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
    .status {
      justify-self: end;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      border: 1px solid var(--line);
    }
    .status.pending, .status.processing { color: var(--warn); }
    .status.succeeded, .status.refunded { color: var(--ok); }
    .status.failed, .status.cancelled { color: var(--bad); }
    .actions { grid-column: 1 / -1; display: flex; gap: 8px; }
    @media (max-width: 800px) {
      header, main { width: min(1120px, calc(100% - 20px)); }
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: 1fr; }
      h1 { font-size: 1.7rem; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Payment desk</h1>
      <p class="lede">Accept a charge, then watch the worker settle it.</p>
    </div>
    <div class="tools">
      <span id="health" class="pill"><span class="dot"></span><span id="health-label">Checking the service</span></span>
      <a class="docs" href="/docs/">API reference</a>
    </div>
  </header>
  <main>
    <section>
      <h2>New charge</h2>
      <p id="banner" class="banner" role="alert"></p>
      <form id="charge-form">
        <label for="api-key">API key</label>
        <input id="api-key" name="apiKey" autocomplete="off" spellcheck="false" value="dev-api-key-change-me" />
        <div class="row">
          <div>
            <label for="amount">Amount</label>
            <input id="amount" name="amount" type="number" min="1" step="1" value="150000" required />
          </div>
          <div>
            <label for="currency">Currency</label>
            <select id="currency" name="currency">
              <option value="NGN" selected>NGN</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
        </div>
        <p class="hint">Minor units. 150000 NGN is 1,500.00 naira.</p>
        <label for="description">Description</label>
        <input id="description" name="description" maxlength="255" value="Order 1042" />
        <div class="row">
          <div>
            <label for="method">Method</label>
            <select id="method" name="method">
              <option value="card" selected>Card</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="wallet">Wallet</option>
            </select>
          </div>
          <div>
            <label for="token">Token</label>
            <input id="token" name="token" value="tok_visa_4242" required />
          </div>
        </div>
        <label for="idempotency">Idempotency key</label>
        <input id="idempotency" name="idempotency" required />
        <p class="hint">The same key and body replay the original 202. A different body is rejected.</p>
        <div class="row" style="margin-top: 14px">
          <button id="submit" type="submit">Accept payment</button>
        </div>
      </form>
    </section>
    <section>
      <div class="ledger-head">
        <h2>Ledger</h2>
        <button id="refresh" class="ghost" type="button">Refresh</button>
      </div>
      <p id="ledger-note" class="loading">Reading the ledger…</p>
      <ul id="payments" class="payments"></ul>
    </section>
  </main>
  <noscript><p class="lede" style="width:min(1120px,calc(100% - 32px));margin:16px auto">This desk needs JavaScript to talk to the API.</p></noscript>
  <script>
    const storageKey = "payment-desk-api-key";
    const health = document.querySelector("#health");
    const healthLabel = document.querySelector("#health-label");
    const banner = document.querySelector("#banner");
    const form = document.querySelector("#charge-form");
    const apiKeyInput = document.querySelector("#api-key");
    const amountInput = document.querySelector("#amount");
    const currencyInput = document.querySelector("#currency");
    const descriptionInput = document.querySelector("#description");
    const methodInput = document.querySelector("#method");
    const tokenInput = document.querySelector("#token");
    const idempotencyInput = document.querySelector("#idempotency");
    const submitButton = document.querySelector("#submit");
    const refreshButton = document.querySelector("#refresh");
    const note = document.querySelector("#ledger-note");
    const list = document.querySelector("#payments");
    let payments = [];
    let timer = 0;

    apiKeyInput.value = sessionStorage.getItem(storageKey) || apiKeyInput.value;
    idempotencyInput.value = newIdempotencyKey();

    form.addEventListener("submit", onSubmit);
    refreshButton.addEventListener("click", () => { watch(); });
    apiKeyInput.addEventListener("change", () => {
      sessionStorage.setItem(storageKey, apiKeyInput.value.trim());
    });

    checkHealth();
    watch();

    function newIdempotencyKey() {
      const bytes = new Uint8Array(8);
      if (globalThis.crypto && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return "desk-" + hex;
      }
      return "desk-" + Date.now().toString(16);
    }

    function apiKey() {
      return apiKeyInput.value.trim();
    }

    async function request(path, options) {
      const headers = { Accept: "application/json" };
      if (options.auth !== false) headers["X-Api-Key"] = apiKey();
      if (options.body) headers["Content-Type"] = "application/json";
      Object.assign(headers, options.headers || {});
      const response = await fetch(path, { method: options.method || "GET", headers, body: options.body });
      const text = await response.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = { detail: text }; }
      }
      if (!response.ok) {
        const error = new Error((body && body.detail) || "Request failed");
        error.status = response.status;
        throw error;
      }
      return body;
    }

    async function checkHealth() {
      try {
        const ready = await request("/health/ready", { auth: false });
        health.className = "pill ok";
        healthLabel.textContent = ready.status === "ok" ? "Ready" : "Not ready";
      } catch {
        health.className = "pill bad";
        healthLabel.textContent = "Not ready";
      }
    }

    function inflight() {
      return payments.some((payment) => payment.status === "PENDING" || payment.status === "PROCESSING");
    }

    async function watch() {
      clearTimeout(timer);
      try {
        await refresh();
      } catch (error) {
        showError(error);
      }
      if (inflight()) timer = setTimeout(watch, 1200);
    }

    async function refresh() {
      sessionStorage.setItem(storageKey, apiKey());
      const page = await request("/api/v1/payments?limit=20", { auth: true });
      payments = page.data || [];
      render();
    }

    function render() {
      list.replaceChildren();
      if (payments.length === 0) {
        note.hidden = false;
        note.textContent = "No charges yet. Accept a payment and it stays pending until the worker finishes.";
        return;
      }
      const inflight = payments.filter((payment) => payment.status === "PENDING" || payment.status === "PROCESSING").length;
      note.hidden = false;
      note.textContent = inflight > 0
        ? "The worker is settling " + inflight + (inflight === 1 ? " charge." : " charges.")
        : payments.length + (payments.length === 1 ? " charge on the ledger." : " charges on the ledger.");
      for (const payment of payments) list.append(renderPayment(payment));
    }

    function renderPayment(payment) {
      const item = document.createElement("li");
      item.className = "payment";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = payment.description || "Untitled charge";
      const amount = document.createElement("div");
      amount.className = "amount";
      amount.textContent = formatAmount(payment.amount, payment.currency);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = payment.paymentMethod.type + " ···· " + payment.paymentMethod.last4
        + " · " + payment.attempts + (payment.attempts === 1 ? " attempt" : " attempts")
        + " · v" + payment.version;
      const status = document.createElement("div");
      status.className = "status " + String(payment.status).toLowerCase();
      status.textContent = payment.status;
      item.append(title, status, meta, amount);
      const action = actionButton(payment);
      if (action) {
        const actions = document.createElement("div");
        actions.className = "actions";
        actions.append(action);
        item.append(actions);
      }
      return item;
    }

    function actionButton(payment) {
      if (payment.status !== "PENDING" && payment.status !== "SUCCEEDED") return null;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      const next = payment.status === "PENDING" ? "CANCELLED" : "REFUNDED";
      button.textContent = next === "CANCELLED" ? "Cancel" : "Refund";
      button.addEventListener("click", () => {
        transition(payment, next).catch(showError);
      });
      return button;
    }

    async function transition(payment, status) {
      clearBanner();
      await request("/api/v1/payments/" + payment.id + "/status", {
        method: "PATCH",
        auth: true,
        headers: { "If-Match": String(payment.version) },
        body: JSON.stringify({
          status,
          reason: status === "CANCELLED" ? "Stopped from the desk" : "Refunded from the desk",
        }),
      });
      await watch();
    }

    async function onSubmit(event) {
      event.preventDefault();
      clearBanner();
      submitButton.disabled = true;
      try {
        const description = descriptionInput.value.trim();
        const payload = {
          amount: Number(amountInput.value),
          currency: currencyInput.value,
          paymentMethod: { type: methodInput.value, token: tokenInput.value.trim() },
        };
        if (description) payload.description = description;
        await request("/api/v1/payments", {
          method: "POST",
          auth: true,
          headers: { "Idempotency-Key": idempotencyInput.value.trim() },
          body: JSON.stringify(payload),
        });
        idempotencyInput.value = newIdempotencyKey();
      await watch();
      checkHealth();
      } catch (error) {
        showError(error);
      } finally {
        submitButton.disabled = false;
      }
    }

    function formatAmount(amount, currency) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100);
      } catch {
        return (amount / 100).toFixed(2) + " " + currency;
      }
    }

    function showError(error) {
      banner.textContent = error && error.message ? error.message : "The desk could not reach the API.";
      banner.classList.add("show");
      if (note.textContent.startsWith("Reading")) {
        note.textContent = "The ledger could not be loaded.";
      }
    }

    function clearBanner() {
      banner.textContent = "";
      banner.classList.remove("show");
    }
  </script>
</body>
</html>`;
}
