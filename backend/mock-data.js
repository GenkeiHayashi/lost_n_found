const mockLostItemData = {
    // Data structure that the frontend POST form would send (Used in POST /api/test-item)
    "name": "Brown Leather Wallet (with ID)",
    "description": "Lost my wallet between the Science block and the student union building. Contains a student ID and a faded picture of a cat.",
    "category": "Wallet / ID Card",
    "lastSeenLocation": "Student Union Cafeteria",
    "imageTempRef": "temp_wallet_photo_101", 
    "status": "lost"
};

const mockFirestoreItem = {
    // Original FOUND item (MOCK_DOC_ID_456)
    id: "MOCK_DOC_ID_456",
    status: "found",
    name: "Red iPhone 15 Pro",
    description: "Found under a bench near the engineering building. Phone case is cracked.",
    category: "Electronics",
    lastSeenLocation: "Engineering Building, Room B-10",
    dateReported: new Date().toISOString(),
    posterUid: "MOCK_ADMIN_UID_789",
    imageUrl: "https://placehold.co/400x300/ff6666/ffffff?text=MOCK+IPHONE",
    whereToCollect: "University Police Office, Room 102",
    isApproved: true,
    isResolved: false,
    textEmbedding: []
};

// --- NEW MOCK ITEMS FOR TESTING ---

const mockLostItemKeys = {
    // New LOST item
    id: "MOCK_DOC_ID_789",
    status: "lost",
    name: "Small Set of Keys on Lanyard",
    description: "Lost set of three keys on a blue university lanyard near the main library entrance. One key is a Yale key, the others are simple silver.",
    category: "Keys",
    lastSeenLocation: "Main Library Entrance",
    dateReported: new Date(Date.now() - 86400000).toISOString(), // Reported 1 day ago
    posterUid: "MOCK_STUDENT_UID_456",
    imageUrl: "https://placehold.co/400x300/3399FF/000000?text=LOST+KEYS",
    whereToCollect: null, // Lost item, so this is null
    isApproved: true,
    isResolved: false,
    textEmbedding: []
};

const mockFoundItemID = {
    // New FOUND item
    id: "MOCK_DOC_ID_101",
    status: "found",
    name: "Student ID Card (John D. Smith)",
    description: "Found an ID card belonging to John D. Smith on the pathway between the dorms and the gym.",
    category: "Wallet / ID Card",
    lastSeenLocation: "Dorm Pathway",
    dateReported: new Date(Date.now() - 3600000).toISOString(), // Reported 1 hour ago
    posterUid: "MOCK_STUDENT_UID_222",
    imageUrl: "https://placehold.co/400x300/00CC99/ffffff?text=STUDENT+ID",
    whereToCollect: "Front Desk, Hall 3",
    isApproved: true,
    isResolved: false,
    textEmbedding: []
};

// --- QUERY SIMULATION ---

const mockQueryResults = [
    mockFirestoreItem,
    mockLostItemKeys,
    mockFoundItemID,
    // Add the structure of the mockLostItemData for full array simulation (if it were approved)
    {
        ...mockLostItemData,
        id: "MOCK_DOC_ID_102",
        dateReported: new Date().toISOString(),
        posterUid: "MOCK_STUDENT_UID_500",
        isApproved: true
    }
];


// Export the single POST data object, the single GET item, and the full list for the mock GET endpoint
export { mockLostItemData, mockFirestoreItem, mockQueryResults };