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

const verifyTokenPlaceholder = (req, res, next) => {
    // Replace 'PASTE_YOUR_SAVED_UID_HERE' with the UID you got from Step 1.
    req.user = { uid: 'zoWc2u0MWphZdmf38nSfWTkqa8v1' }; 
    next();
};

const authClient = new GoogleAuth({ 
    keyFile: absolutePath, // <--- 1. Tells it WHICH file to use
    scopes: ['https://www.googleapis.com/auth/cloud-platform'], // <--- 2. Tells it WHAT permissions to ask for
});

// --- STORAGE UTILITY FUNCTION ---

/**
 * Uploads a file buffer (from Multer) to Firebase Storage and returns a Signed URL.
 * The Signed URL grants time-limited read access to the AI model.
 * @param {object} file - The file object provided by Multer.
 * @returns {string} The Signed URL of the uploaded file.
 */
const uploadFileToStorage = async (file) => {
    if (!file) return null;

    const timestamp = Date.now();
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
            // Generate a Signed URL valid for 30 minutes (1800 seconds)
            const [signedUrl] = await fileUpload.getSignedUrl({
                action: 'read',
                expires: Date.now() + 1800 * 1000, // Expires in 30 minutes
            });
            
            // NEW: GCS URI format for AI services (gs://bucket-name/file/path)
            const gcsUri = `gs://${bucketName}/${fileName}`; 
            
            // Return BOTH the Signed URL (for DB/Front-end) and the GCS URI (for AI)
            resolve({ signedUrl, gcsUri }); // <--- NOW RETURNS AN OBJECT
        });
        
        stream.end(file.buffer); 
    });
};

// --- AI UTILITY FUNCTION (GEMINI EMBEDDING) ---
// NOTE: For pure text embedding, 'text-embedding-004' is often used, but we use a multimodal model to handle the image part.
// Vertex AI Setup for Text Embedding (Requires Service Account Auth)
const LOCATION = 'us-central1'; // Use a consistent region
// Model for reliable text embedding
const EMBEDDING_MODEL_ID = 'text-embedding-004'; 
const VERTEX_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL_ID}:predict`;

const VERTEX_MULTIMODAL_MODEL_ID = 'multimodalembedding@001'; // Model for image/text fusion
const VERTEX_MULTIMODAL_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${VERTEX_MULTIMODAL_MODEL_ID}:predict`;
/**
 * Generates a fused embedding vector using the Vertex AI API.
 * Uses Multimodal endpoint if image is present, Text-only endpoint otherwise.
 * @param {object} input - Object containing { text: string, imageUri?: string }
 * @returns {number[] | null} A vector (array of numbers).
 */
