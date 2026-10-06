const LANG_KEY='savdo_lang';
const LANGS=window.SAVDO_LANGS||['tg','ru','en'];
const LANG_LABELS=window.SAVDO_LANG_LABELS||{tg:'Тоҷикӣ',ru:'Русский',en:'English'};
const I18N=window.SAVDO_I18N||{tg:{},ru:{},en:{}};
function detectLang(){
  const saved=localStorage.getItem(LANG_KEY);
  if(saved&&LANGS.includes(saved))return saved;
  const nav=(navigator.language||'').toLowerCase();
  if(nav.startsWith('tg')||nav.startsWith('tj'))return 'tg';
  if(nav.startsWith('ru'))return 'ru';
  if(nav.startsWith('en'))return 'en';
  return 'tg';
}
let lang=detectLang();
document.documentElement.lang=lang==='tg'?'tg':lang;
function t(key,vars){
  let out=I18N[lang]?.[key]??I18N.ru?.[key]??I18N.en?.[key]??key;
  if(vars)for(const[k,v]of Object.entries(vars))out=String(out).split('{'+k+'}').join(String(v));
  return out;
}
function setLang(l){
  if(!LANGS.includes(l))return;
  lang=l;localStorage.setItem(LANG_KEY,l);
  document.documentElement.lang=l==='tg'?'tg':l;
  const splashP=document.querySelector('#splash p');if(splashP)splashP.textContent=t('splash_loading');
  if(state)render();else auth();
}
function langSwitcherHtml(compact){
  return `<div class="lang-switch${compact?' compact':''}" role="group" aria-label="${t('language')}">${LANGS.map(l=>`<button type="button" class="${lang===l?'active':''}" onclick="setLang('${l}')">${LANG_LABELS[l]||l}</button>`).join('')}</div>`;
}
window.setLang=setLang;window.t=t;
const _splash=document.querySelector('#splashText'); if(_splash)_splash.textContent=t('splash_loading');
const _boot=document.querySelector('#bootLoading'); if(_boot)_boot.textContent=t('loading');


let state=null,view=location.hash.slice(1)||'home',period='month',search='',tab='all',cat='all',authMode='register';
let pendingImage=null; // dataURL | '' | null(keep)
let cart={}; // productId -> qty
let cartPrices={}; // productId -> unit price in minor units (override at sale)
let cartDiscount={percent:0,amount:0}; // amount in major units for input; applied at checkout
let cartWarehouse=1;
let cartWholesale=false;
let cartCustomerId='';
let cartRedeemPoints=0;
let sendTgReceipt=false;
let authPinMode=false;
let inventDraft={}; // productId -> counted
let needWelcome=true;
const PERM_KEYS=['kassa','stock','customers','suppliers','cashbook','reports','analyze','audit','settings','void','discount','import','backup','staff','shops','accounting','fiscal','shift'];
const MODE_KEY='savdo_biz_mode';
const COMPANY_ONLY=new Set(['accounting','central','audit','shops','fiscal','company','period_lock','hub','permissions']);
function draftMode(){return localStorage.getItem(MODE_KEY)||''}
function setDraftMode(m){if(m==='company'||m==='shop')localStorage.setItem(MODE_KEY,m)}
function bizMode(){
  const m=state?.user?.biz_mode||draftMode();
  return m==='company'?'company':m==='shop'?'shop':'';
}
function isCompany(){return bizMode()==='company'}
function modeHas(feat){
  if(!COMPANY_ONLY.has(feat))return true;
  return isCompany();
}
function can(perm){
  if(!state?.user)return false;
  if(COMPANY_ONLY.has(perm)&&!isCompany())return false;
  const p=state.user.permissions;
  if(Array.isArray(p)&&p.length)return p.includes(perm);
  return state.user.role!=='cashier';
}
function isAdminUser(){return can('settings')||can('staff')||(isCompany()&&can('shops'))||(state?.user&&state.user.role!=='cashier')}
function unitLabel(u){return t(u==='kg'?'unit_kg':u==='l'?'unit_l':'unit_pcs')}
function permChecksHtml(selected){
  const set=new Set(selected||[]);
  return `<div class="wide" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:8px">
    ${PERM_KEYS.map(k=>`<label style="display:flex;gap:8px;align-items:center;font-size:13px">
      <input type="checkbox" name="perm_${k}" value="1" ${set.has(k)?'checked':''} style="width:auto"> ${t('perm_'+k)}
    </label>`).join('')}
  </div>`;
}
function readPermsFromBody(b){
  return PERM_KEYS.filter(k=>b['perm_'+k]);
}
function sellP(p){
  if(cartPrices[p.id]!=null)return Number(cartPrices[p.id])||0;
  if(cartWholesale){const w=Number(p.wholesale_price)||0;if(w>0)return w}
  const promo=Number(p.promo_price)||0;return promo>0?promo:p.price;
}
function whStock(p,wh=cartWarehouse){return Number(wh)===2?(Number(p.stock2)||0):p.stock}
function whName(n){
  if(n===2)return state?.user?.wh2_name||t('warehouse_2');
  return state?.user?.wh1_name||t('warehouse_main');
}
function expiryStatus(p){
  const e=String(p.expiry||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(e))return '';
  const today=state?.today||'';
  if(e<today)return 'expired';
  const soon=new Date(today+'T00:00:00');soon.setDate(soon.getDate()+14);
  const lim=soon.toISOString().slice(0,10);
  if(e<=lim)return 'soon';
  return '';
}
let hubInfo=null;
let syncing=false;
let deferredInstall=null;
let installHintDismissed=localStorage.getItem('savdo_install_hide')==='1';
const QUEUE_KEY='savdo_op_queue';
const STATE_KEY='savdo_state_cache';
const HUB_KEY='savdo_hub_origin';
function isPublicCloud(){
  const h=String(location.hostname||'');
  if(!h||h==='localhost'||h==='127.0.0.1')return false;
  if(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))return false;
  return true;
}
function isNativeShell(){
  try{
    const C=window.Capacitor;
    if(C&&typeof C.isNativePlatform==='function')return !!C.isNativePlatform();
    if(C&&C.isNative===true)return true;
    const href=String(location.href||'');
    return href.startsWith('capacitor:')||href.startsWith('ionic:');
  }catch{return false}
}
function needsHubField(){
  return isNativeShell() || !isPublicCloud();
}
function hubBase(){
  const saved=String(localStorage.getItem(HUB_KEY)||'').trim().replace(/\/$/,'');
  if(saved)return saved;
  if(isNativeShell())return '';
  return location.origin;
}
function setHubBase(url){
  const u=String(url||'').trim().replace(/\/$/,'');
  if(!u){localStorage.removeItem(HUB_KEY);return ''}
  if(!/^https?:\/\//i.test(u))throw Error(t('bad_hub_url'));
  localStorage.setItem(HUB_KEY,u);
  return u;
}
function apiUrl(path){return hubBase().replace(/\/$/,'')+'/api/'+String(path||'').replace(/^\//,'')}

function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone===true
    || document.referrer.includes('android-app://');
}
function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent)}
function isAndroid(){return /android/i.test(navigator.userAgent)}
function installBannerHtml(){
  if(isStandalone()||installHintDismissed)return '';
  const ico=`<div class="store-row"><div class="store-ico">S</div><div><b>`;
  const endIco=`</div></div>`;
  if(deferredInstall){
    return `<div class="install-banner">
      ${ico}${t('install_open')}</b><div class="store-meta">${t('install_hint')}<br>${t('one_db_hint')}</div>${endIco}
      <div class="acts">
        <button class="primary" onclick="installApp()">${t('install')}</button>
        <button class="outline" onclick="hideInstall()">${t('later')}</button>
      </div>
    </div>`;
  }
  if(isIOS()){
    return `<div class="install-banner">
      ${ico}${t('install_ios')}</b><div class="store-meta">${t('install_ios_how')}<br>${t('one_db_hint')}</div>${endIco}
      <button class="outline" onclick="hideInstall()">${t('got_it')}</button>
    </div>`;
  }
  if(isAndroid()){
    return `<div class="install-banner">
      ${ico}${t('install_android')}</b><div class="store-meta">${t('install_android_how')}<br>${t('one_db_hint')}</div>${endIco}
      <button class="outline" onclick="hideInstall()">${t('got_it')}</button>
    </div>`;
  }
  return `<div class="install-banner">
    ${ico}${t('install_pc')}</b><div class="store-meta">${t('install_pc_how')}<br>${t('one_db_hint')}</div>${endIco}
    <button class="outline" onclick="hideInstall()">${t('hide')}</button>
  </div>`;
}
function hideInstall(){installHintDismissed=true;localStorage.setItem('savdo_install_hide','1');if(state)render()}
async function installApp(){
  if(!deferredInstall){toast(t('install_browser'));return}
  deferredInstall.prompt();
  const res=await deferredInstall.userChoice;
  deferredInstall=null;
  if(res.outcome==='accepted'){hideInstall();toast(t('install_ok'))}
  else if(state)render();
}

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n/100);
const unit=()=>({TJS:'с.',USD:'$',EUR:'€',RUB:'₽'}[state?.user.currency]||'с.');
const cash=n=>fmt(n)+' '+unit();
const newOpId=()=>(crypto.randomUUID?crypto.randomUUID():Date.now().toString(16)+'-'+Math.random().toString(16).slice(2));
function readQueue(){try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]')}catch{return[]}}
function writeQueue(q){localStorage.setItem(QUEUE_KEY,JSON.stringify(q))}
function queueCount(){return readQueue().length}
function isNetErr(e){return e instanceof TypeError||/Failed to fetch|NetworkError|Load failed|офлайн/i.test(String(e&&e.message||e))}

async function api(path,data){
  const write=data!==undefined;
  const op_id=write?newOpId():null;
  if(!hubBase())throw Error(t('need_hub_url'));
  const ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  const timer=ctrl?setTimeout(()=>ctrl.abort(),18000):null;
  try{
    const r=await fetch(apiUrl(path),{
      method:write?'POST':'GET',
      credentials:'include',
      signal:ctrl?ctrl.signal:undefined,
      headers:write
        ?{'Content-Type':'application/json','X-Savdo-Lang':lang,'X-Savdo-Op':op_id}
        :{'X-Savdo-Lang':lang},
      body:write?JSON.stringify({...data,op_id}):undefined
    });
    const b=await r.json();
    if(!r.ok){
      const err=Error(b.error||t('err'));
      err.status=r.status;
      throw err;
    }
    if(path==='state'){
      delete b._offline;
      localStorage.setItem(STATE_KEY,JSON.stringify(b));
    }
    return b;
  }catch(e){
    if(write&&isNetErr(e)){
      const q=readQueue();
      q.push({op_id,path,body:data,ts:Date.now()});
      writeQueue(q);
      applyOffline(path,data);
      return {ok:true,queued:true};
    }
    // 401 = need login — never fall back to stale cache
    if(path==='state'&&(e.status===401||/ворид|войдите|sign in/i.test(String(e.message||'')))){
      throw e;
    }
    if(path==='state'&&!e.status){
      const raw=localStorage.getItem(STATE_KEY);
      if(raw){
        try{
          const b=JSON.parse(raw);
          b._offline=true;
          return b;
        }catch{}
      }
    }
    if(e&&e.name==='AbortError')throw Error(t('no_net'));
    throw e;
  }finally{
    if(timer)clearTimeout(timer);
  }
}

function applyOffline(path,data){
  try{
    const raw=localStorage.getItem(STATE_KEY);
    if(!raw)return;
    const s=JSON.parse(raw);
    if(path==='cart/checkout'&&Array.isArray(data.items)){
      for(const it of data.items){
        const p=s.products.find(x=>x.id===Number(it.product));
        if(p)p.stock=Math.max(0,p.stock-Number(it.qty||0));
      }
    }
    if(path==='movement'&&data.kind==='sale'){
      const p=s.products.find(x=>x.id===Number(data.product));
      if(p)p.stock=Math.max(0,p.stock-Number(data.qty||0));
    }
    if(path==='movement'&&data.kind==='receipt'){
      const p=s.products.find(x=>x.id===Number(data.product));
      if(p)p.stock+=Number(data.qty||0);
    }
    if(path==='movement'&&data.kind==='writeoff'){
      const p=s.products.find(x=>x.id===Number(data.product));
      if(p)p.stock=Math.max(0,p.stock-Number(data.qty||0));
    }
    if(path==='inventory'&&Array.isArray(data.items)){
      for(const it of data.items){
        const p=s.products.find(x=>x.id===Number(it.product));
        if(p&&Number.isFinite(Number(it.counted)))p.stock=Math.max(0,Number(it.counted));
      }
    }
    s._offline=true;
    localStorage.setItem(STATE_KEY,JSON.stringify(s));
    state=s;
  }catch{}
}

async function hubAlive(){
  try{
    if(!hubBase())return false;
    const ctrl=typeof AbortController!=='undefined'?new AbortController():null;
    const timer=ctrl?setTimeout(()=>ctrl.abort(),5000):null;
    try{
      const r=await fetch(apiUrl('sync/info'),{
        method:'GET',credentials:'include',headers:{'X-Savdo-Lang':lang},cache:'no-store',
        signal:ctrl?ctrl.signal:undefined
      });
      return r.ok;
    }finally{if(timer)clearTimeout(timer)}
  }catch{return false}
}
async function fetchHubInfo(){
  try{
    if(!hubBase())return null;
    const r=await fetch(apiUrl('sync/info'),{method:'GET',credentials:'include',headers:{'X-Savdo-Lang':lang},cache:'no-store'});
    if(!r.ok)return null;
    return await r.json();
  }catch{return null}
}
async function syncNow(opts={}){
  if(syncing)return false;
  const quiet=!!opts.quiet;
  const alive=await hubAlive();
  if(!alive){
    if(state){state._offline=true;render()}
    if(!quiet)toast(navigator.onLine?t('hub_down'):t('no_net'));
    return false;
  }
  syncing=true;if(state)render();
  try{
    const q=readQueue();
    let done=0;
    for(let i=0;i<q.length;i++){
      const op=q[i];
      try{
        const r=await fetch(apiUrl(op.path),{
          method:'POST',
          credentials:'include',
          headers:{'Content-Type':'application/json','X-Savdo-Lang':lang,'X-Savdo-Op':op.op_id||''},
          body:JSON.stringify({...op.body,op_id:op.op_id})
        });
        const b=await r.json();
        if(!r.ok)throw Error(b.error||t('err'));
        done++;
      }catch(e){
        writeQueue(q.slice(i));
        if(state){state._offline=true;render()}
        if(!quiet)toast(isNetErr(e)?t('hub_down'):(t('sync')+': '+e.message));
        return false;
      }
    }
    writeQueue([]);
    if(state)delete state._offline;
    await load();
    const info=await fetchHubInfo();
    if(info){
      hubInfo=info;
      startSyncWatch._lastOp=Number(info.lastOpAt||0);
    }
    if(done>0)toast(t('sync_done',{n:done}));
    else if(!quiet)toast(t('sync_empty'));
    return true;
  }finally{syncing=false;if(state)render()}
}
async function flushToHub(){
  for(let i=0;i<10;i++){
    const ok=await syncNow({quiet:true});
    if(ok)return true;
    await new Promise(r=>setTimeout(r,1200));
  }
  return false;
}
function startSyncWatch(){
  if(startSyncWatch._t)return;
  const tick=async()=>{
    if(!state||syncing)return;
    const info=await fetchHubInfo();
    if(!info){
      if(!state._offline){state._offline=true;render()}
      return;
    }
    hubInfo=info;
    const cameOnline=!!state._offline;
    const qn=queueCount();
    const at=Number(info.lastOpAt||0);
    if(qn||cameOnline){
      await syncNow({quiet:true});
      return;
    }
    if(state._offline){delete state._offline;render()}
    if(startSyncWatch._lastOp==null){
      startSyncWatch._lastOp=at;
      return;
    }
    if(at>Number(startSyncWatch._lastOp||0)){
      startSyncWatch._lastOp=at;
      try{await load()}catch{}
    }
  };
  startSyncWatch._t=setInterval(tick,3000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick()});
  window.addEventListener('focus',()=>tick());
  setTimeout(tick,600);
}

function toast(s){const t=document.querySelector('#toast');t.textContent=s;t.style.display='block';clearTimeout(toast._t);toast._t=setTimeout(()=>t.style.display='none',2800)}

