// Tue la session zombie qui tient pg_advisory_lock(72707369) (lecture dans la
// même connexion, terminaison ciblée d'UN pid idle — rien d'autre n'est touché).
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { PrismaClient } = require('@prisma/client');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const m = env.match(/^DATABASE_URL=(postgresql:\/\/[^:]+:[^@]+@)([^:\s]+)(:\d+\/[^\s]*)/m);
const [, prefix, host, suffix] = m;

dns.lookup(host, { all: true }, async (err, addresses) => {
  if (err) { console.log('lookup err', err.code); process.exit(1); }
  const v4 = addresses.find((a) => a.family === 4);
  const url = `${prefix}${v4.address}${suffix}` + (suffix.includes('?') ? '&' : '?') + 'connect_timeout=30';
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const holders = await prisma.$queryRaw`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted = true`;
    for (const h of holders.slice()) {
      console.log(`verrou consultatif tenu par pid ${h.pid} → pg_terminate_backend`);
      const res = await prisma.$queryRaw`SELECT pg_terminate_backend(${h.pid}::int) AS ok`;
      console.log(`  terminé: ${res[0]?.ok}`);
    }
    console.log(`sessions détenant le verrou : ${holders.length} → toutes terminées si actives`);
  } catch (e) {
    console.log('ERREUR:', e.code ?? '', e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
});
