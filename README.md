# Optim'CCAM

Outil d'optimisation du dépassement d'honoraires sur les codes CCAM de la Sécurité Sociale.

Développé par le **Dr Raphaël Jameson** — Institut Orthopédique de Paris.

---

## Fonctionnalités

- **Simulateur CCAM** — Recherche par code ou mot-clé, calcul automatique des bases majorées (Modif J, K, U), règle des 50% sur les actes associés
- **Répartition DPI** — Ventilation automatique du dépassement d'honoraires proportionnellement aux bases CCAM de chaque acte
- **Favoris** — Sauvegarde de modèles d'interventions avec les honoraires associés, catégorisation, import/export JSON
- **Partage QR** — Partage d'un modèle entre confrères via QR Code
- **Historique** — Registre des 10 dernières simulations
- **Multi-rôles** — Chirurgien (Activité 1), Aide opératoire (Activité 2), Anesthésiste (Activité 4)
- **Secteur & OPTAM** — Calcul adapté au secteur conventionnel (1 ou 2) et à l'adhésion OPTAM

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Frontend | React 19 + Vite |
| Base de données | Firebase Firestore (temps réel) |
| Authentification | Firebase Auth (email/password + Google) |
| Hébergement | Firebase Hosting |
| Backend | Firebase Cloud Functions (Node 24) |
| Recherche | Index `motsCles` avec préfixes (généré à l'import CSV) |

---

## Installation locale

```bash
git clone <url-du-repo>
cd optimisation-ccam-main
npm install
npm run dev
```

L'app tourne sur `http://localhost:5173`.

---

## Déploiement Firebase

```bash
# Build de production
npm run build

# Déploiement complet (hosting + règles Firestore + functions)
npx firebase deploy

# Ou séparément :
npx firebase deploy --only hosting
npx firebase deploy --only firestore:rules
npx firebase deploy --only functions
```

---

## Import de la base CCAM

1. Connectez-vous avec le compte administrateur
2. Onglet **Admin** → section **Maintenance CCAM**
3. Cliquez sur **Nettoyer** si une ancienne base est présente
4. Sélectionnez le fichier CSV CCAM et attendez 100%

Le moteur de recherche utilise un index `motsCles` généré à l'import. **Ré-importer le CSV après chaque mise à jour du code qui modifie la logique d'indexation.**

---

## Structure du projet

```
optimisation-ccam-main/
├── src/
│   ├── App.jsx          # Composant principal (simulateur, favoris, admin)
│   ├── App.css          # Design system "Precision Médicale"
│   ├── firebase.js      # Initialisation Firebase
│   └── main.jsx         # Point d'entrée React
├── functions/
│   └── index.js         # Cloud Function : purge des comptes supprimés
├── firebase.json        # Config Hosting + Firestore + Functions
├── firestore.rules      # Règles de sécurité Firestore
└── index.html           # Point d'entrée HTML
```

---

## Collections Firestore

| Collection | Description | Accès |
|---|---|---|
| `users` | Profils médecins | Propriétaire + Admin |
| `templates` | Favoris (modèles d'interventions) | Propriétaire uniquement |
| `simulations` | Historique des simulations | Propriétaire uniquement |
| `actes_ccam` | Base de données CCAM | Lecture : tous authentifiés / Écriture : Admin |
