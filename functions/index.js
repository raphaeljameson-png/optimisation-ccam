const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

// NOUVEAU NOM : purgeCompteUtilisateur (pour contourner le bug de Google)
exports.purgeCompteUtilisateur = onDocumentDeleted("users/{userId}", async (event) => {
    
    const userId = event.params.userId;

    try {
        await admin.auth().deleteUser(userId);
        console.log(`Succès : Utilisateur ${userId} supprimé de la base d'authentification.`);
    } catch (error) {
        console.error(`Erreur lors de la suppression de ${userId}:`, error);
    }
});