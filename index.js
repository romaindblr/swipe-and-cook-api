require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET manquant dans le .env');
}
if (JWT_SECRET.length < 32) {
  console.warn('⚠️ JWT_SECRET est court (< 32 caractères). Génère-en un avec : openssl rand -hex 48');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BATCH = 500;        // nombre max d'éléments dans une requête batch
const MAX_PERSONS = 100;      // nombre max de personnes pour une recette du panier
const MAX_LIMIT = 200;        // limit max pour GET /api/recipes
const BCRYPT_ROUNDS = 12;
// Hash factice : permet de faire le même travail bcrypt quand l'email n'existe pas
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

// ---------------------------------------------------------------------------
// App Express
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // derrière le tunnel Cloudflare : 1 proxy de confiance
app.use(morgan('dev'));
app.use(express.json({ limit: '50kb' }));

// Limite globale (large) pour toute l'API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie plus tard.' },
});
app.use('/api', apiLimiter);

// Limite stricte pour login / inscription (anti brute-force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
});

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Évite le crash du process si une connexion inactive tombe
pool.on('error', (err) => {
  console.error('Erreur pool PostgreSQL :', err.message);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isUuidList = (arr) => Array.isArray(arr) && arr.length <= MAX_BATCH && arr.every(isUuid);

// Réponse 500 générique : le détail reste dans les logs, jamais chez le client
const serverError = (res, label, err) => {
  console.error(label, err.message);
  return res.status(500).json({ error: 'Erreur serveur' });
};

// Gère les erreurs Postgres "prévisibles" dues à des données invalides
const handleDbInputError = (res, err) => {
  if (err.code === '23503') { // clé étrangère : recette inexistante
    res.status(400).json({ error: 'Recette inconnue.' });
    return true;
  }
  if (err.code === '22P02' || err.code === '22003') { // format invalide / hors limites
    res.status(400).json({ error: 'Données invalides.' });
    return true;
  }
  return false;
};

const normalizeEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

// ---------------------------------------------------------------------------
// Routes publiques
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send('API Swift Cook opérationnelle !');
});

// GET /api/recipes : recherche par nom, tag, aléatoire
app.get('/api/recipes', async (req, res) => {
  const { limit, random, tag, recipeID, search } = req.query;

  if (recipeID && !isUuid(recipeID)) {
    return res.status(400).json({ error: 'recipeID invalide.' });
  }
  if ((tag && typeof tag !== 'string') || (search && typeof search !== 'string')) {
    return res.status(400).json({ error: 'Paramètres invalides.' });
  }
  if (search && search.length > 100) {
    return res.status(400).json({ error: 'Recherche trop longue.' });
  }

  try {
    let query = 'SELECT * FROM recipes';
    const params = [];
    const conditions = [];

    if (recipeID) {
      params.push(recipeID);
      conditions.push(`id = $${params.length}`);
    }

    if (tag) {
      params.push(tag);
      conditions.push(`$${params.length} = ANY(tags)`);
    }

    if (search) {
      // On échappe % et _ pour que l'utilisateur ne fournisse pas ses propres jokers
      const escaped = search.trim().replace(/[\\%_]/g, '\\$&');
      params.push(`%${escaped}%`);
      const searchIndex = params.length;
      conditions.push(`(
        unaccent(title_fr) ILIKE unaccent($${searchIndex}) OR
        unaccent(title_en) ILIKE unaccent($${searchIndex}) OR
        EXISTS (
          SELECT 1 FROM unnest(tags) tag_item
          WHERE unaccent(tag_item) ILIKE unaccent($${searchIndex})
        )
      )`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += random === 'true' ? ' ORDER BY RANDOM()' : ' ORDER BY created_at DESC';

    if (limit !== undefined) {
      const n = parseInt(limit, 10);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'limit doit être un entier >= 1.' });
      }
      params.push(Math.min(n, MAX_LIMIT));
      query += ` LIMIT $${params.length}`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    serverError(res, 'Erreur SQL recettes :', err);
  }
});

