🍳 Swipe & Cook — Backend API & Infrastructure

API REST backend pour l'application iOS Swipe & Cook, hébergée sur une infrastructure Proxmox (LXC) avec Node.js, PostgreSQL et Cloudflare Tunnels.

🛠️ Stack Technique

Serveur API : Node.js 20, Express.js

Base de données : PostgreSQL 16 (via Docker)

Gestionnaire de BDD : Adminer (via Docker)

Sécurité & Auth : JWT (JSON Web Tokens) & Bcrypt

Gestionnaire de processus : PM2

Exposition sécurisée : Cloudflare Zero Trust Tunnel

Infrastructure : Proxmox VE (Conteneurs LXC)

🏗️ Architecture HomeLab

Le projet est divisé de manière sécurisée en deux conteneurs LXC distincts :

LXC 100 (lxc-postgres - 192.168.1.101) : Héberge le moteur de base de données.

Conteneur Docker swipe_cook_db (PostgreSQL sur le port 5432).

Conteneur Docker swipe_cook_adminer (Interface web sur le port 8080).

LXC 101 (lxc-api - 192.168.1.102) : Héberge la logique métier.

API Express exécutée et maintenue en vie via PM2 (Port 3000).

Démon cloudflared pour relier l'API à l'application iOS.

🚀 Installation & Lancement

1. Variables d'environnement

Créer un fichier .env à la racine de l'API (ne jamais le publier sur GitHub) :

PORT=3000
DB_HOST=192.168.1.101
DB_PORT=5432
DB_USER=bkge
DB_PASSWORD="#votre_mot_de_passe"
DB_NAME=swipe_and_cook_db
JWT_SECRET=votre_cle_secrete_jwt


2. Base de données

Restaurer la structure de la base de données et les tables en injectant le fichier init.sql dans le conteneur PostgreSQL :

docker exec -i swipe_cook_db psql -U bkge -d swipe_and_cook_db < init.sql


L'interface d'administration Adminer est ensuite accessible en local sur http://192.168.1.101:8080 pour gérer les données visuellement.

3. Lancer l'API

Installer les dépendances et démarrer le serveur de production :

npm install
pm2 start index.js --name swipe-cook-api
pm2 save


📄 Licence

Projet développé à titre personnel par Romain Doublier.
Tous droits réservés.
