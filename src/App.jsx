// src/App.jsx — Optim'CCAM v5.6 — Navigateur autonome & Codes Favoris
// Corrections v5.6.1 : --sky-600→--sky-500 | double deleteUser supprimé | userProfile dead state retiré

import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { auth, db } from './firebase';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup
} from 'firebase/auth';
import {
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  writeBatch, collection, query, where, getDocs,
  addDoc, orderBy, limit, startAt, endAt, increment, onSnapshot
} from 'firebase/firestore';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { QRCodeCanvas } from 'qrcode.react';

const LOGO_URL    = "https://www.institutorthopedique.paris/wp-content/uploads/2025/07/CROPinstitut-orthopedique-paris-logo-grand.png";
const ADMIN_EMAIL      = "dr.jameson@rachis.paris";
// Collection Firestore — changer en "actes_ccam_test" pour tester sans toucher la prod
const ACTES_COLLECTION = "actes_ccam";
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const normalizeText = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim() : "";

// ─── CALCUL CCAM ─────────────────────────────────────────────────────────────
const computeActs = (acts, userSecteur, isOptam, userSpecialite) =>
  [...acts].map(act => {
    let majo = 1;
    if (act.activeModifiers?.K)      majo = 1.2;
    else if (act.activeModifiers?.J) majo = 1.115;
    if (act.activeModifiers?.U)      majo += 0.1;
    let baseTarif = (userSecteur==='1'||isOptam) ? act.tarifSecteur1 : act.tarifSecteur2;
    if (userSpecialite==='2' && act.activite==='1') baseTarif *= 0.25;
    else if (userSpecialite==='1' && act.activite==='2') baseTarif *= 4;
    return { ...act, baseMajore: baseTarif * majo };
  })
  .sort((a,b) => b.baseMajore - a.baseMajore)
  .map((act,i) => ({ ...act, coeff: i===0?1:0.5, baseRetenue: act.baseMajore*(i===0?1:0.5) }));

const computeTotal = (c) => c.reduce((s,a) => s+a.baseRetenue, 0);
const computeDep   = (ft, fv, base) => ft==='amount' ? (parseFloat(fv)||0) : base*((parseFloat(fv)||0)/100);

// ─── RECHERCHE CCAM ───────────────────────────────────────────────────────────
// specialite = '1' | '2' | '4' → filtre par activité (Simulateur, Favoris)
// specialite = null             → toutes activités (Navigateur)
const searchCCAM = async (term, specialite, maxResults=20) => {
  if (!term || term.trim().length < 3) return [];
  const nt = normalizeText(term);
  const filterByActivite = specialite !== null;

  // 1. Code exact (7 caractères : AAAA999)
  if (/^[A-Z]{4}\d{3}$/.test(nt)) {
    try {
      // Sans filtre d'activité (Navigateur) : retourne toutes les activités du code
      // Avec filtre (Simulateur) : retourne uniquement celle de l'utilisateur
      const q = filterByActivite
        ? query(collection(db, ACTES_COLLECTION), where("code","==",nt), where("activite","==",specialite))
        : query(collection(db, ACTES_COLLECTION), where("code","==",nt));
      const s = await getDocs(q);
      return s.docs.map(d=>({id:d.id,...d.data()}));
    } catch { return []; }
  }

  const seen=new Map(), queries=[];

  // 2. Préfixe de code (nécessite un filtre activité pour orderBy)
  if (/^[A-Z]{1,4}\d{0,3}$/.test(nt)) {
    if (filterByActivite) {
      queries.push(getDocs(query(collection(db, ACTES_COLLECTION),where("activite","==",specialite),orderBy("code"),startAt(nt),endAt(nt+'\uf8ff'),limit(maxResults))));
    } else {
      // Sans filtre activité, on cherche parmi A1 (activite chirurgien) par défaut pour les préfixes
      queries.push(getDocs(query(collection(db, ACTES_COLLECTION),where("activite","==","1"),orderBy("code"),startAt(nt),endAt(nt+'\uf8ff'),limit(maxResults))));
    }
  }

  // 3. Mots-clés (motsCles)
  const words = nt.split(/[^A-Z0-9]+/).filter(w=>w.length>=2);
  if (words.length>0) {
    const best = words.reduce((a,b)=>a.length>=b.length?a:b);
    if (filterByActivite) {
      queries.push(getDocs(query(collection(db, ACTES_COLLECTION),where("activite","==",specialite),where("motsCles","array-contains",best),limit(400))));
    } else {
      // Sans filtre : cherche dans toutes les activités en parallèle
      for (const act of ['1','2','4']) {
        queries.push(getDocs(query(collection(db, ACTES_COLLECTION),where("activite","==",act),where("motsCles","array-contains",best),limit(150))));
      }
    }
  }
  try {
    const snaps = await Promise.all(queries);
    snaps.forEach(s=>s.docs.forEach(d=>{
      if (!seen.has(d.id)) {
        const data=d.data(); let match=true;
        if (words.length>0) {
          const lib=data.libelleSearch||normalizeText(data.libelle), mc=data.motsCles||[];
          for (const w of words) { if (!mc.includes(w)&&!lib.includes(w)){match=false;break;} }
        }
        if (match) seen.set(d.id,{id:d.id,...data});
      }
    }));
  } catch(e) { console.error(e); }
  return [...seen.values()].slice(0,maxResults);
};

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTÈME DE TOASTS
// ═══════════════════════════════════════════════════════════════════════════════

const TOAST_STYLES = {
  success: { bg:'#065f46', border:'#10b981', icon:'✓' },
  error:   { bg:'#7f1d1d', border:'#ef4444', icon:'✕' },
  warning: { bg:'#78350f', border:'#f59e0b', icon:'⚠' },
  info:    { bg:'#0c4a6e', border:'#38bdf8', icon:'ℹ' },
};

function ToastContainer({ toasts, onRemove }) {
  return (
    <>
      <style>{`
        @keyframes toastIn  { from{opacity:0;transform:translateX(100%)} to{opacity:1;transform:translateX(0)} }
        @keyframes toastOut { from{opacity:1;transform:translateX(0)} to{opacity:0;transform:translateX(110%)} }
        .toast-item { animation: toastIn 0.28s cubic-bezier(0.34,1.56,0.64,1) forwards; }
        .toast-item.removing { animation: toastOut 0.22s ease-in forwards; }
      `}</style>
      <div style={{
        position:'fixed', bottom:'24px', right:'24px', zIndex:9999,
        display:'flex', flexDirection:'column', gap:'10px',
        maxWidth:'340px', width:'calc(100vw - 48px)'
      }}>
        {toasts.map(t => {
          const s = TOAST_STYLES[t.type] || TOAST_STYLES.info;
          return (
            <div key={t.id} className={`toast-item${t.removing?' removing':''}`} style={{
              display:'flex', alignItems:'flex-start', gap:'12px',
              background:s.bg, border:`1px solid ${s.border}`,
              borderRadius:'10px', padding:'13px 15px',
              boxShadow:'0 8px 24px rgba(0,0,0,0.3)', cursor:'pointer'
            }} onClick={()=>onRemove(t.id)}>
              <span style={{
                width:'22px', height:'22px', borderRadius:'50%',
                background:s.border, color:'#fff',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:'12px', fontWeight:'700', flexShrink:0
              }}>{s.icon}</span>
              <span style={{flex:1, fontSize:'13px', color:'#fff', lineHeight:'1.45', fontFamily:'var(--font-body)'}}>{t.message}</span>
              <span style={{color:'rgba(255,255,255,0.5)', fontSize:'16px', lineHeight:1, flexShrink:0}}>×</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type='info', duration=3500) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type, removing:false }]);
    setTimeout(() => { setToasts(prev => prev.map(t => t.id===id ? {...t, removing:true} : t)); }, duration - 200);
    setTimeout(() => { setToasts(prev => prev.filter(t => t.id!==id)); }, duration);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.map(t => t.id===id ? {...t, removing:true} : t));
    setTimeout(() => setToasts(prev => prev.filter(t => t.id!==id)), 220);
  }, []);

  return { toasts, showToast, removeToast };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODALE DE CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════════

function ConfirmModal({ state, onConfirm, onCancel }) {
  if (!state.isOpen) return null;
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(5,15,31,0.7)',
      display:'flex', alignItems:'center', justifyContent:'center',
      zIndex:8000, padding:'20px', backdropFilter:'blur(2px)'
    }}>
      <div style={{
        background:'var(--color-surface)', borderRadius:'16px',
        padding:'28px', maxWidth:'380px', width:'100%',
        boxShadow:'0 20px 60px rgba(0,0,0,0.3)',
        borderTop: state.danger ? '4px solid var(--rose-500)' : '4px solid var(--sky-500)'
      }}>
        <div style={{fontSize:'15px', fontWeight:'600', color:'var(--color-text-primary)', marginBottom:'8px'}}>
          {state.title || 'Confirmation'}
        </div>
        <div style={{fontSize:'14px', color:'var(--color-text-secondary)', lineHeight:'1.5', marginBottom:'24px'}}>
          {state.message}
        </div>
        <div style={{display:'flex', gap:'10px'}}>
          <button onClick={onCancel} style={{flex:1, padding:'10px', borderRadius:'8px', border:'1px solid var(--color-border)', background:'transparent', color:'var(--color-text-secondary)', fontSize:'13px', fontWeight:'500', cursor:'pointer', fontFamily:'var(--font-body)'}}>Annuler</button>
          <button onClick={onConfirm} style={{flex:1, padding:'10px', borderRadius:'8px', border:'none', background: state.danger ? 'var(--rose-500)' : 'var(--navy-800)', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer', fontFamily:'var(--font-body)'}}>
            {state.confirmLabel || 'Confirmer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function useConfirm() {
  const [state, setState] = useState({ isOpen:false, message:'', title:'', danger:false, confirmLabel:'Confirmer' });
  const resolveRef = useRef(null);

  const showConfirm = useCallback((message, options={}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ isOpen:true, message, title:options.title||'Confirmation', danger:options.danger||false, confirmLabel:options.confirmLabel||'Confirmer' });
    });
  }, []);

  const handleConfirm = () => { setState(s=>({...s,isOpen:false})); resolveRef.current?.(true); };
  const handleCancel  = () => { setState(s=>({...s,isOpen:false})); resolveRef.current?.(false); };

  return { confirmState:state, showConfirm, handleConfirm, handleCancel };
}

// ─── SOUS-COMPOSANTS ──────────────────────────────────────────────────────────

function ModifierChip({ label, active, onChange }) {
  return (
    <label className={`modifier-chip${active?' modifier-chip--active':''}`}>
      <input type="checkbox" checked={active} onChange={onChange} style={{display:'none'}} />
      {label}
    </label>
  );
}

