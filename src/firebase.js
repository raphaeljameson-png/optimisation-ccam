import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBpdaYX5WpmtwnVgX3sm-Obl5GpYFBMmpA",
  authDomain: "opticcam.firebaseapp.com",
  projectId: "opticcam",
  storageBucket: "opticcam.firebasestorage.app",
  messagingSenderId: "173868651383",
  appId: "1:173868651383:web:aa05c1413daf48f1570772"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };