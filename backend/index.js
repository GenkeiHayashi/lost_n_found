import express from "express";
import cors from "cors";
import * as dotenv from 'dotenv';
import admin from 'firebase-admin'; // Firebase Admin SDK
import path from 'path'; // Node.js native module for path resolution
import { fileURLToPath } from 'url'; // For path resolution in ES Modules
import { Storage } from '@google-cloud/storage'; // Google Cloud Storage SDK
import multer from 'multer'; // Middleware for handling file uploads
import { GoogleAuth } from 'google-auth-library'; // Google Auth Library
import axios from 'axios'; //HTTP Client

// Load environment variables immediately
dotenv.config();

// --- FIREBASE INITIALIZATION ---

// Helper function to get the current file directory in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get paths and project ID from environment variables
const serviceAccountPath = process.env.FIREBASE_PRIVATE_KEY_PATH;
const projectId = process.env.FIREBASE_PROJECT_ID;

if (!serviceAccountPath || !projectId) {
    console.error("❌ FATAL: Missing Firebase environment variables. Check .env file.");
    process.exit(1);
}

// Resolve the absolute path to the JSON key file
const absolutePath = path.resolve(__dirname, serviceAccountPath); 
console.log(`DEBUG PATH: Resolved Service Account Key Path: ${absolutePath}`);
try {
    // Initialize Firebase Admin SDK
    admin.initializeApp({
        credential: admin.credential.cert(absolutePath), 
        databaseURL: `https://${projectId}.firebaseio.com` 
    });

    console.log("✅ SUCCESS: Firebase Admin SDK initialized and connected.");
} catch (error) {
    console.error("❌ FATAL: Firebase Initialization Failed!", error.message);
    process.exit(1);
}

// Exported services (Firestore and Auth)
export const db = admin.firestore();
export const auth = admin.auth();


// --- GOOGLE CLOUD STORAGE SETUP ---
// Initialize Google Cloud Storage using the same credentials from Firebase Admin SDK
const storage = new Storage({
    projectId: projectId,
    keyFilename: absolutePath, // Re-use the service account key path
});

// Define the bucket name (usually projectId.appspot.com)
const bucketName = `${projectId}.firebasestorage.app`;
const bucket = storage.bucket(bucketName);


// --- MULTER SETUP (Handles file upload from frontend) ---
// We use memory storage so the file is stored temporarily in RAM before being uploaded to GCS.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // Limit files to 5MB (Good practice for performance/cost)
    },
});


// --- EXPRESS SERVER SETUP ---

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json()); // Essential for handling JSON data
app.use(cors());         // Essential for frontend communication


// --- AUTHENTICATION PLACEHOLDER MIDDLEWARE ---

const verifyToken = async (req, res, next) => {
    // 1. Get the token from the Authorization header (e.g., 'Bearer <token>')
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(403).json({ message: 'Authorization required.' });
    }

    const idToken = header.split('Bearer ')[1];

    try {
        // 2. Verify the token using Firebase Admin SDK
        // This confirms the token is valid, hasn't expired, and was issued by Firebase.
        const decodedToken = await auth.verifyIdToken(idToken);
        
        // 3. Attach the user object (UID and Custom Claims like 'role') to the request
        req.user = decodedToken; 
        
        next(); // Proceed to the route handler

    } catch (error) {
        console.error("Token Verification Error:", error.message);
        return res.status(401).json({ message: 'Invalid or expired authentication token.' });
    }
};

const authClient = new GoogleAuth({ 
    keyFile: absolutePath, // <--- 1. Tells it WHICH file to use
    scopes: ['https://www.googleapis.com/auth/cloud-platform'], // <--- 2. Tells it WHAT permissions to ask for
});

// --- STORAGE UTILITY FUNCTION ---

/**
 * Uploads a file buffer to GCS, makes it public, and returns the permanent public URL.
 * @param {object} file - The file object provided by Multer.
 * @returns {string} The Signed URL of the uploaded file.
 */
const uploadFileToStorage = async (file) => {
    if (!file) return null;

    const timestamp = Date.now();
    // Re-use the existing file naming logic
    const fileName = `items/${timestamp}_${file.originalname.replace(/ /g, '_')}`;
    const fileUpload = bucket.file(fileName);

    const stream = fileUpload.createWriteStream({
        metadata: {
            contentType: file.mimetype,
        },
    });

    return new Promise((resolve, reject) => {
        stream.on('error', (err) => {
            console.error('Storage Upload Error:', err);
            reject(new Error('Failed to upload file to storage.'));
        });

        stream.on('finish', async () => {
            // ACTION: Make the file public for permanent display
            await fileUpload.makePublic(); 
            
            // Return the permanent public URL
            const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
            
            resolve(publicUrl); // Returns a simple URL string
        });
        
        stream.end(file.buffer); 
    });
};

// --- AI UTILITY FUNCTION (GEMINI EMBEDDING) ---
// Vertex AI Setup for Text Embedding (Simple and reliable)
const LOCATION = 'asia-southeast1'; // Using stable region for the model
const EMBEDDING_MODEL_ID = 'text-embedding-004'; // Reliable text-only model
const VERTEX_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL_ID}:predict`;
/**
 * Generates a text vector using the Vertex AI Text Embedding Model (text-embedding-004).
 * @param {string} text - The text description to embed.
 * @returns {number[] | null} A vector (array of numbers).
 */
const generateEmbedding = async (text) => { 
    try {
        const accessToken = await authClient.getAccessToken();

        const payload = {
            instances: [{ content: text }],
        };

        const response = await axios.post(
            VERTEX_ENDPOINT,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const embedding = response.data.predictions[0].embeddings.values;
        console.log(`✅ SUCCESS: Generated text vector of length ${embedding.length} (768D expected).`);
        return embedding;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response ? error.response.status : 'N/A';
            console.error(`Vertex AI Text Embedding Failed (Status ${status}): ${JSON.stringify(error.response.data)}`);
        }
        return null;
    }
};

/**
 * Calculates the Cosine Similarity between two vectors.
 * Score is between 0 (no similarity) and 1 (identical).
 * Formula: Cosine Similarity = (A . B) / (||A|| * ||B||)
 * @param {number[]} vecA - Query vector
 * @param {number[]} vecB - Target vector
 * @returns {number} The similarity score (0 to 1).
 */
const cosineSimilarity = (vecA, vecB) => {
    // Basic validation to ensure both are valid arrays of the same length
    if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
        return 0;
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magnitudeA += vecA[i] * vecA[i];
        magnitudeB += vecB[i] * vecB[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    // Prevent division by zero
    if (magnitudeA === 0 || magnitudeB === 0) {
        return 0;
    }

    // Result is the dot product divided by the product of the magnitudes
    return dotProduct / (magnitudeA * magnitudeB);
};

// --- CORE ITEM LOGIC ---

/**
 * Handles item creation, file upload, text embedding, and saving to Firestore.
 */
const createItemPost = async (req, res, frontendData, file) => {
    
    if (!frontendData.name || !frontendData.status || !frontendData.category || !frontendData.lastSeenLocation || !frontendData.description) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required item fields: name, description, status, category or last seen location.' 
        });
    }

    try {
        let finalImageUrl = null; // Stored in DB
        
        // 2. Upload image and get URL (Image for display only)
        if (file) {
            finalImageUrl = await uploadFileToStorage(file);
        }
        
        // *** TEXT EMBEDDING GENERATION (Compulsory Text Input) ***
        let textVector = []; 
        const itemText = frontendData.description || frontendData.name;

        if (itemText) {
            console.log("Generating text vector...");
            // Call the simplified text embedding function
            textVector = await generateEmbedding(itemText); 
            
            if (!textVector || textVector.length === 0) {
                 console.warn("Could not generate vector. Item posted without embedding.");
            }
        }

        // 3. CONSTRUCTING THE FIRESTORE DOCUMENT
        const serverGeneratedFields = {
            posterUid: req.user.uid, 
            isApproved: false, 
            isResolved: false, 
            dateReported: admin.firestore.FieldValue.serverTimestamp(),
            textEmbedding: textVector, // Store the text vector
            imageUrl: finalImageUrl, 
            lastSeenLocation: frontendData.lastSeenLocation,
            itemCollectLocation: frontendData.status === 'found' ? frontendData.itemCollectLocation || 'Pending location details' : null
        };
        
        const itemDocument = {
            ...frontendData, 
            ...serverGeneratedFields
        };
        delete itemDocument.imageTempRef; 
        
        const docRef = await db.collection('items').add(itemDocument);

        return res.status(201).json({
            success: true,
            message: `${frontendData.status} item successfully posted for approval.`,
            itemId: docRef.id 
        });
        
    } catch (error) {
        console.error('SERVER ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Internal Server Error during data processing.' });
    }
}

// --- API ROUTES ---

// Health Check / Default Route
app.get("/", (req, res) => {
    res.send("Hello from the Lost & Found Backend!");
});


// 1. CREATE ITEM POST ROUTE (POST /api/items)
// 'upload.single('itemImage')' is the Multer middleware that handles the file named 'itemImage'
app.post('/api/items', verifyToken, upload.single('itemImage'), async (req, res) => {
    // req.body contains the JSON data, req.file contains the image file
    await createItemPost(req, res, req.body, req.file);
});


// 2. READ & FILTER ITEMS ROUTE (GET /api/items)
app.get('/api/items', verifyToken, async (req, res) => {
    
    // Extract query parameters from req.query
    const { category, status, lastSeenLocation, sortBy, sortOrder } = req.query; 

    try {
        let itemsRef = db.collection('items');
        
        // 1. BASE QUERY: Filter for approved and unresolved items (Default public view)
        let query = itemsRef
            .where('isApproved', '==', true)
            .where('isResolved', '==', false);

        // 2. DYNAMIC FILTERING (Exact Match)
        if (category) {
            // Filter by item type/category
            query = query.where('category', '==', category);
        }
        
        if (status && (status === 'lost' || status === 'found')) {
            // Filter by item status
            query = query.where('status', '==', status);
        }
        
        if (lastSeenLocation) {
             // Filter by location
             // NOTE: This performs an exact match on the 'lastSeenLocation' field
             query = query.where('lastSeenLocation', '==', lastSeenLocation);
        }
        
        // 3. SORTING (Includes date filtering)
        // Default sort field is 'dateReported' (Newest first)
        const sortField = sortBy || 'dateReported';
        // Order must be 'asc' or 'desc'. Default descending.
        const order = sortOrder === 'asc' ? 'asc' : 'desc'; 
        
        // IMPORTANT: Firestore requires an orderBy() on any field used in a range or inequality filter.
        // For basic exact matching (==), you can sort on any field.
        query = query.orderBy(sortField, order);


        // 4. Execute the Query
        const snapshot = await query.get();

        const items = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.status(200).json(items);
    } catch (error) {
        console.error('Firestore Error during GET /api/items:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve items.' });
    }
});


// 3. USER & ADMIN MANAGEMENT ENDPOINTS

// Route 3a: Register New User
app.post('/api/auth/register', async (req, res) => {
    // In a real app, you would validate email/password here.
    const { email, password, displayName } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required." });
    }

    try {
        // 1. Create user in Firebase Auth
        const userRecord = await auth.createUser({ email, password, displayName });

        // 2. Create corresponding document in Firestore 'users' collection (for isAdmin flag)
        await db.collection('users').doc(userRecord.uid).set({
            email: userRecord.email,
            displayName: displayName || 'User',
            isAdmin: false, // Default is false
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(201).json({ 
            success: true, 
            message: "User created successfully. Please log in.", 
            uid: userRecord.uid 
        });

    } catch (error) {
        console.error("Registration Error:", error.message);
        // Handle common Firebase Auth errors (e.g., email-already-in-use)
        res.status(400).json({ message: error.message });
    }
});


// Route 3b: Set Admin Role (Admin Utility - needs protection later)
app.post('/api/admin/set-role', verifyToken, async (req, res) => {
    const { targetUid, role } = req.body; // targetUid: UID to promote, role: 'admin' or 'user'

    if (!targetUid) {
        return res.status(400).json({ message: "Target UID is required." });
    }
    
    const isAdmin = role === 'admin';

    try {
        // 1. Update Custom Claims in Firebase Auth (best for runtime checks)
        await auth.setCustomUserClaims(targetUid, { admin: isAdmin });

        // 2. Update Firestore document (good for lookup/display)
        await db.collection('users').doc(targetUid).update({ isAdmin: isAdmin });

        res.status(200).json({ 
            success: true, 
            message: `User ${targetUid} role set to ${role}.` 
        });

    } catch (error) {
        console.error("Admin Role Error:", error.message);
        res.status(500).json({ message: "Failed to set user role." });
    }
});

// Route 3c: Login User (Issues a session token with role claims)
app.get('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required." });
    }

    try {
        // 🛑 STEP 1: Authenticate user using Firebase Client SDK equivalent
        // Since Firebase Admin SDK cannot sign in users, we use a utility API.
        // NOTE: This uses the Identity Toolkit REST API, which requires the project's Web API Key.
        const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY; 
        const SIGN_IN_ENDPOINT = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
        
        // Make the external API call to verify the user's password
        const signInResponse = await axios.post(SIGN_IN_ENDPOINT, {
            email: email,
            password: password,
            returnSecureToken: true
        });

        const idToken = signInResponse.data.idToken;
        const localId = signInResponse.data.localId;
        
        // 🛑 STEP 2: Get the user's role from Firestore
        const userDoc = await db.collection('users').doc(localId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: "User profile not found in database." });
        }
        const userData = userDoc.data();
        const role = userData.isAdmin ? 'admin' : 'user';

        // 🛑 STEP 3: Optionally update Firebase Custom Claims (for future security checks)
        await auth.setCustomUserClaims(localId, { role: role });

        // 🛑 STEP 4: Respond with the necessary data for the frontend
        res.status(200).json({ 
            success: true, 
            message: "Login successful.", 
            token: idToken, // The Firebase ID Token (JWT)
            user: {
                uid: localId,
                email: email,
                displayName: userData.displayName,
                role: role // Crucial for frontend routing
            }
        });

    } catch (error) {
        let message = "Login failed. Invalid email or password.";
        if (axios.isAxiosError(error) && error.response?.data?.error?.message) {
             // Extract specific errors from the Identity Toolkit API
             message = error.response.data.error.message.replace(/EMAIL_NOT_FOUND|INVALID_PASSWORD/g, 'Invalid email or password.');
        } else {
             console.error("Login Error:", error.message);
        }
        res.status(401).json({ message: message });
    }
});

// 4. MATCHING ROUTE (GET /api/items/:itemId/matches)
app.get('/api/items/:itemId/matches', verifyToken, async (req, res) => {
    const { itemId } = req.params;
    const SIMILARITY_THRESHOLD = 0.8; // ADJUST: Confidence level (0.0 to 1.0)
    const MAX_MATCHES = 5;

    try {
        // 1. Get the Query Item and its embedding (The item the user is looking at)
        const queryDoc = await db.collection('items').doc(itemId).get();
        if (!queryDoc.exists) {
            return res.status(404).json({ success: false, message: 'Item not found.' });
        }
        const queryItem = queryDoc.data();
        const queryVector = queryItem.textEmbedding;

        // Ensure the query item has a valid vector
        if (!queryVector || queryVector.length === 0) {
            return res.status(200).json({ 
                success: true, 
                message: "No embedding found for this item. Cannot run matching.", 
                matches: [] 
            });
        }
        
        // Determine the opposite status to match against (Lost matches Found, and vice-versa)
        const targetStatus = queryItem.status === 'lost' ? 'found' : 'lost';

        // 2. Fetch all eligible target items (opposite status, approved, unresolved)
        const targetSnapshot = await db.collection('items')
            .where('status', '==', targetStatus)
            .where('isApproved', '==', true)
            .where('isResolved', '==', false)
            .get();
        
        // 3. Calculate Similarity for each target item
        const matches = [];

        targetSnapshot.docs.forEach(targetDoc => {
            const targetItem = targetDoc.data();
            const targetVector = targetItem.textEmbedding;

            // Skip if target doesn't have a vector
            if (!targetVector || targetVector.length === 0 || targetDoc.id === itemId) {
                return; 
            }
            
            // Calculate similarity score using the utility function
            const score = cosineSimilarity(queryVector, targetVector);

            //TO EMIT DURING FINAL PRODUCTION****************
            console.log(`DEBUG SCORE: Item ID ${targetDoc.id} vs Query ID ${itemId} Score: ${score}`);

            if (score >= SIMILARITY_THRESHOLD) {
                matches.push({
                    id: targetDoc.id,
                    score: parseFloat(score.toFixed(4)), // Keep 4 decimal places
                    ...targetItem
                });
            }
        });
        
        // 4. Sort by score (highest similarity first) and limit results
        matches.sort((a, b) => b.score - a.score);
        const topMatches = matches.slice(0, MAX_MATCHES);

        // 5. Send the final JSON response
        res.status(200).json({ 
            success: true,
            queryId: itemId,
            targetStatus: targetStatus,
            matches: topMatches 
        });

    } catch (error) {
        console.error('Matching Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to find matches.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Backend is serving on port ${PORT}`);
});