// GET /api/recipes/:id : détail d'une recette + ingrédients
app.get('/api/recipes/:id', async (req, res) => {
  const { id } = req.params;

  if (!isUuid(id)) {
    return res.status(404).json({ error: 'Recette non trouvée' });
  }

  try {
    const recipeResult = await pool.query('SELECT * FROM recipes WHERE id = $1', [id]);

    if (recipeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recette non trouvée' });
    }

    const ingredientsResult = await pool.query(
      `SELECT
         i.id,
         ri.recipe_id,
         i.name_en,
         i.name_fr,
         ri.quantity,
         i.unit,
         i.units
       FROM recipe_ingredients ri
       JOIN ingredients i ON ri.ingredient_id = i.id
       WHERE ri.recipe_id = $1`,
      [id]
    );

    res.json({
      ...recipeResult.rows[0],
      ingredients: ingredientsResult.rows,
    });
  } catch (err) {
    serverError(res, 'Erreur SQL détail recette :', err);
  }
});

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------
app.post('/api/users/register', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password, display_name, default_servings } = req.body;

  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }
  // bcrypt ignore tout ce qui dépasse 72 octets
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Le mot de passe doit faire entre 8 et 72 caractères.' });
  }

  let name = null;
  if (typeof display_name === 'string' && display_name.trim()) {
    name = display_name.trim().slice(0, 50);
  }

  let servings = 2;
  if (default_servings !== undefined && default_servings !== null) {
    const s = parseInt(default_servings, 10);
    if (Number.isInteger(s) && s >= 1 && s <= 20) servings = s;
  }

  try {
    // Évite les doublons qui ne différeraient que par la casse (anciens comptes inclus)
    const existing = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, default_servings)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, default_servings`,
      [email, passwordHash, name, servings]
    );

    const newUser = result.rows[0];

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, user: newUser });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }
    serverError(res, 'Erreur inscription :', err);
  }
});

app.post('/api/users/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }
  if (password.length > 200) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  try {
    // lower(email) : compatible avec les comptes créés avant la normalisation
    const result = await pool.query(
      `SELECT id, email, display_name, default_servings, password_hash
       FROM users WHERE lower(email) = $1`,
      [email]
    );

    const user = result.rows[0];

    // On compare toujours avec un hash (réel ou factice) pour que le temps de
    // réponse ne révèle pas si l'email existe.
    const isPasswordValid = await bcrypt.compare(
      password,
      user ? user.password_hash : DUMMY_HASH
    );

    if (!user || !isPasswordValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    delete user.password_hash;

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user });
  } catch (err) {
    serverError(res, 'Erreur connexion :', err);
  }
});

// Middleware de vérification JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

  if (!token) return res.status(401).json({ error: 'Token manquant' });

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalide ou expiré' });
    req.user = user;
    next();
  });
};

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name, default_servings FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, 'Erreur profil :', err);
  }
});

// PATCH /api/users/me : modifier ses préférences (nombre de personnes par défaut)
app.patch('/api/users/me', authenticateToken, async (req, res) => {
  const n = parseInt(req.body.default_servings, 10);

  if (!Number.isInteger(n) || n < 1 || n > 20) {
    return res.status(400).json({ error: 'default_servings doit être un entier entre 1 et 20.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET default_servings = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, display_name, default_servings`,
      [n, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, 'Erreur mise à jour profil :', err);
  }
});

