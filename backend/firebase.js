import * as dotenv from 'dotenv';
import path from 'path'; // Needed to safely resolve the file path

// Load environment variables immediately
dotenv.config();

// 1. Resolve the path to the Service Account Key file from the .env variable
const serviceAccountPath = process.env.FIREBASE_PRIVATE_KEY_PATH;

// 2. We use 'path.resolve' to ensure the file path is correct, regardless of where the script is run from
const absolutePath = path.resolve(serviceAccountPath); 

// 3. Initialize Firebase Admin SDK
admin.initializeApp({
  // Use admin.credential.cert() to securely load the credentials from the resolved path
  credential: admin.credential.cert(absolutePath), 
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com` // Optional but good practice
});

// 4. Get and export the required services
export const db = admin.firestore();
export const auth = admin.auth(); // Crucial for user registration, login verification, and Admin roles