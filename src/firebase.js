// On importe les outils de Firebase
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// VOS CLÉS SECRÈTES (À remplacer par ce que vous avez copié)
const firebaseConfig = {
  apiKey: "AIzaSyBpdaYX5WpmtwnVgX3sm-Obl5GpYFBMmpA",
  authDomain: "opticcam.firebaseapp.com",
  projectId: "opticcam",
  storageBucket: "opticcam.firebasestorage.app",
  messagingSenderId: "173868651383",
  appId: "1:173868651383:web:aa05c1413daf48f1570772"
};

// On allume la connexion
const app = initializeApp(firebaseConfig);

// On exporte l'authentification et la base de données pour pouvoir les utiliser ailleurs
export const auth = getAuth(app);
export const db = getFirestore(app);