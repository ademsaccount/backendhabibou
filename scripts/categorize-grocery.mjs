/* Catégorisation automatique des produits d'épicerie (chips de l'app client).
 *
 * Règles par mots-clés sur le nom du produit. Dry-run par défaut (tableau
 * sans écriture) ; --apply pour écrire en base. Seuls les produits des
 * commerces « epicerie » sont touchés, et seulement ceux dont la catégorie
 * est vide ou « Divers » — on n'écrase jamais une catégorie choisie.
 *
 * Usage :
 *   node scripts/categorize-grocery.mjs           # aperçu
 *   node scripts/categorize-grocery.mjs --apply   # écriture
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

/* Règles : [regex insensible casse/accents, catégorie cible]. La première
 * correspondance gagne — ordre du plus spécifique au plus général. */
const RULES = [
  [/sauce|harissa|afritada|aftitada|mayonnaise|ketchup|moutarde|vinaig/i, 'Sauces'],
  [/yaourt|yougourt|yogurt|danone|iogurt/i, 'Yougourts'],
  [/p[aâ]tes|pasta|spaghetti|macaroni|francine|barilla|bolognaise|bolognese/i, 'Pastas'],
  [/thon|tuna|sardine|maquereau|conserve|lbi ?s|libby/i, 'Conserves'],
  [/lait|milk|fromage|cheese|beurre|butter|cr[èe]me|yaour/i, 'Frais'],
  [/caf[ée]|nescaf[ée]|th[ée] |th[ée]$|infusion|chocolat|cacao|sucre/i, 'Petit-déjeuner'],
  [/jus|eau|minérale|minerale|soda|coca|sirop|boisson/i, 'Boissons'],
  [/pain|baguette|croissant|brioche|galette/i, 'Boulangerie'],
  [/riz|farine|semoule|huile|olive|sel|concentr[ée]|tomate|oignon|ail|l[ée]gume|salade|pomme de terre|carotte/i, 'Épicerie'],
  [/fruit|banane|pomme|orange|past[èe]que|melon|raisin/i, 'Fruits'],
  [/savon|shampoing|dentifrice|papier|mouchoir|lessive|nettoyant|éponge|eponge/i, 'Entretien'],
  [/biscuit|g[âa]teau|gateau|chips|snack|chocolatine|cake/i, 'Snacks'],
];

/** Catégorie déduite du nom, ou null si aucune règle ne colle. */
function matchCategory(name) {
  for (const [re, category] of RULES) {
    if (re.test(name)) return category;
  }
  return null;
}

const products = await prisma.product.findMany({
  where: { restaurant: { category: 'epicerie' }, OR: [{ category: 'Divers' }, { category: '' }] },
  select: { id: true, name: true, category: true },
  orderBy: { name: 'asc' },
});

console.log(`Produits épicerie à catégoriser : ${products.length}`);
if (products.length === 0) {
  console.log('Rien à faire — toutes les catégories sont déjà renseignées.');
} else {
  const updates = [];
  for (const p of products) {
    const category = matchCategory(p.name);
    console.log(`  [${category ?? '— aucune règle —'}] ${p.name} (actuel: ${p.category || 'vide'})`);
    if (category) updates.push({ id: p.id, category });
  }

  if (!APPLY) {
    console.log(`\nDry-run : ${updates.length} mise(s) à jour prévue(s). Relancez avec --apply pour écrire.`);
  } else {
    for (const u of updates) {
      await prisma.product.update({ where: { id: u.id }, data: { category: u.category } });
    }
    console.log(`\n${updates.length} produit(s) catégorisé(s).`);
  }
}

await prisma.$disconnect();
