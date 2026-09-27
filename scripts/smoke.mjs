/* Smoke test end-to-end de l'API Habichou (lancer le serveur avant : npm run dev) */
const BASE = process.env.API_URL ?? 'http://localhost:4000';
let failures = 0;

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function check(label, cond, extra = '') {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label} ${extra}`);
  }
}

async function expect(label, method, path, opts, wantStatus) {
  const r = await api(method, path, opts);
  check(`${label} → ${r.status}`, r.status === wantStatus, JSON.stringify(r.data)?.slice(0, 300));
  return r;
}

const stamp = Date.now();

async function main() {
  console.log('— Health —');
  await expect('GET /health', 'GET', '/health', {}, 200);

  console.log('— Auth —');
  const loginClient = await expect('login client', 'POST', '/auth/login', { body: { email: 'client@habichou.ma', password: 'Habichou2026!' } }, 200);
  const client = loginClient.data?.access_token;
  check('access_token client', Boolean(client));

  const loginAdmin = await expect('login admin', 'POST', '/auth/login', { body: { email: 'admin@habichou.ma', password: 'Habichou2026!' } }, 200);
  const admin = loginAdmin.data?.access_token;
  check('access_token admin', Boolean(admin));

  // Le compte livreur (s'il existe encore en base) ne doit plus pouvoir se connecter.
  const loginLivreur = await api('POST', '/auth/login', { body: { email: 'livreur@habichou.ma', password: 'Habichou2026!' } });
  check(
    'login livreur bloqué (403 ROLE_DISABLED ou 401)',
    loginLivreur.status === 403 || loginLivreur.status === 401,
    `got ${loginLivreur.status} ${JSON.stringify(loginLivreur.data)?.slice(0, 200)}`,
  );
  if (loginLivreur.status === 403) {
    check('code ROLE_DISABLED', loginLivreur.data?.error?.code === 'ROLE_DISABLED', JSON.stringify(loginLivreur.data));
  }

  await expect('register role=livreur → 400', 'POST', '/auth/register', {
    body: { email: `livreur-${stamp}@habichou.ma`, password: 'xxxxxxxx', full_name: 'Ex Livreur', role: 'livreur' },
  }, 400);
  await expect('register role=client ok', 'POST', '/auth/register', {
    body: { email: `smoke-${stamp}@habichou.ma`, password: 'xxxxxxxx', full_name: 'Smoke User', role: 'client' },
  }, 201);

  const refresh = await expect('refresh', 'POST', '/auth/refresh', { body: { refresh_token: loginClient.data.refresh_token } }, 200);
  const clientToken = refresh.data?.access_token ?? client;

  await expect('GET /auth/me', 'GET', '/auth/me', { token: clientToken }, 200);
  await expect('register dup email → 409', 'POST', '/auth/register', { body: { email: 'client@habichou.ma', password: 'xxxxxxxx', full_name: 'Dup' } }, 409);

  console.log('— Routes livreur désactivées (404) —');
  await expect('GET /admin/livreurs → 404', 'GET', '/admin/livreurs', { token: admin }, 404);
  await expect('PUT /admin/livreurs/:id → 404', 'PUT', `/admin/livreurs/${stamp}`, { token: admin, body: { is_online: false } }, 404);
  await expect('GET /admin/livreurs/map → 404', 'GET', '/admin/livreurs/map', { token: admin }, 404);
  await expect('PUT /admin/orders/:id/assign → 404', 'PUT', `/admin/orders/${stamp}/assign`, { token: admin, body: { auto: true } }, 404);
  await expect('GET /livreur/profile → 404', 'GET', '/livreur/profile', { token: admin }, 404);
  await expect('PUT /livreur/online → 404', 'PUT', '/livreur/online', { token: admin, body: { is_online: true } }, 404);
  await expect('GET /livreur/orders/assigned → 404', 'GET', '/livreur/orders/assigned', { token: admin }, 404);
  await expect('PUT /livreur/location → 404', 'PUT', '/livreur/location', { token: admin, body: { lat: 33.57, lng: -7.59 } }, 404);
  await expect('GET /livreur/stats → 404', 'GET', '/livreur/stats', { token: admin }, 404);

  console.log('— Demande spécifique (custom requests) —');
  await expect('POST /custom-requests sans adresse → 400', 'POST', '/custom-requests', {
    token: clientToken,
    body: { description_text: 'Livrez-moi un bouquet de fleurs' },
  }, 400);
  const crCreate = await expect('POST /custom-requests', 'POST', '/custom-requests', {
    token: clientToken,
    body: { description_text: 'Livrez-moi un bouquet de fleurs et un paquet de chocolats', address_id: 'seed-address-1', estimated_budget: 120 },
  }, 201);
  const crId = crCreate.data?.id;
  check('demande creee', Boolean(crId), JSON.stringify(crCreate.data)?.slice(0, 200));
  await expect('GET /custom-requests/me', 'GET', '/custom-requests/me', { token: clientToken }, 200);
  await expect('GET /custom-requests/:id', 'GET', `/custom-requests/${crId}`, { token: clientToken }, 200);
  const crList = await expect('GET /admin/custom-requests', 'GET', '/admin/custom-requests', { token: admin }, 200);
  check('demande visible par admin', crList.data?.some((c) => c.id === crId), `got ${crList.data?.length}`);
  await expect('commande avant devis → 400', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: 'seed-address-1', payment_method: 'cash', custom_request_id: crId },
  }, 400);
  await expect('PUT devis (quote)', 'PUT', `/admin/custom-requests/${crId}/quote`, { token: admin, body: { admin_quote_price: 100 } }, 200);
  await expect('commande avant acceptation → 400', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: 'seed-address-1', payment_method: 'cash', custom_request_id: crId },
  }, 400);
  await expect('client accepte le devis', 'POST', `/custom-requests/${crId}/accept`, { token: clientToken }, 200);
  const crOrder = await expect('POST /orders (devis accepte)', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: 'seed-address-1', payment_method: 'cash', custom_request_id: crId },
  }, 201);
  check('total = devis + frais (115)', crOrder.data?.total_price === 115, `got ${crOrder.data?.total_price}`);
  await expect('deja commandee → 409', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: 'seed-address-1', payment_method: 'cash', custom_request_id: crId },
  }, 409);

  console.log('— Public —');
  const restos = await expect('GET /restaurants (geo)', 'GET', '/restaurants?lat=33.5731&lng=-7.5898', {}, 200);
  check('5 commerces seeded', Array.isArray(restos.data) && restos.data.length >= 5, `got ${restos.data?.length}`);
  check('distance_km presente', restos.data?.[0]?.distance_km !== undefined);

  const resto = await expect('GET /restaurants/:id', 'GET', '/restaurants/seed-resto-1', {}, 200);
  check('menu non vide', resto.data?.products?.length >= 4);
  const burgerMenu = await expect('GET /restaurants/Burger Time', 'GET', '/restaurants/seed-resto-2', {}, 200);
  const classic = burgerMenu.data.products.find((p) => p.name === 'Classic Burger');
  const frites = burgerMenu.data.products.find((p) => p.name === 'Frites Maison');
  check('Classic Burger a des options', Boolean(classic?.options));

  console.log('— Catalogue : Repas / Épicerie / Pharmacie —');
  const dishTypes = await expect('GET /dish-types', 'GET', '/dish-types', {}, 200);
  check('types de plat seeded (>=4)', Array.isArray(dishTypes.data) && dishTypes.data.length >= 4, JSON.stringify(dishTypes.data));
  check('type "Pizza" present', dishTypes.data?.some((d) => d.dish_type === 'Pizza'), JSON.stringify(dishTypes.data));

  const pizzas = await expect('GET /products?dish_type=Pizza', 'GET', '/products?dish_type=Pizza', {}, 200);
  check(
    'Pizza proposee par >=2 commerces',
    Array.isArray(pizzas.data) && pizzas.data.length >= 2 && pizzas.data.every((p) => Boolean(p.restaurant)),
    `got ${pizzas.data?.length}`,
  );

  const groceries = await expect('GET /products?flow=epicerie', 'GET', '/products?flow=epicerie', {}, 200);
  check(
    'epicerie : pain, tomates, oignons',
    ['Pain Integral', 'Tomates 1kg', 'Oignons 1kg'].every((n) => groceries.data?.some((p) => p.name === n)),
    JSON.stringify(groceries.data?.map((p) => p.name)),
  );

  const medCats = await expect('GET /medication-categories', 'GET', '/medication-categories', {}, 200);
  check('4 categories de medicaments', medCats.data?.length === 4, `got ${medCats.data?.length}`);
  const douleur = await expect('GET /products?medication_category_id=seed-medcat-1', 'GET', '/products?medication_category_id=seed-medcat-1', {}, 200);
  check(
    'Douleur & fievre : 2 medicaments',
    douleur.data?.length === 2 && douleur.data.every((p) => p.medication_category_id === 'seed-medcat-1'),
    JSON.stringify(douleur.data?.map((p) => p.name)),
  );

  const pizzaReine = pizzas.data?.find((p) => p.name === 'Pizza Reine');
  check('Pizza Reine trouvee', Boolean(pizzaReine));
  const pizzaDetail = await expect('GET /products/:id (catalogue)', 'GET', `/products/${pizzaReine?.id}`, {}, 200);
  check(
    'ingredients informatifs presents',
    Array.isArray(pizzaDetail.data?.ingredients) && pizzaDetail.data.ingredients.length >= 4,
    JSON.stringify(pizzaDetail.data?.ingredients)?.slice(0, 240),
  );
  check(
    'supplements presents',
    Array.isArray(pizzaDetail.data?.supplements) && pizzaDetail.data.supplements.length >= 2,
    JSON.stringify(pizzaDetail.data?.supplements)?.slice(0, 240),
  );
  const olives = pizzaDetail.data?.supplements?.find((o) => o.name === 'Olives');
  check('supplement Olives = 3', olives?.extra_price === 3, JSON.stringify(olives));

  console.log('— Adresses —');
  const addresses = await expect('GET /addresses', 'GET', '/addresses', { token: clientToken }, 200);
  const addressId = addresses.data?.[0]?.id;
  check('adresse seed presente', Boolean(addressId));
  const newAddr = await expect('POST /addresses', 'POST', '/addresses', {
    token: clientToken,
    body: { label: `Adresse test ${stamp}`, latitude: 33.58, longitude: -7.61, address_text: '99 Rue Test, Casablanca' },
  }, 201);
  await expect('DELETE address', 'DELETE', `/addresses/${newAddr.data.id}`, { token: clientToken }, 204);

  console.log('— Commande restaurant (avec supplément) —');
  await expect('POST /orders sans items → 400', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: addressId, payment_method: 'cash' },
  }, 400);

  const order = await expect('POST /orders', 'POST', '/orders', {
    token: clientToken,
    body: {
      address_id: addressId,
      payment_method: 'cash',
      items: [
        { product_id: classic.id, quantity: 2, options: [{ group: 'Suppléments', name: 'Bacon', price: 999 }] },
        { product_id: frites.id, quantity: 1 },
      ],
    },
  }, 201);
  const orderId = order.data?.id;
  if (!orderId) {
    console.log('❌ abort : commande non creee');
    process.exit(1);
  }
  // 2 × (45 + 8 bacon) + 20 frites + 15 frais = 141
  check('total avec supplement catalog (141)', order.data?.total_price === 141, `got ${order.data?.total_price}`);
  check('unit_price item = 53', order.data?.items?.[0]?.unit_price === 53, `got ${order.data?.items?.[0]?.unit_price}`);
  check('pas de livreur avant confirmation', order.data?.livreur == null, JSON.stringify(order.data?.livreur)?.slice(0, 120));

  if (pizzaReine) {
    const ingOrder = await expect('POST /orders (suppléments ingrédients)', 'POST', '/orders', {
      token: clientToken,
      body: {
        address_id: addressId,
        payment_method: 'cash',
        items: [{ product_id: pizzaReine.id, quantity: 2, options: [{ name: 'Olives', price: 999 }, { name: 'Fromage râpé', price: 5 }] }],
      },
    }, 201);
    // prix client ignoré : suppléments pris dans le catalogue serveur (Olives 3 + Fromage 5)
    check('unit_price avec ingrédients (58)', ingOrder.data?.items?.[0]?.unit_price === 58, `got ${ingOrder.data?.items?.[0]?.unit_price}`);
    check('total avec ingrédients (131)', ingOrder.data?.total_price === 131, `got ${ingOrder.data?.total_price}`);
  }
  await expect('GET /orders/me', 'GET', '/orders/me', { token: clientToken }, 200);
  await expect('GET /orders/:id', 'GET', `/orders/${orderId}`, { token: clientToken }, 200);
  await expect('GET /admin/orders/:id (admin)', 'GET', `/admin/orders/${orderId}`, { token: admin }, 200);

  console.log('— Pay —');
  await expect('pay sur commande cash → 400', 'POST', `/orders/${orderId}/pay`, { token: clientToken }, 400);
  const cardOrder = await expect('POST /orders (card)', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: addressId, payment_method: 'card', items: [{ product_id: frites.id, quantity: 1 }] },
  }, 201);
  const pay = await expect('POST pay (simulé)', 'POST', `/orders/${cardOrder.data.id}/pay`, { token: clientToken }, 200);
  check('pay simulé (pas de Stripe)', pay.data?.simulated === true);

  console.log('— Admin : flux complet de bout en bout (admin = livreur unique) —');
  const dash = await expect('GET /admin/dashboard', 'GET', '/admin/dashboard', { token: admin }, 200);
  check('orders_today > 0', dash.data?.orders_today >= 1);
  check('champs desactivés absents', dash.data?.pending_custom_requests === undefined && dash.data?.livreurs_online === undefined, JSON.stringify(dash.data));
  check('active_orders present', typeof dash.data?.active_orders === 'number');
  await expect('admin → client 403', 'GET', '/admin/orders', { token: clientToken }, 403);

  const confirmed = await expect('confirm', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'confirmed' } }, 200);
  check('auto-assign profil Livreur de l admin', confirmed.data?.livreur?.user?.id === loginAdmin.data?.user?.id, JSON.stringify(confirmed.data?.livreur)?.slice(0, 200));

  await expect('preparing', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'preparing' } }, 200);
  await expect('picked_up', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'picked_up' } }, 200);
  await expect('on_the_way', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'on_the_way' } }, 200);
  await expect('delivered', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'delivered' } }, 200);
  await expect('transition invalide (back) → 400', 'PUT', `/admin/orders/${orderId}/status`, { token: admin, body: { status: 'confirmed' } }, 400);

  const delivered = await expect('commande livrée', 'GET', `/orders/${orderId}`, { token: clientToken }, 200);
  check('status=delivered', delivered.data?.status === 'delivered');
  check('payment_status=paid (cash)', delivered.data?.payment_status === 'paid');
  check('livreur visible par le client', delivered.data?.livreur?.user?.id === loginAdmin.data?.user?.id, JSON.stringify(delivered.data?.livreur)?.slice(0, 200));
  await expect('noter', 'POST', `/orders/${orderId}/rate`, { token: clientToken, body: { rating: 5, comment: 'Parfait' } }, 201);
  await expect('deja notée → 409', 'POST', `/orders/${orderId}/rate`, { token: clientToken, body: { rating: 4 } }, 409);

  console.log('— Admin : CRUD commerce + produits —');
  const resto2 = await expect('POST /admin/restaurants', 'POST', '/admin/restaurants', {
    token: admin,
    body: {
      name: `Smoke Snack ${stamp}`,
      category: 'snack',
      address: '1 Rue Smoke',
      latitude: 33.57,
      longitude: -7.59,
      is_open: true,
      opening_hours: { open: '09:00', close: '22:30' },
      logo_url: 'https://example.com/smoke-logo.png',
    },
  }, 201);
  check('opening_hours creee', resto2.data?.opening_hours?.open === '09:00' && resto2.data?.opening_hours?.close === '22:30', JSON.stringify(resto2.data?.opening_hours));
  check('logo_url cree', resto2.data?.logo_url === 'https://example.com/smoke-logo.png', String(resto2.data?.logo_url));

  await expect('PUT opening_hours invalide (25:99) → 400', 'PUT', `/admin/restaurants/${resto2.data.id}`, {
    token: admin,
    body: { opening_hours: { open: '25:99', close: '22:00' } },
  }, 400);
  await expect('PUT opening_hours format invalide → 400', 'PUT', `/admin/restaurants/${resto2.data.id}`, {
    token: admin,
    body: { opening_hours: { open: '9h', close: '22:00' } },
  }, 400);

  const updResto = await expect('PUT horaires valides + efface logo', 'PUT', `/admin/restaurants/${resto2.data.id}`, {
    token: admin,
    body: { opening_hours: { open: '08:30', close: '23:45' }, logo_url: null },
  }, 200);
  check('horaires mis a jour', updResto.data?.opening_hours?.open === '08:30' && updResto.data?.opening_hours?.close === '23:45', JSON.stringify(updResto.data?.opening_hours));
  check('logo_url efface (null)', updResto.data?.logo_url === null, String(updResto.data?.logo_url));

  const prod = await expect('POST product', 'POST', `/admin/restaurants/${resto2.data.id}/products`, {
    token: admin,
    body: { name: 'Panini Smoke', price: 30, category: 'Paninis' },
  }, 201);
  await expect('PUT product options', 'PUT', `/admin/products/${prod.data.id}`, {
    token: admin,
    body: { options: { Suppléments: [{ name: 'Fromage', price: 5 }] } },
  }, 200);
  const prodOpts = await expect('GET product options', 'GET', `/products/${prod.data.id}`, {}, 200);
  check('options persistees', prodOpts.data?.options?.Suppléments?.[0]?.name === 'Fromage' && prodOpts.data?.options?.Suppléments?.[0]?.price === 5, JSON.stringify(prodOpts.data?.options));
  await expect('PUT product options a null', 'PUT', `/admin/products/${prod.data.id}`, { token: admin, body: { options: null } }, 200);
  const prodNoOpts = await expect('GET product options null', 'GET', `/products/${prod.data.id}`, {}, 200);
  check('options effacees (null)', prodNoOpts.data?.options === null, JSON.stringify(prodNoOpts.data?.options));

  const localIngredient = `Ingr local ${stamp}`;
  const localSupplement = `Supp local ${stamp}`;
  await expect('PUT dish_type + ingredients + supplements', 'PUT', `/admin/products/${prod.data.id}`, {
    token: admin,
    body: {
      dish_type: 'Panini',
      ingredients: [
        { name: 'Pain', add_to_catalog: true },
        { name: localIngredient, add_to_catalog: false },
      ],
      supplements: [
        { name: 'Fromage', add_to_catalog: true, default_extra_price: 5 },
        { name: localSupplement, add_to_catalog: false, default_extra_price: 7 },
      ],
    },
  }, 200);
  const prodIng = await expect('GET produit avec catalogue', 'GET', `/products/${prod.data.id}`, {}, 200);
  check(
    'dish_type + ingredients + supplements persists',
    prodIng.data?.dish_type === 'Panini' &&
      prodIng.data?.ingredients?.length === 2 &&
      prodIng.data?.ingredients[0]?.name === 'Pain' &&
      prodIng.data?.supplements?.length === 2 &&
      prodIng.data.supplements[0]?.name === 'Fromage' &&
      prodIng.data.supplements[0]?.extra_price === 5 &&
      prodIng.data.supplements[1]?.name === localSupplement &&
      prodIng.data.supplements[1]?.extra_price === 7,
    JSON.stringify({
      dish_type: prodIng.data?.dish_type,
      ingredients: prodIng.data?.ingredients,
      supplements: prodIng.data?.supplements,
    })?.slice(0, 400),
  );

  console.log('— Admin : catalogues ingrédients / suppléments —');
  const catIngredients = await expect('GET /admin/ingredients', 'GET', '/admin/ingredients', { token: admin }, 200);
  check(
    'Pain au catalogue, ligne locale non',
    catIngredients.data?.some((i) => i.name === 'Pain') && !catIngredients.data?.some((i) => i.name === localIngredient),
    JSON.stringify(catIngredients.data?.map((i) => i.name))?.slice(0, 300),
  );
  const catSupplements = await expect('GET /admin/supplements', 'GET', '/admin/supplements', { token: admin }, 200);
  check(
    'Fromage au catalogue, supplément local non',
    catSupplements.data?.some((s) => s.name === 'Fromage') && !catSupplements.data?.some((s) => s.name === localSupplement),
    JSON.stringify(catSupplements.data?.map((s) => s.name))?.slice(0, 300),
  );
  await expect('POST /admin/supplements sans nom → 400', 'POST', '/admin/supplements', { token: admin, body: {} }, 400);
  const newSup = await expect('POST /admin/supplements', 'POST', '/admin/supplements', {
    token: admin,
    body: { name: `Smoke Sup ${stamp}`, default_extra_price: 4 },
  }, 201);
  check('supplement catalogue cree', newSup.data?.default_extra_price === 4 && newSup.data?.in_catalog === true, JSON.stringify(newSup.data));

  // Réutilisation d'un supplément du catalogue avec surcharge de prix par produit.
  await expect('PUT supplement catalogue avec override', 'PUT', `/admin/products/${prod.data.id}`, {
    token: admin,
    body: { supplements: [{ supplement_id: newSup.data.id, extra_price_override: 2 }] },
  }, 200);
  const overrideDetail = await expect('GET produit (override)', 'GET', `/products/${prod.data.id}`, {}, 200);
  check(
    'override prix = 2 (catalogue = 4)',
    overrideDetail.data?.supplements?.length === 1 &&
      overrideDetail.data.supplements[0]?.extra_price === 2 &&
      overrideDetail.data.supplements[0]?.default_extra_price === 4,
    JSON.stringify(overrideDetail.data?.supplements),
  );
  await expect('medication_category_id inexistant → 400', 'PUT', `/admin/products/${prod.data.id}`, {
    token: admin,
    body: { medication_category_id: 'inconnue' },
  }, 400);

  console.log('— Admin : catégories de médicaments —');
  await expect('POST medication-category sans nom → 400', 'POST', '/admin/medication-categories', { token: admin, body: {} }, 400);
  const medCatNew = await expect('POST medication-category', 'POST', '/admin/medication-categories', {
    token: admin,
    body: { name: `Smoke Cat ${stamp}`, sort_order: 99 },
  }, 201);
  check('categorie creee (is_active)', medCatNew.data?.is_active === true, JSON.stringify(medCatNew.data));
  await expect('PUT medication-category', 'PUT', `/admin/medication-categories/${medCatNew.data.id}`, {
    token: admin,
    body: { is_active: false },
  }, 200);
  await expect('DELETE medication-category vide', 'DELETE', `/admin/medication-categories/${medCatNew.data.id}`, { token: admin }, 204);
  await expect('GET /admin/medication-categories', 'GET', '/admin/medication-categories', { token: admin }, 200);
  const delMedCat = await expect('DELETE categorie liee a des produits → 409', 'DELETE', '/admin/medication-categories/seed-medcat-1', { token: admin }, 409);
  check('code HAS_PRODUCTS', delMedCat.data?.error?.code === 'HAS_PRODUCTS', JSON.stringify(delMedCat.data));
  await expect('client → medication-categories 403', 'GET', '/admin/medication-categories', { token: clientToken }, 403);

  await expect('PUT product dispo', 'PUT', `/admin/products/${prod.data.id}`, { token: admin, body: { is_available: false } }, 200);
  await expect('produit indisponible → 400', 'POST', '/orders', {
    token: clientToken,
    body: { address_id: addressId, payment_method: 'cash', items: [{ product_id: prod.data.id, quantity: 1 }] },
  }, 400);
  await expect('DELETE product jamais commande', 'DELETE', `/admin/products/${prod.data.id}`, { token: admin }, 204);
  await expect('DELETE restaurant sans commandes', 'DELETE', `/admin/restaurants/${resto2.data.id}`, { token: admin }, 204);

  const delOrdered = await expect('DELETE restaurant avec commandes → 409', 'DELETE', '/admin/restaurants/seed-resto-2', { token: admin }, 409);
  check('code HAS_ORDERS', delOrdered.data?.error?.code === 'HAS_ORDERS', JSON.stringify(delOrdered.data));
  const closedResto = await expect('fermeture auto apres 409', 'GET', '/admin/restaurants/seed-resto-2', { token: admin }, 200);
  check('is_open=false apres 409', closedResto.data?.is_open === false, `got ${closedResto.data?.is_open}`);
  await expect('reactiver seed-resto-2', 'PUT', '/admin/restaurants/seed-resto-2', { token: admin, body: { is_open: true } }, 200);
  await expect('DELETE restaurant inexistant → 404', 'DELETE', `/admin/restaurants/${stamp}-nope`, { token: admin }, 404);

  console.log('— Notifications —');
  const notifs = await expect('GET /notifications/me', 'GET', '/notifications/me', { token: clientToken }, 200);
  check('notifications recues', notifs.data?.length >= 3, `got ${notifs.data?.length}`);
  if (notifs.data?.[0]) {
    await expect('mark read', 'PUT', `/notifications/${notifs.data[0].id}/read`, { token: clientToken }, 200);
  }

  console.log('— Push (jeton Expo) —');
  const pushReg = await expect('POST /devices/push-token', 'POST', '/devices/push-token', {
    token: clientToken,
    body: { push_token: `ExponentPushToken[smoke-${stamp}]` },
  }, 200);
  check('jeton enregistre', pushReg.data?.registered === true, JSON.stringify(pushReg.data));
  const pushOff = await expect('POST /devices/push-token (retrait)', 'POST', '/devices/push-token', {
    token: clientToken,
    body: { push_token: null },
  }, 200);
  check('jeton retire', pushOff.data?.registered === false, JSON.stringify(pushOff.data));
  await expect('push-token sans session → 401', 'POST', '/devices/push-token', { body: { push_token: 'x' } }, 401);

  console.log('— Upload Supabase Storage —');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'smoke.png');
  const up = await api('POST', '/uploads?folder=restaurants', { token: clientToken, form });
  check(`upload → ${up.status}`, up.status === 201 && typeof up.data?.url === 'string', JSON.stringify(up.data)?.slice(0, 300));
  if (up.data?.url) {
    const img = await fetch(up.data.url);
    check('URL publique accessible', img.status === 200, `status ${img.status}`);
  }

  console.log(failures === 0 ? '\n✅ SMOKE TEST : tous les checks passent' : `\n❌ SMOKE TEST : ${failures} echec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERREUR FATALE', e);
  process.exit(1);
});
