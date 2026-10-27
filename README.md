# 🍳 Swipe & Cook — Backend API

L'API REST monolithique propulsant l'application iOS native *Swipe & Cook*. Elle est conçue avec **Node.js** et **Express** pour gérer l'authentification (JWT), les requêtes de recettes, le panier d'ingrédients et la synchronisation sécurisée des favoris utilisateur.

---

## 🏗️ Architecture du Serveur (Proxmox VE)

Pour assurer une isolation parfaite des processus et des sauvegardes indépendantes, l'infrastructure serveur est hébergée sous **Proxmox VE** et scindée en deux conteneurs LXC distincts :

### 1. LXC 100 (`lxc-postgres`) : Base de données
* **IP Locale :** `192.168.1.101`
* **Moteur :** Docker
* **Base de données :** PostgreSQL 16 (Image `postgres:16-alpine`)
* **Interface de Gestion :** Adminer (sur le port 8080)
* **Objectif :** Héberger les données (`swipe_and_cook_db`) de manière persistante sur disque SSD, isolées du serveur web.

### 2. LXC 101 (`lxc-api`) : Serveur Web & API
* **IP Locale :** `192.168.1.102`
* **Serveur d'Exécution :** Node.js 20, géré en daemon par **PM2**
* **Réseau Externe :** Cloudflare Zero Trust Tunnel (URL HTTPS gratuite `.trycloudflare.com`)
* **Objectif :** Faire tourner le code Express de l'API et exposer la connexion sécurisée sur Internet.

---

## 🛠️ Stack Technique

* **Langage & Runtime :** JavaScript (Node.js v20+)
* **Framework Web :** Express.js
* **Base de données :** PostgreSQL 16 (Driver `pg`)
* **Sécurité & Auth :** JSON Web Tokens (`jsonwebtoken`), Hachage `bcrypt`
* **Gestionnaire de processus :** PM2
* **Proxy / HTTPS :** Cloudflare Tunnel
* **Monitoring des requêtes :** Morgan

---

## 🔌 Routes Principales

### 🔓 Routes Publiques (Découverte)
* `GET /api/recipes` : Récupère la liste des recettes (Filtres supportés : `search` via `unaccent`, `tag`, `random`, `limit`).
* `GET /api/recipes/:id` : Récupère le détail d'une recette ainsi que la liste jointurée de ses ingrédients.

### 🔐 Authentification (Utilisateurs)
* `POST /api/users/register` : Inscription d'un utilisateur, hachage Bcrypt, et retour du Token JWT.
* `POST /api/users/login` : Connexion utilisateur et génération du Token JWT.
* `GET /api/users/me` : Profil de l'utilisateur connecté *(exige le Bearer Token)*.

### ❤️ Favoris (Nécessite le Token JWT)
* `GET /api/users/favorites` : Récupération des favoris avec leurs données et ingrédients agrégés en JSON via sous-requête `LATERAL`.
* `POST /api/users/favorites/batch` : Synchronisation globale du cache local iOS vers la base de données PostgreSQL.

---

## 🚀 Installation & Déploiement Local

Pour faire tourner cette API sur votre machine de développement (ex: macOS) :

### 1. Cloner le projet et installer les dépendances
```bash
git clone [https://github.com/romaindblr/swipe-and-cook-api.git](https://github.com/romaindblr/swipe-and-cook-api.git)
cd swipe-and-cook-api
npm install
```

### 2. Configuration (.env)
Créez un fichier .env à la racine pour lier votre base de données :

Code snippet
PORT=3000
DB_HOST=192.168.1.101
DB_PORT=5432
DB_USER=bkge
DB_PASSWORD=#rorododo71
DB_NAME=swipe_and_cook_db
JWT_SECRET=votre_cle_secrete_jwt

### 3. Base de données
Assurez-vous d'avoir exécuté le fichier de création init.sql pour créer les tables nécessaires.

### 4. Démarrage de l'API
Bash
# Lancement simple
npm start

# Mode production avec PM2 (recommandé)
npm install -g pm2
pm2 start index.js --name swipe-cook-api
pm2 save

---
*Projet développé par Romain Doublier.*
