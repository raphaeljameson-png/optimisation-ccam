// functions/index.js — Optim'CCAM Cloud Functions
// Déploiement : npx firebase deploy --only functions

const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

// ─── purgeCompteUtilisateur ───────────────────────────────────────────────────
// Déclencheur : suppression d'un document dans la collection "users/{userId}"
//
// Cette fonction fait 3 choses dans l'ordre :
//   1. Supprime le compte Firebase Authentication de l'utilisateur
//   2. Supprime tous ses favoris (collection "templates")
//   3. Supprime tout son historique (collection "simulations")
//
// Elle est appelée dans deux situations :
//   - Un médecin supprime son propre compte (depuis l'onglet Profil)
//   - L'admin supprime un praticien (depuis l'onglet Admin)
//
// Sans cette fonction, les templates et simulations resteraient en Firestore
// et continueraient d'être facturés sur le plan Blaze.

exports.purgeCompteUtilisateur = onDocumentDeleted("users/{userId}", async (event) => {

    const userId = event.params.userId;
    const db     = admin.firestore();

    console.log(`Début purge du compte : ${userId}`);

    // ── 1. Suppression du compte Firebase Authentication ──────────────────────
    try {
        await admin.auth().deleteUser(userId);
        console.log(`Auth supprimé : ${userId}`);
    } catch (error) {
        // L'utilisateur peut avoir déjà supprimé son Auth (cas auto-suppression)
        // On log l'erreur mais on continue le nettoyage Firestore
        console.warn(`Auth déjà supprimé ou introuvable (${userId}) :`, error.code);
    }

    // ── 2. Suppression de tous les favoris de cet utilisateur ─────────────────
    try {
        const templatesSnap = await db
            .collection("templates")
            .where("userId", "==", userId)
            .get();

        if (!templatesSnap.empty) {
            // On supprime par batch de 400 max (limite Firestore)
            const chunks = [];
            for (let i = 0; i < templatesSnap.docs.length; i += 400) {
                chunks.push(templatesSnap.docs.slice(i, i + 400));
            }
            for (const chunk of chunks) {
                const batch = db.batch();
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
            console.log(`${templatesSnap.size} favoris supprimés pour : ${userId}`);
        } else {
            console.log(`Aucun favori à supprimer pour : ${userId}`);
        }
    } catch (error) {
        console.error(`Erreur suppression favoris (${userId}) :`, error);
    }

    // ── 3. Suppression de tout l'historique de cet utilisateur ───────────────
    try {
        const simulationsSnap = await db
            .collection("simulations")
            .where("userId", "==", userId)
            .get();

        if (!simulationsSnap.empty) {
            const chunks = [];
            for (let i = 0; i < simulationsSnap.docs.length; i += 400) {
                chunks.push(simulationsSnap.docs.slice(i, i + 400));
            }
            for (const chunk of chunks) {
                const batch = db.batch();
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
            console.log(`${simulationsSnap.size} simulations supprimées pour : ${userId}`);
        } else {
            console.log(`Aucune simulation à supprimer pour : ${userId}`);
        }
    } catch (error) {
        console.error(`Erreur suppression simulations (${userId}) :`, error);
    }

    console.log(`Purge complète terminée pour : ${userId}`);
});
