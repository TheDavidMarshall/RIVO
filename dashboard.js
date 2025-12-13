/* script.js — SpamSlam Dashboard (production-ready)
   Version: v1.0.0-github-copoilt
   Features:
    - Real Gmail OAuth (GSI) + Gmail API (gapi) usage
    - Guest mode (all zeros) until user connects
    - Inbox scanning, grouping by domain
    - Grid rendering, search, sort, pagination, select-all, bulk actions
    - OpenAI worker integration for unsubscribe / deletion text generation
    - Create Gmail drafts (deletion requests)
    - Caching and persistent UI
   Notes:
    - GOOGLE_CLIENT_ID and WORKER_URL set below (from your message)
    - Requires: index.html & style.css matching the earlier provided markup
*/

/* ---------- Config (replace with your provided values) ---------- */
const VERSION = "v1.0.0-github-copoilt";
const GOOGLE_CLIENT_ID = "0987654321-abc587def456ghi789jkl012.apps.googleusercontent.com"; // provided
const WORKER_URL = "https://openai-proxy.misty-hill-5aa9.workers.dev"; // provided

// required Gmail scopes
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose openid email profile";

/* ---------- State & Keys ---------- */
const CACHE_KEY = "spamslam_dashboard_cache_v1";
let tokenClient = null;
let gapiInited = false;
let gisInited = false;
let gmailToken = null;       // access_token after login
let userProfile = null;      // {name, email, picture}
let senders = {};            // keyed by domain: { domain, emails: {email:count}, count, firstSeen, lastSeen, sampleSubjects, ai:{...} }
let pageState = {
  perPage: 9,
  page: 1,
  sort: "freq",    // freq | recent | alpha
  query: "",
  selectAll: false
};

/* ---------- DOM Shortcuts ---------- */
const $ = id => document.getElementById(id);
const qs = s => document.querySelector(s);

/* ---------- Utility Helpers ---------- */
function showToast(msg, timeout=3500){
  const t = $('toast');
  if(!t) return alert(msg);
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), timeout);
}
function isoDate(ts){ return ts ? new Date(Number(ts)).toLocaleString() : 'Unknown'; }
function escapeHtml(s){ return (s+'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------- Load Google libraries (gapi + gis) ---------- */
function loadScript(src){
  return new Promise((res, rej)=>{
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = () => res();
    s.onerror = (e)=> rej(e);
    document.head.appendChild(s);
  });
}
async function initGoogleLibs(){
  // If already initialized, skip
  if(gapiInited && gisInited) return;

  try {
    await loadScript('https://apis.google.com/js/api.js');
    await loadScript('https://accounts.google.com/gsi/client');
    // init gapi client
    gapi.load('client', async () => {
      // we don't need to init with discovery docs until later for Gmail; we'll use direct rest calls for some parts.
      gapiInited = true;
    });

    // init token client (Gis)
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      // callback will be set on connect
      callback: (resp) => {
        if(resp && resp.access_token){
          gmailToken = resp.access_token;
          onSignedIn(); // proceed
        } else {
          showToast('Auth failed');
        }
      }
    });
    gisInited = true;
  } catch(err){
    console.error('initGoogleLibs', err);
    showToast('Failed to load Google libraries');
  }
}

/* ---------- UI bootstrap ---------- */
function uiInit(){
  // wire buttons
  const connectBtn = $('seeCompanies') ? $('seeCompanies') : null; // optional
  // Primary connect button is at top "Try it" or "Take action" depends on your layout.
  // We'll try to find a "Connect Gmail" action in DOM; otherwise we will create one inside header.
  // The HTML you provided contains "Take action" and "See which companies" buttons. We'll attach connect to "Take action".
  const takeActionBtn = $('takeActionBtn') || $('takeAction') || qs('.btn.primary');
  if(takeActionBtn){
    takeActionBtn.addEventListener('click', connectHandler);
  }

  // Also attach connect to seeCompanies button to open modal or start auth
  const seeBtn = $('seeCompanies');
  if(seeBtn) seeBtn.addEventListener('click', connectHandler);

  // toolbar actions
  $('searchInput')?.addEventListener('input', (e)=>{ pageState.query = e.target.value.trim().toLowerCase(); pageState.page = 1; renderCompanies(); });
  $('sortSelect')?.addEventListener('change', (e)=>{ pageState.sort = e.target.value; renderCompanies(); });
  $('selectAll')?.addEventListener('change', (e)=>{ toggleSelectAll(e.target.checked); });

  $('bulkUnsub')?.addEventListener('click', async ()=>{ await bulkAction('unsubscribe'); });
  $('bulkDelete')?.addEventListener('click', async ()=>{ await bulkAction('deletion'); });

  $('modalClose')?.addEventListener('click', closeModal);
  // pagination wrap will be rendered by renderPager()

  // load cache
  const cache = localStorage.getItem(CACHE_KEY);
  if(cache){
    try { const parsed = JSON.parse(cache); senders = parsed.senders || {}; userProfile = parsed.userProfile || null; }
    catch(e){ senders = {}; userProfile = null; }
  }

  updateHeader();
  renderStats(); renderCompanies();
}