const generateEmbedding = async (input) => {
    try {
        const accessToken = await authClient.getAccessToken();

        // 1. Determine Endpoint and Payload Structure
        let endpoint = VERTEX_ENDPOINT; // Default: Text-only (for lost items without photo)
        let payload = {};

        if (input.imageUri) {
            // FUSION/IMAGE: Use the Multimodal endpoint and payload structure
            endpoint = VERTEX_MULTIMODAL_ENDPOINT;
            payload = {
                instances: [{
                    // Image input
                    image: { gcsUri: input.imageUri }, 
                    // Text input (fused with the image)
                    text: input.text 
                }]
            };
        } else {
            // TEXT-ONLY: Use the Text Embedding endpoint
            payload = {
                instances: [{ content: input.text }],
            };
        }

        // 2. Make the Authenticated Request via Axios
        const response = await axios.post(
            endpoint,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        // DEBUG: log the exact response shape when troubleshooting
        console.debug("Vertex response data:", JSON.stringify(response.data, null, 2));

        // --- ROBUST EMBEDDING EXTRACTION ---
        // Walk the response to find the first array of numbers (embedding vector).
        const findNumericArray = (root, maxDepth = 6) => {
            const seen = new Set();
            const queue = [{ node: root, depth: 0 }];
            while (queue.length) {
                const { node, depth } = queue.shift();
                if (!node || depth > maxDepth) continue;
                if (Array.isArray(node) && node.length > 0 && typeof node[0] === 'number') {
                    return node;
                }
                if (Array.isArray(node)) {
                    // push array elements for inspection
                    for (const el of node) queue.push({ node: el, depth: depth + 1 });
                } else if (typeof node === 'object') {
                    for (const key of Object.keys(node)) {
                        const child = node[key];
                        if (child && typeof child === 'object' && !seen.has(child)) {
                            seen.add(child);
                            queue.push({ node: child, depth: depth + 1 });
                        }
                    }
                }
            }
            return null;
        };

        // Try known prediction array first, then fallback to a generic search
        const preds = response?.data?.predictions;
        let vector = null;
        if (Array.isArray(preds) && preds.length > 0) {
            // try to find numeric array inside the first prediction object
            vector = findNumericArray(preds[0]);
        }
        // fallback: search entire response body
        if (!vector) vector = findNumericArray(response.data);

        if (!vector) {
            console.error("🛑 FAILURE: Could not find embedding vector in Vertex response. Full response:", JSON.stringify(response.data, null, 2));
            return null;
        }

        return vector;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response ? error.response.status : 'N/A';
            console.error(`Vertex AI Embedding Failed (Status ${status}): ${JSON.stringify(error.response.data)}`);
        } else {
             console.error('Error during AI embedding generation:', error.message);
        }
        console.error("ACTION REQUIRED: Ensure both Text and Multimodal APIs are enabled in Vertex AI and permissions are correct.");
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
 * Handles the saving of item data to Firestore. Shared by POST /api/items and POST /api/test-item.
 */
const createItemPost = async (req, res, frontendData, file) => {
    
    // 1. Basic Input Validation
    if (!frontendData.name || !frontendData.status || !frontendData.category) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required item fields: name, status, or category.' 
        });
    }

    try {
        // 2. Upload image and get URL (if file exists)
        let finalImageUrl = null; // Stored in DB
        let gcsUri = null;        // Used for AI

        if (file) {
            // UPLOAD NOW RETURNS THE OBJECT { signedUrl, gcsUri }
            const imageUris = await uploadFileToStorage(file);
            finalImageUrl = imageUris.signedUrl;
            gcsUri = imageUris.gcsUri; 
        }
        
        // *** IMPLEMENT MULTIMODAL FUSION STRATEGY ***
        let imageVector = []; 
        let embeddingInput = {}; // Object to hold { text, imageUri }

        // 1. Always include text description (Compulsory)
        const itemText = frontendData.description || frontendData.name;
        if (itemText) {
            embeddingInput.text = itemText; 
        } else {
            // If the item name is also missing (shouldn't happen due to validation), skip vector creation
            console.warn("Item lacks both description and name. Skipping vector generation.");
        }

        // 2. Add Image URI if available (Optional for Lost, Compulsory for Found)
        if (gcsUri) { 
            embeddingInput.imageUri = gcsUri; 
        }
        
        // 3. Only proceed if we have at least text OR an image
        if (Object.keys(embeddingInput).length > 0) {
            console.log("Generating fused vector from multimodal input...");
            
            // Pass the source and status
            imageVector = await generateEmbedding(embeddingInput); 
            
            if (!imageVector || imageVector.length === 0) {
                 console.warn("Could not generate vector. Item posted without embedding.");
            }
        }

        // 3. CONSTRUCTING THE FIRESTORE DOCUMENT
        const serverGeneratedFields = {
            posterUid: req.user.uid, 
            isApproved: false, 
            isResolved: false, 
            dateReported: admin.firestore.FieldValue.serverTimestamp(),
            textEmbedding: imageVector, // Store the array of numbers
            imageUrl: finalImageUrl, // Use the signed URL for the front-end
            
            whereToCollect: frontendData.status === 'found' ? frontendData.whereToCollect || 'Pending location details' : null
        };
        
        // Combine frontend data with server-controlled fields
        const itemDocument = {
            ...frontendData, 
            ...serverGeneratedFields
        };
        delete itemDocument.imageTempRef; 
        
        // 4. Save the new document to the 'items' collection
        const docRef = await db.collection('items').add(itemDocument);

        // Success Response (201 Created)
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
app.post('/api/items', verifyTokenPlaceholder, upload.single('itemImage'), async (req, res) => {
    // req.body contains the JSON data, req.file contains the image file
    await createItemPost(req, res, req.body, req.file);
});


// 2. READ & FILTER ITEMS ROUTE (GET /api/items)
app.get('/api/items', verifyTokenPlaceholder, async (req, res) => {
    
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
app.post('/api/admin/set-role', verifyTokenPlaceholder, async (req, res) => {
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

// 4. MATCHING ROUTE (GET /api/items/:itemId/matches)
app.get('/api/items/:itemId/matches', verifyTokenPlaceholder, async (req, res) => {
    const { itemId } = req.params;
    const SIMILARITY_THRESHOLD = 0.0001; // ADJUST: Confidence level (0.0 to 1.0)
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

            // --- NEW DEBUG LOG ---
            console.log(`DEBUG SCORE: Item ID ${targetDoc.id} vs Query ID ${itemId} Score: ${score}`);
            // --- END DEBUG LOG ---

            if (score >= SIMILARITY_THRESHOLD) {
                matches.push({
                    id: targetDoc.id,
                    score: parseFloat(score.toFixed(4)), // Keep 4 decimal places
                    ...targetItem
                });
            }
        });
        
        // 🛑 FIX: SORT AND RETURN THE RESULTS HERE
        
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