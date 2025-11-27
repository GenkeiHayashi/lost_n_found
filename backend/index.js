import express from "express";
import cors from "cors";
import * as dotenv from 'dotenv';
import admin from 'firebase-admin'; // Firebase Admin SDK
import path from 'path'; // Node.js native module for path resolution
import { fileURLToPath } from 'url'; // For path resolution in ES Modules
import { Storage } from '@google-cloud/storage'; // Google Cloud Storage SDK
import multer from 'multer'; // Middleware for handling file uploads

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
        fileSize: 5 * 1024 * 1024, // Limit files to 5MB (Good practice for performance/cost)
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


// --- STORAGE UTILITY FUNCTION ---

/**
 * Uploads a file buffer (from Multer) to Firebase Storage.
 * @param {object} file - The file object provided by Multer.
 * @returns {string} The public URL of the uploaded file.
 */
const uploadFileToStorage = async (file) => {
    if (!file) return null;

    // Create a unique file name using the current timestamp and original name
    const timestamp = Date.now();
    const fileName = `items/${timestamp}_${file.originalname.replace(/ /g, '_')}`;

    const fileUpload = bucket.file(fileName);

    // Create a writable stream and pipeline the file buffer to it
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
            // Make the file publicly readable
            // NOTE: In a production app, you might use signed URLs instead of making it public.
            await fileUpload.makePublic(); 
            // Return the public URL
            const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
            resolve(publicUrl);
        });
        
        // End the stream with the file buffer
        stream.end(file.buffer); 
    });
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
        let imageUrl = null;
        if (file) {
            imageUrl = await uploadFileToStorage(file);
        } else if (frontendData.imageTempRef) {
             // Fallback for mock data or if using a pre-uploaded ref
            imageUrl = `temp/storage/${frontendData.imageTempRef}`; 
        }

        // 3. CONSTRUCTING THE FIRESTORE DOCUMENT (Server-Controlled Fields)
        const serverGeneratedFields = {
            posterUid: req.user.uid, 
            isApproved: false, // Items require admin review by default
            isResolved: false, 
            dateReported: admin.firestore.FieldValue.serverTimestamp(),
            textEmbedding: [], // Placeholder for AI vector
            imageUrl: imageUrl, // Use the real URL or placeholder
            
            // Conditional field: only save if status is 'found' and data exists
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
};


// --- API ROUTES ---

// Health Check / Default Route
app.get("/", (req, res) => {
    res.send("Hello from the Lost & Found Backend!");
});

// Mock User Data Route (Temporary for frontend proxy test)
app.get("/api/user", (req, res) => {
    res.json(users);
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
        
        // 1. BASE QUERY: Filter for approved and unresolved items (Required for public view)
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


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Backend is serving on port ${PORT}`);
});