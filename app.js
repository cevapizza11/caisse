/* ================================================================
   COMPTAGE CAISSE — LA MARMITE BLEUE
   Fichier unique app.js — sections numérotées pour patchs ciblés
   ================================================================ */

/* ================================================================
   SECTION 1 — CONFIGURATION FIREBASE
   👉 Remplace les valeurs ci-dessous par celles de TON projet Firebase
   (Console Firebase > Paramètres du projet > Configuration SDK)
   ================================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyAcxFEGVmuzwnnsKVNY40oJG6PZfzTuCTE",
  authDomain: "caisse-marmite-bleue-6a67b.firebaseapp.com",
  projectId: "caisse-marmite-bleue-6a67b",
  storageBucket: "caisse-marmite-bleue-6a67b.firebasestorage.app",
  messagingSenderId: "33627481275",
  appId: "1:33627481275:web:38dbab3f2f61c5cadcb59e"
};

let db = null;
let firebaseReady = false;

try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  // Persistance hors-ligne : permet de continuer à utiliser l'app sans réseau
  db.enablePersistence({ synchronizeTabs: true }).catch(()=>{});
  firebaseReady = true;
} catch (e) {
  console.error("Erreur init Firebase :", e);
  firebaseReady = false;
}

const COLLECTION = "comptages";
const CAISSES_DOC = "config/caisses";
const EMPLOYES_DOC = "config/employes";

/* ================================================================
   SECTION 2 — DÉNOMINATIONS (billets / pièces EUR)
   ================================================================ */
const BILLETS = [500, 200, 100, 50, 20, 10, 5];
const PIECES  = [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

function formatMontant(n) {
  if (isNaN(n)) n = 0;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function formatMontantSigne(n) {
  if (isNaN(n)) n = 0;
  const s = n >= 0 ? "+" : "";
  return s + formatMontant(n);
}
function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function formatDateHeure(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }) +
    " à " + new Date(d).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ================================================================
   SECTION 3 — ÉTAT GLOBAL DE L'APPLICATION
   ================================================================ */
const State = {
  currentScreen: 'nouveau',
  caisses: ["Caisse 1", "Caisse 2", "Bar"],
  services: ["Service midi", "Service soir", "Journée complète"],
  employes: [],         // [{nom, pin}] chargés depuis Firestore
  employeActif: null,   // {nom} de la personne connectée sur cet appareil
  comptages: [],       // chargés depuis Firestore
  historyFilter: { caisse: 'toutes', periode: '30j' },
  draft: null,         // comptage en cours de saisie
  editingHistId: null,
  seuilEcartAlerte: 5  // € — au-delà, écart affiché en rouge
};

const SESSION_KEY = 'caisseMarmiteEmployeActif';

function nouveauDraft() {
  const denomQte = {};
  BILLETS.forEach(b => denomQte['b' + b] = 0);
  PIECES.forEach(p => denomQte['p' + p] = 0);
  return {
    id: null,
    date: new Date().toISOString().slice(0,10),
    heure: new Date().toTimeString().slice(0,5),
    caisse: State.caisses[0] || "Caisse 1",
    service: State.services[0] || "Service midi",
    type: "cloture",       // 'fond' (ouverture) ou 'cloture' (fermeture)
    employe: State.employeActif ? State.employeActif.nom : "",
    denomQte: denomQte,
    caTheorique: null,     // saisi manuellement, ou null si pas de rapprochement
    fondDeCaisse: 0,       // montant de départ en caisse, pour calcul écart sur clôture
    commentaire: "",
    createdAt: null
  };
}

/* ================================================================
   SECTION 4 — CALCULS
   ================================================================ */
function calculTotalDraft(draft) {
  let total = 0;
  BILLETS.forEach(b => total += (draft.denomQte['b'+b] || 0) * b);
  PIECES.forEach(p => total += (draft.denomQte['p'+p] || 0) * p);
  return Math.round(total * 100) / 100;
}

function calculEcart(draft) {
  if (draft.caTheorique === null || draft.caTheorique === undefined || draft.caTheorique === "") return null;
  const totalCompte = calculTotalDraft(draft);
  const especesAttendues = (parseFloat(draft.fondDeCaisse) || 0) + (parseFloat(draft.caTheorique) || 0);
  return Math.round((totalCompte - especesAttendues) * 100) / 100;
}

function statutEcart(ecart, seuil) {
  if (ecart === null) return null;
  const abs = Math.abs(ecart);
  if (abs < 0.5) return 'ok';
  if (abs <= seuil) return 'warn';
  return 'bad';
}

/* ================================================================
   SECTION 7 — NAVIGATION
   ================================================================ */
const Nav = {
  go(screen) {
    if (screen === 'nouveau' && State.currentScreen !== 'nouveau') {
      State.draft = nouveauDraft();
    }
    State.currentScreen = screen;
    State.editingHistId = null;
    this.updateActiveTab(screen);
    Render.screen();
    document.getElementById('screen').scrollTop = 0;
    window.scrollTo(0,0);
  },
  updateActiveTab(screen) {
    ['nouveau','historique','stats','reglages'].forEach(s => {
      const el = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (el) el.classList.toggle('active', s === screen);
    });
  }
};

/* ================================================================
   SECTION 7B — AUTHENTIFICATION PAR PIN EMPLOYÉ
   ================================================================ */
const Auth = {
  pinSaisi: "",

  restaurerSession() {
    try {
      const nom = localStorage.getItem(SESSION_KEY);
      if (nom && State.employes.find(e => e.nom === nom)) {
        State.employeActif = { nom };
        return true;
      }
    } catch (e) { /* localStorage indisponible, on ignore */ }
    return false;
  },

  ouvrirEcranConnexion() {
    this.pinSaisi = "";
    document.getElementById('screen').style.display = 'none';
    document.querySelector('.bottom-nav').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    this.renderLogin();
  },

  fermerEcranConnexion() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('screen').style.display = '';
    document.querySelector('.bottom-nav').style.display = '';
  },

  choisirEmploye(nom) {
    this.employeChoisi = nom;
    this.pinSaisi = "";
    this.renderLogin();
  },

  retourListe() {
    this.employeChoisi = null;
    this.pinSaisi = "";
    this.renderLogin();
  },

  saisirChiffre(c) {
    if (this.pinSaisi.length >= 4) return;
    this.pinSaisi += c;
    this.renderLogin();
    if (this.pinSaisi.length === 4) {
      setTimeout(() => this.verifierPin(), 150);
    }
  },

  effacerChiffre() {
    this.pinSaisi = this.pinSaisi.slice(0, -1);
    this.renderLogin();
  },

  verifierPin() {
    const emp = State.employes.find(e => e.nom === this.employeChoisi);
    if (emp && emp.pin === this.pinSaisi) {
      State.employeActif = { nom: emp.nom };
      try { localStorage.setItem(SESSION_KEY, emp.nom); } catch(e) {}
      this.employeChoisi = null;
      this.pinSaisi = "";
      this.fermerEcranConnexion();
      State.draft = nouveauDraft();
      Render.screen();
    } else {
      toast("Code incorrect", true);
      this.pinSaisi = "";
      this.renderLogin();
    }
  },

  changerUtilisateur() {
    State.employeActif = null;
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
    this.employeChoisi = null;
    this.ouvrirEcranConnexion();
  },

  renderLogin() {
    const el = document.getElementById('loginScreen');
    if (!el) return;

    if (State.employes.length === 0) {
      el.innerHTML = `
        <div class="login-box">
          <div class="login-logo">🦪</div>
          <h2 style="color:#fff; margin-bottom:6px;">Comptage Caisse</h2>
          <p style="color:#bcd6d4; font-size:13px; margin-bottom:20px;">
            Aucun employé n'est encore configuré.<br>Ajoute-en au moins un dans Réglages.
          </p>
          <button class="btn btn-primary" onclick="Auth.accesSansCompte()">Continuer sans code (réglages)</button>
        </div>`;
      return;
    }

    if (!this.employeChoisi) {
      const boutons = State.employes.map(e => `
        <button class="login-employe-btn" onclick="Auth.choisirEmploye('${e.nom.replace(/'/g,"\\'")}')">${e.nom}</button>
      `).join('');
      el.innerHTML = `
        <div class="login-box">
          <div class="login-logo">🦪</div>
          <h2 style="color:#fff; margin-bottom:18px;">Qui es-tu ?</h2>
          <div class="login-employe-list">${boutons}</div>
        </div>`;
      return;
    }

    const dots = [0,1,2,3].map(i => `<div class="pin-dot ${i < this.pinSaisi.length ? 'filled' : ''}"></div>`).join('');
    const pad = ['1','2','3','4','5','6','7','8','9','','0','⌫'].map(k => {
      if (k === '') return `<div></div>`;
      if (k === '⌫') return `<button class="pin-key pin-key-action" onclick="Auth.effacerChiffre()">⌫</button>`;
      return `<button class="pin-key" onclick="Auth.saisirChiffre('${k}')">${k}</button>`;
    }).join('');

    el.innerHTML = `
      <div class="login-box">
        <div class="login-logo">🦪</div>
        <h2 style="color:#fff; margin-bottom:4px;">${this.employeChoisi}</h2>
        <p style="color:#bcd6d4; font-size:13px; margin-bottom:18px;">Entre ton code à 4 chiffres</p>
        <div class="pin-dots">${dots}</div>
        <div class="pin-pad">${pad}</div>
        <button class="link-btn-light" onclick="Auth.retourListe()">← Changer de personne</button>
      </div>`;
  },

  accesSansCompte() {
    State.employeActif = { nom: "Non renseigné" };
    this.fermerEcranConnexion();
    State.draft = nouveauDraft();
    Render.screen();
  }
};

