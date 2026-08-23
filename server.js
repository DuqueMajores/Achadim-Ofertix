import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin SDK
let firestoreDb = null;
try {
  const serviceAccount = JSON.parse(
    readFileSync(path.join(__dirname, 'firebase-key.json'), 'utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  firestoreDb = admin.firestore();
  console.log('Firebase Admin initialized successfully with project:', serviceAccount.project_id);
} catch (err) {
  console.error('Failed to initialize Firebase Admin:', err);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Increase payload size limit to support base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from the current directory
app.use(express.static(__dirname));

// Firebase cloud sync endpoints
app.get('/api/db', async (req, res) => {
  if (!firestoreDb) {
    return res.status(500).json({ error: 'Firebase is not initialized on the server.' });
  }
  try {
    const siteRef = firestoreDb.collection('metadata').doc('site');
    const catsRef = firestoreDb.collection('metadata').doc('cats');
    const productsSnapshot = await firestoreDb.collection('products').get();

    const [siteDoc, catsDoc] = await Promise.all([siteRef.get(), catsRef.get()]);

    // If Firestore is completely brand new and empty, notify the client so it can seed the cloud
    if (!siteDoc.exists && !catsDoc.exists && productsSnapshot.empty) {
      return res.json({ uninitialized: true });
    }

    const site = siteDoc.exists ? siteDoc.data() : { name: 'OFERTIX', logo: '' };
    const cats = catsDoc.exists ? catsDoc.data().list : ['Todos', 'Eletrônicos', 'Casa', 'Moda', 'Beleza', 'Ofertas'];
    
    const products = [];
    productsSnapshot.forEach(doc => {
      products.push(doc.data());
    });

    res.json({ site, cats, products });
  } catch (err) {
    console.error('Error fetching data from Firestore:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve database.' });
  }
});

app.post('/api/db', async (req, res) => {
  if (!firestoreDb) {
    return res.status(500).json({ error: 'Firebase is not initialized on the server.' });
  }
  try {
    const { site, cats, products } = req.body;

    if (!site || !cats || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Invalid database payload.' });
    }

    const siteRef = firestoreDb.collection('metadata').doc('site');
    const catsRef = firestoreDb.collection('metadata').doc('cats');

    // Save site metadata and categories
    await Promise.all([
      siteRef.set(site),
      catsRef.set({ list: cats })
    ]);

    // Sync products
    const productsSnapshot = await firestoreDb.collection('products').get();
    const existingIds = productsSnapshot.docs.map(doc => doc.id);
    const incomingIds = products.map(p => String(p.id));

    // Construct list of batch operations
    const operations = [];

    // Add or update products
    products.forEach(p => {
      operations.push((batch) => {
        const docRef = firestoreDb.collection('products').doc(String(p.id));
        batch.set(docRef, p);
      });
    });

    // Delete products not present in payload
    existingIds.forEach(id => {
      if (!incomingIds.includes(id)) {
        operations.push((batch) => {
          const docRef = firestoreDb.collection('products').doc(id);
          batch.delete(docRef);
        });
      }
    });

    // Commit operations in chunks of 400 to prevent Firestore's 500 operations per batch limit
    let batch = firestoreDb.batch();
    let count = 0;
    for (const op of operations) {
      op(batch);
      count++;
      if (count === 400) {
        await batch.commit();
        batch = firestoreDb.batch();
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving data to Firestore:', err);
    res.status(500).json({ error: err.message || 'Failed to save database.' });
  }
});

// Fallback to index.html for other paths
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
