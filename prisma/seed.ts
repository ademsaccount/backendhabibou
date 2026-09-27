import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

import { syncProductIngredients, syncProductSupplements } from '../src/lib/catalog';

const prisma = new PrismaClient();

type SeedIngredient = { name: string; extra_price?: number; is_default_checked?: boolean };

type SeedProduct = {
  name: string;
  price: number;
  category: string;
  description?: string;
  image_url?: string;
  options?: Record<string, { name: string; price: number }[]>;
  /** Type de plat transverse (filtre "Par type de plat"). */
  dish_type?: string;
  /** Catégorie de médicaments (flux Pharmacie). */
  medication_category_id?: string;
  /** Ingrédients optionnels (écran de personnalisation). */
  ingredients?: SeedIngredient[];
};

type SeedRestaurant = {
  id: string;
  name: string;
  category: 'restaurant' | 'snack' | 'epicerie' | 'pharmacie' | 'tabac';
  description?: string;
  address: string;
  latitude: number;
  longitude: number;
  logo_url?: string;
  cover_url?: string;
  opening_hours?: { open: string; close: string };
  products: SeedProduct[];
};

async function main() {
  console.log('[seed] demarrage...');

  const password = await bcrypt.hash('Habichou2026!', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@habichou.ma' },
    update: {},
    create: {
      email: 'admin@habichou.ma',
      password_hash: password,
      full_name: 'Admin Habichou',
      phone: '+212600000001',
      role: 'admin',
    },
  });

  const client = await prisma.user.upsert({
    where: { email: 'client@habichou.ma' },
    update: {},
    create: {
      email: 'client@habichou.ma',
      password_hash: password,
      full_name: 'Amine Client',
      phone: '+212600000002',
      role: 'client',
    },
  });

  // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
  // const livreurUser = await prisma.user.upsert({
  //   where: { email: 'livreur@habichou.ma' },
  //   update: {},
  //   create: {
  //     email: 'livreur@habichou.ma',
  //     password_hash: password,
  //     full_name: 'Youssef Livreur',
  //     phone: '+212600000003',
  //     role: 'livreur',
  //   },
  // });
  //
  // await prisma.livreur.upsert({
  //   where: { user_id: livreurUser.id },
  //   update: {},
  //   create: { user_id: livreurUser.id, vehicle_type: 'moto', is_online: true, current_lat: 33.5731, current_lng: -7.5898 },
  // });
  // --- FIN DÉSACTIVÉ ---

  const address = await prisma.address.upsert({
    where: { id: 'seed-address-1' },
    update: {},
    create: {
      id: 'seed-address-1',
      user_id: client.id,
      label: 'Maison',
      latitude: 33.5731,
      longitude: -7.5898,
      address_text: '12 Boulevard Zerktouni, Casablanca',
      is_default: true,
    },
  });
  void address;

  // Catégories de médicaments du flux Pharmacie (table configurable côté admin).
  const medicationCategoriesData = [
    { id: 'seed-medcat-1', name: 'Douleur & fièvre', description: 'Paracétamol, antipyrétiques, antalgiques.', icon: 'thermometer-outline', sort_order: 1 },
    { id: 'seed-medcat-2', name: 'Toux, rhume & allergies', description: 'Sirops, sprays nasaux, antihistaminiques.', icon: 'medkit-outline', sort_order: 2 },
    { id: 'seed-medcat-3', name: 'Digestion & transit', description: 'Sachets, comprimés et remèdes digestifs.', icon: 'water-outline', sort_order: 3 },
    { id: 'seed-medcat-4', name: 'Soins & vitamines', description: 'Hygiène, pansements, compléments alimentaires.', icon: 'bandage-outline', sort_order: 4 },
  ];
  for (const c of medicationCategoriesData) {
    await prisma.medicationCategory.upsert({ where: { id: c.id }, update: {}, create: c });
  }

  const restaurantsData: SeedRestaurant[] = [
    {
      id: 'seed-resto-1',
      name: 'Le Petit Chef',
      category: 'restaurant' as const,
      description: 'Cuisine marocaine et francaise, fait maison.',
      address: '45 Rue Ibn Batouta, Casablanca',
      latitude: 33.5898,
      longitude: -7.6114,
      logo_url: 'https://picsum.photos/seed/lepetitchef/200',
      cover_url: 'https://picsum.photos/seed/lepetitchefcover/800/400',
      opening_hours: { open: '11:00', close: '23:00' },
      products: [
        { name: 'Tajine Poulet Citron', price: 55, category: 'Plats', description: 'Poulet, olives, citron confit', image_url: 'https://picsum.photos/seed/tajine/400/300', dish_type: 'Tajine', ingredients: [{ name: 'Olives', is_default_checked: true }, { name: 'Citron confit', is_default_checked: true }, { name: 'Harissa', extra_price: 2 }, { name: 'Amandes grillées', extra_price: 5 }] },
        { name: 'Couscous Poulet', price: 60, category: 'Plats', description: 'Vraie semoule, 7 legumes', image_url: 'https://picsum.photos/seed/couscous/400/300', dish_type: 'Couscous' },
        { name: 'Salade Marocaine', price: 30, category: 'Entrees', description: 'Tomates, concombre, agrumes', image_url: 'https://picsum.photos/seed/salade/400/300' },
        { name: 'Jus d\'Avocat', price: 25, category: 'Boissons', description: 'Avocat frais mixte', image_url: 'https://picsum.photos/seed/jusavocat/400/300' },
        { name: 'Pizza Margherita', price: 48, category: 'Pizzas', description: 'Sauce tomate, mozzarella, basilic', image_url: 'https://picsum.photos/seed/pizzamarg/400/300', dish_type: 'Pizza', ingredients: [{ name: 'Mozzarella', is_default_checked: true }, { name: 'Olives', extra_price: 3, is_default_checked: true }, { name: 'Fromage râpé', extra_price: 5 }, { name: 'Jambon', extra_price: 7 }, { name: 'Sans tomate' }] },
        { name: 'Makloub Végétarien', price: 42, category: 'Plats', description: 'Aubergine, tomate, poivron, fromage', image_url: 'https://picsum.photos/seed/makloubveg/400/300', dish_type: 'Makloub', ingredients: [{ name: 'Fromage', is_default_checked: true }, { name: 'Sauce yaourt', extra_price: 3 }, { name: 'Thon', extra_price: 6 }, { name: 'Sans piment' }] },
        { name: 'Fricassé Poulet', price: 38, category: 'Sandwichs', description: 'Poulet, frites, sauce maison', image_url: 'https://picsum.photos/seed/fricasse/400/300', dish_type: 'Fricassé', ingredients: [{ name: 'Sauce maison', is_default_checked: true }, { name: 'Frites', is_default_checked: true }, { name: 'Oignons', is_default_checked: true }, { name: 'Fromage', extra_price: 5 }, { name: 'Sans oignons' }] },
        { name: 'Sandwich Poulet Grillé', price: 32, category: 'Sandwichs', description: 'Poulet grillé, crudités, sauce blanche', image_url: 'https://picsum.photos/seed/sandwichpoulet/400/300', dish_type: 'Sandwich', ingredients: [{ name: 'Sauce blanche', is_default_checked: true }, { name: 'Crudités', is_default_checked: true }, { name: 'Fromage', extra_price: 5 }, { name: 'Cornichons', extra_price: 2 }] },
      ],
    },
    {
      id: 'seed-resto-2',
      name: 'Burger Time',
      category: 'snack' as const,
      description: 'Burgers gourmands et frites maison.',
      address: '8 Avenue Hassan II, Casablanca',
      latitude: 33.595,
      longitude: -7.605,
      logo_url: 'https://picsum.photos/seed/burger/200',
      cover_url: 'https://picsum.photos/seed/burgercover/800/400',
      products: [
        { name: 'Classic Burger', price: 45, category: 'Burgers', description: 'Steak 150g, cheddar, sauce maison', image_url: 'https://picsum.photos/seed/classicburger/400/300', dish_type: 'Burger', options: { suppléments: [{ name: 'Bacon', price: 8 }, { name: 'Fromage extra', price: 5 }] } },
        { name: 'Double Cheese', price: 60, category: 'Burgers', description: 'Double steak, double cheddar', image_url: 'https://picsum.photos/seed/double/400/300', dish_type: 'Burger', ingredients: [{ name: 'Cheddar', is_default_checked: true }, { name: 'Sauce barbecue', extra_price: 3 }, { name: 'Oignons croustillants', extra_price: 2 }] },
        { name: 'Frites Maison', price: 20, category: 'Accompagnements', description: 'Portion 150g', image_url: 'https://picsum.photos/seed/frites/400/300' },
        { name: 'Milkshake Chocolat', price: 28, category: 'Boissons', description: 'Glace vanille, chocolat belge', image_url: 'https://picsum.photos/seed/shake/400/300' },
        { name: 'Pizza Reine', price: 50, category: 'Pizzas', description: 'Sauce tomate, mozzarella, jambon, champignons', image_url: 'https://picsum.photos/seed/pizzareine/400/300', dish_type: 'Pizza', ingredients: [{ name: 'Mozzarella', is_default_checked: true }, { name: 'Jambon', is_default_checked: true }, { name: 'Champignons', is_default_checked: true }, { name: 'Olives', extra_price: 3 }, { name: 'Fromage râpé', extra_price: 5 }, { name: 'Sans champignons' }] },
        { name: 'Makloub Thon', price: 40, category: 'Sandwichs', description: 'Thon, tomate, œuf, fromage', image_url: 'https://picsum.photos/seed/makloubthon/400/300', dish_type: 'Makloub', ingredients: [{ name: 'Thon', is_default_checked: true }, { name: 'Œuf', is_default_checked: true }, { name: 'Fromage', is_default_checked: true }, { name: 'Sauce harissa', extra_price: 2 }, { name: 'Olives', extra_price: 3 }] },
        { name: 'Escalope Panée', price: 45, category: 'Plats', description: 'Escalope de poulet panée, salade', image_url: 'https://picsum.photos/seed/escalope/400/300', dish_type: 'Escalope plate', ingredients: [{ name: 'Salade', is_default_checked: true }, { name: 'Sauce fromagère', extra_price: 4 }, { name: 'Frites', extra_price: 8 }] },
        { name: 'Sandwich Thon', price: 28, category: 'Sandwichs', description: 'Thon, tomate, œuf, mayonnaise', image_url: 'https://picsum.photos/seed/sandwichthon/400/300', dish_type: 'Sandwich', ingredients: [{ name: 'Mayonnaise', is_default_checked: true }, { name: 'Tomate', is_default_checked: true }, { name: 'Fromage', extra_price: 5 }, { name: 'Cornichons', extra_price: 2 }] },
      ],
    },
    {
      id: 'seed-resto-3',
      name: 'Marché Frais',
      category: 'epicerie' as const,
      description: 'Fruits, legumes et produits du quotidien.',
      address: '120 Route de Rabat, Casablanca',
      latitude: 33.565,
      longitude: -7.64,
      logo_url: 'https://picsum.photos/seed/marche/200',
      cover_url: 'https://picsum.photos/seed/marchecover/800/400',
      products: [
        { name: 'Pain Integral', price: 6, category: 'Boulangerie', image_url: 'https://picsum.photos/seed/pain/400/300' },
        { name: 'Tomates 1kg', price: 8, category: 'Legumes', image_url: 'https://picsum.photos/seed/tomates/400/300' },
        { name: 'Oignons 1kg', price: 7, category: 'Legumes', image_url: 'https://picsum.photos/seed/oignons/400/300' },
        { name: 'Bananes 1kg', price: 14, category: 'Fruits', image_url: 'https://picsum.photos/seed/bananes/400/300' },
        { name: 'Oeufs x10', price: 18, category: 'Frais', image_url: 'https://picsum.photos/seed/oeufs/400/300' },
        { name: 'Eau 1.5L x6', price: 24, category: 'Boissons', image_url: 'https://picsum.photos/seed/eau/400/300' },
      ],
    },
    {
      id: 'seed-resto-4',
      name: 'PharmaPlus',
      category: 'pharmacie' as const,
      description: 'Medicaments sans ordonnance, hygiene et bebe.',
      address: '3 Boulevard de Paris, Casablanca',
      latitude: 33.578,
      longitude: -7.601,
      logo_url: 'https://picsum.photos/seed/pharma/200',
      cover_url: 'https://picsum.photos/seed/pharmacover/800/400',
      products: [
        { name: 'Paracetamol 500mg', price: 12, category: 'Douleur', description: 'Boite de 20 comprimes', image_url: 'https://picsum.photos/seed/para/400/300', medication_category_id: 'seed-medcat-1' },
        { name: 'Ibuprofène 400mg', price: 18, category: 'Douleur', description: 'Boite de 20 comprimes', image_url: 'https://picsum.photos/seed/ibupro/400/300', medication_category_id: 'seed-medcat-1' },
        { name: 'Sirop Toux Sèche 125ml', price: 28, category: 'Toux & rhume', description: 'Adultes et enfants dès 6 ans', image_url: 'https://picsum.photos/seed/sirop/400/300', medication_category_id: 'seed-medcat-2' },
        { name: 'Spray Nasal 15ml', price: 24, category: 'Toux & rhume', description: 'Désencombrement nasal', image_url: 'https://picsum.photos/seed/spray/400/300', medication_category_id: 'seed-medcat-2' },
        { name: 'Smecta Sachets x12', price: 22, category: 'Digestion', description: 'Diarrhée aiguë', image_url: 'https://picsum.photos/seed/smecta/400/300', medication_category_id: 'seed-medcat-3' },
        { name: 'Gel Hydroalcoolique', price: 15, category: 'Hygiene', description: '500ml', image_url: 'https://picsum.photos/seed/gel/400/300', medication_category_id: 'seed-medcat-4' },
        { name: 'Vitamine C', price: 35, category: 'Complements', description: 'Flacon 30 gelsules', image_url: 'https://picsum.photos/seed/vitc/400/300', medication_category_id: 'seed-medcat-4' },
        { name: 'Pansements Assortis', price: 12, category: 'Soins', description: 'Boite de 20 pieces', image_url: 'https://picsum.photos/seed/pansements/400/300', medication_category_id: 'seed-medcat-4' },
      ],
    },
    {
      id: 'seed-resto-5',
      name: 'Tabac Presse Centre',
      category: 'tabac' as const,
      description: 'Presse, allumettes, briquets et articles fumeurs.',
      address: '1 Place Mohammed V, Casablanca',
      latitude: 33.5992,
      longitude: -7.6136,
      logo_url: 'https://picsum.photos/seed/tabac/200',
      cover_url: 'https://picsum.photos/seed/tabaccover/800/400',
      products: [
        { name: 'Journal du Jour', price: 5, category: 'Presse', image_url: 'https://picsum.photos/seed/journal/400/300' },
        { name: 'Briquet', price: 10, category: 'Accessoires', image_url: 'https://picsum.photos/seed/briquet/400/300' },
      ],
    },
  ];

  for (const r of restaurantsData) {
    const { products, ...rest } = r;
    const restaurant = await prisma.restaurant.upsert({
      where: { id: r.id },
      update: {},
      create: { ...rest, created_by_admin_id: admin.id },
    });
    for (const p of products) {
      const { dish_type, medication_category_id, ingredients, ...data } = p;
      const existing = await prisma.product.findFirst({ where: { restaurant_id: restaurant.id, name: p.name } });

      let productId: string;
      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...(dish_type !== undefined ? { dish_type } : {}),
            ...(medication_category_id !== undefined ? { medication_category_id } : {}),
          },
        });
        productId = existing.id;
      } else {
        const created = await prisma.product.create({
          data: {
            ...data,
            restaurant_id: restaurant.id,
            options: (p.options ?? undefined) as never,
            dish_type: dish_type ?? null,
            medication_category_id: medication_category_id ?? null,
          },
        });
        productId = created.id;
      }

      if (ingredients) {
        // Même règle que la migration : prix > 0 -> supplément (catalogue réutilisable),
        // sinon -> ingrédient informatif.
        const ingredientRows = ingredients
          .filter((i) => (i.extra_price ?? 0) <= 0)
          .map((i, index) => ({ name: i.name, add_to_catalog: true, sort_order: index }));
        const supplementRows = ingredients
          .filter((i) => (i.extra_price ?? 0) > 0)
          .map((i, index) => ({
            name: i.name,
            default_extra_price: i.extra_price ?? 0,
            add_to_catalog: true,
            sort_order: index,
          }));

        await syncProductIngredients(prisma, productId, ingredientRows, admin.id);
        await syncProductSupplements(prisma, productId, supplementRows, admin.id);
      }
    }
  }

  // Demande spécifique de démonstration (flux "Demande spécifique" côté client).
  const demo = await prisma.customRequest.upsert({
    where: { id: 'seed-cr-1' },
    update: {},
    create: {
      id: 'seed-cr-1',
      user_id: client.id,
      description_text: 'Je veux que tu me livres un bouquet de fleurs et un paquet de chocolats depuis le centre-ville.',
      estimated_budget: 150,
      address_id: 'seed-address-1',
      status: 'pending',
    },
  });
  void demo;

  console.log('[seed] termine.');
  console.log('[seed] comptes (mot de passe : Habichou2026!)');
  console.log('  admin    → admin@habichou.ma');
  console.log('  client   → client@habichou.ma');
  // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
  // console.log('  livreur  → livreur@habichou.ma');
  // --- FIN DÉSACTIVÉ ---
}

main()
  .catch((e) => {
    console.error('[seed] erreur:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