async function load(){
  try{
    state=await api('state');
    if(state&&!state._offline)delete state._offline;
    try{hubInfo=await api('sync/info')}catch{hubInfo=null}
    if(state&&!state._offline&&!(await hubAlive())){
      state._offline=true;
    }
    if(!state.user.biz_mode){
      hideSplash();
      showModePicker(async mode=>{
        try{
          await api('biz-mode',{biz_mode:mode});
          setDraftMode(mode);
          await load();
        }catch(e){toast(e.message)}
      });
      return;
    }
    setDraftMode(state.user.biz_mode);
    const allowed=['settings'];
    if(can('kassa')||can('shift'))allowed.unshift('kassa');
    if(can('reports')||can('analyze')||can('stock'))allowed.unshift('home');
    if(can('stock'))allowed.push('stock');
    if(can('customers'))allowed.push('customers');
    if(can('suppliers'))allowed.push('suppliers');
    if(can('cashbook'))allowed.push('cashbook');
    if(can('reports'))allowed.push('reports');
    if(can('analyze'))allowed.push('analyze');
    if(can('audit')&&modeHas('audit'))allowed.push('audit');
    if(can('accounting')&&modeHas('accounting'))allowed.push('accounting');
    if(can('shops')&&modeHas('central'))allowed.push('central');
    if(!allowed.includes(view))view=allowed.includes('home')?'home':(allowed.includes('kassa')?'kassa':'settings');
    render();
    hideSplash();
    if(needWelcome){needWelcome=false;showWelcomeFlash()}
    startSyncWatch();
    if(queueCount())syncNow({quiet:true});
  }catch(e){
    hideSplash();
    if(e.status===401||/ворид|войдите|sign in/i.test(String(e.message||'')))auth();
    else document.querySelector('#app').innerHTML=`<div class="loading">${esc(e.message||t('err'))} <button class="primary" onclick="load()">${t('retry')}</button></div>`;
  }
}
function showModePicker(onPick){
  hideSplash();
  document.querySelector('#app').innerHTML=`
  <div class="mode-pick">
    <div class="mode-pick-inner">
      <div style="text-align:center;margin-bottom:18px">${langSwitcherHtml()}</div>
      <div class="brand" style="justify-content:center;color:var(--forest);margin-bottom:18px"><span class="mark">S</span>Savdo</div>
      <h1>${t('mode_pick_title')}</h1>
      <p class="sub">${t('mode_pick_sub')}</p>
      <div class="mode-cards">
        <button type="button" class="mode-card company" id="pickCompany">
          <span class="mode-ico">К</span>
          <b>${t('mode_company')}</b>
          <p class="mode-card-desc">${t('mode_company_desc')}</p>
          <span class="mode-go">→</span>
        </button>
        <button type="button" class="mode-card shop" id="pickShop">
          <span class="mode-ico">М</span>
          <b>${t('mode_shop')}</b>
          <p class="mode-card-desc">${t('mode_shop_desc')}</p>
          <span class="mode-go">→</span>
        </button>
      </div>
    </div>
  </div>`;
  document.querySelector('#pickCompany').onclick=()=>onPick('company');
  document.querySelector('#pickShop').onclick=()=>onPick('shop');
}
function showWelcomeFlash(){
  const el=document.createElement('div');
  el.className='welcome-flash';
  el.setAttribute('aria-hidden','true');
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),1200);
}
function lowLimit(){
  const n=Number(state?.user?.low_stock);
  return Number.isFinite(n)?Math.max(0,Math.floor(n)):5;
}
function isLow(p){const s=whStock(p,1)+(Number(p.stock2)||0);return s>0&&s<=lowLimit()}
function isOut(p){return (whStock(p,1)+(Number(p.stock2)||0))<=0}
function productRanks(s){
  return state.products.map(p=>{
    const sold=s.m.filter(m=>m.product_id===p.id&&m.kind==='sale').reduce((a,m)=>a+m.qty,0)
      -s.m.filter(m=>m.product_id===p.id&&m.kind==='return').reduce((a,m)=>a+m.qty,0);
    const revenue=s.m.filter(m=>m.product_id===p.id&&m.kind==='sale').reduce((a,m)=>a+m.qty*m.price,0)
      -s.m.filter(m=>m.product_id===p.id&&m.kind==='return').reduce((a,m)=>a+m.qty*m.price,0);
    const profit=s.m.filter(m=>m.product_id===p.id&&m.kind==='sale').reduce((a,m)=>a+m.qty*(m.price-m.cost),0)
      -s.m.filter(m=>m.product_id===p.id&&m.kind==='return').reduce((a,m)=>a+m.qty*(m.price-m.cost),0);
    return{...p,sold:Math.max(0,sold),revenue:Math.max(0,revenue),profit};
  });
}

