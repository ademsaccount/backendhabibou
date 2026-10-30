// Diagnostic : liste pg_stat_activity (lecture seule) via le client Prisma
// généré, en forçant une IPv4 + connect_timeout (contourne les AAAA NAT64).
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
  const url = `${prefix}${v4.address}${suffix}`.replace(':6543/', ':5432/').replace(':5432/', ':5432/');
  const finalUrl = url + (url.includes('?') ? '&' : '?') + 'connect_timeout=30';
  const prisma = new PrismaClient({ datasources: { db: { url: finalUrl } } });
  try {
    const rows = await prisma.$queryRaw`
      SELECT pid, usename, application_name, client_addr, backend_start, query_start,
             state, wait_event, left(query, 90) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
      ORDER BY query_start DESC NULLS LAST`;
    console.log(`connexions (${rows.length}) :`);
    for (const r of rows) {
      console.log(
        `pid=${r.pid} user=${r.usename} app=${r.application_name} addr=${r.client_addr} ` +
        `state=${r.state} wait=${r.wait_event ?? '-'} start=${r.query_start ? r.query_start.toISOString() : '-'}` +
        `\n    q: ${r.query}`,
      );
    }
    const locks = await prisma.$queryRaw`
      SELECT a.pid AS locked_pid, b.pid AS holder_pid, b.query AS holder_query
      FROM pg_locks bl
      JOIN pg_locks gl ON gl.locktype = bl.locktype AND gl."locktype" = 'advisory'
      JOIN pg_stat_activity a ON a.pid = bl.pid
      JOIN pg_stat_activity b ON b.pid = gl.pid
      WHERE gl.granted = true AND bl.granted = false LIMIT 5`;
    console.log(`\ndemandes de verrous bloquées : ${locks.length}`);
    for (const l of locks) console.log(`  pid ${l.locked_pid} attend sur pid ${l.holder_pid} → ${l.holder_query}`);
  } catch (e) {
    console.log('ERREUR:', e.code ?? '', e.message.split('\n')[0]);
  } finally {
    await prisma.$disconnect();
  }
});
