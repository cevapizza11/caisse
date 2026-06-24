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
  apiKey: "VOTRE_API_KEY",
  authDomain: "caisse-marmite-bleue.firebaseapp.com",
  projectId: "caisse-marmite-bleue",
  storageBucket: "caisse-marmite-bleue.appspot.com",
  messagingSenderId: "VOTRE_SENDER_ID",
  appId: "VOTRE_APP_ID"
};

let db = null;
let firebaseReady = false;

try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  // Certains réseaux/box/antivirus bloquent ou perturbent par intermittence le
  // canal de connexion habituel de Firestore (WebSocket/streaming). On force ici
  // systématiquement le mode "long-polling", plus lent de quelques centaines de
  // millisecondes mais beaucoup plus fiable sur les connexions capricieuses —
  // la détection automatique s'est révélée insuffisante sur certains réseaux.
  db.settings({ experimentalForceLongPolling: true, merge: true });
  // Persistance hors-ligne : permet de continuer à utiliser l'app sans réseau
  db.enablePersistence({ synchronizeTabs: true }).catch(()=>{});
  firebaseReady = true;
} catch (e) {
  console.error("Erreur init Firebase :", e);
  firebaseReady = false;
}

const COLLECTION = "comptages";
const TICKETS_COLLECTION = "tickets";
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
  tickets: [],          // chargés depuis Firestore (tickets de vente)
  historyFilter: { caisse: 'toutes', periode: '30j' },
  draft: null,         // comptage en cours de saisie
  editingHistId: null,
  seuilEcartAlerte: 5,  // € — au-delà, écart affiché en rouge
  ticketContexte: null, // {caisse, service, date} sélectionné sur l'écran Tickets
  ticketMontantSaisie: "" // montant en cours de frappe sur le pavé numérique tickets
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
    caTheorique: null,     // CA théorique espèces — auto-rempli depuis les tickets si dispo, sinon saisi manuellement
    caTheoriqueCB: null,   // relevé du terminal CB, saisi manuellement (l'app ne peut pas le connaître)
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

function calculEcartCB(draft) {
  if (draft.caTheoriqueCB === null || draft.caTheoriqueCB === undefined || draft.caTheoriqueCB === "") return null;
  const totalTicketsCB = totauxTicketsPour(draft.caisse, draft.service, draft.date).cb;
  return Math.round((parseFloat(draft.caTheoriqueCB) - totalTicketsCB) * 100) / 100;
}

