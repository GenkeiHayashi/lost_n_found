// test-init.js

import * as dotenv from 'dotenv';
import path from 'path';
import admin from 'firebase-admin';

// Load environment variables IMMEDIATELY
dotenv.config();

// --- 1. CONFIGURATION ---
const serviceAccountPath = process.env.FIREBASE_PRIVATE_KEY_PATH;
const projectId = process.env.FIREBASE_PROJECT_ID;

if (!serviceAccountPath || !projectId) {
    console.error("❌ ERROR: Missing FIREBASE_PRIVATE_KEY_PATH or FIREBASE_PROJECT_ID in .env file.");
    process.exit(1);
}

try {
    const absolutePath = path.resolve(serviceAccountPath); 

    // --- 2. INITIALIZATION ---
    admin.initializeApp({
      credential: admin.credential.cert(absolutePath), 
      databaseURL: `https://${projectId}.firebaseio.com`
    });

    const db = admin.firestore();

    // --- 3. VERIFICATION TEST ---
    async function runTest() {
        // We'll try to read a non-existent document just to confirm communication
        const docRef = db.collection('test_collection').doc('test_doc');
        const doc = await docRef.get(); 

        if (doc.exists) {
            console.log("✅ SUCCESS: Firebase Admin SDK initialized and connected to Firestore!");
        } else {
            console.log("✅ SUCCESS: Firebase Admin SDK initialized and connected to Firestore!");
            console.log("   (Test document does not exist, but connection was successful.)");
        }
        process.exit(0);

    }

    runTest();

} catch (error) {
    console.error("❌ FAILURE: Firebase Initialization Failed!");
    console.error("   Reason:", error.message);
    process.exit(1);
}