/* ================================================================
   SECTION 5 — TOAST (notifications courtes)
   ================================================================ */
let toastTimer = null;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isErr ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

/* ================================================================
   SECTION 6 — SYNC FIRESTORE
   ================================================================ */
const Sync = {
  setStatus(state) {
    // state: 'ok' | 'busy' | 'off'
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    if (!dot || !txt) return;
    dot.className = 'sync-dot ' + (state === 'ok' ? '' : state);
    txt.textContent = state === 'ok' ? 'synchronisé' : state === 'busy' ? 'sync...' : 'hors ligne';
  },

  async chargerComptages() {
    if (!firebaseReady) { this.setStatus('off'); return; }
    this.setStatus('busy');
    try {
      const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(500).get();
      State.comptages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.setStatus('ok');
    } catch (e) {
      console.error("Erreur chargement comptages :", e);
      this.setStatus('off');
      toast("Impossible de charger l'historique (vérifie ta connexion)", true);
    }
  },

  async sauvegarderComptage(draft) {
    if (!firebaseReady) { toast("Pas de connexion Firebase — comptage non sauvegardé", true); return false; }
    this.setStatus('busy');
    try {
      const total = calculTotalDraft(draft);
      const ecart = calculEcart(draft);
      const payload = {
        date: draft.date,
        heure: draft.heure,
        caisse: draft.caisse,
        service: draft.service,
        type: draft.type,
        employe: draft.employe || "Non renseigné",
        denomQte: draft.denomQte,
        caTheorique: draft.caTheorique === "" ? null : draft.caTheorique,
        fondDeCaisse: parseFloat(draft.fondDeCaisse) || 0,
        commentaire: draft.commentaire || "",
        total: total,
        ecart: ecart,
        createdAt: draft.createdAt || Date.now()
      };
      if (draft.id) {
        await db.collection(COLLECTION).doc(draft.id).set(payload, { merge: true });
      } else {
        await db.collection(COLLECTION).add(payload);
      }
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur sauvegarde :", e);
      this.setStatus('off');
      toast("Erreur lors de la sauvegarde", true);
      return false;
    }
  },

  async supprimerComptage(id) {
    if (!firebaseReady) return false;
    this.setStatus('busy');
    try {
      await db.collection(COLLECTION).doc(id).delete();
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur suppression :", e);
      this.setStatus('off');
      toast("Erreur lors de la suppression", true);
      return false;
    }
  },

  async chargerConfig() {
    if (!firebaseReady) return;
    try {
      const doc = await db.doc(CAISSES_DOC).get();
      if (doc.exists) {
        const data = doc.data();
        if (data.caisses && data.caisses.length) State.caisses = data.caisses;
        if (data.services && data.services.length) State.services = data.services;
        if (data.seuilEcartAlerte !== undefined) State.seuilEcartAlerte = data.seuilEcartAlerte;
      }
    } catch (e) {
      console.error("Erreur chargement config :", e);
    }
  },

  async chargerEmployes() {
    if (!firebaseReady) return;
    try {
      const doc = await db.doc(EMPLOYES_DOC).get();
      if (doc.exists) {
        const data = doc.data();
        if (data.liste && data.liste.length) State.employes = data.liste;
      }
    } catch (e) {
      console.error("Erreur chargement employés :", e);
    }
  },

  async sauvegarderEmployes() {
    if (!firebaseReady) { toast("Pas de connexion — employés non sauvegardés", true); return; }
    try {
      await db.doc(EMPLOYES_DOC).set({ liste: State.employes });
    } catch (e) {
      console.error("Erreur sauvegarde employés :", e);
      toast("Erreur lors de l'enregistrement", true);
    }
  },

  async sauvegarderConfig() {
    if (!firebaseReady) { toast("Pas de connexion — réglages non sauvegardés", true); return; }
    try {
      await db.doc(CAISSES_DOC).set({
        caisses: State.caisses,
        services: State.services,
        seuilEcartAlerte: State.seuilEcartAlerte
      });
      toast("Réglages enregistrés");
    } catch (e) {
      console.error("Erreur sauvegarde config :", e);
      toast("Erreur lors de l'enregistrement", true);
    }
  }
};