// DELETE /api/users/me : suppression du compte et de toutes ses données (RGPD / Apple)
app.delete('/api/users/me', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_cart WHERE user_id = $1', [req.user.userId]);
    await client.query('DELETE FROM user_favorites WHERE user_id = $1', [req.user.userId]);
    await client.query('DELETE FROM users WHERE id = $1', [req.user.userId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    serverError(res, 'Erreur suppression compte :', err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Favoris
// ---------------------------------------------------------------------------
app.get('/api/users/favorites', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT
        r.*,
        COALESCE(ing.ingredients_list, '[]'::json) AS ingredients
      FROM user_favorites uf
      JOIN recipes r ON uf.recipe_id = r.id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', i.id,
            'recipe_id', ri.recipe_id,
            'name_en', i.name_en,
            'name_fr', i.name_fr,
            'quantity', ri.quantity::text,
            'unit', i.unit,
            'units', i.units
          )
        ) AS ingredients_list
        FROM recipe_ingredients ri
        JOIN ingredients i ON ri.ingredient_id = i.id
        WHERE ri.recipe_id = r.id
      ) ing ON true
      WHERE uf.user_id = $1;
    `;

    const result = await pool.query(query, [req.user.userId]);
    res.json(result.rows);
  } catch (err) {
    serverError(res, 'Erreur récupération favoris :', err);
  }
});

// POST /api/users/favorites/add  body: { recipeIds: ["uuid1", ...] }
app.post('/api/users/favorites/add', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body;

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun favori à synchroniser.' });
  }
  if (!isUuidList(recipeIds)) {
    return res.status(400).json({ error: `recipeIds doit contenir au plus ${MAX_BATCH} UUID valides.` });
  }

  try {
    await pool.query(
      `INSERT INTO user_favorites (user_id, recipe_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT (user_id, recipe_id) DO NOTHING;`,
      [req.user.userId, recipeIds]
    );

    res.status(200).json({ success: true, message: 'Tous les favoris ont été synchronisés.' });
  } catch (err) {
    if (handleDbInputError(res, err)) return;
    serverError(res, 'Erreur synchronisation favoris :', err);
  }
});

// POST /api/users/favorites/remove  body: { recipeIds: ["uuid1", ...] }
app.post('/api/users/favorites/remove', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body;

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun favori à supprimer.' });
  }
  if (!isUuidList(recipeIds)) {
    return res.status(400).json({ error: `recipeIds doit contenir au plus ${MAX_BATCH} UUID valides.` });
  }

  try {
    await pool.query(
      `DELETE FROM user_favorites
       WHERE user_id = $1 AND recipe_id = ANY($2::uuid[]);`,
      [req.user.userId, recipeIds]
    );

    res.status(200).json({ success: true, message: 'Recettes retirées des favoris.' });
  } catch (err) {
    serverError(res, 'Erreur suppression favoris :', err);
  }
});

// ---------------------------------------------------------------------------
// Panier
// ---------------------------------------------------------------------------
// GET /api/users/cart : recettes du panier + nombre de personnes + ingrédients
app.get('/api/users/cart', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT
        r.*,
        uc.number_of_persons,
        COALESCE(ing.ingredients_list, '[]'::json) AS ingredients
      FROM user_cart uc
      JOIN recipes r ON uc.recipe_id = r.id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', i.id,
            'recipe_id', ri.recipe_id,
            'name_en', i.name_en,
            'name_fr', i.name_fr,
            'quantity', ri.quantity::text,
            'unit', i.unit,
            'units', i.units
          )
        ) AS ingredients_list
        FROM recipe_ingredients ri
        JOIN ingredients i ON ri.ingredient_id = i.id
        WHERE ri.recipe_id = r.id
      ) ing ON true
      WHERE uc.user_id = $1
      ORDER BY uc.updated_at DESC;
    `;

    const result = await pool.query(query, [req.user.userId]);
    res.json(result.rows);
  } catch (err) {
    serverError(res, 'Erreur récupération panier :', err);
  }
});