function ActCard({ act, index, onRemove, onModifierChange }) {
  const isPrimary = index === 0;
  return (
    <div className={`act-card ${isPrimary?'act-card--primary':'act-card--secondary'}`}>
      <div className="act-card__header">
        <span className="act-card__code">{act.code}</span>
        <span className="act-card__coeff">{isPrimary?'100% — Acte principal':'50% — Acte associé'}</span>
        <button className="act-card__remove" onClick={onRemove}>×</button>
      </div>
      <div className="act-card__libelle">{act.libelle}</div>
      <div className="modifiers">
        {['J','K','U'].map(m=>(
          <ModifierChip key={m} label={`Modif ${m}${m==='J'?' +11.5%':m==='K'?' +20%':' +10%'}`} active={!!act.activeModifiers?.[m]} onChange={onModifierChange(m)} />
        ))}
      </div>
      {act.baseRetenue!==undefined && <div className="act-card__base">Base retenue : <strong>{act.baseRetenue.toFixed(2)} €</strong></div>}
    </div>
  );
}

function DpiBox({ calculated, totalBase, totalDep, feeValue, feeType }) {
  if (totalDep<=0||!calculated.length) return null;
  return (
    <div className="dpi-box">
      <div className="dpi-box__title">Répartition DPI — {feeValue}{feeType==='amount'?' €':' %'}</div>
      {calculated.map((act,i)=>{
        const part=totalDep*(act.baseRetenue/totalBase), pct=Math.round((act.baseRetenue/totalBase)*100);
        return (
          <div key={i} className="dpi-row">
            <div className="dpi-row__code">{act.code}<span className="dpi-row__sub">Base : {act.baseRetenue.toFixed(2)} €</span></div>
            <div className="dpi-row__track"><div className={`dpi-row__fill${i>0?' dpi-row__fill--secondary':''}`} style={{width:`${pct}%`}} /></div>
            <div className="dpi-row__amount">{part.toFixed(2)} €</div>
          </div>
        );
      })}
    </div>
  );
}

function DpiCompact({ calculated, totalBase, totalDep, feeValue, feeType }) {
  if (totalDep<=0) return <div className="dpi-empty">Aucun honoraire enregistré</div>;
  return (
    <div className="dpi-compact">
      <div className="dpi-compact__title">DPI — {feeValue}{feeType==='amount'?' €':' %'}</div>
      {calculated.map((act,i)=>(
        <div key={i} className="dpi-compact__row">
          <span>{act.code}</span>
          <strong>{(totalDep*(act.baseRetenue/totalBase)).toFixed(2)} €</strong>
        </div>
      ))}
    </div>
  );
}

function FeeBox({ feeType, feeValue, onTypeChange, onValueChange }) {
  const handleChange = (e) => {
    const raw = parseFloat(e.target.value);
    // Bloque toute valeur négative ou vide → remet à 0
    if (e.target.value === '' || e.target.value === '-') { onValueChange(0); return; }
    if (!isNaN(raw) && raw < 0) { onValueChange(0); return; }
    onValueChange(e.target.value);
  };
  return (
    <div className="fee-box">
      <div className="fee-box__label">Honoraires (DPI)</div>
      <div className="fee-box__tabs">
        <button className={`fee-tab ${feeType==='amount'?'fee-tab--active':'fee-tab--inactive'}`} onClick={()=>onTypeChange('amount')}>Montant fixe (€)</button>
        <button className={`fee-tab ${feeType==='percentage'?'fee-tab--active':'fee-tab--inactive'}`} onClick={()=>onTypeChange('percentage')}>Pourcentage (%)</button>
      </div>
      <input
        type="number"
        className="input--fee"
        value={feeValue}
        onChange={handleChange}
        min="0"
        step={feeType==='amount' ? '1' : '0.1'}
        placeholder={feeType==='amount'?'Ex : 3500':'Ex : 250'}
        onWheel={e => e.currentTarget.blur()}
        onKeyDown={e => { if (e.key === '-' || e.key === 'e') e.preventDefault(); }}
      />
    </div>
  );
}