function hideSplash(){
  const s=document.querySelector('#splash');
  if(!s)return;
  s.classList.add('hide');
  clearTimeout(hideSplash._t);
  hideSplash._t=setTimeout(()=>{try{s.remove()}catch{}},400);
}
// phone: never leave splash stuck
setTimeout(()=>{try{hideSplash()}catch{}},1500);
setTimeout(()=>{try{hideSplash()}catch{}},4000);
function auth(){
  state=null;
  hideSplash();
  if(!draftMode()){
    showModePicker(mode=>{setDraftMode(mode);auth()});
    return;
  }
  const pinForm=authMode==='login'&&authPinMode;
  const mode=draftMode();
  document.querySelector('#app').innerHTML=`
  <div class="auth">
    <section class="auth-art">
      <div class="brand"><span class="mark">S</span>Savdo</div>
      <h1>${t('auth_title')}</h1>
      <p>${t('auth_sub')}</p>
      <div class="auth-badges">
        <span>${mode==='company'?t('mode_company_badge'):t('mode_shop_badge')}</span>
        <span>${t('badge_pc')}</span><span>${t('badge_android')}</span><span>${t('badge_iphone')}</span><span>${t('badge_offline')}</span>
      </div>
    </section>
    <section class="auth-form"><div class="auth-box">${langSwitcherHtml()}
      <h2>${authMode==='login'?t('welcome'):(mode==='company'?t('mode_company'):t('create_shop'))}</h2>
      <div class="sub">${pinForm?t('pin_hint'):authMode==='login'?t('login_hint'):t('register_hint')}</div>
      <form id="authForm">
        ${needsHubField()?`<label class="wide">${t('hub_connect')}<input name="hub" id="hubInput" value="${esc(hubBase()||location.origin)}" placeholder="https://savdo.example.com" maxlength="200"><small style="color:var(--muted)">${t('hub_connect_hint')}</small></label>`:`<input type="hidden" name="hub" value="${esc(location.origin)}">`}
        ${authMode==='register'?`<label>${t('shop_name')}<input name="name" required maxlength="100" placeholder="${t('shop_ph')}"></label>`:''}
        ${pinForm
          ?`<label>${t('pin')}<input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" required autocomplete="one-time-code" placeholder="${t('pin_hint')}"></label>`
          :`<label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>${t('password')}<input name="password" type="password" minlength="8" required autocomplete="${authMode==='login'?'current-password':'new-password'}" placeholder="${t('password_ph')}"></label>`}
        <div class="error" id="authError"></div>
        <button class="primary">${authMode==='login'?t('login'):t('start')}</button>
      </form>
      ${authMode==='login'?`<button class="switch" id="pinBtn" type="button">${authPinMode?t('email_login'):t('pin_login')}</button>`:''}
      <button class="switch" id="switchBtn">${authMode==='login'?t('new_account'):t('have_account')}</button>
      <button class="switch" id="modeBtn" type="button">${t('mode_change')}</button>
    </div></section>
  </div>`;
  document.querySelector('#switchBtn').onclick=()=>{authMode=authMode==='login'?'register':'login';authPinMode=false;auth()};
  document.querySelector('#modeBtn').onclick=()=>{localStorage.removeItem(MODE_KEY);auth()};
  document.querySelector('#pinBtn')?.addEventListener('click',()=>{authPinMode=!authPinMode;auth()});
  document.querySelector('#authForm').onsubmit=async e=>{
    e.preventDefault();const btn=e.target.querySelector('.primary');btn.disabled=true;
    try{
      const body=Object.fromEntries(new FormData(e.target));
      const hub=String(body.hub||'').trim();
      delete body.hub;
      if(hub)setHubBase(hub);
      if(!hubBase())throw Error(t('need_hub_url'));
      if(authMode==='register')body.biz_mode=draftMode()||'shop';
      if(pinForm)await api('login/pin',body);
      else await api(authMode,body);
      load();
    }catch(err){document.querySelector('#authError').textContent=err.message;btn.disabled=false}
  };
}

const navs=()=>{
  const all=[
    ['home','⌂',t('nav_home'),()=>can('reports')||can('analyze')||can('stock')],
    ['kassa','◉',t('nav_kassa'),()=>can('kassa')||can('shift')],
    ['stock','▤',t('nav_stock'),()=>can('stock')],
    ['customers','☺',t('nav_customers'),()=>can('customers')],
    ['suppliers','▣',t('nav_suppliers'),()=>can('suppliers')],
    ['cashbook','◎',t('nav_cashbook'),()=>can('cashbook')],
    ['analyze','★',t('nav_analyze'),()=>can('analyze')],
    ['reports','▥',t('nav_reports'),()=>can('reports')],
    ['accounting','Σ',t('nav_accounting'),()=>can('accounting')&&modeHas('accounting')],
    ['central','◈',t('nav_central'),()=>can('shops')&&modeHas('central')],
    ['audit','☰',t('nav_audit'),()=>can('audit')&&modeHas('audit')],
    ['settings','⚙',t('nav_settings'),()=>true]
  ];
  return all.filter(([, , ,ok])=>ok());
};

function go(k){
  const allowed=navs().map(n=>n[0]);
  if(!allowed.includes(k)){toast(t('cashier_only'));k=allowed[0]||'settings'}
  view=k;search='';tab='all';cat='all';location.hash=k;render();
}
function dayBefore(iso){
  const x=new Date(iso+'T12:00:00');
  x.setDate(x.getDate()-1);
  return x.toISOString().slice(0,10);
}
function isOpeningDebt(m){
  return !m.product_id && String(m.note||'').startsWith('[opening]');
}
function openingNote(n){return String(n||'').replace(/^\[opening\]\s*/i,'').trim()}
function dayStats(date){
  const m=(state.movements||[]).filter(x=>x.date===date);
  const sales=m.filter(x=>x.kind==='sale'&&!isOpeningDebt(x));
  const returns=m.filter(x=>x.kind==='return');
  const rev=sales.reduce((a,x)=>a+x.qty*x.price,0)-returns.reduce((a,x)=>a+x.qty*x.price,0);
  const cost=sales.reduce((a,x)=>a+x.qty*x.cost,0)-returns.reduce((a,x)=>a+x.qty*x.cost,0);
  const expense=m.filter(x=>x.kind==='expense').reduce((a,x)=>a+x.price,0);
  const checks=new Set(sales.map(x=>x.batch||('id:'+x.id))).size;
  const qty=sales.reduce((a,x)=>a+x.qty,0)-returns.reduce((a,x)=>a+x.qty,0);
  return{rev,cost,profit:rev-cost,expense,checks,qty};
}
function pctChange(now,prev){
  if(!prev)return now?100:0;
  return Math.round((now-prev)*100/Math.abs(prev));
}
function deltaHtml(now,prev){
  const p=pctChange(now,prev);
  const cls=p>0?'up':p<0?'down':'flat';
  const sign=p>0?'+':'';
  return `<span class="delta ${cls}">${sign}${p}% ${t('vs_yesterday')}</span>`;
}
function homePage(){
  const today=state.today;
  const yday=dayBefore(today);
  const a=dayStats(today);
  const b=dayStats(yday);
  const debt=(state.customers||[]).reduce((x,c)=>x+(c.debt||0),0);
  const low=state.products.filter(p=>isLow(p)||isOut(p)).length;
  return `
  <div class="panel" style="margin-bottom:12px">
    <div class="panel-h"><div><h2>${t('today_vs_yesterday')}</h2><p>${esc(today)} · ${t('yesterday')}: ${esc(yday)}</p></div>
      <button class="gold" onclick="go('kassa')">${t('nav_kassa')}</button>
    </div>
  </div>
  <div class="dash-grid">
    <div class="dash-card dark">
      <span>${t('today')} · ${t('sales')}</span>
      <strong>${cash(a.rev)}</strong>
      <div class="sub">${cash(b.rev)} · ${t('yesterday')}</div>
      ${deltaHtml(a.rev,b.rev)}
    </div>
    <div class="dash-card">
      <span>${t('today')} · ${t('profit')}</span>
      <strong>${cash(a.profit)}</strong>
      <div class="sub">${cash(b.profit)} · ${t('yesterday')}</div>
      ${deltaHtml(a.profit,b.profit)}
    </div>
    <div class="dash-card">
      <span>${t('checks_today')}</span>
      <strong>${a.checks}</strong>
      <div class="sub">${b.checks} · ${t('yesterday')}</div>
      ${deltaHtml(a.checks,b.checks)}
    </div>
    <div class="dash-card">
      <span>${t('sold')}</span>
      <strong>${a.qty}</strong>
      <div class="sub">${b.qty} · ${t('yesterday')}</div>
      ${deltaHtml(a.qty,b.qty)}
    </div>
  </div>
  <div class="stats" style="margin-top:12px">
    <div class="stat"><span>${t('customer_debts')}</span><strong>${cash(debt)}</strong></div>
    <div class="stat"><span>${t('supplier_debt')}</span><strong>${cash(state.supplier_debt_total||0)}</strong></div>
    <div class="stat"><span>${t('low_stock')}</span><strong style="color:${low?'var(--danger)':''}">${low}</strong></div>
  </div>
  <div class="acts" style="margin-top:14px">
    <button class="primary" onclick="go('kassa')">${t('nav_kassa')}</button>
    <button class="outline" onclick="go('reports')">${t('nav_reports')}</button>
    <button class="outline" onclick="go('analyze')">${t('nav_analyze')}</button>
  </div>`;
}
function productPhoto(p,cls='ph'){
  if(p?.image)return `<div class="${cls}"><img src="${p.image}" alt=""></div>`;
  return `<div class="${cls}">▣</div>`;
}
function compressImage(file){
  return new Promise((resolve,reject)=>{
    if(!file||!file.type.startsWith('image/'))return reject(Error(t('not_photo')));
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      const max=720;
      let w=img.width,h=img.height;
      if(w>max||h>max){const r=Math.min(max/w,max/h);w=Math.round(w*r);h=Math.round(h*r)}
      const c=document.createElement('canvas');c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg',0.72));
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(Error(t('photo_fail')))};
    img.src=url;
  });
}
window.addEventListener('hashchange',()=>{const k=location.hash.slice(1)||'kassa';if(k!==view&&state)go(k)});

function filtered(){
  const d=state.today;let start=d;
  if(period==='week'){const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()-6);start=x.toISOString().slice(0,10)}
  if(period==='month')start=d.slice(0,7)+'-01';
  if(period==='all')start='0000-00-00';
  return state.movements.filter(m=>m.date>=start&&m.date<=d);
}
function stats(){
  const m=filtered();
  const sales=m.filter(x=>x.kind==='sale'&&!isOpeningDebt(x));
  const returns=m.filter(x=>x.kind==='return');
  const rev=sales.reduce((a,x)=>a+x.qty*x.price,0)-returns.reduce((a,x)=>a+x.qty*x.price,0);
  const cost=sales.reduce((a,x)=>a+x.qty*x.cost,0)-returns.reduce((a,x)=>a+x.qty*x.cost,0);
  const expense=m.filter(x=>x.kind==='expense').reduce((a,x)=>a+x.price,0);
  const qty=sales.reduce((a,x)=>a+x.qty,0)-returns.reduce((a,x)=>a+x.qty,0);
  const debt=(state.customers||[]).reduce((a,c)=>a+c.debt,0);
  return{m,sales,returns,rev,cost,expense,profit:rev-cost,qty,debt};
}
function kindLabel(k,m){
  if(m&&isOpeningDebt(m))return t('opening_debt');
  return{sale:t('kind_sale'),receipt:t('kind_receipt'),expense:t('kind_expense'),return:t('kind_return'),writeoff:t('kind_writeoff'),adjust:t('kind_adjust')}[k]||k;
}
function kindPill(k){return`pill ${k==='expense'||k==='return'?(k==='expense'?'warn':'return'):k==='receipt'?'gray':''}`}

function render(){
  const s=stats();
  const limit=lowLimit();
  const low=state.products.filter(isLow);
  const out=state.products.filter(isOut);
  const debtors=(state.customers||[]).filter(c=>c.debt>0).length;
  const title=navs().find(n=>n[0]===view)[2];
  const alertHtml=(low.length||out.length)?`
    <div class="low-banner">
      <div>
        <b>⚠ ${t('low_stock_banner')}</b>
        <p>${out.length?t('out_count',{n:out.length}):''}${low.length?t('low_count',{n:low.length,limit}):''}${t('threshold_settings',{limit})}</p>
      </div>
      <button onclick="go('stock')">${t('view_stock')}</button>
    </div>`:'';
  const qn=queueCount();
  const offline=!!state._offline;
  const syncHtml=(offline||qn)?`<div class="sync-bar ${offline?'off':'queue'}">
      <span>${offline?t('offline_queue'):t('queue_ops',{n:qn})}</span>
    </div>`:'';
  document.querySelector('#app').innerHTML=`
  <div class="app">
    <aside>
      <div class="brand"><span class="mark">S</span>Savdo</div>
      <div class="nav-label">${t('menu')}</div>
      <nav>${navs().map(([k,i,n])=>`<button class="${view===k?'active':''}" onclick="go('${k}')"><span>${i}</span>${n}</button>`).join('')}</nav>
      ${isCompany()&&((state.shops||[]).length>1||can('shops'))?`<div class="shop-switch" style="padding:10px 14px 0">
        <div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:6px">${t('switch_shop')}</div>
        <select onchange="switchShop(this.value)" style="width:100%;font-size:13px">
          ${(state.shops||[{id:state.user.active_shop_id,name:state.user.name}]).map(s=>`<option value="${s.id}" ${Number(s.id)===Number(state.user.active_shop_id)?'selected':''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>`:''}
      <div class="aside-foot"><b>${esc(state.user.name)}</b>${state.user.currency} · ${isCompany()?t('mode_company_badge'):t('mode_shop_badge')}<br><button class="outline" style="padding:6px 10px;margin-top:10px;font-size:12px" onclick="logout()">${t('logout')}</button></div>
    </aside>
    <main>
      <div class="top">
        <div><h1>${title}</h1><p>${esc(state.user.name)} · ${state.today}</p></div>
        <div class="chips">${langSwitcherHtml(true)}
          ${debtors?`<span class="chip">${t('debtors',{n:debtors})}</span>`:''}
          ${low.length||out.length
            ?`<span class="chip danger" onclick="go('stock')" style="cursor:pointer">${out.length?t('out_short',{n:out.length}):''}${low.length?t('low_short',{n:low.length}):''}</span>`:`<span class="chip ok">${t('stock_ok')}</span>`}
        </div>
      </div>
      ${installBannerHtml()}
      ${syncHtml}
      ${alertHtml}
      ${page(s)}
    </main>
  </div>`;
  if(view==='settings'){
    document.querySelector('#settingsForm')?.addEventListener('submit',saveSettings);
    document.querySelector('#restoreFile')?.addEventListener('change',restoreBackup);
  }
  if(view==='stock'){
    document.querySelector('#importCsvFile')?.addEventListener('change',importProductsCsv);
  }
}

function page(s){
  if(view==='home')return homePage();
  if(view==='kassa')return kassaPage(s);
  if(view==='stock')return stockPage();
  if(view==='customers')return customersPage(s);
  if(view==='suppliers')return suppliersPage(s);
  if(view==='cashbook')return cashbookPage();
  if(view==='analyze')return analyzePage(s);
  if(view==='reports')return reportsPage(s);
  if(view==='audit')return auditPage();
  if(view==='accounting')return accountingPage();
  if(view==='central')return centralPage();
  return settingsPage();
}
function accountingPage(){
  const a=state.accounting||{revenue:0,cogs:0,expenses:0,gross:0,net:0,entries:[]};
  return `<div class="panel"><div class="panel-b">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <h2 style="margin:0;font-family:var(--display)">${t('accounting_title')}</h2>
      <button class="outline" type="button" onclick="rebuildBooks()">${t('rebuild_books')}</button>
    </div>
    <div class="stats" style="margin:16px 0;grid-template-columns:repeat(2,1fr)">
      <div class="stat"><span>${t('revenue')}</span><strong>${cash(a.revenue||0)}</strong></div>
      <div class="stat"><span>${t('cogs')}</span><strong>${cash(a.cogs||0)}</strong></div>
      <div class="stat"><span>${t('gross_profit')}</span><strong>${cash(a.gross||0)}</strong></div>
      <div class="stat dark"><span>${t('net_profit')}</span><strong>${cash(a.net||0)}</strong></div>
    </div>
    <h3 style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('journal')}</h3>
    ${(a.entries||[]).length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('date')}</th><th>Dr</th><th>Cr</th><th>${t('summary')}</th><th>ref</th></tr></thead>
      <tbody>${a.entries.map(e=>`<tr>
        <td>${esc(e.date)}</td><td>${esc(e.debit)}</td><td>${esc(e.credit)}</td>
        <td>${cash(e.amount)}</td><td>${esc(e.ref||e.note||'')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('audit_empty')}</h3></div>`}
  </div></div>`;
}
function centralPage(){
  const c=state.central||{shops:[],remote:[],day:state.today};
  const rows=[...(c.shops||[]),...(c.remote||[])];
  return `<div class="panel"><div class="panel-b">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <h2 style="margin:0;font-family:var(--display)">${t('central_title')}</h2>
      <button class="primary" type="button" onclick="pushToHub()">${t('hub_push')}</button>
    </div>
    <p style="margin:8px 0 16px;color:var(--muted);font-size:14px">${esc(c.day||state.today)} · ${t('hub_hint')}</p>
    ${rows.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('shop')}</th><th>${t('kind_sale')}</th><th>${t('sales_period')}</th><th></th></tr></thead>
      <tbody>${rows.map(s=>`<tr>
        <td><b>${esc(s.name)}</b>${s.main?' · main':''}${s.source==='remote'?' · '+t('remote_shop'):''}</td>
        <td>${cash(s.sales_today||0)}</td>
        <td>${cash(s.sales_month||0)}</td>
        <td>${s.source!=='remote'&&Number(s.id)!==Number(state.user.active_shop_id)?`<button class="outline" onclick="switchShop(${s.id})">${t('switch_shop')}</button>`:''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('branches')}</h3></div>`}
  </div></div>`;
}
async function rebuildBooks(){
  try{await api('accounting/rebuild',{});await load();toast(t('saved'))}catch(e){toast(e.message)}
}
async function pushToHub(){
  try{await api('sync/push',{});toast(t('hub_pushed'))}catch(e){toast(e.message)}
}
async function saveRemoteUrl(){
  try{
    const url=String(document.querySelector('#remoteUrlInput')?.value||'').trim();
    const r=await api('remote-url',{url});
    if(hubInfo)hubInfo.remoteUrl=r.remoteUrl||url;
    toast(t('remote_saved'));
    render();
  }catch(e){toast(e.message)}
}
async function clearRemoteUrl(){
  try{
    await api('remote-url',{clear:1,url:''});
    if(hubInfo)hubInfo.remoteUrl='';
    const el=document.querySelector('#remoteUrlInput');if(el)el.value='';
    toast(t('saved'));
    render();
  }catch(e){toast(e.message)}
}
function copyRemoteUrl(){
  const u=(hubInfo&&hubInfo.remoteUrl)||document.querySelector('#remoteUrlInput')?.value||'';
  if(!u){toast(t('remote_none'));return}
  navigator.clipboard.writeText(u);toast(t('addr_copied'));
}
window.saveRemoteUrl=saveRemoteUrl;
window.clearRemoteUrl=clearRemoteUrl;
window.copyRemoteUrl=copyRemoteUrl;

function companyHeaderHtml(extra='',fiscalNo=''){
  const u=state.user||{};
  const title=u.company_legal||u.name||'Savdo';
  return `<h1>${esc(title)}</h1>
    ${u.company_inn?`<div class="m">${t('company_inn')}: ${esc(u.company_inn)}</div>`:''}
    ${u.company_address?`<div class="m">${esc(u.company_address)}</div>`:''}
    ${u.company_phone?`<div class="m">${esc(u.company_phone)}</div>`:''}
    ${u.cashier_name?`<div class="m">${t('cashier')}: ${esc(u.cashier_name)}</div>`:''}
    ${extra}
    ${u.fiscal_enabled?`<div class="m" style="margin-top:8px;border-top:1px dashed #ccc;padding-top:6px">
      <b>FISCAL</b>
      ${fiscalNo?`<div>${t('fiscal_no')}: ${esc(fiscalNo)}</div>`:''}
      ${u.fiscal_reg?`<div>${t('fiscal_reg')}: ${esc(u.fiscal_reg)}</div>`:''}
      ${u.fiscal_serial?`<div>${t('fiscal_serial')}: ${esc(u.fiscal_serial)}</div>`:''}
    </div>`:''}`;
}

function auditPage(){
  const rows=state.audit||[];
  return `<div class="panel"><div class="panel-b">
    <h2 style="margin:0 0 8px;font-family:var(--display)">${t('audit_log')}</h2>
    <p style="margin:0 0 16px;color:var(--muted);font-size:14px">${t('company')}</p>
    ${rows.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('date')}</th><th>${t('cashier')}</th><th>${t('type')}</th><th>${t('what')}</th></tr></thead>
      <tbody>${rows.map(a=>{
        const when=a.created_at?new Date(a.created_at).toLocaleString():'';
        return `<tr>
          <td>${esc(when)}</td>
          <td>${esc(a.actor_name||'—')}</td>
          <td><span class="pill gray">${esc(a.action||'')}</span></td>
          <td>${esc(a.detail||'')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('audit_empty')}</h3></div>`}
  </div></div>`;
}

function cartLines(){
  return Object.entries(cart).map(([id,qty])=>{
    const p=state.products.find(x=>x.id===Number(id));
    return p&&qty>0?{p,qty}:null;
  }).filter(Boolean);
}
function cartCustomer(){
  if(!cartCustomerId)return null;
  return (state.customers||[]).find(c=>String(c.id)===String(cartCustomerId))||null;
}
function cartTotals(){
  const lines=cartLines();
  const count=lines.reduce((a,l)=>a+l.qty,0);
  const sum=lines.reduce((a,l)=>a+l.qty*sellP(l.p),0);
  let discount=0;
  if(cartDiscount.percent>0)discount=Math.round(sum*Math.min(100,cartDiscount.percent)/100);
  if(cartDiscount.amount>0)discount=Math.round(cartDiscount.amount*100);
  discount=Math.max(0,Math.min(sum,discount));
  const cust=cartCustomer();
  const have=Number(cust?.points)||0;
  const maxRedeem=Math.min(have,Math.floor(Math.max(0,sum-discount)/100));
  const redeem=Math.max(0,Math.min(maxRedeem,Math.floor(Number(cartRedeemPoints)||0)));
  cartRedeemPoints=redeem;
  const pointsDisc=redeem*100;
  const payable=Math.max(0,sum-discount-pointsDisc);
  const vatPct=Number(state?.user?.vat_percent)||0;
  const vat=vatPct>0?Math.round(payable*vatPct/(100+vatPct)):0;
  return{lines,count,sum,discount,pointsDisc,redeem,have,maxRedeem,payable,vat,vatPct,kinds:lines.length};
}
function shiftBarHtml(){
  const sh=state.shift;
  const st=state.shift_stats;
  if(!sh){
    return `<div class="shift-bar">
      <div><b>${t('shift_closed')}</b><span>${t('shift_hint')}</span></div>
      <button class="gold" style="padding:8px 12px;font-size:12px" onclick="openShiftDialog()">${t('shift_open_btn')}</button>
    </div>`;
  }
  const who=sh.cashier_name?` · ${esc(sh.cashier_name)}`:'';
  return `<div class="shift-bar on">
    <div>
      <b>${t('shift')} #${sh.id}${who}</b>
      <span>${t('shift_expected')}: ${cash(st?.expected_cash||0)} · ${t('checks')}: ${st?.checks||0}</span>
    </div>
    <div class="acts">
      <button class="outline" style="padding:8px 12px;font-size:12px" onclick="openCashMove('in')">${t('shift_cash_in')}</button>
      <button class="outline" style="padding:8px 12px;font-size:12px" onclick="openCashMove('out')">${t('shift_cash_out')}</button>
      <button class="primary" style="padding:8px 12px;font-size:12px" onclick="closeShiftDialog()">${t('shift_close_btn')}</button>
    </div>
  </div>`;
}
function openShiftDialog(){
  const list=state.cashiers||[];
  const me=list.find(c=>c.id===state.user?.id)||list[0];
  const opts=list.length
    ? `<label class="wide">${t('shift_cashier')}<select name="cashier_id" required>
        ${list.map(c=>`<option value="${c.id}" ${me&&c.id===me.id?'selected':''}>${esc(c.name)}${c.has_pin?'':' · '+t('pin_not_set_short')}</option>`).join('')}
      </select></label>`
    : `<input type="hidden" name="cashier_id" value="">`;
  showModal(t('shift_open_btn'),
    opts
    +field(t('shift_pin'),'pin','password','',true,'required inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" autocomplete="one-time-code"')
    +field(t('shift_open_cash'),'open_cash','number','0',true,'required min="0" step="0.01"')
    +`<p class="wide" style="margin:0;color:var(--muted);font-size:13px">${t('shift_pin_hint')}</p>`,
    async b=>{await api('shift/open',b);toast(t('shift_opened'));}
  );
}
function openCashMove(kind){
  showModal(kind==='out'?t('shift_cash_out'):t('shift_cash_in'),
    field(t('amount'),'amount','number','',true)
    +field(t('note'),'note','text','',true,'maxlength="200"'),
    async b=>{await api('shift/cash',{...b,kind});}
  );
}
async function closeShiftDialog(){
  const st=state.shift_stats||{};
  showModal(t('z_report'),
    `<div class="wide hint" style="margin-top:0">
      ${t('cash_sales')}: <b>${cash(st.cash_sales||0)}</b><br>
      ${t('card_sales')}: <b>${cash(st.card_sales||0)}</b><br>
      ${t('transfer_sales')}: <b>${cash(st.transfer_sales||0)}</b><br>
      ${t('debt_sales')}: <b>${cash(st.debt_sales||0)}</b><br>
      ${t('kind_return')}: <b>${cash(st.returns||0)}</b><br>
      ${t('expenses')}: <b>${cash(st.expenses||0)}</b><br>
      ${t('shift_cash_in')}: <b>${cash(st.cash_in||0)}</b><br>
      ${t('shift_cash_out')}: <b>${cash(st.cash_out||0)}</b><br>
      ${t('shift_expected')}: <b>${cash(st.expected_cash||0)}</b>
    </div>`
    +field(t('shift_close_cash'),'close_cash','number',((st.expected_cash||0)/100).toFixed(2),true,'required min="0" step="0.01"')
    +field(t('note'),'note','text','',true,'maxlength="200"'),
    async b=>{
      const r=await api('shift/close',b);
      const diff=r.stats?.diff||0;
      toast(`${t('shift_closed_ok')} · ${t('shift_diff')}: ${cash(diff)}`);
      return r;
    }
  );
}
function openDiscount(){
  const {sum}=cartTotals();
  showModal(t('discount'),
    field(t('discount_pct'),'percent','number',String(cartDiscount.percent||0),false,'min="0" max="100" step="1"')
    +field(t('discount_sum'),'amount','number',String(cartDiscount.amount||0),false,'min="0" step="0.01"')
    +`<p class="wide" style="margin:0;color:var(--muted);font-size:13px">${t('cart_total')}: ${cash(sum)}</p>`,
    async b=>{
      cartDiscount={percent:Number(b.percent)||0,amount:Number(b.amount)||0};
      if(cartDiscount.amount>0)cartDiscount.percent=0;
      return {ok:true};
    }
  );
}
function clearDiscount(){cartDiscount={percent:0,amount:0};render()}
function openWriteoff(productId){
  openMove('writeoff',productId);
}
function openInventory(){
  inventDraft={};
  for(const p of state.products)inventDraft[p.id]=p.stock;
  window.inventDraft=inventDraft;
  showModal(t('inventory'),
    `<p class="wide" style="margin:0 0 10px;color:var(--muted);font-size:13px">${t('inventory_hint')}</p>
     <div class="wide invent-list">${state.products.map(p=>`
       <div class="invent-row">
         <div><b>${esc(p.name)}</b><div class="meta">${t('in_system')}: ${p.stock}</div></div>
         <label>${t('counted')}<input type="number" min="0" step="1" value="${p.stock}"
           oninput="window.inventDraft[${p.id}]=Number(this.value)||0"></label>
       </div>`).join('')}</div>`,
    async()=>{
      const draft=window.inventDraft||inventDraft;
      const items=state.products.map(p=>({product:p.id,counted:draft[p.id]??p.stock}));
      const r=await api('inventory',{items,date:state.today});
      toast(t('inventory_done',{n:r.changed||0}));
      return r;
    }
  );
}
window.openShiftDialog=openShiftDialog;
window.editCartPrice=editCartPrice;
window.openCashMove=openCashMove;
window.closeShiftDialog=closeShiftDialog;
window.openDiscount=openDiscount;
window.clearDiscount=clearDiscount;
window.openInventory=openInventory;
window.openWriteoff=openWriteoff;
window.printCartDraft=printCartDraft;
window.printPriceTags=printPriceTags;
window.printReportPdf=printReportPdf;
window.openRecon=openRecon;
window.openTransfer=openTransfer;
window.openStaff=openStaff;
window.deleteStaff=deleteStaff;
window.sendTelegramBackup=sendTelegramBackup;
window.startCamScan=startCamScan;
window.startVoiceSearch=startVoiceSearch;
window.openQuickBuy=openQuickBuy;
window.setRedeemPoints=setRedeemPoints;
window.useMaxPoints=useMaxPoints;
window.openPartialReturn=openPartialReturn;
window.openLastPartialReturn=openLastPartialReturn;
window.onCartCustomerQuery=onCartCustomerQuery;
window.pickCustomerFromQuery=pickCustomerFromQuery;
window.switchShop=switchShop;
window.openBranch=openBranch;
window.deleteBranch=deleteBranch;
window.printThermalIfEnabled=printThermalIfEnabled;
window.printThermalDraft=printThermalDraft;
function addToCart(id){
  const p=state.products.find(x=>x.id===id);
  const avail=whStock(p);
  if(!p||avail<=0){toast(t('no_stock'));return}
  const cur=cart[id]||0;
  if(cur+1>avail){toast(t('over_stock'));return}
  cart[id]=cur+1;
  render();
}
function cartSet(id,qty){
  const p=state.products.find(x=>x.id===Number(id));
  if(!p)return;
  qty=Math.max(0,Math.min(whStock(p),Number(qty)||0));
  if(qty<=0){delete cart[id];delete cartPrices[id]}else cart[id]=qty;
  render();
}
function cartClear(){cart={};cartPrices={};render()}
function editCartPrice(id){
  const p=state.products.find(x=>x.id===Number(id));
  if(!p)return;
  const cur=(sellP(p)/100).toFixed(2);
  showModal(t('edit_sale_price'),
    `<p class="wide" style="margin:0 0 8px;color:var(--muted);font-size:13px">${esc(p.name)} · ${t('catalog_price')}: ${cash(p.price)}</p>`
    +field(t('sell_price'),'price','number',cur,true,'required min="0" step="0.01"')
    +`<p class="wide" style="margin:0;color:var(--muted);font-size:13px">${t('sale_price_hint')}</p>`,
    async b=>{
      const v=Number(b.price);
      if(!(v>=0))throw Error(t('err'));
      cartPrices[p.id]=Math.round(v*100);
      return{ok:true};
    }
  );
}
function checkoutPayload(lines,pay,extra={}){
  const body={
    pay,
    date:state.today,
    warehouse:cartWarehouse,
    wholesale:cartWholesale?1:0,
    send_telegram:sendTgReceipt?1:0,
    items:lines.map(l=>{
      const row={product:l.p.id,qty:l.qty};
      if(cartPrices[l.p.id]!=null)row.price=cartPrices[l.p.id]/100;
      return row;
    }),
    ...extra
  };
  if(cartCustomerId)body.customer=cartCustomerId;
  if(cartRedeemPoints>0)body.redeem_points=cartRedeemPoints;
  if(cartDiscount.percent>0)body.discount_percent=cartDiscount.percent;
  else if(cartDiscount.amount>0)body.discount_amount=cartDiscount.amount;
  return body;
}
async function afterCheckout(res){
  cart={};cartPrices={};cartDiscount={percent:0,amount:0};cartCustomerId='';cartRedeemPoints=0;
  const bits=[res.doc_no&&(t('paid_saved')+' · '+res.doc_no)];
  if(res.points_spent)bits.push('⭐ −'+res.points_spent);
  if(res.points)bits.push('⭐ +'+res.points);
  if(bits.length)toast(bits.filter(Boolean).join(' · '));
  res._cartPrint=true;
  return res;
}
function setRedeemPoints(n){
  cartRedeemPoints=Math.max(0,Math.floor(Number(n)||0));
  render();
}
function useMaxPoints(){
  const {maxRedeem}=cartTotals();
  cartRedeemPoints=maxRedeem;
  render();
}
async function checkoutCart(pay='cash'){
  const {lines,count,payable}=cartTotals();
  if(!lines.length){toast(t('cart_empty'));return}
  if(pay==='cash'){
    showModal(t('choose_pay'),
      `<p class="wide" style="margin:0 0 12px;color:var(--muted);font-size:13px">${count} ${t('pcs')} · ${cash(payable)} · ${esc(whName(cartWarehouse))}</p>
       <div class="wide paymodes">
         <label><input type="radio" name="pay_method" value="cash" checked> ${t('pay_cash_short')}</label>
         <label><input type="radio" name="pay_method" value="card"> ${t('pay_card')}</label>
         <label><input type="radio" name="pay_method" value="transfer"> ${t('pay_transfer')}</label>
       </div>`,
      async b=>afterCheckout(await api('cart/checkout',checkoutPayload(lines,'cash',{pay_method:b.pay_method||'cash'})))
    );
    return;
  }
  const list=state.customers||[];
  if(!list.length){toast(t('add_customer_first'));go('customers');return}
  showModal(t('debt_title',{sum:cash(payable)}),
    `<p class="wide" style="margin:0 0 12px;color:var(--muted);font-size:13px">${count} ${t('pcs')} · ${kindsLabel(lines)}</p>
     ${customerSelect(cartCustomerId||'')}`,
    async b=>{
      let cid=b.customer||'';
      if(!cid&&b.customer_q){
        const q=String(b.customer_q).trim().toLowerCase();
        const digits=q.replace(/\D/g,'');
        const c=list.find(x=>{
          const label=(x.name+(x.phone?' · '+x.phone:'')).toLowerCase();
          const phone=String(x.phone||'').replace(/\D/g,'');
          return label===q||label.includes(q)||(digits&&phone.includes(digits));
        });
        cid=c?.id||'';
      }
      if(!cid)throw Error(t('debt_customer'));
      return afterCheckout(await api('cart/checkout',checkoutPayload(lines,'debt',{customer:cid})));
    }
  );
  const qel=document.querySelector('[name=customer_q]');
  if(qel){
    const sync=()=>pickCustomerFromQuery(qel,'customer');
    qel.addEventListener('input',sync);
    qel.addEventListener('change',sync);
  }
}
function findByBarcode(code){
  const q=String(code||'').trim().toLowerCase();
  if(!q)return null;
  return state.products.find(p=>(p.barcode||'').toLowerCase()===q)
    || state.products.find(p=>(p.barcode||'').toLowerCase().includes(q));
}
function onBarcodeEnter(el){
  const p=findByBarcode(el.value);
  if(!p){toast(t('product_missing'));return}
  el.value='';
  addToCart(p.id);
}
function kindsLabel(lines){return t('kinds_of',{n:lines.length})}
async function voidLastCart(){
  if(!confirm(t('void_confirm')))return;
  const needPin=!!state.user.has_void_pin;
  if(needPin){
    showModal(t('void_pin'),
      field(t('pin'),'pin','password','',true,'required inputmode="numeric" minlength="4" maxlength="8"'),
      async b=>{
        const r=await api('cart/void-last',{pin:b.pin});
        toast(t('voided',{n:r.voided}));
        return r;
      }
    );
    return;
  }
  try{
    const r=await api('cart/void-last',{});
    await load();
    toast(t('voided',{n:r.voided}));
  }catch(err){toast(err.message)}
}

function kassaPage(s){
  if(!state.products.length){
    return `<div class="panel"><div class="empty">
      <h3>${t('add_products_first')}</h3>
      <p>${t('add_products_hint')}</p>
      <button class="primary" onclick="openProduct()">${t('add_product')}</button>
    </div></div>`;
  }
  const q=search.trim().toLowerCase();
  const categories=[...new Set(state.products.map(p=>p.category).filter(Boolean))];
  const products=state.products.filter(p=>{
    const okCat=cat==='all'||p.category===cat;
    const okQ=!q||p.name.toLowerCase().includes(q)||p.category.toLowerCase().includes(q)||(p.barcode||'').toLowerCase().includes(q);
    return okCat&&okQ;
  });
  const {lines,count,sum,discount,pointsDisc,redeem,have,maxRedeem,payable,vat,vatPct,kinds}=cartTotals();
  return `
  ${shiftBarHtml()}
  <div class="stats">
    <div class="stat dark"><span>${t('sales_today')}</span><strong>${cash(s.rev)}</strong></div>
    <div class="stat"><span>${t('profit')}</span><strong>${cash(s.profit)}</strong></div>
    <div class="stat"><span>${t('debts')}</span><strong>${cash(s.debt)}</strong></div>
  </div>
  <div class="quick">
    <section class="panel sell-box">
      <h2>${t('tap_product')}</h2>
      <div class="hint">${t('cart_hint')}</div>
      <div class="toolbar" style="padding:0 0 10px">
        <input id="kassaSearch" placeholder="${t('search')}" value="${esc(search)}" oninput="search=this.value;render()">
        <input placeholder="${t('barcode_ph')}" inputmode="numeric" onkeydown="if(event.key==='Enter'){event.preventDefault();onBarcodeEnter(this)}">
        <button class="outline" type="button" onclick="startCamScan()" title="${t('scan_cam')}">📷</button>
        <button class="outline" type="button" onclick="startVoiceSearch()" title="${t('voice_search')}">🎙</button>
      </div>
      <div class="cats">
        <button class="${cat==='all'?'active':''}" onclick="cat='all';render()">${t('all')}</button>
        ${categories.map(c=>`<button class="${cat===c?'active':''}" onclick="cat=decodeURIComponent('${encodeURIComponent(c)}');render()">${esc(c)}</button>`).join('')}
      </div>
      <div class="product-grid">
        ${products.map(p=>{
          const inCart=cart[p.id]||0;
          const avail=whStock(p);
          const low=isLow(p);
          const ex=expiryStatus(p);
          const price=sellP(p);
          const promo=Number(p.promo_price)>0;
          return `<button class="pbtn ${avail<=0?'out':''} ${low?'low':''}" onclick="addToCart(${p.id})" ${avail<=0?'disabled':''}>
            ${productPhoto(p)}
            <b>${esc(p.name)}</b>
            <small>${esc(p.category)} · ${avail} ${unitLabel(p.unit)}${inCart?' · '+t('in_cart',{n:inCart}):''}${low?' · '+t('low_tag'):''}${ex==='expired'?' · '+t('expired'):ex==='soon'?' · '+t('expiry_soon'):''}</small>
            <div class="price">${cash(price)}${promo?` <span style="text-decoration:line-through;opacity:.55;font-size:12px">${cash(p.price)}</span>`:''}</div>
          </button>`;
        }).join('')||`<div class="empty"><p>${t('empty_cat')}</p></div>`}
      </div>
    </section>
    <section class="cart-box">
      <div class="cart-total">
        <div class="lbl">${t('cart_total')}</div>
        <div class="sum">${cash(payable)}</div>
        <div class="meta">${t('kinds_pcs',{kinds,count})}${discount?` · ${t('discount')} −${cash(discount)}`:''}${pointsDisc?` · ⭐ −${cash(pointsDisc)}`:''}${vatPct?` · ${t('vat_amount')} ${cash(vat)}`:''}</div>
      </div>
      <div class="acts" style="margin-bottom:8px">
        <select onchange="cartWarehouse=Number(this.value)||1;render()" style="flex:1">
          <option value="1" ${cartWarehouse===1?'selected':''}>${esc(whName(1))}</option>
          <option value="2" ${cartWarehouse===2?'selected':''}>${esc(whName(2))}</option>
        </select>
        <button class="outline ${cartWholesale?'active':''}" onclick="cartWholesale=!cartWholesale;render()">${cartWholesale?t('wholesale'):t('retail')}</button>
        ${can('discount')?`<button class="outline" onclick="openDiscount()" ${!count?'disabled':''}>${t('discount')}</button>`:''}
        ${discount?`<button class="outline" onclick="clearDiscount()">${t('discount_clear')}</button>`:''}
      </div>
      ${customerPickerHtml()}
      ${cartCustomerId?`<div class="acts" style="margin-bottom:8px;align-items:end">
        <label style="flex:1;margin:0;font-size:12px">${t('redeem_points')}
          <input type="number" min="0" max="${maxRedeem}" step="1" value="${redeem}" onchange="setRedeemPoints(this.value)" oninput="cartRedeemPoints=Number(this.value)||0">
        </label>
        <button type="button" class="outline" style="padding:8px 10px;font-size:12px" onclick="useMaxPoints()" ${maxRedeem<=0?'disabled':''}>${t('use_max_points')}</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin:0 0 10px">${t('points_available',{n:have})} · ${t('redeem_hint',{cur:state.user.currency})}${redeem?` · ${t('points_spent',{n:redeem})}`:''}</div>`:''}
      <label style="display:flex;gap:8px;align-items:center;margin:0 0 10px;font-size:13px;color:var(--muted)">
        <input type="checkbox" ${sendTgReceipt?'checked':''} onchange="sendTgReceipt=this.checked" style="width:auto"> ${t('send_tg_receipt')}
      </label>
      <button class="cart-pay gold" onclick="checkoutCart('cash')" ${!count?'disabled':''}>${t('pay_cash')}</button>
      <button class="cart-pay primary" onclick="checkoutCart('debt')" ${!count?'disabled':''} style="font-size:15px;padding:14px">${t('pay_debt')}</button>
      <div class="panel">
        <div class="panel-h">
          <div><h2>${t('cart')}</h2><p>${count?count+' '+t('pcs'):t('empty')}</p></div>
          ${count?`<button class="outline" style="padding:7px 10px;font-size:12px" onclick="cartClear();clearDiscount()">${t('clear')}</button>`:''}
        </div>
        <div class="panel-b cart-lines">
          ${lines.length?lines.map(({p,qty})=>{
            const price=sellP(p);
            const custom=cartPrices[p.id]!=null;
            return `<div class="cart-line">
            <div><b>${esc(p.name)}</b>
              <div class="meta">${cash(price)} × ${qty} ${unitLabel(p.unit)} = ${cash(price*qty)}${custom?' · '+t('price_changed'):''}</div>
              <button type="button" class="outline" style="margin-top:6px;padding:6px 10px;font-size:12px" onclick="editCartPrice(${p.id})">${t('edit_sale_price')}</button>
            </div>
            <div class="qtybox">
              <button type="button" onclick="cartSet(${p.id},${qty-1})">−</button>
              <span>${qty}</span>
              <button type="button" onclick="cartSet(${p.id},${qty+1})">＋</button>
            </div>
          </div>`;
          }).join(''):`<div class="empty"><p>${t('tap_left')}</p></div>`}
        </div>
      </div>
      <button class="outline" onclick="printCartDraft()">${t('cart_receipt')}</button>
      ${state.user.printer_enabled?`<button class="outline" onclick="printThermalDraft()">${t('print_thermal')}</button>`:''}
      <button class="outline" onclick="openLastPartialReturn()">${t('partial_return')}</button>
      ${can('void')?`<button class="outline" onclick="voidLastCart()">${t('void_last')}</button>`:''}
      <button class="outline" onclick="openMove('receipt')">${t('plus_receipt')}</button>
      <button class="outline" onclick="openMove('expense')">${t('plus_expense')}</button>
      <button class="outline" onclick="openMove('writeoff')">${t('plus_writeoff')}</button>
    </section>
  </div>`;
}

function stockPage(){
  const list=state.products.filter(p=>p.name.toLowerCase().includes(search.toLowerCase()));
  const value=state.products.reduce((a,p)=>a+(p.stock+(Number(p.stock2)||0))*p.cost,0);
  return `<div class="panel">
    <div class="panel-h">
      <div><h2>${t('products_stock')}</h2><p>${t('kinds_value',{n:state.products.length,v:cash(value)})}</p></div>
      <div class="acts">
        <button class="outline" onclick="printPriceTags()">${t('price_tags')}</button>
        <button class="outline" onclick="openQuickBuy()">${t('quick_buy')}</button>
        <button class="outline" onclick="openTransfer()">${t('transfer')}</button>
        <button class="outline" onclick="openInventory()">${t('inventory')}</button>
        <button class="outline" onclick="openMove('writeoff')">${t('writeoff')}</button>
        <button class="primary" onclick="openProduct()">${t('plus_add')}</button>
      </div>
    </div>
    <div class="toolbar">
      <input placeholder="${t('search')}" value="${esc(search)}" oninput="search=this.value;render()">
      <button class="outline" onclick="exportCSV('products')">Excel</button>
      ${can('import')?`<label class="outline" style="display:inline-flex;align-items:center;cursor:pointer;margin:0" title="${t('import_hint')}">${t('import_csv')}<input id="importCsvFile" type="file" accept=".csv,text/csv" hidden></label>`:''}
    </div>
    ${list.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('product')}</th><th>${t('price')}</th><th>${esc(whName(1))}</th><th>${esc(whName(2))}</th><th>${t('status')}</th><th></th></tr></thead>
      <tbody>${list.map(p=>{
        const total=p.stock+(Number(p.stock2)||0);
        const ex=expiryStatus(p);
        const price=sellP(p);
        return `<tr class="${isLow(p)||isOut(p)||ex==='expired'?'low-row':''}">
        <td><div style="display:flex;gap:10px;align-items:center">${productPhoto(p,'thumb')}<div><b>${esc(p.name)}</b><div style="color:var(--muted);font-size:12px">${esc(p.category)} · ${unitLabel(p.unit)} · ${t('buy_cost',{v:cash(p.cost)})}${p.expiry?' · '+t('expiry')+' '+esc(p.expiry):''}${ex==='soon'?' · '+t('expiry_soon'):ex==='expired'?' · '+t('expired'):''}</div></div></div></td>
        <td>${cash(price)}${Number(p.promo_price)>0?`<div style="font-size:11px;color:var(--muted);text-decoration:line-through">${cash(p.price)}</div>`:''}</td>
        <td><b>${p.stock}</b></td>
        <td><b>${Number(p.stock2)||0}</b></td>
        <td><span class="pill ${total===0?'gray':isLow(p)||ex?'warn':''}">${total===0?t('status_out'):isLow(p)?'≤'+lowLimit():ex==='expired'?t('expired'):t('status_ok')}</span></td>
        <td class="acts">
          <button class="gold" onclick="quickSale(${p.id})" ${whStock(p)<=0?'disabled':''}>${t('sell')}</button>
          <button class="outline" onclick="openProductById(${p.id})">${t('edit')}</button>
          <button class="danger" onclick="archiveProduct(${p.id})">${t('hide')}</button>
        </td>
      </tr>`;
      }).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('empty_title')}</h3><p>${t('add_products')}</p><button class="primary" onclick="openProduct()">${t('plus_add')}</button></div>`}
  </div>`;
}

function customersPage(s){
  const list=(state.customers||[]).filter(c=>c.name.toLowerCase().includes(search.toLowerCase())||(c.phone||'').includes(search));
  const pays=(state.payments||[]).slice(0,10);
  return `
  <div class="stats">
    <div class="stat dark"><span>${t('total_debt')}</span><strong>${cash(s.debt)}</strong></div>
    <div class="stat"><span>${t('customers')}</span><strong>${(state.customers||[]).length}</strong></div>
    <div class="stat"><span>${t('debtor_count')}</span><strong>${(state.customers||[]).filter(c=>c.debt>0).length}</strong></div>
  </div>
  <div class="panel">
    <div class="panel-h">
      <div><h2>${t('list')}</h2><p>${t('debt_pay_here')}</p></div>
      <div class="acts">
        <button class="outline" onclick="openPayment()">${t('payment')}</button>
        <button class="outline" onclick="openOpeningDebt()">${t('opening_debt')}</button>
        <button class="primary" onclick="openCustomer()">${t('plus_customer')}</button>
      </div>
    </div>
    <div class="toolbar"><input placeholder="${t('name_phone')}" value="${esc(search)}" oninput="search=this.value;render()"></div>
    ${list.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('customer')}</th><th>${t('phone')}</th><th>${t('points')}</th><th>${t('debt')}</th><th></th></tr></thead>
      <tbody>${list.map(c=>`<tr>
        <td><b>${esc(c.name)}</b>${c.note?`<div style="color:var(--muted);font-size:12px">${esc(c.note)}</div>`:''}</td>
        <td>${esc(c.phone||'—')}</td>
        <td>${Number(c.points)||0}</td>
        <td>${c.debt?`<span class="pill debt">${cash(c.debt)}</span>`:`<span class="pill">${t('no_debt')}</span>`}</td>
        <td class="acts">
          <button class="outline" onclick="openOpeningDebt(${c.id})">${t('opening_debt')}</button>
          ${c.debt?`<button class="gold" onclick="openPayment(${c.id})">${t('payment')}</button>`:''}
          <button class="outline" onclick='openCustomer(${JSON.stringify({id:c.id,name:c.name,phone:c.phone,note:c.note})})'>${t('edit')}</button>
          <button class="danger" onclick="archiveCustomer(${c.id})">${t('hide')}</button>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('no_customers')}</h3><p>${t('debt_need_customer')}</p><button class="primary" onclick="openCustomer()">${t('plus_add')}</button></div>`}
  </div>
  ${pays.length?`<div class="panel" style="margin-top:12px"><div class="panel-h"><h2>${t('recent_payments')}</h2></div>
    <div class="tablewrap"><table><thead><tr><th>${t('customer')}</th><th>${t('date')}</th><th>${t('amount')}</th></tr></thead>
    <tbody>${pays.map(p=>`<tr><td>${esc(p.customer_name)}</td><td>${p.date}</td><td>${cash(p.amount)}</td></tr>`).join('')}</tbody></table></div></div>`:''}
  ${openingDebtPanel('customer')}`;
}