// POST /api/users/cart/add : ajout/mise à jour en batch
// body: { items: [{ recipeId: "uuid", numberOfPersons: 4 }, ...] }
app.post('/api/users/cart/add', authenticateToken, async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun élément à synchroniser.' });
  }
  if (items.length > MAX_BATCH) {
    return res.status(400).json({ error: `Maximum ${MAX_BATCH} éléments par requête.` });
  }

  const recipeIds = [];
  const persons = [];
  for (const item of items) {
    const n = item ? parseInt(item.numberOfPersons, 10) : NaN;
    if (!item || !isUuid(item.recipeId) || !Number.isInteger(n) || n < 1 || n > MAX_PERSONS) {
      return res.status(400).json({
        error: `recipeId (UUID) et numberOfPersons (entre 1 et ${MAX_PERSONS}) requis.`,
      });
    }
    recipeIds.push(item.recipeId);
    persons.push(n);
  }

  try {
    await pool.query(
      `INSERT INTO user_cart (user_id, recipe_id, number_of_persons, updated_at)
       SELECT $1, t.recipe_id, t.persons, NOW()
       FROM unnest($2::uuid[], $3::int[]) AS t(recipe_id, persons)
       ON CONFLICT (user_id, recipe_id)
       DO UPDATE SET number_of_persons = EXCLUDED.number_of_persons,
                     updated_at = NOW();`,
      [req.user.userId, recipeIds, persons]
    );
    res.status(200).json({ success: true, message: 'Panier synchronisé.' });
  } catch (err) {
    if (handleDbInputError(res, err)) return;
    serverError(res, 'Erreur synchronisation panier :', err);
  }
});

// PATCH /api/users/cart/:recipeId : changer le nombre de personnes
app.patch('/api/users/cart/:recipeId', authenticateToken, async (req, res) => {
  const { recipeId } = req.params;
  const n = parseInt(req.body.numberOfPersons, 10);

  if (!isUuid(recipeId)) {
    return res.status(404).json({ error: 'Recette absente du panier.' });
  }
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERSONS) {
    return res.status(400).json({ error: `numberOfPersons doit être un entier entre 1 et ${MAX_PERSONS}.` });
  }

  try {
    const result = await pool.query(
      `UPDATE user_cart
       SET number_of_persons = $1, updated_at = NOW()
       WHERE user_id = $2 AND recipe_id = $3`,
      [n, req.user.userId, recipeId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Recette absente du panier.' });
    }

    res.json({ success: true });
  } catch (err) {
    serverError(res, 'Erreur mise à jour panier :', err);
  }
});

// POST /api/users/cart/remove : retrait en batch
// body: { recipeIds: ["uuid1", "uuid2"] }
app.post('/api/users/cart/remove', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body;

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun élément à supprimer.' });
  }
  if (!isUuidList(recipeIds)) {
    return res.status(400).json({ error: `recipeIds doit contenir au plus ${MAX_BATCH} UUID valides.` });
  }

  try {
    await pool.query(
      `DELETE FROM user_cart
       WHERE user_id = $1 AND recipe_id = ANY($2::uuid[])`,
      [req.user.userId, recipeIds]
    );
    res.status(200).json({ success: true, message: 'Recettes retirées du panier.' });
  } catch (err) {
    serverError(res, 'Erreur suppression panier :', err);
  }
});

// POST /api/users/cart/clear : vider tout le panier
app.post('/api/users/cart/clear', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_cart WHERE user_id = $1', [req.user.userId]);
    res.status(200).json({ success: true, message: 'Panier vidé.' });
  } catch (err) {
    serverError(res, 'Erreur vidage panier :', err);
  }
});

// ---------------------------------------------------------------------------
// Gestion des erreurs (à placer après toutes les routes)
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Requête trop volumineuse.' });
  }
  console.error('Erreur non gérée :', err.message);
  res.status(500).json({ error: 'Erreur serveur' });
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
// À terme : déplacer cette ligne dans init.sql et retirer les droits
// de création d'extension à l'utilisateur de l'API.
pool.query('CREATE EXTENSION IF NOT EXISTS unaccent;')
  .then(() => console.log('✅ Extension unaccent activée sur PostgreSQL'))
  .catch((err) => console.error('⚠️ Erreur activation unaccent:', err.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