/* ================================================================
   SECTION 8 — RENDU : ÉCRAN "NOUVEAU COMPTAGE"
   ================================================================ */
function renderDenomRow(denom, prefix, isPiece) {
  const key = prefix + denom;
  const qte = State.draft.denomQte[key] || 0;
  const total = Math.round(qte * denom * 100) / 100;
  const labelTxt = isPiece
    ? (denom >= 1 ? denom + ' €' : (denom*100).toFixed(0) + ' cts')
    : denom + ' €';
  return `
    <div class="denom-row">
      <div class="denom-label">${labelTxt}</div>
      <div class="denom-qty">
        <div class="stepper">
          <button onclick="Draft.stepDenom('${key}', -1)" aria-label="Diminuer">−</button>
          <input type="number" inputmode="numeric" min="0" value="${qte}"
                 onchange="Draft.setDenom('${key}', this.value)"
                 onfocus="this.select()">
          <button onclick="Draft.stepDenom('${key}', 1)" aria-label="Augmenter">+</button>
        </div>
      </div>
      <div class="denom-eq">×</div>
      <div class="denom-total">${formatMontant(total)}</div>
    </div>`;
}

function renderEcranNouveau() {
  const d = State.draft;
  const total = calculTotalDraft(d);
  const ecart = calculEcart(d);
  const statut = statutEcart(ecart, State.seuilEcartAlerte);

  const optionsCaisses = State.caisses.map(c => `<option value="${c}" ${c===d.caisse?'selected':''}>${c}</option>`).join('');
  const optionsServices = State.services.map(s => `<option value="${s}" ${s===d.service?'selected':''}>${s}</option>`).join('');

  return `
    <div class="card">
      <div class="card-title">Informations</div>
      <div class="field-row">
        <div>
          <label>Date</label>
          <input type="text" value="${formatDate(d.date)}" readonly onclick="Draft.openDatePicker()" style="background:#fafaf7;">
        </div>
        <div>
          <label>Heure</label>
          <input type="text" value="${d.heure}" readonly style="background:#fafaf7;">
        </div>
      </div>
      <label>Type de comptage</label>
      <div class="grid-2" style="margin-bottom:14px;">
        <button class="btn ${d.type==='fond'?'btn-primary':'btn-secondary'}" onclick="Draft.setType('fond')">🌅 Ouverture (fond)</button>
        <button class="btn ${d.type==='cloture'?'btn-primary':'btn-secondary'}" onclick="Draft.setType('cloture')">🌙 Clôture</button>
      </div>
      <div class="field-row">
        <div>
          <label>Caisse / poste</label>
          <select onchange="Draft.setField('caisse', this.value)">${optionsCaisses}</select>
        </div>
        <div>
          <label>Service</label>
          <select onchange="Draft.setField('service', this.value)">${optionsServices}</select>
        </div>
      </div>
    </div>

    ${d.type === 'cloture' ? `
    <div class="card">
      <div class="card-title">Rapprochement (optionnel)</div>
      <label>Fond de caisse de départ (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.fondDeCaisse || ''}"
             placeholder="0,00"
             onchange="Draft.setField('fondDeCaisse', this.value)">
      <label>CA théorique (relevé Z / TPE) (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.caTheorique === null ? '' : d.caTheorique}"
             placeholder="Laisser vide si pas de rapprochement"
             onchange="Draft.setField('caTheorique', this.value)">
      <div class="helper-text">Écart = Total compté − (Fond de caisse + CA théorique)</div>
    </div>` : ''}

    <div class="card">
      <div class="card-title">
        <span>Billets</span>
      </div>
      <div class="denom-section-label">Billets</div>
      ${BILLETS.map(b => renderDenomRow(b, 'b', false)).join('')}
      <div class="denom-section-label">Pièces</div>
      ${PIECES.map(p => renderDenomRow(p, 'p', true)).join('')}
    </div>

    <div class="total-banner">
      <span class="lbl">Total compté</span>
      <span class="val">${formatMontant(total)}</span>
    </div>

    ${ecart !== null ? `
    <div class="ecart-box ${statut}">
      <span class="lbl">${statut==='ok' ? '✓ Caisse juste' : statut==='warn' ? '⚠ Petit écart' : '⚠ Écart important'}</span>
      <span class="val">${formatMontantSigne(ecart)}</span>
    </div>` : ''}

    <div class="card">
      <label>Commentaire (optionnel)</label>
      <textarea placeholder="Ex : billet déchiré mis de côté, erreur de rendu monnaie..." onchange="Draft.setField('commentaire', this.value)">${d.commentaire || ''}</textarea>
    </div>

    <button class="btn btn-primary" onclick="Draft.enregistrer()">💾 Enregistrer le comptage</button>
    <div class="section-gap"></div>
  `;
}