function rankList(items,valueFn,valueFmt,cls=''){
  if(!items.length)return `<div class="empty"><p>${t('no_data')}</p></div>`;
  return `<div class="rank-list">${items.slice(0,8).map((p,i)=>`
    <div class="rank-item ${cls}">
      <div style="display:flex;gap:10px;align-items:center;min-width:0">
        <span class="n">${i+1}</span>
        <div style="min-width:0"><b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</b>
        <div class="meta" style="color:var(--muted);font-size:12px">${t('stock')}: ${p.stock}</div></div>
      </div>
      <b>${valueFmt(valueFn(p))}</b>
    </div>`).join('')}</div>`;
}

function analyzePage(s){
  const ranks=productRanks(s);
  const bySold=[...ranks].sort((a,b)=>b.sold-a.sold||b.revenue-a.revenue);
  const byRev=[...ranks].sort((a,b)=>b.revenue-a.revenue||b.sold-a.sold);
  const byProfit=[...ranks].sort((a,b)=>b.profit-a.profit||b.revenue-a.revenue);
  const lowSold=[...ranks].sort((a,b)=>a.sold-b.sold||a.revenue-b.revenue);
  const lowRev=[...ranks].sort((a,b)=>a.revenue-b.revenue||a.sold-b.sold);
  const low=state.products.filter(p=>isLow(p)||isOut(p)).sort((a,b)=>a.stock-b.stock);
  const dayMap={};
  for(const m of s.sales){dayMap[m.date]=(dayMap[m.date]||0)+m.qty*m.price}
  for(const m of s.returns){dayMap[m.date]=(dayMap[m.date]||0)-m.qty*m.price}
  const days=Object.keys(dayMap).sort().slice(-14);
  const maxDay=Math.max(1,...days.map(d=>dayMap[d]));

  return `
  <div class="toolbar" style="padding:0 0 12px">
    <select onchange="period=this.value;render()">
      ${[['today',t('today')],['week',t('week')],['month',t('month')],['all',t('all')]].map(([v,n])=>`<option value="${v}" ${period===v?'selected':''}>${n}</option>`).join('')}
    </select>
    <span style="color:var(--muted);font-size:13px">${t('analyze_hint')}</span>
  </div>
  <div class="stats">
    <div class="stat dark"><span>${t('sales_period')}</span><strong>${cash(s.rev)}</strong></div>
    <div class="stat"><span>${t('profit')}</span><strong>${cash(s.profit)}</strong></div>
    <div class="stat"><span>${t('low_stock')}</span><strong style="color:${low.length?'var(--danger)':''}">${low.length}</strong></div>
  </div>
  <section class="panel" style="margin-bottom:12px">
    <div class="panel-h"><div><h2>${t('chart_sales')}</h2><p>${days.length?days[0]+' — '+days[days.length-1]:t('no_data')}</p></div></div>
    <div class="bars">${days.length?days.map(d=>`<div class="bar-col" title="${d}: ${cash(dayMap[d])}"><div class="bar" style="height:${Math.max(4,Math.round(80*dayMap[d]/maxDay))}px"></div><span>${d.slice(5)}</span></div>`).join(''):`<div class="empty"><p>${t('no_data')}</p></div>`}</div>
  </section>
  <div class="analyze-grid">
    <section class="panel rank-card top">
      <div class="panel-h"><div><h2>${t('top_sold')}</h2><p>${t('by_qty')}</p></div></div>
      ${rankList(bySold,p=>p.sold,v=>v+' '+t('pcs'))}
    </section>
    <section class="panel rank-card hot">
      <div class="panel-h"><div><h2>${t('profit_by_product')}</h2><p>${t('profit')}</p></div></div>
      ${rankList(byProfit,p=>p.profit,v=>cash(v))}
    </section>
    <section class="panel rank-card hot">
      <div class="panel-h"><div><h2>${t('top_rev')}</h2><p>${t('by_rev')}</p></div></div>
      ${rankList(byRev,p=>p.revenue,v=>cash(v))}
    </section>
    <section class="panel rank-card cold">
      <div class="panel-h"><div><h2>${t('low_sold')}</h2><p>${t('least_pcs')}</p></div></div>
      ${rankList(lowSold,p=>p.sold,v=>v+' '+t('pcs'),'cold')}
    </section>
    <section class="panel rank-card bad">
      <div class="panel-h"><div><h2>${t('low_rev')}</h2><p>${t('least_money')}</p></div></div>
      ${rankList(lowRev,p=>p.revenue,v=>cash(v),'bad')}
    </section>
  </div>
  <section class="panel">
    <div class="panel-h"><div><h2>${t('red_stock')}</h2><p>${t('threshold_you',{n:lowLimit()})}</p></div>
      <button class="outline" onclick="go('settings')">${t('change_threshold')}</button>
    </div>
    ${low.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('product')}</th><th>${t('stock')}</th><th>${t('status')}</th></tr></thead>
      <tbody>${low.map(p=>`<tr class="low-row"><td><b>${esc(p.name)}</b></td><td><b style="color:var(--danger)">${p.stock}</b></td>
        <td><span class="pill ${p.stock===0?'gray':'warn'}">${p.stock===0?t('status_out'):t('low_tag')}</span></td></tr>`).join('')}
      </tbody></table></div>`:`<div class="empty"><p>${t('no_red')}</p></div>`}
  </section>`;
}

function reportsPage(s){
  const kinds={
    all:s.m,
    sale:s.m.filter(m=>(m.kind==='sale'||m.kind==='return')&&!isOpeningDebt(m)),
    receipt:s.m.filter(m=>m.kind==='receipt'&&!isOpeningDebt(m)),
    expense:s.m.filter(m=>m.kind==='expense'),
    writeoff:s.m.filter(m=>m.kind==='writeoff'),
    adjust:s.m.filter(m=>m.kind==='adjust')
  };
  const rows=kinds[tab]||s.m;

  return `
  <div class="toolbar" style="padding:0 0 12px">
    <select onchange="period=this.value;render()">
      ${[['today',t('today')],['week',t('week')],['month',t('month')],['all',t('all')]].map(([v,n])=>`<option value="${v}" ${period===v?'selected':''}>${n}</option>`).join('')}
    </select>
    <button class="outline" onclick="exportCSV('report')">Excel</button>
    <button class="outline" onclick="printReportPdf()">${t('print_report')}</button>
    <button class="outline" onclick="openRecon()">${t('recon')}</button>
    <button class="primary" onclick="go('analyze')">${t('analyze_products')}</button>
  </div>
  <div class="stats">
    <div class="stat dark"><span>${t('sales')}</span><strong>${cash(s.rev)}</strong></div>
    <div class="stat"><span>${t('profit')}</span><strong>${cash(s.profit)}</strong></div>
    <div class="stat"><span>${t('after_expense')}</span><strong>${cash(s.profit-s.expense)}</strong></div>
  </div>
  <div class="stats">
    <div class="stat"><span>${t('pay_cash_short')}</span><strong>${cash((state.pay_totals||{}).cash||0)}</strong></div>
    <div class="stat"><span>${t('pay_card')}</span><strong>${cash((state.pay_totals||{}).card||0)}</strong></div>
    <div class="stat"><span>${t('pay_transfer')}</span><strong>${cash((state.pay_totals||{}).transfer||0)}</strong></div>
  </div>
  <div class="panel" style="margin-bottom:12px">
    <div class="panel-h"><div><h2>${t('summary')}</h2><p>${t('all_numbers')}</p></div></div>
    <div class="tablewrap"><table><tbody>
      <tr><td>${t('sales')}</td><td><b>${cash(s.rev)}</b></td></tr>
      <tr><td>${t('cogs')}</td><td>${cash(s.cost)}</td></tr>
      <tr><td>${t('profit')}</td><td>${cash(s.profit)}</td></tr>
      <tr><td>${t('expenses')}</td><td>${cash(s.expense)}</td></tr>
      <tr><td>${t('customer_debts')}</td><td>${cash(s.debt)}</td></tr>
      <tr><td>${t('supplier_debt')}</td><td>${cash(state.supplier_debt_total||0)}</td></tr>
      ${(Number(state.user.vat_percent)>0)?`<tr><td>${t('vat_amount')} ${state.user.vat_percent}%</td><td>${cash(Math.round(s.rev*state.user.vat_percent/(100+Number(state.user.vat_percent))))}</td></tr>`:''}
      <tr><td>${t('sold')}</td><td>${t('sold_pcs',{n:s.qty})}</td></tr>
    </tbody></table></div>
  </div>
  <div class="panel">
    <div class="tabs">
      ${[['all',t('all')],['sale',t('kind_sale')],['receipt',t('kind_receipt')],['expense',t('expenses')],['writeoff',t('kind_writeoff')],['adjust',t('kind_adjust')]].map(([k,n])=>`<button class="${tab===k?'active':''}" onclick="tab='${k}';render()">${n}</button>`).join('')}
    </div>
    ${rows.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('what')}</th><th>${t('customer')}</th><th>${t('date')}</th><th>${t('amount')}</th><th>${t('type')}</th><th></th></tr></thead>
      <tbody>${rows.slice(0,80).map(m=>{
        const total=m.kind==='receipt'?m.qty*m.cost:m.qty*m.price;
        const debt=m.kind==='sale'?Math.max(0,total-(m.paid||0)):0;
        const open=isOpeningDebt(m);
        return`<tr>
          <td><b>${esc(open?openingNote(m.note)||t('opening_debt'):(m.name||m.note))}</b>${debt?`<div style="color:var(--danger);font-size:12px">${t('debt')} ${cash(debt)}</div>`:''}</td>
          <td>${esc(m.customer_name||m.supplier_name||'—')}</td>
          <td>${m.date}</td>
          <td>${cash(total)}</td>
          <td><span class="${kindPill(m.kind)}">${kindLabel(m.kind,m)}</span></td>
          <td class="acts">
            ${!open&&(m.kind==='sale'||m.kind==='return')?`<button class="outline" onclick="printReceipt(${m.id})">${t('print')}</button>`:''}
            ${!open&&m.kind==='sale'&&m.batch?`<button class="outline" onclick="openPartialReturn('${String(m.batch).replace(/'/g,'')}')">${t('return_from_check')}</button>`:''}
            ${!open&&m.kind==='sale'?`<button class="outline" onclick='openReturn(${JSON.stringify({id:m.product_id,price:m.price,name:m.name,customer_id:m.customer_id||''})})'>${t('return')}</button>`:''}
          </td>
        </tr>`}).join('')}</tbody>
    </table></div>`:`<div class="empty"><p>${t('no_ops')}</p></div>`}
  </div>`;
}

