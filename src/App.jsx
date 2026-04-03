// Chemin complet : src/App.jsx
// Version : Optim'CCAM - Base de Référence + Importateur Séquentiel (Anti-plantage)

import { useState, useEffect } from 'react';
import { auth, db } from './firebase'; 
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut, 
  onAuthStateChanged, 
  sendPasswordResetEmail,
  deleteUser
} from 'firebase/auth';
import { 
  doc, 
  setDoc, 
  updateDoc,
  getDoc,
  deleteDoc,
  writeBatch, 
  collection, 
  query, 
  where, 
  getDocs, 
  addDoc,
  orderBy,
  limit,
  startAt,
  endAt,
  increment 
} from 'firebase/firestore'; 
import Papa from 'papaparse';

const LOGO_URL = "https://www.institutorthopedique.paris/wp-content/uploads/2025/07/CROPinstitut-orthopedique-paris-logo-grand.png";

function App() {
  // --- 1. ÉTATS AUTHENTIFICATION & PROFIL ---
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [isRegistering, setIsRegistering] = useState(false); 
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [consentChecked, setConsentChecked] = useState(false); 
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nom, setNom] = useState('');
  const [prenom, setPrenom] = useState('');
  const [rpps, setRpps] = useState('');
  const [telephone, setTelephone] = useState('');
  const [numeroRue, setNumeroRue] = useState('');
  const [nomRue, setNomRue] = useState('');
  const [codePostal, setCodePostal] = useState('');
  const [ville, setVille] = useState('');
  const [specialite, setSpecialite] = useState('1'); 

  // --- 2. ÉTATS APPLICATION (SIMULATEUR) ---
  const [isUploading, setIsUploading] = useState(false); 
  const [uploadProgress, setUploadProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedActs, setSelectedActs] = useState([]); 
  const [feeType, setFeeType] = useState('amount'); 
  const [feeValue, setFeeValue] = useState(0);
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState('');

  // --- 3. ÉTATS GESTION FAVORIS ---
  const [isEditingFav, setIsEditingFav] = useState(false);
  const [currentFavId, setCurrentFavId] = useState(null);
  const [favNameInput, setFavNameInput] = useState('');
  const [favActsInput, setFavActsInput] = useState([]);
  const [favFeeType, setFavFeeType] = useState('amount');
  const [favFeeValue, setFavFeeValue] = useState(0);
  const [favSearchTerm, setFavSearchTerm] = useState('');
  const [favSearchResults, setFavSearchResults] = useState([]);

  // --- 4. ÉTATS NAVIGATION & ADMIN ---
  const [simulations, setSimulations] = useState([]);
  const [interventionName, setInterventionName] = useState('');
  const [usersList, setUsersList] = useState([]);
  const [activeTab, setActiveTab] = useState('simulator'); 

  const ADMIN_EMAIL = "dr.jameson@rachis.paris"; 

  // --- INITIALISATION ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await loadUserProfile(currentUser.uid);
        fetchTemplates(currentUser.uid);
        fetchSimulations(currentUser.uid);
        if (currentUser.email === ADMIN_EMAIL) fetchUsersList();
      } else {
        setUserProfile(null); setTemplates([]); setSimulations([]); setUsersList([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (activeTab === 'dashboard' && auth.currentUser?.email === ADMIN_EMAIL) {
      fetchUsersList();
    }
  }, [activeTab]);

  const loadUserProfile = async (uid) => {
    const docSnap = await getDoc(doc(db, "users", uid));
    if (docSnap.exists()) {
      const data = docSnap.data();
      setUserProfile(data);
      setNom(data.nom || ''); setPrenom(data.prenom || ''); setRpps(data.rpps || '');
      setTelephone(data.telephone || ''); setNumeroRue(data.adresse?.numero || '');
      setNomRue(data.adresse?.rue || ''); setCodePostal(data.adresse?.codePostal || '');
      setVille(data.adresse?.ville || ''); setSpecialite(data.specialite || '1');
    }
  };

  const fetchTemplates = async (uid) => {
    const q = query(collection(db, "templates"), where("userId", "==", uid));
    const snap = await getDocs(q);
    setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  };

  const fetchSimulations = async (uid) => {
    try {
      const q = query(collection(db, "simulations"), where("userId", "==", uid), orderBy("date", "desc"), limit(10));
      const snap = await getDocs(q);
      setSimulations(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  const fetchUsersList = async () => {
    try {
      const snap = await getDocs(collection(db, "users"));
      setUsersList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };

  // --- RECHERCHE CCAM ---
  const performSearch = async (term, limitCount = 20) => {
    if (!term) return [];
    const searchUpper = term.toUpperCase().trim();
    let q;
    if (searchUpper.length === 7 && /^[A-Z]{4}\d{3}$/.test(searchUpper)) {
      q = query(collection(db, "actes_ccam"), where("code", "==", searchUpper), where("activite", "==", specialite));
    } else {
      q = query(collection(db, "actes_ccam"), where("activite", "==", specialite), orderBy("libelle"), startAt(searchUpper), endAt(searchUpper + '\uf8ff'), limit(limitCount));
    }
    const snap = await getDocs(q);
    const res = []; snap.forEach(d => res.push({ id: d.id, ...d.data() }));
    return res;
  };

  const handleSearch = async () => { setSearchResults(await performSearch(searchTerm)); };
  const handleFavSearch = async () => { setFavSearchResults(await performSearch(favSearchTerm, 10)); };

  // --- IMPORTATION CSV "Goutte-à-Goutte" (ULTRA ROBUSTE) ---
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(1);

    let rowBuffer = [];
    const CHUNK_SIZE = 50; 
    let totalProcessed = 0;

    Papa.parse(file, {
      skipEmptyLines: true,
      step: async function(row, parser) {
        const data = row.data;
        // Filtrage de la ligne
        if (data[0] && data[0].toString().trim().length === 7) {
          rowBuffer.push(data);
        }

        // Si le tampon est plein, on met la lecture en pause et on écrit dans Firestore
        if (rowBuffer.length >= CHUNK_SIZE) {
          parser.pause();
          await commitBatch(rowBuffer);
          totalProcessed += rowBuffer.length;
          setUploadProgress(Math.min(99, Math.round((totalProcessed / 15000) * 100))); // 15k est une estimation
          rowBuffer = [];
          parser.resume();
        }
      },
      complete: async function() {
        if (rowBuffer.length > 0) {
          await commitBatch(rowBuffer);
        }
        setUploadProgress(100);
        setIsUploading(false);
        alert("Importation terminée !");
      }
    });
  };

  const commitBatch = async (rows) => {
    const batch = writeBatch(db);
    rows.forEach(acte => {
      const code = acte[0].toString().trim().toUpperCase();
      const libelle = (acte[2] || "").toString().toUpperCase().trim();
      const actId = (acte[3] || "1").toString();
      const phaId = (acte[4] || "0").toString();
      const s1 = acte[5] ? parseFloat(acte[5].toString().replace(',', '.')) : 0;
      const s2 = acte[6] ? parseFloat(acte[6].toString().replace(',', '.')) : s1;

      const docRef = doc(db, "actes_ccam", `${code}_A${actId}_P${phaId}`);
      batch.set(docRef, {
        code, libelle, activite: actId, phase: phaId,
        tarifSecteur1: isNaN(s1) ? 0 : s1, tarifSecteur2: isNaN(s2) ? 0 : s2
      });
    });
    return batch.commit();
  };

  const handleClearDatabase = async () => {
    if (window.confirm("Voulez-vous vraiment vider les actes CCAM ?")) {
      setIsUploading(true);
      const snap = await getDocs(collection(db, "actes_ccam"));
      let i = 0;
      while (i < snap.docs.length) {
        const batch = writeBatch(db);
        const chunk = snap.docs.slice(i, i + 400);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
        i += 400;
        setUploadProgress(Math.round((i / snap.docs.length) * 100));
      }
      alert("Base nettoyée.");
      setIsUploading(false); setUploadProgress(0);
    }
  };

  // --- GESTION FAVORIS ---
  const startCreateFav = () => {
    setIsEditingFav(true); setCurrentFavId(null); setFavNameInput(''); 
    setFavActsInput([]); setFavFeeType('amount'); setFavFeeValue(0); setFavSearchResults([]);
  };

  const startEditFav = (template) => {
    setIsEditingFav(true); setCurrentFavId(template.id);
    setFavNameInput(template.name); setFavActsInput(template.acts);
    setFavFeeType(template.feeType || 'amount'); setFavFeeValue(template.feeValue || 0);
    setFavSearchResults([]);
  };

  const saveFavChanges = async () => {
    const favData = { userId: user.uid, name: favNameInput, acts: favActsInput, feeType: favFeeType, feeValue: parseFloat(favFeeValue) || 0 };
    if (currentFavId) await updateDoc(doc(db, "templates", currentFavId), favData);
    else await addDoc(collection(db, "templates"), favData);
    setIsEditingFav(false); fetchTemplates(user.uid);
  };

  const deleteTemplate = async (id) => { if (window.confirm("Supprimer ?")) { await deleteDoc(doc(db, "templates", id)); fetchTemplates(user.uid); } };

  const loadTemplateIntoSimulator = (t) => {
    if (!t) return;
    setSelectedActs(t.acts);
    if (t.feeValue > 0) { setFeeType(t.feeType || 'amount'); setFeeValue(t.feeValue); }
  };

  // --- ACTIONS AUTH / ADMIN ---
  const exportUsersToCSV = () => {
    const headers = ["Nom;Prenom;Email;RPPS;Telephone;Rue;CP;Ville;Activite;Inscription;Usage"];
    const rows = usersList.map(u => `${u.nom};${u.prenom};${u.email};${u.rpps};${u.telephone || ""};${u.adresse?.rue || ""};${u.adresse?.codePostal || ""};${u.adresse?.ville || ""};${u.specialite};${u.dateCreation?.seconds};${u.usageCount || 0}`);
    const csvContent = "data:text/csv;charset=utf-8," + headers.concat(rows).join("\n");
    const link = document.createElement("a"); link.setAttribute("href", encodeURI(csvContent)); link.setAttribute("download", "Mailing_OptimCCAM.csv");
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleDeleteUserAdmin = async (id) => { if (window.confirm("Supprimer praticien ?")) { await deleteDoc(doc(db, "users", id)); fetchUsersList(); } };

  const handleLogin = async (e) => { 
    e.preventDefault(); 
    try { 
      const res = await signInWithEmailAndPassword(auth, email, password);
      await updateDoc(doc(db, "users", res.user.uid), { lastLogin: new Date() });
    } catch (err) { setError('Identifiants incorrects.'); } 
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!consentChecked) { setError("Veuillez accepter le RGPD."); return; }
    try {
      const res = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", res.user.uid), {
        nom: nom.toUpperCase(), prenom, email, rpps, telephone, specialite,
        adresse: { numero: numeroRue, rue: nomRue, codePostal, ville },
        dateCreation: new Date(), lastLogin: new Date(), usageCount: 0
      });
      setIsRegistering(false);
    } catch (err) { setError("Erreur."); }
  };

  const updateProfile = async (e) => {
    e.preventDefault();
    try {
      await updateDoc(doc(db, "users", user.uid), { nom: nom.toUpperCase(), prenom, telephone, specialite, adresse: { numero: numeroRue, rue: nomRue, codePostal, ville } });
      setSuccessMessage("Profil mis à jour !"); setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err) { setError("Erreur."); }
  };

  const addAct = (act) => {
    if (selectedActs.length >= 3) return;
    setSelectedActs([...selectedActs, { ...act, activeModifiers: { 'J': true } }]);
    setSearchResults([]); setSearchTerm('');
  };

  const saveIntervention = async () => {
    if (!interventionName || selectedActs.length === 0) { alert("Manquant."); return; }
    await addDoc(collection(db, "simulations"), { userId: user.uid, patient: interventionName, acts: selectedActs, feeType, feeValue, date: new Date() });
    await updateDoc(doc(db, "users", user.uid), { usageCount: increment(1) });
    setInterventionName(''); fetchSimulations(user.uid); alert("Enregistré.");
  };

  const saveCurrentAsTemplateFromSim = async () => {
    if (!templateName || selectedActs.length === 0) { alert("Nom favori ?"); return; }
    await addDoc(collection(db, "templates"), { userId: user.uid, name: templateName, acts: selectedActs, feeType: feeType, feeValue: parseFloat(feeValue) || 0 });
    setTemplateName(''); fetchTemplates(user.uid); alert("Favori ajouté.");
  };

  // --- CALCULS ---
  const calculated = [...selectedActs]
    .map((act) => {
      let majo = 1;
      if (act.activeModifiers?.['K']) majo = 1.2; else if (act.activeModifiers?.['J']) majo = 1.115;
      if (act.activeModifiers?.['U']) majo += 0.1;
      return { ...act, baseMajore: act.tarifSecteur2 * majo };
    })
    .sort((a, b) => b.baseMajore - a.baseMajore)
    .map((act, i) => {
      const coeff = i === 0 ? 1 : 0.5;
      return { ...act, coeff, baseRetenue: act.baseMajore * coeff };
    });

  const totalBase = calculated.reduce((s, a) => s + a.baseRetenue, 0);
  const totalDep = feeType === 'amount' ? (parseFloat(feeValue) || 0) : totalBase * ((parseFloat(feeValue) || 0) / 100);

  // --- STYLES REUTILISABLES ---
  const cardStyle = { background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginBottom: '20px' };
  const inputStyle = { padding: '12px', borderRadius: '8px', border: '1px solid #ddd', width: '100%', boxSizing: 'border-box', fontSize: '14px', marginBottom: '10px' };
  const btnStyle = { padding: '12px', background: '#0056b3', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' };
  
  const footerBranding = (
    <div style={{ textAlign: 'center', color: '#95a5a6', fontSize: '0.85em', marginTop: '40px', padding: '20px', borderTop: '1px solid #e1e8ed' }}>
      <img src={LOGO_URL} alt="Logo" style={{ maxWidth: '140px', marginBottom: '10px', opacity: 0.6 }} />
      <p style={{ margin: '5px 0' }}>Powered by <strong>Institut Orthopédique de Paris</strong></p>
      <p style={{ margin: '0', opacity: 0.7 }}>Développeur, Dr Raphael Jameson</p>
    </div>
  );

  if (!user) {
    return (
      <div style={{ padding: '20px', maxWidth: '500px', margin: 'auto', fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ textAlign: 'center', color: '#2c3e50' }}>Optim'CCAM</h2>
        <div style={cardStyle}>
          {error && <div style={{ color: '#e74c3c', marginBottom: '15px' }}>{error}</div>}
          {isRegistering ? (
            <form onSubmit={handleRegister}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input type="text" placeholder="Nom *" value={nom} onChange={e => setNom(e.target.value)} style={inputStyle} required />
                <input type="text" placeholder="Prénom *" value={prenom} onChange={e => setPrenom(e.target.value)} style={inputStyle} required />
              </div>
              <input type="email" placeholder="Email professionnel *" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} required />
              <input type="password" placeholder="Mot de passe *" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} required />
              <input type="text" placeholder="N° RPPS *" value={rpps} onChange={e => setRpps(e.target.value)} style={inputStyle} required />
              <label style={{ display: 'flex', gap: '10px', fontSize: '0.8em', color: '#64748b', marginBottom: '15px' }}>
                <input type="checkbox" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} required /> J'accepte le RGPD.
              </label>
              <button type="submit" style={{ ...btnStyle, width: '100%', background: '#27ae60' }}>S'inscrire</button>
              <p onClick={() => setIsRegistering(false)} style={{ textAlign: 'center', color: '#0056b3', cursor: 'pointer', marginTop: '10px' }}>Retour</p>
            </form>
          ) : (
            <form onSubmit={handleLogin}>
              <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} required />
              <input type="password" placeholder="Mot de passe" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} required />
              <button type="submit" style={{ ...btnStyle, width: '100%' }}>Se connecter</button>
              <p onClick={() => setIsRegistering(true)} style={{ textAlign: 'center', color: '#0056b3', cursor: 'pointer', marginTop: '15px' }}>Créer un compte</p>
            </form>
          )}
        </div>
        {footerBranding}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f7f9', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #e1e8ed', padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 100 }}>
        <h3 style={{ margin: 0, color: '#2c3e50' }}>Optim'CCAM</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setActiveTab('simulator')} style={{ padding: '6px 12px', borderRadius: '6px', border: activeTab === 'simulator' ? '2px solid #0056b3' : '1px solid #ddd', cursor: 'pointer' }}>📱 Optim'</button>
          <button onClick={() => setActiveTab('favorites')} style={{ padding: '6px 12px', borderRadius: '6px', border: activeTab === 'favorites' ? '2px solid #f39c12' : '1px solid #ddd', cursor: 'pointer' }}>⭐ Favoris</button>
          <button onClick={() => setActiveTab('profile')} style={{ padding: '6px 12px', borderRadius: '6px', border: activeTab === 'profile' ? '2px solid #0056b3' : '1px solid #ddd', cursor: 'pointer' }}>👤 Profil</button>
          {auth.currentUser?.email === ADMIN_EMAIL && <button onClick={() => setActiveTab('dashboard')} style={{ padding: '6px 12px', borderRadius: '6px', border: activeTab === 'dashboard' ? '2px solid #8e44ad' : '1px solid #ddd', cursor: 'pointer' }}>Admin</button>}
          <button onClick={() => signOut(auth)} style={{ padding: '6px 12px', borderRadius: '6px', color: '#e74c3c', border: '1px solid #e74c3c', background: '#fff', cursor: 'pointer' }}>Quitter</button>
        </div>
      </div>

      <div style={{ padding: '20px', maxWidth: '1200px', margin: 'auto' }}>
        
        {/* ONGLET PROFIL */}
        {activeTab === 'profile' && (
          <div>
            <div style={cardStyle}>
              <h3>Mon Profil Professionnel</h3>
              <form onSubmit={updateProfile}>
                <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 600 ? '1fr 1fr' : '1fr', gap: '15px' }}>
                  <div><label>Nom</label><input type="text" value={nom} onChange={e => setNom(e.target.value)} style={inputStyle} /></div>
                  <div><label>Prénom</label><input type="text" value={prenom} onChange={e => setPrenom(e.target.value)} style={inputStyle} /></div>
                  <div><label>Email (Lecture seule)</label><input type="text" value={auth.currentUser?.email} style={{ ...inputStyle, background: '#eee' }} disabled /></div>
                  <div><label>RPPS (Lecture seule)</label><input type="text" value={rpps} style={{ ...inputStyle, background: '#eee' }} disabled /></div>
                  <div><label>Téléphone</label><input type="tel" value={telephone} onChange={e => setTelephone(e.target.value)} style={inputStyle} /></div>
                  <div><label>Rôle CCAM </label><span style={{ cursor: 'help', color: '#0056b3' }} onClick={() => alert("Activité 2 (Aide) = 25% de la base.")}>ⓘ</span>
                    <select value={specialite} onChange={e => setSpecialite(e.target.value)} style={inputStyle}>
                      <option value="1">Chirurgien (Activité 1)</option>
                      <option value="2">Aide opératoire (Activité 2)</option>
                      <option value="4">Anesthésiste (Activité 4)</option>
                    </select>
                  </div>
                </div>
                <button type="submit" style={{ ...btnStyle, width: '100%', marginTop: '10px' }}>Enregistrer les modifications</button>
              </form>
            </div>
          </div>
        )}

        {/* ONGLET FAVORIS */}
        {activeTab === 'favorites' && (
          <div>
            {!isEditingFav ? (
              <div style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
                  <h3>Mes Modèles Favoris</h3>
                  <button onClick={startCreateFav} style={{ ...btnStyle, background: '#27ae60' }}>➕ Nouveau</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '15px' }}>
                  {templates.map(t => (
                    <div key={t.id} style={{ padding: '15px', border: '1px solid #eee', borderRadius: '10px', background: '#f8fafc' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong style={{ color: '#2c3e50' }}>{t.name}</strong>
                        <div>
                          <button onClick={() => startEditFav(t)} style={{ background: 'none', border: 'none', color: '#0056b3', cursor: 'pointer' }}>📝</button>
                          <button onClick={() => deleteTemplate(t.id)} style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer' }}>🗑️</button>
                        </div>
                      </div>
                      <div style={{ fontSize: '0.85em', color: '#64748b' }}>{t.acts.map((a, i) => <div key={i}>• {a.code} : {a.libelle}</div>)}</div>
                      {t.feeValue > 0 && <div style={{ background: '#e0f2fe', padding: '5px', borderRadius: '5px', marginTop: '10px', fontSize: '0.8em', color: '#0369a1', fontWeight: 'bold' }}>Honoraires : {t.feeValue}{t.feeType === 'amount' ? '€' : '%'}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={cardStyle}>
                <h3>{currentFavId ? "Modifier" : "Créer"} favori</h3>
                <input type="text" placeholder="Nom..." value={favNameInput} onChange={e => setFavNameInput(e.target.value)} style={inputStyle} />
                <div style={{ background: '#f1f5f9', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
                  <h4 style={{ marginTop: 0 }}>💰 Honoraires (Optionnel)</h4>
                  <div style={{ display: 'flex', gap: '5px', marginBottom: '10px' }}>
                    <button onClick={() => setFavFeeType('amount')} style={{ flex: 1, padding: '8px', background: favFeeType==='amount'?'#0056b3':'#94a3b8', color: '#fff', border: 'none', borderRadius: '5px' }}>Fixe (€)</button>
                    <button onClick={() => setFavFeeType('percentage')} style={{ flex: 1, padding: '8px', background: favFeeType==='percentage'?'#0056b3':'#94a3b8', color: '#fff', border: 'none', borderRadius: '5px' }}>% Base</button>
                  </div>
                  <input type="number" placeholder="Valeur" value={favFeeValue} onChange={e => setFavFeeValue(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }} />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input type="text" placeholder="Code ou Mot-clé..." value={favSearchTerm} onChange={e => setFavSearchTerm(e.target.value)} style={inputStyle} />
                  <button onClick={handleFavSearch} style={{ ...btnStyle, height: '45px' }}>OK</button>
                </div>
                {favSearchResults.map(act => (
                  <div key={act.id} onClick={() => addActToFav(act)} style={{ padding: '8px', background: '#fff', border: '1px solid #ddd', borderRadius: '5px', cursor: 'pointer', marginBottom: '5px' }}><strong>{act.code}</strong> - {act.libelle}</div>
                ))}
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={saveFavChanges} style={{ ...btnStyle, flex: 1, background: '#27ae60' }}>💾 Enregistrer</button>
                  <button onClick={() => setIsEditingFav(false)} style={{ ...btnStyle, flex: 1, background: '#94a3b8' }}>Annuler</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ONGLET SIMULATEUR */}
        {activeTab === 'simulator' && (
          <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 800 ? '1fr 320px' : '1fr', gap: '20px' }}>
            <div>
              <div style={cardStyle}>
                <h4>🔍 Chercher un acte (Code ou Mot-clé)</h4>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input type="text" placeholder="Ex: LHEA002 ou Hernie..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={inputStyle} />
                  <button onClick={handleSearch} style={{ ...btnStyle, padding: '0 20px', height: '45px' }}>OK</button>
                </div>
                {searchResults.map(act => (
                  <div key={act.id} style={{ padding: '12px', background: '#f8fafc', marginTop: '8px', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: 1 }}><strong>{act.code}</strong> - {act.tarifSecteur2}€ <br/><small>{act.libelle}</small></div>
                    <button onClick={() => addAct(act)} style={{ width: '35px', height: '35px', borderRadius: '50%', background: '#27ae60', color: 'white', border: 'none', fontSize: '20px' }}>+</button>
                  </div>
                ))}
              </div>
              {selectedActs.length > 0 && (
                <div style={cardStyle}>
                  <input type="text" placeholder="Nom intervention..." value={interventionName} onChange={e => setInterventionName(e.target.value)} style={{ ...inputStyle, fontWeight: 'bold' }} />
                  {calculated.map((act, idx) => (
                    <div key={idx} style={{ padding: '15px', background: '#f1f5f9', borderRadius: '10px', marginBottom: '10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{act.code}</strong><button onClick={() => setSelectedActs(selectedActs.filter((_,i)=>i!==idx))} style={{ border: 'none', background: 'none', color: '#e74c3c' }}>✕</button></div>
                      <div style={{ fontSize: '0.85em', margin: '5px 0' }}>{act.libelle}</div>
                      <div style={{ textAlign: 'right', marginTop: '8px' }}><strong>Retenu : {act.baseRetenue.toFixed(2)}€</strong></div>
                    </div>
                  ))}
                  <button onClick={saveIntervention} style={{ ...btnStyle, width: '100%', marginBottom: '15px', background: '#059669' }}>💾 Sauvegarder</button>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input type="text" placeholder="Favori..." value={templateName} onChange={e => setTemplateName(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }} />
                    <button onClick={saveCurrentAsTemplateFromSim} style={{ ...btnStyle, background: '#f39c12' }}>Favori</button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <div style={cardStyle}>
                <h4>⚡ Favoris Rapides</h4>
                <select onChange={e => loadTemplateIntoSimulator(templates.find(x => x.id === e.target.value))} style={inputStyle}>
                  <option value="">Charger un favori...</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {simulations.length > 0 && (
                <div style={cardStyle}>
                  <h4>🕰️ Historique</h4>
                  {simulations.map(s => (
                    <div key={s.id} onClick={() => { setSelectedActs(s.acts); setInterventionName(s.patient); setFeeValue(s.feeValue); setFeeType(s.feeType); }} style={{ padding: '8px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', fontSize: '0.9em' }}>
                      <strong>{s.patient}</strong><br/><small>{new Date(s.date.seconds * 1000).toLocaleDateString()}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ONGLET ADMIN */}
        {activeTab === 'dashboard' && auth.currentUser?.email === ADMIN_EMAIL && (
          <div style={cardStyle}>
            <h3>⚙️ Gestion Master</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead><tr style={{ textAlign: 'left', background: '#f8fafc' }}><th style={{ padding: '10px' }}>Identité</th><th style={{ padding: '10px' }}>Connexion</th><th style={{ padding: '10px' }}>Usage</th><th style={{ padding: '10px' }}>Actions</th></tr></thead>
                <tbody>
                  {usersList.map(u => (
                    <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '10px' }}><strong>{u.nom} {u.prenom}</strong></td>
                      <td style={{ padding: '10px' }}><small>{u.lastLogin?.seconds ? new Date(u.lastLogin.seconds * 1000).toLocaleString() : '-'}</small></td>
                      <td style={{ padding: '10px' }}>{u.usageCount || 0}</td>
                      <td style={{ padding: '10px' }}><button onClick={() => handleDeleteUserAdmin(u.id)} style={{ background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 8px' }}>🗑️</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: '20px', padding: '15px', background: '#fff3cd', borderRadius: '8px' }}>
              <h4 style={{ marginTop: 0 }}>⚙️ Maintenance CCAM</h4>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                <input type="file" accept=".csv" onChange={handleFileUpload} style={{ flex: 1 }} />
                <button onClick={handleClearDatabase} style={{ background: '#e74c3c', color: '#fff', border: 'none', padding: '10px', borderRadius: '5px', cursor: 'pointer' }}>🗑️ Nettoyer Base</button>
              </div>
              {isUploading && (
                <div style={{ marginTop: '10px' }}>
                  <div style={{ background: '#eee', height: '10px', borderRadius: '5px', overflow: 'hidden' }}><div style={{ width: `${uploadProgress}%`, background: '#27ae60', height: '100%', transition: 'width 0.5s' }}></div></div>
                  <p style={{ fontSize: '0.8em', textAlign: 'center' }}>Progression : {uploadProgress}% (Lecture séquentielle active)</p>
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