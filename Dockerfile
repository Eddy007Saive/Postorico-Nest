# Node 20 sur Debian (pas Alpine) : Chromium/Playwright (rendu carrousels) a besoin de
# bibliothèques partagées (glibc) absentes de musl — voir `install --with-deps` plus bas.
FROM node:20-bookworm-slim

WORKDIR /app

# Fichiers de dépendances + schéma Prisma AVANT `npm ci` : le postinstall de
# @prisma/client (génération du client) cherche prisma/schema.prisma au moment de
# l'install ; sans lui présent ici, la génération échoue silencieusement.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Chromium headless (rendu carrousels, Playwright) : navigateur + dépendances système
# (le binaire vient de la dépendance "playwright" du package.json, pas d'une version à part).
RUN npx playwright install --with-deps chromium

# Code source + build (nest build a besoin des devDependencies, donc après le `npm ci`
# complet ci-dessus — jamais un `npm ci --only=production` avant le build).
COPY . .
RUN npm run build

# Expose port (Railway fournit $PORT dynamiquement)
EXPOSE 3000

# Démarre l'application
CMD ["node", "dist/main"]