// Menu déroulant de recherche réutilisable
function SearchAutocomplete({ specialite, userSecteur, isOptam, onSelect, maxActs, placeholder="Code CCAM ou mots-clés...", maxResults=20 }) {
  const [term, setTerm]           = useState('');
  const [results, setResults]     = useState([]);
  const [isOpen, setIsOpen]       = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const h = (e)=>{ if (wrapperRef.current&&!wrapperRef.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown',h); return ()=>document.removeEventListener('mousedown',h);
  }, []);

  useEffect(() => {
    if (term.trim().length<3) { setResults([]); setIsOpen(false); setHasSearched(false); return; }
    setIsLoading(true); setHasSearched(false);
    const t = setTimeout(async()=>{
      try {
        const res = await searchCCAM(term, specialite, maxResults);
        setResults(res); setIsOpen(true); setHasSearched(true);
      } catch { setResults([]); setIsOpen(true); setHasSearched(true); }
      finally { setIsLoading(false); }
    }, 350);
    return ()=>clearTimeout(t);
  }, [term, specialite, maxResults]);

  const handleSelect = (act) => { onSelect(act); setTerm(''); setResults([]); setIsOpen(false); setHasSearched(false); };

  return (
    <div ref={wrapperRef} style={{position:'relative'}}>
      <div style={{position:'relative'}}>
        <input type="text" value={term} onChange={e=>setTerm(e.target.value)}
          placeholder={maxActs<=0?"Maximum 3 actes atteint":placeholder}
          disabled={maxActs<=0} style={{width:'100%',paddingRight:'38px'}} />
        <span style={{position:'absolute',right:'12px',top:'50%',transform:'translateY(-50%)',color:'var(--color-text-muted)',fontSize:'15px',pointerEvents:'none'}}>
          {isLoading?'⏳':'🔍'}
        </span>
      </div>
      {isOpen && results.length>0 && (
        <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,right:0,background:'var(--color-surface)',border:'1px solid var(--color-border)',borderRadius:'var(--radius-md)',boxShadow:'0 8px 24px rgba(15,23,42,0.12)',zIndex:300,maxHeight:'320px',overflowY:'auto'}}>
          <div style={{padding:'8px 12px',fontSize:'11px',fontWeight:'600',color:'var(--color-text-muted)',letterSpacing:'0.5px',borderBottom:'1px solid var(--color-border-soft)',textTransform:'uppercase'}}>
            {results.length} résultat{results.length>1?'s':''} — cliquer pour voir
          </div>
          {results.map(act=>{
            const displayTarif=(userSecteur==='1'||isOptam)?act.tarifSecteur1:act.tarifSecteur2;
            return (
              <div key={act.id} onClick={()=>handleSelect(act)}
                style={{display:'flex',alignItems:'center',gap:'10px',padding:'10px 12px',cursor:'pointer',borderBottom:'1px solid var(--color-border-soft)',transition:'background 120ms'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--sky-50)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <span style={{fontFamily:'var(--font-mono)',fontSize:'11px',fontWeight:'600',padding:'3px 8px',borderRadius:'4px',background:'var(--sky-50)',color:'var(--navy-600)',whiteSpace:'nowrap',flexShrink:0}}>{act.code}</span>
                <span style={{flex:1,fontSize:'12px',color:'var(--color-text-secondary)',lineHeight:'1.35',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{act.libelle}</span>
                <span style={{fontSize:'13px',fontWeight:'600',color:'var(--color-text-primary)',whiteSpace:'nowrap'}}>{displayTarif} €</span>
                <span style={{width:'26px',height:'26px',borderRadius:'50%',background:'var(--emerald-500)',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',flexShrink:0}}>+</span>
              </div>
            );
          })}
        </div>
      )}
      {isOpen && hasSearched && results.length===0 && !isLoading && (
        <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,right:0,background:'var(--color-surface)',border:'1px solid var(--color-border)',borderRadius:'var(--radius-md)',padding:'14px 12px',fontSize:'13px',color:'var(--color-text-muted)',textAlign:'center',boxShadow:'0 8px 24px rgba(15,23,42,0.08)',zIndex:300}}>
          Aucun acte trouvé pour « {term} »<br/>
          <span style={{fontSize:'11px',opacity:0.7}}>Vérifiez l'onglet Admin → ré-importer le CSV</span>
        </div>
      )}
    </div>
  );
}

// ─── COMPOSANT PRINCIPAL ──────────────────────────────────────────────────────
function App() {

  const { toasts, showToast, removeToast }               = useToast();
  const { confirmState, showConfirm, handleConfirm, handleCancel } = useConfirm();

  // Auth & profil
  // FIX : userProfile supprimé — état déclaré mais jamais lu dans le JSX
  const [user, setUser]                               = useState(null);
  const [isRegistering, setIsRegistering]             = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [resetMessage, setResetMessage]               = useState('');
  const [error, setError]                             = useState('');
  const [consentChecked, setConsentChecked]           = useState(false);
  const [proChecked, setProChecked]                   = useState(false);
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

  const [saveStatus, setSaveStatus]     = useState('');
  const [favoriteActs, setFavoriteActs] = useState([]);
  const initialLoadDone                 = useRef(false);

  // Navigateur
  const [browserView, setBrowserView]               = useState('search');
  const [selectedBrowserAct, setSelectedBrowserAct] = useState(null);

  // Simulateur
  const [isUploading, setIsUploading]           = useState(false);
  const [uploadProgress, setUploadProgress]     = useState(0);
  const [selectedActs, setSelectedActs]         = useState([]);
  const [feeType, setFeeType]                   = useState('amount');
  const [feeValue, setFeeValue]                 = useState(0);
  const [interventionName, setInterventionName] = useState('');

  // Favoris (Modèles Simulateur)
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
  const [sharedTemplate, setSharedTemplate]             = useState(null);
  const [incomingTemplate, setIncomingTemplate]         = useState(null);
  const [usersList, setUsersList]                       = useState([]);
  const [activeTab, setActiveTab]                       = useState('browser');

  const unsubTemplatesRef   = useRef(null);
  const unsubSimulationsRef = useRef(null);

  const encodeTemplate = (t) => btoa(encodeURIComponent(JSON.stringify({n:t.name,a:t.acts,ft:t.feeType||'amount',fv:t.feeValue||0,cat:t.category||''})));
  const decodeTemplate = (h) => { try { return JSON.parse(decodeURIComponent(atob(h))); } catch { return null; } };

  const subscribeTemplates = (uid) => {
    if (unsubTemplatesRef.current) unsubTemplatesRef.current();
    setIsLoadingTemplates(true);
    unsubTemplatesRef.current = onSnapshot(
      query(collection(db,"templates"),where("userId","==",uid)),
      s=>{ setTemplates(s.docs.map(d=>({id:d.id,...d.data()}))); setIsLoadingTemplates(false); },
      e=>{ console.error(e); setIsLoadingTemplates(false); }
    );
  };

  const subscribeSimulations = (uid) => {
    if (unsubSimulationsRef.current) unsubSimulationsRef.current();
    setIsLoadingSimulations(true);
    unsubSimulationsRef.current = onSnapshot(
      query(collection(db,"simulations"),where("userId","==",uid),orderBy("date","desc"),limit(10)),
      s=>{ setSimulations(s.docs.map(d=>({id:d.id,...d.data()}))); setIsLoadingSimulations(false); },
      e=>{ console.error(e); setIsLoadingSimulations(false); }
    );
  };

  const unsubscribeAll = () => {
    if (unsubTemplatesRef.current)   { unsubTemplatesRef.current();   unsubTemplatesRef.current=null; }
    if (unsubSimulationsRef.current) { unsubSimulationsRef.current(); unsubSimulationsRef.current=null; }
  };

  useEffect(() => {
    const params=new URLSearchParams(window.location.search), imp=params.get('import');
    if (imp) { const d=decodeTemplate(imp); if(d) setIncomingTemplate(d); window.history.replaceState(null,'',window.location.pathname); }
    const unsubAuth = onAuthStateChanged(auth, async(cu)=>{
      setUser(cu);
      if (cu) {
        initialLoadDone.current = false;
        await loadUserProfile(cu.uid);
        subscribeTemplates(cu.uid);
        subscribeSimulations(cu.uid);
        if (cu.email===ADMIN_EMAIL) fetchUsersList();
      } else {
        unsubscribeAll();
        // FIX : setUserProfile supprimé
        setTemplates([]); setSimulations([]); setUsersList([]);
        setSelectedBrowserAct(null);
        setFavoriteActs([]);
        initialLoadDone.current = false;
      }
    });
    return ()=>{ unsubAuth(); unsubscribeAll(); };
  }, []);

  const loadUserProfile = async(uid) => {
    const s=await getDoc(doc(db,"users",uid));
    if (s.exists()) {
      // FIX : setUserProfile(d) supprimé — l'état était déclaré mais jamais lu
      const d=s.data();
      setNom(d.nom||''); setPrenom(d.prenom||''); setRpps(d.rpps||''); setTelephone(d.telephone||'');
      setNumeroRue(d.adresse?.numero||''); setNomRue(d.adresse?.rue||'');
      setCodePostal(d.adresse?.codePostal||''); setVille(d.adresse?.ville||'');
      setSpecialite(d.specialite||'1'); setSecteur(d.secteur||'2'); setOptam(d.optam||false);
      setFavoriteActs(d.favoriteActs || []);
      setTimeout(() => { initialLoadDone.current = true; }, 800);
    }
  };

  // Auto-save profil (debounce 1200ms)
  useEffect(() => {
    if (!initialLoadDone.current || !user) return;
    setSaveStatus('Enregistrement en cours...');
    const timer = setTimeout(async () => {
      try {
        await updateDoc(doc(db,"users",user.uid), {
          nom: nom.toUpperCase(), prenom, telephone, rpps, specialite, secteur, optam,
          adresse: { numero: numeroRue, rue: nomRue, codePostal, ville }
        });
        setSaveStatus('Enregistré ✓');
        setTimeout(() => setSaveStatus(''), 3000);
      } catch { setSaveStatus('Erreur de sauvegarde'); }
    }, 1200);
    return () => clearTimeout(timer);
  }, [nom, prenom, telephone, rpps, specialite, secteur, optam, numeroRue, nomRue, codePostal, ville, user]);

  const fetchUsersList = async() => {
    try { const s=await getDocs(collection(db,"users")); setUsersList(s.docs.map(d=>({id:d.id,...d.data()}))); }
    catch(e) { console.error(e); }
  };

  // Gestion des codes favoris du Navigateur (sauvegarde directe, pas via auto-save)
  const toggleFavoriteAct = async (act) => {
    const isFav = favoriteActs.some(a => a.code === act.code);
    const newFavs = isFav ? favoriteActs.filter(a => a.code !== act.code) : [...favoriteActs, act];
    setFavoriteActs(newFavs);
    showToast(isFav ? "Code retiré de vos favoris." : "Code ajouté à vos favoris !", isFav ? "info" : "success", 2000);
    try {
      await updateDoc(doc(db, "users", user.uid), { favoriteActs: newFavs });
    } catch { showToast("Erreur lors de la sauvegarde du favori.", "error"); }
  };

  const handleAcceptSharedTemplate = async() => {
    if (!user||!incomingTemplate) return;
    try {
      await addDoc(collection(db,"templates"),{userId:user.uid,name:incomingTemplate.n+" (Partagé)",category:incomingTemplate.cat||'Partagé',acts:incomingTemplate.a,feeType:incomingTemplate.ft,feeValue:parseFloat(incomingTemplate.fv)});
      setIncomingTemplate(null); setActiveTab('favorites');
      showToast("Modèle importé dans vos favoris !", 'success');
    } catch { showToast("Erreur lors de l'enregistrement.", 'error'); }
  };

  const printTemplates = (tpl, cs, co, csp) => {
    let html=`<html><head><title>Optim'CCAM</title><style>body{font-family:sans-serif;color:#333;padding:20px;}.header{text-align:center;margin-bottom:30px;border-bottom:2px solid #0B1628;padding-bottom:15px;}.header img{max-height:80px;margin-bottom:10px;}.t{margin-bottom:30px;page-break-inside:avoid;border:1px solid #ddd;padding:15px;border-radius:8px;}.t h3{margin-top:0;color:#0B1628;border-bottom:1px solid #eee;padding-bottom:8px;}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}th,td{border:1px solid #ddd;padding:8px;}th{background:#f8fafc;}.dpi{margin-top:15px;background:#ecfdf5;padding:12px;border:1px solid #10b981;border-radius:5px;}.dpi h4{margin:0 0 8px;color:#065f46;font-size:13px;}.dr{display:flex;justify-content:space-between;font-size:13px;color:#065f46;border-bottom:1px dashed #a7f3d0;padding:4px 0;}</style></head><body>
    <div class="header"><img src="${LOGO_URL}" alt=""/><h2>Optim'CCAM — Référentiel</h2><p><strong>Dr ${nom} ${prenom}</strong> — RPPS : ${rpps}</p><p style="font-size:12px;color:#666;">Secteur ${cs} ${co?'(OPTAM)':'(Hors OPTAM)'} - Rôle ${csp}</p></div>`;
    tpl.forEach(t=>{
      const c=computeActs(t.acts,cs,co,csp),tb=computeTotal(c),td=computeDep(t.feeType,t.feeValue,tb);
      html+=`<div class="t"><h3>${t.name}${t.category?` (${t.category})`:''}</h3><table><thead><tr><th>Code</th><th>Libellé</th><th>Retenu</th></tr></thead><tbody>`;
      c.forEach(a=>{html+=`<tr><td><strong>${a.code}</strong></td><td>${a.libelle}</td><td>${a.baseRetenue.toFixed(2)} €</td></tr>`;});
      html+=`</tbody></table>`;
      if (td>0) {
        html+=`<div class="dpi"><h4>DPI (${t.feeValue}${t.feeType==='amount'?' €':' %'})</h4>`;
        c.forEach(a=>{html+=`<div class="dr"><span>${a.code}</span><strong>${(td*(a.baseRetenue/tb)).toFixed(2)} €</strong></div>`;});
        html+=`</div>`;
      }
      html+=`</div>`;
    });
    html+=`</body></html>`;
    const w=window.open('','','width=800,height=800'); w.document.write(html); w.document.close(); w.focus();
    setTimeout(()=>{w.print();w.close();},250);
  };

  const handleExportAllFavorites = () => {
    if (!templates.length) { showToast("Vous n'avez aucun favori à exporter.", 'warning'); return; }
    const a=document.createElement('a');
    a.href="data:text/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(templates.map(t=>({name:t.name,category:t.category||'',acts:t.acts,feeType:t.feeType||'amount',feeValue:t.feeValue||0}))));
    a.download="OptimCCAM_Mes_Favoris.json"; document.body.appendChild(a); a.click(); a.remove();
    showToast(`${templates.length} favori${templates.length>1?'s':''} exporté${templates.length>1?'s':''}.`, 'success');
  };

  const handleImportFavorites = (event) => {
    const file=event.target.files[0]; if (!file) return;
    const reader=new FileReader();
    reader.onload = async(e) => {
      try {
        const data=JSON.parse(e.target.result);
        if (!Array.isArray(data)) throw new Error();
        let count=0;
        for (const t of data) {
          if (t.name&&Array.isArray(t.acts)) {
            await addDoc(collection(db,"templates"),{userId:user.uid,name:t.name,category:t.category||'Non classé',acts:t.acts,feeType:t.feeType||'amount',feeValue:parseFloat(t.feeValue)||0});
            count++;
          }
        }
        showToast(`${count} favori${count>1?'s':''} importé${count>1?'s':''} avec succès.`, 'success');
      } catch { showToast("Erreur : format de fichier invalide.", 'error'); }
      event.target.value=null;
    };
    reader.readAsText(file);
  };

  const startCreateFav = () => { setIsEditingFav(true); setCurrentFavId(null); setFavNameInput(''); setFavCategoryInput(''); setFavActsInput([]); setFavFeeType('amount'); setFavFeeValue(0); };
  const startEditFav   = (t) => { setIsEditingFav(true); setCurrentFavId(t.id); setFavNameInput(t.name); setFavCategoryInput(t.category||''); setFavActsInput(t.acts); setFavFeeType(t.feeType||'amount'); setFavFeeValue(t.feeValue||0); };

  // ─── RÈGLES D'INCOMPATIBILITÉ ──────────────────────────────────────────────
  // Format : chaque paire [CodeA, CodeB] est incompatible — ne peut pas être
  // associée dans le même acte opératoire selon la nomenclature CCAM.
  // Source : Notes d'exclusion du fichier CCAM V82 + règles CNAM.
  // L'admin peut étendre cette liste dans la prochaine version.
  const INCOMPATIBLE_PAIRS = [
    // Rachis : geste discal vs geste osseux au même niveau
    ['LFFA002', 'LHFA016'], // Discectomie lombale + Laminectomie lombale
    ['LFFA002', 'LFDA009'], // Discectomie lombale + Arthrodèse lombal PLIF
    ['LFEA002', 'LHFA016'], // Discectomie cervicale + Laminectomie lombale
    ['LFFA007', 'LFDA009'], // Discectomie thoracique + Arthrodèse
    // Ajoutez d'autres paires ici selon votre pratique
  ];

  // Vérifie si l'ajout d'un acte crée une incompatibilité avec les actes déjà présents
  const checkIncompatibility = (newAct, existingActs) => {
    for (const existing of existingActs) {
      for (const [codeA, codeB] of INCOMPATIBLE_PAIRS) {
        const newCode      = newAct.code.toUpperCase();
        const existingCode = existing.code.toUpperCase();
        if (
          (newCode === codeA && existingCode === codeB) ||
          (newCode === codeB && existingCode === codeA)
        ) {
          return `⚠️ Association non recommandée : ${newCode} et ${existingCode} ne peuvent pas être cotés ensemble selon la nomenclature CCAM.`;
        }
      }
    }
    return null;
  };

  const addActToSimulatorFromBrowser = (act) => {
    if (selectedActs.length >= 3) {
      showToast("Le simulateur est plein (3 actes maximum).", "warning");
      setActiveTab('simulator');
      return;
    }
    const warning = checkIncompatibility(act, selectedActs);
    if (warning) showToast(warning, 'error', 7000);
    setSelectedActs(p => [...p, { ...act, activeModifiers: { J: true } }]);
    setActiveTab('simulator');
    if (!warning) showToast(`Acte ${act.code} envoyé au simulateur.`, 'success');
  };

  const saveFavChanges = async() => {
    if (!favNameInput||!favActsInput.length) { showToast("Le nom et au moins un acte sont requis.", 'warning'); return; }
    const data={userId:user.uid,name:favNameInput,category:favCategoryInput||'Non classé',acts:favActsInput,feeType:favFeeType,feeValue:parseFloat(favFeeValue)||0};
    if (currentFavId) await updateDoc(doc(db,"templates",currentFavId),data);
    else              await addDoc(collection(db,"templates"),data);
    setIsEditingFav(false);
    showToast(`Favori "${favNameInput}" enregistré.`, 'success');
  };

  const deleteTemplate = async(id) => {
    const t = templates.find(x=>x.id===id);
    const ok = await showConfirm(`Supprimer le favori "${t?.name||'ce favori'}" ?`, { danger:true, confirmLabel:'Supprimer' });
    if (ok) { await deleteDoc(doc(db,"templates",id)); showToast("Favori supprimé.", 'info'); }
  };

  const loadTemplateIntoSimulator = (t) => {
    if (!t) return;
    setInterventionName(t.name); setSelectedActs(t.acts);
    if (t.feeValue > 0) { setFeeType(t.feeType || 'amount'); setFeeValue(t.feeValue); }
    else                { setFeeType('amount'); setFeeValue(0); }
    setActiveTab('simulator');
    showToast(`"${t.name}" chargé dans le simulateur.`, 'info', 2500);
  };

  const addActToFav = (act) => {
    if (favActsInput.length>=3) return;
    const warning = checkIncompatibility(act, favActsInput);
    if (warning) showToast(warning, 'error', 7000);
    setFavActsInput(p=>[...p,{...act,activeModifiers:{J:true}}]);
  };

  const addAct = (act) => {
    if (selectedActs.length>=3) return;
    const warning = checkIncompatibility(act, selectedActs);
    if (warning) showToast(warning, 'error', 7000);
    setSelectedActs(p=>[...p,{...act,activeModifiers:{J:true}}]);
  };

  const toggleSimModifier = (idx,m) => setSelectedActs(p=>{ const n=[...p]; n[idx]={...n[idx],activeModifiers:{...n[idx].activeModifiers,[m]:!n[idx].activeModifiers?.[m]}}; return n; });
  const toggleFavModifier = (idx,m) => setFavActsInput(p=>{ const n=[...p]; n[idx]={...n[idx],activeModifiers:{...n[idx].activeModifiers,[m]:!n[idx].activeModifiers?.[m]}}; return n; });

  const calculated    = computeActs(selectedActs,secteur,optam,specialite);
  const totalBase     = computeTotal(calculated);
  const totalDep      = computeDep(feeType,feeValue,totalBase);
  const favCalculated = computeActs(favActsInput,secteur,optam,specialite);
  const favTotalBase  = computeTotal(favCalculated);
  const favTotalDep   = computeDep(favFeeType,favFeeValue,favTotalBase);

  const saveIntervention = async() => {
    if (!interventionName||!selectedActs.length) { showToast("Ajoutez un nom et au moins un acte CCAM.", 'warning'); return; }
    await addDoc(collection(db,"simulations"),{userId:user.uid,patient:interventionName,acts:selectedActs,feeType,feeValue,date:new Date()});
    await updateDoc(doc(db,"users",user.uid),{usageCount:increment(1)});
    showToast(`"${interventionName}" ajouté à l'historique.`, 'success');
    setInterventionName('');
  };

  const saveCurrentAsTemplate = async() => {
    if (!interventionName||!selectedActs.length) { showToast("Ajoutez un nom et au moins un acte CCAM.", 'warning'); return; }
    await addDoc(collection(db,"templates"),{userId:user.uid,name:interventionName,acts:selectedActs,feeType,feeValue:parseFloat(feeValue)||0});
    showToast(`Favori "${interventionName}" créé !`, 'success');
  };

  const exportUsersToCSV = () => {
    const rows=usersList.map(u=>{const d=u.dateCreation?.seconds?new Date(u.dateCreation.seconds*1000).toLocaleDateString():"";return `${u.nom};${u.prenom};${u.email};${u.rpps};${u.telephone||""};${u.adresse?.rue||""};${u.adresse?.codePostal||""};${u.adresse?.ville||""};${u.specialite};${d};${u.usageCount||0}`;});
    const a=document.createElement('a');
    a.href="data:text/csv;charset=utf-8,"+encodeURI(["Nom;Prenom;Email;RPPS;Telephone;Rue;CP;Ville;Activite;Inscription;Usage"].concat(rows).join("\n"));
    a.download="OptimCCAM_Mailing.csv"; document.body.appendChild(a); a.click(); a.remove();
    showToast(`${usersList.length} utilisateurs exportés.`, 'success');
  };

  const handleDeleteUserAdmin = async(id) => {
    const u=usersList.find(x=>x.id===id);
    const ok=await showConfirm(`Supprimer le compte de ${u?.nom||''} ${u?.prenom||''} ?`, { danger:true, confirmLabel:'Supprimer le compte' });
    if (ok) { await deleteDoc(doc(db,"users",id)); fetchUsersList(); showToast("Compte supprimé.", 'info'); }
  };

  const handleAdminResetPassword = async(emailToReset) => {
    const ok=await showConfirm(`Envoyer un lien de réinitialisation à ${emailToReset} ?`, { confirmLabel:'Envoyer' });
    if (ok) {
      try { await sendPasswordResetEmail(auth,emailToReset); showToast("Lien de réinitialisation envoyé !", 'success'); }
      catch { showToast("Impossible d'envoyer l'email.", 'error'); }
    }
  };

  const handleClearDatabase = async() => {
    const ok=await showConfirm("Vider TOUS les actes CCAM de la base ? Cette action est irréversible.", { danger:true, title:'Nettoyer la base', confirmLabel:'Vider la base' });
    if (!ok) return;
    setIsUploading(true);
    const snap=await getDocs(collection(db, ACTES_COLLECTION)); let i=0;
    while (i<snap.docs.length) {
      const batch=writeBatch(db);
      snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));
      await batch.commit(); i+=400; setUploadProgress(Math.round((i/snap.docs.length)*100));
    }
    showToast("Base CCAM nettoyée. Vous pouvez ré-importer le CSV.", 'info');
    setIsUploading(false); setUploadProgress(0);
  };

  // ─── IMPORTATION CCAM V82 — LECTURE DIRECTE DU FICHIER XLS OFFICIEL ───────────
  // Accepte directement le fichier XLS de la CNAM sans aucune conversion préalable.
  // La bibliothèque SheetJS lit le XLS nativement dans le navigateur.
  //
  // Structure parsée ligne par ligne :
  //   Code 7 chars (AAAA999) | | libellé | 1 | phase | tarif_s1 | tarif_s2 → chirurgien (A1)
  //   vide ou [modifs]       | | "anesthésie" | 4 | 0  | tarif | tarif      → anesthésiste (A4)
  //   vide                   | | "Activité 2..." | 2 | 0 | tarif | tarif    → aide opératoire (A2)
  //   toute autre ligne                                                       → ignorée
  //
  // Résultat attendu : ~13 235 documents (8 257 A1 + 4 936 A4 + 42 A2)
  // ─── IMPORTATION CCAM ─────────────────────────────────────────────────────
  // MODE 1 — 1 fichier  : XLS V82 officiel CNAM (tarifs A1+A4+A2, ~13 235 actes)
  // MODE 2 — 2 fichiers : XLS V82 + XLSX complémentaire PMSI
  //           → notes d'actes, règles de chapitre, arborescence complète
  //           → ~13 000 actes enrichis (notes, exclusions, inclusions, chapitre/sous-chapitre)
  //
  // Comment utiliser :
  //   Mode 1 : sélectionner uniquement le fichier CCAM_V82_...VF.xls
  //   Mode 2 : sélectionner les DEUX fichiers simultanément (Ctrl+clic ou Cmd+clic)
  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    setIsUploading(true); setUploadProgress(1);

    // ── Helpers ──────────────────────────────────────────────────────────
    const parseTarif = (val) => {
      if (val === null || val === undefined || val === '') return 0;
      const n = parseFloat(String(val).replace(',', '.').replace(/\s/g, ''));
      return isNaN(n) ? 0 : n;
    };

    const ALIASES = {
      'CALCANEUS':'CALCANEUM','CALCANEUM':'CALCANEUS',
      'ASTRAGALE':'TALUS',    'TALUS':'ASTRAGALE',
      'ROTULE':'PATELLA',     'PATELLA':'ROTULE',
      'SCAPULA':'OMOPLATE',   'OMOPLATE':'SCAPULA',
      'COLONNE':'RACHIS',     'RACHIS':'COLONNE',
      'GENOU':'GONARTHROSE',  'HANCHE':'COXARTHROSE',
    };

    const buildMotsCles = (libelle, extra = []) => {
      const norm  = normalizeText(libelle);
      const words = norm.split(/[^A-Z0-9]+/).filter(w => w.length >= 2);
      const mc    = new Set();
      words.forEach(w => {
        mc.add(w);
        for (let l = 2; l < w.length; l++) mc.add(w.substring(0, l));
        if (ALIASES[w]) mc.add(ALIASES[w]);
      });
      extra.forEach(a => mc.add(normalizeText(a)));
      return [...mc];
    };

    const readXLSX = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        await new Promise(r => setTimeout(r, 50));
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', dense: true });
        resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }));
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    const uploadBatches = async (docs) => {
      const CHUNK = 500;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const batch = writeBatch(db);
        docs.slice(i, i + CHUNK).forEach(d => {
          const { docId, ...data } = d;
          batch.set(doc(db, ACTES_COLLECTION, docId), data);
        });
        await batch.commit();
        setUploadProgress(Math.round(((i + Math.min(CHUNK, docs.length - i)) / docs.length) * 100));
        await delay(50);
      }
    };

    const CODE_RE = /^[A-Z]{4}\d{3}$/i;

    try {
      // Identifier les fichiers
      const v82File  = files.find(f => /v82|ccam.*vf/i.test(f.name)) || files[0];
      const compFile = files.find(f => /complement|pmsi/i.test(f.name));

      showToast(`Lecture du fichier V82...`, 'info', 3000);
      const v82Rows = await readXLSX(v82File);

      if (!compFile) {
        // ════════════════════════════════════════════════════════════════
        // MODE 1 — XLS V82 uniquement : tarifs + A1/A4/A2
        // ════════════════════════════════════════════════════════════════
        const docs = [];
        let curCode = null, curLib = null;

        for (const row of v82Rows) {
          const code = String(row[0] ?? '').trim();
          const texte = String(row[2] ?? '').trim();
          const act   = String(row[3] ?? '').trim();
          const phase = String(row[4] ?? '').trim() || '0';
          const s1    = parseTarif(row[5]);
          const s2    = parseTarif(row[6]) || s1;

          if (CODE_RE.test(code)) {
            curCode = code.toUpperCase(); curLib = texte;
            docs.push({ docId:`${curCode}_A1_P${phase}`, code:curCode, libelle:texte, activite:'1', phase, tarifSecteur1:s1, tarifSecteur2:s2, motsCles:buildMotsCles(texte), libelleSearch:normalizeText(texte) });
          } else if (act === '4' && /anesth/i.test(texte) && s1 > 0 && curCode) {
            const lib = `Anesthésie — ${curLib}`;
            docs.push({ docId:`${curCode}_A4_P${phase}`, code:curCode, libelle:lib, activite:'4', phase, tarifSecteur1:s1, tarifSecteur2:s2, motsCles:buildMotsCles(lib,['ANESTHESIE','ANESTH']), libelleSearch:normalizeText(lib) });
          } else if (act === '2' && s1 > 0 && curCode) {
            const lib = `Aide opératoire — ${curLib}`;
            docs.push({ docId:`${curCode}_A2_P${phase}`, code:curCode, libelle:lib, activite:'2', phase, tarifSecteur1:s1, tarifSecteur2:s2, motsCles:buildMotsCles(lib,['AIDE','OPERATOIRE']), libelleSearch:normalizeText(lib) });
          }
        }
        if (!docs.length) { showToast("Fichier non reconnu. Sélectionnez le XLS officiel CNAM.", 'error'); setIsUploading(false); return; }
        await uploadBatches(docs);
        const a1=docs.filter(d=>d.activite==='1').length, a4=docs.filter(d=>d.activite==='4').length, a2=docs.filter(d=>d.activite==='2').length;
        showToast(`✅ ${docs.length} actes — ${a1} chirurgiens · ${a4} anesthésistes · ${a2} aides op.`, 'success', 7000);

      } else {
        // ════════════════════════════════════════════════════════════════
        // MODE 2 — V82 + complémentaire : import enrichi avec notes + arborescence
        // ════════════════════════════════════════════════════════════════
        showToast(`Lecture du fichier complémentaire...`, 'info', 3000);
        const compRows = await readXLSX(compFile);

        // Étape A : Construire la carte des tarifs depuis V82
        const tarifsMap = new Map();
        let curV82Code = null;
        for (const row of v82Rows) {
          const code = String(row[0] ?? '').trim();
          const act  = String(row[3] ?? '').trim();
          const ph   = String(row[4] ?? '').trim() || '0';
          const s1   = parseTarif(row[5]);
          const s2   = parseTarif(row[6]) || s1;
          if (CODE_RE.test(code)) {
            curV82Code = code.toUpperCase();
            tarifsMap.set(`${curV82Code}_A1_P${ph}`, { s1, s2 });
          } else if (act === '4' && /anesth/i.test(String(row[2]??'')) && s1 > 0 && curV82Code) {
            tarifsMap.set(`${curV82Code}_A4_P${ph}`, { s1, s2 });
          } else if (act === '2' && s1 > 0 && curV82Code) {
            tarifsMap.set(`${curV82Code}_A2_P${ph}`, { s1, s2 });
          }
        }

        // Étape B : Parser le fichier complémentaire (arborescence + notes)
        // Colonnes clés (0-indexed) :
        //   0  = code principal (subdivisions) / 2 = code 7 chars
        //   5  = texte (libellé / note)
        //   10 = typo (T=titre, NT=note chapitre, L=acte, N=note acte, LV=libellé vide)
        //   11 = activité  |  12 = phase
        //   42 = N° chapitre  |  43 = Titre chapitre
        //   44 = N° sous-chap |  45 = Titre sous-chapitre
        //   46 = N° paragraphe|  47 = Titre paragraphe
        const docs = [];
        let lastDoc = null;
        let chapTitre = '', sousChapTitre = '', paraTitre = '';
        let sectionNotes = [];

        for (let i = 1; i < compRows.length; i++) {
          const row   = compRows[i];
          const typo  = String(row[10] ?? '').trim();
          const texte = String(row[5]  ?? '').trim();
          const code  = String(row[2]  ?? String(row[0] ?? '')).trim();
          const act   = String(row[11] ?? '').trim() || '1';
          const ph    = String(row[12] ?? '').trim() || '0';

          if (typo === 'T') {
            // Nouveau titre de section → réinitialise les notes
            sectionNotes = [];
            const ct = String(row[43] ?? '').trim();
            const st = String(row[45] ?? '').trim();
            const pt = String(row[47] ?? '').trim();
            if (ct) { chapTitre = ct; sousChapTitre = ''; paraTitre = ''; }
            if (st) { sousChapTitre = st; paraTitre = ''; }
            if (pt)   paraTitre = pt;

          } else if (typo === 'NT' && texte) {
            // Note de chapitre = règle s'appliquant à tous les actes du chapitre
            // (inclusions, exclusions, conditions)
            sectionNotes.push(texte);

          } else if ((typo === 'L' || typo === 'LV') && CODE_RE.test(code)) {
            // Nouvelle ligne d'acte
            if (lastDoc) docs.push(lastDoc);
            const codeUp  = code.toUpperCase();
            const docId   = `${codeUp}_A${act}_P${ph}`;
            const tarif   = tarifsMap.get(docId) || { s1: 0, s2: 0 };
            const libNorm = normalizeText(texte);
            lastDoc = {
              docId, code: codeUp, libelle: texte, activite: act, phase: ph,
              tarifSecteur1: tarif.s1, tarifSecteur2: tarif.s2,
              motsCles: buildMotsCles(texte), libelleSearch: libNorm,
              chapTitre, sousChapTitre, paraTitre,
              notesSection: [...sectionNotes],
              notesActe: [],
            };
            // Créer aussi A4 si présent dans le V82
            const a4Key = `${codeUp}_A4_P${ph}`;
            if (tarifsMap.has(a4Key) && !docs.find(d => d.docId === a4Key)) {
              const libA4 = `Anesthésie — ${texte}`;
              docs.push({
                docId: a4Key, code: codeUp, libelle: libA4, activite: '4', phase: ph,
                tarifSecteur1: tarifsMap.get(a4Key).s1, tarifSecteur2: tarifsMap.get(a4Key).s2,
                motsCles: buildMotsCles(libA4, ['ANESTHESIE', 'ANESTH']),
                libelleSearch: normalizeText(libA4),
                chapTitre, sousChapTitre, paraTitre,
                notesSection: [...sectionNotes], notesActe: [],
              });
            }

          } else if (typo === 'N' && lastDoc && texte) {
            // Note spécifique à l'acte courant
            lastDoc.notesActe.push(texte);
          }
        }
        if (lastDoc) docs.push(lastDoc);

        if (!docs.length) { showToast("Fichier complémentaire non reconnu.", 'error'); setIsUploading(false); return; }
        await uploadBatches(docs);
        const a1=docs.filter(d=>d.activite==='1').length, a4=docs.filter(d=>d.activite==='4').length;
        const avecNotes = docs.filter(d=>d.notesActe?.length>0||d.notesSection?.length>0).length;
        showToast(`✅ ${docs.length} actes — ${a1} chirurgiens · ${a4} anesthésistes · ${avecNotes} avec notes/règles`, 'success', 8000);
      }

    } catch (err) {
      console.error('Import error:', err);
      showToast("Erreur pendant l'import. Vérifiez la console.", 'error');
    }
    setIsUploading(false); setUploadProgress(0);
  };
  const handleGoogleLogin = async() => {
    try {
      const res = await signInWithPopup(auth, new GoogleAuthProvider()), cu = res.user;
      const s = await getDoc(doc(db,"users",cu.uid));
      if (!s.exists()) {
        let defaultPrenom = ""; let defaultNom = "";
        if (cu.displayName) { const p = cu.displayName.split(' '); defaultPrenom = p[0]||""; defaultNom = p.slice(1).join(' ').toUpperCase()||""; }
        else if (cu.email) { defaultPrenom = cu.email.split('@')[0]; }
        await setDoc(doc(db,"users",cu.uid),{nom:defaultNom,prenom:defaultPrenom,email:cu.email,rpps:'',telephone:'',specialite:'1',secteur:'2',optam:false,adresse:{numero:'',rue:'',codePostal:'',ville:''},dateCreation:new Date(),lastLogin:new Date(),usageCount:0});
      } else { await updateDoc(doc(db,"users",cu.uid),{lastLogin:new Date()}); }
      setError('');
    } catch { setError("Erreur lors de la connexion avec Google."); }
  };

  const handleLogin = async(e) => {
    e.preventDefault();
    try { const r=await signInWithEmailAndPassword(auth,email,password); await updateDoc(doc(db,"users",r.user.uid),{lastLogin:new Date()}); setError(''); }
    catch { setError("Identifiants incorrects."); }
  };

  const handleRegister = async(e) => {
    e.preventDefault();
    if (!consentChecked || !proChecked) { setError("Veuillez cocher les cases obligatoires."); return; }
    try {
      const r = await createUserWithEmailAndPassword(auth,email,password);
      await setDoc(doc(db,"users",r.user.uid),{nom:nom.toUpperCase(),prenom,email,rpps,telephone,specialite,secteur:'2',optam:false,adresse:{numero:numeroRue,rue:nomRue,codePostal,ville},dateCreation:new Date(),lastLogin:new Date(),usageCount:0});
      setIsRegistering(false); setError('');
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') setError("Cette adresse email est déjà utilisée.");
      else if (err.code === 'auth/weak-password') setError("Le mot de passe doit faire au moins 6 caractères.");
      else setError("Erreur lors de l'inscription : " + err.message);
    }
  };

  const handleResetPassword = async(e) => {
    e.preventDefault();
    if (!email) { setError("Veuillez renseigner votre email."); return; }
    try { await sendPasswordResetEmail(auth,email); setResetMessage("Lien envoyé ! Vérifiez vos emails."); setError(''); }
    catch { setError("Impossible d'envoyer l'email. Vérifiez l'adresse."); }
  };

  const handleDeleteAccount = async() => {
    const ok=await showConfirm("Supprimer définitivement votre compte et toutes vos données ? Cette action est irréversible.", { danger:true, title:'Suppression du compte', confirmLabel:'Supprimer mon compte' });
    if (ok) {
      try {
        // FIX : On supprime uniquement le doc Firestore.
        // La Cloud Function "purgeCompteUtilisateur" se déclenche automatiquement
        // et efface le compte Firebase Auth + les templates + les simulations.
        // deleteUser() a été retiré pour éviter la double suppression.
        await deleteDoc(doc(db,"users",auth.currentUser.uid));
        // Déconnexion immédiate côté client
        await signOut(auth);
      } catch { showToast("Veuillez vous reconnecter avant de supprimer votre compte.", 'warning'); }
    }
  };

  const allCategories     = ['Tous',...new Set(templates.map(t=>t.category||'Non classé'))];
  const filteredTemplates = activeCategoryFilter==='Tous' ? templates : templates.filter(t=>(t.category||'Non classé')===activeCategoryFilter);
  const categoryColors    = {'Rachis':'tag--green','Hanche':'tag--blue','Genou':'tag--amber','Épaule':'tag--purple','Partagé':'tag--slate'};
  const getCategoryTag    = (cat) => categoryColors[cat]||'tag--slate';

  const footerBranding = (
    <div className="footer-branding">
      <img src={LOGO_URL} alt="Logo" />
      <p>Powered by <strong>Institut Orthopédique de Paris</strong></p>
      <p>Développé par Dr Raphaël Jameson</p>
    </div>
  );

  const liveIndicator = (
    <span title="Synchronisation temps réel" style={{display:'inline-block',width:'7px',height:'7px',borderRadius:'50%',background:'var(--emerald-500)',marginLeft:'10px',verticalAlign:'middle',boxShadow:'0 0 0 2px rgba(16,185,129,0.3)'}} />
  );

  const renderShareModal = () => {
    if (!sharedTemplate) return null;
    const url=`${window.location.origin}/?import=${encodeTemplate(sharedTemplate)}`;
    return (
      <div className="modal-overlay" onClick={()=>setSharedTemplate(null)}>
        <div className="modal" onClick={e=>e.stopPropagation()}>
          <h3 className="modal__title">Partager ce modèle</h3>
          <p className="modal__subtitle">Faites scanner ce QR Code par votre confrère.</p>
          <div className="modal__qr-wrapper"><QRCodeCanvas value={url} size={200} /></div>
          <div className="modal__actions"><button className="btn btn--ghost" style={{flex:1}} onClick={()=>setSharedTemplate(null)}>Fermer</button></div>
        </div>
      </div>
    );
  };

  const renderIncomingModal = () => {
    if (!user||!incomingTemplate) return null;
    return (
      <div className="modal-overlay">
        <div className="modal modal--incoming">
          <h2 className="modal__title" style={{color:'var(--emerald-600)'}}>Nouveau modèle reçu</h2>
          <p className="modal__subtitle">Un confrère vous partage son modèle :</p>
          <div className="modal__template-name">{incomingTemplate.n}</div>
          <div style={{fontSize:'13px',color:'var(--color-text-secondary)',textAlign:'left',marginBottom:'20px'}}>
            {incomingTemplate.a.map((act,i)=><div key={i} style={{padding:'3px 0'}}><span className="code-badge">{act.code}</span></div>)}
            {incomingTemplate.fv>0&&<div style={{marginTop:'10px',color:'var(--emerald-600)',fontWeight:'600'}}>Honoraires : {incomingTemplate.fv}{incomingTemplate.ft==='amount'?' €':' %'}</div>}
          </div>
          <div className="modal__actions">
            <button className="btn btn--success" style={{flex:2}} onClick={handleAcceptSharedTemplate}>Ajouter à mes favoris</button>
            <button className="btn btn--ghost"   style={{flex:1}} onClick={()=>setIncomingTemplate(null)}>Refuser</button>
          </div>
        </div>
      </div>
    );
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE AUTH
  // ══════════════════════════════════════════════════════════════════════════
  if (!user) {
    return (
      <div className="auth-wrapper">
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        <ConfirmModal state={confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
        <div className="auth-card">
          <div className="auth-logo">
            <img src={LOGO_URL} alt="Logo" style={{maxHeight:'50px',marginBottom:'12px'}} />
            <div className="auth-logo__title">Optim'<span>CCAM</span></div>
            <div className="auth-logo__subtitle">Outil d'optimisation du dépassement d'honoraires</div>
          </div>
          {incomingTemplate&&<div className="incoming-banner"><strong>Modèle reçu.</strong><br/>Connectez-vous pour l'enregistrer.</div>}
          {error&&<div className="auth-error">{error}</div>}

          {isResettingPassword?(
            <form onSubmit={handleResetPassword}>
              <p style={{fontSize:'13px',color:'var(--color-text-secondary)',marginBottom:'16px',textAlign:'center'}}>Entrez votre email pour recevoir un lien.</p>
              <input type="email" placeholder="Email professionnel" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              {resetMessage&&<div className="auth-success">{resetMessage}</div>}
              <button type="submit" className="btn btn--warning" style={{width:'100%',padding:'12px'}}>Envoyer le lien</button>
              <p style={{textAlign:'center',marginTop:'16px',fontSize:'13px'}}><span className="auth-link" onClick={()=>{setIsResettingPassword(false);setResetMessage('');setError('');}}>← Retour</span></p>
            </form>
          ):isRegistering?(
            <form onSubmit={handleRegister}>
              <div className="responsive-grid-profile" style={{marginBottom:0}}>
                <input type="text" placeholder="Nom *" value={nom} onChange={e=>setNom(e.target.value)} autoComplete="family-name" required style={{marginBottom:'12px'}} />
                <input type="text" placeholder="Prénom *" value={prenom} onChange={e=>setPrenom(e.target.value)} autoComplete="given-name" required style={{marginBottom:'12px'}} />
              </div>
              <input type="email" placeholder="Email *" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              <input type="password" placeholder="Mot de passe * (min. 6 caractères)" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" required style={{marginBottom:'12px'}} />
              <input type="text" placeholder="N° RPPS (Optionnel)" value={rpps} onChange={e=>setRpps(e.target.value)} style={{marginBottom:'12px'}} />
              <div style={{display:'flex', flexDirection:'column', gap:'8px', marginBottom:'16px'}}>
                <label className="consent-label">
                  <input type="checkbox" checked={proChecked} onChange={e=>setProChecked(e.target.checked)} required />
                  Je certifie être un professionnel de santé (ou assistant(e)). *
                </label>
                <label className="consent-label">
                  <input type="checkbox" checked={consentChecked} onChange={e=>setConsentChecked(e.target.checked)} required />
                  J'accepte que mes données soient traitées conformément au RGPD. *
                </label>
              </div>
              <button type="submit" className="btn btn--success" style={{width:'100%',padding:'12px'}}>Créer mon compte</button>
              <div className="auth-divider">ou</div>
              <button type="button" className="btn-google" onClick={handleGoogleLogin}><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{width:'18px'}} /> Continuer avec Google</button>
              <p style={{textAlign:'center',marginTop:'16px',fontSize:'13px'}}><span className="auth-link" onClick={()=>{setIsRegistering(false);setError('');}}>← Retour à la connexion</span></p>
            </form>
          ):(
            <form onSubmit={handleLogin}>
              <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required style={{marginBottom:'12px'}} />
              <input type="password" placeholder="Mot de passe" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required style={{marginBottom:'16px'}} />
              <button type="submit" className="btn btn--primary" style={{width:'100%',padding:'12px'}}>Se connecter</button>
              <div className="auth-divider">ou</div>
              <button type="button" className="btn-google" onClick={handleGoogleLogin}><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{width:'18px'}} /> Continuer avec Google</button>
              <div className="auth-footer">
                <span className="auth-link" onClick={()=>{setIsResettingPassword(true);setError('');setResetMessage('');}}>Mot de passe oublié ?</span>
                <span className="auth-link" onClick={()=>{setIsRegistering(true);setError('');}}>Créer un compte</span>
              </div>
            </form>
          )}
        </div>
        {footerBranding}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // APP PRINCIPALE
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="app-body">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <ConfirmModal state={confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      {renderShareModal()}
      {renderIncomingModal()}

      <nav className="app-navbar">
        <div className="app-navbar__logo">Optim'<span>CCAM</span></div>
        <div className="responsive-navbar-buttons">
          <button className={`nav-btn${activeTab==='browser'?' nav-btn--active':''}`} onClick={()=>setActiveTab('browser')}>Navigateur</button>
          <button className={`nav-btn${activeTab==='simulator'?' nav-btn--active':''}`} onClick={()=>setActiveTab('simulator')}>Simulateur</button>
          <button className={`nav-btn${activeTab==='favorites'?' nav-btn--active':''}`} onClick={()=>setActiveTab('favorites')}>Favoris {isLoadingTemplates&&<span style={{fontSize:'10px',opacity:0.6}}>⏳</span>}</button>
          <button className={`nav-btn${activeTab==='profile'?' nav-btn--active':''}`} onClick={()=>setActiveTab('profile')}>Profil</button>
          {auth.currentUser?.email===ADMIN_EMAIL&&<button className={`nav-btn${activeTab==='dashboard'?' nav-btn--active':''}`} onClick={()=>setActiveTab('dashboard')}>Admin</button>}
          <button className="nav-btn nav-btn--exit" onClick={()=>signOut(auth)}>Quitter</button>
        </div>
      </nav>

      <div className="app-container">

        {/* ── NAVIGATEUR ────────────────────────────────────────────────── */}
        {activeTab==='browser'&&(
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
              <div className="card__title" style={{ margin: 0 }}>Navigateur CCAM</div>
              <div className="fee-box__tabs" style={{ background: 'var(--slate-100)', padding: '4px', borderRadius: '8px', margin: 0, display: 'flex', gap: '4px' }}>
                <button
                  style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: '500', background: browserView === 'search' ? '#fff' : 'transparent', color: browserView === 'search' ? 'var(--navy-800)' : 'var(--slate-500)', boxShadow: browserView === 'search' ? 'var(--shadow-sm)' : 'none' }}
                  onClick={() => { setBrowserView('search'); setSelectedBrowserAct(null); }}
                >🔍 Recherche</button>
                <button
                  style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: '500', background: browserView === 'favorites' ? '#fff' : 'transparent', color: browserView === 'favorites' ? 'var(--navy-800)' : 'var(--slate-500)', boxShadow: browserView === 'favorites' ? 'var(--shadow-sm)' : 'none' }}
                  onClick={() => { setBrowserView('favorites'); setSelectedBrowserAct(null); }}
                >⭐ Mes Favoris ({favoriteActs.length})</button>
              </div>
            </div>

            {selectedBrowserAct ? (
              <div style={{border:'1px solid var(--color-border)',borderRadius:'var(--radius-md)',padding:'20px',display:'flex',flexDirection:'column',gap:'16px',background:'var(--slate-50)',boxShadow:'var(--shadow-sm)'}}>

                {/* ── En-tête : code + tarif + fermer ── */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                  <div style={{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap'}}>
                    <span className="code-badge" style={{fontSize:'16px',padding:'6px 10px',background:'var(--sky-100)',color:'var(--navy-800)'}}>{selectedBrowserAct.code}</span>
                    <strong style={{color:'var(--sky-500)',fontSize:'18px'}}>
                      {(secteur==='1'||optam)?selectedBrowserAct.tarifSecteur1:selectedBrowserAct.tarifSecteur2} €
                    </strong>
                    {selectedBrowserAct.activite==='4'&&<span style={{fontSize:'11px',background:'var(--amber-50)',color:'var(--amber-600)',border:'1px solid var(--amber-200)',borderRadius:'4px',padding:'2px 8px',fontWeight:'600'}}>Anesthésiste</span>}
                    {selectedBrowserAct.activite==='2'&&<span style={{fontSize:'11px',background:'var(--slate-100)',color:'var(--slate-600)',border:'1px solid var(--slate-200)',borderRadius:'4px',padding:'2px 8px',fontWeight:'600'}}>Aide op.</span>}
                  </div>
                  <button className="btn-icon" onClick={()=>setSelectedBrowserAct(null)} title="Fermer">✕</button>
                </div>

                {/* ── Arborescence (si disponible) ── */}
                {selectedBrowserAct.chapTitre && (
                  <div style={{fontSize:'11px',color:'var(--color-text-muted)',display:'flex',gap:'4px',alignItems:'center',flexWrap:'wrap'}}>
                    <span style={{background:'var(--slate-100)',padding:'2px 8px',borderRadius:'4px'}}>{selectedBrowserAct.chapTitre}</span>
                    {selectedBrowserAct.sousChapTitre&&<><span>›</span><span style={{background:'var(--slate-100)',padding:'2px 8px',borderRadius:'4px'}}>{selectedBrowserAct.sousChapTitre}</span></>}
                    {selectedBrowserAct.paraTitre&&<><span>›</span><span style={{background:'var(--slate-100)',padding:'2px 8px',borderRadius:'4px'}}>{selectedBrowserAct.paraTitre}</span></>}
                  </div>
                )}

                {/* ── Libellé complet ── */}
                <div style={{fontSize:'14px',color:'var(--color-text-primary)',lineHeight:'1.7',background:'#fff',padding:'16px',borderRadius:'8px',border:'1px solid var(--color-border-soft)',fontWeight:'500'}}>
                  {selectedBrowserAct.libelle}
                </div>

                {/* ── Notes spécifiques à l'acte ── */}
                {selectedBrowserAct.notesActe?.length>0 && (
                  <div style={{background:'var(--sky-50)',border:'1px solid var(--sky-200)',borderRadius:'8px',padding:'14px'}}>
                    <div style={{fontSize:'10px',fontWeight:'700',color:'var(--sky-500)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'8px'}}>ℹ️ Notes de l'acte</div>
                    {selectedBrowserAct.notesActe.map((n,i)=>(
                      <p key={i} style={{fontSize:'13px',color:'var(--sky-700)',margin:'4px 0',lineHeight:'1.5'}}>{n}</p>
                    ))}
                  </div>
                )}

                {/* ── Règles du chapitre (exclusions, inclusions, conditions) ── */}
                {selectedBrowserAct.notesSection?.length>0 && (
                  <div style={{background:'var(--rose-50)',border:'1px solid var(--rose-200)',borderRadius:'8px',padding:'14px'}}>
                    <div style={{fontSize:'10px',fontWeight:'700',color:'var(--rose-600)',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'8px'}}>⚠️ Règles du chapitre</div>
                    {selectedBrowserAct.notesSection.map((n,i)=>{
                      const isExclusion = /exclusion|ne pas|interdit/i.test(n);
                      const isInclusion = /inclut|comprend|avec ou sans/i.test(n);
                      return (
                        <p key={i} style={{fontSize:'13px',color: isExclusion?'var(--rose-700)': isInclusion?'var(--emerald-700)':'var(--slate-600)',margin:'6px 0',lineHeight:'1.5',paddingLeft:'8px',borderLeft:`3px solid ${isExclusion?'var(--rose-400)':isInclusion?'var(--emerald-400)':'var(--slate-300)'}`}}>
                          {isExclusion?'⛔ ':isInclusion?'✅ ':'ℹ️ '}{n}
                        </p>
                      );
                    })}
                  </div>
                )}

                {/* ── Actions ── */}
                <div style={{display:'flex',gap:'10px',marginTop:'4px'}}>
                  <button className="btn btn--primary" style={{flex:1}} onClick={()=>addActToSimulatorFromBrowser(selectedBrowserAct)}>
                    ➕ Ajouter au Simulateur
                  </button>
                  {favoriteActs.some(a=>a.code===selectedBrowserAct.code)?(
                    <button className="btn btn--slate" style={{flex:1}} onClick={()=>toggleFavoriteAct(selectedBrowserAct)}>★ Retirer des favoris</button>
                  ):(
                    <button className="btn btn--warning" style={{flex:1}} onClick={()=>toggleFavoriteAct(selectedBrowserAct)}>☆ Ajouter aux favoris</button>
                  )}
                </div>
              </div>
            ) : browserView === 'search' ? (
              <>
                <div style={{ marginBottom: '20px' }}>
                  {/* specialite={null} → recherche toutes activités (A1, A2, A4) sans filtre de rôle */}
                  <SearchAutocomplete specialite={null} userSecteur={secteur} isOptam={optam} onSelect={(act) => setSelectedBrowserAct(act)} maxActs={999} maxResults={50} placeholder="Rechercher un acte (ex: LFDA009) ou mots-clés (ex: SPONDYLOLISTHESIS)..." />
                </div>
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                  Utilisez la barre de recherche ci-dessus pour explorer la nomenclature CCAM.
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {favoriteActs.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                    Vous n'avez pas encore de codes favoris. Cherchez un acte et cliquez sur l'étoile pour l'ajouter ici.
                  </div>
                ) : (
                  favoriteActs.map(act => {
                    const displayTarif = (secteur === '1' || optam) ? act.tarifSecteur1 : act.tarifSecteur2;
                    return (
                      <div key={act.code} onClick={() => setSelectedBrowserAct(act)} style={{display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', transition: 'all var(--duration-fast)'}}
                        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--sky-500)'}
                        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--color-border)'}>
                        <span style={{ color: 'var(--amber-500)', fontSize: '18px' }}>★</span>
                        <span className="code-badge">{act.code}</span>
                        <span style={{ flex: 1, fontSize: '13px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{act.libelle}</span>
                        <strong style={{ color: 'var(--color-text-primary)' }}>{displayTarif} €</strong>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* ── PROFIL ────────────────────────────────────────────────────── */}
        {activeTab==='profile'&&(
          <div>
            <div className="card">
              <div className="card__title">Mon profil professionnel</div>
              <form onSubmit={e=>e.preventDefault()}>
                <div className="responsive-grid-profile">
                  <div><label>Nom</label><input type="text" value={nom} onChange={e=>setNom(e.target.value)} style={{marginBottom:'12px'}} /></div>
                  <div><label>Prénom</label><input type="text" value={prenom} onChange={e=>setPrenom(e.target.value)} style={{marginBottom:'12px'}} /></div>
                  <div><label>Email</label><input type="text" value={auth.currentUser?.email} disabled style={{marginBottom:'12px'}} /></div>
                  <div><label>RPPS</label><input type="text" value={rpps} onChange={e=>setRpps(e.target.value)} style={{marginBottom:'12px'}} /></div>
                  <div><label>Téléphone</label><input type="tel" value={telephone} onChange={e=>setTelephone(e.target.value)} style={{marginBottom:'12px'}} /></div>
                </div>
                <div style={{marginTop:'4px',borderTop:'1px solid var(--color-border-soft)',paddingTop:'14px',marginBottom:'4px'}}>
                  <div className="card__label" style={{marginBottom:'12px'}}>Adresse du cabinet</div>
                  <div className="responsive-grid-profile">
                    <div><label>Rue</label><input type="text" value={nomRue} onChange={e=>setNomRue(e.target.value)} placeholder="Ex : 12 avenue de la Grande Armée" style={{marginBottom:'12px'}} /></div>
                    <div><label>Complément</label><input type="text" value={numeroRue} onChange={e=>setNumeroRue(e.target.value)} placeholder="Bâtiment, étage..." style={{marginBottom:'12px'}} /></div>
                    <div><label>Code postal</label><input type="text" value={codePostal} onChange={e=>setCodePostal(e.target.value)} placeholder="75016" style={{marginBottom:'12px'}} /></div>
                    <div><label>Ville</label><input type="text" value={ville} onChange={e=>setVille(e.target.value)} placeholder="Paris" style={{marginBottom:'12px'}} /></div>
                  </div>
                </div>
                <div style={{marginTop:'12px',borderTop:'1px solid var(--color-border-soft)',paddingTop:'16px'}}>
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
                        <div className={`role-option${secteur==='1'?' role-option--selected':''}`} onClick={()=>{setSecteur('1');setOptam(false);}}>Secteur 1</div>
                        <div className={`role-option${secteur==='2'?' role-option--selected':''}`} onClick={()=>setSecteur('2')}>Secteur 2</div>
                      </div>
                      {secteur==='2'&&(
                        <label className="consent-label" style={{background:'var(--sky-50)',padding:'10px',borderRadius:'8px'}}>
                          <input type="checkbox" checked={optam} onChange={e=>setOptam(e.target.checked)} />
                          <strong style={{color:'var(--navy-600)'}}>Adhérent OPTAM / OPTAM-CO</strong>
                          <div style={{fontSize:'11px',color:'var(--color-text-muted)',marginTop:'4px'}}>Applique la base de remboursement du Secteur 1.</div>
                        </label>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{display:'flex', justifyContent:'center', alignItems:'center', marginTop:'24px', padding:'12px', background:'var(--sky-50)', borderRadius:'8px'}}>
                  <span style={{fontSize:'13px', color: saveStatus.includes('✓') ? 'var(--emerald-600)' : 'var(--navy-600)', fontWeight:'600'}}>
                    {saveStatus || 'Vos modifications sont sauvegardées automatiquement.'}
                  </span>
                </div>
              </form>
            </div>
            <div className="card card--danger" style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'12px'}}>
              <div><div style={{fontWeight:'600',marginBottom:'4px'}}>Zone de danger</div><div style={{fontSize:'13px',color:'var(--color-text-secondary)'}}>La suppression est irréversible.</div></div>
              <button className="btn btn--danger" onClick={handleDeleteAccount}>Supprimer mon compte</button>
            </div>
          </div>
        )}

        {/* ── FAVORIS ───────────────────────────────────────────────────── */}
        {activeTab==='favorites'&&(
          <div>
            {!isEditingFav?(
              <div>
                <div className="card">
                  <div className="favorites-header">
                    <div className="card__title" style={{margin:0}}>Mes modèles favoris {liveIndicator}</div>
                    <div className="favorites-header__actions">
                      <label className="btn btn--slate" style={{cursor:'pointer',margin:0}}><input type="file" accept=".json" style={{display:'none'}} onChange={handleImportFavorites} />Importer</label>
                      <button className="btn btn--sky"     onClick={handleExportAllFavorites}>Exporter tout</button>
                      <button className="btn btn--ghost"   onClick={()=>printTemplates(templates,secteur,optam,specialite)}>Imprimer tout</button>
                      <button className="btn btn--success" onClick={startCreateFav}>+ Nouveau</button>
                    </div>
                  </div>
                  <div className="category-filters">
                    {allCategories.map(cat=><button key={cat} className={`category-btn${activeCategoryFilter===cat?' category-btn--active':''}`} onClick={()=>setActiveCategoryFilter(cat)}>{cat}</button>)}
                  </div>
                </div>
                {isLoadingTemplates?(
                  <div className="favorites-grid">{[1,2,3].map(i=><div key={i} className="fav-card"><div className="skeleton" style={{height:'20px',width:'70%',marginBottom:'12px'}} /><div className="skeleton" style={{height:'14px',width:'100%',marginBottom:'8px'}} /><div className="skeleton" style={{height:'60px',marginTop:'12px'}} /></div>)}</div>
                ):(
                  <div className="favorites-grid">
                    {filteredTemplates.map(t=>{
                      const calc=computeActs(t.acts,secteur,optam,specialite),tb=computeTotal(calc),td=computeDep(t.feeType,t.feeValue,tb);
                      return (
                        <div key={t.id} className="fav-card">
                          <div className="fav-card__header">
                            <div className="fav-card__title">{t.name}</div>
                            <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
                              <span className={`tag ${getCategoryTag(t.category||'Non classé')}`}>{t.category||'Non classé'}</span>
                              <button className="btn-icon" onClick={()=>printTemplates([t],secteur,optam,specialite)} title="Imprimer">🖨</button>
                              <button className="btn-icon" onClick={()=>setSharedTemplate(t)} title="Partager">🔗</button>
                              <button className="btn-icon" onClick={()=>startEditFav(t)} title="Modifier">✏️</button>
                              <button className="btn-icon btn-icon--danger" onClick={()=>deleteTemplate(t.id)} title="Supprimer">🗑</button>
                            </div>
                          </div>
                          <div className="fav-card__acts">
                            {t.acts.map((a,i)=><div key={i} className="fav-act-row"><span className="code-badge">{a.code}</span><span style={{fontSize:'11px'}}>{a.libelle}</span></div>)}
                          </div>
                          <DpiCompact calculated={calc} totalBase={tb} totalDep={td} feeValue={t.feeValue} feeType={t.feeType} />
                          <div className="fav-card__footer">
                            <button className="btn btn--primary" style={{flex:2,padding:'8px'}} onClick={()=>loadTemplateIntoSimulator(t)}>Charger</button>
                            <button className="btn btn--ghost"   style={{flex:1,padding:'8px'}} onClick={()=>startEditFav(t)}>Modifier</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ):(
              <div className="card">
                <div className="card__title">{currentFavId?"Modifier le favori":"Créer un favori"}</div>
                <div className="responsive-grid-profile" style={{marginBottom:'16px'}}>
                  <div><label>Nom *</label><input type="text" placeholder="Ex : Arthrodèse L5-S1..." value={favNameInput} onChange={e=>setFavNameInput(e.target.value)} /></div>
                  <div><label>Catégorie</label><input type="text" placeholder="Ex : Rachis, Hanche..." value={favCategoryInput} onChange={e=>setFavCategoryInput(e.target.value)} /></div>
                </div>
                <FeeBox feeType={favFeeType} feeValue={favFeeValue} onTypeChange={setFavFeeType} onValueChange={setFavFeeValue} />
                <div style={{marginTop:'16px'}}>
                  <label>Rechercher un acte CCAM (3 max.)</label>
                  <SearchAutocomplete specialite={specialite} userSecteur={secteur} isOptam={optam} onSelect={addActToFav} maxActs={3-favActsInput.length} placeholder="Code CCAM ou mot-clé..." />
                </div>
                {favActsInput.length>0&&(
                  <div style={{marginTop:'20px'}}>
                    <div className="card__label">Actes sélectionnés</div>
                    {favCalculated.map((act,idx)=><ActCard key={idx} act={act} index={idx} onRemove={()=>setFavActsInput(p=>p.filter((_,i)=>i!==idx))} onModifierChange={(m)=>()=>toggleFavModifier(idx,m)} />)}
                  </div>
                )}
                {favTotalDep>0&&favActsInput.length>0&&<DpiBox calculated={favCalculated} totalBase={favTotalBase} totalDep={favTotalDep} feeValue={favFeeValue} feeType={favFeeType} />}
                <div className="responsive-action-buttons" style={{marginTop:'20px'}}>
                  <button className="btn btn--success" style={{flex:1,padding:'12px'}} onClick={saveFavChanges}>Enregistrer</button>
                  <button className="btn btn--ghost"   style={{flex:1,padding:'12px'}} onClick={()=>setIsEditingFav(false)}>Annuler</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SIMULATEUR ────────────────────────────────────────────────── */}
        {activeTab==='simulator'&&(
          <div className="responsive-grid-sim">
            <div>
              <div className="card">
                <div className="card__label">Ajouter un acte CCAM</div>
                <SearchAutocomplete specialite={specialite} userSecteur={secteur} isOptam={optam} onSelect={addAct} maxActs={3-selectedActs.length} placeholder="Tapez un code (ex: NEKA010) ou un mot-clé (ex: PROTHESE)..." />
                {selectedActs.length>=3&&<p style={{fontSize:'12px',color:'var(--color-text-muted)',marginTop:'8px',textAlign:'center'}}>Maximum 3 actes atteint.</p>}
              </div>

              {selectedActs.length>0&&(
                <div className="card">
                  <div className="metrics-row">
                    <div className="metric-card"><div className="metric-card__label">Base CCAM totale</div><div className="metric-card__value">{totalBase.toFixed(2)} €</div></div>
                    {totalDep>0&&<div className="metric-card"><div className="metric-card__label">Honoraires DPI</div><div className="metric-card__value metric-card__value--success">{totalDep.toFixed(2)} €</div></div>}
                  </div>
                  {calculated.map((act,idx)=><ActCard key={idx} act={act} index={idx} onRemove={()=>setSelectedActs(p=>p.filter((_,i)=>i!==idx))} onModifierChange={(m)=>()=>toggleSimModifier(idx,m)} />)}
                  <FeeBox feeType={feeType} feeValue={feeValue} onTypeChange={setFeeType} onValueChange={setFeeValue} />
                  <DpiBox calculated={calculated} totalBase={totalBase} totalDep={totalDep} feeValue={feeValue} feeType={feeType} />
                  <div style={{marginBottom:'10px'}}>
                    <label style={{fontWeight:'600',fontSize:'12px',color:'var(--color-text-secondary)',display:'block',marginBottom:'6px'}}>Nom de l'intervention / du patient</label>
                    <input type="text" className="input--title" placeholder="Ex : PTH DUPONT Jean — Arthrodèse L5-S1..." value={interventionName} onChange={e=>setInterventionName(e.target.value)} style={{fontSize:'15px'}} />
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
                  <div key={t.id} className="fav-quick-item" onClick={()=>loadTemplateIntoSimulator(t)}>
                    <div className="fav-quick-item__name">{t.name}</div>
                    <div className="fav-quick-item__sub">{t.category||'Non classé'}{t.feeValue>0?` · ${t.feeValue}${t.feeType==='amount'?' €':' %'}`:''}</div>
                  </div>
                ))}
              </div>
              {(isLoadingSimulations||simulations.length>0)&&(
                <div className="sidebar-card">
                  <div className="sidebar-card__title">Historique récent {liveIndicator}</div>
                  {isLoadingSimulations?(
                    [1,2,3].map(i=><div key={i} className="skeleton" style={{height:'14px',marginBottom:'10px',borderRadius:'6px'}} />)
                  ):simulations.map((s,i)=>{
                    const colors=['var(--emerald-500)','var(--sky-500)','var(--amber-500)','var(--slate-400)'];
                    return <div key={s.id} className="hist-item" onClick={()=>{setSelectedActs(s.acts);setInterventionName(s.patient);setFeeValue(s.feeValue);setFeeType(s.feeType);}}><div className="hist-item__dot" style={{background:colors[i%colors.length]}} /><div className="hist-item__name">{s.patient}</div><div className="hist-item__date">{new Date(s.date.seconds*1000).toLocaleDateString()}</div></div>;
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ADMIN ─────────────────────────────────────────────────────── */}
        {activeTab==='dashboard'&&auth.currentUser?.email===ADMIN_EMAIL&&(
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
                      <td>
                        <strong>{u.nom} {u.prenom}</strong><br/>
                        <span style={{fontSize:'12px', color:'var(--sky-500)', display:'inline-block', marginBottom:'2px'}}>{u.email}</span><br/>
                        <span className="text-muted text-xs">RPPS : {u.rpps}</span>
                      </td>
                      <td><span style={{color:'var(--emerald-600)',fontWeight:'500',fontSize:'12px'}}>{u.lastLogin?.seconds?new Date(u.lastLogin.seconds*1000).toLocaleString():'Jamais'}</span></td>
                      <td style={{textAlign:'center'}}>{u.usageCount||0}</td>
                      <td>
                        <div style={{display:'flex',gap:'6px'}}>
                          <button className="btn btn--warning" style={{padding:'5px 10px',fontSize:'12px'}} onClick={()=>handleAdminResetPassword(u.email)}>MdP</button>
                          <button className="btn btn--danger"  style={{padding:'5px 10px',fontSize:'12px'}} onClick={()=>handleDeleteUserAdmin(u.id)}>Suppr.</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="maintenance-box">
              <div className="card__label" style={{marginBottom:'8px'}}>
                Importation CCAM V82
              </div>
              <div style={{fontSize:'12px',color:'var(--color-text-secondary)',marginBottom:'12px',background:'var(--sky-50)',border:'1px solid var(--sky-200)',borderRadius:'8px',padding:'10px 14px'}}>
                <strong style={{color:'var(--navy-700)'}}>Mode 1 — XLS V82 seul</strong> : sélectionner <code>CCAM_V82_...VF.xls</code><br/>
                <strong style={{color:'var(--emerald-700)'}}>Mode 2 — Enrichi (recommandé)</strong> : sélectionner les <strong>2 fichiers simultanément</strong> (Ctrl+clic) :<br/>
                <span style={{paddingLeft:'12px'}}>• <code>CCAM_V82_...VF.xls</code> + <code>fichier_complementaire_...xlsx</code></span><br/>
                <span style={{color:'var(--emerald-600)',fontWeight:'500'}}>→ Ajoute notes, exclusions, arborescence dans le Navigateur</span>
              </div>
              <div style={{display:'flex',gap:'10px',flexWrap:'wrap',alignItems:'center'}}>
                <input type="file" accept=".xls,.xlsx,.csv" multiple onChange={handleFileUpload} style={{flex:1,minWidth:'200px'}} />
                <button className="btn btn--danger" style={{border:'1px solid var(--rose-500)',background:'transparent',color:'var(--rose-500)'}} onClick={handleClearDatabase}>Nettoyer</button>
              </div>
              {isUploading&&(
                <div style={{marginTop:'12px'}}>
                  <div className="progress-bar"><div className="progress-bar__fill" style={{width:`${uploadProgress}%`}} /></div>
                  <p className="progress-bar__label">Progression : {uploadProgress}% — Ne fermez pas cette page</p>
                </div>
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