/* ---------- Auth / Connect ---------- */
async function connectHandler(){
  await initGoogleLibs();
  if(!tokenClient){ showToast('Auth not ready'); return; }

  // request token with consent
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

/* Called after we receive a gmailToken */
async function onSignedIn(){
  try {
    // fetch userinfo
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + gmailToken }
    });
    if(!resp.ok) throw new Error('Failed to fetch profile');
    userProfile = await resp.json(); // {email, name, picture, ...}
    // store
    saveCache();

    // init gapi client for Gmail operations
    await gapi.client.init({ apiKey: '', discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest"] });

    updateHeader();
    // set UI mode to user
    showToast('Connected as ' + (userProfile.name || userProfile.email));
    // enable scan button if exists
    // find scan button if present
    const scanBtn = $('takeActionBtn') || $('scanBtn');
    if(scanBtn) {
      scanBtn.textContent = 'Scan Inbox';
      scanBtn.disabled = false;
      scanBtn.removeEventListener('click', connectHandler);
      scanBtn.addEventListener('click', startScan);
    }

    // Auto-scan on initial sign-in? We'll not auto-run; user clicks Scan Inbox.
    // But we can try to restore cached senders if any
    renderCompanies();
    renderStats();
  } catch(err){
    console.error('onSignedIn', err);
    showToast('Sign-in failed: ' + (err.message || err));
  }
}

/* ---------- Scanning inbox & processing messages ---------- */
async function startScan(){
  if(!gmailToken) { showToast('Please connect your Gmail first'); return; }
  showToast('Scanning inbox — this may take a minute');

  // reset senders
  senders = {};
  pageState.page = 1;
  renderCompanies(); renderStats();

  try {
    // list messages matching sign-up-like queries within 365 days
    const q = '(welcome OR "confirm your" OR "verify your" OR "create account" OR "complete registration" OR "thanks for registering" OR unsubscribe OR "account created") newer_than:365d';
    const res = await gapi.client.gmail.users.messages.list({ userId: 'me', q, maxResults: 900 });
    const messages = res.result.messages || [];
    if(messages.length === 0) {
      showToast('No signup-like messages found in the last 365 days');
      saveCache(); renderCompanies(); renderStats(); return;
    }

    // process in batches to avoid rate limits
    const batch = 60;
    for(let i=0;i<messages.length;i+=batch){
      const chunk = messages.slice(i, i+batch);
      await Promise.all(chunk.map(m => processMessage(m.id)));
      // small delay
      await new Promise(r => setTimeout(r, 150));
      renderCompanies(); renderStats();
    }

    // finished
    saveCache();
    showToast('Scan complete — found ' + Object.keys(senders).length + ' companies');
  } catch(err){
    console.error('startScan', err);
    showToast('Scan failed: ' + (err.message || err));
  }
}

