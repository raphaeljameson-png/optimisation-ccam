// Chemin complet : src/App.jsx
// Version : Optim'CCAM v4.5 — Moteur de recherche avancé (Accents, Préfixes & Alias Médicaux)

import { useState, useEffect, useRef } from 'react';
import './App.css';
import { auth, db } from './firebase';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail,
  deleteUser, GoogleAuthProvider, signInWithPopup
} from 'firebase/auth';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  writeBatch, collection, query, where, getDocs,
  addDoc, orderBy, limit, startAt, endAt, increment, onSnapshot
} from 'firebase/firestore';
import Papa from 'papaparse';
import { QRCodeCanvas } from 'qrcode.react';

const LOGO_URL    = "https://www.institutorthopedique.paris/wp-content/uploads/2025/07/CROPinstitut-orthopedique-paris-logo-grand.png";
const ADMIN_EMAIL = "dr.jameson@rachis.paris";

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const normalizeText = (text) => text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim() : "";

// ─── CALCUL CCAM DYNAMIQUE ───────────────────────────────────────────────────
const computeActs = (acts, userSecteur, isOptam, userSpecialite) =>
  [...acts]
    .map(act => {
      let majo = 1;
      if (act.activeModifiers?.K)      majo = 1.2;
      else if (act.activeModifiers?.J) majo = 1.115;
      if (act.activeModifiers?.U)      majo += 0.1;

      let baseTarif = (userSecteur === '1' || isOptam) ? act.tarifSecteur1 : act.tarifSecteur2;

      if (userSpecialite === '2' && act.activite === '1') {
        baseTarif = baseTarif * 0.25;
      } else if (userSpecialite === '1' && act.activite === '2') {
        baseTarif = baseTarif * 4; 
      }

      return { ...act, baseMajore: baseTarif * majo };
    })
    .sort((a, b) => b.baseMajore - a.baseMajore)
    .map((act, i) => ({ ...act, coeff: i === 0 ? 1 : 0.5, baseRetenue: act.baseMajore * (i === 0 ? 1 : 0.5) }));

const computeTotal = (calc) => calc.reduce((s, a) => s + a.baseRetenue, 0);
const computeDep   = (feeType, feeValue, base) =>
  feeType === 'amount' ? (parseFloat(feeValue) || 0) : base * ((parseFloat(feeValue) || 0) / 100);

// ─── RECHERCHE CCAM ULTRA-ROBUSTE ───────────────────────────────────────────
const searchCCAM = async (term, specialite, maxResults = 15) => {
  if (!term || term.trim().length < 2) return [];
  const normalizedTerm = normalizeText(term);

  // 1. Code exact
  if (/^[A-Z]{4}\d{3}$/.test(normalizedTerm)) {
    try {
      const snap = await getDocs(query(collection(db, "actes_ccam"), where("code", "==", normalizedTerm), where("activite", "==", specialite)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { return []; }
  }

  const seen = new Map();
  const queries = [];

  // 2. Préfixe de code
  if (/^[A-Z]{1,4}\d{0,3}$/.test(normalizedTerm)) {
    queries.push(getDocs(query(collection(db, "actes_ccam"), where("activite", "==", specialite), orderBy("code"), startAt(normalizedTerm), endAt(normalizedTerm + '\uf8ff'), limit(maxResults))));
  }

  // 3. Recherche Intelligente par mots-clés (Insensible aux accents)
  const searchWords = normalizedTerm.split(/[^A-Z0-9]+/).filter(w => w.length > 1);
  
  if (searchWords.length > 0) {
    const bestWord = searchWords.reduce((a, b) => a.length > b.length ? a : b);
    queries.push(getDocs(query(
      collection(db, "actes_ccam"),
      where("activite", "==", specialite),
      where("motsCles", "array-contains", bestWord),
      limit(400) // On ratisse large pour trouver des correspondances multi-mots
    )));
  }

  try {
    const snaps = await Promise.all(queries);
    snaps.forEach((snap) => {
      snap.docs.forEach(d => {
        const data = d.data();
        if (!seen.has(d.id)) {
          let match = true;
          if (searchWords.length > 0) {
             const libSearch = data.libelleSearch || normalizeText(data.libelle);
             const motsCles = data.motsCles || [];
             for (let i = 0; i < searchWords.length; i++) {
                const w = searchWords[i];
                // Vérifie le dictionnaire d'alias ou le texte exact
                if (!motsCles.includes(w) && !libSearch.includes(w)) {
                   match = false;
                   break;
                }
             }
          }
          if (match) seen.set(d.id, { id: d.id, ...data });
        }
      });
    });
  } catch (error) { console.error(error); }

  return [...seen.values()].slice(0, maxResults);
};

// ─── SOUS-COMPOSANTS ──────────────────────────────────────────────────────────
function ModifierChip({ label, active, onChange }) {
  return (
    <label className={`modifier-chip${active ? ' modifier-chip--active' : ''}`}>
      <input type="checkbox" checked={active} onChange={onChange} style={{ display: 'none' }} />
      {label}
    </label>
  );
}

function ActCard({ act, index, onRemove, onModifierChange }) {
  const isPrimary = index === 0;
  return (
    <div className={`act-card ${isPrimary ? 'act-card--primary' : 'act-card--secondary'}`}>
      <div className="act-card__header">
        <span className="act-card__code">{act.code}</span>
        <span className="act-card__coeff">{isPrimary ? '100% — Acte principal' : '50% — Acte associé'}</span>
        <button className="act-card__remove" onClick={onRemove}>×</button>
      </div>
      <div className="act-card__libelle">{act.libelle}</div>
      <div className="modifiers">
        {['J', 'K', 'U'].map(m => (
          <ModifierChip key={m} label={`Modif ${m}${m==='J' ? ' +11.5%' : m==='K' ? ' +20%' : ' +10%'}`} active={!!act.activeModifiers?.[m]} onChange={onModifierChange(m)} />
        ))}
      </div>
      {act.baseRetenue !== undefined && (
        <div className="act-card__base">Base retenue : <strong>{act.baseRetenue.toFixed(2)} €</strong></div>
      )}
    </div>
  );
}

function DpiBox({ calculated, totalBase, totalDep, feeValue, feeType }) {
  if (totalDep <= 0 || !calculated.length) return null;
  return (
    <div className="dpi-box">
      <div className="dpi-box__title">Répartition DPI — {feeValue}{feeType === 'amount' ? ' €' : ' %'}</div>
      {calculated.map((act, i) => {
        const part = totalDep * (act.baseRetenue / totalBase);
        const pct  = Math.round((act.baseRetenue / totalBase) * 100);
        return (
          <div key={i} className="dpi-row">
            <div className="dpi-row__code">{act.code}<span className="dpi-row__sub">Base : {act.baseRetenue.toFixed(2)} €</span></div>
            <div className="dpi-row__track"><div className={`dpi-row__fill${i > 0 ? ' dpi-row__fill--secondary' : ''}`} style={{ width: `${pct}%` }} /></div>
            <div className="dpi-row__amount">{part.toFixed(2)} €</div>
          </div>
        );
      })}
    </div>
  );
}

function DpiCompact({ calculated, totalBase, totalDep, feeValue, feeType }) {
  if (totalDep <= 0) return <div className="dpi-empty">Aucun honoraire enregistré</div>;
  return (
    <div className="dpi-compact">
      <div className="dpi-compact__title">DPI — {feeValue}{feeType === 'amount' ? ' €' : ' %'}</div>
      {calculated.map((act, i) => (
        <div key={i} className="dpi-compact__row">
          <span>{act.code}</span>
          <strong>{(totalDep * (act.baseRetenue / totalBase)).toFixed(2)} €</strong>
        </div>
      ))}
    </div>
  );
}

function FeeBox({ feeType, feeValue, onTypeChange, onValueChange }) {
  return (
    <div className="fee-box">
      <div className="fee-box__label">Honoraires (DPI)</div>
      <div className="fee-box__tabs">
        <button className={`fee-tab ${feeType==='amount'     ? 'fee-tab--active' : 'fee-tab--inactive'}`} onClick={() => onTypeChange('amount')}>Montant fixe (€)</button>
        <button className={`fee-tab ${feeType==='percentage' ? 'fee-tab--active' : 'fee-tab--inactive'}`} onClick={() => onTypeChange('percentage')}>Pourcentage (%)</button>
      </div>
      <input type="number" className="input--fee" value={feeValue} onChange={e => onValueChange(e.target.value)} placeholder={feeType==='amount' ? 'Ex : 3500' : 'Ex : 250'} />
    </div>
  );
}

function SearchAutocomplete({ specialite, userSecteur, isOptam, onSelect, maxActs, placeholder = "Code CCAM ou mots-clés..." }) {
  const [term, setTerm]             = useState('');
  const [results, setResults]       = useState([]);
  const [isOpen, setIsOpen]         = useState(false);
  const [isLoading, setIsLoading]   = useState(false);
  const wrapperRef                  = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (term.trim().length < 2) { setResults([]); setIsOpen(false); return; }
    setIsLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchCCAM(term, specialite, 12);
        setResults(res); setIsOpen(res.length > 0);
      } catch (err) { setResults([]); setIsOpen(false); } 
      finally { setIsLoading(false); }
    }, 350);
    return () => clearTimeout(timer);
  }, [term, specialite]);

  const handleSelect = (act) => { onSelect(act); setTerm(''); setResults([]); setIsOpen(false); };

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input type="text" value={term} onChange={e => setTerm(e.target.value)} placeholder={maxActs <= 0 ? "Maximum 3 actes atteint" : placeholder} disabled={maxActs <= 0} style={{ width: '100%', paddingRight: '38px' }} />
        <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: '15px', pointerEvents: 'none' }}>{isLoading ? '⏳' : '🔍'}</span>
      </div>
      {isOpen && results.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', zIndex: 300, maxHeight: '320px', overflowY: 'auto' }}>
          <div style={{ padding: '8px 12px', fontSize: '11px', fontWeight: '600', color: 'var(--color-text-muted)', letterSpacing: '0.5px', borderBottom: '1px solid var(--color-border-soft)', textTransform: 'uppercase' }}>
            {results.length} résultat{results.length > 1 ? 's' : ''} — cliquer pour ajouter
          </div>
          {results.map(act => {
             let displayTarif = (userSecteur === '1' || isOptam) ? act.tarifSecteur1 : act.tarifSecteur2;
             return (
              <div key={act.id} onClick={() => handleSelect(act)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--color-border-soft)', transition: 'background 120ms' }} onMouseEnter={e => e.currentTarget.style.background = 'var(--sky-50)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: '600', padding: '3px 8px', borderRadius: '4px', background: 'var(--sky-50)', color: 'var(--navy-600)', whiteSpace: 'nowrap', flexShrink: 0 }}>{act.code}</span>
                <span style={{ flex: 1, fontSize: '12px', color: 'var(--color-text-secondary)', lineHeight: '1.35', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{act.libelle}</span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{displayTarif} €</span>
                <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'var(--emerald-500)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>+</span>
              </div>
            );
          })}
        </div>
      )}
      {isOpen && results.length === 0 && !isLoading && term.length >= 2 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '14px 12px', fontSize: '13px', color: 'var(--color-text-muted)', textAlign: 'center', boxShadow: '0 8px 24px rgba(15,23,42,0.08)', zIndex: 300 }}>
          Aucun acte trouvé pour « {term} »
        </div>
      )}
    </div>
  );
}

