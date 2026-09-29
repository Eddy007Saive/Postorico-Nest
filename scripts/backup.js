// Sauvegarde en lecture seule de toutes les tables de la base Postorico réelle.
// N'écrit rien en base — que des SELECT via le client Prisma, table par table.
// Le fichier produit contient de VRAIES données clients : ne jamais le commiter,
// à garder hors du dépôt (déjà exclu via .gitignore).
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  const modelNames = Object.keys(prisma).filter(
    (k) => !k.startsWith('_') && !k.startsWith('$') && typeof prisma[k]?.findMany === 'function',
  );

  const backup = {};
  const counts = [];
  for (const name of modelNames) {
    try {
      const rows = await prisma[name].findMany();
      backup[name] = rows;
      counts.push(`${name}: ${rows.length}`);
    } catch (e) {
      counts.push(`${name}: ERREUR (${e.message})`);
    }
  }

  const outDir = path.join(__dirname, '..', '_backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `postorico_backup_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(backup, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  console.log(`\n=== Sauvegarde écrite : ${outFile} ===`);
  console.log(counts.join('\n'));
}

main()
  .catch((e) => {
    console.error('Échec de la sauvegarde:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