function settingsPage(){
  const urls=(hubInfo&&hubInfo.urls)||[];
  return `<div class="panel"><div class="panel-b">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
    <h2 style="margin:0;font-family:var(--display)">${t('one_app')}</h2>
  </div>
  <div style="margin:0 0 6px;font-weight:700;font-size:13px;color:var(--muted)">${t('language')}</div>
  <div style="margin:0 0 16px">${langSwitcherHtml()}</div>
  <h2 style="margin:0 0 8px;font-family:var(--display);display:none">${t('one_app')}</h2>
    <p style="margin:0 0 12px;color:var(--muted);font-size:14px">${t('pwa_desc')}</p>
    <div class="hint">
      <b>${t('how_install')}</b><br>
      ${t('install_a')}<br>
      ${t('install_i')}<br>
      ${t('install_c')}<br>
      ${isStandalone()?`<br><b>${t('standalone_now')}</b>`:''}
    </div>
    <div class="acts" style="margin-bottom:18px">
      ${deferredInstall?`<button type="button" class="gold" onclick="installApp()">${t('install_app')}</button>`:''}
      <button type="button" class="outline" onclick="localStorage.removeItem('savdo_install_hide');installHintDismissed=false;render()">${t('show_install')}</button>
    </div>
    <h2 style="margin:18px 0 8px;font-family:var(--display)">${t('hub_sync')}</h2>
    <p style="margin:0 0 12px;color:var(--muted);font-size:14px">${t('hub_desc')}</p>
    <div class="hint">
      ${urls.length?urls.map(u=>`• <b>${esc(u)}</b>`).join('<br>'):`• ${t('start_server')}`}
      <br><br>${t('sync_flow')}
      <br><br><b>${t('one_account_hint')}</b>
    </div>
    <div class="acts" style="margin-bottom:18px">
      <button type="button" class="outline" onclick="navigator.clipboard.writeText((hubInfo&&hubInfo.urls&&hubInfo.urls[1])||location.origin);toast(t('addr_copied'))">${t('copy_wifi')}</button>
      <a class="outline" style="display:inline-grid;place-items:center;text-decoration:none;min-height:44px;padding:10px 14px;border-radius:14px;border:1px solid var(--line);font-weight:700" href="/download" target="_blank">${t('download_page')}</a>
    </div>
    <h2 style="margin:0 0 8px;font-family:var(--display)">${t('remote_title')}</h2>
    <p style="margin:0 0 12px;color:var(--muted);font-size:14px">${t('remote_desc')}</p>
    <div class="hint" style="margin-bottom:12px">
      ${(hubInfo&&hubInfo.remoteUrl)
        ? `• <b>${esc(hubInfo.remoteUrl)}</b>`
        : `• ${t('remote_none')}`}
    </div>
    <div class="formgrid" style="margin-bottom:10px">
      <label class="wide">${t('remote_url')}<input id="remoteUrlInput" value="${esc((hubInfo&&hubInfo.remoteUrl)||'')}" placeholder="https://….trycloudflare.com" maxlength="200"></label>
    </div>
    <div class="acts" style="margin-bottom:22px">
      <button type="button" class="primary" onclick="saveRemoteUrl()">${t('remote_save')}</button>
      <button type="button" class="outline" onclick="copyRemoteUrl()">${t('remote_copy')}</button>
      <button type="button" class="outline" onclick="clearRemoteUrl()">${t('remote_clear')}</button>
    </div>
    <h2 style="margin:0 0 8px;font-family:var(--display)">${t('shop')}</h2>
    <p style="margin:0 0 16px;color:var(--muted);font-size:14px">${t('shop_settings')}</p>
    ${can('settings')?`<form id="settingsForm">
      <div class="formgrid">
        <label class="wide">${t('shop_name')}<input name="name" value="${esc(state.user.name)}" required></label>
        <label>${t('currency')}<select name="currency">${['TJS','USD','EUR','RUB'].map(c=>`<option ${c===state.user.currency?'selected':''}>${c}</option>`).join('')}</select></label>
        <label>${t('zone')}<select name="zone">${['Asia/Dushanbe','Europe/Moscow','Europe/Berlin','Asia/Dubai'].map(z=>`<option ${z===state.user.zone?'selected':''}>${z}</option>`).join('')}</select></label>
        <label>${t('vat')}<input name="vat_percent" type="number" min="0" max="100" step="0.1" value="${esc(state.user.vat_percent||0)}"></label>
        <label>${t('bonus_pct')}<input name="bonus_percent" type="number" min="0" max="100" step="0.1" value="${esc(state.user.bonus_percent||0)}"></label>
        <label class="wide">${t('warehouse_main')}<input name="wh1_name" value="${esc(state.user.wh1_name||'')}" maxlength="60" placeholder="${t('warehouse_main')}"></label>
        <label class="wide">${t('warehouse_2')}<input name="wh2_name" value="${esc(state.user.wh2_name||'')}" maxlength="60" placeholder="${t('warehouse_2')}"></label>
        <label class="wide">${t('mode_change')}<select name="biz_mode"><option value="shop" ${!isCompany()?'selected':''}>${t('mode_shop_badge')}</option><option value="company" ${isCompany()?'selected':''}>${t('mode_company_badge')}</option></select></label>
        ${isCompany()?`
        <h3 style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('company')}</h3>
        <label class="wide">${t('company_legal')}<input name="company_legal" value="${esc(state.user.company_legal||'')}" maxlength="120"></label>
        <label>${t('company_inn')}<input name="company_inn" value="${esc(state.user.company_inn||'')}" maxlength="40"></label>
        <label>${t('company_phone')}<input name="company_phone" value="${esc(state.user.company_phone||'')}" maxlength="40"></label>
        <label class="wide">${t('company_address')}<input name="company_address" value="${esc(state.user.company_address||'')}" maxlength="200"></label>
        <label class="wide">${t('period_lock')}<input name="locked_until" type="date" value="${esc(state.user.locked_until||'')}"><small style="color:var(--muted)">${t('period_lock_hint')}</small></label>
        <h3 style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('fiscal')}</h3>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="fiscal_enabled" type="checkbox" value="1" ${state.user.fiscal_enabled?'checked':''} style="width:auto">
          ${t('fiscal_on')}
        </label>
        <label>${t('fiscal_reg')}<input name="fiscal_reg" value="${esc(state.user.fiscal_reg||'')}" maxlength="40"></label>
        <label>${t('fiscal_serial')}<input name="fiscal_serial" value="${esc(state.user.fiscal_serial||'')}" maxlength="60"></label>
        <h3 style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('nav_central')}</h3>
        <label class="wide">${t('hub_url')}<input name="hub_url" value="${esc(state.user.hub_url||'')}" placeholder="http://192.168.1.10:4173" maxlength="200"></label>
        <label class="wide">${t('hub_token')}<input name="hub_token" value="${esc(state.user.hub_token||'')}" maxlength="80" autocomplete="off"></label>
        <div class="hint">${t('hub_hint')}</div>`:''}
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="require_shift" type="checkbox" value="1" ${state.user.require_shift?'checked':''} style="width:auto">
          ${t('require_shift')}
        </label>
        <label class="wide">${t('pin')} <small>(${t('pin_hint')})</small><input name="pin" type="password" inputmode="numeric" maxlength="8" placeholder="${state.user.has_pin?'••••':t('pin_hint')}" autocomplete="new-password"></label>
        <label class="wide">${t('void_pin')}<input name="void_pin" type="password" inputmode="numeric" maxlength="8" placeholder="${state.user.has_void_pin?'••••':t('pin_hint')}" autocomplete="new-password"></label>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="block_below_cost" type="checkbox" value="1" ${state.user.block_below_cost?'checked':''} style="width:auto">
          ${t('min_price_block')}
        </label>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="auto_backup" type="checkbox" value="1" ${state.user.auto_backup?'checked':''} style="width:auto">
          ${t('auto_backup')}${state.user.last_backup?' · '+t('last_backup')+' '+esc(state.user.last_backup):''}
        </label>
        <label class="wide">${t('telegram_token')}<input name="telegram_token" value="${esc(state.user.telegram_token||'')}" maxlength="200" autocomplete="off"></label>
        <label class="wide">${t('telegram_chat')}<input name="telegram_chat" value="${esc(state.user.telegram_chat||'')}" maxlength="60"></label>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="alert_low" type="checkbox" value="1" ${state.user.alert_low?'checked':''} style="width:auto">
          ${t('alert_low')}
        </label>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="alert_expiry" type="checkbox" value="1" ${state.user.alert_expiry?'checked':''} style="width:auto">
          ${t('alert_expiry')}
        </label>
        <div class="hint">${t('alert_daily')}</div>
        <h3 style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('printer')}</h3>
        <label class="wide" style="display:flex;gap:10px;align-items:center">
          <input name="printer_enabled" type="checkbox" value="1" ${state.user.printer_enabled?'checked':''} style="width:auto">
          ${t('printer_on')}
        </label>
        <label class="wide">${t('printer_host')}<input name="printer_host" value="${esc(state.user.printer_host||'')}" placeholder="192.168.1.50" maxlength="80"></label>
        <label>${t('printer_port')}<input name="printer_port" type="number" min="1" max="65535" value="${esc(state.user.printer_port||9100)}"></label>
        <label>${t('printer_width')}<select name="printer_width">${[32,42,48].map(n=>`<option value="${n}" ${Number(state.user.printer_width)===n?'selected':''}>${n}</option>`).join('')}</select></label>
        <h3 class="wide" style="margin:18px 0 8px;font-family:var(--display);font-size:16px">${t('red_stock')}</h3>
        <label class="wide">${t('low_threshold')}
          <input name="low_stock" type="number" min="0" step="1" required value="${esc(lowLimit())}">
        </label>
        <div class="hint wide">${t('low_example')}</div>
      </div>
      <div class="error" id="settingsError"></div>
      <button class="primary">${t('save')}</button>
    </form>`:`<div class="hint">${t('no_access')}</div>`}
    ${can('shops')&&modeHas('shops')?`<div style="margin-top:28px;padding-top:20px;border-top:1px solid var(--line)">
      <h2 style="margin:0 0 8px;font-family:var(--display);font-size:18px">${t('branches')}</h2>
      <div class="acts" style="margin-bottom:12px"><button class="primary" type="button" onclick="openBranch()">${t('add_branch')}</button></div>
      ${(state.shops||[]).length?`<div class="tablewrap"><table><thead><tr><th>${t('shop')}</th><th></th></tr></thead>
      <tbody>${state.shops.map(s=>`<tr>
        <td><b>${esc(s.name)}</b>${s.main?' · main':''}${Number(s.id)===Number(state.user.active_shop_id)?' · ✓':''}</td>
        <td class="acts">
          ${Number(s.id)!==Number(state.user.active_shop_id)?`<button class="outline" onclick="switchShop(${s.id})">${t('switch_shop')}</button>`:''}
          ${!s.main?`<button class="danger" onclick="deleteBranch(${s.id})">${t('hide')}</button>`:''}
        </td>
      </tr>`).join('')}</tbody></table></div>`:''}
    </div>`:''}
    ${can('staff')?`<div style="margin-top:28px;padding-top:20px;border-top:1px solid var(--line)">
      <h2 style="margin:0 0 8px;font-family:var(--display);font-size:18px">${t('staff')}</h2>
      <div class="acts" style="margin-bottom:12px"><button class="primary" type="button" onclick="openStaff()">${t('add_staff')}</button></div>
      ${(state.staff||[]).length?`<div class="tablewrap"><table><thead><tr><th>${t('name')}</th><th>Email</th><th>${t('role')}</th>${isCompany()?`<th>${t('permissions')}</th>`:''}<th></th></tr></thead>
      <tbody>${state.staff.map(st=>`<tr>
        <td><b>${esc(st.name)}</b>${st.has_pin?'':` · <span style="color:var(--danger);font-size:12px">${t('pin_not_set_short')}</span>`}</td>
        <td>${esc(st.email)}</td>
        <td>${st.role==='cashier'?t('role_cashier'):t('role_admin')}</td>
        ${isCompany()?`<td style="font-size:11px;color:var(--muted)">${esc((st.permissions||[]).slice(0,6).join(', '))}${(st.permissions||[]).length>6?'…':''}</td>`:''}
        <td class="acts">
          <button class="outline" onclick="editStaff(${st.id})">${t('edit')}</button>
          ${st.id!==undefined&&st.email!==state.user.email&&st.role==='cashier'?`<button class="danger" onclick="deleteStaff(${st.id})">${t('hide')}</button>`:''}
        </td>
      </tr>`).join('')}</tbody></table></div>`:`<p style="color:var(--muted);font-size:13px">${t('staff')}</p>`}
    </div>`:''}
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid var(--line)">
      <h2 style="margin:0 0 8px;font-family:var(--display);font-size:18px">${t('backup')}</h2>
      <p style="color:var(--muted);font-size:13px;margin:0 0 12px">${t('backup_hint')}</p>
      <div class="acts">
        <button class="primary" type="button" onclick="downloadBackup()">JSON</button>
        <button class="outline" type="button" onclick="downloadDbFile()">SQLite</button>
        ${can('backup')?`<button class="outline" type="button" onclick="sendTelegramBackup()">${t('telegram_send')}</button>
        <label class="outline" style="display:inline-flex;align-items:center;cursor:pointer;margin:0">${t('restore')}<input id="restoreFile" type="file" accept=".json,application/json" hidden></label>`:''}
      </div>
    </div>
  </div></div>`;
}

