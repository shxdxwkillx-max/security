document.addEventListener("DOMContentLoaded", () => {
  if (!window.crypto || !window.crypto.subtle) {
    const el = document.getElementById("global-error");
    if (el) { el.style.display = "block"; el.textContent = "⚠️ Web Crypto API недоступен. Откройте через http://localhost (не file://)."; }
    return;
  }

  // ================= ТЕМА =================
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-icon");
  const themeText = document.getElementById("theme-text");

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
    themeText.textContent = theme === "dark" ? "Тёмная тема" : "Светлая тема";
    localStorage.setItem("cryptofile-theme", theme);
  }
  applyTheme(localStorage.getItem("cryptofile-theme") || "dark");
  themeToggle.addEventListener("click", () => {
    applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });

  // ================= УТИЛИТЫ =================
  const b64urlEncode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  
  const b64urlDecode = (str) => {
    const n = str.trim().replace(/-/g, "+").replace(/_/g, "/");
    const p = n + "=".repeat((4 - (n.length % 4)) % 4);
    const bin = atob(p); 
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    return raw;
  };

  const fmtSize = (b) => b < 1024 ? b + " Б" : b < 1048576 ? (b / 1024).toFixed(1) + " КБ" : (b / 1048576).toFixed(2) + " МБ";

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob); 
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ================= КЛЮЧИ =================
  async function generateRandomKey() {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = await crypto.subtle.exportKey("raw", key);
    return { key, code: b64urlEncode(raw) };
  }

  async function keyFromPassword(password, salt) {
    const passKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, 
      passKey, 
      { name: "AES-GCM", length: 256 }, 
      false, 
      ["encrypt", "decrypt"]
    );
  }

  async function keyFromCode(code) {
    const raw = b64urlDecode(code); 
    if (raw.length !== 32) throw new Error("Неверная длина кода");
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  }

  // ================= ШИФРОВАНИЕ / РАСШИФРОВКА =================
  async function encryptFile(file, mode, pass, codeStr) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let key, salt = new Uint8Array(16);
    
    if (mode === "password") {
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await keyFromPassword(pass, salt);
    } else {
      const r = await generateRandomKey(); 
      key = r.key; 
      if (codeStr) codeStr.value = r.code;
    }
    
    const fileData = new Uint8Array(await file.arrayBuffer());
    const nameBytes = new TextEncoder().encode(file.name);
    
    const payload = new Uint8Array(1 + 2 + nameBytes.length + fileData.length);
    let off = 0;
    
    payload[off++] = mode === "password" ? 1 : 0;
    payload[off++] = (nameBytes.length >> 8) & 0xff;
    payload[off++] = nameBytes.length & 0xff;
    payload.set(nameBytes, off); off += nameBytes.length;
    payload.set(fileData, off);
    
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
    const result = new Uint8Array(12 + salt.length + enc.byteLength);
    
    result.set(iv, 0); 
    result.set(salt, 12); 
    result.set(new Uint8Array(enc), 12 + salt.length);
    
    return result;
  }

  async function decryptFile(buffer, mode, pass, codeStr) {
    const data = new Uint8Array(buffer);
    if (data.length < 28) throw new Error("Файл повреждён");
    
    const iv = data.slice(0, 12); 
    const salt = data.slice(12, 28); 
    const ct = data.slice(28);
    
    let key;
    if (mode === "password") key = await keyFromPassword(pass, salt);
    else key = await keyFromCode(codeStr);
    
    const dec = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    
    let off = 1;
    const nameLen = (dec[off] << 8) | dec[off + 1]; off += 2;
    const filename = new TextDecoder().decode(dec.slice(off, off + nameLen)); off += nameLen;
    
    return { filename, fileData: dec.slice(off) };
  }

  // ================= ИСТОРИЯ =================
  function loadHistory() { 
    try { return JSON.parse(localStorage.getItem("cryptofile-history") || "[]"); } 
    catch { return []; } 
  }
  
  function addHistory(action, files) {
    const list = loadHistory(); 
    list.unshift({ action, files, time: Date.now() });
    localStorage.setItem("cryptofile-history", JSON.stringify(list.slice(0, 20))); 
    renderHistory();
  }
  
  function renderHistory() {
    const list = loadHistory(); 
    const el = document.getElementById("history-list");
    if (!list.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><h3>История пуста</h3><p>Здесь появятся ваши операции</p></div>';
      return;
    }
    el.innerHTML = list.map(item => {
      const isEnc = item.action === "encrypt";
      const label = isEnc ? "🔒 Зашифровано" : "🔓 Расшифровано";
      const t = new Date(item.time).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `<div class="history-item ${isEnc ? '' : 'decrypt'}">
        <div class="h-top">
          <span class="h-action">${label}</span>
          <span class="h-time">${t}</span>
        </div>
        <div class="h-files">${item.files.map(escapeHtml).join(", ")}</div>
      </div>`;
    }).join("");
  }
  
  document.getElementById("clear-history").onclick = () => {
    localStorage.removeItem("cryptofile-history");
    renderHistory();
  };
  renderHistory();

  // ================= ВКЛАДКИ =================
  document.querySelectorAll(".nav-item[data-tab]").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".nav-item[data-tab]").forEach(el => el.classList.remove("active"));
      document.querySelectorAll(".page").forEach(el => el.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("page-" + tab.dataset.tab).classList.add("active");
    };
  });

  // ================= ДРОП-ЗОНЫ =================
  function setupDrop(zoneId, inputId, onFiles) {
    const zone = document.getElementById(zoneId), input = document.getElementById(inputId);
    if (!zone || !input) return;
    zone.onclick = (e) => { e.preventDefault(); input.click(); };
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("dragover"); };
    zone.ondragleave = () => zone.classList.remove("dragover");
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("dragover"); if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files)); };
    input.onchange = () => { if (input.files.length) onFiles(Array.from(input.files)); };
  }

  // ================= ШИФРОВАНИЕ =================
  let encFiles = [];
  const encBtn = document.getElementById("enc-btn"), encList = document.getElementById("enc-list");
  const encStatus = document.getElementById("enc-status"), encResult = document.getElementById("enc-result");
  const encCode = document.getElementById("enc-code"), encPasswordBox = document.getElementById("password-box");
  const encP1 = document.getElementById("enc-password"), encP2 = document.getElementById("enc-password2");

  function renderEncList() {
    encList.innerHTML = "";
    encFiles.forEach((f, i) => {
      const d = document.createElement("div"); d.className = "file-item";
      d.innerHTML = `<span class="icon">📄</span><span class="name">${escapeHtml(f.name)}</span><span class="size">${fmtSize(f.size)}</span><button type="button" class="remove">✕</button>`;
      d.querySelector(".remove").onclick = () => { encFiles.splice(i, 1); renderEncList(); updateEncBtn(); };
      encList.appendChild(d);
    });
  }

  function updateEncBtn() {
    if (!encFiles.length) { encBtn.disabled = true; return; }
    const mode = document.querySelector('input[name="key-mode"]:checked').value;
    if (mode === "password") {
      const p = encP1.value.trim(), p2 = encP2.value.trim();
      encBtn.disabled = !(p.length >= 8 && p === p2);
    } else { encBtn.disabled = false; }
  }

  document.querySelectorAll('input[name="key-mode"]').forEach(r => {
    r.onchange = () => {
      const mode = document.querySelector('input[name="key-mode"]:checked').value;
      encPasswordBox.style.display = mode === "password" ? "flex" : "none";
      updateEncBtn();
    };
  });
  encP1.oninput = updateEncBtn;
  encP2.oninput = updateEncBtn;

  setupDrop("enc-drop", "enc-file", files => { encFiles = files; renderEncList(); updateEncBtn(); });

  document.getElementById("copy-code").onclick = () => { navigator.clipboard.writeText(encCode.textContent); alert("Код скопирован!"); };

  encBtn.onclick = async () => {
    if (!encFiles.length) return;
    encBtn.disabled = true; encStatus.textContent = "Шифрование..."; encStatus.className = "status";
    const mode = document.querySelector('input[name="key-mode"]:checked').value;
    const pass = encP1.value;
    try {
      let firstCode = null;
      for (const file of encFiles) {
        const codeBox = { value: null };
        const encrypted = await encryptFile(file, mode, pass, codeBox);
        if (mode === "random") firstCode = codeBox.value;
        downloadBlob(new Blob([encrypted]), file.name + ".enc");
      }
      if (mode === "random") { encCode.textContent = firstCode; encResult.style.display = "block"; }
      else { encResult.style.display = "none"; }
      addHistory("encrypt", encFiles.map(f => f.name));
      encStatus.textContent = "✅ Готово! Файлы скачаны."; encStatus.className = "status success";
      encFiles = []; renderEncList(); updateEncBtn();
    } catch (e) { console.error(e); encStatus.textContent = "❌ Ошибка: " + e.message; encStatus.className = "status error"; }
    encBtn.disabled = false;
  };

  // ================= РАСШИФРОВКА =================
  let decFiles = [];
  const decBtn = document.getElementById("dec-btn"), decList = document.getElementById("dec-list");
  const decStatus = document.getElementById("dec-status"), decPasswordBox = document.getElementById("dec-password-box");
  const decCodeBox = document.getElementById("dec-code-box");
  const decCodeInput = document.getElementById("dec-code"), decPassword = document.getElementById("dec-password");

  function renderDecList() {
    decList.innerHTML = "";
    decFiles.forEach((f, i) => {
      const d = document.createElement("div"); d.className = "file-item";
      d.innerHTML = `<span class="icon">🔒</span><span class="name">${escapeHtml(f.name)}</span><span class="size">${fmtSize(f.size)}</span><button type="button" class="remove">✕</button>`;
      d.querySelector(".remove").onclick = () => { decFiles.splice(i, 1); renderDecList(); updateDecBtn(); };
      decList.appendChild(d);
    });
  }

  function updateDecBtn() {
    if (!decFiles.length) { decBtn.disabled = true; return; }
    const mode = document.querySelector('input[name="dec-mode"]:checked').value;
    if (mode === "password") decBtn.disabled = !decPassword.value.trim();
    else decBtn.disabled = !decCodeInput.value.trim();
  }

  document.querySelectorAll('input[name="dec-mode"]').forEach(r => {
    r.onchange = () => {
      const mode = document.querySelector('input[name="dec-mode"]:checked').value;
      decPasswordBox.style.display = mode === "password" ? "flex" : "none";
      decCodeBox.style.display = mode === "random" ? "block" : "none";
      updateDecBtn();
    };
  });
  decPassword.oninput = updateDecBtn;
  decCodeInput.oninput = updateDecBtn;

  setupDrop("dec-drop", "dec-file", files => { decFiles = files; renderDecList(); updateDecBtn(); });

  decBtn.onclick = async () => {
    if (!decFiles.length) return;
    decBtn.disabled = true; decStatus.textContent = "Расшифровка..."; decStatus.className = "status";
    const mode = document.querySelector('input[name="dec-mode"]:checked').value;
    const pass = decPassword.value;
    const code = decCodeInput.value.trim();
    try {
      for (const file of decFiles) {
        const buffer = await file.arrayBuffer();
        const { filename, fileData } = await decryptFile(buffer, mode, pass, code);
        downloadBlob(new Blob([fileData]), filename);
      }
      addHistory("decrypt", decFiles.map(f => f.name));
      decStatus.textContent = "✅ Файлы успешно расшифрованы!"; decStatus.className = "status success";
      decFiles = []; renderDecList(); updateDecBtn();
    } catch (e) { console.error(e); decStatus.textContent = "❌ Неверный код/пароль или файл повреждён"; decStatus.className = "status error"; }
    decBtn.disabled = false;
  };
});