// ─── COMPOSANT PRINCIPAL ──────────────────────────────────────────────────────
function App() {
  const [user, setUser]                               = useState(null);
  const [userProfile, setUserProfile]                 = useState(null);
  const [isRegistering, setIsRegistering]             = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [resetMessage, setResetMessage]               = useState('');
  const [error, setError]                             = useState('');
  const [successMessage, setSuccessMessage]           = useState('');
  const [consentChecked, setConsentChecked]           = useState(false);
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [nom, setNom]               = useState('');
  const [prenom, setPrenom]         = useState('');
  const [rpps, setRpps]             = useState('');
  const [telephone, setTelephone]   = useState('');
  const [numeroRue, setNumeroRue]   = useState('');
  const [nomRue, setNomRue]         = useState('');
  const [codePostal, setCodePostal] = useState('');
  const [ville, setVille]           = useState('');
  const [specialite, setSpecialite] = useState('1'); 
  const [secteur, setSecteur]       = useState('2');
  const [optam, setOptam]           = useState(false);

  const [isUploading, setIsUploading]           = useState(false);
  const [uploadProgress, setUploadProgress]     = useState(0);
  const [selectedActs, setSelectedActs]         = useState([]);
  const [feeType, setFeeType]                   = useState('amount');
  const [feeValue, setFeeValue]                 = useState(0);
  const [interventionName, setInterventionName] = useState('');

  const [templates, setTemplates]                       = useState([]);
  const [isLoadingTemplates, setIsLoadingTemplates]     = useState(false);
  const [isEditingFav, setIsEditingFav]                 = useState(false);
  const [currentFavId, setCurrentFavId]                 = useState(null);
  const [favNameInput, setFavNameInput]                 = useState('');
  const [favCategoryInput, setFavCategoryInput]         = useState('');
  const [activeCategoryFilter, setActiveCategoryFilter] = useState('Tous');
  const [favActsInput, setFavActsInput]                 = useState([]);
  const [favFeeType, setFavFeeType]                     = useState('amount');
  const [favFeeValue, setFavFeeValue]                   = useState(0);

  const [simulations, setSimulations]                   = useState([]);
  const [isLoadingSimulations, setIsLoadingSimulations] = useState(false);

  const [sharedTemplate, setSharedTemplate]     = useState(null);
  const [incomingTemplate, setIncomingTemplate] = useState(null);
  const [usersList, setUsersList]               = useState([]);
  const [activeTab, setActiveTab]               = useState('simulator');

  const unsubTemplatesRef   = useRef(null);
  const unsubSimulationsRef = useRef(null);

  const encodeTemplate = (t) => btoa(encodeURIComponent(JSON.stringify({ n: t.name, a: t.acts, ft: t.feeType || 'amount', fv: t.feeValue || 0, cat: t.category || '' })));
  const decodeTemplate = (hash) => { try { return JSON.parse(decodeURIComponent(atob(hash))); } catch { return null; } };

  const subscribeTemplates = (uid) => {
    if (unsubTemplatesRef.current) unsubTemplatesRef.current();
    setIsLoadingTemplates(true);
    unsubTemplatesRef.current = onSnapshot(query(collection(db, "templates"), where("userId", "==", uid)), snap => { setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setIsLoadingTemplates(false); }, err => { console.error(err); setIsLoadingTemplates(false); });
  };
  const subscribeSimulations = (uid) => {
    if (unsubSimulationsRef.current) unsubSimulationsRef.current();
    setIsLoadingSimulations(true);
    unsubSimulationsRef.current = onSnapshot(query(collection(db, "simulations"), where("userId", "==", uid), orderBy("date", "desc"), limit(10)), snap => { setSimulations(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setIsLoadingSimulations(false); }, err => { console.error(err); setIsLoadingSimulations(false); });
  };
  const unsubscribeAll = () => {
    if (unsubTemplatesRef.current) { unsubTemplatesRef.current(); unsubTemplatesRef.current = null; }
    if (unsubSimulationsRef.current) { unsubSimulationsRef.current(); unsubSimulationsRef.current = null; }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const importData = params.get('import');
    if (importData) {
      const decoded = decodeTemplate(importData);
      if (decoded) setIncomingTemplate(decoded);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const unsubAuth = onAuthStateChanged(auth, async (cu) => {
      setUser(cu);
      if (cu) {
        await loadUserProfile(cu.uid);
        subscribeTemplates(cu.uid);
        subscribeSimulations(cu.uid);
        if (cu.email === ADMIN_EMAIL) fetchUsersList();
      } else { unsubscribeAll(); setUserProfile(null); setTemplates([]); setSimulations([]); setUsersList([]); }
    });
    return () => { unsubAuth(); unsubscribeAll(); };
  }, []);

  const loadUserProfile = async (uid) => {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data(); setUserProfile(d);
      setNom(d.nom || ''); setPrenom(d.prenom || ''); setRpps(d.rpps || ''); setTelephone(d.telephone || '');
      setNumeroRue(d.adresse?.numero || ''); setNomRue(d.adresse?.rue || ''); setCodePostal(d.adresse?.codePostal || ''); setVille(d.adresse?.ville || ''); 
      setSpecialite(d.specialite || '1'); setSecteur(d.secteur || '2'); setOptam(d.optam || false);   
    }
  };

  const fetchUsersList = async () => { try { const s = await getDocs(collection(db, "users")); setUsersList(s.docs.map(d => ({ id: d.id, ...d.data() }))); } catch (e) { console.error(e); } };

  const handleAcceptSharedTemplate = async () => {
    if (!user || !incomingTemplate) return;
    try {
      await addDoc(collection(db, "templates"), { userId: user.uid, name: incomingTemplate.n + " (Partagé)", category: incomingTemplate.cat || 'Partagé', acts: incomingTemplate.a, feeType: incomingTemplate.ft, feeValue: parseFloat(incomingTemplate.fv) });
      setIncomingTemplate(null); setActiveTab('favorites'); alert("Modèle importé dans vos favoris !");
    } catch { alert("Erreur lors de l'enregistrement."); }
  };

  const printTemplates = (tpl, currentSecteur, currentOptam, currentSpecialite) => {
    let html = `<html><head><title>Optim'CCAM</title><style>body{font-family:sans-serif;color:#333;padding:20px;}.header{text-align:center;margin-bottom:30px;border-bottom:2px solid #0B1628;padding-bottom:15px;}.header img{max-height:80px;margin-bottom:10px;}.t{margin-bottom:30px;page-break-inside:avoid;border:1px solid #ddd;padding:15px;border-radius:8px;}.t h3{margin-top:0;color:#0B1628;border-bottom:1px solid #eee;padding-bottom:8px;}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}th,td{border:1px solid #ddd;padding:8px;}th{background:#f8fafc;}.dpi{margin-top:15px;background:#ecfdf5;padding:12px;border:1px solid #10b981;border-radius:5px;}.dpi h4{margin:0 0 8px;color:#065f46;font-size:13px;}.dr{display:flex;justify-content:space-between;font-size:13px;color:#065f46;border-bottom:1px dashed #a7f3d0;padding:4px 0;}</style></head><body>
    <div class="header"><img src="${LOGO_URL}" alt="Logo"/><h2>Optim'CCAM — Référentiel</h2><p><strong>Dr ${nom} ${prenom}</strong> — RPPS : ${rpps}</p><p style="font-size:12px; color:#666;">Secteur ${currentSecteur} ${currentOptam ? '(OPTAM)' : '(Hors OPTAM)'} - Rôle ${currentSpecialite}</p></div>`;
    tpl.forEach(t => {
      const c = computeActs(t.acts, currentSecteur, currentOptam, currentSpecialite), tb = computeTotal(c), td = computeDep(t.feeType, t.feeValue, tb);
      html += `<div class="t"><h3>${t.name}${t.category ? ` (${t.category})` : ''}</h3><table><thead><tr><th>Code</th><th>Libellé</th><th>Retenu</th></tr></thead><tbody>`;
      c.forEach(a => { html += `<tr><td><strong>${a.code}</strong></td><td>${a.libelle}</td><td>${a.baseRetenue.toFixed(2)} €</td></tr>`; });
      html += `</tbody></table>`;
      if (td > 0) {
        html += `<div class="dpi"><h4>DPI (${t.feeValue}${t.feeType==='amount' ? ' €' : ' %'})</h4>`;
        c.forEach(a => { html += `<div class="dr"><span>${a.code}</span><strong>${(td*(a.baseRetenue/tb)).toFixed(2)} €</strong></div>`; });
        html += `</div>`;
      } html += `</div>`;
    });
    html += `</body></html>`;
    const w = window.open('', '', 'width=800,height=800'); w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); w.close(); }, 250);
  };

  const handleExportAllFavorites = () => {
    if (!templates.length) { alert("Aucun favori à exporter."); return; }
    const a = document.createElement('a'); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(templates.map(t => ({ name: t.name, category: t.category || '', acts: t.acts, feeType: t.feeType || 'amount', feeValue: t.feeValue || 0 }))));
    a.download = "OptimCCAM_Mes_Favoris.json"; document.body.appendChild(a); a.click(); a.remove();
  };

  const handleImportFavorites = (event) => {
    const file = event.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result); if (!Array.isArray(data)) throw new Error();
        let count = 0; for (const t of data) { if (t.name && Array.isArray(t.acts)) { await addDoc(collection(db, "templates"), { userId: user.uid, name: t.name, category: t.category || 'Non classé', acts: t.acts, feeType: t.feeType || 'amount', feeValue: parseFloat(t.feeValue) || 0 }); count++; } }
        alert(`${count} favoris importés.`);
      } catch { alert("Erreur d'importation."); } event.target.value = null;
    }; reader.readAsText(file);
  };

  const startCreateFav = () => { setIsEditingFav(true); setCurrentFavId(null); setFavNameInput(''); setFavCategoryInput(''); setFavActsInput([]); setFavFeeType('amount'); setFavFeeValue(0); };
  const startEditFav = (t) => { setIsEditingFav(true); setCurrentFavId(t.id); setFavNameInput(t.name); setFavCategoryInput(t.category || ''); setFavActsInput(t.acts); setFavFeeType(t.feeType || 'amount'); setFavFeeValue(t.feeValue || 0); };
  const saveFavChanges = async () => {
    if (!favNameInput || !favActsInput.length) { alert("Nom et actes requis."); return; }
    const data = { userId: user.uid, name: favNameInput, category: favCategoryInput || 'Non classé', acts: favActsInput, feeType: favFeeType, feeValue: parseFloat(favFeeValue) || 0 };
    if (currentFavId) await updateDoc(doc(db, "templates", currentFavId), data); else await addDoc(collection(db, "templates"), data);
    setIsEditingFav(false);
  };
  const deleteTemplate = async (id) => { if (window.confirm("Supprimer ce favori ?")) await deleteDoc(doc(db, "templates", id)); };
  const loadTemplateIntoSimulator = (t) => { if (!t) return; setInterventionName(t.name); setSelectedActs(t.acts); if (t.feeValue > 0) { setFeeType(t.feeType || 'amount'); setFeeValue(t.feeValue); } setActiveTab('simulator'); };

  const addActToFav = (act) => { if (favActsInput.length >= 3) return; setFavActsInput(prev => [...prev, { ...act, activeModifiers: { J: true } }]); };
  const addAct = (act) => { if (selectedActs.length >= 3) return; setSelectedActs(prev => [...prev, { ...act, activeModifiers: { J: true } }]); };

  const toggleSimModifier = (idx, m) => { setSelectedActs(prev => { const n = [...prev]; n[idx] = { ...n[idx], activeModifiers: { ...n[idx].activeModifiers, [m]: !n[idx].activeModifiers?.[m] } }; return n; }); };
  const toggleFavModifier = (idx, m) => { setFavActsInput(prev => { const n = [...prev]; n[idx] = { ...n[idx], activeModifiers: { ...n[idx].activeModifiers, [m]: !n[idx].activeModifiers?.[m] } }; return n; }); };

  const calculated    = computeActs(selectedActs, secteur, optam, specialite);
  const totalBase     = computeTotal(calculated);
  const totalDep      = computeDep(feeType, feeValue, totalBase);
  
  const favCalculated = computeActs(favActsInput, secteur, optam, specialite);
  const favTotalBase  = computeTotal(favCalculated);
  const favTotalDep   = computeDep(favFeeType, favFeeValue, favTotalBase);

  const saveIntervention = async () => {
    if (!interventionName || !selectedActs.length) { alert("Ajoutez un nom et au moins un acte."); return; }
    await addDoc(collection(db, "simulations"), { userId: user.uid, patient: interventionName, acts: selectedActs, feeType, feeValue, date: new Date() });
    await updateDoc(doc(db, "users", user.uid), { usageCount: increment(1) });
    setInterventionName(''); alert("Ajouté à l'historique !");
  };
  const saveCurrentAsTemplate = async () => {
    if (!interventionName || !selectedActs.length) { alert("Ajoutez un nom et au moins un acte."); return; }
    await addDoc(collection(db, "templates"), { userId: user.uid, name: interventionName, acts: selectedActs, feeType, feeValue: parseFloat(feeValue) || 0 });
    alert("Favori créé !");
  };

  const exportUsersToCSV = () => {
    const rows = usersList.map(u => { const d = u.dateCreation?.seconds ? new Date(u.dateCreation.seconds * 1000).toLocaleDateString() : ""; return `${u.nom};${u.prenom};${u.email};${u.rpps};${u.telephone||""};${u.adresse?.rue||""};${u.adresse?.codePostal||""};${u.adresse?.ville||""};${u.specialite};${d};${u.usageCount||0}`; });
    const a = document.createElement('a'); a.href = "data:text/csv;charset=utf-8," + encodeURI(["Nom;Prenom;Email;RPPS;Telephone;Rue;CP;Ville;Activite;Inscription;Usage"].concat(rows).join("\n"));
    a.download = "OptimCCAM_Mailing.csv"; document.body.appendChild(a); a.click(); a.remove();
  };
  const handleDeleteUserAdmin = async (id) => { if (window.confirm("Supprimer ce praticien ?")) { await deleteDoc(doc(db, "users", id)); fetchUsersList(); } };
  const handleAdminResetPassword = async (emailToReset) => { if (window.confirm(`Envoyer un lien à ${emailToReset} ?`)) { try { await sendPasswordResetEmail(auth, emailToReset); alert("Lien envoyé !"); } catch { alert("Erreur."); } } };

  // ─── IMPORTATION ULTRA-PERFORMANTE (Préfixes & Alias) ──────────────────────
  const handleClearDatabase = async () => {
    if (!window.confirm("Vider les actes CCAM ?")) return;
    setIsUploading(true); const snap = await getDocs(collection(db, "actes_ccam")); let i = 0;
    while (i < snap.docs.length) { const batch = writeBatch(db); snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref)); await batch.commit(); i += 400; setUploadProgress(Math.round((i / snap.docs.length) * 100)); }
    alert("Base nettoyée."); setIsUploading(false); setUploadProgress(0);
  };
  const handleFileUpload = (event) => {
    const file = event.target.files[0]; if (!file) return;
    setIsUploading(true); setUploadProgress(1);
    Papa.parse(file, { skipEmptyLines: true, complete: async ({ data: rows }) => {
      const valid = rows.filter(r => r[0]?.toString().trim().length === 7);
      if (!valid.length) { alert("Fichier invalide."); setIsUploading(false); return; }
      const CHUNK = 200;
      try {
        for (let i = 0; i < valid.length; i += CHUNK) {
          const batch = writeBatch(db);
          valid.slice(i, i + CHUNK).forEach(acte => {
            const code = acte[0].toString().trim().toUpperCase();
            const libelle = (acte[2]||"").toString().trim();
            const actId = (acte[3]||"1").toString(), phaId = (acte[4]||"0").toString();
            const s1 = acte[5] ? parseFloat(acte[5].toString().replace(',','.')) : 0;
            const s2 = acte[6] ? parseFloat(acte[6].toString().replace(',','.')) : s1;
            
            // LA MAGIE OPÈRE ICI (Accents et Découpe)
            const libelleNorm = normalizeText(libelle);
            const words = libelleNorm.split(/[^A-Z0-9]+/).filter(w => w.length > 1);
            const motsClesSet = new Set();

            words.forEach(w => {
              motsClesSet.add(w);
              // Génération des préfixes (dès 3 lettres)
              for (let len = 3; len < w.length; len++) {
                motsClesSet.add(w.substring(0, len));
              }
            });
            
            // Ajout du dictionnaire d'alias médicaux !
            if (words.includes("CALCANEUS")) motsClesSet.add("CALCANEUM");
            if (words.includes("CALCANEUM")) motsClesSet.add("CALCANEUS");
            if (words.includes("ASTRAGALE")) motsClesSet.add("TALUS");
            if (words.includes("TALUS")) motsClesSet.add("ASTRAGALE");
            if (words.includes("ROTULE")) motsClesSet.add("PATELLA");
            if (words.includes("PATELLA")) motsClesSet.add("ROTULE");
            if (words.includes("SCAPULA")) motsClesSet.add("OMOPLATE");
            if (words.includes("OMOPLATE")) motsClesSet.add("SCAPULA");

            batch.set(doc(db, "actes_ccam", `${code}_A${actId}_P${phaId}`), { 
              code, libelle, activite: actId, phase: phaId, 
              tarifSecteur1: isNaN(s1)?0:s1, tarifSecteur2: isNaN(s2)?0:s2,
              motsCles: [...motsClesSet],
              libelleSearch: libelleNorm
            });
          });
          await batch.commit(); setUploadProgress(Math.round(((i + Math.min(CHUNK, valid.length - i)) / valid.length) * 100)); await delay(100);
        }
        alert("Importation réussie ! Votre moteur de recherche intelligent est prêt.");
      } catch (e) { console.error(e); alert("Erreur Firebase."); }
      setIsUploading(false); setUploadProgress(0);
    }});
  };

  const handleGoogleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider()); const cu = result.user; const snap = await getDoc(doc(db, "users", cu.uid));
      if (!snap.exists()) { const parts = (cu.displayName || "").split(' '); await setDoc(doc(db, "users", cu.uid), { nom: parts.slice(1).join(' ').toUpperCase()||"", prenom: parts[0]||"", email: cu.email, rpps:'', telephone:'', specialite:'1', secteur:'2', optam:false, adresse:{numero:'',rue:'',codePostal:'',ville:''}, dateCreation: new Date(), lastLogin: new Date(), usageCount:0 }); } else { await updateDoc(doc(db, "users", cu.uid), { lastLogin: new Date() }); }
      setError('');
    } catch { setError("Erreur Google."); }
  };
  const handleLogin = async (e) => { e.preventDefault(); try { const r = await signInWithEmailAndPassword(auth, email, password); await updateDoc(doc(db, "users", r.user.uid), { lastLogin: new Date() }); setError(''); } catch { setError("Identifiants incorrects."); } };
  const handleRegister = async (e) => {
    e.preventDefault(); if (!consentChecked) { setError("Veuillez accepter le RGPD."); return; }
    try { const r = await createUserWithEmailAndPassword(auth, email, password); await setDoc(doc(db, "users", r.user.uid), { nom: nom.toUpperCase(), prenom, email, rpps, telephone, specialite, secteur:'2', optam:false, adresse:{numero:numeroRue,rue:nomRue,codePostal,ville}, dateCreation:new Date(), lastLogin:new Date(), usageCount:0 }); setIsRegistering(false); setError(''); } catch { setError("Erreur d'inscription."); }
  };
  const handleResetPassword = async (e) => { e.preventDefault(); if (!email) { setError("Email requis."); return; } try { await sendPasswordResetEmail(auth, email); setResetMessage("Lien envoyé par email."); setError(''); } catch { setError("Impossible d'envoyer l'email."); } };
  const updateProfile = async (e) => { e.preventDefault(); try { await updateDoc(doc(db, "users", user.uid), { nom: nom.toUpperCase(), prenom, telephone, specialite, secteur, optam, adresse:{numero:numeroRue,rue:nomRue,codePostal,ville} }); setSuccessMessage("Profil mis à jour."); setTimeout(()=>setSuccessMessage(''),4000); } catch { setError("Erreur lors de la sauvegarde du profil."); } };
  const handleDeleteAccount = async () => { if (window.confirm("Supprimer définitivement votre compte ?")) { try { await deleteDoc(doc(db, "users", auth.currentUser.uid)); await deleteUser(auth.currentUser); } catch { alert("Reconnectez-vous d'abord."); } } };

  const allCategories     = ['Tous', ...new Set(templates.map(t => t.category || 'Non classé'))];
  const filteredTemplates = activeCategoryFilter === 'Tous' ? templates : templates.filter(t => (t.category||'Non classé') === activeCategoryFilter);
  const categoryColors    = { 'Rachis':'tag--green','Hanche':'tag--blue','Genou':'tag--amber','Épaule':'tag--purple','Partagé':'tag--slate' };
  const getCategoryTag    = (cat) => categoryColors[cat] || 'tag--slate';

  const footerBranding = ( <div className="footer-branding"><img src={LOGO_URL} alt="Logo" /><p>Powered by <strong>Institut Orthopédique de Paris</strong></p><p>Développé par Dr Raphaël Jameson</p></div> );
  const liveIndicator = ( <span title="Synchronisation temps réel" style={{ display:'inline-block', width:'7px', height:'7px', borderRadius:'50%', background:'var(--emerald-500)', marginLeft:'10px', verticalAlign:'middle', boxShadow:'0 0 0 2px rgba(16,185,129,0.3)' }} /> );

  const renderShareModal = () => {
    if (!sharedTemplate) return null; const url = `${window.location.origin}/?import=${encodeTemplate(sharedTemplate)}`;
    return ( <div className="modal-overlay" onClick={() => setSharedTemplate(null)}><div className="modal" onClick={e => e.stopPropagation()}><h3 className="modal__title">Partager ce modèle</h3><p className="modal__subtitle">Faites scanner ce QR Code par votre confrère.</p><div className="modal__qr-wrapper"><QRCodeCanvas value={url} size={200} /></div><div className="modal__actions"><button className="btn btn--ghost" style={{flex:1}} onClick={() => setSharedTemplate(null)}>Fermer</button></div></div></div> );
  };

  const renderIncomingModal = () => {
    if (!user || !incomingTemplate) return null;
    return (
      <div className="modal-overlay">
        <div className="modal modal--incoming">
          <h2 className="modal__title" style={{color:'var(--emerald-600)'}}>Nouveau modèle reçu</h2>
          <p className="modal__subtitle">Un confrère vous partage son modèle :</p>
          <div className="modal__template-name">{incomingTemplate.n}</div>
          <div style={{fontSize:'13px',color:'var(--color-text-secondary)',textAlign:'left',marginBottom:'20px'}}>
            {incomingTemplate.a.map((act,i) => <div key={i} style={{padding:'3px 0'}}><span className="code-badge">{act.code}</span></div>)}
            {incomingTemplate.fv > 0 && <div style={{marginTop:'10px',color:'var(--emerald-600)',fontWeight:'600'}}>Honoraires : {incomingTemplate.fv}{incomingTemplate.ft==='amount' ? ' €' : ' %'}</div>}
          </div>
          <div className="modal__actions">
            <button className="btn btn--success" style={{flex:2}} onClick={handleAcceptSharedTemplate}>Ajouter à mes favoris</button>
            <button className="btn btn--ghost"   style={{flex:1}} onClick={() => setIncomingTemplate(null)}>Refuser</button>
          </div>
        </div>
      </div>
    );
  };

  if (!user) {
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo"><img src={LOGO_URL} alt="Logo" style={{maxHeight:'50px',marginBottom:'12px'}} /><div className="auth-logo__title">Optim'<span>CCAM</span></div><div className="auth-logo__subtitle">Outil d'optimisation du dépassement d'honoraires</div></div>
          {incomingTemplate && <div className="incoming-banner"><strong>Modèle reçu.</strong><br/>Connectez-vous pour l'enregistrer.</div>}
          {error && <div className="auth-error">{error}</div>}

          {isResettingPassword ? (
            <form onSubmit={handleResetPassword}>
              <p style={{fontSize:'13px',color:'var(--color-text-secondary)',marginBottom:'16px',textAlign:'center'}}>Entrez votre email pour recevoir un lien.</p>
              <input type="email" placeholder="Email professionnel" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              {resetMessage && <div className="auth-success">{resetMessage}</div>}
              <button type="submit" className="btn btn--warning" style={{width:'100%',padding:'12px'}}>Envoyer le lien</button>
              <p style={{textAlign:'center',marginTop:'16px',fontSize:'13px'}}><span className="auth-link" onClick={()=>{setIsResettingPassword(false);setResetMessage('');setError('');}}>← Retour</span></p>
            </form>
          ) : isRegistering ? (
            <form onSubmit={handleRegister}>
              <div className="responsive-grid-profile" style={{marginBottom:0}}>
                <input type="text" placeholder="Nom *" value={nom} onChange={e=>setNom(e.target.value)} autoComplete="family-name" required style={{marginBottom:'12px'}} />
                <input type="text" placeholder="Prénom *" value={prenom} onChange={e=>setPrenom(e.target.value)} autoComplete="given-name" required style={{marginBottom:'12px'}} />
              </div>
              <input type="email" placeholder="Email *" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              <input type="password" placeholder="Mot de passe *" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" required style={{marginBottom:'12px'}} />
              <input type="text" placeholder="N° RPPS *" value={rpps} onChange={e=>setRpps(e.target.value)} required style={{marginBottom:'12px'}} />
              <label className="consent-label"><input type="checkbox" checked={consentChecked} onChange={e=>setConsentChecked(e.target.checked)} required /> J'accepte que mes données soient traitées conformément au RGPD.</label>
              <button type="submit" className="btn btn--success" style={{width:'100%',padding:'12px'}}>Créer mon compte</button>
              <div className="auth-divider">ou</div>
              <button type="button" className="btn-google" onClick={handleGoogleLogin}><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{width:'18px'}} /> Continuer avec Google</button>
              <p style={{textAlign:'center',marginTop:'16px',fontSize:'13px'}}><span className="auth-link" onClick={()=>{setIsRegistering(false);setError('');}}>← Retour à la connexion</span></p>
            </form>
          ) : (
            <form onSubmit={handleLogin}>
              <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              <input type="password" placeholder="Mot de passe" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required style={{marginBottom:'16px'}} />
              <button type="submit" className="btn btn--primary" style={{width:'100%',padding:'12px'}}>Se connecter</button>
              <div className="auth-divider">ou</div>
              <button type="button" className="btn-google" onClick={handleGoogleLogin}><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{width:'18px'}} /> Continuer avec Google</button>
              <div className="auth-footer"><span className="auth-link" onClick={()=>{setIsResettingPassword(true);setError('');setResetMessage('');}}>Mot de passe oublié ?</span><span className="auth-link" onClick={()=>{setIsRegistering(true);setError('');}}>Créer un compte</span></div>
            </form>
          )}
        </div>
        {footerBranding}
      </div>
    );
  }

  return (
    <div className="app-body">
      {renderShareModal()}
      {renderIncomingModal()}

      <nav className="app-navbar">
        <div className="app-navbar__logo">Optim'<span>CCAM</span></div>
        <div className="responsive-navbar-buttons">
          <button className={`nav-btn${activeTab==='simulator'  ? ' nav-btn--active':''}`} onClick={()=>setActiveTab('simulator')}>Simulateur</button>
          <button className={`nav-btn${activeTab==='favorites'  ? ' nav-btn--active':''}`} onClick={()=>setActiveTab('favorites')}>Favoris {isLoadingTemplates && <span style={{fontSize:'10px',opacity:0.6}}>⏳</span>}</button>
          <button className={`nav-btn${activeTab==='profile'    ? ' nav-btn--active':''}`} onClick={()=>setActiveTab('profile')}>Profil</button>
          {auth.currentUser?.email === ADMIN_EMAIL && (<button className={`nav-btn${activeTab==='dashboard' ? ' nav-btn--active':''}`} onClick={()=>setActiveTab('dashboard')}>Admin</button>)}
          <button className="nav-btn nav-btn--exit" onClick={()=>signOut(auth)}>Quitter</button>
        </div>
      </nav>

      <div className="app-container">

        {/* ── PROFIL ────────────────────────────── */}
        {activeTab === 'profile' && (
          <div>
            <div className="card">
              <div className="card__title">Mon profil professionnel</div>
              {successMessage && <div className="auth-success">{successMessage}</div>}
              <form onSubmit={updateProfile}>
                <div className="responsive-grid-profile">
                  <div><label>Nom</label><input type="text" value={nom} onChange={e=>setNom(e.target.value)} style={{marginBottom:'12px'}} /></div>
                  <div><label>Prénom</label><input type="text" value={prenom} onChange={e=>setPrenom(e.target.value)} style={{marginBottom:'12px'}} /></div>
                  <div><label>Email</label><input type="text" value={auth.currentUser?.email} disabled style={{marginBottom:'12px'}} /></div>
                  <div><label>RPPS</label><input type="text" value={rpps} disabled style={{marginBottom:'12px'}} /></div>
                  <div><label>Téléphone</label><input type="tel" value={telephone} onChange={e=>setTelephone(e.target.value)} style={{marginBottom:'12px'}} /></div>
                </div>

                <div style={{marginTop:'12px', borderTop:'1px solid var(--color-border-soft)', paddingTop:'16px'}}>
                  <div className="card__label" style={{marginBottom:'16px'}}>Paramètres de Facturation (CCAM)</div>
                  <div className="responsive-grid-profile">
                    <div>
                      <label>Rôle</label>
                      <div className="role-selector">
                        {[{val:'1',label:'Chirurgien',sub:'Act. 1'},{val:'2',label:'Aide Op.',sub:'Act. 2'},{val:'4',label:'Anesthésiste',sub:'Act. 4'}].map(({val,label,sub})=>(
                          <div key={val} className={`role-option${specialite===val?' role-option--selected':''}`} onClick={()=>setSpecialite(val)}>{label}<span className="role-option__sub">{sub}</span></div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label>Secteur Conventionnel</label>
                      <div className="role-selector" style={{marginBottom:'12px'}}>
                        <div className={`role-option${secteur==='1'?' role-option--selected':''}`} onClick={()=>{setSecteur('1'); setOptam(false);}}>Secteur 1</div>
                        <div className={`role-option${secteur==='2'?' role-option--selected':''}`} onClick={()=>setSecteur('2')}>Secteur 2</div>
                      </div>
                      {secteur === '2' && (
                        <label className="consent-label" style={{background:'var(--sky-50)', padding:'10px', borderRadius:'8px'}}>
                          <input type="checkbox" checked={optam} onChange={e=>setOptam(e.target.checked)} /><strong style={{color:'var(--navy-600)'}}>Adhérent OPTAM / OPTAM-CO</strong><div style={{fontSize:'11px', color:'var(--color-text-muted)', marginTop:'4px'}}>Applique la base de remboursement du Secteur 1.</div>
                        </label>
                      )}
                    </div>
                  </div>
                </div>
                <button type="submit" className="btn btn--primary" style={{width:'100%',padding:'12px',marginTop:'24px'}}>Enregistrer mon profil</button>
              </form>
            </div>
            
            <div className="card card--danger" style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'12px'}}>
              <div><div style={{fontWeight:'600',marginBottom:'4px'}}>Zone de danger</div><div style={{fontSize:'13px',color:'var(--color-text-secondary)'}}>La suppression est irréversible.</div></div>
              <button className="btn btn--danger" onClick={handleDeleteAccount}>Supprimer mon compte</button>
            </div>
          </div>
        )}

        {/* ── FAVORIS ───────────────────────────────────────────────────── */}
        {activeTab === 'favorites' && (
          <div>
            {!isEditingFav ? (
              <div>
                <div className="card">
                  <div className="favorites-header">
                    <div className="card__title" style={{margin:0}}>Mes modèles favoris {liveIndicator}</div>
                    <div className="favorites-header__actions">
                      <label className="btn btn--slate" style={{cursor:'pointer',margin:0}}><input type="file" accept=".json" style={{display:'none'}} onChange={handleImportFavorites} />Importer</label>
                      <button className="btn btn--sky" onClick={handleExportAllFavorites}>Exporter tout</button>
                      <button className="btn btn--ghost" onClick={()=>printTemplates(templates, secteur, optam, specialite)}>Imprimer tout</button>
                      <button className="btn btn--success" onClick={startCreateFav}>+ Nouveau</button>
                    </div>
                  </div>
                  <div className="category-filters">
                    {allCategories.map(cat=>( <button key={cat} className={`category-btn${activeCategoryFilter===cat?' category-btn--active':''}`} onClick={()=>setActiveCategoryFilter(cat)}>{cat}</button> ))}
                  </div>
                </div>

                {isLoadingTemplates ? (
                  <div className="favorites-grid">{[1,2,3].map(i=>(<div key={i} className="fav-card"><div className="skeleton" style={{height:'20px',width:'70%',marginBottom:'12px'}} /><div className="skeleton" style={{height:'14px',width:'100%',marginBottom:'8px'}} /><div className="skeleton" style={{height:'60px',marginTop:'12px'}} /></div>))}</div>
                ) : (
                  <div className="favorites-grid">
                    {filteredTemplates.map(t => {
                      const calc=computeActs(t.acts, secteur, optam, specialite), tb=computeTotal(calc), td=computeDep(t.feeType,t.feeValue,tb);
                      return (
                        <div key={t.id} className="fav-card">
                          <div className="fav-card__header">
                            <div className="fav-card__title">{t.name}</div>
                            <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
                              <span className={`tag ${getCategoryTag(t.category||'Non classé')}`}>{t.category||'Non classé'}</span>
                              <button className="btn-icon" onClick={()=>printTemplates([t], secteur, optam, specialite)} title="Imprimer">🖨</button>
                              <button className="btn-icon" onClick={()=>setSharedTemplate(t)} title="Partager">🔗</button>
                              <button className="btn-icon" onClick={()=>startEditFav(t)} title="Modifier">✏️</button>
                              <button className="btn-icon btn-icon--danger" onClick={()=>deleteTemplate(t.id)} title="Supprimer">🗑</button>
                            </div>
                          </div>
                          <div className="fav-card__acts">
                            {t.acts.map((a,i)=>( <div key={i} className="fav-act-row"><span className="code-badge">{a.code}</span><span style={{fontSize:'11px'}}>{a.libelle}</span></div> ))}
                          </div>
                          <DpiCompact calculated={calc} totalBase={tb} totalDep={td} feeValue={t.feeValue} feeType={t.feeType} />
                          <div className="fav-card__footer">
                            <button className="btn btn--primary" style={{flex:2,padding:'8px'}} onClick={()=>loadTemplateIntoSimulator(t)}>Charger</button>
                            <button className="btn btn--ghost" style={{flex:1,padding:'8px'}} onClick={()=>startEditFav(t)}>Modifier</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="card">
                <div className="card__title">{currentFavId ? "Modifier le favori" : "Créer un favori"}</div>
                <div className="responsive-grid-profile" style={{marginBottom:'16px'}}>
                  <div><label>Nom *</label><input type="text" placeholder="Ex : Arthrodèse L5-S1..." value={favNameInput} onChange={e=>setFavNameInput(e.target.value)} /></div>
                  <div><label>Catégorie</label><input type="text" placeholder="Ex : Rachis, Hanche..." value={favCategoryInput} onChange={e=>setFavCategoryInput(e.target.value)} /></div>
                </div>

                <FeeBox feeType={favFeeType} feeValue={favFeeValue} onTypeChange={setFavFeeType} onValueChange={setFavFeeValue} />

                <div style={{marginTop:'16px'}}>
                  <label>Rechercher un acte CCAM (3 max.)</label>
                  <SearchAutocomplete specialite={specialite} userSecteur={secteur} isOptam={optam} onSelect={addActToFav} maxActs={3 - favActsInput.length} placeholder="Code CCAM ou mot-clé..." />
                </div>

                {favActsInput.length > 0 && (
                  <div style={{marginTop:'20px'}}>
                    <div className="card__label">Actes sélectionnés</div>
                    {favCalculated.map((act,idx)=>( <ActCard key={idx} act={act} index={idx} onRemove={()=>setFavActsInput(prev=>prev.filter((_,i)=>i!==idx))} onModifierChange={(m)=>()=>toggleFavModifier(idx,m)} /> ))}
                  </div>
                )}
                {favTotalDep > 0 && favActsInput.length > 0 && ( <DpiBox calculated={favCalculated} totalBase={favTotalBase} totalDep={favTotalDep} feeValue={favFeeValue} feeType={favFeeType} /> )}
                <div className="responsive-action-buttons" style={{marginTop:'20px'}}>
                  <button className="btn btn--success" style={{flex:1,padding:'12px'}} onClick={saveFavChanges}>Enregistrer</button>
                  <button className="btn btn--ghost" style={{flex:1,padding:'12px'}} onClick={()=>setIsEditingFav(false)}>Annuler</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SIMULATEUR ────────────────────────────────────────────────── */}
        {activeTab === 'simulator' && (
          <div className="responsive-grid-sim">
            <div>
              <div className="card">
                <div className="card__label">Ajouter un acte CCAM</div>
                <SearchAutocomplete specialite={specialite} userSecteur={secteur} isOptam={optam} onSelect={addAct} maxActs={3 - selectedActs.length} placeholder="Tapez un code (ex: NEKA010) ou un mot-clé..." />
                {selectedActs.length >= 3 && (<p style={{fontSize:'12px',color:'var(--color-text-muted)',marginTop:'8px',textAlign:'center'}}>Maximum 3 actes atteint.</p>)}
              </div>

              {selectedActs.length > 0 && (
                <div className="card">
                  <div className="metrics-row">
                    <div className="metric-card"><div className="metric-card__label">Base CCAM totale</div><div className="metric-card__value">{totalBase.toFixed(2)} €</div></div>
                    {totalDep > 0 && ( <div className="metric-card"><div className="metric-card__label">Honoraires DPI</div><div className="metric-card__value metric-card__value--success">{totalDep.toFixed(2)} €</div></div> )}
                  </div>

                  {calculated.map((act,idx) => ( <ActCard key={idx} act={act} index={idx} onRemove={()=>setSelectedActs(prev=>prev.filter((_,i)=>i!==idx))} onModifierChange={(m)=>()=>toggleSimModifier(idx,m)} /> ))}

                  <FeeBox feeType={feeType} feeValue={feeValue} onTypeChange={setFeeType} onValueChange={setFeeValue} />
                  <DpiBox calculated={calculated} totalBase={totalBase} totalDep={totalDep} feeValue={feeValue} feeType={feeType} />

                  <div style={{ marginBottom: '10px' }}>
                    <label style={{ fontWeight: '600', fontSize: '12px', color: 'var(--color-text-secondary)', display: 'block', marginBottom: '6px' }}>Nom de l'intervention / du patient</label>
                    <input type="text" className="input--title" placeholder="Ex : PTH DUPONT Jean..." value={interventionName} onChange={e => setInterventionName(e.target.value)} style={{ fontSize: '15px' }} />
                  </div>

                  <div className="responsive-action-buttons">
                    <button className="btn btn--success" style={{flex:2,padding:'12px'}} onClick={saveIntervention}>Valider dans l'historique</button>
                    <button className="btn btn--warning" style={{flex:1,padding:'12px'}} onClick={saveCurrentAsTemplate}>Créer un favori</button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="sidebar-card">
                <div className="sidebar-card__title">Favoris rapides {liveIndicator}</div>
                <select className="fav-select" onChange={e=>loadTemplateIntoSimulator(templates.find(x=>x.id===e.target.value))}>
                  <option value="">Charger un favori...</option>
                  {templates.map(t=><option key={t.id} value={t.id}>{t.name} ({t.category||'N/C'})</option>)}
                </select>
                {templates.slice(0,4).map(t=>(
                  <div key={t.id} className="fav-quick-item" onClick={()=>loadTemplateIntoSimulator(t)}><div className="fav-quick-item__name">{t.name}</div><div className="fav-quick-item__sub">{t.category||'Non classé'}{t.feeValue>0 ? ` · ${t.feeValue}${t.feeType==='amount'?' €':' %'}` : ''}</div></div>
                ))}
              </div>

              {(isLoadingSimulations || simulations.length > 0) && (
                <div className="sidebar-card">
                  <div className="sidebar-card__title">Historique récent {liveIndicator}</div>
                  {isLoadingSimulations ? (
                    [1,2,3].map(i=><div key={i} className="skeleton" style={{height:'14px',marginBottom:'10px',borderRadius:'6px'}} />)
                  ) : simulations.map((s,i)=>{
                    const colors=['var(--emerald-500)','var(--sky-500)','var(--amber-500)','var(--slate-400)'];
                    return ( <div key={s.id} className="hist-item" onClick={()=>{setSelectedActs(s.acts);setInterventionName(s.patient);setFeeValue(s.feeValue);setFeeType(s.feeType);}}><div className="hist-item__dot" style={{background:colors[i%colors.length]}} /><div className="hist-item__name">{s.patient}</div><div className="hist-item__date">{new Date(s.date.seconds*1000).toLocaleDateString()}</div></div> );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ADMIN ─────────────────────────────────────────────────────── */}
        {activeTab === 'dashboard' && auth.currentUser?.email === ADMIN_EMAIL && (
          <div className="card">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'20px',flexWrap:'wrap',gap:'12px'}}>
              <div className="card__title" style={{margin:0}}>Gestion Master (Plan Blaze)</div>
              <button className="btn btn--sky" onClick={exportUsersToCSV}>Export Mailing (CSV)</button>
            </div>
            <div className="overflow-x-auto" style={{marginBottom:'24px'}}>
              <table className="admin-table">
                <thead><tr><th>Identité</th><th>Dernière connexion</th><th style={{textAlign:'center'}}>Usage</th><th>Actions</th></tr></thead>
                <tbody>
                  {usersList.map(u=>(
                    <tr key={u.id}>
                      <td><strong>{u.nom} {u.prenom}</strong><br/><span className="text-muted text-xs">RPPS : {u.rpps}</span></td>
                      <td><span style={{color:'var(--emerald-600)',fontWeight:'500',fontSize:'12px'}}>{u.lastLogin?.seconds ? new Date(u.lastLogin.seconds*1000).toLocaleString() : 'Jamais'}</span></td>
                      <td style={{textAlign:'center'}}>{u.usageCount||0}</td>
                      <td>
                        <div style={{display:'flex',gap:'6px'}}>
                          <button className="btn btn--warning" style={{padding:'5px 10px',fontSize:'12px'}} onClick={()=>handleAdminResetPassword(u.email)}>MdP</button>
                          <button className="btn btn--danger" style={{padding:'5px 10px',fontSize:'12px'}} onClick={()=>handleDeleteUserAdmin(u.id)}>Suppr.</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="maintenance-box">
              <div className="card__label" style={{marginBottom:'12px'}}>Maintenance CCAM</div>
              <div style={{display:'flex',gap:'10px',flexWrap:'wrap',alignItems:'center'}}>
                <input type="file" accept=".csv" onChange={handleFileUpload} style={{flex:1,minWidth:'200px'}} />
                <button className="btn btn--danger" style={{border:'1px solid var(--rose-500)',background:'transparent',color:'var(--rose-500)'}} onClick={handleClearDatabase}>Nettoyer</button>
              </div>
              {isUploading && (
                <div style={{marginTop:'12px'}}><div className="progress-bar"><div className="progress-bar__fill" style={{width:`${uploadProgress}%`}} /></div><p className="progress-bar__label">Progression : {uploadProgress}%</p></div>
              )}
            </div>
          </div>
        )}

        {footerBranding}
      </div>
    </div>
  );
}

export default App;