/* ================================================================
   SECTION 9 — MODULE DRAFT (interactions écran de saisie)
   ================================================================ */
const Draft = {
  setField(field, value) {
    if (field === 'caTheorique') {
      State.draft.caTheorique = value === '' ? null : parseFloat(value);
    } else if (field === 'fondDeCaisse') {
      State.draft.fondDeCaisse = parseFloat(value) || 0;
    } else {
      State.draft[field] = value;
    }
    Render.screen();
  },

  setType(type) {
    State.draft.type = type;
    Render.screen();
  },

  setDenom(key, value) {
    let v = parseInt(value, 10);
    if (isNaN(v) || v < 0) v = 0;
    State.draft.denomQte[key] = v;
    Render.screen();
  },

  stepDenom(key, delta) {
    const cur = State.draft.denomQte[key] || 0;
    State.draft.denomQte[key] = Math.max(0, cur + delta);
    Render.screen();
  },

  openDatePicker() {
    // Simple prompt-based picker pour rester léger (pas de lib externe)
    const cur = State.draft.date;
    const input = document.createElement('input');
    input.type = 'date';
    input.value = cur;
    input.style.position = 'fixed';
    input.style.top = '-100px';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      State.draft.date = input.value;
      Render.screen();
      document.body.removeChild(input);
    });
    input.click();
    input.showPicker ? input.showPicker() : input.focus();
  },

  async enregistrer() {
    const d = State.draft;
    const total = calculTotalDraft(d);
    if (total === 0) {
      toast("Le total est à 0 € — vérifie ta saisie avant d'enregistrer", true);
      return;
    }
    const ok = await Sync.sauvegarderComptage(d);
    if (ok) {
      toast(d.id ? "Comptage modifié" : "Comptage enregistré ✓");
      await Sync.chargerComptages();
      State.draft = nouveauDraft();
      Nav.go('historique');
    }
  }
};

/* ================================================================
   SECTION 10 — RENDU : ÉCRAN "HISTORIQUE"
   ================================================================ */
function comptagesFiltres() {
  let list = [...State.comptages];
  if (State.historyFilter.caisse !== 'toutes') {
    list = list.filter(c => c.caisse === State.historyFilter.caisse);
  }
  const periode = State.historyFilter.periode;
  if (periode !== 'tout') {
    const now = Date.now();
    const jours = periode === '7j' ? 7 : periode === '30j' ? 30 : 90;
    const seuil = now - jours * 24 * 3600 * 1000;
    list = list.filter(c => (c.createdAt || 0) >= seuil);
  }
  return list;
}