// Agrège tous les tickets correspondant à une caisse/service/date donnés,
// et retourne le total par mode de paiement.
function totauxTicketsPour(caisse, service, date) {
  const tickets = State.tickets.filter(t => t.caisse === caisse && t.service === service && t.date === date);
  const especes = tickets.reduce((s, t) => s + (t.mode === 'especes' ? t.montant : 0), 0);
  const cb = tickets.reduce((s, t) => s + (t.mode === 'cb' ? t.montant : 0), 0);
  return {
    especes: Math.round(especes * 100) / 100,
    cb: Math.round(cb * 100) / 100,
    total: Math.round((especes + cb) * 100) / 100,
    nbTickets: tickets.length
  };
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
function estAdmin() {
  // Si aucun employé n'est configuré (mode libre / premier démarrage), tout le monde est admin
  if (State.employes.length === 0) return true;
  if (!State.employeActif) return false;
  const emp = State.employes.find(e => e.nom === State.employeActif.nom);
  return !!(emp && emp.admin);
}

const Nav = {
  go(screen) {
    if (screen === 'reglages' && !estAdmin()) {
      toast("Accès réservé à l'administrateur", true);
      return;
    }
    if (screen === 'nouveau' && State.currentScreen !== 'nouveau') {
      State.draft = nouveauDraft();
    }
    if (screen === 'tickets' && !State.ticketContexte) {
      State.ticketContexte = {
        caisse: State.caisses[0] || "Caisse 1",
        service: State.services[0] || "Service midi",
        date: new Date().toISOString().slice(0,10)
      };
    }
    State.currentScreen = screen;
    State.editingHistId = null;
    this.updateActiveTab(screen);
    Render.screen();
    document.getElementById('screen').scrollTop = 0;
    window.scrollTo(0,0);
  },
  updateActiveTab(screen) {
    ['nouveau','tickets','historique','stats','reglages'].forEach(s => {
      const el = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (el) el.classList.toggle('active', s === screen);
    });
    const reglagesBtn = document.getElementById('navReglages');
    if (reglagesBtn) reglagesBtn.style.display = estAdmin() ? '' : 'none';
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
      Nav.updateActiveTab(State.currentScreen);
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
    Nav.updateActiveTab(State.currentScreen);
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
    Nav.updateActiveTab(State.currentScreen);
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
      const ecartCB = calculEcartCB(draft);
      const payload = {
        date: draft.date,
        heure: draft.heure,
        caisse: draft.caisse,
        service: draft.service,
        type: draft.type,
        employe: draft.employe || "Non renseigné",
        denomQte: draft.denomQte,
        caTheorique: draft.caTheorique === "" ? null : draft.caTheorique,
        caTheoriqueCB: draft.caTheoriqueCB === "" ? null : draft.caTheoriqueCB,
        fondDeCaisse: parseFloat(draft.fondDeCaisse) || 0,
        commentaire: draft.commentaire || "",
        total: total,
        ecart: ecart,
        ecartCB: ecartCB,
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

  /* -------- TICKETS DE VENTE -------- */
  async chargerTickets() {
    if (!firebaseReady) { return; }
    try {
      const snap = await db.collection(TICKETS_COLLECTION).orderBy('createdAt', 'desc').limit(2000).get();
      State.tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error("Erreur chargement tickets :", e);
      toast("Impossible de charger les tickets", true);
    }
  },

  async sauvegarderTicket(ticket) {
    if (!firebaseReady) { toast("Pas de connexion — ticket non sauvegardé", true); return false; }
    this.setStatus('busy');
    try {
      const payload = {
        date: ticket.date,
        heure: ticket.heure,
        caisse: ticket.caisse,
        service: ticket.service,
        mode: ticket.mode,        // 'especes' ou 'cb'
        montant: Math.round(parseFloat(ticket.montant) * 100) / 100,
        employe: ticket.employe || "Non renseigné",
        createdAt: Date.now()
      };
      const ref = await db.collection(TICKETS_COLLECTION).add(payload);
      State.tickets.unshift({ id: ref.id, ...payload });
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur sauvegarde ticket :", e);
      this.setStatus('off');
      toast("Erreur lors de la sauvegarde du ticket", true);
      return false;
    }
  },

  async supprimerTicket(id) {
    if (!firebaseReady) return false;
    this.setStatus('busy');
    try {
      await db.collection(TICKETS_COLLECTION).doc(id).delete();
      State.tickets = State.tickets.filter(t => t.id !== id);
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur suppression ticket :", e);
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
    // Filet de sécurité : si la liste existe mais qu'aucun employé n'a le statut admin
    // (ex. données créées avant l'ajout de cette fonctionnalité), on évite de bloquer
    // tout le monde dehors en promouvant automatiquement le premier de la liste.
    if (State.employes.length > 0 && !State.employes.some(e => e.admin === true)) {
      State.employes[0].admin = true;
      Sync.sauvegarderEmployes();
      console.warn("Aucun admin trouvé — " + State.employes[0].nom + " promu administrateur automatiquement.");
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
  const totauxTickets = totauxTicketsPour(d.caisse, d.service, d.date);

  // Si le CA théorique espèces n'a pas été saisi manuellement, on propose
  // automatiquement le total des tickets espèces enregistrés pour ce contexte.
  const caTheoriqueEffectif = (d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === "")
    ? (totauxTickets.nbTickets > 0 ? totauxTickets.especes : null)
    : parseFloat(d.caTheorique);
  const draftPourCalcul = { ...d, caTheorique: caTheoriqueEffectif };
  const ecart = calculEcart(draftPourCalcul);
  const statut = statutEcart(ecart, State.seuilEcartAlerte);
  const ecartCB = calculEcartCB(d);
  const statutCB = statutEcart(ecartCB, State.seuilEcartAlerte);

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
      <div class="card-title">Tickets saisis pour ce service</div>
      ${totauxTickets.nbTickets === 0 ? `
        <div class="helper-text" style="margin-bottom:0;">Aucun ticket saisi pour cette caisse/service/date. Va dans l'onglet 🧾 Tickets pour les enregistrer au fur et à mesure du service, ou saisis le CA théorique manuellement ci-dessous.</div>
      ` : `
        <div class="grid-2">
          <div>
            <div class="helper-text" style="margin-bottom:2px;">Espèces (${totauxTickets.nbTickets} ticket${totauxTickets.nbTickets>1?'s':''})</div>
            <div style="font-family:'Cormorant',serif; font-size:22px; font-weight:700; color:var(--teal-dark);">${formatMontant(totauxTickets.especes)}</div>
          </div>
          <div>
            <div class="helper-text" style="margin-bottom:2px;">CB</div>
            <div style="font-family:'Cormorant',serif; font-size:22px; font-weight:700; color:var(--terracotta);">${formatMontant(totauxTickets.cb)}</div>
          </div>
        </div>
      `}
    </div>

    <div class="card">
      <div class="card-title">Rapprochement</div>
      <label>Fond de caisse de départ (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.fondDeCaisse || ''}"
             placeholder="0,00"
             onchange="Draft.setField('fondDeCaisse', this.value)">
      <label>CA théorique espèces (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.caTheorique === null ? '' : d.caTheorique}"
             placeholder="${totauxTickets.nbTickets > 0 ? 'Auto : ' + formatMontant(totauxTickets.especes) + ' (depuis les tickets)' : 'Laisser vide si pas de rapprochement'}"
             onchange="Draft.setField('caTheorique', this.value)">
      <div class="helper-text">${totauxTickets.nbTickets > 0 && (d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === '') ? 'Pré-rempli automatiquement depuis les tickets espèces — modifie si besoin.' : 'Écart espèces = Total compté − (Fond de caisse + CA théorique espèces)'}</div>

      <label>Relevé terminal CB (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.caTheoriqueCB === null ? '' : d.caTheoriqueCB}"
             placeholder="Montant indiqué par le TPE en fin de service"
             onchange="Draft.setField('caTheoriqueCB', this.value)">
      <div class="helper-text">Écart CB = Relevé terminal − Total des tickets CB saisis (${formatMontant(totauxTickets.cb)})</div>
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
      <span class="lbl">${statut==='ok' ? '✓ Espèces juste' : statut==='warn' ? '⚠ Petit écart espèces' : '⚠ Écart espèces important'}</span>
      <span class="val">${formatMontantSigne(ecart)}</span>
    </div>` : ''}

    ${ecartCB !== null ? `
    <div class="ecart-box ${statutCB}">
      <span class="lbl">${statutCB==='ok' ? '✓ CB juste' : statutCB==='warn' ? '⚠ Petit écart CB' : '⚠ Écart CB important'}</span>
      <span class="val">${formatMontantSigne(ecartCB)}</span>
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
    // Si le CA théorique espèces n'a pas été saisi à la main, on fige la valeur
    // automatique issue des tickets au moment de l'enregistrement, pour que
    // l'historique reflète exactement l'écart qui était affiché à l'écran.
    if ((d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === "") && d.type === 'cloture') {
      const totauxTickets = totauxTicketsPour(d.caisse, d.service, d.date);
      if (totauxTickets.nbTickets > 0) d.caTheorique = totauxTickets.especes;
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
   SECTION 9B — RENDU : ÉCRAN "TICKETS" (saisie des ventes en direct)
   ================================================================ */
function renderEcranTickets() {
  if (!State.ticketContexte) {
    State.ticketContexte = {
      caisse: State.caisses[0] || "Caisse 1",
      service: State.services[0] || "Service midi",
      date: new Date().toISOString().slice(0,10)
    };
  }
  const ctx = State.ticketContexte;
  const totaux = totauxTicketsPour(ctx.caisse, ctx.service, ctx.date);
  const ticketsJour = State.tickets
    .filter(t => t.caisse === ctx.caisse && t.service === ctx.service && t.date === ctx.date)
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0));

  const optionsCaisses = State.caisses.map(c => `<option value="${c}" ${c===ctx.caisse?'selected':''}>${c}</option>`).join('');
  const optionsServices = State.services.map(s => `<option value="${s}" ${s===ctx.service?'selected':''}>${s}</option>`).join('');

  const montant = State.ticketMontantSaisie || "0";
  const montantAffiche = (parseInt(montant, 10) / 100).toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:2});

  const pad = ['1','2','3','4','5','6','7','8','9','','0','⌫'].map(k => {
    if (k === '') return `<div></div>`;
    if (k === '⌫') return `<button class="pin-key pin-key-action ticket-key" onclick="Tickets.effacerChiffre()">⌫</button>`;
    return `<button class="pin-key ticket-key" onclick="Tickets.saisirChiffre('${k}')">${k}</button>`;
  }).join('');

  const ticketsHtml = ticketsJour.length === 0 ? `
    <div class="empty-state" style="padding:24px;">
      <p>Aucun ticket saisi pour ce service.</p>
    </div>` : ticketsJour.map(t => `
      <div class="hist-item" style="cursor:default;">
        <div class="hist-main">
          <div class="hist-titre">${t.mode === 'especes' ? '💶 Espèces' : '💳 CB'}</div>
          <div class="hist-meta">${t.heure || ''}${t.employe ? ' · ' + t.employe : ''}</div>
        </div>
        <div class="hist-right" style="display:flex; align-items:center; gap:10px;">
          <div class="hist-montant">${formatMontant(t.montant)}</div>
          <button class="btn-icon" style="background:var(--ivoire-dark); color:var(--ecart-bad);" onclick="Tickets.supprimer('${t.id}')">✕</button>
        </div>
      </div>`).join('');

  return `
    <div class="card">
      <div class="card-title">Contexte</div>
      <div class="field-row">
        <div>
          <label>Caisse / poste</label>
          <select onchange="Tickets.setContexte('caisse', this.value)">${optionsCaisses}</select>
        </div>
        <div>
          <label>Service</label>
          <select onchange="Tickets.setContexte('service', this.value)">${optionsServices}</select>
        </div>
      </div>
      <label>Date</label>
      <input type="text" value="${formatDate(ctx.date)}" readonly onclick="Tickets.openDatePicker()" style="background:#fafaf7;">
    </div>

    <div class="card" style="text-align:center;">
      <div class="card-title" style="justify-content:center;">Montant du ticket</div>
      <div style="font-family:'Cormorant',serif; font-size:42px; font-weight:700; color:var(--teal-dark); margin:8px 0 18px;">${montantAffiche} €</div>
      <div class="pin-pad" style="margin:0 auto 18px;">${pad}</div>
      <div class="btn-full-row">
        <button class="btn btn-primary" style="background:var(--teal-dark);" onclick="Tickets.enregistrer('especes')">💶 Espèces</button>
        <button class="btn btn-primary" onclick="Tickets.enregistrer('cb')">💳 CB</button>
      </div>
    </div>

    <div class="total-banner">
      <span class="lbl">Total espèces</span>
      <span class="val">${formatMontant(totaux.especes)}</span>
    </div>
    <div class="total-banner" style="background:var(--terracotta-dark);">
      <span class="lbl">Total CB</span>
      <span class="val">${formatMontant(totaux.cb)}</span>
    </div>

    <div class="divider-text">Tickets du service (${ticketsJour.length})</div>
    ${ticketsHtml}
  `;
}

const Tickets = {
  setContexte(champ, value) {
    State.ticketContexte[champ] = value;
    Render.screen();
  },

  openDatePicker() {
    const input = document.createElement('input');
    input.type = 'date';
    input.value = State.ticketContexte.date;
    input.style.position = 'fixed';
    input.style.top = '-100px';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      State.ticketContexte.date = input.value;
      Render.screen();
      document.body.removeChild(input);
    });
    input.click();
    input.showPicker ? input.showPicker() : input.focus();
  },

  saisirChiffre(c) {
    let m = State.ticketMontantSaisie || "";
    if (m.length >= 7) return; // limite raisonnable (jusqu'à 99999,99 €)
    m += c;
    State.ticketMontantSaisie = m.replace(/^0+(?=\d)/, ''); // évite les zéros en tête
    Render.screen();
  },

  effacerChiffre() {
    State.ticketMontantSaisie = (State.ticketMontantSaisie || "").slice(0, -1);
    Render.screen();
  },

  async enregistrer(mode) {
    const centimes = parseInt(State.ticketMontantSaisie || "0", 10);
    if (!centimes || centimes === 0) {
      toast("Saisis un montant avant d'enregistrer", true);
      return;
    }
    const montant = centimes / 100;
    const ctx = State.ticketContexte;
    const ticket = {
      date: ctx.date,
      heure: new Date().toTimeString().slice(0,5),
      caisse: ctx.caisse,
      service: ctx.service,
      mode: mode,
      montant: montant,
      employe: State.employeActif ? State.employeActif.nom : ""
    };
    const ok = await Sync.sauvegarderTicket(ticket);
    if (ok) {
      toast((mode === 'especes' ? 'Espèces' : 'CB') + " — " + formatMontant(montant) + " enregistré");
      State.ticketMontantSaisie = "";
      Render.screen();
    }
  },

  async supprimer(id) {
    if (!confirm("Supprimer ce ticket ?")) return;
    const ok = await Sync.supprimerTicket(id);
    if (ok) {
      toast("Ticket supprimé");
      Render.screen();
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
        <span class="lbl">Écart espèces (fond ${formatMontant(c.fondDeCaisse||0)} + théo. ${formatMontant(c.caTheorique||0)})</span>
        <span class="val">${formatMontantSigne(c.ecart)}</span>
      </div>` : ''}

      ${c.ecartCB !== null && c.ecartCB !== undefined ? `
      <div class="ecart-box ${statutEcart(c.ecartCB, State.seuilEcartAlerte)}" style="margin-top:8px;">
        <span class="lbl">Écart CB (relevé ${formatMontant(c.caTheoriqueCB||0)})</span>
        <span class="val">${formatMontantSigne(c.ecartCB)}</span>
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
      <button class="btn-icon admin-toggle ${e.admin ? 'active' : ''}" title="${e.admin ? 'Administrateur — clique pour retirer' : 'Donner les droits administrateur'}" onclick="Reglages.toggleAdmin(${i})">${e.admin ? '👑' : '🔒'}</button>
      <button class="btn-icon" style="background:var(--ivoire-dark); color:var(--ecart-bad); margin-left:8px;" onclick="Reglages.supprimerEmploye(${i})">✕</button>
    </div>
  `).join('');
}

function renderEcranReglages() {
  return `
    <div class="card">
      <div class="card-title">Session</div>
      <div class="helper-text" style="margin-bottom:10px;">Connecté en tant que <strong>${State.employeActif ? State.employeActif.nom : 'inconnu'}</strong> ${estAdmin() ? '👑 (administrateur)' : ''}</div>
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

    <div class="helper-text" style="text-align:center; margin-top:4px;">✓ Toutes les modifications sont enregistrées automatiquement</div>

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
    Sync.sauvegarderConfig();
  },
  modifierItem(type, index, value) {
    if (!value.trim()) { toast("Le nom ne peut pas être vide", true); Render.screen(); return; }
    State[type][index] = value.trim();
    Render.screen();
    Sync.sauvegarderConfig();
  },
  supprimerItem(type, index) {
    if (State[type].length <= 1) { toast("Il doit rester au moins un élément", true); return; }
    if (!confirm("Supprimer cet élément ?")) return;
    State[type].splice(index, 1);
    Render.screen();
    Sync.sauvegarderConfig();
  },
  setSeuil(value) {
    const v = parseFloat(value);
    State.seuilEcartAlerte = isNaN(v) ? 5 : Math.max(0, v);
    Sync.sauvegarderConfig();
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
    // Devient automatiquement administrateur s'il n'existe encore aucun admin
    // (plus robuste que de tester juste "premier employé créé")
    const aucunAdmin = !State.employes.some(e => e.admin === true);
    State.employes.push({ nom: nom.trim(), pin: pin, admin: aucunAdmin });
    Render.screen();
    Sync.sauvegarderEmployes();
    toast(aucunAdmin ? nom.trim() + " ajouté (administrateur par défaut)" : nom.trim() + " ajouté et enregistré");
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
    Sync.sauvegarderEmployes();
  },

  supprimerEmploye(index) {
    const emp = State.employes[index];
    if (emp.admin && State.employes.filter(e => e.admin).length <= 1) {
      toast("Impossible : il doit rester au moins un administrateur", true);
      return;
    }
    if (!confirm("Supprimer cet employé ?")) return;
    State.employes.splice(index, 1);
    Render.screen();
    Sync.sauvegarderEmployes();
  },

  toggleAdmin(index) {
    const emp = State.employes[index];
    if (emp.admin && State.employes.filter(e => e.admin).length <= 1) {
      toast("Il doit rester au moins un administrateur", true);
      return;
    }
    emp.admin = !emp.admin;
    Render.screen();
    Sync.sauvegarderEmployes();
    toast(emp.admin ? emp.nom + " est maintenant administrateur" : emp.nom + " n'est plus administrateur");
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
      "CA théorique espèces (€)": c.caTheorique === null || c.caTheorique === undefined ? "" : c.caTheorique,
      "Relevé terminal CB (€)": c.caTheoriqueCB === null || c.caTheoriqueCB === undefined ? "" : c.caTheoriqueCB,
      "Total compté (€)": c.total,
      "Écart espèces (€)": c.ecart === null || c.ecart === undefined ? "" : c.ecart,
      "Écart CB (€)": c.ecartCB === null || c.ecartCB === undefined ? "" : c.ecartCB,
      "Commentaire": c.commentaire || ""
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      {wch:11},{wch:7},{wch:14},{wch:10},{wch:16},{wch:16},
      {wch:16},{wch:18},{wch:16},{wch:15},{wch:14},{wch:12},{wch:30}
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comptages");

    // Feuille additionnelle : détail des tickets correspondant aux mêmes filtres
    const datesComptages = new Set(list.map(c => c.date));
    const ticketsConcernes = State.tickets.filter(t => {
      const matchCaisse = State.historyFilter.caisse === 'toutes' || t.caisse === State.historyFilter.caisse;
      const matchDate = datesComptages.has(t.date) || State.historyFilter.periode === 'tout';
      return matchCaisse && matchDate;
    });
    if (ticketsConcernes.length > 0) {
      const rowsTickets = ticketsConcernes
        .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
        .map(t => ({
          "Date": formatDate(t.date),
          "Heure": t.heure || "",
          "Caisse": t.caisse,
          "Service": t.service,
          "Mode": t.mode === 'especes' ? 'Espèces' : 'CB',
          "Montant (€)": t.montant,
          "Saisi par": t.employe || ""
        }));
      const wsTickets = XLSX.utils.json_to_sheet(rowsTickets);
      wsTickets['!cols'] = [{wch:11},{wch:7},{wch:14},{wch:16},{wch:10},{wch:12},{wch:16}];
      XLSX.utils.book_append_sheet(wb, wsTickets, "Tickets");
    }

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
        <tr><td>CA théorique espèces</td><td style="text-align:right;">${formatMontant(c.caTheorique||0)}</td></tr>
        <tr style="font-weight:700;"><td>Total attendu (espèces)</td><td style="text-align:right;">${formatMontant((c.fondDeCaisse||0)+(c.caTheorique||0))}</td></tr>
        <tr style="font-weight:700; color:${statut==='ok'?'#2d7d4f':statut==='warn'?'#c19a2e':'#b6402f'};">
          <td>ÉCART ESPÈCES</td><td style="text-align:right;">${formatMontantSigne(c.ecart)}</td>
        </tr>
      </table>` : '';

    const ecartCBHtml = (c.ecartCB !== null && c.ecartCB !== undefined) ? `
      <table class="pdf-table" style="margin-top:10px;">
        <tr><td>Relevé terminal CB</td><td style="text-align:right;">${formatMontant(c.caTheoriqueCB||0)}</td></tr>
        <tr style="font-weight:700; color:${statutEcart(c.ecartCB, State.seuilEcartAlerte)==='ok'?'#2d7d4f':statutEcart(c.ecartCB, State.seuilEcartAlerte)==='warn'?'#c19a2e':'#b6402f'};">
          <td>ÉCART CB</td><td style="text-align:right;">${formatMontantSigne(c.ecartCB)}</td>
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
        ${ecartCBHtml}
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
    if (State.currentScreen === 'reglages' && !estAdmin()) {
      State.currentScreen = 'nouveau';
      State.draft = nouveauDraft();
      Nav.updateActiveTab('nouveau');
    }
    const el = document.getElementById('screen');
    let html = '';
    switch (State.currentScreen) {
      case 'nouveau': html = renderEcranNouveau(); break;
      case 'tickets': html = renderEcranTickets(); break;
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
        tickets: 'Saisie des tickets',
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
  await Sync.chargerTickets();

  if (State.currentScreen === 'nouveau') Render.screen();

  // Demande la connexion si personne n'est identifié sur cet appareil
  if (State.employes.length > 0 && !Auth.restaurerSession()) {
    Nav.updateActiveTab(State.currentScreen);
    Auth.ouvrirEcranConnexion();
  } else if (State.employeActif) {
    State.draft = nouveauDraft();
    Nav.updateActiveTab(State.currentScreen);
    Render.screen();
  } else {
    Nav.updateActiveTab(State.currentScreen);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