async function processMessage(id){
  try {
    const resp = await gapi.client.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const msg = resp.result;
    const headers = msg.payload?.headers || [];
    const fromH = headers.find(h=>h.name.toLowerCase()==='from')?.value || '';
    const subject = headers.find(h=>h.name.toLowerCase()==='subject')?.value || '';
    const date = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
    const emailMatch = fromH.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    const senderEmail = emailMatch ? emailMatch[1].toLowerCase() : fromH;
    const domain = senderEmail.includes('@') ? senderEmail.split('@')[1].replace(/^www\./,'').toLowerCase() : senderEmail;

    if(!senders[domain]) senders[domain] = { domain, emails:{}, firstSeen: date?date.toISOString():null, lastSeen: date?date.toISOString():null, count:0, sampleSubjects: [], ai: {}, claimed:false };
    senders[domain].count += 1;
    if(date && (!senders[domain].firstSeen || new Date(senders[domain].firstSeen) > date)) senders[domain].firstSeen = date.toISOString();
    if(date && (!senders[domain].lastSeen || new Date(senders[domain].lastSeen) < date)) senders[domain].lastSeen = date.toISOString();
    senders[domain].emails[senderEmail] = (senders[domain].emails[senderEmail]||0)+1;
    if(subject && senders[domain].sampleSubjects.length < 3) senders[domain].sampleSubjects.push(subject);
  } catch(err){
    console.warn('processMessage', err);
    // continue
  }
}

/* ---------- Rendering: Header, Stats, Companies Grid ---------- */
function updateHeader(){
  // top profile area: avatar + name
  const profileEl = qs('.profile-name');
  const avatar = $('avatar');
  if(userProfile){
    profileEl.textContent = (userProfile.name || userProfile.email) + ' ';
    const caret = document.createElement('span'); caret.className='caret'; caret.textContent='▾';
    profileEl.appendChild(caret);
    if(avatar && userProfile.picture) avatar.src = userProfile.picture;
  } else {
    // guest mode
    if(profileEl) profileEl.textContent = 'Guest';
    if(avatar) avatar.src = '';
  }
}

function renderStats(){
  const companiesCount = Object.keys(senders).length;
  const totalMsgs = Object.values(senders).reduce((s,a)=>s + (a.count||0), 0);

  // If guest, all zeros
  const isGuest = !userProfile;
  const companiesShown = isGuest ? 0 : companiesCount;
  const msgsShown = isGuest ? 0 : totalMsgs;

  $('topCompanies') && ($('topCompanies').textContent = companiesShown);
  $('companiesBig') && ($('companiesBig').textContent = companiesShown);
  $('statCompanies')?.textContent = companiesShown;
  $('statMessages')?.textContent = msgsShown;
  // progress: compute simple ratio: actionsTaken / companiesTotal
  // We'll use claimed/tracked markers in senders[].claimed (not yet used). For now 0 until activity happens.
  const actionsTaken = Object.values(senders).reduce((s,a)=> s + (a.actionsTaken||0), 0);
  const progress = isGuest || companiesCount===0 ? 0 : Math.round((actionsTaken / companiesCount) * 100);
  // update gauge percent text if present
  document.querySelectorAll('.g-percent').forEach(node => node.textContent = (isGuest ? '0%' : progress + '%'));
  // update activity cards
  // find numbers in activity grid (we used static values earlier) -> set to 0 if guest
  document.querySelectorAll('.activity-item .big').forEach((el,i)=>{
    const val = isGuest ? 0 : (i===0 ? Math.max(0, companiesCount >=0 ? Math.min(999, Math.round(companiesCount*0.02)) : 0) : 0);
    el.textContent = val;
  });
}

/* ---------- Companies Grid rendering with search/sort/pagination ---------- */
function getSortedFilteredItems(){
  const q = pageState.query || "";
  let items = Object.values(senders);
  if(q){
    items = items.filter(s => s.domain.includes(q) || Object.keys(s.emails||{}).some(e=>e.includes(q)) || (s.sampleSubjects||[]).join(' ').toLowerCase().includes(q));
  }
  if(pageState.sort === 'freq') items = items.sort((a,b)=>b.count - a.count);
  if(pageState.sort === 'recent') items = items.sort((a,b)=> new Date(b.lastSeen) - new Date(a.lastSeen));
  if(pageState.sort === 'alpha') items = items.sort((a,b)=> a.domain.localeCompare(b.domain));
  return items;
}
function renderCompanies(){
  const container = $('companiesGrid');
  if(!container) return;
  container.innerHTML = '';

  // guest state: show placeholder "connect" cards or zeros
  const isGuest = !userProfile;
  const allItems = getSortedFilteredItems();
  if(isGuest && allItems.length === 0){
    // show placeholder sample 3 boxes (the ones you specified)
    container.appendChild(makeSampleSnapshotCard()); // 1
    container.appendChild(makeSourceIconsCard());     // 2
    container.appendChild(makeLearnMoreCard());       // 3
    return;
  }

  // pagination
  const items = allItems;
  const per = pageState.perPage || 9;
  const page = pageState.page || 1;
  const totalPages = Math.max(1, Math.ceil(items.length / per));
  const start = (page-1)*per;
  const pageItems = items.slice(start, start + per);

  // render items
  if(pageItems.length === 0){
    container.innerHTML = `<div class="card">No companies found</div>`;
  } else {
    pageItems.forEach(s => container.appendChild(companyCardEl(s)));
  }

  // update pagers
  renderPager(totalPages, page);
}