function showModal(title,fields,submit,extra=''){
  const d=document.querySelector('#modal');
  d.innerHTML=`<h2>${title}</h2><form id="dialogForm"><div class="formgrid">${fields}</div>
    <div class="error" id="dialogError"></div>
    <div class="dialogbuttons">
      <button type="button" class="outline" onclick="document.querySelector('#modal').close()">${t('cancel')}</button>
      ${extra}<button class="primary" type="submit">${t('save')}</button>
    </div></form>`;
  d.showModal();
  document.querySelector('#dialogForm').onsubmit=async e=>{
    e.preventDefault();const btn=e.target.querySelector('[type=submit]');btn.disabled=true;
    try{
      const result=await submit(Object.fromEntries(new FormData(e.target)));
      d.close();
      if(result?.queued){
        const raw=localStorage.getItem(STATE_KEY);
        if(raw)state=JSON.parse(raw);
        render();
        toast(t('offline_queued'));
      }else{
        await load();
        toast(t('saved'));
        if(result?._cartPrint&&result.batch){
          await printThermalIfEnabled(result);
          printCartReceipt(result.batch,result);
        }else if(result?.movement?.kind==='sale'&&result._print!==false)printReceipt(result.id);
      }
    }catch(err){document.querySelector('#dialogError').textContent=err.message;btn.disabled=false}
  };
}
function field(label,name,type='text',value='',wide=false,attrs='required'){
  return `<label class="${wide?'wide':''}">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs} ${type==='number'?'min="0" step="0.01"':''}></label>`;
}
function dateField(){return `<label>${t('date')}<input name="date" type="date" value="${esc(state.today)}" max="${esc(state.today)}" required></label>`}
function customerSelect(selected=''){
  return `<label class="wide">${t('customer')}
    <input list="custList" name="customer_q" placeholder="${t('find_customer')}" autocomplete="off"
      oninput="pickCustomerFromQuery(this,'customer')" value="${esc(customerLabel(selected))}">
    <input type="hidden" name="customer" id="customerHidden" value="${esc(selected||'')}">
    <datalist id="custList">${(state.customers||[]).map(c=>`<option value="${esc(c.name)}${c.phone?' · '+esc(c.phone):''}" data-id="${c.id}"></option>`).join('')}</datalist>
  </label>`;
}
function customerLabel(id){
  if(!id)return '';
  const c=(state.customers||[]).find(x=>String(x.id)===String(id));
  if(!c)return '';
  return c.name+(c.phone?' · '+c.phone:'');
}
function pickCustomerFromQuery(el,hiddenName){
  const q=String(el.value||'').trim().toLowerCase();
  const hidden=el.parentElement.querySelector(`[name="${hiddenName}"]`)||document.querySelector(`#${hiddenName}Hidden`);
  if(!q){if(hidden)hidden.value='';return}
  const c=(state.customers||[]).find(x=>{
    const label=(x.name+(x.phone?' · '+x.phone:'')).toLowerCase();
    const phone=String(x.phone||'').replace(/\D/g,'');
    const digits=q.replace(/\D/g,'');
    return label===q||label.includes(q)||(digits&&phone.includes(digits))||String(x.name).toLowerCase()===q;
  });
  if(hidden)hidden.value=c?c.id:'';
}
function customerPickerHtml(){
  const cur=cartCustomer();
  const val=cur?(cur.name+(cur.phone?' · '+cur.phone:'')):'';
  return `<div style="margin:0 0 8px">
    <label style="display:grid;gap:4px;font-size:13px;margin:0">${t('customer')}
      <input list="kassaCustList" placeholder="${t('find_customer')}" value="${esc(val)}" autocomplete="off"
        oninput="onCartCustomerQuery(this)" onchange="onCartCustomerQuery(this)">
      <datalist id="kassaCustList">${(state.customers||[]).map(c=>`<option value="${esc(c.name)}${c.phone?' · '+esc(c.phone):''}"></option>`).join('')}</datalist>
    </label>
  </div>`;
}
function onCartCustomerQuery(el){
  const q=String(el.value||'').trim().toLowerCase();
  if(!q){cartCustomerId='';cartRedeemPoints=0;render();return}
  const digits=q.replace(/\D/g,'');
  const c=(state.customers||[]).find(x=>{
    const label=(x.name+(x.phone?' · '+x.phone:'')).toLowerCase();
    const phone=String(x.phone||'').replace(/\D/g,'');
    return label===q||(digits.length>=3&&phone.includes(digits))||String(x.name).toLowerCase().includes(q)||phone.endsWith(digits);
  });
  const next=c?String(c.id):'';
  if(next!==String(cartCustomerId||'')){
    cartCustomerId=next;
    cartRedeemPoints=0;
    render();
    const inp=document.querySelector('input[list=kassaCustList]');
    if(inp&&c)inp.value=c.name+(c.phone?' · '+c.phone:'');
  }
}
function openPartialReturn(batch){
  batch=String(batch||'').trim();
  if(!batch){toast(t('cart_missing'));return}
  const sales=(state.movements||[]).filter(m=>m.batch===batch&&m.kind==='sale');
  if(!sales.length){toast(t('cart_missing'));return}
  const sold={};
  for(const m of sales){
    if(!sold[m.product_id])sold[m.product_id]={id:m.product_id,name:m.name,price:m.price,qty:0};
    sold[m.product_id].qty+=m.qty;
  }
  const returned={};
  for(const m of (state.movements||[])){
    if(m.kind==='return'&&String(m.note||'').includes('ref:'+batch)){
      returned[m.product_id]=(returned[m.product_id]||0)+m.qty;
    }
  }
  const lines=Object.values(sold).map(p=>{
    const left=p.qty-(returned[p.id]||0);
    return {...p,left};
  }).filter(p=>p.left>0);
  if(!lines.length){toast(t('return_over'));return}
  showModal(t('partial_return')+(sales[0].doc_no?' · '+sales[0].doc_no:''),
    `<p class="wide" style="margin:0 0 8px;color:var(--muted);font-size:13px">${t('return_from_check')}</p>
     <div class="wide invent-list">${lines.map(p=>`
       <div class="invent-row">
         <div><b>${esc(p.name)}</b><div class="meta">${cash(p.price)} · ${t('return_left',{n:p.left})}</div></div>
         <label>${t('qty')}<input type="number" min="0" max="${p.left}" step="1" value="0" name="r_${p.id}"></label>
       </div>`).join('')}</div>
     ${dateField()}`,
    async b=>{
      const items=[];
      for(const p of lines){
        const n=Number(b['r_'+p.id]||0);
        if(n>0)items.push({product:p.id,qty:n});
      }
      if(!items.length)throw Error(t('cart_empty'));
      const r=await api('cart/partial-return',{batch,items,date:b.date});
      toast(t('saved')+' · '+cash(r.total||0));
      return r;
    }
  );
}
function openLastPartialReturn(){
  const last=(state.movements||[]).find(m=>m.kind==='sale'&&m.batch);
  if(!last){toast(t('no_void'));return}
  openPartialReturn(last.batch);
}

function quickSale(id){
  addToCart(id);
  if(view!=='kassa'){go('kassa');toast(t('added_cart'))}
}

