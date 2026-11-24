/**
 * E2E coupon de bienvenue — lance un serveur HTTP en-process avec le vrai
 * createApp(), mocke les pushes Expo (undici MockAgent), puis verifie :
 *  - 1 coupon par compte verifie, pas de doublon, pas de backfill ;
 *  - commande sans coupon inchangee ; avec coupon : frais 0 / remise / USED / total ;
 *  - 2e utilisation -> COUPON_ALREADY_USED ; concurrence -> 1 seule reussit ;
 *  - coupon d'un autre user -> COUPON_NOT_FOUND (seen) ;
 *  - annulation avant pickup -> coupon restaure puis reutilisable ;
 *  - push bienvenue : differe sans jeton, envoye une seule fois, localise.
 *
 * Mode E2E_FEE_ZERO=1 : frais configures a 0 (DELIVERY_BASE_FEE=0 ...) pour le
 * cas COUPON_NOT_APPLICABLE. Aucun email/push reel. Toutes les donnees creees
 * (users prefixed, commandes, coupons, restaurant/produit) sont supprimees.
 */
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { MockAgent, setGlobalDispatcher } from 'undici';

const FEE_ZERO = process.env.E2E_FEE_ZERO === '1';
// Le serveur exige GOOGLE_CLIENT_ID au demarrage ; en e2e aucun login Google
// n'est utilise -> valeur factice locale (jamais une vraie credential).
if (!process.env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = 'e2e-local-dummy.apps.googleusercontent.com';
if (FEE_ZERO) {
  process.env.DELIVERY_BASE_FEE = '0';
  process.env.DELIVERY_PER_KM_FEE = '0';
  process.env.DELIVERY_HOP_FEE = '0';
}

// --- Mock push Expo (avant tout import de l'app : le SDK charge undici). ---
const mockAgent = new MockAgent();
// Seul le trafic local vers l'app en test (http://127.0.0.1:<port>) est
// autorise ; tout le reste est bloque. Les pushes Expo sont interceptes.
mockAgent.disableNetConnect();
mockAgent.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
setGlobalDispatcher(mockAgent);
let pushRequests = 0;
let lastPushBody = '';
const pool = mockAgent.get('https://exp.host');
pool
  .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
  .reply(200, (opts) => {
    pushRequests += 1;
    try {
      lastPushBody = String(opts.body ?? '');
    } catch {
      lastPushBody = '';
    }
    return { data: [{ status: 'ok', id: `mock-${Date.now()}` }] };
  })
  .persist();

const PREFIX = `e2e-coupon-${Date.now()}`;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail: ok ? undefined : String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `attendu=${JSON.stringify(expected)} recu=${JSON.stringify(actual)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createApp } = await import('../src/app');
  const { prisma } = await import('../src/lib/prisma');

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `${PREFIX} shop`,
      category: 'restaurant',
      address: 'e2e',
      latitude: 36.8,
      longitude: 10.18,
      is_open: true,
    },
  });
  const product = await prisma.product.create({
    data: { restaurant_id: restaurant.id, name: `${PREFIX} produit`, price: 10, is_available: true },
  });

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function api(
    path: string,
    opts: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  const createdEmails: string[] = [];
  const userIds: string[] = [];

  async function newVerifiedUser(tag: string): Promise<{ email: string; token: string; id: string }> {
    const email = `${PREFIX}-${tag}@habichou.test`;
    createdEmails.push(email);
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { email, password: 'MotDePasse123!', full_name: `E2E ${tag}` },
    });
    if (reg.status !== 201 || !reg.json?.dev_code) throw new Error(`register ${tag} -> ${reg.status} ${JSON.stringify(reg.json)}`);
    const ver = await api('/auth/verify-email', { method: 'POST', body: { email, code: reg.json.dev_code } });
    if (ver.status !== 200) throw new Error(`verify ${tag} -> ${ver.status} ${JSON.stringify(ver.json)}`);
    userIds.push(ver.json.user.id);
    return { email, token: ver.json.access_token, id: ver.json.user.id };
  }

  async function addAddress(userId: string) {
    return prisma.address.create({
      data: {
        user_id: userId,
        label: 'E2E',
        latitude: 36.8,
        longitude: 10.18,
        address_text: 'Rue E2E',
        is_default: true,
      },
    });
  }

  const orderBody = (addressId: string, useCoupon?: boolean) => ({
    address_id: addressId,
    payment_method: 'cash',
    ...(useCoupon ? { use_welcome_coupon: true } : {}),
    items: [{ product_id: product.id, quantity: 1 }],
  });

  if (FEE_ZERO) {
    // --- Cas frais deja nuls : COUPON_NOT_APPLICABLE, rien consomme. ---
    const u = await newVerifiedUser('feezero');
    const coupons = await prisma.coupon.findMany({ where: { user_id: u.id } });
    eq('fee0: 1 coupon accorde a la verification', coupons.length, 1);
    const address = await addAddress(u.id);
    const res = await api('/orders', { method: 'POST', token: u.token, body: orderBody(address.id, true) });
    eq('fee0: commande + coupon -> 400', res.status, 400);
    eq('fee0: code COUPON_NOT_APPLICABLE', res.json?.error?.code, 'COUPON_NOT_APPLICABLE');
    const after = await prisma.coupon.findUnique({ where: { id: coupons[0].id } });
    eq('fee0: coupon reste AVAILABLE', after?.status, 'AVAILABLE');
    eq('fee0: used_at null', after?.used_at, null);

    // Commande sans coupon : ok, frais 0.
    const plain = await api('/orders', { method: 'POST', token: u.token, body: orderBody(address.id) });
    eq('fee0: commande sans coupon -> 201', plain.status, 201);
    eq('fee0: frais 0 sans coupon', plain.json?.delivery_fee, 0);
    eq('fee0: remise 0 sans coupon', plain.json?.delivery_discount, 0);
  } else {
    // --- 1. Verification -> exactement 1 coupon. ---
    const a = await newVerifiedUser('a');
    const couponsA = await prisma.coupon.findMany({ where: { user_id: a.id } });
    eq('A: 1 coupon a la verification', couponsA.length, 1);
    eq('A: coupon FREE_DELIVERY/WELCOME/AVAILABLE', [couponsA[0]?.type, couponsA[0]?.source, couponsA[0]?.status], ['FREE_DELIVERY', 'WELCOME', 'AVAILABLE']);

    // Double attribution (meme point d'entree que les flux auth) -> pas de doublon.
    const { grantWelcomeCoupon } = await import('../src/lib/coupons');
    await grantWelcomeCoupon(a.id);
    await grantWelcomeCoupon(a.id);
    const couponsA2 = await prisma.coupon.count({ where: { user_id: a.id } });
    eq('A: double attribution -> toujours 1 coupon', couponsA2, 1);

    // Coupon d'un AUTRE user -> 404 (jamais de fuite).
    const b = await newVerifiedUser('b');
    const couponB = await prisma.coupon.findFirstOrThrow({ where: { user_id: b.id } });
    const foreignSeen = await api(`/coupons/${couponB.id}/seen`, { method: 'POST', token: a.token });
    eq('A: seen coupon etranger -> 404', foreignSeen.status, 404);
    eq('A: code COUPON_NOT_FOUND', foreignSeen.json?.error?.code, 'COUPON_NOT_FOUND');

    // seen idempotent.
    const seen1 = await api(`/coupons/${couponsA[0].id}/seen`, { method: 'POST', token: a.token });
    eq('A: seen -> 200 + seen_at', seen1.status, 200);
    check('A: seen_at renseigne', Boolean(seen1.json?.seen_at));
    const firstSeenAt = seen1.json?.seen_at;
    const seen2 = await api(`/coupons/${couponsA[0].id}/seen`, { method: 'POST', token: a.token });
    eq('A: seen idempotent (meme date)', seen2.json?.seen_at, firstSeenAt);

    const listA = await api('/coupons/me', { token: a.token });
    eq('A: GET /coupons/me -> 200 (1)', [listA.status, Array.isArray(listA.json) ? listA.json.length : -1], [200, 1]);

    const addressA = await addAddress(a.id);

    // --- 2. Commande SANS coupon : inchangee. ---
    const plain = await api('/orders', { method: 'POST', token: a.token, body: orderBody(addressA.id) });
    eq('A: commande sans coupon -> 201', plain.status, 201);
    eq('A: frais normaux', plain.json?.delivery_fee, 2);
    eq('A: remise 0', plain.json?.delivery_discount, 0);
    eq('A: coupon_id null', plain.json?.coupon_id, null);
    eq('A: total = 10 + frais', plain.json?.total_price, 12);

    // --- 3. Commande AVEC coupon : frais 0, remise, USED, total. ---
    const withCoupon = await api('/orders', { method: 'POST', token: a.token, body: orderBody(addressA.id, true) });
    eq('A: commande + coupon -> 201', withCoupon.status, 201);
    eq('A: delivery_fee 0', withCoupon.json?.delivery_fee, 0);
    eq('A: delivery_discount = frais offert', withCoupon.json?.delivery_discount, 2);
    eq('A: coupon_id renseigne', withCoupon.json?.coupon_id, couponsA[0].id);
    eq('A: total = articles seuls', withCoupon.json?.total_price, 10);
    const usedCoupon = await prisma.coupon.findUnique({ where: { id: couponsA[0].id } });
    eq('A: coupon USED + order_id', [usedCoupon?.status, usedCoupon?.order_id], ['USED', withCoupon.json?.id]);
    check('A: used_at renseigne', Boolean(usedCoupon?.used_at));

    // --- 4. 2e utilisation -> COUPON_ALREADY_USED. ---
    const secondUse = await api('/orders', { method: 'POST', token: a.token, body: orderBody(addressA.id, true) });
    eq('A: 2e utilisation -> 400', secondUse.status, 400);
    eq('A: code COUPON_ALREADY_USED', secondUse.json?.error?.code, 'COUPON_ALREADY_USED');

    // --- 5. Concurrence : 2 commandes simultanees, une seule gagne. ---
    const addressB = await addAddress(b.id);
    const [c1, c2] = await Promise.all([
      api('/orders', { method: 'POST', token: b.token, body: orderBody(addressB.id, true) }),
      api('/orders', { method: 'POST', token: b.token, body: orderBody(addressB.id, true) }),
    ]);
    const statuses = [c1.status, c2.status].sort();
    eq('B: concurrence -> 201 + 400', statuses, [201, 400]);
    const loser = c1.status === 400 ? c1 : c2;
    eq('B: code du perdant', loser.json?.error?.code, 'COUPON_ALREADY_USED');
    const couponsB = await prisma.coupon.findMany({ where: { user_id: b.id } });
    eq('B: un seul coupon utilise', couponsB.filter((c) => c.status === 'USED').length, 1);
    const ordersWithB = await prisma.order.count({ where: { user_id: b.id, coupon_id: { not: null } } });
    eq('B: une seule commande liee au coupon', ordersWithB, 1);

    // --- 6. Annulation avant pickup -> restaure, reutilisable. ---
    const c = await newVerifiedUser('c');
    const addressC = await addAddress(c.id);
    const couponC = await prisma.coupon.findFirstOrThrow({ where: { user_id: c.id } });
    const orderC = await api('/orders', { method: 'POST', token: c.token, body: orderBody(addressC.id, true) });
    eq('C: commande + coupon -> 201', orderC.status, 201);
    const cancelled = await api(`/orders/${orderC.json.id}/cancel`, { method: 'PUT', token: c.token });
    eq('C: annulation avant pickup -> 200', cancelled.status, 200);
    const restored = await prisma.coupon.findUnique({ where: { id: couponC.id } });
    eq('C: coupon restaure AVAILABLE', restored?.status, 'AVAILABLE');
    eq('C: used_at/order_id vides', [restored?.used_at, restored?.order_id], [null, null]);
    const freshOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderC.json.id } });
    eq('C: commande detachee du coupon', freshOrder.coupon_id, null);
    const reuse = await api('/orders', { method: 'POST', token: c.token, body: orderBody(addressC.id, true) });
    eq('C: coupon reutilisable -> 201', reuse.status, 201);
    eq('C: remise a nouveau appliquee', reuse.json?.delivery_discount, 2);

    // --- 7. Push bienvenue : differe sans jeton puis une seule fois. ---
    const e = await newVerifiedUser('e'); // aucun jeton au moment de la verification
    // La notification in-app part en tache de fond (jamais bloquante pour
    // l'auth) : petite attente avant de verifier.
    let notifs: { id: string }[] = [];
    for (let i = 0; i < 20; i += 1) {
      notifs = await prisma.notification.findMany({ where: { user_id: e.id, type: 'welcome_coupon' } });
      if (notifs.length > 0) break;
      await sleep(100);
    }
    eq('E: entree in-app welcome_coupon', notifs.length, 1);
    eq('E: push pas encore envoye (differe)', (await prisma.coupon.findFirstOrThrow({ where: { user_id: e.id } })).welcome_notified_at, null);
    const before = pushRequests;
    const tok = await api('/devices/push-token', {
      method: 'POST',
      token: e.token,
      body: { push_token: 'ExponentPushToken[e2e-mock-aeb]', locale: 'aeb' },
    });
    eq('E: enregistrement jeton -> 200', tok.status, 200);
    let notifiedAt: Date | null = null;
    for (let i = 0; i < 20 && !notifiedAt; i += 1) {
      await sleep(100);
      notifiedAt = (await prisma.coupon.findFirstOrThrow({ where: { user_id: e.id } })).welcome_notified_at;
    }
    check('E: welcome_notified_at pose apres envoi', Boolean(notifiedAt));
    eq('E: un push envoye', pushRequests - before, 1);
    check('E: push localise aeb (arabe)', lastPushBody.includes('هابيشو'));
    const afterFirst = pushRequests;
    await api('/devices/push-token', {
      method: 'POST',
      token: e.token,
      body: { push_token: 'ExponentPushToken[e2e-mock-aeb]', locale: 'aeb' },
    });
    await sleep(400);
    eq('E: pas de 2e push au re-enregistrement', pushRequests - afterFirst, 0);
    const inApp = await prisma.notification.count({ where: { user_id: e.id, type: 'welcome_coupon' } });
    eq('E: une seule entree in-app', inApp, 1);

    // --- 8. Utilisateur existant (deja verifie) -> aucun coupon. ---
    const existingEmail = `${PREFIX}-existing@habichou.test`;
    createdEmails.push(existingEmail);
    const existing = await prisma.user.create({
      data: {
        email: existingEmail,
        password_hash: await bcrypt.hash('MotDePasse123!', 10),
        full_name: 'E2E existing',
        email_verified_at: new Date(),
      },
    });
    userIds.push(existing.id);
    const login = await api('/auth/login', { method: 'POST', body: { email: existingEmail, password: 'MotDePasse123!' } });
    eq('existant: login -> 200', login.status, 200);
    eq('existant: aucun coupon (pas de backfill)', await prisma.coupon.count({ where: { user_id: existing.id } }), 0);
    // Flag envoye sans coupon : refus explicite, commande non creee.
    const existingAddress = await addAddress(existing.id);
    const noCoupon = await api('/orders', {
      method: 'POST',
      token: login.json?.access_token,
      body: orderBody(existingAddress.id, true),
    });
    eq('existant: flag sans coupon -> 400', noCoupon.status, 400);
    eq('existant: code COUPON_NOT_FOUND', noCoupon.json?.error?.code, 'COUPON_NOT_FOUND');
  }

  server.close();

  // --- Nettoyage complet des donnees de test. ---
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  const ids = [...new Set([...users.map((u) => u.id), ...userIds])];
  if (ids.length) {
    await prisma.order.deleteMany({ where: { user_id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.product.deleteMany({ where: { id: product.id } });
  await prisma.restaurant.deleteMany({ where: { id: restaurant.id } });

  const leftovers =
    (await prisma.user.count({ where: { email: { startsWith: PREFIX } } })) +
    (await prisma.order.count({ where: { restaurant_id: restaurant.id } })) +
    (await prisma.product.count({ where: { id: product.id } })) +
    (await prisma.restaurant.count({ where: { id: restaurant.id } }));
  check('nettoyage: aucune donnee de test restante', leftovers === 0, leftovers);

  await prisma.$disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK${failed.length ? ` — ${failed.length} ECHEC(S)` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('E2E fatal:', err);
  process.exitCode = 1;
  try {
    const { prisma } = await import('../src/lib/prisma');
    const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await prisma.order.deleteMany({ where: { user_id: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    // Commerce/produit crees avant un echec : meme prefixe.
    const shops = await prisma.restaurant.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const shopIds = shops.map((s) => s.id);
    if (shopIds.length) {
      await prisma.product.deleteMany({ where: { restaurant_id: { in: shopIds } } });
      await prisma.restaurant.deleteMany({ where: { id: { in: shopIds } } });
    }
    await prisma.$disconnect();
  } catch {
    // best effort
  }
  process.exit(1);
});