function renderEcranHistorique() {
  const list = comptagesFiltres();
  const chipsCaisses = ['toutes', ...State.caisses];

  const chipsHtml = chipsCaisses.map(c => `
    <button class="filter-chip ${State.historyFilter.caisse===c?'active':''}" onclick="Hist.setFiltreCaisse('${c}')">
      ${c === 'toutes' ? 'Toutes les caisses' : c}
    </button>`).join('');

  const chipsPeriode = [['7j','7 jours'],['30j','30 jours'],['90j','3 mois'],['tout','Tout']].map(([k,l]) => `
    <button class="filter-chip ${State.historyFilter.periode===k?'active':''}" onclick="Hist.setFiltrePeriode('${k}')">${l}</button>
  `).join('');

  if (list.length === 0) {
    return `
      <div class="filter-bar">${chipsHtml}</div>
      <div class="filter-bar">${chipsPeriode}</div>
      <div class="empty-state">
        <div class="ic">🗒️</div>
        <p><strong>Aucun comptage trouvé</strong></p>
        <p>Modifie les filtres ou crée un nouveau comptage.</p>
      </div>`;
  }

  const items = list.map(c => {
    const statut = statutEcart(c.ecart, State.seuilEcartAlerte);
    const badge = c.ecart !== null && c.ecart !== undefined
      ? `<span class="hist-badge ${statut}">${formatMontantSigne(c.ecart)}</span>`
      : '';
    return `
      <div class="hist-item" onclick="Hist.ouvrirDetail('${c.id}')">
        <div class="hist-main">
          <div class="hist-titre">${c.caisse} · ${c.type === 'fond' ? 'Ouverture' : 'Clôture'}</div>
          <div class="hist-meta">${formatDate(c.date)} à ${c.heure} · ${c.service}${c.employe ? ' · ' + c.employe : ''}</div>
        </div>
        <div class="hist-right">
          <div class="hist-montant">${formatMontant(c.total)}</div>
          ${badge}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="filter-bar">${chipsHtml}</div>
    <div class="filter-bar">${chipsPeriode}</div>
    <button class="btn btn-secondary" style="margin-bottom:14px;" onclick="Export.exporterExcel()">📊 Exporter en Excel (${list.length} comptage${list.length>1?'s':''})</button>
    ${items}
  `;
}

const Hist = {
  setFiltreCaisse(c) { State.historyFilter.caisse = c; Render.screen(); },
  setFiltrePeriode(p) { State.historyFilter.periode = p; Render.screen(); },

  ouvrirDetail(id) {
    State.editingHistId = id;
    Render.screen();
  },

  fermerDetail() {
    State.editingHistId = null;
    Render.screen();
  },

  chargerPourEditionParId(id) {
    const c = State.comptages.find(x => x.id === id);
    if (!c) { toast("Comptage introuvable", true); return; }
    this.chargerPourEdition(c);
  },

  chargerPourEdition(c) {
    State.draft = {
      id: c.id,
      date: c.date,
      heure: c.heure,
      caisse: c.caisse,
      service: c.service,
      type: c.type,
      employe: c.employe || (State.employeActif ? State.employeActif.nom : ""),
      denomQte: c.denomQte ? { ...c.denomQte } : nouveauDraft().denomQte,
      caTheorique: c.caTheorique,
      fondDeCaisse: c.fondDeCaisse || 0,
      commentaire: c.commentaire || "",
      createdAt: c.createdAt
    };
    Nav.go('nouveau');
  },

  async supprimer(id) {
    if (!confirm("Supprimer définitivement ce comptage ?")) return;
    const ok = await Sync.supprimerComptage(id);
    if (ok) {
      toast("Comptage supprimé");
      await Sync.chargerComptages();
      State.editingHistId = null;
      Render.screen();
    }
  }
};

function renderDetailModal() {
  const c = State.comptages.find(x => x.id === State.editingHistId);
  if (!c) return '';
  const denomQte = c.denomQte || {};
  const statut = statutEcart(c.ecart, State.seuilEcartAlerte);

  const lignesBillets = BILLETS.filter(b => (denomQte['b'+b]||0) > 0).map(b => {
    const q = denomQte['b'+b];
    return `<div class="denom-row" style="padding:5px 0;"><div class="denom-label">${b} €</div><div style="flex:1;color:var(--ink-soft);">${q} ×</div><div class="denom-total">${formatMontant(q*b)}</div></div>`;
  }).join('');
  const lignesPieces = PIECES.filter(p => (denomQte['p'+p]||0) > 0).map(p => {
    const q = denomQte['p'+p];
    const lbl = p >= 1 ? p + ' €' : (p*100).toFixed(0) + ' cts';
    return `<div class="denom-row" style="padding:5px 0;"><div class="denom-label">${lbl}</div><div style="flex:1;color:var(--ink-soft);">${q} ×</div><div class="denom-total">${formatMontant(q*p)}</div></div>`;
  }).join('');

  return `
  <div class="modal-overlay" onclick="if(event.target===this) Hist.fermerDetail()">
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-title">${c.caisse} — ${c.type === 'fond' ? 'Ouverture' : 'Clôture'}</div>
      <div class="hist-meta" style="margin-bottom:14px;">${formatDateHeure(c.createdAt || Date.now())} · ${c.service}${c.employe ? ' · compté par ' + c.employe : ''}</div>

      ${lignesBillets ? `<div class="denom-section-label">Billets</div>${lignesBillets}` : ''}
      ${lignesPieces ? `<div class="denom-section-label">Pièces</div>${lignesPieces}` : ''}

      <div class="total-banner" style="margin-top:14px;">
        <span class="lbl">Total compté</span>
        <span class="val">${formatMontant(c.total)}</span>
      </div>

      ${c.ecart !== null && c.ecart !== undefined ? `
      <div class="ecart-box ${statut}">
        <span class="lbl">Écart (fond ${formatMontant(c.fondDeCaisse||0)} + CA théo. ${formatMontant(c.caTheorique||0)})</span>
        <span class="val">${formatMontantSigne(c.ecart)}</span>
      </div>` : ''}

      ${c.commentaire ? `<div class="card" style="margin-top:14px;"><label>Commentaire</label><div>${c.commentaire}</div></div>` : ''}

      <button class="btn btn-primary" style="margin-top:14px;" onclick="Export.exporterPdf('${c.id}')">🧾 Générer l'état de caisse (PDF)</button>

      <div class="btn-full-row" style="margin-top:10px;">
        <button class="btn btn-secondary" onclick="Hist.chargerPourEditionParId('${c.id}')">✏️ Modifier</button>
        <button class="btn btn-danger" onclick="Hist.supprimer('${c.id}')">🗑️ Supprimer</button>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px;" onclick="Hist.fermerDetail()">Fermer</button>
    </div>
  </div>`;
}

/* ================================================================
   SECTION 11 — RENDU : ÉCRAN "STATS"
   ================================================================ */
function renderEcranStats() {
  const list = State.comptages.filter(c => c.type === 'cloture' && c.ecart !== null && c.ecart !== undefined);

  if (list.length === 0) {
    return `
      <div class="empty-state">
        <div class="ic">📊</div>
        <p><strong>Pas encore de données</strong></p>
        <p>Les statistiques d'écart apparaîtront ici dès qu'un comptage de clôture avec rapprochement aura été enregistré.</p>
      </div>`;
  }

  const totalEcarts = list.reduce((s,c) => s + c.ecart, 0);
  const moyenne = totalEcarts / list.length;
  const nbOk = list.filter(c => statutEcart(c.ecart, State.seuilEcartAlerte) === 'ok').length;
  const nbWarn = list.filter(c => statutEcart(c.ecart, State.seuilEcartAlerte) === 'warn').length;
  const nbBad = list.filter(c => statutEcart(c.ecart, State.seuilEcartAlerte) === 'bad').length;

  // Stats par caisse
  const parCaisse = {};
  list.forEach(c => {
    if (!parCaisse[c.caisse]) parCaisse[c.caisse] = { sum: 0, count: 0 };
    parCaisse[c.caisse].sum += c.ecart;
    parCaisse[c.caisse].count += 1;
  });

  const lignesCaisses = Object.entries(parCaisse).map(([nom, v]) => {
    const moy = v.sum / v.count;
    const st = statutEcart(moy, State.seuilEcartAlerte);
    return `
      <div class="hist-item" style="cursor:default;">
        <div class="hist-main">
          <div class="hist-titre">${nom}</div>
          <div class="hist-meta">${v.count} clôture(s) avec rapprochement</div>
        </div>
        <div class="hist-right">
          <div class="hist-montant" style="color:var(--${st==='ok'?'ecart-ok':st==='warn'?'ecart-warn':'ecart-bad'});">${formatMontantSigne(moy)}</div>
          <div class="hist-meta">écart moyen</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Vue d'ensemble — ${list.length} clôture(s)</div>
      <div class="grid-2">
        <div>
          <div class="helper-text" style="margin-bottom:2px;">Écart moyen</div>
          <div style="font-family:'Cormorant',serif; font-size:24px; font-weight:700; color:${Math.abs(moyenne)<0.5?'var(--ecart-ok)':'var(--ecart-bad)'};">${formatMontantSigne(moyenne)}</div>
        </div>
        <div>
          <div class="helper-text" style="margin-bottom:2px;">Cumul des écarts</div>
          <div style="font-family:'Cormorant',serif; font-size:24px; font-weight:700;">${formatMontantSigne(totalEcarts)}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Répartition</div>
      <div style="display:flex; gap:10px;">
        <div style="flex:1; text-align:center; padding:10px; background:#eef6ef; border-radius:10px;">
          <div style="font-size:22px; font-weight:700; color:var(--ecart-ok);">${nbOk}</div>
          <div style="font-size:11px; color:var(--ink-soft);">justes</div>
        </div>
        <div style="flex:1; text-align:center; padding:10px; background:#fbf3e1; border-radius:10px;">
          <div style="font-size:22px; font-weight:700; color:var(--ecart-warn);">${nbWarn}</div>
          <div style="font-size:11px; color:var(--ink-soft);">petits écarts</div>
        </div>
        <div style="flex:1; text-align:center; padding:10px; background:#fbece9; border-radius:10px;">
          <div style="font-size:22px; font-weight:700; color:var(--ecart-bad);">${nbBad}</div>
          <div style="font-size:11px; color:var(--ink-soft);">écarts importants</div>
        </div>
      </div>
    </div>

    <div class="divider-text">Par caisse</div>
    ${lignesCaisses}
  `;
}

/* ================================================================
   SECTION 12 — RENDU : ÉCRAN "RÉGLAGES"
   ================================================================ */
function renderListeEditable(liste, type) {
  return liste.map((item, i) => `
    <div class="denom-row" style="padding:6px 0;">
      <input type="text" value="${item}" style="margin-bottom:0;" onchange="Reglages.modifierItem('${type}', ${i}, this.value)">
      <button class="btn-icon" style="background:var(--ivoire-dark); color:var(--ecart-bad); margin-left:8px;" onclick="Reglages.supprimerItem('${type}', ${i})">✕</button>
    </div>
  `).join('');
}

function renderListeEmployes() {
  if (State.employes.length === 0) {
    return `<div class="helper-text" style="margin-bottom:10px;">Aucun employé configuré — l'app sera accessible sans code.</div>`;
  }
  return State.employes.map((e, i) => `
    <div class="denom-row" style="padding:6px 0;">
      <input type="text" value="${e.nom}" placeholder="Nom" style="margin-bottom:0; flex:2;" onchange="Reglages.modifierEmploye(${i}, 'nom', this.value)">
      <input type="text" inputmode="numeric" maxlength="4" value="${e.pin}" placeholder="PIN" style="margin-bottom:0; flex:1; text-align:center;" onchange="Reglages.modifierEmploye(${i}, 'pin', this.value)">
      <button class="btn-icon" style="background:var(--ivoire-dark); color:var(--ecart-bad); margin-left:8px;" onclick="Reglages.supprimerEmploye(${i})">✕</button>
    </div>
  `).join('');
}

function renderEcranReglages() {
  return `
    <div class="card">
      <div class="card-title">Session</div>
      <div class="helper-text" style="margin-bottom:10px;">Connecté en tant que <strong>${State.employeActif ? State.employeActif.nom : 'inconnu'}</strong></div>
      <button class="btn btn-ghost" onclick="Auth.changerUtilisateur()">🔄 Changer d'utilisateur</button>
    </div>

    <div class="card">
      <div class="card-title">Employés &amp; codes PIN</div>
      ${renderListeEmployes()}
      <button class="btn btn-secondary" style="margin-top:8px;" onclick="Reglages.ajouterEmploye()">➕ Ajouter un employé</button>
      <div class="helper-text" style="margin-top:8px; margin-bottom:0;">Le code PIN doit faire 4 chiffres. Chaque comptage enregistré est associé à l'employé connecté.</div>
    </div>

    <div class="card">
      <div class="card-title">Caisses / postes</div>
      ${renderListeEditable(State.caisses, 'caisses')}
      <button class="btn btn-secondary" style="margin-top:8px;" onclick="Reglages.ajouterItem('caisses')">➕ Ajouter une caisse</button>
    </div>

    <div class="card">
      <div class="card-title">Services</div>
      ${renderListeEditable(State.services, 'services')}
      <button class="btn btn-secondary" style="margin-top:8px;" onclick="Reglages.ajouterItem('services')">➕ Ajouter un service</button>
    </div>

    <div class="card">
      <div class="card-title">Seuil d'alerte écart</div>
      <label>Au-delà de ce montant, l'écart est affiché en rouge (€)</label>
      <input type="number" inputmode="decimal" step="0.5" min="0" value="${State.seuilEcartAlerte}"
             onchange="Reglages.setSeuil(this.value)">
      <div class="helper-text">En dessous de 0,50 € l'écart est toujours considéré comme "juste" (arrondis de caisse).</div>
    </div>

    <button class="btn btn-primary" onclick="Reglages.enregistrer()">💾 Enregistrer les réglages</button>

    <div class="divider-text">À propos</div>
    <div class="card" style="text-align:center;">
      <div style="font-size:13px; color:var(--ink-soft); line-height:1.6;">
        Comptage Caisse — La Marmite Bleue<br>
        Données synchronisées via Firebase<br>
        <span id="versionTag">v1.0</span>
      </div>
    </div>
  `;
}

const Reglages = {
  ajouterItem(type) {
    const nom = prompt(type === 'caisses' ? "Nom de la nouvelle caisse :" : "Nom du nouveau service :");
    if (!nom || !nom.trim()) return;
    State[type].push(nom.trim());
    Render.screen();
  },
  modifierItem(type, index, value) {
    if (!value.trim()) { toast("Le nom ne peut pas être vide", true); Render.screen(); return; }
    State[type][index] = value.trim();
    Render.screen();
  },
  supprimerItem(type, index) {
    if (State[type].length <= 1) { toast("Il doit rester au moins un élément", true); return; }
    if (!confirm("Supprimer cet élément ?")) return;
    State[type].splice(index, 1);
    Render.screen();
  },
  setSeuil(value) {
    const v = parseFloat(value);
    State.seuilEcartAlerte = isNaN(v) ? 5 : Math.max(0, v);
  },

  ajouterEmploye() {
    const nom = prompt("Prénom de l'employé :");
    if (!nom || !nom.trim()) return;
    if (State.employes.find(e => e.nom.toLowerCase() === nom.trim().toLowerCase())) {
      toast("Ce nom existe déjà", true);
      return;
    }
    let pin = prompt("Code PIN à 4 chiffres :");
    if (!pin || !/^\d{4}$/.test(pin)) {
      toast("Le PIN doit être composé de 4 chiffres", true);
      return;
    }
    State.employes.push({ nom: nom.trim(), pin: pin });
    Render.screen();
  },

  modifierEmploye(index, champ, value) {
    if (champ === 'nom') {
      if (!value.trim()) { toast("Le nom ne peut pas être vide", true); Render.screen(); return; }
      State.employes[index].nom = value.trim();
    } else if (champ === 'pin') {
      if (!/^\d{4}$/.test(value)) {
        toast("Le PIN doit être composé de 4 chiffres", true);
        Render.screen();
        return;
      }
      State.employes[index].pin = value;
    }
    Render.screen();
  },

  supprimerEmploye(index) {
    if (!confirm("Supprimer cet employé ?")) return;
    State.employes.splice(index, 1);
    Render.screen();
  },

  async enregistrer() {
    await Sync.sauvegarderConfig();
    await Sync.sauvegarderEmployes();
    Render.screen();
  }
};

/* ================================================================
   SECTION 12B — EXPORT EXCEL & PDF
   ================================================================ */
const Export = {
  exporterExcel() {
    const list = comptagesFiltres();
    if (list.length === 0) { toast("Rien à exporter pour ces filtres", true); return; }
    if (typeof XLSX === 'undefined') { toast("Module Excel indisponible (vérifie ta connexion)", true); return; }

    const rows = list.map(c => ({
      "Date": formatDate(c.date),
      "Heure": c.heure || "",
      "Caisse": c.caisse,
      "Type": c.type === 'fond' ? 'Ouverture' : 'Clôture',
      "Service": c.service,
      "Compté par": c.employe || "",
      "Fond de caisse (€)": c.fondDeCaisse || 0,
      "CA théorique (€)": c.caTheorique === null || c.caTheorique === undefined ? "" : c.caTheorique,
      "Total compté (€)": c.total,
      "Écart (€)": c.ecart === null || c.ecart === undefined ? "" : c.ecart,
      "Commentaire": c.commentaire || ""
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      {wch:11},{wch:7},{wch:14},{wch:10},{wch:16},{wch:16},
      {wch:16},{wch:15},{wch:15},{wch:10},{wch:30}
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comptages");

    const dateStr = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `comptages-marmite-bleue-${dateStr}.xlsx`);
    toast("Export Excel généré");
  },

  exporterPdf(id) {
    const c = State.comptages.find(x => x.id === id);
    if (!c) { toast("Comptage introuvable", true); return; }
    const denomQte = c.denomQte || {};
    const statut = statutEcart(c.ecart, State.seuilEcartAlerte);

    const ligneDenom = (label, q, montant) => `
      <tr>
        <td>${label}</td>
        <td style="text-align:center;">${q}</td>
        <td style="text-align:right;">${formatMontant(montant)}</td>
      </tr>`;

    const lignesBillets = BILLETS.filter(b => (denomQte['b'+b]||0) > 0)
      .map(b => ligneDenom(b + ' €', denomQte['b'+b], denomQte['b'+b]*b)).join('');
    const lignesPieces = PIECES.filter(p => (denomQte['p'+p]||0) > 0)
      .map(p => ligneDenom(p >= 1 ? p+' €' : (p*100).toFixed(0)+' cts', denomQte['p'+p], denomQte['p'+p]*p)).join('');

    const ecartHtml = (c.ecart !== null && c.ecart !== undefined) ? `
      <table class="pdf-table" style="margin-top:14px;">
        <tr><td>Fond de caisse de départ</td><td style="text-align:right;">${formatMontant(c.fondDeCaisse||0)}</td></tr>
        <tr><td>CA théorique (relevé)</td><td style="text-align:right;">${formatMontant(c.caTheorique||0)}</td></tr>
        <tr style="font-weight:700;"><td>Total attendu</td><td style="text-align:right;">${formatMontant((c.fondDeCaisse||0)+(c.caTheorique||0))}</td></tr>
        <tr style="font-weight:700; color:${statut==='ok'?'#2d7d4f':statut==='warn'?'#c19a2e':'#b6402f'};">
          <td>ÉCART</td><td style="text-align:right;">${formatMontantSigne(c.ecart)}</td>
        </tr>
      </table>` : '';

    const commentaireHtml = c.commentaire ? `
      <div style="margin-top:16px; padding:12px; background:#f7f2ea; border-radius:8px; font-size:13px;">
        <strong>Commentaire :</strong> ${c.commentaire}
      </div>` : '';

    const win = window.open('', '_blank');
    win.document.write(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
      <meta charset="UTF-8">
      <title>État de caisse — ${c.caisse} — ${formatDate(c.date)}</title>
      <style>
        body{font-family:Georgia,'Times New Roman',serif; color:#2A2521; padding:40px; max-width:600px; margin:0 auto;}
        h1{font-size:22px; margin-bottom:2px; color:#163f3e;}
        .sub{color:#6b6258; font-size:13px; margin-bottom:24px;}
        table.pdf-table{width:100%; border-collapse:collapse; margin-bottom:8px;}
        table.pdf-table td{padding:6px 4px; border-bottom:1px solid #e2d9c8; font-size:13.5px;}
        .section-title{font-size:12px; text-transform:uppercase; letter-spacing:.6px; font-weight:700; color:#1F5C5A; margin:18px 0 6px; border-bottom:2px solid #1F5C5A; padding-bottom:4px;}
        .total-row{display:flex; justify-content:space-between; padding:12px 0; border-top:2px solid #163f3e; border-bottom:2px solid #163f3e; font-weight:700; font-size:17px; margin-top:10px;}
        .meta{display:flex; justify-content:space-between; font-size:12.5px; color:#6b6258; margin-top:30px; border-top:1px solid #e2d9c8; padding-top:10px;}
        @media print{ body{padding:15mm;} }
      </style>
      </head>
      <body>
        <h1>🦪 La Marmite Bleue — État de caisse</h1>
        <div class="sub">${c.caisse} · ${c.type === 'fond' ? 'Ouverture' : 'Clôture'} · ${formatDateHeure(c.createdAt || Date.now())} · ${c.service}${c.employe ? ' · Compté par ' + c.employe : ''}</div>

        ${lignesBillets ? `<div class="section-title">Billets</div><table class="pdf-table">${lignesBillets}</table>` : ''}
        ${lignesPieces ? `<div class="section-title">Pièces</div><table class="pdf-table">${lignesPieces}</table>` : ''}

        <div class="total-row"><span>TOTAL COMPTÉ</span><span>${formatMontant(c.total)}</span></div>

        ${ecartHtml}
        ${commentaireHtml}

        <div class="meta">
          <span>Document généré le ${formatDateHeure(Date.now())}</span>
          <span>La Marmite Bleue</span>
        </div>

        <script>window.onload = function(){ window.print(); };</script>
      </body>
      </html>
    `);
    win.document.close();
  }
};

/* ================================================================
   SECTION 13 — RENDU CENTRAL
   ================================================================ */
const Render = {
  screen() {
    const el = document.getElementById('screen');
    let html = '';
    switch (State.currentScreen) {
      case 'nouveau': html = renderEcranNouveau(); break;
      case 'historique': html = renderEcranHistorique(); break;
      case 'stats': html = renderEcranStats(); break;
      case 'reglages': html = renderEcranReglages(); break;
      default: html = renderEcranNouveau();
    }
    el.innerHTML = html + (State.editingHistId ? renderDetailModal() : '');

    const sub = document.getElementById('topbarSub');
    if (sub) {
      const titreEcran = {
        nouveau: 'Nouveau comptage',
        historique: 'Historique des comptages',
        stats: "Statistiques d'écarts",
        reglages: 'Réglages'
      }[State.currentScreen] || 'La Marmite Bleue';
      sub.textContent = titreEcran;
    }
    const userBtn = document.getElementById('userPill');
    if (userBtn) {
      userBtn.textContent = State.employeActif ? '👤 ' + State.employeActif.nom : '👤 ?';
    }
  }
};

/* ================================================================
   SECTION 14 — INITIALISATION
   ================================================================ */
async function initApp() {
  State.draft = nouveauDraft();
  Nav.updateActiveTab('nouveau');

  // Affiche l'écran de saisie immédiatement (utilisable hors-ligne)
  Render.screen();

  // Charge la config, les employés et l'historique en arrière-plan
  await Sync.chargerConfig();
  await Sync.chargerEmployes();
  State.draft = nouveauDraft(); // ré-applique caisses/services/employé à jour
  await Sync.chargerComptages();

  if (State.currentScreen === 'nouveau') Render.screen();

  // Demande la connexion si personne n'est identifié sur cet appareil
  if (State.employes.length > 0 && !Auth.restaurerSession()) {
    Auth.ouvrirEcranConnexion();
  } else if (State.employeActif) {
    State.draft = nouveauDraft();
    Render.screen();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
