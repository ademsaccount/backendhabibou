const { Expo } = await import('expo-server-sdk');
const { PrismaClient } = await import('@prisma/client');
const p = new PrismaClient();
const u = await p.user.findUnique({ where: { id: '2175a59c-d0a1-4a7e-a603-0a094beb0a10' }, select: { expo_push_token: true, locale: true } });
console.log('token en DB:', u?.expo_push_token, '| locale:', u?.locale);
if (!u?.expo_push_token) { process.exit(1); }
const expo = new Expo();
const msgs = [{ to: u.expo_push_token, title: 'Test livraison', body: 'Diag receipt - ignorez', sound: 'default', priority: 'high', channelId: 'orders', data: { type: 'diag' } }];
const tickets = await expo.sendPushNotificationsAsync(msgs);
console.log('ticket:', JSON.stringify(tickets[0]));
if (tickets[0].status !== 'ok') { process.exit(1); }
const id = tickets[0].id;
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 4000));
  try {
    const receipts = await expo.getReceiptsAsync([id]);
    const r = receipts[0];
    console.log('poll ' + i + ' receipt:', JSON.stringify(r));
    if (r && r.status) break;
  } catch (e) { console.log('poll ' + i + ' err:', e.message); }
}
await p.$disconnect();