function companyCardEl(s){
  const div = document.createElement('div');
  div.className = 'company';
  div.dataset.domain = s.domain;

  // top row
  const top = document.createElement('div'); top.className = 'top';
  const logoWrap = document.createElement('div'); logoWrap.className = 'logo-round';
  const logoImg = document.createElement('img');
  logoImg.src = `https://logo.clearbit.com/${s.domain}`;
  logoImg.alt = s.domain;
  logoImg.onerror = function(){ this.style.display='none'; logoWrap.textContent = s.domain.charAt(0).toUpperCase(); logoWrap.style.fontWeight='700'; logoWrap.style.color='#111'; };
  logoWrap.appendChild(logoImg);

  const mid = document.createElement('div'); mid.style.flex = '1';
  const domainEl = document.createElement('div'); domainEl.className = 'domain'; domainEl.textContent = s.domain;
  const subEl = document.createElement('div'); subEl.className = 'sub'; subEl.textContent = (Object.keys(s.emails||{})[0] || '') + ' • ' + (s.firstSeen ? new Date(s.firstSeen).toLocaleDateString() : 'Unknown');
  mid.appendChild(domainEl); mid.appendChild(subEl);

  const pillWrap = document.createElement('div'); pillWrap.style.textAlign='right';
  const pill = document.createElement('div'); pill.className = 'pill'; pill.innerText = (userProfile ? (s.count + ' msg' + (s.count>1?'s':'')) : '0 msgs');
  pillWrap.appendChild(pill);

  top.appendChild(logoWrap); top.appendChild(mid); top.appendChild(pillWrap);

  // footer
  const footer = document.createElement('div'); footer.className = 'card-footer';
  const sample = document.createElement('div'); sample.style.flex='1'; sample.textContent = (s.sampleSubjects||[]).slice(0,2).join(' • ');
  const actions = document.createElement('div');
  // checkbox for bulk select
  const cb = document.createElement('input'); cb.type='checkbox'; cb.className='selcb'; cb.dataset.domain = s.domain;
  cb.addEventListener('change', (e)=> handleSelectChange(s.domain, e.target.checked));
  // individual action buttons
  const unsubBtn = document.createElement('button'); unsubBtn.className='btn small'; unsubBtn.textContent='Unsubscribe'; unsubBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openAiModal('unsubscribe', s.domain); });
  const delBtn = document.createElement('button'); delBtn.className='btn small'; delBtn.textContent='Request deletion'; delBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openAiModal('deletion', s.domain); });

  actions.appendChild(cb); actions.appendChild(unsubBtn); actions.appendChild(delBtn);

  footer.appendChild(sample); footer.appendChild(actions);

  div.appendChild(top); div.appendChild(footer);

  div.addEventListener('click', ()=> openCompanyDetails(s.domain));

  return div;
}

