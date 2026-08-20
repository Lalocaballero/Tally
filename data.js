/* Tally — grocery dictionary & normalization data
   Slovak (sk) + Austrian German (de) -> English canonical names.
   Used to translate receipt lines and guess what a product is.
   Every user correction is remembered in localStorage (learned aliases),
   so the app gets smarter the more receipts you scan. */

/* Canonical products: englishName -> { cat, aliases:[...] }
   Aliases are lowercase, accent-insensitive matched (see fold()). */
const CATALOG = [
  // ---- Dairy ----
  { en: 'Milk',            cat: 'Dairy',        aliases: ['mlieko', 'milch', 'vollmilch', 'polotucne mlieko', 'trvanlive mlieko', 'frischmilch'] },
  { en: 'Butter',          cat: 'Dairy',        aliases: ['maslo', 'butter', 'alpenbutter', 'teebutter'] },
  { en: 'Yogurt',          cat: 'Dairy',        aliases: ['jogurt', 'joghurt', 'biely jogurt', 'naturjoghurt', 'fruchtjoghurt'] },
  { en: 'Cheese',          cat: 'Dairy',        aliases: ['syr', 'kase', 'kaese', 'gouda', 'edamer', 'eidam', 'ementaler', 'emmentaler', 'cheddar', 'mozzar', 'mozzarella', 'toastkaese', 'goldfish kaese'] },
  { en: 'Pesto',           cat: 'Pantry',       aliases: ['pesto', 'genov'] },
  { en: 'Avocado',         cat: 'Produce',      aliases: ['avocado', 'avokado'] },
  { en: 'Mushrooms',       cat: 'Produce',      aliases: ['champignon', 'champignons', 'huby', 'pilze', 'kulturchampignons'] },
  { en: 'Cream',           cat: 'Dairy',        aliases: ['smotana', 'sahne', 'schlagobers', 'obers', 'slahacka'] },
  { en: 'Sour cream',      cat: 'Dairy',        aliases: ['kysla smotana', 'sauerrahm'] },
  { en: 'Cottage cheese',  cat: 'Dairy',        aliases: ['tvaroh', 'topfen', 'quark'] },
  { en: 'Camembert',       cat: 'Dairy',        aliases: ['camembert', 'hermelin'] },
  { en: 'Grilling cheese', cat: 'Dairy',        aliases: ['gril syr', 'grill kaese', 'grilovaci syr', 'camembert na gril'] },

  // ---- Produce ----
  { en: 'Eggs',            cat: 'Produce',      aliases: ['vajcia', 'vajce', 'eier'] },
  { en: 'Apples',          cat: 'Produce',      aliases: ['jablka', 'jablko', 'apfel', 'aepfel'] },
  { en: 'Bananas',         cat: 'Produce',      aliases: ['banany', 'banan', 'banane', 'bananen'] },
  { en: 'Tomatoes',        cat: 'Produce',      aliases: ['paradajky', 'rajciny', 'tomaten', 'tomate', 'paradiser'] },
  { en: 'Potatoes',        cat: 'Produce',      aliases: ['zemiaky', 'zemiak', 'kartoffeln', 'erdaepfel', 'erdapfel'] },
  { en: 'Onions',          cat: 'Produce',      aliases: ['cibula', 'cibule', 'zwiebel', 'zwiebeln'] },
  { en: 'Carrots',         cat: 'Produce',      aliases: ['mrkva', 'karotte', 'karotten', 'moehren'] },
  { en: 'Cucumber',        cat: 'Produce',      aliases: ['uhorka', 'uhorky', 'gurke', 'gurken'] },
  { en: 'Peppers',         cat: 'Produce',      aliases: ['paprika', 'papriky'] },
  { en: 'Lettuce',         cat: 'Produce',      aliases: ['salat', 'kopfsalat', 'blattsalat'] },
  { en: 'Lemons',          cat: 'Produce',      aliases: ['citron', 'citrony', 'zitrone', 'zitronen'] },
  { en: 'Garlic',          cat: 'Produce',      aliases: ['cesnak', 'knoblauch'] },

  // ---- Bakery ----
  { en: 'Bread',           cat: 'Bakery',       aliases: ['chlieb', 'brot', 'toastbrot', 'toastovy chlieb', 'vollkornbrot', 'bread', 'share bread', 'brioche'] },
  { en: 'Rolls',           cat: 'Bakery',       aliases: ['rozok', 'rozky', 'zemla', 'zemle', 'semmel', 'semmeln', 'weckerl', 'gebaeck'] },
  { en: 'Croissant',       cat: 'Bakery',       aliases: ['croissant', 'kifel', 'kipferl', 'kifle'] },

  // ---- Meat & Fish ----
  { en: 'Chicken',         cat: 'Meat & Fish',  aliases: ['kura', 'kuracie', 'kuracie prsia', 'huhn', 'haehnchen', 'hendl'] },
  { en: 'Pork',            cat: 'Meat & Fish',  aliases: ['bravcove', 'bravcove maso', 'schwein', 'schweinefleisch'] },
  { en: 'Beef',            cat: 'Meat & Fish',  aliases: ['hovadzie', 'hovadzie maso', 'rind', 'rindfleisch'] },
  { en: 'Ham',             cat: 'Meat & Fish',  aliases: ['sunka', 'schinken'] },
  { en: 'Sausage',         cat: 'Meat & Fish',  aliases: ['klobasa', 'parky', 'wurst', 'wuerstel', 'wuerstchen', 'salama', 'salami'] },
  { en: 'Fish',            cat: 'Meat & Fish',  aliases: ['ryba', 'ryby', 'fisch', 'losos', 'lachs'] },

  // ---- Pantry ----
  { en: 'Flour',           cat: 'Pantry',       aliases: ['muka', 'mehl'] },
  { en: 'Sugar',           cat: 'Pantry',       aliases: ['cukor', 'zucker'] },
  { en: 'Salt',            cat: 'Pantry',       aliases: ['sol', 'salz'] },
  { en: 'Rice',            cat: 'Pantry',       aliases: ['ryza', 'reis'] },
  { en: 'Pasta',           cat: 'Pantry',       aliases: ['cestoviny', 'nudeln', 'spagety', 'spaghetti', 'teigwaren'] },
  { en: 'Oil',             cat: 'Pantry',       aliases: ['olej', 'oel', 'slnecnicovy olej', 'sonnenblumenoel'] },
  { en: 'Olive oil',       cat: 'Pantry',       aliases: ['olivovy olej', 'olivenoel'] },

  // ---- Drinks ----
  { en: 'Coffee',          cat: 'Drinks',       aliases: ['kava', 'kaffee'] },
  { en: 'Tea',             cat: 'Drinks',       aliases: ['caj', 'tee'] },
  { en: 'Water',           cat: 'Drinks',       aliases: ['voda', 'wasser', 'mineralka', 'mineralwasser'] },
  { en: 'Juice',           cat: 'Drinks',       aliases: ['dzus', 'stava', 'saft', 'fruchtsaft'] },
  { en: 'Beer',            cat: 'Drinks',       aliases: ['pivo', 'bier', 'budweis', 'budvar', 'stiegl', 'gosser', 'ottakringer'] },
  { en: 'Wine',            cat: 'Drinks',       aliases: ['vino', 'wein'] },
  { en: 'Cola',            cat: 'Drinks',       aliases: ['cola', 'coke', 'cocacola', 'coca cola', 'coke cherry', 'pepsi'] },
  { en: 'Soft drink',      cat: 'Drinks',       aliases: ['limo', 'limonade', 'sprite', 'fanta', 'kofola'] },

  // ---- Snacks / Pantry extras ----
  { en: 'Chips',           cat: 'Pantry',       aliases: ['chips', 'kellys chips', 'zemiakove lupienky'] },
  { en: 'Mayonnaise',      cat: 'Pantry',       aliases: ['mayonnaise', 'mayo', 'majoneza'] },
  { en: 'Ketchup',         cat: 'Pantry',       aliases: ['ketchup', 'kecup'] },
  { en: 'Sandwich',        cat: 'Bakery',       aliases: ['sandwich'] },
  { en: 'Wraps',           cat: 'Bakery',       aliases: ['wraps', 'wrap', 'tortilla', 'tortillas'] },

  // ---- Personal care (Household) ----
  { en: 'Toothbrush',      cat: 'Household',    aliases: ['zahnbuerste', 'zahnburste', 'zubna kefka'] },
  { en: 'Toothpaste',      cat: 'Household',    aliases: ['zahnpasta', 'zahncreme', 'zubna pasta', 'elmex'] },
  { en: 'Shampoo',         cat: 'Household',    aliases: ['shampoo', 'sampon'] },
  { en: 'Soap',            cat: 'Household',    aliases: ['seife', 'mydlo'] },

  // ---- Household ----
  { en: 'Toilet paper',    cat: 'Household',    aliases: ['toaletny papier', 'toilettenpapier', 'klopapier', 'wc papier'] },
  { en: 'Dish soap',       cat: 'Household',    aliases: ['prostriedok na riad', 'spuelmittel', 'geschirrspuelmittel'] },
  { en: 'Laundry deterg.', cat: 'Household',    aliases: ['praci prasok', 'waschmittel'] },
  { en: 'Paper towels',    cat: 'Household',    aliases: ['papierove utierky', 'kuchynske utierky', 'kuechenrolle', 'haushaltsrolle', 'haushaltstucher', 'haushaltstuecher'] },
  { en: 'Fabric softener', cat: 'Household',    aliases: ['weichspueler', 'weichspuler', 'silan', 'avivaz'] },
  { en: 'Trash bags',      cat: 'Household',    aliases: ['muellbeutel', 'mullbeutel', 'vrecia na odpad', 'abfallsack'] },
  { en: 'Gloves',          cat: 'Household',    aliases: ['handschuhe', 'nitrile handschuhe', 'rukavice'] },
  { en: 'Baking paper',    cat: 'Household',    aliases: ['backpapier', 'peciaci papier'] },
  { en: 'Aluminium foil',  cat: 'Household',    aliases: ['alufolie', 'alobal'] },
  { en: 'Toilet cleaner',  cat: 'Household',    aliases: ['toilettengel', 'wc gel', 'duck', 'wc cistic'] },

  // ---- Seen in real receipts (v2.5 dictionary expansion) ----
  { en: 'Actimel',         cat: 'Dairy',        aliases: ['actimel', 'danone actimel'] },
  { en: 'Drinkable yogurt',cat: 'Dairy',        aliases: ['trinkjoghurt', 'jogurtovy napoj'] },
  { en: 'Breakfast cereal',cat: 'Pantry',       aliases: ['cereals', 'cerealie', 'nesquik', 'muesli', 'musli', 'cornflakes', 'cini minis'] },
  { en: 'Seasoning',       cat: 'Pantry',       aliases: ['maggi', 'wurze', 'wuerze', 'korenie', 'vegeta'] },
  { en: 'Guacamole',       cat: 'Produce',      aliases: ['guacamole'] },
  { en: 'Shallots',        cat: 'Produce',      aliases: ['schalotten', 'salotky'] },
  { en: 'Chives',          cat: 'Produce',      aliases: ['schnittlauch', 'pazitka'] },
  { en: 'Turkey',          cat: 'Meat & Fish',  aliases: ['truthahn', 'truthahnbrust', 'pute', 'putenbrust', 'moriak', 'morcacie'] },
  { en: 'Pork chop',       cat: 'Meat & Fish',  aliases: ['karree', 'karreekotelett', 'kotelett', 'kotleta', 'bravcove kare'] },
  { en: 'Pork belly',      cat: 'Meat & Fish',  aliases: ['schweinebauch', 'bravcovy bok'] },
  { en: 'Bacon',           cat: 'Meat & Fish',  aliases: ['speck', 'bacon', 'slanina', 'raucherspeck'] },
  { en: 'Minced meat',     cat: 'Meat & Fish',  aliases: ['faschiertes', 'hackfleisch', 'mlete maso'] },
  { en: 'Soup noodles',    cat: 'Pantry',       aliases: ['suppennudeln', 'polievkove cestoviny'] },
];

