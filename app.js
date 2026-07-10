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
const TICKETS_COLLECTION = "tickets";
const PETITE_CAISSE_COLLECTION = "petiteCaisse";
const CAISSES_DOC = "config/caisses";
const EMPLOYES_DOC = "config/employes";

/* ================================================================
   SECTION 2 — DÉNOMINATIONS (billets / pièces EUR)
   ================================================================ */
const BILLETS = [100, 50, 20, 10, 5];
const PIECES  = [2, 1, 0.5, 0.2, 0.1, 0.05];

// Liste centrale des modes de paiement gérés par l'app. Toute la logique
// (saisie tickets, rapprochement, écarts, exports) s'appuie sur cette liste
// plutôt que de coder chaque mode en dur, pour faciliter l'ajout futur.
const MODES_PAIEMENT = [
  { cle: 'especes',        label: 'Espèces',          icone: '💶', champTheorique: 'caTheorique',   champEcart: 'ecart',   compteEspeces: true },
  { cle: 'cb',              label: 'CB',                icone: '💳', champTheorique: 'caTheoriqueCB', champEcart: 'ecartCB', compteEspeces: false },
  { cle: 'titrerestaurant', label: 'Titre-restaurant', icone: '🍽️', champTheorique: 'caTheoriqueTR', champEcart: 'ecartTR', compteEspeces: false },
  { cle: 'chequevacances',  label: 'Chèque-vacances',  icone: '🏖️', champTheorique: 'caTheoriqueCV', champEcart: 'ecartCV', compteEspeces: false },
  { cle: 'cheque',          label: 'Chèque',            icone: '📝', champTheorique: 'caTheoriqueCQ', champEcart: 'ecartCQ', compteEspeces: false }
];
function modeInfo(cle) {
  return MODES_PAIEMENT.find(m => m.cle === cle) || MODES_PAIEMENT[0];
}

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
  petiteCaisse: [],      // chargés depuis Firestore (sorties d'argent petite caisse)
  ticketsEnAttente: [],   // tickets saisis hors-ligne, en attente de synchronisation
  historyFilter: { caisse: 'toutes', periode: '30j' },
  draft: null,         // comptage en cours de saisie
  editingHistId: null,
  seuilEcartAlerte: 5,  // € — au-delà, écart affiché en rouge
  montantCibleFondCaisse: 80, // montant cible à laisser en caisse après le retrait de clôture (réglable)
  ticketContexte: null, // {caisse, service, date} sélectionné sur l'écran Tickets
  ticketMontantSaisie: "", // montant en cours de frappe sur le pavé numérique tickets
  petiteCaisseDraft: null, // sortie de petite caisse en cours de saisie
  petiteCaisseFiltrePeriode: '30j',
  rapportDate: new Date().toISOString().slice(0,10), // date sélectionnée pour le rapport journalier
  dernierComptageId: null, // id du dernier comptage enregistré, pour proposer l'impression directe sans passer par l'historique
  statsPeriode: '30j', // période pour l'écran Stats et les alertes d'écarts récurrents
  statsDateDebut: null, // utilisé si statsPeriode === 'perso'
  statsDateFin: null,
  seuilAlertesRecurrentes: 2, // nb d'écarts jaunes+rouges déclenchant une alerte récurrence
  delaiInactiviteMinutes: 15  // délai avant déconnexion auto (0 = désactivé)
};

const SESSION_KEY = 'caisseMarmiteEmployeActif';
const QUEUE_KEY = 'caisseMarmiteFileTicketsEnAttente';

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
    caTheoriqueTR: null,   // relevé titre-restaurant (bordereau de remise)
    caTheoriqueCV: null,   // relevé chèque-vacances
    caTheoriqueCQ: null,   // relevé chèque "classique"
    fondDeCaisse: 0,       // montant de départ en caisse, pour calcul écart sur clôture
    commentaire: "",
    forcerOuverture: false, // permet à un admin de contourner le blocage d'ouverture en doublon
    forcerCloture: false,   // permet à un admin de contourner le blocage de clôture sans ouverture
    createdAt: null
  };
}

