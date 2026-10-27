require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');


const app = express();
app.use(morgan('dev')); // Enregistre toutes les requêtes HTTP dans les logs
app.use(express.json());

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Connexion à la base PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Route de test
app.get('/', (req, res) => {
  res.send('API Swift Cook opérationnelle !');
});

// Route GET /api/recipes avec recherche par nom et tag
app.get('/api/recipes', async (req, res) => {
  const { limit, random, tag, recipeID, search } = req.query;

  try {
    // 💡 Remplace le SELECT ciblé par SELECT *
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
       params.push(`%${search.trim()}%`);
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

    if (random === 'true') {
      query += ' ORDER BY RANDOM()';
    } else {
      query += ' ORDER BY created_at DESC';
    }

    if (limit) {
      params.push(parseInt(limit, 10));
      query += ` LIMIT $${params.length}`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Erreur SQL :", err.message);
    res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
});

// Route pour récupérer le détail d'une recette avec ses ingrédients
app.get('/api/recipes/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const recipeResult = await pool.query(
      'SELECT * FROM recipes WHERE id = $1',
      [id]
    );

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
      ingredients: ingredientsResult.rows
    });
  } catch (err) {
    console.error("Erreur SQL détaillée :", err.message);
    res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
});

// Route au pluriel pour correspondre à Swift
app.post('/api/users/register', async (req, res) => {
  const { email, password, display_name, default_servings } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, display_name, default_servings) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, passwordHash, display_name || null, default_servings || 2]
    );

    const newUser = result.rows[0];
    delete newUser.password_hash;

    // 💡 1. Génération du token JWT
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || 'votre_cle_secrete_de_dev',
      { expiresIn: '30d' }
    );

    // 💡 2. Envoi du format JSON attendu par Swift { token, user }
    res.status(201).json({
      token: token,
      user: newUser
    });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
    }

    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    // 1. Chercher l'utilisateur par email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    const user = result.rows[0];

    // 2. Comparer le mot de passe en clair avec le hash bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    // 3. Ne pas renvoyer le hash du mot de passe
    delete user.password_hash;

    // 4. Générer le JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'votre_cle_secrete_de_dev',
      { expiresIn: '30d' }
    );

    // 5. Renvoyer la réponse formatée pour Swift
    res.json({
      token: token,
      user: user
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Middleware de vérification JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

  if (!token) return res.status(401).json({ error: 'Token manquant' });

  jwt.verify(token, process.env.JWT_SECRET || 'votre_cle_secrete_de_dev', (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalide ou expiré' });
    req.user = user;
    next();
  });
};

// Route pour récupérer son propre profil au lancement de l'app
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, display_name, default_servings FROM users WHERE id = $1', [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

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
            'recipe_id', ri.recipe_id,  -- 👈 AJOUTÉ POUR SWIFT
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
    console.error('Erreur récupération favoris:', err);
    res.status(500).json({ error: 'Erreur serveur', details: err.message });
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
    console.error('Erreur mise à jour profil :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/users/favorites/add
app.post('/api/users/favorites/add', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body; // ex: ["uuid1", "uuid2"]

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun favori à synchroniser.' });
  }

  try {
    const query = `
      INSERT INTO user_favorites (user_id, recipe_id)
      SELECT $1, unnest($2::uuid[])
      ON CONFLICT (user_id, recipe_id) DO NOTHING;
    `;

    await pool.query(query, [req.user.userId, recipeIds]);

    res.status(200).json({ success: true, message: 'Tous les favoris ont été synchronisés.' });
  } catch (err) {
    console.error('Erreur synchronisation batch favoris :', err);
    res.status(500).json({ error: 'Erreur serveur lors de la synchronisation batch.' });
  }
});

// POST /api/users/favorites/remove
app.post('/api/users/favorites/remove', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body; // ex: ["uuid1", "uuid2"]

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun favori à synchroniser.' });
  }

  try {
    const query = `
      DELETE FROM user_favorites
      WHERE user_id = $1 AND recipe_id = ANY($2::uuid[]);
    `;

    await pool.query(query, [req.user.userId, recipeIds]);

    res.status(200).json({ success: true, message: 'recette supprimer de favorie.' });
  } catch (err) {
    console.error('Erreur synchronisation delete favoris :', err);
    res.status(500).json({ error: 'Erreur serveur lors de la synchronisation delete favories.' });
  }
});

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
    console.error('Erreur récupération panier :', err);
    res.status(500).json({ error: 'Erreur serveur', details: err.message });
  }
});

// POST /api/users/cart/add : ajout/mise à jour en batch
// body: { items: [{ recipeId: "uuid", numberOfPersons: 4 }, ...] }
app.post('/api/users/cart/add', authenticateToken, async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun élément à synchroniser.' });
  }

  const recipeIds = [];
  const persons = [];
  for (const item of items) {
    const n = parseInt(item.numberOfPersons, 10);
    if (!item.recipeId || !Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'recipeId et numberOfPersons (>= 1) requis.' });
    }
    recipeIds.push(item.recipeId);
    persons.push(n);
  }

  try {
    const query = `
      INSERT INTO user_cart (user_id, recipe_id, number_of_persons, updated_at)
      SELECT $1, t.recipe_id, t.persons, NOW()
      FROM unnest($2::uuid[], $3::int[]) AS t(recipe_id, persons)
      ON CONFLICT (user_id, recipe_id)
      DO UPDATE SET number_of_persons = EXCLUDED.number_of_persons,
                    updated_at = NOW();
    `;

    await pool.query(query, [req.user.userId, recipeIds, persons]);
    res.status(200).json({ success: true, message: 'Panier synchronisé.' });
  } catch (err) {
    console.error('Erreur synchronisation panier :', err);
    res.status(500).json({ error: 'Erreur serveur lors de la synchronisation du panier.' });
  }
});

// PATCH /api/users/cart/:recipeId : changer le nombre de personnes
app.patch('/api/users/cart/:recipeId', authenticateToken, async (req, res) => {
  const { recipeId } = req.params;
  const n = parseInt(req.body.numberOfPersons, 10);

  if (!Number.isInteger(n) || n < 1) {
    return res.status(400).json({ error: 'numberOfPersons doit être un entier >= 1.' });
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
    console.error('Erreur mise à jour panier :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/users/cart/remove : retrait en batch
// body: { recipeIds: ["uuid1", "uuid2"] }
app.post('/api/users/cart/remove', authenticateToken, async (req, res) => {
  const { recipeIds } = req.body;

  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(200).json({ success: true, message: 'Aucun élément à supprimer.' });
  }

  try {
    await pool.query(
      `DELETE FROM user_cart
       WHERE user_id = $1 AND recipe_id = ANY($2::uuid[])`,
      [req.user.userId, recipeIds]
    );
    res.status(200).json({ success: true, message: 'Recettes retirées du panier.' });
  } catch (err) {
    console.error('Erreur suppression panier :', err);
    res.status(500).json({ error: 'Erreur serveur lors de la suppression.' });
  }
});

// POST /api/users/cart/clear : vider tout le panier
app.post('/api/users/cart/clear', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_cart WHERE user_id = $1', [req.user.userId]);
    res.status(200).json({ success: true, message: 'Panier vidé.' });
  } catch (err) {
    console.error('Erreur vidage panier :', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Activer l'extension unaccent automatiquement
pool.query('CREATE EXTENSION IF NOT EXISTS unaccent;')
  .then(() => console.log('✅ Extension unaccent activée sur PostgreSQL'))
  .catch(err => console.error('⚠️ Erreur activation unaccent:', err.message));

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