/* ---------- Sample cards (3 boxes you required when guest or to match design) ---------- */
function makeSampleSnapshotCard(){
  const card = document.createElement('div'); card.className = 'card';
  card.innerHTML = `
    <div style="text-align:left">
      <div style="font-weight:700;font-family:'Playfair Display',serif;font-size:20px">Websites Spamming you. Total of</div>
      <div style="font-size:40px;font-weight:700;margin-top:8px" id="sampleTotal">573</div>
      <div style="margin-top:6px;color:var(--muted)">websites linked to your email</div>
    </div>
  `;
  return card;
}
function makeSourceIconsCard(){
  const card = document.createElement('div'); card.className='card';
  card.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;justify-content:center">
      <div style="width:60px;height:60px;border-radius:10px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center">N</div>
      <div style="width:60px;height:60px;border-radius:10px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center">U</div>
      <div style="width:60px;height:60px;border-radius:10px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center">S</div>
      <div style="width:60px;height:60px;border-radius:10px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center">A</div>
    </div>
  `;
  return card;
}
function makeLearnMoreCard(){
  const card = document.createElement('div'); card.className='card';
  card.innerHTML = `
    <div>
      <h3>Learn more from your data and make better decisions</h3>
      <p style="color:var(--muted)">Connect your email to analyze your footprint and receive personalized suggestions.</p>
      <div style="margin-top:12px"><button class="btn outline" id="learnMoreBtn">Learn more</button></div>
    </div>
  `;
  return card;
}

/* ---------- Pagination rendering ---------- */
function renderPager(totalPages, currentPage){
  const wrap = $('pagerBottom') || $('paginationWrap');
  if(!wrap) return;
  wrap.innerHTML = '';
  for(let i=1;i<=totalPages;i++){
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (i===currentPage ? ' active' : '');
    btn.textContent = i;
    btn.addEventListener('click', ()=>{ pageState.page = i; renderCompanies(); });
    wrap.appendChild(btn);
  }
}

/* ---------- Selection / Bulk ---------- */
function toggleSelectAll(checked){
  pageState.selectAll = checked;
  document.querySelectorAll('.selcb').forEach(cb => { cb.checked = checked; });
}
function handleSelectChange(domain, checked){
  // store selection in senders[domain].selected
  if(senders[domain]) senders[domain].selected = checked;
}

/* ---------- Modals & company details ---------- */
function openCompanyDetails(domain){
  const s = senders[domain];
  if(!s) return;
  openModal(`<h2>${escapeHtml(domain)}</h2>
    <div style="color:var(--muted)">Found ${s.count} messages • First: ${isoDate(s.firstSeen)}</div>
    <div style="margin-top:8px">${escapeHtml((s.sampleSubjects||[]).slice(0,4).join('\n'))}</div>
    <div style="margin-top:12px"><button class="btn primary" id="modalUnsub">Unsubscribe</button> <button class="btn outline" id="modalDelete">Request deletion</button></div>
  `);
  // wire modal buttons
  setTimeout(()=>{
    $('modalUnsub')?.addEventListener('click', ()=>{ openAiModal('unsubscribe', domain); });
    $('modalDelete')?.addEventListener('click', ()=>{ openAiModal('deletion', domain); });
  }, 120);
}

function openModal(html){
  const modal = $('modal');
  const content = $('modalContent');
  if(!modal || !content) return;
  content.innerHTML = html;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}
function closeModal(){ const modal = $('modal'); if(!modal) return; modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }

/* ---------- Bulk actions ---------- */
async function bulkAction(type){
  if(!userProfile){ showToast('Connect your Gmail to perform this action'); return; }
  const selected = Object.values(senders).filter(s => s.selected);
  if(selected.length===0) { showToast('Select some companies first'); return; }
  // For unsubscribes: generate instructions per domain using worker, show modal with results
  const results = {};
  for(const s of selected){
    const domain = s.domain;
    const prompt = type === 'unsubscribe' ?
      `Provide short step-by-step unsubscribe instructions for ${domain}. If none exist, suggest contacting support@${domain} or visiting ${domain}/account -> email preferences.` :
      `Create a polite GDPR-style data deletion request to support@${domain}. Output JSON with keys "subject" and "body". Use placeholders {name} and {email}.`;
    try{
      const ai = await callAiWorker(prompt);
      results[domain] = ai;
      // store into senders
      s.ai = s.ai || {};
      s.ai[type] = ai;
    }catch(e){
      results[domain] = 'AI error: ' + e.message;
    }
  }
  saveCache();
  // show results in modal
  let html = `<h3>Bulk ${type === 'unsubscribe' ? 'Unsubscribe steps' : 'Deletion requests'}</h3>`;
  for(const d of Object.keys(results)){
    html += `<div style="margin-top:10px"><strong>${escapeHtml(d)}</strong><pre style="white-space:pre-wrap">${escapeHtml(results[d])}</pre></div>`;
  }
  openModal(html);
}

/* ---------- OpenAI Worker call ---------- */
async function callAiWorker(prompt, temperature=0.2){
  const payload = { model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature };
  const res = await fetch(WORKER_URL + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if(!res.ok) {
    const txt = await res.text();
    throw new Error('AI proxy error: ' + txt);
  }
  const j = await res.json();
  const reply = (j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) || JSON.stringify(j, null, 2);
  return reply;
}

/* ---------- Open AI modal for single domain actions ---------- */
async function openAiModal(type, domain){
  if(!userProfile){ showToast('Connect your Gmail to use AI features'); return; }
  openModal(`<div style="min-height:80px">Working on ${escapeHtml(domain)}...</div>`);
  try{
    const prompt = type === 'unsubscribe' ?
      `Provide short step-by-step unsubscribe instructions for ${domain}.` :
      `Create a polite GDPR-style data deletion request to support@${domain}. Output JSON with keys "subject" and "body". Use placeholders {name} and {email}.`;
    const ai = await callAiWorker(prompt);
    // try parse JSON if deletion
    let html = `<h3>${type === 'unsubscribe'? 'Unsubscribe steps' : 'Deletion request'}</h3>`;
    if(type === 'deletion'){
      let parsed = null;
      try{ parsed = JSON.parse(ai); }catch(e){ parsed = null; }
      if(parsed && parsed.subject && parsed.body){
        html += `<div><strong>Subject:</strong> ${escapeHtml(parsed.subject)}</div><pre style="white-space:pre-wrap">${escapeHtml(parsed.body)}</pre>`;
        html += `<div style="margin-top:8px"><button class="btn primary" id="createDraftBtn">Create draft in Gmail</button></div>`;
      } else {
        html += `<pre style="white-space:pre-wrap">${escapeHtml(ai)}</pre>`;
      }
    } else {
      html += `<pre style="white-space:pre-wrap">${escapeHtml(ai)}</pre>`;
    }
    openModal(html);
    // wire create draft
    setTimeout(()=>{
      const btn = $('createDraftBtn');
      if(btn){
        btn.addEventListener('click', async ()=>{
          try{
            const parsed = JSON.parse(ai);
            const to = Object.keys(senders[domain].emails || {})[0] || `support@${domain}`;
            await createGmailDraft(to, parsed.subject, parsed.body);
            showToast('Draft created in Gmail');
          }catch(err){
            showToast('Draft creation failed: ' + (err.message||err));
          }
        });
      }
    }, 120);
  } catch(err){
    openModal(`<div style="color:red">AI error: ${escapeHtml(err.message || err)}</div>`);
  }
}

/* ---------- Create Gmail draft helper ---------- */
async function createGmailDraft(to, subject, body){
  if(!gapi.client) throw new Error('GAPI not initialized');
  function encodeRaw(str){ return btoa(unescape(encodeURIComponent(str))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
  const raw = [`To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset="UTF-8"`, '', body].join('\r\n');
  const rawEncoded = encodeRaw(raw);
  const resp = await gapi.client.gmail.users.drafts.create({ userId:'me', resource:{ message:{ raw: rawEncoded } } });
  if(resp.status !== 200) throw new Error('Draft creation failed');
  return true;
}

/* ---------- Save / Load cache ---------- */
function saveCache(){
  try {
    const payload = { senders, userProfile };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch(e){ console.warn('saveCache', e); }
}

/* ---------- Open company detail in new modal (ai/history etc.) ---------- */
function openCompanyModal(domain){
  const s = senders[domain];
  openModal(`<h3>${escapeHtml(domain)}</h3><pre>${escapeHtml(JSON.stringify(s, null, 2))}</pre>`);
}

/* ---------- Initialize on DOM ready ---------- */
document.addEventListener('DOMContentLoaded', ()=>{
  uiInit();
  // expose a global debug hook to set counts (useful)
  window.__SpamSlam_setCounts = function({ companies, messages } = {}) {
    if(typeof companies !== 'undefined'){ /* fake: create dummy senders if none */ }
  };

  // show guest numbers (all zeros) initially
  renderStats();
  renderCompanies();
});

/* ---------- Expose functions for debugging (optional) ---------- */
window.__spamslam = {
  startScan,
  connectHandler,
  callAiWorker,
  saveCache,
  getSenders: ()=>senders,
  version: VERSION
};