function openProductById(id){
  const p=state.products.find(x=>x.id===id);
  if(!p){toast(t('product_missing'));return}
  openProduct(p);
}
function openProduct(p){
  const edit=!!p;
  pendingImage=null;
  const current=p?.image||'';
  showModal(edit?t('edit_product'):t('new_product'),
    `<label class="wide img-pick">${t('photo_label')}
      <div class="preview" id="imgPreview">${current?`<img src="${current}" alt="">`:'▣'}</div>
      <div class="img-actions">
        <label class="outline" style="margin:0;cursor:pointer;display:inline-flex;align-items:center">
          ${t('photo_pick')}
          <input id="imgFile" type="file" accept="image/*" capture="environment" hidden>
        </label>
        <button type="button" class="danger" id="imgClear" ${!current?'style="display:none"':''}>${t('remove_photo')}</button>
      </div>
      <small style="color:var(--muted);font-weight:500">${t('name_optional_hint')}</small>
    </label>`
    +`<label class="wide">${t('name_optional')}<input name="name" type="text" value="${esc(p?.name||'')}" maxlength="100" placeholder="${t('name_ph')}"></label>`
    +field(t('barcode'),'barcode','text',p?.barcode||'',true,'maxlength="64"')
    +field(t('category'),'category','text',p?.category||t('other'),true,'maxlength="60"')
    +`<label>${t('unit')}<select name="unit">
        <option value="pcs" ${(p?.unit||'pcs')==='pcs'?'selected':''}>${t('unit_pcs')}</option>
        <option value="kg" ${p?.unit==='kg'?'selected':''}>${t('unit_kg')}</option>
        <option value="l" ${p?.unit==='l'?'selected':''}>${t('unit_l')}</option>
      </select></label>`
    +field(t('cost'),'cost','number',p?p.cost/100:'')
    +field(t('sell_price'),'price','number',p?p.price/100:'')
    +field(t('promo_price'),'promo_price','number',p&&p.promo_price?p.promo_price/100:'',false,'min="0" step="0.01"')
    +field(t('wholesale_price'),'wholesale_price','number',p&&p.wholesale_price?p.wholesale_price/100:'',false,'min="0" step="0.01"')
    +`<label>${t('expiry')}<input name="expiry" type="date" value="${esc(p?.expiry||'')}"></label>`
    +(edit?'':field(t('initial_qty'),'stock','number','0',true,'required min="0" step="1"')+dateField()),
    b=>{
      const image=pendingImage===null?(edit?'__keep__':''):pendingImage;
      if(!edit&&!image&&!String(b.name||'').trim())throw Error(t('need_photo_or_name'));
      return edit?api('product/update',{...b,id:p.id,image}):api('product',{...b,image});
    }
  );
  document.querySelector('#imgFile').onchange=async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try{
      pendingImage=await compressImage(file);
      document.querySelector('#imgPreview').innerHTML=`<img src="${pendingImage}" alt="">`;
      document.querySelector('#imgClear').style.display='inline-flex';
    }catch(err){toast(err.message)}
  };
  document.querySelector('#imgClear').onclick=()=>{
    pendingImage='';
    document.querySelector('#imgPreview').innerHTML='▣';
    document.querySelector('#imgClear').style.display='none';
    const f=document.querySelector('#imgFile');if(f)f.value='';
  };
}
function openCustomer(c){
  const edit=!!c;
  showModal(edit?t('edit_customer'):t('new_customer'),
    field(t('name'),'name','text',c?.name||'',true)
    +field(t('phone'),'phone','text',c?.phone||'',true,'maxlength="40"')
    +field(t('note'),'note','text',c?.note||'',true,'maxlength="200"'),
    b=>edit?api('customer/update',{...b,id:c.id}):api('customer',b)
  );
}
function openPayment(customerId){
  const list=(state.customers||[]).filter(c=>c.debt>0);
  if(!list.length){toast(t('no_debtors'));return}
  const cur=list.find(c=>c.id===Number(customerId))||list[0];
  showModal(t('pay_debt'),
    `<label class="wide">${t('customer')}<select name="customer" id="payCustomer">${list.map(c=>`<option value="${c.id}" ${c.id===cur.id?'selected':''}>${esc(c.name)} · ${fmt(c.debt)}</option>`).join('')}</select></label>`
    +field(t('amount'),'amount','number',cur.debt/100)
    +field(t('note'),'note','text',t('payment'),true,'')
    +dateField(),
    b=>api('payment',b)
  );
  document.querySelector('#payCustomer').onchange=e=>{
    const c=list.find(x=>x.id===Number(e.target.value));
    document.querySelector('[name=amount]').value=c.debt/100;
  };
}
function openingDebtPanel(kind){
  const isSup=kind==='supplier';
  const rows=(state.movements||[])
    .filter(m=>isOpeningDebt(m)&&(isSup?m.kind==='receipt':m.kind==='sale'))
    .slice(0,40);
  if(!rows.length)return '';
  return `<div class="panel" style="margin-top:12px"><div class="panel-h"><div><h2>${t('opening_debts')}</h2><p>${t('opening_debt_hint')}</p></div></div>
    <div class="tablewrap"><table>
      <thead><tr><th>${isSup?t('supplier'):t('customer')}</th><th>${t('date')}</th><th>${t('amount')}</th><th>${t('note')}</th><th></th></tr></thead>
      <tbody>${rows.map(m=>{
        const amt=isSup?(m.cost||0):(m.price||0);
        const who=isSup?(m.supplier_name||'—'):(m.customer_name||'—');
        const note=openingNote(m.note);
        const payload={id:m.id,kind,amount:amt,date:m.date,note};
        return`<tr>
          <td><b>${esc(who)}</b></td>
          <td>${esc(m.date)}</td>
          <td><b>${cash(amt)}</b></td>
          <td>${esc(note||'—')}</td>
          <td class="acts">
            <button class="outline" onclick='editOpeningDebt(${JSON.stringify(payload)})'>${t('edit')}</button>
            <button class="danger" onclick="deleteOpeningDebt('${kind}',${m.id})">${t('delete')}</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div></div>`;
}
function openOpeningDebt(customerId){
  const list=state.customers||[];
  if(!list.length){toast(t('no_customers'));return}
  const cur=list.find(c=>c.id===Number(customerId))||list[0];
  showModal(t('opening_debt'),
    `<label class="wide">${t('customer')}<select name="customer" id="openDebtCust">${list.map(c=>`<option value="${c.id}" ${c.id===cur.id?'selected':''}>${esc(c.name)}${c.debt?' · '+fmt(c.debt):''}</option>`).join('')}</select></label>`
    +field(t('amount'),'amount','number','',true,'required min="0.01" step="0.01"')
    +field(t('note'),'note','text',t('opening_debt_note'),true,'maxlength="180"')
    +dateField(),
    b=>api('customer/opening-debt',b)
  );
}
function openSupplierOpeningDebt(supplierId){
  const list=state.suppliers||[];
  if(!list.length){toast(t('no_suppliers'));return}
  const cur=list.find(c=>c.id===Number(supplierId))||list[0];
  showModal(t('opening_debt'),
    `<label class="wide">${t('supplier')}<select name="supplier" id="openDebtSup">${list.map(c=>`<option value="${c.id}" ${c.id===cur.id?'selected':''}>${esc(c.name)}${c.debt?' · '+fmt(c.debt):''}</option>`).join('')}</select></label>`
    +field(t('amount'),'amount','number','',true,'required min="0.01" step="0.01"')
    +field(t('note'),'note','text',t('opening_debt_note'),true,'maxlength="180"')
    +dateField(),
    b=>api('supplier/opening-debt',b)
  );
}
function editOpeningDebt(row){
  const isSup=row.kind==='supplier';
  showModal(t('edit_opening_debt'),
    field(t('amount'),'amount','number',(row.amount||0)/100,true,'required min="0.01" step="0.01"')
    +field(t('note'),'note','text',row.note||'',true,'maxlength="180"')
    +`<label>${t('date')}<input name="date" type="date" value="${esc(row.date||state.today)}" max="${esc(state.today)}" required></label>`,
    b=>api(isSup?'supplier/opening-debt/update':'customer/opening-debt/update',{...b,id:row.id})
  );
}
async function deleteOpeningDebt(kind,id){
  if(!confirm(t('opening_debt_del_q')))return;
  try{
    await api(kind==='supplier'?'supplier/opening-debt/delete':'customer/opening-debt/delete',{id});
    await load();
    toast(t('saved'));
  }catch(e){toast(e.message)}
}
function openMove(kind,productId){
  if(kind!=='expense'&&!state.products.length){toast(t('products_first'));openProduct();return}
  let fields;
  if(kind==='expense'){
    fields=field(t('for_what'),'note','text','',true)+field(t('amount'),'amount','number','',true)+dateField();
  }else if(kind==='sale'){
    const sel=productId||state.products.find(p=>p.stock>0)?.id||state.products[0].id;
    const p=state.products.find(x=>x.id===Number(sel));
    fields=`<label class="wide">${t('product')}<select name="product" id="productSelect">${state.products.map(x=>`<option value="${x.id}" ${x.id===p.id?'selected':''}>${esc(x.name)} · ${x.stock} ${t('pcs')}</option>`).join('')}</select></label>
      <label>${t('qty')}<input name="qty" type="number" min="1" step="1" value="1" required></label>
      ${field(t('price'),'price','number',p.price/100)}
      ${customerSelect()}
      <div class="wide"><div style="font-size:12px;color:var(--muted);margin-bottom:8px;font-weight:600">${t('payment')}</div>
        <div class="paymodes">
          <label><input type="radio" name="pay" value="cash" checked> ${t('cash')}</label>
          <label><input type="radio" name="pay" value="debt"> ${t('debt_mode')}</label>
          <label><input type="radio" name="pay" value="partial"> ${t('partial')}</label>
        </div></div>
      <label class="wide" id="paidWrap" style="display:none">${t('pay_now')}<input name="paid" type="number" min="0" step="0.01" value="0"></label>
      ${dateField()}`;
  }else if(kind==='writeoff'){
    const withStock=state.products.filter(p=>p.stock>0);
    const sel=productId||withStock[0]?.id||state.products[0].id;
    const p=state.products.find(x=>x.id===Number(sel));
    fields=`<label class="wide">${t('product')}<select name="product" id="productSelect">${state.products.map(x=>`<option value="${x.id}" ${x.id===p.id?'selected':''}>${esc(x.name)} · ${x.stock} ${t('pcs')}</option>`).join('')}</select></label>
      <label>${t('qty')}<input name="qty" type="number" min="1" step="1" value="1" required></label>
      ${field(t('writeoff_reason'),'note','text','',true,'required maxlength="200"')}
      ${dateField()}`;
  }else if(kind==='receipt'){
    const p=state.products[0];
    const suppliers=state.suppliers||[];
    fields=`<label class="wide">${t('product')}<select name="product" id="productSelect">${state.products.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label>${t('qty')}<input name="qty" type="number" min="1" step="1" value="1" required></label>
      ${field(t('cost'),'cost','number',p.cost/100)}
      <label class="wide">${t('supplier')}<select name="supplier"><option value="">${t('select_none')}</option>
        ${suppliers.map(s=>`<option value="${s.id}">${esc(s.name)}${s.debt?' · '+fmt(s.debt):''}</option>`).join('')}
      </select></label>
      <div class="wide"><div style="font-size:12px;color:var(--muted);margin-bottom:8px;font-weight:600">${t('purchase_pay')}</div>
        <div class="paymodes">
          <label><input type="radio" name="pay" value="cash" checked> ${t('pay_cash_short')}</label>
          <label><input type="radio" name="pay" value="debt"> ${t('debt_mode')}</label>
          <label><input type="radio" name="pay" value="partial"> ${t('partial')}</label>
        </div></div>
      <label class="wide" id="paidWrap" style="display:none">${t('pay_now')}<input name="paid" type="number" min="0" step="0.01" value="0"></label>
      ${dateField()}`;
  }else{
    const p=state.products[0];
    fields=`<label class="wide">${t('product')}<select name="product" id="productSelect">${state.products.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label>${t('qty')}<input name="qty" type="number" min="1" step="1" value="1" required></label>
      ${field(t('cost'),'cost','number',p.cost/100)}
      ${dateField()}`;
  }
  const titles={sale:t('kind_sale'),receipt:t('kind_receipt'),expense:t('kind_expense'),writeoff:t('kind_writeoff')};
  showModal(titles[kind]||kind,fields,async b=>{
    const res=await api('movement',{...b,kind});
    if(kind==='sale')res._print=true;
    return res;
  },kind==='sale'?`<button type="button" class="outline" id="saveNoPrint">${t('no_print')}</button>`:'');

  if(kind==='sale'||kind==='receipt'){
    const sync=()=>{const w=document.querySelector('#paidWrap');if(w)w.style.display=document.querySelector('input[name=pay]:checked')?.value==='partial'?'grid':'none'};
    document.querySelectorAll('input[name=pay]').forEach(r=>r.onchange=sync);
  }
  if(kind==='sale'){
    document.querySelector('#saveNoPrint').onclick=async()=>{
      const form=document.querySelector('#dialogForm');const btn=document.querySelector('#saveNoPrint');btn.disabled=true;
      try{await api('movement',{...Object.fromEntries(new FormData(form)),kind:'sale'});document.querySelector('#modal').close();await load();toast(t('sale_saved'))}
      catch(err){document.querySelector('#dialogError').textContent=err.message;btn.disabled=false}
    };
  }
  if(kind!=='expense'){
    document.querySelector('#productSelect')?.addEventListener('change',e=>{
      const p=state.products.find(x=>x.id===Number(e.target.value));
      if(!p)return;
      if(kind==='sale')document.querySelector('[name=price]').value=p.price/100;
      if(kind==='receipt')document.querySelector('[name=cost]').value=p.cost/100;
    });
  }
}
function suppliersPage(s){
  const list=(state.suppliers||[]).filter(x=>x.name.toLowerCase().includes(search.toLowerCase())||(x.phone||'').includes(search));
  const debt=(state.suppliers||[]).reduce((a,x)=>a+x.debt,0);
  const pays=(state.supplier_payments||[]).slice(0,10);
  return `
  <div class="stats">
    <div class="stat dark"><span>${t('supplier_debt')}</span><strong>${cash(debt)}</strong></div>
    <div class="stat"><span>${t('suppliers')}</span><strong>${(state.suppliers||[]).length}</strong></div>
    <div class="stat"><span>${t('debtor_count')}</span><strong>${(state.suppliers||[]).filter(x=>x.debt>0).length}</strong></div>
  </div>
  <div class="panel">
    <div class="panel-h">
      <div><h2>${t('suppliers')}</h2><p>${t('supplier_debt')}</p></div>
      <div class="acts">
        <button class="outline" onclick="openSupplierPayment()">${t('pay_supplier')}</button>
        <button class="gold" onclick="openSupplierOpeningDebt()">${t('opening_debt_supplier')}</button>
        <button class="primary" onclick="openSupplier()">${t('new_supplier')}</button>
      </div>
    </div>
    <div class="toolbar"><input placeholder="${t('name_phone')}" value="${esc(search)}" oninput="search=this.value;render()"></div>
    ${list.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('supplier')}</th><th>${t('phone')}</th><th>${t('debt')}</th><th></th></tr></thead>
      <tbody>${list.map(c=>`<tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(c.phone||'—')}</td>
        <td>${c.debt?`<span class="pill debt">${cash(c.debt)}</span>`:`<span class="pill">${t('no_debt')}</span>`}</td>
        <td class="acts">
          <button class="outline" onclick="openSupplierOpeningDebt(${c.id})">${t('opening_debt_supplier')}</button>
          ${c.debt?`<button class="gold" onclick="openSupplierPayment(${c.id})">${t('payment')}</button>`:''}
          <button class="outline" onclick='openSupplier(${JSON.stringify({id:c.id,name:c.name,phone:c.phone,note:c.note})})'>${t('edit')}</button>
          <button class="danger" onclick="archiveSupplier(${c.id})">${t('hide')}</button>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`:`<div class="empty"><h3>${t('no_suppliers')}</h3><button class="primary" onclick="openSupplier()">${t('plus_add')}</button></div>`}
  </div>
  ${pays.length?`<div class="panel" style="margin-top:12px"><div class="panel-h"><h2>${t('recent_payments')}</h2></div>
    <div class="tablewrap"><table><thead><tr><th>${t('supplier')}</th><th>${t('date')}</th><th>${t('amount')}</th></tr></thead>
    <tbody>${pays.map(p=>`<tr><td>${esc(p.supplier_name)}</td><td>${p.date}</td><td>${cash(p.amount)}</td></tr>`).join('')}</tbody></table></div></div>`:''}
  ${openingDebtPanel('supplier')}`;
}
function cashbookPage(){
  const rows=state.cashbook||[];
  const inn=rows.filter(r=>r.kind==='in').reduce((a,r)=>a+r.amount,0);
  const out=rows.filter(r=>r.kind==='out').reduce((a,r)=>a+r.amount,0);
  return `
  <div class="stats">
    <div class="stat dark"><span>${t('shift_cash_in')}</span><strong>${cash(inn)}</strong></div>
    <div class="stat"><span>${t('shift_cash_out')}</span><strong>${cash(out)}</strong></div>
    <div class="stat"><span>${t('shift')}</span><strong>${state.shift?('#'+state.shift.id):t('shift_closed')}</strong></div>
  </div>
  <div class="panel">
    <div class="panel-h"><div><h2>${t('cashbook')}</h2><p>${t('cashbook_hint')}</p></div>
      <button class="outline" onclick="go('kassa')">${t('nav_kassa')}</button>
    </div>
    ${rows.length?`<div class="tablewrap"><table>
      <thead><tr><th>${t('date')}</th><th>${t('type')}</th><th>${t('amount')}</th><th>${t('note')}</th><th>${t('shift')}</th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td>${esc(r.date)}</td>
        <td>${r.kind==='in'?t('shift_cash_in'):t('shift_cash_out')}</td>
        <td><b>${cash(r.amount)}</b></td>
        <td>${esc(r.note||'—')}</td>
        <td>#${r.shift_id}</td>
      </tr>`).join('')}</tbody>
    </table></div>`:`<div class="empty"><p>${t('no_data')}</p></div>`}
  </div>`;
}
function openSupplier(c){
  const edit=!!c;
  showModal(edit?t('edit_supplier'):t('new_supplier'),
    field(t('name'),'name','text',c?.name||'',true)
    +field(t('phone'),'phone','text',c?.phone||'',true,'maxlength="40"')
    +field(t('note'),'note','text',c?.note||'',true,'maxlength="200"'),
    b=>edit?api('supplier/update',{...b,id:c.id}):api('supplier',b)
  );
}
function openSupplierPayment(supplierId){
  const list=(state.suppliers||[]).filter(c=>c.debt>0);
  if(!list.length){toast(t('no_debtors'));return}
  const cur=list.find(c=>c.id===Number(supplierId))||list[0];
  showModal(t('pay_supplier'),
    `<label class="wide">${t('supplier')}<select name="supplier" id="supPay">${list.map(c=>`<option value="${c.id}" ${c.id===cur.id?'selected':''}>${esc(c.name)} · ${fmt(c.debt)}</option>`).join('')}</select></label>`
    +field(t('amount'),'amount','number',cur.debt/100)
    +field(t('note'),'note','text','',true,'')
    +`<label class="wide"><input type="checkbox" name="from_cash" value="1" checked> ${t('from_cash')}</label>`
    +dateField(),
    b=>api('supplier/payment',{...b,from_cash:b.from_cash?1:0})
  );
  document.querySelector('#supPay').onchange=e=>{
    const c=list.find(x=>x.id===Number(e.target.value));
    document.querySelector('[name=amount]').value=c.debt/100;
  };
}
async function archiveSupplier(id){
  if(!confirm(t('hide_q')))return;
  try{await api('supplier/archive',{id});await load();toast(t('saved'))}catch(e){toast(e.message)}
}
window.onBarcodeEnter=onBarcodeEnter;
window.openSupplier=openSupplier;
window.openSupplierPayment=openSupplierPayment;
window.archiveSupplier=archiveSupplier;
function openReturn(sale){
  showModal(t('return'),
    `<label class="wide">${t('product')}<input value="${esc(sale.name)}" disabled></label>
     <input type="hidden" name="product" value="${sale.id}">
     <label>${t('qty')}<input name="qty" type="number" min="1" step="1" value="1" required></label>
     ${field(t('price'),'price','number',sale.price/100)}
     ${customerSelect(sale.customer_id||'')}
     ${field(t('note'),'note','text',t('return'),true,'')}
     ${dateField()}`,
    b=>api('movement',{...b,kind:'return'})
  );
}

function writePrint(html){
  const f=document.querySelector('#printFrame');const d=f.contentDocument;d.open();d.write(html);d.close();
}
function printReceipt(id){
  const m=state.movements.find(x=>x.id===id);if(!m){toast(t('not_found'));return}
  const total=m.qty*m.price;const debt=m.kind==='sale'?Math.max(0,total-(m.paid||0)):0;
  writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('receipt')}</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:20px;max-width:340px;margin:auto}h1{font-size:18px;margin:0}.m{color:#666;font-size:12px}
    table{width:100%;margin-top:14px;font-size:14px;border-collapse:collapse}td{padding:7px 0;border-bottom:1px dashed #ccc}.t{font-weight:700}</style></head><body>
    ${companyHeaderHtml(`<div class="m">${m.kind==='return'?t('return'):t('receipt')}${m.doc_no?' · '+esc(m.doc_no):''} · ${m.date}</div>`, m.fiscal_no||'')}
    <table>
      <tr><td>${t('product')}</td><td style="text-align:right"><b>${esc(m.name)}</b></td></tr>
      <tr><td>${t('qty')}</td><td style="text-align:right">${m.qty}</td></tr>
      <tr><td>${t('price')}</td><td style="text-align:right">${cash(m.price)}</td></tr>
      ${m.customer_name?`<tr><td>${t('customer')}</td><td style="text-align:right">${esc(m.customer_name)}</td></tr>`:''}
      <tr><td>${t('summary')}</td><td style="text-align:right" class="t">${cash(total)}</td></tr>
      ${m.kind==='sale'?`<tr><td>${t('payment')}</td><td style="text-align:right">${cash(m.paid||0)}</td></tr>`:''}
      ${debt?`<tr><td>${t('debt')}</td><td style="text-align:right">${cash(debt)}</td></tr>`:''}
    </table>
    <script>onload=()=>print()<\/script></body></html>`);
}
async function printThermalIfEnabled(meta={}){
  if(!state?.user?.printer_enabled||!state.user.printer_host)return false;
  try{
    await api('print/receipt',{
      batch:meta.batch||'',
      doc_no:meta.doc_no||'',
      payable:meta.payable,
      discount:meta.discount||0,
      pay_method:meta.pay_method||'',
      points:meta.points||0,
      points_spent:meta.points_spent||0,
      date:state.today
    });
    toast(t('printed_ok'));
    return true;
  }catch(e){toast(e.message);return false}
}
async function switchShop(id){
  try{
    await api('shops/switch',{id:Number(id)});
    cart={};cartDiscount={percent:0,amount:0};cartCustomerId='';cartRedeemPoints=0;
    await load();
    toast(t('switch_shop'));
  }catch(e){toast(e.message)}
}
function openBranch(){
  showModal(t('add_branch'),
    field(t('shop_name'),'name','text','',true),
    async b=>{
      const r=await api('shops',b);
      toast(t('saved'));
      return r;
    }
  );
}
async function deleteBranch(id){
  if(!confirm(t('hide_q')))return;
  try{await api('shops/delete',{id});await load();toast(t('saved'))}catch(e){toast(e.message)}
}
function printCartReceipt(batch,meta={}){
  const rows=(state.movements||[]).filter(m=>m.batch===batch&&m.kind==='sale');
  const lines=rows.length?rows:null;
  if(!lines&&!meta.payable){toast(t('not_found'));return}
  const items=lines||[];
  const total=items.reduce((a,m)=>a+m.qty*m.price,0)||Number(meta.payable)||0;
  const vatPct=Number(state.user.vat_percent)||0;
  const vat=vatPct?Math.round(total*vatPct/(100+vatPct)):0;
  const qrData=encodeURIComponent(`Savdo|${state.user.name}|${meta.doc_no||''}|${(total/100).toFixed(2)}|${state.today}`);
  const qr=`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${qrData}`;
  writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('cart_receipt')}</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:16px;max-width:340px;margin:auto}h1{font-size:18px;margin:0}.m{color:#666;font-size:12px}
    table{width:100%;margin-top:12px;font-size:13px;border-collapse:collapse}td{padding:6px 0;border-bottom:1px dashed #ccc}.t{font-weight:700}
    .qr{display:block;margin:14px auto 0;width:140px;height:140px}</style></head><body>
    ${companyHeaderHtml(`<div class="m">${t('cart_receipt')}${meta.doc_no?' · '+esc(meta.doc_no):''} · ${esc(state.today)}${meta.points?' · ⭐ +'+meta.points:''}</div>`, meta.fiscal_no||(items[0]&&items[0].fiscal_no)||'')}
    <table>
      ${items.map(m=>`<tr><td>${esc(m.name)} × ${m.qty}</td><td style="text-align:right">${cash(m.qty*m.price)}</td></tr>`).join('')||`<tr><td>${t('cart')}</td><td style="text-align:right">${cash(total)}</td></tr>`}
      ${meta.discount?`<tr><td>${t('discount')}</td><td style="text-align:right">−${cash(meta.discount)}</td></tr>`:''}
      ${vat?`<tr><td>${t('vat_amount')} ${vatPct}%</td><td style="text-align:right">${cash(vat)}</td></tr>`:''}
      <tr><td class="t">${t('summary')}</td><td style="text-align:right" class="t">${cash(total)}</td></tr>
    </table>
    <img class="qr" src="${qr}" alt="QR" onerror="this.style.display='none'">
    <div class="m" style="text-align:center;margin-top:6px">${esc(meta.doc_no||batch||'')}</div>
    <script>onload=()=>print()<\/script></body></html>`);
}
async function printThermalDraft(){
  const {lines,sum,discount,payable,redeem}=cartTotals();
  if(!lines.length){toast(t('cart_empty'));return}
  try{
    await api('print/receipt',{
      lines:lines.map(l=>({name:l.p.name,qty:l.qty,price:sellP(l.p)})),
      payable,
      discount:(discount||0)+(redeem?redeem*100:0),
      date:state.today
    });
    toast(t('printed_ok'));
  }catch(e){toast(e.message)}
}
function printCartDraft(){
  const {lines,sum,discount,payable,vat,vatPct}=cartTotals();
  if(!lines.length){toast(t('cart_empty'));return}
  writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('cart_receipt')}</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:16px;max-width:340px;margin:auto}h1{font-size:18px;margin:0}.m{color:#666;font-size:12px}
    table{width:100%;margin-top:12px;font-size:13px;border-collapse:collapse}td{padding:6px 0;border-bottom:1px dashed #ccc}.t{font-weight:700}</style></head><body>
    ${companyHeaderHtml(`<div class="m">${t('cart_receipt')} · ${esc(whName(cartWarehouse))} · ${esc(state.today)}</div>`)}
    <table>
      ${lines.map(({p,qty})=>`<tr><td>${esc(p.name)} × ${qty} ${unitLabel(p.unit)}</td><td style="text-align:right">${cash(sellP(p)*qty)}</td></tr>`).join('')}
      ${discount?`<tr><td>${t('discount')}</td><td style="text-align:right">−${cash(discount)}</td></tr>`:''}
      ${vat?`<tr><td>${t('vat_amount')} ${vatPct}%</td><td style="text-align:right">${cash(vat)}</td></tr>`:''}
      <tr><td class="t">${t('summary')}</td><td style="text-align:right" class="t">${cash(payable)}</td></tr>
      <tr><td colspan="2" class="m">${t('summary')}: ${cash(sum)}</td></tr>
    </table>
    <script>onload=()=>print()<\/script></body></html>`);
}
function printPriceTags(){
  const list=state.products.filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase()));
  if(!list.length){toast(t('empty_title'));return}
  writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('price_tags')}</title>
    <style>@page{margin:8mm}body{font-family:Segoe UI,sans-serif;margin:0}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}
    .tag{border:1px solid #222;border-radius:8px;padding:10px;break-inside:avoid}
    .n{font-size:13px;font-weight:700;margin-bottom:6px}.p{font-size:22px;font-weight:800}.o{font-size:11px;color:#666}</style></head><body>
    <div class="grid">${list.map(p=>`<div class="tag"><div class="n">${esc(p.name)}</div>
      <div class="p">${cash(sellP(p))}</div>
      <div class="o">${unitLabel(p.unit)}${p.barcode?' · '+esc(p.barcode):''}${Number(p.promo_price)>0?' · promo':''}</div></div>`).join('')}</div>
    <script>onload=()=>print()<\/script></body></html>`);
}
function printReportPdf(){
  const s=stats();
  const vatPct=Number(state.user.vat_percent)||0;
  const vat=vatPct?Math.round(s.rev*vatPct/(100+vatPct)):0;
  writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('print_report')}</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:24px;max-width:720px;margin:auto}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:16px}
    td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}.r{text-align:right}</style></head><body>
    <h1>${esc(state.user.name)} — ${t('print_report')}</h1>
    <div>${period} · ${esc(state.today)}</div>
    <table>
      <tr><td>${t('sales')}</td><td class="r"><b>${cash(s.rev)}</b></td></tr>
      <tr><td>${t('cogs')}</td><td class="r">${cash(s.cost)}</td></tr>
      <tr><td>${t('profit')}</td><td class="r">${cash(s.profit)}</td></tr>
      <tr><td>${t('expenses')}</td><td class="r">${cash(s.expense)}</td></tr>
      <tr><td>${t('customer_debts')}</td><td class="r">${cash(s.debt)}</td></tr>
      ${vat?`<tr><td>${t('vat_amount')} ${vatPct}%</td><td class="r">${cash(vat)}</td></tr>`:''}
      <tr><td>${t('sold')}</td><td class="r">${s.qty}</td></tr>
    </table>
    <p style="color:#666;font-size:12px">${t('print_report')} → PDF</p>
    <script>onload=()=>print()<\/script></body></html>`);
}
function openRecon(){
  const list=state.customers||[];
  if(!list.length){toast(t('no_customers'));return}
  showModal(t('recon'),
    `<label class="wide">${t('customer')}<select name="customer" required>${list.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
     <label>${t('date')} <small>from</small><input name="from" type="date" value="${esc(state.today.slice(0,8)+'01')}" required></label>
     <label>${t('date')} <small>to</small><input name="to" type="date" value="${esc(state.today)}" required></label>`,
    async b=>{
      const cid=Number(b.customer);
      const c=list.find(x=>x.id===cid);
      const moves=(state.movements||[]).filter(m=>m.customer_id===cid&&m.date>=b.from&&m.date<=b.to&&(m.kind==='sale'||m.kind==='return'));
      const pays=(state.payments||[]).filter(p=>p.customer_id===cid&&p.date>=b.from&&p.date<=b.to);
      let bal=0;
      const rows=[];
      for(const m of [...moves].sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id)){
        const amt=m.kind==='return'?-(m.qty*m.price):(m.qty*m.price-(m.paid||0));
        bal+=amt;
        rows.push({date:m.date,txt:m.name||m.note,debit:amt>0?amt:0,credit:amt<0?-amt:0,bal});
      }
      for(const p of pays){bal-=p.amount;rows.push({date:p.date,txt:t('payment'),debit:0,credit:p.amount,bal})}
      rows.sort((a,b)=>a.date.localeCompare(b.date));
      writePrint(`<!doctype html><html><head><meta charset="utf-8"><title>${t('recon')}</title>
        <style>body{font-family:Segoe UI,sans-serif;padding:20px}h1{font-size:18px}table{width:100%;border-collapse:collapse;font-size:13px}
        th,td{border:1px solid #ccc;padding:6px}.r{text-align:right}</style></head><body>
        <h1>${t('recon_title')}</h1>
        <div>${esc(state.user.name)} ↔ ${esc(c.name)} · ${esc(b.from)} — ${esc(b.to)}</div>
        <table><thead><tr><th>${t('date')}</th><th>${t('what')}</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">${t('debt')}</th></tr></thead>
        <tbody>${rows.map(r=>`<tr><td>${r.date}</td><td>${esc(r.txt)}</td><td class="r">${r.debit?cash(r.debit):''}</td><td class="r">${r.credit?cash(r.credit):''}</td><td class="r">${cash(r.bal)}</td></tr>`).join('')||`<tr><td colspan="5">${t('no_data')}</td></tr>`}</tbody></table>
        <p><b>${t('debt')}: ${cash(c.debt||0)}</b></p>
        <script>onload=()=>print()<\/script></body></html>`);
      return {ok:true,_print:false};
    }
  );
}
function openTransfer(){
  if(!state.products.length){toast(t('add_products_first'));return}
  showModal(t('transfer'),
    `<label class="wide">${t('product')}<select name="product" required>${state.products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${p.stock}/${Number(p.stock2)||0}</option>`).join('')}</select></label>
     ${field(t('qty'),'qty','number','1',false,'required min="1" step="1"')}
     <label>${t('warehouse')}<select name="from"><option value="1">${esc(whName(1))}</option><option value="2">${esc(whName(2))}</option></select></label>
     <label>${t('warehouse')}<select name="to"><option value="2">${esc(whName(2))}</option><option value="1">${esc(whName(1))}</option></select></label>`,
    b=>api('stock/transfer',{product:b.product,qty:b.qty,from:b.from,to:b.to})
  );
}
function openStaff(){
  showModal(t('add_staff'),
    field(t('name'),'name','text','',true)
    +`<label class="wide">Email<input name="email" type="email" required></label>`
    +field(t('staff_pass'),'password','password','',true,'required minlength="8"')
    +`<label>${t('role')}<select name="role"><option value="cashier">${t('role_cashier')}</option><option value="admin">${t('role_admin')}</option></select></label>`
    +field(t('pin'),'pin','password','',true,'required inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8"')
    +`<p class="wide" style="margin:0;color:var(--muted);font-size:13px">${t('staff_pin_hint')}</p>`
    +(isCompany()?`<div class="wide"><b>${t('permissions')}</b>${permChecksHtml(['kassa','shift'])}</div>`:''),
    b=>{
      if(isCompany())b.permissions=readPermsFromBody(b);
      else b.permissions=b.role==='admin'?PERM_KEYS.filter(p=>!COMPANY_ONLY.has(p)):['kassa','shift'];
      return api('staff',b);
    }
  );
}
function editStaff(id){
  const st=(state.staff||[]).find(x=>x.id===id);if(!st){toast(t('not_found'));return}
  showModal(t('edit_staff'),
    field(t('name'),'name','text',st.name,true)
    +`<label>${t('role')}<select name="role"><option value="cashier" ${st.role==='cashier'?'selected':''}>${t('role_cashier')}</option><option value="admin" ${st.role==='admin'?'selected':''}>${t('role_admin')}</option></select></label>`
    +field(t('pin'),'pin','password','',!st.has_pin,'inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8"'+(st.has_pin?'':' required'))
    +`<p class="wide" style="margin:0;color:var(--muted);font-size:13px">${st.has_pin?t('staff_pin_change'):t('staff_pin_hint')}</p>`
    +(isCompany()?`<div class="wide"><b>${t('permissions')}</b>${permChecksHtml(st.permissions||[])}</div>`:''),
    b=>{
      b.id=id;
      if(isCompany())b.permissions=readPermsFromBody(b);
      else b.permissions=b.role==='admin'?PERM_KEYS.filter(p=>!COMPANY_ONLY.has(p)):['kassa','shift'];
      if(!b.pin)delete b.pin;
      return api('staff/update',b);
    }
  );
}
function openQuickBuy(){
  if(!state.products.length){toast(t('add_products_first'));return}
  const suppliers=state.suppliers||[];
  showModal(t('quick_buy'),
    `<label class="wide">${t('supplier')}<select name="supplier"><option value="">${t('select_none')}</option>
      ${suppliers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
     <div class="wide invent-list">${state.products.slice(0,40).map(p=>`
       <div class="invent-row">
         <div><b>${esc(p.name)}</b><div class="meta">${cash(p.cost)}</div></div>
         <label>${t('qty')}<input type="number" min="0" step="1" value="0" name="q_${p.id}"></label>
       </div>`).join('')}</div>
     <div class="wide paymodes">
       <label><input type="radio" name="pay" value="debt" checked> ${t('debt_mode')}</label>
       <label><input type="radio" name="pay" value="cash"> ${t('pay_cash_short')}</label>
     </div>
     ${dateField()}`,
    async b=>{
      const items=[];
      for(const p of state.products){
        const n=Number(b['q_'+p.id]||0);
        if(n>0)items.push({product:p.id,qty:n,cost:p.cost/100});
      }
      if(!items.length)throw Error(t('cart_empty'));
      return api('quick-receive',{items,supplier:b.supplier,pay:b.pay,date:b.date});
    }
  );
}
async function deleteStaff(id){
  if(!confirm(t('hide_q')))return;
  try{await api('staff/delete',{id});await load();toast(t('saved'))}catch(e){toast(e.message)}
}
async function sendTelegramBackup(){
  try{const r=await api('backup/telegram',{});toast(r.message||t('telegram_ok'))}catch(e){toast(e.message)}
}
async function startCamScan(){
  try{
    if(!('BarcodeDetector' in window)){
      toast(t('scan_cam')+' — Chrome/Edge');
      return;
    }
    const stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}
    });
    const det=new BarcodeDetector({formats:['ean_13','ean_8','code_128','code_39','qr_code','upc_a','upc_e']});
    const d=document.querySelector('#modal');
    d.innerHTML=`<h2>${t('scan_cam')}</h2>
      <video id="scanVid" style="width:100%;max-height:55vh;border-radius:12px;background:#000;object-fit:cover" autoplay playsinline muted></video>
      <p style="color:var(--muted);font-size:13px;margin:8px 0 0">${t('barcode_ph')}</p>
      <div class="dialogbuttons"><button type="button" class="outline" id="scanClose">${t('cancel')}</button></div>`;
    d.showModal();
    const v=document.querySelector('#scanVid');v.srcObject=stream;await v.play().catch(()=>{});
    let stop=false,last='',cool=0;
    const track=stream.getVideoTracks()[0];
    try{
      const caps=track.getCapabilities?.();
      if(caps?.torch)await track.applyConstraints({advanced:[{torch:true}]});
    }catch{}
    document.querySelector('#scanClose').onclick=()=>{stop=true;stream.getTracks().forEach(x=>x.stop());d.close()};
    const tick=async()=>{
      if(stop)return;
      try{
        if(v.readyState>=2){
          const codes=await det.detect(v);
          const val=codes[0]?.rawValue;
          if(val&&val!==last&&Date.now()>cool){
            last=val;cool=Date.now()+1200;
            const p=findByBarcode(val);
            if(p){addToCart(p.id);toast(p.name)}
            else toast(t('product_missing')+': '+val);
          }
        }
      }catch{}
      setTimeout(tick,180);
    };
    tick();
  }catch(e){toast(e.message||t('scan_cam'))}
}
function startVoiceSearch(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast(t('voice_search')+' — Chrome');return}
  const langs=lang==='en'?['en-US']:lang==='ru'?['ru-RU']:['tg-TJ','ru-RU','fa-IR'];
  let i=0;
  const run=()=>{
    const r=new SR();r.lang=langs[i];r.interimResults=false;r.maxAlternatives=3;
    r.onresult=e=>{
      const txt=e.results?.[0]?.[0]?.transcript||'';
      search=txt;render();
      toast(txt);
    };
    r.onerror=()=>{i++;if(i<langs.length)run();else toast(t('voice_search'))};
    try{r.start()}catch{toast(t('voice_search'))}
  };
  run();
}