/* Store name hints -> country, to tag receipts AT vs SK (used later for insights).
   Key = a distinctive lowercase token that appears in the receipt header.
   display = the pretty name to show/store. */
const STORE_HINTS = {
  // ---- Austria (AT) ----
  'billa':      { country: 'AT', display: 'Billa' },
  'spar':       { country: 'AT', display: 'Spar' },
  'interspar':  { country: 'AT', display: 'Interspar' },
  'penny':      { country: 'AT', display: 'Penny' },
  'hofer':      { country: 'AT', display: 'Hofer' },
  'merkur':     { country: 'AT', display: 'Merkur' },
  'drogerie':   { country: 'AT', display: 'DM' },       // "dm drogerie markt"
  'bipa':       { country: 'AT', display: 'Bipa' },
  'mueller':    { country: 'AT', display: 'Müller' },
  // ---- Slovakia (SK) ----
  'tesco':      { country: 'SK', display: 'Tesco' },
  'kaufland':   { country: 'SK', display: 'Kaufland' },
  'coop':       { country: 'SK', display: 'COOP' },
  'jednota':    { country: 'SK', display: 'Jednota' },
  'fresh':      { country: 'SK', display: 'Fresh' },
  // ---- Both countries — resolved by receipt language ----
  'lidl':       { country: '??', display: 'Lidl' },
  'rossmann':   { country: '??', display: 'Rossmann' },
};

/* Word-tokens that hint receipt language */
const LANG_HINTS = {
  sk: ['spolu', 'zaplatene', 'hotovost', 'dph', 'ks', 'mnozstvo', 'cena', 'zlava', 'pokladna', 'ucet', 'dakujeme'],
  de: ['summe', 'gesamt', 'bar', 'mwst', 'stk', 'menge', 'preis', 'rabatt', 'kassa', 'beleg', 'danke', 'rechnung'],
};

/* Default shelf life / typical repurchase interval per category (days).
   Used by the prediction engine BEFORE it has learned your real cadence
   from purchase history. Rough, sensible seeds — the learned average
   overrides these once there are 2+ purchases of an item. */
const CATEGORY_SHELFLIFE = {
  'Dairy':       7,
  'Bakery':      4,
  'Produce':     6,
  'Meat & Fish': 5,
  'Frozen':      30,
  'Drinks':      10,
  'Pantry':      30,
  'Household':   45,
  'Other':       14,
};
function shelfLifeFor(cat) { return CATEGORY_SHELFLIFE[cat] || CATEGORY_SHELFLIFE['Other']; }

/* strip accents + lowercase for fuzzy matching */
function fold(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