function nouveauPetiteCaisseDraft() {
  return {
    id: null,
    date: new Date().toISOString().slice(0,10),
    heure: new Date().toTimeString().slice(0,5),
    montant: "",
    motif: "",
    employe: State.employeActif ? State.employeActif.nom : "",
    justificatifBase64: null, // photo du ticket de caisse magasin, compressée en base64
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

// Calcule l'écart de rapprochement pour un mode de paiement non-espèces
// (CB, titre-restaurant, chèque-vacances, chèque) : relevé externe saisi
// manuellement (TPE, bordereau...) moins le total des tickets de ce mode.
function calculEcartMode(draft, modeCle) {
  const info = modeInfo(modeCle);
  const valeurRelevee = draft[info.champTheorique];
  if (valeurRelevee === null || valeurRelevee === undefined || valeurRelevee === "") return null;
  const totalTickets = totauxTicketsPour(draft.caisse, draft.service, draft.date)[modeCle] || 0;
  return Math.round((parseFloat(valeurRelevee) - totalTickets) * 100) / 100;
}
// Alias conservé pour compatibilité avec le code existant
function calculEcartCB(draft) {
  return calculEcartMode(draft, 'cb');
}

// Agrège tous les tickets correspondant à une caisse/service/date donnés,
// et retourne le total par mode de paiement.
function totauxTicketsPour(caisse, service, date) {
  const tickets = State.tickets.filter(t => t.caisse === caisse && t.service === service && t.date === date);
  const parMode = {};
  let total = 0;
  MODES_PAIEMENT.forEach(m => {
    const somme = tickets.reduce((s, t) => s + (t.mode === m.cle ? t.montant : 0), 0);
    parMode[m.cle] = Math.round(somme * 100) / 100;
    total += somme;
  });
  return {
    ...parMode,                 // ex: { especes: 120.5, cb: 89.3, titrerestaurant: 0, ... }
    especes: parMode.especes,   // alias explicites conservés pour rétrocompatibilité du code existant
    cb: parMode.cb,
    total: Math.round(total * 100) / 100,
    nbTickets: tickets.length
  };
}

// Agrège toutes les données (comptages, tickets) d'une date donnée, pour une
// caisse précise ou pour toutes les caisses confondues (caisse = null).
// Utilisé pour générer le rapport journalier (global ou par caisse).
// Détermine si une caisse a actuellement une ouverture "active" (= une
// ouverture enregistrée à laquelle aucune clôture postérieure n'a encore
// répondu). Tant que c'est le cas, on bloque une nouvelle ouverture pour
// cette caisse — il faut d'abord clôturer le cycle en cours.
// Normalise un nom de caisse (espaces superflus + casse) pour comparer de
// façon fiable même si une faute de frappe a glissé un espace ou une
// majuscule différente lors d'une saisie manuelle.
function normaliserNomCaisse(nom) {
  return (nom || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function caisseADejaOuvertureActive(caisse, idAExclure) {
  const cibleNormalisee = normaliserNomCaisse(caisse);
  const comptagesCaisse = State.comptages
    .filter(c => normaliserNomCaisse(c.caisse) === cibleNormalisee && c.id !== idAExclure)
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
  if (comptagesCaisse.length === 0) return null;
  const dernier = comptagesCaisse[comptagesCaisse.length - 1];
  return dernier.type === 'fond' ? dernier : null;
}

// Récupère les tickets d'une caisse strictement compris entre l'horodatage
// d'une ouverture et celui d'une clôture (bornes incluses) — plus précis que
// le filtrage par service, car il capture exactement ce qui s'est passé
// pendant ce cycle de caisse, même si le service a changé en cours de route.
function ticketsEntreOuvertureEtCloture(caisse, createdAtOuverture, createdAtCloture) {
  const cibleNormalisee = normaliserNomCaisse(caisse);
  return State.tickets
    .filter(t => normaliserNomCaisse(t.caisse) === cibleNormalisee
      && (t.createdAt || 0) >= createdAtOuverture
      && (t.createdAt || 0) <= createdAtCloture)
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
}

function donneesJourPour(date, caisse) {
  const filtreCaisse = (x) => caisse ? normaliserNomCaisse(x.caisse) === normaliserNomCaisse(caisse) : true;

  const comptagesJour = State.comptages.filter(c => c.date === date && filtreCaisse(c));
  const ouvertures = comptagesJour.filter(c => c.type === 'fond').sort((a,b) => (a.createdAt||0)-(b.createdAt||0));
  const clotures = comptagesJour.filter(c => c.type === 'cloture').sort((a,b) => (a.createdAt||0)-(b.createdAt||0));

  const ticketsJour = State.tickets.filter(t => t.date === date && filtreCaisse(t));
  const totauxParMode = {};
  let totalGeneral = 0;
  MODES_PAIEMENT.forEach(m => {
    const somme = ticketsJour.reduce((s, t) => s + (t.mode === m.cle ? t.montant : 0), 0);
    totauxParMode[m.cle] = Math.round(somme * 100) / 100;
    totalGeneral += somme;
  });

  const totalCompteCloture = clotures.reduce((s, c) => s + (c.total || 0), 0);
  const totalFondOuverture = ouvertures.reduce((s, c) => s + (c.total || 0), 0);

  return {
    caisse: caisse || 'Toutes les caisses',
    date: date,
    ouvertures: ouvertures,
    clotures: clotures,
    ticketsJour: ticketsJour,
    totauxParMode: totauxParMode,
    totalGeneralTickets: Math.round(totalGeneral * 100) / 100,
    totalCompteCloture: Math.round(totalCompteCloture * 100) / 100,
    totalFondOuverture: Math.round(totalFondOuverture * 100) / 100,
    nbComptages: comptagesJour.length,
    nbTickets: ticketsJour.length
  };
}

// Calcule, pour une date donnée, le montant à déposer au coffre/banque en
// espèces pour chaque caisse clôturée ce jour-là, basé sur le montant cible
// du fond de caisse défini dans les Réglages. Retourne le détail par caisse
// ainsi que le total général toutes caisses confondues.
function montantsADeposerPour(date) {
  const clotures = State.comptages.filter(c => c.type === 'cloture' && c.date === date);
  const parCaisse = clotures.map(c => {
    const aDeposer = Math.max(0, (c.total || 0) - State.montantCibleFondCaisse);
    return {
      comptageId: c.id,
      caisse: c.caisse,
      heure: c.heure,
      totalCompte: c.total || 0,
      aDeposer: Math.round(aDeposer * 100) / 100,
      manqueAuFond: c.total < State.montantCibleFondCaisse ? Math.round((State.montantCibleFondCaisse - c.total) * 100) / 100 : 0
    };
  }).sort((a,b) => (a.heure||'').localeCompare(b.heure||''));
  const totalGeneral = parCaisse.reduce((s, x) => s + x.aDeposer, 0);
  return {
    date: date,
    parCaisse: parCaisse,
    totalGeneral: Math.round(totalGeneral * 100) / 100,
    nbClotures: clotures.length
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

const ECRANS_RESERVES_ADMIN = ['reglages', 'historique', 'stats'];

const Nav = {
  go(screen) {
    if (ECRANS_RESERVES_ADMIN.includes(screen) && !estAdmin()) {
      toast("Accès réservé à l'administrateur", true);
      return;
    }
    if (screen === 'nouveau' && State.currentScreen !== 'nouveau') {
      State.draft = nouveauDraft();
    }
    if (screen === 'tickets') {
      if (!State.ticketContexte) {
        State.ticketContexte = {
          caisse: State.caisses[0] || "Caisse 1",
          service: State.services[0] || "Service midi",
          date: new Date().toISOString().slice(0,10)
        };
      }
      if (State.ticketsEnAttente.length > 0) FileAttente.tenterSynchronisation();
    }
    if (screen === 'petitecaisse' && !State.petiteCaisseDraft) {
      State.petiteCaisseDraft = nouveauPetiteCaisseDraft();
    }
    State.currentScreen = screen;
    State.editingHistId = null;
    this.updateActiveTab(screen);
    Render.screen();
    document.getElementById('screen').scrollTop = 0;
    window.scrollTo(0,0);
  },
  updateActiveTab(screen) {
    ['nouveau','tickets','petitecaisse','historique','stats','reglages'].forEach(s => {
      const el = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (el) el.classList.toggle('active', s === screen);
    });
    const admin = estAdmin();
    ECRANS_RESERVES_ADMIN.forEach(s => {
      const btn = document.getElementById('nav' + s.charAt(0).toUpperCase() + s.slice(1));
      if (btn) btn.style.display = admin ? '' : 'none';
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
        Minuteur.relancer(); // relance le minuteur pour la session restaurée
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
      Minuteur.relancer(); // démarre le minuteur d'inactivité après connexion
    } else {
      toast("Code incorrect", true);
      this.pinSaisi = "";
      this.renderLogin();
    }
  },

  changerUtilisateur() {
    State.employeActif = null;
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
    Minuteur.stopper(); // stoppe le minuteur à la déconnexion manuelle
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
          <div class="login-logo"></div>
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
          <div class="login-logo"></div>
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
        <div class="login-logo"></div>
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
/* ================================================================
   SECTION 6B — FILE D'ATTENTE LOCALE (tickets saisis hors-ligne)
   ================================================================ */
// Enveloppe une promesse avec un délai maximal. Nécessaire car le SDK
// Firestore, avec la persistance hors-ligne activée, NE REJETTE PAS et NE
// RÉSOUT PAS une promesse d'écriture (add/set/update) tant que la connexion
// n'est pas revenue — elle reste indéfiniment en attente. Sans ce timeout,
// le code resterait bloqué sur le `await` sans jamais basculer en file
// d'attente locale, donnant l'impression que rien ne se passe.
function avecTimeout(promesse, ms) {
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error('timeout')), ms);
    promesse.then(
      (val) => { clearTimeout(minuteur); resolve(val); },
      (err) => { clearTimeout(minuteur); reject(err); }
    );
  });
}

const FileAttente = {
  charger() {
    try {
      const brut = localStorage.getItem(QUEUE_KEY);
      State.ticketsEnAttente = brut ? JSON.parse(brut) : [];
    } catch (e) {
      State.ticketsEnAttente = [];
    }
  },

  sauvegarderLocal() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(State.ticketsEnAttente));
    } catch (e) {
      console.error("Erreur écriture file d'attente locale :", e);
    }
  },

  ajouter(ticketPayload) {
    const idLocal = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const enAttente = {
      idLocal: idLocal,
      // _idClient voyage avec le document dans Firestore : permet en théorie
      // de repérer un doublon si une écriture en timeout réussit malgré tout
      // plus tard pendant qu'une nouvelle tentative est aussi en cours.
      payload: { ...ticketPayload, _idClient: idLocal }
    };
    State.ticketsEnAttente.push(enAttente);
    this.sauvegarderLocal();
    return enAttente;
  },

  retirer(idLocal) {
    State.ticketsEnAttente = State.ticketsEnAttente.filter(t => t.idLocal !== idLocal);
    this.sauvegarderLocal();
  },

  // Tente d'envoyer tous les tickets en attente vers Firestore. Appelé
  // automatiquement à chaque retour de connexion et au démarrage de l'app.
  async tenterSynchronisation() {
    if (!firebaseReady || State.ticketsEnAttente.length === 0) return;
    Sync.setStatus('busy');
    const enAttenteCopie = [...State.ticketsEnAttente];
    let nbReussis = 0;
    for (const item of enAttenteCopie) {
      try {
        // Timeout de sécurité : si le réseau est encore coupé (faux positif
        // de l'événement "online", ou coupure entre deux tickets de la file),
        // on ne reste pas bloqué indéfiniment sur cette tentative.
        const ref = await avecTimeout(db.collection(TICKETS_COLLECTION).add(item.payload), 6000);
        // Remplace l'entrée locale par la vraie entrée Firestore dans la liste affichée
        const idx = State.tickets.findIndex(t => t.id === item.idLocal);
        if (idx >= 0) State.tickets[idx] = { id: ref.id, ...item.payload };
        this.retirer(item.idLocal);
        nbReussis++;
      } catch (e) {
        console.error("Échec ou timeout sync ticket en attente :", e);
        // On arrête la boucle dès le premier échec : si le réseau est de nouveau
        // coupé, inutile d'essayer les suivants, on retentera plus tard.
        break;
      }
    }
    if (nbReussis > 0) {
      toast(nbReussis + " ticket" + (nbReussis>1?'s':'') + " synchronisé" + (nbReussis>1?'s':'') + " ✓");
      Render.screen();
    }
    Sync.setStatus(State.ticketsEnAttente.length > 0 ? 'attente' : 'ok');
  }
};

const Sync = {
  setStatus(state) {
    // state: 'ok' | 'busy' | 'off' | 'attente'
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    if (!dot || !txt) return;
    const nbAttente = State.ticketsEnAttente ? State.ticketsEnAttente.length : 0;
    if (state === 'ok' && nbAttente > 0) state = 'attente';
    dot.className = 'sync-dot ' + (state === 'ok' ? '' : state === 'attente' ? 'busy' : state);
    txt.textContent = state === 'ok' ? 'synchronisé'
      : state === 'busy' ? 'sync...'
      : state === 'attente' ? nbAttente + ' en attente'
      : 'hors ligne';
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
      const ecartCB = calculEcartMode(draft, 'cb');
      const ecartTR = calculEcartMode(draft, 'titrerestaurant');
      const ecartCV = calculEcartMode(draft, 'chequevacances');
      const ecartCQ = calculEcartMode(draft, 'cheque');
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
        caTheoriqueTR: draft.caTheoriqueTR === "" ? null : draft.caTheoriqueTR,
        caTheoriqueCV: draft.caTheoriqueCV === "" ? null : draft.caTheoriqueCV,
        caTheoriqueCQ: draft.caTheoriqueCQ === "" ? null : draft.caTheoriqueCQ,
        fondDeCaisse: parseFloat(draft.fondDeCaisse) || 0,
        commentaire: draft.commentaire || "",
        total: total,
        ecart: ecart,
        ecartCB: ecartCB,
        ecartTR: ecartTR,
        ecartCV: ecartCV,
        ecartCQ: ecartCQ,
        createdAt: draft.createdAt || Date.now()
      };
      let idComptage = draft.id;
      if (draft.id) {
        await db.collection(COLLECTION).doc(draft.id).set(payload, { merge: true });
      } else {
        const ref = await db.collection(COLLECTION).add(payload);
        idComptage = ref.id;
      }
      this.setStatus('ok');
      return idComptage;
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
    const payload = {
      date: ticket.date,
      heure: ticket.heure,
      caisse: ticket.caisse,
      service: ticket.service,
      mode: ticket.mode,
      montant: Math.round(parseFloat(ticket.montant) * 100) / 100,
      employe: ticket.employe || "Non renseigné",
      createdAt: Date.now()
    };

    // Si Firebase n'est même pas initialisé (config absente), on bascule
    // directement en file d'attente locale plutôt que de perdre la saisie.
    if (!firebaseReady) {
      const enAttente = FileAttente.ajouter(payload);
      State.tickets.unshift({ id: enAttente.idLocal, ...payload, _enAttente: true });
      this.setStatus('attente');
      return 'attente';
    }

    this.setStatus('busy');
    try {
      const ref = await avecTimeout(db.collection(TICKETS_COLLECTION).add(payload), 5000);
      State.tickets.unshift({ id: ref.id, ...payload });
      this.setStatus('ok');
      return 'ok';
    } catch (e) {
      // Échec réseau OU timeout (cas hors-ligne où la promesse Firestore ne se
      // résout/rejette jamais) : on conserve le ticket localement plutôt que
      // de le perdre, et on retentera dès que la connexion reviendra.
      console.error("Erreur ou timeout sauvegarde ticket, mise en file d'attente locale :", e);
      const enAttente = FileAttente.ajouter(payload);
      State.tickets.unshift({ id: enAttente.idLocal, ...payload, _enAttente: true });
      this.setStatus('attente');
      return 'attente';
    }
  },

  async supprimerTicket(id) {
    // Ticket encore en file d'attente locale (jamais envoyé à Firestore) :
    // suppression purement locale, pas d'appel réseau nécessaire.
    if (typeof id === 'string' && id.startsWith('local_')) {
      FileAttente.retirer(id);
      State.tickets = State.tickets.filter(t => t.id !== id);
      this.setStatus(State.ticketsEnAttente.length > 0 ? 'attente' : 'ok');
      return true;
    }
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

  /* -------- PETITE CAISSE (sorties d'argent pour achats courants) -------- */
  async chargerPetiteCaisse() {
    if (!firebaseReady) return;
    try {
      const snap = await db.collection(PETITE_CAISSE_COLLECTION).orderBy('createdAt', 'desc').limit(500).get();
      State.petiteCaisse = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error("Erreur chargement petite caisse :", e);
      toast("Impossible de charger la petite caisse", true);
    }
  },

  async sauvegarderPetiteCaisse(sortie) {
    if (!firebaseReady) { toast("Pas de connexion — sortie non sauvegardée", true); return false; }
    this.setStatus('busy');
    try {
      const payload = {
        date: sortie.date,
        heure: sortie.heure,
        montant: Math.round(parseFloat(sortie.montant) * 100) / 100,
        motif: sortie.motif || "",
        employe: sortie.employe || "Non renseigné",
        justificatifBase64: sortie.justificatifBase64 || null,
        createdAt: sortie.createdAt || Date.now()
      };
      if (sortie.id) {
        await db.collection(PETITE_CAISSE_COLLECTION).doc(sortie.id).set(payload, { merge: true });
      } else {
        const ref = await db.collection(PETITE_CAISSE_COLLECTION).add(payload);
        State.petiteCaisse.unshift({ id: ref.id, ...payload });
      }
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur sauvegarde petite caisse :", e);
      this.setStatus('off');
      toast("Erreur lors de la sauvegarde (justificatif trop volumineux ?)", true);
      return false;
    }
  },

  async supprimerPetiteCaisse(id) {
    if (!firebaseReady) return false;
    this.setStatus('busy');
    try {
      await db.collection(PETITE_CAISSE_COLLECTION).doc(id).delete();
      State.petiteCaisse = State.petiteCaisse.filter(s => s.id !== id);
      this.setStatus('ok');
      return true;
    } catch (e) {
      console.error("Erreur suppression petite caisse :", e);
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
        if (data.montantCibleFondCaisse !== undefined) State.montantCibleFondCaisse = data.montantCibleFondCaisse;
        if (data.delaiInactiviteMinutes !== undefined) State.delaiInactiviteMinutes = data.delaiInactiviteMinutes;
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
        seuilEcartAlerte: State.seuilEcartAlerte,
        montantCibleFondCaisse: State.montantCibleFondCaisse,
        delaiInactiviteMinutes: State.delaiInactiviteMinutes
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
  const ouvertureActive = d.type === 'fond' ? caisseADejaOuvertureActive(d.caisse, d.id) : null;
  const ouvertureBloquee = !!ouvertureActive && !d.forcerOuverture;

  // À la clôture, le fond de caisse de départ doit correspondre exactement à
  // ce qui a été réellement compté à l'ouverture (et non à une saisie libre),
  // pour garantir la cohérence du rapprochement. On retrouve cette ouverture
  // de référence et on verrouille le champ si elle existe.
  const ouvertureDeReference = d.type === 'cloture' ? caisseADejaOuvertureActive(d.caisse) : null;
  const fondVerrouille = !!ouvertureDeReference;
  if (fondVerrouille && d.fondDeCaisse !== ouvertureDeReference.total) {
    d.fondDeCaisse = ouvertureDeReference.total;
  }
  // Symétrique du blocage d'ouverture en doublon : on ne peut pas créer une
  // NOUVELLE clôture pour une caisse qui n'a aucune ouverture active en
  // attente, sauf forçage admin. Ne s'applique pas à l'édition d'une clôture
  // déjà existante (d.id rempli), qui a forcément déjà été validée à l'époque.
  const clotureBloquee = d.type === 'cloture' && !d.id && !ouvertureDeReference && !d.forcerCloture;

  // Si le CA théorique espèces n'a pas été saisi manuellement, on propose
  // automatiquement le total des tickets espèces enregistrés pour ce contexte.
  const caTheoriqueEffectif = (d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === "")
    ? (totauxTickets.nbTickets > 0 ? totauxTickets.especes : null)
    : parseFloat(d.caTheorique);
  const draftPourCalcul = { ...d, caTheorique: caTheoriqueEffectif };
  const ecart = calculEcart(draftPourCalcul);
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

    ${ouvertureActive ? `
    <div class="ecart-box ${d.forcerOuverture ? 'warn' : 'bad'}">
      <span class="lbl" style="line-height:1.4;">
        ⚠ ${d.caisse} a déjà une ouverture en cours (${formatDateHeure(ouvertureActive.createdAt || Date.now())}${ouvertureActive.employe ? ', par ' + ouvertureActive.employe : ''}) sans clôture associée.
        ${estAdmin() ? "Clôture-la d'abord, ou force une nouvelle ouverture ci-dessous." : "Demande à un administrateur de clôturer cette ouverture, ou de forcer une nouvelle ouverture."}
      </span>
    </div>
    ${estAdmin() ? `
      <button class="btn ${d.forcerOuverture ? 'btn-primary' : 'btn-ghost'}" style="margin-top:-4px; margin-bottom:14px;" onclick="Draft.toggleForcerOuverture()">
        ${d.forcerOuverture ? '✓ Ouverture forcée — décocher' : '🔓 Forcer une nouvelle ouverture malgré tout'}
      </button>
    ` : ''}
    ` : ''}

    ${d.type === 'cloture' && !d.id && !ouvertureDeReference ? `
    <div class="ecart-box ${d.forcerCloture ? 'warn' : 'bad'}">
      <span class="lbl" style="line-height:1.4;">
        ⚠ ${d.caisse} n'a pas d'ouverture en cours — impossible de la clôturer sans avoir d'abord enregistré son ouverture.
        ${estAdmin() ? "Fais d'abord l'ouverture, ou force la clôture ci-dessous." : "Demande à un administrateur de forcer la clôture, ou fais d'abord l'ouverture de cette caisse."}
      </span>
    </div>
    ${estAdmin() ? `
      <button class="btn ${d.forcerCloture ? 'btn-primary' : 'btn-ghost'}" style="margin-top:-4px; margin-bottom:14px;" onclick="Draft.toggleForcerCloture()">
        ${d.forcerCloture ? '✓ Clôture forcée — décocher' : '🔓 Forcer la clôture malgré tout'}
      </button>
    ` : ''}
    ` : ''}

    ${d.type === 'cloture' ? `
    <div class="card">
      <div class="card-title">Tickets saisis pour ce service</div>
      ${totauxTickets.nbTickets === 0 ? `
        <div class="helper-text" style="margin-bottom:0;">Aucun ticket saisi pour cette caisse/service/date. Va dans l'onglet 🧾 Tickets pour les enregistrer au fur et à mesure du service, ou saisis le CA théorique manuellement ci-dessous.</div>
      ` : `
        <div class="modes-totaux-grid">
          ${MODES_PAIEMENT.filter(m => (totauxTickets[m.cle] || 0) > 0).map(m => `
            <div>
              <div class="helper-text" style="margin-bottom:2px;">${m.icone} ${m.label}</div>
              <div style="font-family:'Cormorant',serif; font-size:20px; font-weight:700; color:var(--ink);">${formatMontant(totauxTickets[m.cle])}</div>
            </div>`).join('')}
        </div>
        <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between;">
          <span class="helper-text" style="margin-bottom:0; font-weight:700; text-transform:uppercase; letter-spacing:.5px;">CA réalisé (total, ${totauxTickets.nbTickets} ticket${totauxTickets.nbTickets>1?'s':''})</span>
          <span style="font-family:'Cormorant',serif; font-size:26px; font-weight:700; color:var(--ink);">${formatMontant(totauxTickets.total)}</span>
        </div>
      `}
    </div>

    <div class="card">
      <div class="card-title">Rapprochement espèces</div>
      <label>Fond de caisse de départ (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.fondDeCaisse || ''}"
             placeholder="0,00"
             ${fondVerrouille ? 'readonly style="background:#fafaf7; color:var(--ink-soft);"' : ''}
             onchange="Draft.setField('fondDeCaisse', this.value)">
      <div class="helper-text" style="${fondVerrouille ? '' : 'margin-top:-8px;'}">
        ${fondVerrouille
          ? "🔒 Verrouillé — correspond au comptage d'ouverture du " + formatDateHeure(ouvertureDeReference.createdAt || Date.now()) + (ouvertureDeReference.employe ? ' par ' + ouvertureDeReference.employe : '') + '.'
          : 'Aucune ouverture trouvée pour cette caisse — saisis le fond de départ manuellement.'}
      </div>
      <label>CA théorique espèces (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.caTheorique === null ? '' : d.caTheorique}"
             placeholder="${totauxTickets.nbTickets > 0 ? 'Auto : ' + formatMontant(totauxTickets.especes) + ' (depuis les tickets)' : 'Laisser vide si pas de rapprochement'}"
             onchange="Draft.setField('caTheorique', this.value)">
      <div class="helper-text">${totauxTickets.nbTickets > 0 && (d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === '') ? 'Pré-rempli automatiquement depuis les tickets espèces — modifie si besoin.' : 'Écart espèces = Total compté − (Fond de caisse + CA théorique espèces)'}</div>
    </div>

    <div class="card">
      <div class="card-title">Rapprochement des autres moyens de paiement</div>
      <div class="helper-text" style="margin-top:-6px;">Saisis le relevé externe de chaque moyen de paiement (terminal CB, bordereau de remise titres-restaurant/chèques-vacances, etc.) pour comparer avec les tickets enregistrés.</div>
      ${MODES_PAIEMENT.filter(m => !m.compteEspeces).map(m => `
        <label style="margin-top:14px; display:block;">${m.icone} Relevé ${m.label} (€)</label>
        <input type="number" inputmode="decimal" step="0.01" value="${d[m.champTheorique] === null || d[m.champTheorique] === undefined ? '' : d[m.champTheorique]}"
               placeholder="Montant relevé pour ${m.label}"
               onchange="Draft.setField('${m.champTheorique}', this.value)">
        <div class="helper-text">Écart ${m.label} = Relevé − Total tickets ${m.label} (${formatMontant(totauxTickets[m.cle] || 0)})</div>
      `).join('')}
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

    ${d.type === 'cloture' ? `
    <div class="ecart-box" style="border-color:var(--teal-light); background:#eef6f5;">
      <span class="lbl" style="color:var(--teal-dark);">💰 À retirer pour la banque/coffre</span>
      <span class="val" style="color:var(--teal-dark);">${formatMontant(Math.max(0, total - State.montantCibleFondCaisse))}</span>
    </div>
    <div class="helper-text" style="margin-top:-8px; margin-bottom:14px;">Pour ramener la caisse à ${formatMontant(State.montantCibleFondCaisse)} (montant cible défini dans Réglages) avant la prochaine ouverture.${total < State.montantCibleFondCaisse ? ' ⚠ Le total compté est inférieur au montant cible — rien à retirer, et il manque ' + formatMontant(State.montantCibleFondCaisse - total) + ' pour atteindre la cible.' : ''}</div>
    ` : ''}

    ${MODES_PAIEMENT.filter(m => !m.compteEspeces).map(m => {
      const ec = calculEcartMode(d, m.cle);
      if (ec === null) return '';
      const st = statutEcart(ec, State.seuilEcartAlerte);
      return `
    <div class="ecart-box ${st}">
      <span class="lbl">${st==='ok' ? '✓ '+m.label+' juste' : st==='warn' ? '⚠ Petit écart '+m.label : '⚠ Écart '+m.label+' important'}</span>
      <span class="val">${formatMontantSigne(ec)}</span>
    </div>`;
    }).join('')}

    <div class="card">
      <label>Commentaire (optionnel)</label>
      <textarea placeholder="Ex : billet déchiré mis de côté, erreur de rendu monnaie..." onchange="Draft.setField('commentaire', this.value)">${d.commentaire || ''}</textarea>
    </div>

    <button class="btn btn-primary" ${(ouvertureBloquee || clotureBloquee) ? 'disabled' : ''} onclick="Draft.enregistrer()">💾 Enregistrer le comptage</button>

    ${State.dernierComptageId && !d.id ? `
      <button class="btn btn-secondary" style="margin-top:10px;" onclick="Export.exporterPdf('${State.dernierComptageId}')">🧾 Imprimer le dernier comptage enregistré</button>
    ` : ''}
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
      if (field === 'caisse') { State.draft.forcerOuverture = false; State.draft.forcerCloture = false; }
    }
    Render.screen();
  },

  setType(type) {
    State.draft.type = type;
    State.draft.forcerOuverture = false; // on réinitialise le forçage à chaque changement de type
    State.draft.forcerCloture = false;
    Render.screen();
  },

  toggleForcerCloture() {
    State.draft.forcerCloture = !State.draft.forcerCloture;
    Render.screen();
  },

  toggleForcerOuverture() {
    State.draft.forcerOuverture = !State.draft.forcerOuverture;
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
    // Empêche d'ouvrir une caisse qui a déjà une ouverture active (sans
    // clôture associée), sauf si un admin a explicitement coché "forcer".
    if (d.type === 'fond') {
      const ouvertureActive = caisseADejaOuvertureActive(d.caisse, d.id);
      if (ouvertureActive && !d.forcerOuverture) {
        toast(d.caisse + " a déjà une ouverture en cours — clôture-la d'abord ou demande à un administrateur de forcer", true);
        return;
      }
    }
    // Sécurité supplémentaire : si une ouverture de référence existe pour
    // cette clôture, on réimpose le fond de caisse correspondant, même si le
    // champ avait été contourné côté interface (il est censé être verrouillé).
    if (d.type === 'cloture') {
      const ouvertureDeReference = caisseADejaOuvertureActive(d.caisse);
      if (ouvertureDeReference) {
        d.fondDeCaisse = ouvertureDeReference.total;
      } else if (!d.id && !d.forcerCloture) {
        // Empêche de CRÉER une nouvelle clôture pour une caisse qui n'a pas
        // d'ouverture en cours, sauf si un admin a explicitement coché "forcer".
        // Ne s'applique pas à l'édition d'une clôture déjà existante (d.id rempli).
        toast(d.caisse + " n'a pas d'ouverture en cours — fais d'abord l'ouverture ou demande à un administrateur de forcer la clôture", true);
        return;
      }
    }
    // Si le CA théorique espèces n'a pas été saisi à la main, on fige la valeur
    // automatique issue des tickets au moment de l'enregistrement, pour que
    // l'historique reflète exactement l'écart qui était affiché à l'écran.
    if ((d.caTheorique === null || d.caTheorique === undefined || d.caTheorique === "") && d.type === 'cloture') {
      const totauxTickets = totauxTicketsPour(d.caisse, d.service, d.date);
      if (totauxTickets.nbTickets > 0) d.caTheorique = totauxTickets.especes;
    }
    // Capture si c'est la création d'une NOUVELLE clôture (pas une édition),
    // ainsi que l'id de l'ouverture associée — utilisé après la sauvegarde
    // pour ouvrir automatiquement la feuille de caisse prête à imprimer.
    const estNouvelleCloture = d.type === 'cloture' && !d.id;
    let idOuvertureAssociee = null;
    if (estNouvelleCloture) {
      const ouvertureDeReference = caisseADejaOuvertureActive(d.caisse);
      if (ouvertureDeReference) idOuvertureAssociee = ouvertureDeReference.id;
    }

    // IMPORTANT : la fenêtre d'impression doit être ouverte ICI, AVANT tout
    // `await`, sinon de nombreux navigateurs (Safari en particulier, mais
    // aussi Chrome/Firefox selon les réglages) bloquent silencieusement
    // window.open() s'il est appelé après une opération asynchrone — le
    // clic initial n'est alors plus reconnu comme une vraie interaction
    // utilisateur. On ouvre donc une fenêtre vide tout de suite, et on la
    // remplit une fois la sauvegarde terminée.
    let fenetreImpression = null;
    if (estNouvelleCloture) {
      fenetreImpression = window.open('', '_blank');
    }

    const idComptage = await Sync.sauvegarderComptage(d);
    if (idComptage) {
      toast(d.id ? "Comptage modifié" : "Comptage enregistré ✓");
      await Sync.chargerComptages();
      State.dernierComptageId = idComptage;
      State.draft = nouveauDraft();
      // Les non-admins n'ont pas accès à l'Historique : on les laisse sur
      // l'écran de saisie (qui propose désormais un bouton d'impression
      // directe) plutôt que de tenter une redirection bloquée.
      if (estAdmin()) {
        Nav.go('historique');
      } else {
        Nav.go('nouveau');
      }
      // Remplit la fenêtre déjà ouverte avec la feuille de caisse, avec le
      // détail des tickets de l'ouverture à la clôture, juste après une
      // nouvelle clôture (pas à l'édition, pour ne pas réimprimer à chaque
      // petite correction ultérieure).
      if (estNouvelleCloture) {
        Export.exporterPdf(idComptage, idOuvertureAssociee, fenetreImpression);
      }
    } else if (fenetreImpression) {
      // La sauvegarde a échoué : on ferme la fenêtre vide ouverte en avance
      // pour ne pas laisser un onglet blanc inutile (si elle a pu s'ouvrir).
      try { fenetreImpression.close(); } catch (e) {}
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
    </div>` : ticketsJour.map(t => {
      const info = modeInfo(t.mode);
      const badgeAttente = t._enAttente ? `<span class="hist-badge warn">⏳ en attente</span>` : '';
      // La suppression est réservée aux admins, SAUF pour un ticket encore en
      // file d'attente locale (pas encore synchronisé) : l'employé doit
      // pouvoir corriger sa propre saisie tant qu'elle n'est pas confirmée.
      const peutSupprimer = estAdmin() || t._enAttente;
      const boutonSupprimer = peutSupprimer
        ? `<button class="btn-icon" style="background:var(--ivoire-dark); color:var(--ecart-bad);" onclick="Tickets.supprimer('${t.id}')">✕</button>`
        : '';
      return `
      <div class="hist-item" style="cursor:default; ${t._enAttente ? 'border-color:var(--ecart-warn); border-style:dashed;' : ''}">
        <div class="hist-main">
          <div class="hist-titre">${info.icone} ${info.label}</div>
          <div class="hist-meta">${t.heure || ''}${t.employe ? ' · ' + t.employe : ''}</div>
        </div>
        <div class="hist-right" style="display:flex; align-items:center; gap:10px;">
          <div>
            <div class="hist-montant">${formatMontant(t.montant)}</div>
            ${badgeAttente}
          </div>
          ${boutonSupprimer}
        </div>
      </div>`;
    }).join('');

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
      <div class="mode-paiement-grid">
        ${MODES_PAIEMENT.map(m => `<button class="btn btn-mode-paiement" onclick="Tickets.enregistrer('${m.cle}')">${m.icone} ${m.label}</button>`).join('')}
      </div>
    </div>

    ${MODES_PAIEMENT.map((m, i) => `
    <div class="total-banner" style="background:${['var(--teal-dark)','var(--terracotta-dark)','#6b5b95','#2d8659','#8a5a44'][i % 5]};">
      <span class="lbl">Total ${m.label}</span>
      <span class="val">${formatMontant(totaux[m.cle] || 0)}</span>
    </div>`).join('')}
    <div class="total-banner" style="background:var(--ink);">
      <span class="lbl">CA réalisé (total)</span>
      <span class="val">${formatMontant(totaux.total)}</span>
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
    const resultat = await Sync.sauvegarderTicket(ticket);
    if (resultat === 'ok') {
      toast(modeInfo(mode).label + " — " + formatMontant(montant) + " enregistré");
      State.ticketMontantSaisie = "";
      Render.screen();
    } else if (resultat === 'attente') {
      toast(modeInfo(mode).label + " — " + formatMontant(montant) + " conservé hors-ligne, sera synchronisé automatiquement", true);
      State.ticketMontantSaisie = "";
      Render.screen();
    }
  },

  async supprimer(id) {
    // Un ticket encore en file d'attente locale (pas encore synchronisé)
    // peut être supprimé par celui qui l'a saisi, pour corriger une erreur
    // avant confirmation. Une fois synchronisé, seul un admin peut le faire.
    const estEnAttente = typeof id === 'string' && id.startsWith('local_');
    if (!estAdmin() && !estEnAttente) {
      toast("Seul un administrateur peut supprimer un ticket", true);
      return;
    }
    if (!confirm("Supprimer ce ticket ?")) return;
    const ok = await Sync.supprimerTicket(id);
    if (ok) {
      toast("Ticket supprimé");
      Render.screen();
    }
  }
};

/* ================================================================
   SECTION 9C — RENDU : ÉCRAN "PETITE CAISSE" (sorties d'argent)
   ================================================================ */
function petiteCaisseFiltree() {
  let list = [...State.petiteCaisse];
  const periode = State.petiteCaisseFiltrePeriode;
  if (periode !== 'tout') {
    const now = Date.now();
    const jours = periode === '7j' ? 7 : periode === '30j' ? 30 : 90;
    const seuil = now - jours * 24 * 3600 * 1000;
    list = list.filter(s => (s.createdAt || 0) >= seuil);
  }
  return list;
}

function renderEcranPetiteCaisse() {
  if (!State.petiteCaisseDraft) State.petiteCaisseDraft = nouveauPetiteCaisseDraft();
  const d = State.petiteCaisseDraft;
  const list = petiteCaisseFiltree();
  const totalSorti = list.reduce((s, x) => s + (x.montant || 0), 0);

  const chipsPeriode = [['7j','7 jours'],['30j','30 jours'],['90j','3 mois'],['tout','Tout']].map(([k,l]) => `
    <button class="filter-chip ${State.petiteCaisseFiltrePeriode===k?'active':''}" onclick="PetiteCaisse.setFiltrePeriode('${k}')">${l}</button>
  `).join('');

  const photoPreview = d.justificatifBase64 ? `
    <div style="position:relative; margin-bottom:14px;">
      <img src="${d.justificatifBase64}" style="width:100%; border-radius:10px; border:1px solid var(--border);">
      <button class="btn-icon" style="position:absolute; top:8px; right:8px; background:rgba(182,64,47,0.9); color:#fff;" onclick="PetiteCaisse.retirerPhoto()">✕</button>
    </div>` : `
    <button class="btn btn-secondary" style="margin-bottom:14px;" onclick="document.getElementById('petiteCaissePhotoInput').click()">📷 Photographier le ticket de caisse</button>
    <input type="file" id="petiteCaissePhotoInput" accept="image/*" capture="environment" style="display:none;" onchange="PetiteCaisse.choisirPhoto(this)">`;

  const listHtml = list.length === 0 ? `
    <div class="empty-state" style="padding:24px;">
      <p>Aucune sortie de petite caisse enregistrée.</p>
    </div>` : list.map(s => `
      <div class="hist-item" onclick="PetiteCaisse.ouvrirDetail('${s.id}')">
        <div class="hist-main">
          <div class="hist-titre">${s.motif || 'Sans motif'}</div>
          <div class="hist-meta">${formatDate(s.date)} à ${s.heure}${s.employe ? ' · ' + s.employe : ''}${s.justificatifBase64 ? ' · 📷' : ''}</div>
        </div>
        <div class="hist-right">
          <div class="hist-montant" style="color:var(--ecart-bad);">−${formatMontant(s.montant)}</div>
        </div>
      </div>`).join('');

  return `
    <div class="card">
      <div class="card-title">Nouvelle sortie de petite caisse</div>
      <label>Montant (€)</label>
      <input type="number" inputmode="decimal" step="0.01" value="${d.montant}"
             placeholder="0,00"
             onchange="PetiteCaisse.setField('montant', this.value)">
      <label>Motif (ex : ampoule, papier, dépannage...)</label>
      <input type="text" value="${d.motif}"
             placeholder="Que vient-on d'acheter ?"
             onchange="PetiteCaisse.setField('motif', this.value)">
      <label>Justificatif (optionnel)</label>
      ${photoPreview}
      <button class="btn btn-primary" onclick="PetiteCaisse.enregistrer()">💾 Enregistrer la sortie</button>
    </div>

    <div class="total-banner" style="background:var(--ecart-bad);">
      <span class="lbl">Total sorti (période affichée)</span>
      <span class="val">${formatMontant(totalSorti)}</span>
    </div>

    <div class="filter-bar">${chipsPeriode}</div>
    <div class="divider-text">Historique (${list.length})</div>
    ${listHtml}
  `;
}

const PetiteCaisse = {
  setField(champ, value) {
    State.petiteCaisseDraft[champ] = value;
  },

  setFiltrePeriode(p) {
    State.petiteCaisseFiltrePeriode = p;
    Render.screen();
  },

  choisirPhoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast("Le fichier choisi n'est pas une image", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Redimensionne et compresse l'image pour rester largement sous la limite
        // de 1 Mo par document Firestore (une photo de ticket n'a pas besoin
        // d'une résolution élevée pour rester lisible).
        const maxLargeur = 900;
        const ratio = Math.min(1, maxLargeur / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.6);
        State.petiteCaisseDraft.justificatifBase64 = base64;
        Render.screen();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  retirerPhoto() {
    State.petiteCaisseDraft.justificatifBase64 = null;
    Render.screen();
  },

  async enregistrer() {
    const d = State.petiteCaisseDraft;
    const montant = parseFloat(d.montant);
    if (!montant || montant <= 0) {
      toast("Saisis un montant valide avant d'enregistrer", true);
      return;
    }
    if (!d.motif || !d.motif.trim()) {
      toast("Indique un motif avant d'enregistrer", true);
      return;
    }
    const ok = await Sync.sauvegarderPetiteCaisse(d);
    if (ok) {
      toast("Sortie de petite caisse enregistrée ✓");
      State.petiteCaisseDraft = nouveauPetiteCaisseDraft();
      Render.screen();
    }
  },

  ouvrirDetail(id) {
    const s = State.petiteCaisse.find(x => x.id === id);
    if (!s) return;
    this.detailId = id;
    Render.screen();
  },

  fermerDetail() {
    this.detailId = null;
    Render.screen();
  },

  async supprimer(id) {
    if (!confirm("Supprimer cette sortie de petite caisse ?")) return;
    const ok = await Sync.supprimerPetiteCaisse(id);
    if (ok) {
      toast("Sortie supprimée");
      this.detailId = null;
      Render.screen();
    }
  }
};

function renderPetiteCaisseDetailModal() {
  const s = State.petiteCaisse.find(x => x.id === PetiteCaisse.detailId);
  if (!s) return '';
  return `
  <div class="modal-overlay" onclick="if(event.target===this) PetiteCaisse.fermerDetail()">
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-title">${s.motif || 'Sortie de petite caisse'}</div>
      <div class="hist-meta" style="margin-bottom:14px;">${formatDateHeure(s.createdAt || Date.now())}${s.employe ? ' · ' + s.employe : ''}</div>

      ${s.justificatifBase64 ? `<img src="${s.justificatifBase64}" style="width:100%; border-radius:10px; border:1px solid var(--border); margin-bottom:14px;">` : ''}

      <div class="total-banner" style="background:var(--ecart-bad);">
        <span class="lbl">Montant sorti</span>
        <span class="val">${formatMontant(s.montant)}</span>
      </div>

      <button class="btn btn-primary" style="margin-top:14px;" onclick="Export.exporterRecuPetiteCaisse('${s.id}')">🧾 Imprimer un reçu</button>
      <button class="btn btn-danger" style="margin-top:10px; width:100%;" onclick="PetiteCaisse.supprimer('${s.id}')">🗑️ Supprimer</button>
      <button class="btn btn-ghost" style="margin-top:10px;" onclick="PetiteCaisse.fermerDetail()">Fermer</button>
    </div>
  </div>`;
}

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

  const optionsCaissesRapport = State.caisses.map(c => `<option value="${c}">${c}</option>`).join('');

  const carteRapport = `
    <div class="card">
      <div class="card-title">🖨️ Rapport journalier</div>
      <label>Date</label>
      <input type="text" value="${formatDate(State.rapportDate)}" readonly onclick="Hist.openRapportDatePicker()" style="background:#fafaf7;">
      <button class="btn btn-primary" onclick="Hist.genererRapportGlobal()">📊 Rapport global (toutes caisses)</button>
      <div class="divider-text" style="margin:14px 0 8px;">ou par caisse</div>
      <select id="rapportCaisseSelect" style="margin-bottom:10px;">${optionsCaissesRapport}</select>
      <button class="btn btn-secondary" onclick="Hist.genererRapportCaisse()">🖨️ Rapport de cette caisse</button>
      <div class="helper-text" style="margin-top:8px; margin-bottom:0;">Le rapport inclut les ouvertures, clôtures, tickets et écarts du jour — pratique à imprimer et agrafer avec les tickets TPE papier.</div>
    </div>
  `;

  const depots = montantsADeposerPour(State.rapportDate);
  const carteDepot = `
    <div class="card" style="border-color:var(--teal-light); background:#f5faf9;">
      <div class="card-title" style="color:var(--teal-dark);">💰 À déposer au coffre/banque — ${formatDate(State.rapportDate)}</div>
      ${depots.nbClotures === 0 ? `
        <div class="helper-text" style="margin-bottom:0;">Aucune clôture enregistrée pour cette date. Change la date ci-dessus (carte Rapport journalier) pour voir un autre jour.</div>
      ` : `
        ${depots.parCaisse.map(d => `
          <div class="hist-item" style="cursor:default; background:#fff;">
            <div class="hist-main">
              <div class="hist-titre">${d.caisse}</div>
              <div class="hist-meta">${d.heure || ''} · Total compté ${formatMontant(d.totalCompte)}</div>
            </div>
            <div class="hist-right">
              <div class="hist-montant" style="color:var(--teal-dark);">${formatMontant(d.aDeposer)}</div>
              ${d.manqueAuFond > 0 ? `<div class="hist-badge bad">manque ${formatMontant(d.manqueAuFond)}</div>` : ''}
            </div>
          </div>
        `).join('')}
        <div style="margin-top:12px; padding-top:12px; border-top:1.5px solid var(--teal-light); display:flex; align-items:center; justify-content:space-between;">
          <span style="font-weight:700; text-transform:uppercase; letter-spacing:.5px; font-size:12px; color:var(--teal-dark);">Total à déposer (toutes caisses)</span>
          <span style="font-family:'Cormorant',serif; font-size:28px; font-weight:700; color:var(--teal-dark);">${formatMontant(depots.totalGeneral)}</span>
        </div>
      `}
    </div>
  `;

  const chipsHtml = chipsCaisses.map(c => `
    <button class="filter-chip ${State.historyFilter.caisse===c?'active':''}" onclick="Hist.setFiltreCaisse('${c}')">
      ${c === 'toutes' ? 'Toutes les caisses' : c}
    </button>`).join('');

  const chipsPeriode = [['7j','7 jours'],['30j','30 jours'],['90j','3 mois'],['tout','Tout']].map(([k,l]) => `
    <button class="filter-chip ${State.historyFilter.periode===k?'active':''}" onclick="Hist.setFiltrePeriode('${k}')">${l}</button>
  `).join('');

  if (list.length === 0) {
    return `
      ${carteRapport}
      ${carteDepot}
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
    // Sur les lignes de clôture, on affiche en teal le montant à déposer
    // au coffre/banque (= total compté − montant cible du fond de caisse),
    // pour un repérage immédiat sans avoir à ouvrir le détail.
    const aDeposer = c.type === 'cloture'
      ? Math.max(0, (c.total || 0) - State.montantCibleFondCaisse)
      : null;
    const badgeDepot = aDeposer !== null
      ? `<span class="hist-badge" style="background:#eef6f5; color:var(--teal-dark); font-weight:700;">💰 ${formatMontant(aDeposer)}</span>`
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
          ${badgeDepot}
        </div>
      </div>`;
  }).join('');

  return `
    ${carteRapport}
    ${carteDepot}
    <div class="filter-bar">${chipsHtml}</div>
    <div class="filter-bar">${chipsPeriode}</div>
    <button class="btn btn-secondary" style="margin-bottom:14px;" onclick="Export.exporterExcel()">📊 Exporter en Excel (${list.length} comptage${list.length>1?'s':''})</button>
    ${items}
  `;
}

const Hist = {
  setFiltreCaisse(c) { State.historyFilter.caisse = c; Render.screen(); },
  setFiltrePeriode(p) { State.historyFilter.periode = p; Render.screen(); },

  openRapportDatePicker() {
    const input = document.createElement('input');
    input.type = 'date';
    input.value = State.rapportDate;
    input.style.position = 'fixed';
    input.style.top = '-100px';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      State.rapportDate = input.value;
      Render.screen();
      document.body.removeChild(input);
    });
    input.click();
    input.showPicker ? input.showPicker() : input.focus();
  },

  genererRapportGlobal() {
    Export.exporterRapportJournalier(State.rapportDate, null);
  },

  genererRapportCaisse() {
    const select = document.getElementById('rapportCaisseSelect');
    const caisse = select ? select.value : State.caisses[0];
    Export.exporterRapportJournalier(State.rapportDate, caisse);
  },

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
      caTheoriqueCB: c.caTheoriqueCB,
      caTheoriqueTR: c.caTheoriqueTR,
      caTheoriqueCV: c.caTheoriqueCV,
      caTheoriqueCQ: c.caTheoriqueCQ,
      fondDeCaisse: c.fondDeCaisse || 0,
      commentaire: c.commentaire || "",
      forcerOuverture: false,
      forcerCloture: false,
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

      ${MODES_PAIEMENT.filter(m => !m.compteEspeces).map(m => {
        const ec = c[m.champEcart];
        if (ec === null || ec === undefined) return '';
        return `
      <div class="ecart-box ${statutEcart(ec, State.seuilEcartAlerte)}" style="margin-top:8px;">
        <span class="lbl">Écart ${m.label} (relevé ${formatMontant(c[m.champTheorique]||0)})</span>
        <span class="val">${formatMontantSigne(ec)}</span>
      </div>`;
      }).join('')}

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
// Filtre les comptages de clôture (avec écart renseigné) selon la période
// choisie dans l'écran Stats — période fixe (7j/30j/90j/tout) ou plage de
// dates personnalisée choisie par l'utilisateur.
function clituresPourStats() {
  let list = State.comptages.filter(c => c.type === 'cloture');
  const periode = State.statsPeriode;
  if (periode === 'perso' && State.statsDateDebut && State.statsDateFin) {
    list = list.filter(c => c.date >= State.statsDateDebut && c.date <= State.statsDateFin);
  } else if (periode !== 'tout' && periode !== 'perso') {
    const now = Date.now();
    const jours = periode === '7j' ? 7 : periode === '30j' ? 30 : 90;
    const seuil = now - jours * 24 * 3600 * 1000;
    list = list.filter(c => (c.createdAt || 0) >= seuil);
  }
  return list;
}

// Calcule les alertes de récurrence : pour chaque caisse / employé, compte le
// nombre d'écarts non-"ok" (jaune+rouge confondus) sur les comptages filtrés,
// et signale ceux qui dépassent le seuil défini.
function calculerAlertesRecurrentes(list) {
  const grouper = (list, champ) => {
    const groupes = {};
    list.forEach(c => {
      const cle = c[champ] || '—';
      if (!groupes[cle]) groupes[cle] = { total: 0, nonOk: 0, ecartsMode: {} };
      MODES_PAIEMENT.forEach(m => {
        const ec = c[m.champEcart];
        if (ec === null || ec === undefined) return;
        groupes[cle].total++;
        if (statutEcart(ec, State.seuilEcartAlerte) !== 'ok') groupes[cle].nonOk++;
      });
    });
    return Object.entries(groupes)
      .map(([nom, v]) => ({ nom, ...v }))
      .filter(g => g.nonOk >= State.seuilAlertesRecurrentes)
      .sort((a,b) => b.nonOk - a.nonOk);
  };
  return {
    parCaisse: grouper(list, 'caisse'),
    parEmploye: grouper(list, 'employe')
  };
}

function renderEcranStats() {
  const list = clituresPourStats().filter(c => c.ecart !== null && c.ecart !== undefined);
  const alertes = calculerAlertesRecurrentes(clituresPourStats());

  const chipsPeriode = [['7j','7 jours'],['30j','30 jours'],['90j','3 mois'],['tout','Tout'],['perso','Période perso']].map(([k,l]) => `
    <button class="filter-chip ${State.statsPeriode===k?'active':''}" onclick="Stats.setPeriode('${k}')">${l}</button>
  `).join('');

  const datesPerso = State.statsPeriode === 'perso' ? `
    <div class="card">
      <div class="card-title">Période personnalisée</div>
      <div class="field-row">
        <div>
          <label>Du</label>
          <input type="date" value="${State.statsDateDebut || ''}" onchange="Stats.setDatePerso('debut', this.value)">
        </div>
        <div>
          <label>Au</label>
          <input type="date" value="${State.statsDateFin || ''}" onchange="Stats.setDatePerso('fin', this.value)">
        </div>
      </div>
    </div>
  ` : '';

  const renderAlertes = (titre, liste, icone) => {
    if (liste.length === 0) return '';
    const lignes = liste.map(a => `
      <div class="hist-item" style="cursor:default; border-color:var(--ecart-warn);">
        <div class="hist-main">
          <div class="hist-titre">${icone} ${a.nom}</div>
          <div class="hist-meta">${a.nonOk} écart${a.nonOk>1?'s':''} non-juste${a.nonOk>1?'s':''} sur ${a.total} rapprochement${a.total>1?'s':''}</div>
        </div>
        <div class="hist-right">
          <span class="hist-badge warn">⚠ récurrent</span>
        </div>
      </div>`).join('');
    return `
      <div class="card" style="border-color:var(--ecart-warn);">
        <div class="card-title" style="color:var(--ecart-warn);">${titre}</div>
        ${lignes}
      </div>`;
  };

  const alertesHtml = renderAlertes('⚠ Alertes — caisses', alertes.parCaisse, '🗄️') + renderAlertes('⚠ Alertes — employés', alertes.parEmploye, '👤');

  if (list.length === 0) {
    return `
      <div class="filter-bar">${chipsPeriode}</div>
      ${datesPerso}
      <div class="empty-state">
        <div class="ic">📊</div>
        <p><strong>Pas encore de données pour cette période</strong></p>
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
    <div class="filter-bar">${chipsPeriode}</div>
    ${datesPerso}

    ${alertesHtml}

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

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Réglage des alertes récurrentes</div>
      <label>Déclencher une alerte à partir de combien d'écarts non-justes (jaune ou rouge) ?</label>
      <input type="number" inputmode="numeric" min="1" step="1" value="${State.seuilAlertesRecurrentes}"
             onchange="Stats.setSeuilRecurrence(this.value)">
      <div class="helper-text" style="margin-bottom:0;">S'applique séparément à chaque caisse et à chaque employé, sur la période sélectionnée ci-dessus.</div>
    </div>
  `;
}

/* ================================================================
   SECTION 12 — RENDU : ÉCRAN "RÉGLAGES"
   ================================================================ */
const Stats = {
  setPeriode(p) {
    State.statsPeriode = p;
    if (p === 'perso' && !State.statsDateDebut) {
      const aujourdhui = new Date().toISOString().slice(0,10);
      State.statsDateDebut = aujourdhui;
      State.statsDateFin = aujourdhui;
    }
    Render.screen();
  },
  setDatePerso(champ, value) {
    if (champ === 'debut') State.statsDateDebut = value;
    else State.statsDateFin = value;
    Render.screen();
  },
  setSeuilRecurrence(value) {
    const v = parseInt(value, 10);
    State.seuilAlertesRecurrentes = isNaN(v) || v < 1 ? 2 : v;
    Render.screen();
  }
};

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

    <div class="card">
      <div class="card-title">Montant cible du fond de caisse</div>
      <label>Montant à laisser en caisse après le retrait de clôture (€)</label>
      <input type="number" inputmode="decimal" step="1" min="0" value="${State.montantCibleFondCaisse}"
             onchange="Reglages.setMontantCible(this.value)">
      <div class="helper-text">À la clôture, l'app calcule combien retirer du tiroir pour ramener la caisse à ce montant, prêt pour la prochaine ouverture.</div>
    </div>

    <div class="card">
      <div class="card-title">Déconnexion automatique par inactivité</div>
      <label>Délai d'inactivité avant déconnexion (minutes) — 0 pour désactiver</label>
      <input type="number" inputmode="numeric" step="1" min="0" value="${State.delaiInactiviteMinutes}"
             onchange="Reglages.setDelaiInactivite(this.value)">
      <div class="helper-text">Si aucune interaction pendant ce délai, l'app redemande le PIN de connexion. Pratique pour sécuriser les caisses entre deux utilisateurs. Mettre 0 pour désactiver complètement.</div>
    </div>

    <div class="helper-text" style="text-align:center; margin-top:4px;">✓ Toutes les modifications sont enregistrées automatiquement</div>

    <div class="divider-text">À propos</div>
    <div class="card" style="text-align:center;">
      <div style="font-size:13px; color:var(--ink-soft); line-height:1.6;">
        Comptage Caisse — Smoke & Smile<br>
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

  setMontantCible(value) {
    const v = parseFloat(value);
    State.montantCibleFondCaisse = isNaN(v) ? 0 : Math.max(0, v);
    Sync.sauvegarderConfig();
  },

  setDelaiInactivite(value) {
    const v = parseInt(value, 10);
    State.delaiInactiviteMinutes = isNaN(v) ? 0 : Math.max(0, v);
    Minuteur.relancer(); // repart avec le nouveau délai immédiatement
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
  // Génère le HTML d'un bloc "caisse" pour le rapport journalier — réutilisé
  // aussi bien pour le rapport global (un bloc par caisse) que pour le
  // rapport d'une caisse unique (un seul bloc).
  _blocRapportCaisse(d) {
    const ligneOuverture = d.ouvertures.map(c => `
      <tr><td>Ouverture ${c.heure || ''} (${c.service})</td><td style="text-align:right;">${formatMontant(c.total)}</td></tr>
    `).join('');

    const ligneCloture = d.clotures.map(c => {
      const statut = statutEcart(c.ecart, State.seuilEcartAlerte);
      const ecartsAutres = MODES_PAIEMENT.filter(m => !m.compteEspeces).map(m => {
        const ec = c[m.champEcart];
        if (ec === null || ec === undefined) return '';
        return `<tr><td style="padding-left:18px; font-size:12.5px; color:#6b6258;">Écart ${m.label}</td><td style="text-align:right; font-size:12.5px; color:${statutEcart(ec, State.seuilEcartAlerte)==='ok'?'#2d7d4f':'#b6402f'};">${formatMontantSigne(ec)}</td></tr>`;
      }).join('');
      return `
        <tr><td>Clôture ${c.heure || ''} (${c.service})</td><td style="text-align:right;">${formatMontant(c.total)}</td></tr>
        <tr><td style="padding-left:18px; font-size:12.5px; color:#6b6258;">Écart espèces</td><td style="text-align:right; font-size:12.5px; color:${statut==='ok'?'#2d7d4f':'#b6402f'};">${c.ecart!==null&&c.ecart!==undefined?formatMontantSigne(c.ecart):'—'}</td></tr>
        ${ecartsAutres}
      `;
    }).join('');

    const lignesModesTickets = MODES_PAIEMENT.filter(m => (d.totauxParMode[m.cle]||0) > 0).map(m => `
      <tr><td>${m.icone} ${m.label}</td><td style="text-align:right;">${formatMontant(d.totauxParMode[m.cle])}</td></tr>
    `).join('');

    const ticketsTries = [...d.ticketsJour].sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
    const ligneTicket = (t) => {
      const info = modeInfo(t.mode);
      return `<tr><td style="padding-left:10px; color:#6b6258;">${t.heure || ''} ${info.icone}${t.employe ? ' ' + t.employe.slice(0,4) : ''}</td><td style="text-align:right; color:#6b6258;">${formatMontant(t.montant)}</td></tr>`;
    };
    const milieu = Math.ceil(ticketsTries.length / 2);
    const colonne1 = ticketsTries.slice(0, milieu).map(ligneTicket).join('');
    const colonne2 = ticketsTries.slice(milieu).map(ligneTicket).join('');

    return `
      <div class="bloc-caisse">
        <h2>${d.caisse}</h2>

        ${d.ouvertures.length === 0 && d.clotures.length === 0 ? `
          <div style="font-size:11px; color:#6b6258; font-style:italic;">Aucun comptage enregistré ce jour pour cette caisse.</div>
        ` : `
          <table class="pdf-table">
            ${ligneOuverture}
            ${ligneCloture}
          </table>
        `}

        ${d.nbTickets > 0 ? `
          <div class="section-title">Tickets saisis (${d.nbTickets})</div>
          <table class="pdf-table">
            ${lignesModesTickets}
            <tr style="font-weight:700;"><td>TOTAL TICKETS</td><td style="text-align:right;">${formatMontant(d.totalGeneralTickets)}</td></tr>
          </table>
          <div class="detail-tickets">
            <table class="pdf-table">${colonne1}</table>
            <table class="pdf-table">${colonne2}</table>
          </div>
        ` : `<div class="helper-text">Aucun ticket saisi ce jour pour cette caisse.</div>`}
      </div>`;
  },

  exporterRapportJournalier(date, caisse) {
    // caisse = null pour le rapport global (toutes caisses), ou un nom précis
    const caissesAInclure = caisse ? [caisse] : State.caisses;
    const blocs = caissesAInclure.map(c => this._blocRapportCaisse(donneesJourPour(date, c))).join('');

    // Total général toutes caisses confondues (utile surtout en mode global)
    const dGlobal = donneesJourPour(date, caisse || null);
    const totalGlobalHtml = !caisse ? `
      <div class="total-row"><span>TOTAL TICKETS — TOUTES CAISSES</span><span>${formatMontant(dGlobal.totalGeneralTickets)}</span></div>
    ` : '';

    const win = window.open('', '_blank');
    win.document.write(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
      <meta charset="UTF-8">
      <title>Rapport journalier — ${formatDate(date)}${caisse ? ' — ' + caisse : ''}</title>
      <style>
        *{box-sizing:border-box;}
        body{font-family:Georgia,'Times New Roman',serif; color:#2A2521; padding:18px 22px; max-width:680px; margin:0 auto; font-size:12px; line-height:1.3;}
        h1{font-size:17px; margin:0 0 1px;}
        h2{font-family:'Georgia',serif; font-size:14px; margin:0 0 5px;}
        .sub{color:#6b6258; font-size:11px; margin-bottom:10px;}
        table.pdf-table{width:100%; border-collapse:collapse; margin-bottom:4px;}
        table.pdf-table td{padding:2px 4px; border-bottom:1px solid #e8e2d4; font-size:11px;}
        .section-title{font-size:10px; text-transform:uppercase; letter-spacing:.4px; font-weight:700; color:#1F5C5A; margin:8px 0 3px; border-bottom:1.5px solid #1F5C5A; padding-bottom:2px;}
        .total-row{display:flex; justify-content:space-between; padding:6px 0; border-top:1.5px solid #163f3e; border-bottom:1.5px solid #163f3e; font-weight:700; font-size:13px; margin-top:8px;}
        .meta{display:flex; justify-content:space-between; font-size:10px; color:#6b6258; margin-top:10px; border-top:1px solid #e8e2d4; padding-top:6px;}
        .zone-agrafe{margin-top:14px; padding:10px; border:1.5px dashed #c9bfa9; border-radius:6px; text-align:center; color:#a89c84; font-size:10.5px;}
        .helper-text{font-size:10.5px; color:#6b6258;}
        .bloc-caisse{margin-bottom:10px; padding-bottom:8px; border-bottom:1.5px dashed #c9bfa9;}
        .detail-tickets{display:grid; grid-template-columns:1fr 1fr; gap:0 14px;}
        .detail-tickets table.pdf-table td{font-size:10px; padding:1px 3px;}
        @media print{
          body{padding:8mm 10mm; font-size:11px;}
          .zone-agrafe{page-break-inside:avoid;}
          .bloc-caisse{page-break-inside:avoid;}
        }
      </style>
      </head>
      <body>
        <h1>Smoke &amp; Smile — Rapport journalier</h1>
        <div class="sub">${formatDate(date)} — ${caisse ? caisse : 'Toutes les caisses'}</div>

        ${blocs}
        ${totalGlobalHtml}

        <div class="zone-agrafe">📎 Agrafer ici les tickets TPE / relevés de caisse papier de la journée</div>

        <div class="meta">
          <span>Généré le ${formatDateHeure(Date.now())} par ${State.employeActif ? State.employeActif.nom : '—'}</span>
          <span>Smoke & Smile</span>
        </div>

        <script>window.onload = function(){ window.print(); };</script>
      </body>
      </html>
    `);
    win.document.close();
  },

  exporterRecuPetiteCaisse(id) {
    const s = State.petiteCaisse.find(x => x.id === id);
    if (!s) { toast("Sortie introuvable", true); return; }

    const photoHtml = s.justificatifBase64 ? `
      <div style="margin-top:18px;">
        <div class="section-title">Justificatif</div>
        <img src="${s.justificatifBase64}" style="width:100%; max-width:300px; border:1px solid #e2d9c8; border-radius:6px;">
      </div>` : '';

    const win = window.open('', '_blank');
    win.document.write(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
      <meta charset="UTF-8">
      <title>Reçu petite caisse — ${formatDate(s.date)}</title>
      <style>
        body{font-family:Georgia,'Times New Roman',serif; color:#2A2521; padding:40px; max-width:480px; margin:0 auto;}
        h1{font-size:20px; margin-bottom:2px; color:#163f3e;}
        .sub{color:#6b6258; font-size:13px; margin-bottom:24px;}
        table.pdf-table{width:100%; border-collapse:collapse; margin-bottom:8px;}
        table.pdf-table td{padding:7px 4px; border-bottom:1px solid #e2d9c8; font-size:14px;}
        .section-title{font-size:12px; text-transform:uppercase; letter-spacing:.6px; font-weight:700; color:#1F5C5A; margin:18px 0 6px; border-bottom:2px solid #1F5C5A; padding-bottom:4px;}
        .total-row{display:flex; justify-content:space-between; padding:12px 0; border-top:2px solid #163f3e; border-bottom:2px solid #163f3e; font-weight:700; font-size:18px; margin-top:10px; color:#b6402f;}
        .meta{font-size:12px; color:#6b6258; margin-top:30px; border-top:1px solid #e2d9c8; padding-top:10px;}
        @media print{ body{padding:15mm;} }
      </style>
      </head>
      <body>
        <h1>Smoke &amp; Smile — Reçu petite caisse</h1>
        <div class="sub">Justificatif interne de sortie d'argent — pas un ticket de vente</div>

        <table class="pdf-table">
          <tr><td>Date</td><td style="text-align:right;">${formatDateHeure(s.createdAt || Date.now())}</td></tr>
          <tr><td>Motif</td><td style="text-align:right;">${s.motif || '—'}</td></tr>
          <tr><td>Pris par</td><td style="text-align:right;">${s.employe || '—'}</td></tr>
        </table>

        <div class="total-row"><span>MONTANT SORTI</span><span>${formatMontant(s.montant)}</span></div>

        ${photoHtml}

        <div class="meta">Document généré le ${formatDateHeure(Date.now())} — usage interne uniquement</div>

        <script>window.onload = function(){ window.print(); };</script>
      </body>
      </html>
    `);
    win.document.close();
  },

  exporterExcel() {
    const list = comptagesFiltres();
    if (list.length === 0) { toast("Rien à exporter pour ces filtres", true); return; }
    if (typeof XLSX === 'undefined') { toast("Module Excel indisponible (vérifie ta connexion)", true); return; }

    const rows = list.map(c => {
      const row = {
        "Date": formatDate(c.date),
        "Heure": c.heure || "",
        "Caisse": c.caisse,
        "Type": c.type === 'fond' ? 'Ouverture' : 'Clôture',
        "Service": c.service,
        "Compté par": c.employe || "",
        "Fond de caisse (€)": c.fondDeCaisse || 0,
        "CA théorique espèces (€)": c.caTheorique === null || c.caTheorique === undefined ? "" : c.caTheorique,
        "Total compté (€)": c.total,
        "Écart espèces (€)": c.ecart === null || c.ecart === undefined ? "" : c.ecart
      };
      MODES_PAIEMENT.filter(m => !m.compteEspeces).forEach(m => {
        row["Relevé " + m.label + " (€)"] = c[m.champTheorique] === null || c[m.champTheorique] === undefined ? "" : c[m.champTheorique];
        row["Écart " + m.label + " (€)"] = c[m.champEcart] === null || c[m.champEcart] === undefined ? "" : c[m.champEcart];
      });
      row["Commentaire"] = c.commentaire || "";
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
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
          "Mode": modeInfo(t.mode).label,
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

  exporterPdf(id, idOuvertureAssociee, fenetrePreOuverte) {
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

    const ecartCBHtml = MODES_PAIEMENT.filter(m => !m.compteEspeces).map(m => {
      const ec = c[m.champEcart];
      if (ec === null || ec === undefined) return '';
      const st = statutEcart(ec, State.seuilEcartAlerte);
      return `
      <table class="pdf-table" style="margin-top:10px;">
        <tr><td>Relevé ${m.label}</td><td style="text-align:right;">${formatMontant(c[m.champTheorique]||0)}</td></tr>
        <tr style="font-weight:700; color:${st==='ok'?'#2d7d4f':st==='warn'?'#c19a2e':'#b6402f'};">
          <td>ÉCART ${m.label.toUpperCase()}</td><td style="text-align:right;">${formatMontantSigne(ec)}</td>
        </tr>
      </table>`;
    }).join('');

    const commentaireHtml = c.commentaire ? `
      <div style="margin-top:16px; padding:12px; background:#f7f2ea; border-radius:8px; font-size:13px;">
        <strong>Commentaire :</strong> ${c.commentaire}
      </div>` : '';

    // Si une ouverture associée est fournie (ou retrouvable automatiquement),
    // on filtre les tickets par plage horaire RÉELLE entre l'ouverture et la
    // clôture — plus précis que le filtrage par service, qui peut chevaucher
    // un changement de service en cours de cycle. Sinon, on retombe sur le
    // filtrage par service (comportement historique, pour rétrocompatibilité).
    let ouvertureAssociee = null;
    if (c.type === 'cloture') {
      if (idOuvertureAssociee) {
        ouvertureAssociee = State.comptages.find(x => x.id === idOuvertureAssociee) || null;
      } else {
        // Retrouve automatiquement la dernière ouverture de cette caisse
        // antérieure à cette clôture (au cas où l'id n'a pas été transmis).
        ouvertureAssociee = State.comptages
          .filter(x => x.type === 'fond' && normaliserNomCaisse(x.caisse) === normaliserNomCaisse(c.caisse) && (x.createdAt||0) <= (c.createdAt||0))
          .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))[0] || null;
      }
    }

    const ticketsTries = ouvertureAssociee
      ? ticketsEntreOuvertureEtCloture(c.caisse, ouvertureAssociee.createdAt || 0, c.createdAt || Date.now())
      : State.tickets
          .filter(t => t.caisse === c.caisse && t.service === c.service && t.date === c.date)
          .sort((a,b) => (a.createdAt||0) - (b.createdAt||0));

    const totauxParModeCycle = {};
    let totalCycle = 0;
    MODES_PAIEMENT.forEach(m => {
      const somme = ticketsTries.reduce((s, t) => s + (t.mode === m.cle ? t.montant : 0), 0);
      totauxParModeCycle[m.cle] = Math.round(somme * 100) / 100;
      totalCycle += somme;
    });
    const lignesModesTickets = MODES_PAIEMENT.filter(m => (totauxParModeCycle[m.cle]||0) > 0).map(m => `
      <tr><td>${m.icone} ${m.label}</td><td style="text-align:right;">${formatMontant(totauxParModeCycle[m.cle])}</td></tr>
    `).join('');
    const ligneTicketDetail = (t) => {
      const info = modeInfo(t.mode);
      return `<tr><td style="padding-left:10px; color:#6b6258;">${t.heure || ''} ${info.icone}${t.employe ? ' ' + t.employe.slice(0,6) : ''}</td><td style="text-align:right; color:#6b6258;">${formatMontant(t.montant)}</td></tr>`;
    };
    const milieuTickets = Math.ceil(ticketsTries.length / 2);
    const colonneTickets1 = ticketsTries.slice(0, milieuTickets).map(ligneTicketDetail).join('');
    const colonneTickets2 = ticketsTries.slice(milieuTickets).map(ligneTicketDetail).join('');

    const sousTitreTickets = ouvertureAssociee
      ? `de l'ouverture (${ouvertureAssociee.heure || formatDateHeure(ouvertureAssociee.createdAt)}) à la clôture (${c.heure || formatDateHeure(c.createdAt)})`
      : c.service;

    const ticketsHtml = (c.type === 'cloture' && ticketsTries.length > 0) ? `
      <div class="section-title" style="margin-top:18px;">Tickets saisis (${ticketsTries.length}) — ${sousTitreTickets}</div>
      <table class="pdf-table">
        ${lignesModesTickets}
        <tr style="font-weight:700;"><td>TOTAL TICKETS</td><td style="text-align:right;">${formatMontant(Math.round(totalCycle*100)/100)}</td></tr>
      </table>
      <div class="detail-tickets">
        <table class="pdf-table">${colonneTickets1}</table>
        <table class="pdf-table">${colonneTickets2}</table>
      </div>
    ` : (c.type === 'cloture' ? `<div class="helper-text" style="margin-top:14px;">Aucun ticket saisi pendant ce cycle de caisse.</div>` : '');

    // Si une fenêtre a déjà été ouverte en amont (cas de l'impression
    // automatique à la clôture, pour éviter le blocage popup des
    // navigateurs sur les ouvertures asynchrones), on la réutilise.
    // Sinon (bouton manuel "Imprimer", clic direct), on en ouvre une.
    const win = fenetrePreOuverte || window.open('', '_blank');
    if (!win) {
      toast("La fenêtre d'impression a été bloquée par le navigateur — autorise les popups pour ce site", true);
      return;
    }
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
        .detail-tickets{display:grid; grid-template-columns:1fr 1fr; gap:0 14px; margin-top:6px;}
        .detail-tickets table.pdf-table td{font-size:11px; padding:2px 4px;}
        .helper-text{font-size:12px; color:#6b6258;}
        @media print{ body{padding:15mm;} }
      </style>
      </head>
      <body>
        <h1>Smoke &amp; Smile — État de caisse</h1>
        <div class="sub">${c.caisse} · ${c.type === 'fond' ? 'Ouverture' : 'Clôture'} · ${formatDateHeure(c.createdAt || Date.now())} · ${c.service}${c.employe ? ' · Compté par ' + c.employe : ''}</div>

        ${lignesBillets ? `<div class="section-title">Billets</div><table class="pdf-table">${lignesBillets}</table>` : ''}
        ${lignesPieces ? `<div class="section-title">Pièces</div><table class="pdf-table">${lignesPieces}</table>` : ''}

        <div class="total-row"><span>TOTAL COMPTÉ</span><span>${formatMontant(c.total)}</span></div>

        ${ecartHtml}
        ${ecartCBHtml}
        ${ticketsHtml}
        ${commentaireHtml}

        <div class="meta">
          <span>Document généré le ${formatDateHeure(Date.now())}</span>
          <span>Smoke & Smile</span>
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
    if (ECRANS_RESERVES_ADMIN.includes(State.currentScreen) && !estAdmin()) {
      State.currentScreen = 'nouveau';
      State.draft = nouveauDraft();
      Nav.updateActiveTab('nouveau');
    }
    const el = document.getElementById('screen');
    let html = '';
    switch (State.currentScreen) {
      case 'nouveau': html = renderEcranNouveau(); break;
      case 'tickets': html = renderEcranTickets(); break;
      case 'petitecaisse': html = renderEcranPetiteCaisse(); break;
      case 'historique': html = renderEcranHistorique(); break;
      case 'stats': html = renderEcranStats(); break;
      case 'reglages': html = renderEcranReglages(); break;
      default: html = renderEcranNouveau();
    }
    el.innerHTML = html
      + (State.editingHistId ? renderDetailModal() : '')
      + (State.currentScreen === 'petitecaisse' && PetiteCaisse.detailId ? renderPetiteCaisseDetailModal() : '');

    const sub = document.getElementById('topbarSub');
    if (sub) {
      const titreEcran = {
        nouveau: 'Nouveau comptage',
        tickets: 'Saisie des tickets',
        petitecaisse: 'Petite caisse',
        historique: 'Historique des comptages',
        stats: "Statistiques d'écarts",
        reglages: 'Réglages'
      }[State.currentScreen] || 'Smoke & Smile';
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
/* ================================================================
   MODULE MINUTEUR D'INACTIVITÉ
   Déclenche une déconnexion automatique si aucune interaction
   n'est détectée pendant le délai configuré dans les Réglages.
   Le minuteur se relance à chaque clic ou toucher sur l'app.
   ================================================================ */
const Minuteur = {
  _timer: null,
  _timerNuit: null,
  _HEURE_REMISE_A_ZERO: 5, // 5h du matin
  _CLE_REMISE: 'caisseMarmiteRemiseZeroDate', // date de la dernière remise en localStorage

  // Relance le minuteur d'inactivité. Appelé à chaque interaction (clic,
  // toucher) et à chaque changement de délai dans les Réglages.
  relancer() {
    if (this._timer) clearTimeout(this._timer);
    const delaiMs = State.delaiInactiviteMinutes * 60 * 1000;
    if (delaiMs <= 0 || !State.employeActif) return;
    this._timer = setTimeout(() => this._expirer(), delaiMs);
  },

  // Stoppe le minuteur d'inactivité (à la déconnexion manuelle).
  stopper() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },

  _expirer() {
    if (!State.employeActif) return;
    const nom = State.employeActif.nom;
    State.employeActif = null;
    localStorage.removeItem(SESSION_KEY);
    this._timer = null;
    toast(nom + " — déconnecté automatiquement après inactivité");
    Nav.updateActiveTab('nouveau');
    Auth.ouvrirEcranConnexion();
  },

  // Vérifie si la remise à zéro quotidienne (5h) doit être déclenchée,
  // et programme le prochain déclenchement. Appelé au démarrage de l'app
  // et à chaque reprise de focus (visibilitychange).
  verifierRemiseQuotidienne() {
    if (this._timerNuit) clearTimeout(this._timerNuit);

    const maintenant = new Date();
    const dateAujourdhui = maintenant.toISOString().slice(0, 10);
    const derniereRemise = localStorage.getItem(this._CLE_REMISE) || '';

    // Si on est après 5h et qu'on n'a pas encore fait la remise aujourd'hui,
    // on la déclenche immédiatement.
    if (maintenant.getHours() >= this._HEURE_REMISE_A_ZERO && derniereRemise !== dateAujourdhui) {
      this._remettreAZero();
    }

    // Programme le prochain déclenchement à 5h (demain si on est déjà passé 5h,
    // aujourd'hui sinon).
    const prochaine5h = new Date(maintenant);
    if (maintenant.getHours() >= this._HEURE_REMISE_A_ZERO) {
      prochaine5h.setDate(prochaine5h.getDate() + 1);
    }
    prochaine5h.setHours(this._HEURE_REMISE_A_ZERO, 0, 5, 0); // 05:00:05 pour éviter les micro-décalages
    const msAvant5h = prochaine5h - maintenant;

    this._timerNuit = setTimeout(() => {
      this._remettreAZero();
      this.verifierRemiseQuotidienne(); // reprogramme pour le lendemain
    }, msAvant5h);
  },

  _remettreAZero() {
    const dateAujourdhui = new Date().toISOString().slice(0, 10);
    localStorage.setItem(this._CLE_REMISE, dateAujourdhui);

    // 1. Remet la date du contexte Tickets sur aujourd'hui, pour que l'écran
    //    repart sur une page vierge du jour (plus de tickets de la veille).
    if (State.ticketContexte) {
      State.ticketContexte.date = dateAujourdhui;
    }

    // 2. Déconnecte tous les employés — chacun devra rerentrer son PIN.
    if (State.employeActif) {
      State.employeActif = null;
      localStorage.removeItem(SESSION_KEY);
      this.stopper();
      toast("Bonne journée ! Remise à zéro automatique des caisses à 5h — reconnectez-vous pour commencer.");
      Nav.updateActiveTab('nouveau');
      Auth.ouvrirEcranConnexion();
    } else {
      // Même sans employé connecté, on remet la date à jour pour que la
      // prochaine personne qui se connecte parte sur la bonne date.
      if (State.ticketContexte) {
        if (!State.draft) State.draft = nouveauDraft();
        Render.screen();
      }
    }
  }
};

async function initApp() {
  State.draft = nouveauDraft();
  Nav.updateActiveTab('nouveau');

  // Charge la file d'attente locale avant tout (disponible même hors-ligne)
  FileAttente.charger();

  // Affiche l'écran de saisie immédiatement (utilisable hors-ligne)
  Render.screen();

  // Charge la config, les employés et l'historique en arrière-plan
  await Sync.chargerConfig();
  await Sync.chargerEmployes();
  State.draft = nouveauDraft(); // ré-applique caisses/services/employé à jour
  await Sync.chargerComptages();
  await Sync.chargerTickets();
  await Sync.chargerPetiteCaisse();

  // Réinjecte les tickets en attente (non encore dans Firestore) en tête de
  // liste, pour qu'ils restent visibles même après le rechargement depuis le serveur.
  State.ticketsEnAttente.forEach(item => {
    State.tickets.unshift({ id: item.idLocal, ...item.payload, _enAttente: true });
  });

  if (State.currentScreen === 'nouveau') Render.screen();

  // Tente une synchronisation immédiate des tickets en attente (au cas où
  // la connexion serait déjà disponible depuis le dernier passage hors-ligne)
  FileAttente.tenterSynchronisation();

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

  // Écoute tous les clics/touches sur l'app pour relancer le minuteur
  // d'inactivité à chaque interaction de l'utilisateur.
  if (typeof document !== 'undefined' && document.addEventListener) {
    ['click', 'touchstart', 'keydown'].forEach(evt => {
      document.addEventListener(evt, () => Minuteur.relancer(), { passive: true });
    });
    // Quand l'utilisateur revient sur l'onglet (ex: app laissée ouverte la
    // nuit), on re-vérifie si la remise à zéro quotidienne est due.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        Minuteur.verifierRemiseQuotidienne();
      }
    });
  }

  // Lance la vérification de remise à zéro quotidienne (5h du matin)
  Minuteur.verifierRemiseQuotidienne();

  // Réécoute les changements de connectivité du navigateur pour resynchroniser
  // automatiquement dès que le réseau revient, sans attendre une action de l'utilisateur.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
      toast("Connexion rétablie — synchronisation en cours...");
      FileAttente.tenterSynchronisation();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