async function archiveProduct(id){if(!confirm(t('hide_q')))return;try{await api('product/archive',{id});await load();toast(t('product_hidden'))}catch(e){toast(e.message)}}
async function archiveCustomer(id){if(!confirm(t('hide_q')))return;try{await api('customer/archive',{id});await load();toast(t('customer_hidden'))}catch(e){toast(e.message)}}
async function saveSettings(e){
  e.preventDefault();
  try{
    const fd=new FormData(e.target);
    const body=Object.fromEntries(fd);
    body.block_below_cost=fd.get('block_below_cost')?1:0;
    body.auto_backup=fd.get('auto_backup')?1:0;
    body.alert_low=fd.get('alert_low')?1:0;
    body.alert_expiry=fd.get('alert_expiry')?1:0;
    body.printer_enabled=fd.get('printer_enabled')?1:0;
    body.require_shift=fd.get('require_shift')?1:0;
    body.fiscal_enabled=fd.get('fiscal_enabled')?1:0;
    body.biz_mode=body.biz_mode==='company'?'company':'shop';
    // Keep company fields if not on the form (shop UI) or switching modes
    for(const k of ['company_legal','company_inn','company_phone','company_address','locked_until','fiscal_reg','fiscal_serial','hub_url','hub_token']){
      if(body[k]===undefined)body[k]=state.user[k]||'';
    }
    if(body.biz_mode!=='company')body.fiscal_enabled=Number(state.user.fiscal_enabled)||0;
    if(!body.pin)delete body.pin;
    if(!body.void_pin)delete body.void_pin;
    await api('settings',body);
    setDraftMode(body.biz_mode);
    load();
    toast(t('saved'));
  }catch(err){document.querySelector('#settingsError').textContent=err.message}
}
async function importProductsCsv(e){
  const file=e.target.files?.[0];if(!file)return;
  try{
    const csv=await file.text();
    const r=await api('products/import',{csv});
    await load();
    toast(t('imported_ok',{n:r.total||((r.created||0)+(r.updated||0))}));
  }catch(err){toast(err.message||t('err'))}
  e.target.value='';
}
async function logout(){await api('logout',{});needWelcome=true;cart={};auth()}
async function downloadBackup(){try{const r=await fetch(apiUrl('backup/export'),{credentials:'include'});if(!r.ok)throw Error((await r.json()).error);const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='savdo-backup-'+state.today+'.json';a.click();toast(t('json_ok'))}catch(e){toast(e.message)}}
async function downloadDbFile(){try{const r=await fetch(apiUrl('backup/file'),{credentials:'include'});if(!r.ok)throw Error((await r.json()).error);const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='savdo-'+state.today+'.sqlite';a.click();toast(t('sqlite_ok'))}catch(e){toast(e.message)}}
async function restoreBackup(e){
  const file=e.target.files?.[0];if(!file)return;
  if(!confirm(t('restore_q'))){e.target.value='';return}
  try{await api('backup/restore',{data:JSON.parse(await file.text())});await load();toast(t('restored'))}catch(err){toast(err.message||t('err'))}
  e.target.value='';
}
function exportCSV(type){
  let rows;
  if(type==='products'){
    rows=[[t('product'),t('category'),t('cost'),t('sell_price'),t('promo_price'),t('wholesale_price'),t('unit'),whName(1),whName(2),t('barcode'),t('expiry')],
      ...state.products.map(p=>[p.name,p.category,p.cost/100,p.price/100,(p.promo_price||0)/100,(p.wholesale_price||0)/100,p.unit||'pcs',p.stock,Number(p.stock2)||0,p.barcode||'',p.expiry||''])];
  }else{
    const s=stats();
    rows=[[t('date'),t('what'),t('customer'),t('supplier'),t('type'),t('qty'),t('amount'),t('payment'),'doc'],
      ...s.m.map(m=>[m.date,m.name||m.note,m.customer_name||'',m.supplier_name||'',m.kind,m.qty,(m.kind==='receipt'?m.cost*m.qty:m.qty*m.price)/100,m.pay_method||'',m.doc_no||''])];
  }
  const safe=v=>{let x=String(v);if(typeof v==='string'&&/^[=+@\-\t\r]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"'};
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(safe).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  a.download='savdo-'+type+'-'+state.today+'.csv';a.click();toast(t('excel_ok'));
}

document.querySelector('#modal').addEventListener('click',e=>{
  if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close()}
});
window.addEventListener('online',()=>{toast(t('net_back'));flushToHub()});
window.addEventListener('offline',()=>{toast(t('offline'));if(state){state._offline=true;render()}});
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();
  deferredInstall=e;
  if(state)render();
});
window.addEventListener('appinstalled',()=>{deferredInstall=null;hideInstall();toast(t('app_installed'))});
const isTunnel=/\.trycloudflare\.com$/i.test(location.hostname)||/\.loca\.lt$/i.test(location.hostname);
try{
  if('serviceWorker' in navigator && !isNativeShell()){
    if(isTunnel){
      navigator.serviceWorker.getRegistrations?.().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});
    }else{
      navigator.serviceWorker.register('/sw.js').catch(()=>{});
    }
  }
}catch{}
load();
