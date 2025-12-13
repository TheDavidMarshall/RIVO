/* script.js — Production-ready dashboard interactions (vanilla JS)
   - Guest mode / User mode
   - Search, Sort, Pagination
   - Bulk select, Unsubscribe, Request Deletion (simulated)
   - Company modal with AI integration (worker) or fallback simulation
   - localStorage persistence per-user
   - Exposes window.__SpamSlam_signIn(...) to connect real OAuth
*/

(() => {
  /* ====== CONFIG ====== */
  const PAGE_SIZE = 9; // companies per page
  const WORKER_URL = "" ; // <-- set to your OpenAI proxy worker e.g. "https://openai-proxy.misty-hill-5aa9.workers.dev"
  const STORAGE_PREFIX = "spamslam_user_";
  const GUEST_USERNAME = "Guest";

  /* ====== DOM REFS ====== */
  const topCompaniesEl = document.getElementById("topCompanies");
  const companiesBigEl = document.getElementById("companiesBig");
  const companiesGridEl = document.getElementById("companiesGrid");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const selectAllCheckbox = document.getElementById("selectAll");
  const bulkUnsubBtn = document.getElementById("bulkUnsub");
  const bulkDeleteBtn = document.getElementById("bulkDelete");
  const paginationWrap = document.getElementById("paginationWrap");
  const pagerBottom = document.getElementById("pagerBottom");
  const profileImg = document.getElementById("avatar");
  const profileNameWrap = document.querySelector(".profile-name");
  const takeActionBtn = document.getElementById("takeActionBtn");
  const seeCompaniesBtn = document.getElementById("seeCompanies");
  const modalRoot = document.getElementById("modal");
  const modalContent = document.getElementById("modalContent");
  const modalCloseBtn = document.getElementById("modalClose");
  const toastEl = document.getElementById("toast");

  /* ====== STATE ====== */
  let user = null; // { email, name, avatar }
  let companies = []; // current user's companies
  let filtered = []; // after search & sort
  let currentPage = 1;
  let selectedSet = new Set(); // domains selected
  let userMode = false; // guest vs user

  /* ====== SAMPLE SEED DATA (for demo / initial user) ======
     The real scanning flow should replace this with real scanned data.
  */
  const SAMPLE_COMPANIES = [
    {
      domain: "netflix.com",
      count: 18,
      firstSeen: "2023-02-01T09:00:00Z",
      lastSeen: "2025-11-10T12:00:00Z",
      emails: { "info@netflix.com": 10 },
      sampleSubjects: ["Welcome to Netflix", "Account update"],
      logo: "https://logo.clearbit.com/netflix.com",
      ai: {}
    },
    {
      domain: "spotify.com",
      count: 9,
      firstSeen: "2024-01-12T10:00:00Z",
      lastSeen: "2025-07-02T10:00:00Z",
      emails: { "no-reply@spotify.com": 9 },
      sampleSubjects: ["Your Weekly Mix", "Try Premium"],
      logo: "https://logo.clearbit.com/spotify.com",
      ai: {}
    },
    {
      domain: "uber.com",
      count: 6,
      firstSeen: "2022-06-21T08:00:00Z",
      lastSeen: "2025-01-18T15:00:00Z",
      emails: { "account@uber.com": 6 },
      sampleSubjects: ["Ride receipt", "Your driver is on the way"],
      logo: "https://logo.clearbit.com/uber.com",
      ai: {}
    },
    {
      domain: "amazon.com",
      count: 45,
      firstSeen: "2019-11-01T09:30:00Z",
      lastSeen: "2025-10-12T11:10:00Z",
      emails: { "no-reply@amazon.com": 30, "news@amazon.com": 15 },
      sampleSubjects: ["Your order", "Deal of the day"],
      logo: "https://logo.clearbit.com/amazon.com",
      ai: {}
    },
    // duplicate data to reach many items for pagination demo
    ...Array.from({length:24}).map((_,i)=>({
      domain: `store${i+1}.example.com`,
      count: Math.floor(Math.random()*20)+1,
      firstSeen: "2021-05-01T09:00:00Z",
      lastSeen: "2025-11-01T09:00:00Z",
      emails: { [`news@store${i+1}.example.com`]: Math.floor(Math.random()*20)+1 },
      sampleSubjects: ["Welcome", "Discount code"],
      logo: `https://logo.clearbit.com/store${i+1}.example.com`,
      ai: {}
    }))
  ];

  /* ====== UTILITIES ====== */
  function formatDate(iso) {
    try { return new Date(iso).toLocaleDateString(); } catch(e) { return "Unknown"; }
  }

  function toast(msg, timeout = 3000) {
    if(!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    toastEl.setAttribute("aria-hidden", "false");
    setTimeout(()=> {
      toastEl.classList.remove("show");
      toastEl.setAttribute("aria-hidden","true");
    }, timeout);
  }

  function saveUserData() {
    if(!user) return;
    try {
      const key = STORAGE_PREFIX + user.email;
      localStorage.setItem(key, JSON.stringify(companies));
    } catch (e) {
      console.warn("saveUserData error", e);
    }
  }

  function loadUserData(email) {
    const key = STORAGE_PREFIX + email;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /* ====== AUTH / USER MODE API ====== */

  // Public function to sign in (simulate or hook real OAuth)
  // Example: window.__SpamSlam_signIn('me@gmail.com','Michael','https://...avatar.jpg')
  window.__SpamSlam_signIn = function(email, name = "User", avatarUrl = "") {
    if(!email) return;
    user = { email, name: name || GUEST_USERNAME, avatar: avatarUrl || "" };
    userMode = true;
    // load or seed data
    const existing = loadUserData(email);
    companies = existing ? existing : JSON.parse(JSON.stringify(SAMPLE_COMPANIES));
    // store if newly seeded
    if(!existing) saveUserData();
    // update UI
    renderProfile();
    applyFiltersAndRender();
    toast(`Signed in as ${user.name}`);
  };

  // Public sign out
  window.__SpamSlam_signOut = function() {
    user = null;
    userMode = false;
    companies = [];
    filtered = [];
    currentPage = 1;
    selectedSet.clear();
    renderProfile();
    applyFiltersAndRender();
    toast("Signed out — you are in guest mode");
  };

  function renderProfile() {
    // profile avatar and name in topbar
    if (userMode && user) {
      profileImg.src = user.avatar || "";
      profileImg.alt = user.name;
      profileNameWrap.innerHTML = `${user.name} <span class="caret">▾</span>`;
      document.querySelector(".welcome h1").textContent = `Welcome ${user.name}!`;
      // show counts
      updateTopNumbers();
    } else {
      // guest mode: zeros and default
      profileImg.src = "";
      profileImg.alt = "";
      profileNameWrap.innerHTML = `Guest`;
      document.querySelector(".welcome h1").textContent = `Welcome!`;
      updateTopNumbers(); // zeros
    }
  }

  function updateTopNumbers() {
    if (userMode) {
      const totalCompanies = companies.length;
      topCompaniesEl.textContent = totalCompanies;
      companiesBigEl.textContent = totalCompanies;
      // optionally show completed
      const completed = companies.filter(c=>c.ai && c.ai.deleted).length || 0;
      const smallCompleted = document.querySelector(".top-stats .small");
      if (smallCompleted) smallCompleted.textContent = `${completed} Completed`;
    } else {
      // guest
      topCompaniesEl.textContent = "0";
      companiesBigEl.textContent = "0";
      const smallCompleted = document.querySelector(".top-stats .small");
      if (smallCompleted) smallCompleted.textContent = `0 Completed`;
    }
  }

  /* ====== SEARCH / SORT / FILTER / PAGINATION ====== */

  function applyFiltersAndRender() {
    // apply search
    const q = (searchInput.value || "").trim().toLowerCase();
    filtered = companies.filter(c => {
      if(!q) return true;
      if (c.domain && c.domain.toLowerCase().includes(q)) return true;
      if (Object.keys(c.emails||{}).some(e => e.toLowerCase().includes(q))) return true;
      if ((c.sampleSubjects||[]).join(" ").toLowerCase().includes(q)) return true;
      return false;
    });

    // apply sort
    const sort = sortSelect.value;
    if (sort === "freq") {
      filtered.sort((a,b)=> (b.count||0) - (a.count||0));
    } else if (sort === "recent") {
      filtered.sort((a,b)=> new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
    } else if (sort === "alpha") {
      filtered.sort((a,b)=> a.domain.localeCompare(b.domain));
    }

    // reset pagination if needed
    currentPage = Math.max(1, Math.min(currentPage, Math.ceil(filtered.length / PAGE_SIZE) || 1));
    renderGridPage(currentPage);
    updateTopNumbers();
  }

  function renderGridPage(page = 1) {
    currentPage = page;
    companiesGridEl.innerHTML = "";

    if (!userMode) {
      // guest mode empty state
      companiesGridEl.innerHTML = `<div class="empty-note" style="padding:20px;border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,0.9),#fff);">Connect your email to see companies that hold your data.</div>`;
      renderPaginationControls(0);
      return;
    }

    const start = (page-1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    if (!pageItems.length) {
      companiesGridEl.innerHTML = `<div class="empty-note" style="padding:20px;border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,0.9),#fff);">No companies matched your search.</div>`;
      renderPaginationControls(filtered.length);
      return;
    }

    pageItems.forEach(c => {
      const card = buildCompanyCard(c);
      companiesGridEl.appendChild(card);
    });

    renderPaginationControls(filtered.length);
    // update select-all checkbox based on page selection
    updateSelectAllFromPage();
  }

  function renderPaginationControls(totalCount) {
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    paginationWrap.innerHTML = "";
    pagerBottom.innerHTML = "";

    // small pager
    for (let p = 1; p <= totalPages; p++) {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (p === currentPage ? " active" : "");
      btn.textContent = p;
      btn.addEventListener("click", ()=> { renderGridPage(p); });
      paginationWrap.appendChild(btn);
      // bottom pager duplicate
      const btn2 = btn.cloneNode(true);
      btn2.addEventListener("click", ()=> { renderGridPage(p); });
      pagerBottom.appendChild(btn2);
    }
  }

  /* ====== COMPANY CARD DOM ====== */
  function buildCompanyCard(c) {
    const card = document.createElement("div");
    card.className = "company";
    card.dataset.domain = c.domain;

    // top row: checkbox, logo, domain, pill
    const top = document.createElement("div");
    top.className = "top";

    const leftWrap = document.createElement("div");
    leftWrap.style.display = "flex";
    leftWrap.style.alignItems = "center";
    leftWrap.style.gap = "12px";

    // checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "select-company";
    cb.dataset.domain = c.domain;
    cb.checked = selectedSet.has(c.domain);
    cb.addEventListener("change", (ev)=> {
      if(cb.checked) selectedSet.add(c.domain);
      else selectedSet.delete(c.domain);
      updateSelectAllFromPage(); // updates UI
    });

    // logo round
    const logoRound = document.createElement("div");
    logoRound.className = "logo-round";
    const img = document.createElement("img");
    img.src = c.logo || `https://logo.clearbit.com/${c.domain}`;
    img.alt = c.domain;
    img.onerror = ()=> { img.style.display = "none"; };
    logoRound.appendChild(img);

    const textWrap = document.createElement("div");
    textWrap.style.flex = "1";
    const domainEl = document.createElement("div");
    domainEl.className = "domain";
    domainEl.textContent = c.domain;
    const subEl = document.createElement("div");
    subEl.className = "sub";
    const sample = Object.keys(c.emails || {})[0] || "";
    subEl.textContent = `${sample} • ${formatDate(c.firstSeen)}`;

    textWrap.appendChild(domainEl);
    textWrap.appendChild(subEl);

    leftWrap.appendChild(cb);
    leftWrap.appendChild(logoRound);
    leftWrap.appendChild(textWrap);

    top.appendChild(leftWrap);

    // pill and actions column
    const rightCol = document.createElement("div");
    rightCol.style.textAlign = "right";
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.innerText = `${c.count} msg${c.count>1 ? "s" : ""}`;

    rightCol.appendChild(pill);
    top.appendChild(rightCol);

    // footer: sample subjects and buttons
    const footer = document.createElement("div");
    footer.className = "card-footer tiny";
    const subs = document.createElement("div");
    subs.innerHTML = (c.sampleSubjects || []).slice(0,2).map(s => escapeHtml(s)).join(" • ");
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    const viewBtn = document.createElement("button");
    viewBtn.className = "btn small";
    viewBtn.textContent = "Open";
    viewBtn.addEventListener("click", ()=> openCompanyModal(c.domain));
    const unsubBtn = document.createElement("button");
    unsubBtn.className = "btn small";
    unsubBtn.textContent = "Unsubscribe (AI)";
    unsubBtn.addEventListener("click", ()=> aiUnsubscribe(c.domain));
    const delBtn = document.createElement("button");
    delBtn.className = "btn small";
    delBtn.textContent = "Request deletion (AI)";
    delBtn.addEventListener("click", ()=> aiDeletionRequest(c.domain));

    actions.appendChild(viewBtn);
    actions.appendChild(unsubBtn);
    actions.appendChild(delBtn);

    footer.appendChild(subs);
    footer.appendChild(actions);

    // add event: click whole card open modal
    card.addEventListener("click", (e) => {
      // avoid clicks on checkbox/buttons triggering duplicate open
      if (e.target.tagName.toLowerCase() === "input" || e.target.tagName.toLowerCase() === "button") return;
      openCompanyModal(c.domain);
    });

    card.appendChild(top);
    card.appendChild(footer);

    return card;
  }

  /* ====== Helpers ====== */
  function escapeHtml(s) {
    if (!s) return "";
    return (s+"").replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]));
  }

  function updateSelectAllFromPage() {
    // determines all checkboxes in current page and sets selectAll checkbox state
    const pageCheckboxes = Array.from(document.querySelectorAll(".select-company"));
    if (!pageCheckboxes.length) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
      return;
    }
    const checked = pageCheckboxes.filter(cb => cb.checked).length;
    if (checked === pageCheckboxes.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else if (checked === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  /* ====== BULK ACTIONS ====== */
  selectAllCheckbox.addEventListener("change", ()=> {
    const pageCheckboxes = Array.from(document.querySelectorAll(".select-company"));
    pageCheckboxes.forEach(cb => {
      cb.checked = selectAllCheckbox.checked;
      const domain = cb.dataset.domain;
      if (cb.checked) selectedSet.add(domain);
      else selectedSet.delete(domain);
    });
  });

  bulkUnsubBtn.addEventListener("click", async ()=> {
    if (!userMode) { toast("Please sign in to perform this action"); return; }
    if (!selectedSet.size) { toast("Select companies first"); return; }
    const domains = Array.from(selectedSet);
    toast("Generating unsubscribe steps...");
    // attempt to call AI per domain in sequence (or do simulated)
    for (const d of domains) {
      await aiUnsubscribe(d, true); // silent + save
      await sleep(150); // small throttle
    }
    toast(`Unsubscribe steps generated for ${domains.length} companies`);
    saveUserData();
    applyFiltersAndRender();
  });

  bulkDeleteBtn.addEventListener("click", async ()=> {
    if (!userMode) { toast("Please sign in to perform this action"); return; }
    if (!selectedSet.size) { toast("Select companies first"); return; }
    const domains = Array.from(selectedSet);
    toast("Generating deletion requests...");
    for (const d of domains) {
      await aiDeletionRequest(d, true);
      await sleep(150);
    }
    toast(`Deletion requests generated for ${domains.length} companies`);
    saveUserData();
    applyFiltersAndRender();
  });

  /* ====== COMPANY MODAL ====== */
  function openCompanyModal(domain) {
    const c = companies.find(x=>x.domain === domain);
    if (!c) return;
    modalContent.innerHTML = `
      <h2 style="margin-top:0">${escapeHtml(c.domain)}</h2>
      <div style="display:flex;gap:12px;align-items:center;margin-top:8px">
        <div style="width:64px;height:64px;border-radius:10px;background:linear-gradient(90deg,#ffd28a,#8cc1ff);display:flex;align-items:center;justify-content:center;overflow:hidden">
          <img src="${escapeHtml(c.logo)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'"/>
        </div>
        <div>
          <div style="font-weight:700">${escapeHtml(c.domain)}</div>
          <div style="color:var(--muted);font-size:14px">${c.count} messages • First: ${formatDate(c.firstSeen)}</div>
        </div>
      </div>

      <div style="margin-top:12px">
        <strong>Sample subjects:</strong>
        <div style="margin-top:6px;color:var(--muted)">${(c.sampleSubjects || []).slice(0,5).map(s=>escapeHtml(s)).join(" • ")}</div>
      </div>

      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="modalUnsub" class="btn primary">Generate Unsubscribe Steps (AI)</button>
        <button id="modalDelete" class="btn outline">Generate Deletion Request (AI)</button>
        <button id="modalDraft" class="btn">Create Gmail Draft</button>
      </div>

      <div id="modalAiOutput" style="margin-top:12px;background:#f8fafc;padding:12px;border-radius:10px;display:none"></div>
    `;
    modalRoot.classList.add("open");
    modalRoot.setAttribute("aria-hidden","false");

    // wire modal buttons
    document.getElementById("modalUnsub").addEventListener("click", ()=> aiUnsubscribe(domain));
    document.getElementById("modalDelete").addEventListener("click", ()=> aiDeletionRequest(domain));
    document.getElementById("modalDraft").addEventListener("click", async ()=> {
      if(!userMode) { toast("Sign in to create drafts"); return; }
      try {
        await createGmailDraftFor(domain);
        toast("Draft created in your Gmail drafts (if OAuth connected)");
      } catch (err) {
        toast("Draft creation failed (not connected)");
      }
    });
  }

  modalCloseBtn.addEventListener("click", closeModal);
  modalRoot.addEventListener("click", (e)=> { if(e.target === modalRoot) closeModal(); });

  function closeModal(){
    modalRoot.classList.remove("open");
    modalRoot.setAttribute("aria-hidden","true");
    modalContent.innerHTML = "";
  }

  /* ====== AI INTEGRATION ====== */
  async function callAI(prompt) {
    // If WORKER_URL set, call it; otherwise simulate friendly response
    if (WORKER_URL && WORKER_URL.length>4) {
      try {
        const payload = { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.2 };
        const res = await fetch(WORKER_URL + "/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const text = await res.text();
          console.warn("AI worker returned error:", text);
          throw new Error("AI proxy error");
        }
        const j = await res.json();
        const reply = (j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) || JSON.stringify(j);
        return reply;
      } catch (e) {
        console.warn("AI call failed:", e);
        return null;
      }
    } else {
      // Simulate a response (safe fallback)
      await sleep(400 + Math.random()*300);
      return "Simulated AI response: Please follow these steps on the website to unsubscribe, or send the provided deletion email to support@" +
             " (this is a demo response — configure WORKER_URL for real AI).";
    }
  }

  async function aiUnsubscribe(domain, silent = false) {
    // generate unsubscribe steps and store in c.ai.unsubscribe
    const c = companies.find(x=>x.domain === domain);
    if(!c) return;
    if(!userMode) { toast("Sign in to generate unsubscribe steps"); return; }

    const outEl = document.getElementById("modalAiOutput");
    if(outEl) { outEl.style.display = "block"; outEl.textContent = "Generating unsubscribe steps..."; }

    const prompt = `Provide short step-by-step unsubscribe instructions for ${domain}. If none are obvious, suggest contacting support@${domain} or visiting ${domain} -> Account -> Email preferences.`;
    const reply = await callAI(prompt);
    c.ai = c.ai || {};
    c.ai.unsubscribe = reply || "No unsubscribe steps found (simulated).";
    saveUserData();

    if(outEl) outEl.innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(c.ai.unsubscribe)}</pre>`;

    if(!silent) toast("Unsubscribe steps generated (see modal).");
    return c.ai.unsubscribe;
  }

  async function aiDeletionRequest(domain, silent=false) {
    const c = companies.find(x=>x.domain === domain);
    if(!c) return;
    if(!userMode) { toast("Sign in to generate deletion requests"); return; }

    const outEl = document.getElementById("modalAiOutput");
    if(outEl) { outEl.style.display = "block"; outEl.textContent = "Generating deletion request..."; }

    const prompt = `Create a polite GDPR-style data deletion request to support@${domain}. Output JSON with keys "subject" and "body". Use placeholders {name} and {email}.`;
    const reply = await callAI(prompt);

    // try parse JSON, otherwise store as raw text
    let parsed = null;
    try { parsed = JSON.parse(reply); } catch {}
    c.ai = c.ai || {};
    if(parsed && parsed.subject && parsed.body) {
      c.ai.deletionEmail = parsed;
      if(outEl) outEl.innerHTML = `<div><strong>Subject:</strong> ${escapeHtml(parsed.subject)}</div><pre style="white-space:pre-wrap">${escapeHtml(parsed.body)}</pre>`;
    } else {
      c.ai.deletionEmail = { subject: "Data deletion request", body: reply || "Simulated deletion email" };
      if(outEl) outEl.innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(c.ai.deletionEmail.body)}</pre>`;
    }
    saveUserData();
    if(!silent) toast("Deletion request generated (see modal).");
    return c.ai.deletionEmail;
  }

  /* ====== Gmail Draft helper (placeholder) ====== */
  async function createGmailDraftFor(domain) {
    // This requires OAuth + Gmail API. We provide stub that throws when not implemented.
    // Replace with real OAuth flow: call your serverless worker to create drafts securely.
    throw new Error("Not implemented: connect Gmail OAuth to create drafts");
  }

  /* ====== small helpers ====== */
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  /* ====== UI EVENTS ====== */
  // search & sort
  searchInput.addEventListener("input", ()=> {
    currentPage = 1;
    applyFiltersAndRender();
  });
  sortSelect.addEventListener("change", ()=> {
    currentPage = 1;
    applyFiltersAndRender();
  });

  // quick demo sign-in button (Take Action) - opens small sign in modal
  takeActionBtn.addEventListener("click", ()=> {
    if (!userMode) {
      // show sign-in prompt modal
      openSignInModal();
    } else {
      // if already signed-in, scroll to companies
      document.querySelector(".companies-grid")?.scrollIntoView({behavior:"smooth"});
    }
  });

  seeCompaniesBtn.addEventListener("click", ()=>{
    if(!userMode) {
      openSignInModal();
    } else {
      document.querySelector(".companies-grid")?.scrollIntoView({behavior:"smooth"});
    }
  });

  /* ====== SIGN IN / MODAL UI ====== */
  function openSignInModal(){
    // simple modal content for sign-in (email + name)
    modalContent.innerHTML = `
      <h3 style="margin-top:0">Sign in to connect your inbox</h3>
      <p style="color:var(--muted)">For demo: type any email to simulate connection. This will persist locally to your browser.</p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <input id="si_email" placeholder="you@example.com" style="flex:1;padding:10px;border-radius:8px;border:1px solid #e5e7eb" />
        <input id="si_name" placeholder="Your name" style="width:180px;padding:10px;border-radius:8px;border:1px solid #e5e7eb" />
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
        <button id="si_cancel" class="btn">Cancel</button>
        <button id="si_submit" class="btn primary">Try it — connect</button>
      </div>
    `;
    modalRoot.classList.add("open");
    modalRoot.setAttribute("aria-hidden","false");

    document.getElementById("si_cancel").addEventListener("click", closeModal);
    document.getElementById("si_submit").addEventListener("click", ()=> {
      const email = document.getElementById("si_email").value.trim();
      const name = document.getElementById("si_name").value.trim() || "You";
      if(!email || !validateEmail(email)) { toast("Enter a valid email"); return; }
      // simulate sign in
      window.__SpamSlam_signIn(email, name, "");
      closeModal();
    });
  }

  function validateEmail(e) {
    return /\S+@\S+\.\S+/.test(e);
  }

  /* ====== INITIALIZATION ====== */
  function init() {
    // initial state: guest mode
    user = null;
    companies = [];
    filtered = [];
    userMode = false;
    selectedSet.clear();
    currentPage = 1;

    renderProfile();
    applyFiltersAndRender();
    // keyboard: ESC to close modal
    document.addEventListener("keydown", (e)=> {
      if(e.key === "Escape") closeModal();
    });

    // show welcome sample (if any persisted last user, don't auto sign-in)
    // But to aid demo: if a persisted user exists in localStorage, remain guest until they explicitly sign in
    // The owner can programmatically call window.__SpamSlam_signIn(...)
  }

  // run init
  init();

  /* ====== expose some helpers for external integration ====== */
  window.__SpamSlam_getState = () => ({
    userMode, user,
    companiesCount: companies.length,
    selected: Array.from(selectedSet)
  });

  window.__SpamSlam_setWorkerUrl = (url) => {
    // allow runtime setting of worker URL
    try {
      if(!url || typeof url !== "string") return;
      // not changing constant; but we store as runtime
      window.__SpamSlam_workerUrl = url;
      toast("Worker URL saved (use for AI calls)");
    } catch(e){}
  };

  /* ====== last note: safe defaults for production ======
     - Replace the sign-in simulation with real OAuth (Google) and call window.__SpamSlam_signIn() with returned profile.
     - Set WORKER_URL constant above to your Cloudflare Worker that proxies OpenAI keys.
     - For draft creation, implement secure server-side call that makes Gmail draft on user's behalf.
  */

})();
