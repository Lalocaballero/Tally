/* Tally — ingredient synonyms, substitutions, staples & query terms (v3.0)
   All keys/values are matched accent-insensitive & lowercase via fold().
   Conservative on purpose — grows with use. */

/* SYNONYMS: recipe-ingredient (TheMealDB name) -> your canonical pantry name.
   These are EQUIVALENTS (count as "have" if you own the canonical item).
   e.g. a recipe calling for "Cheddar" is satisfied by your "Cheese". */
const INGREDIENT_SYNONYMS = {
  'cheddar': 'cheese', 'parmesan': 'cheese', 'parmigiano': 'cheese', 'mozzarella': 'cheese',
  'gouda': 'cheese', 'emmental': 'cheese', 'gruyere': 'cheese', 'feta': 'cheese',
  'chicken breast': 'chicken', 'chicken breasts': 'chicken', 'chicken thighs': 'chicken',
  'chicken thigh': 'chicken', 'skinless chicken': 'chicken', 'whole chicken': 'chicken',
  'pork chops': 'pork', 'pork chop': 'pork', 'pork shoulder': 'pork', 'pork belly': 'pork',
  'pork mince': 'pork', 'minced pork': 'pork', 'pork loin': 'pork',
  'beef mince': 'beef', 'minced beef': 'beef', 'ground beef': 'beef', 'beef steak': 'beef',
  'steak': 'beef', 'stewing beef': 'beef',
  'spring onions': 'green onion', 'spring onion': 'green onion', 'scallions': 'green onion',
  'red onion': 'onions', 'white onion': 'onions', 'onion': 'onions',
  'garlic clove': 'garlic', 'garlic cloves': 'garlic',
  'potato': 'potatoes', 'baby potatoes': 'potatoes', 'new potatoes': 'potatoes',
  'tomato': 'tomatoes', 'cherry tomatoes': 'tomatoes', 'plum tomatoes': 'tomatoes',
  'chopped tomatoes': 'tomatoes', 'canned tomatoes': 'tomatoes',
  'egg': 'eggs', 'free range eggs': 'eggs', 'egg yolks': 'eggs', 'egg whites': 'eggs',
  'plain flour': 'flour', 'self raising flour': 'flour', 'all purpose flour': 'flour',
  'whole milk': 'milk', 'semi skimmed milk': 'milk', 'skimmed milk': 'milk',
  'streaky bacon': 'bacon', 'smoked bacon': 'bacon', 'bacon lardons': 'bacon', 'pancetta': 'bacon',
  'turkey breast': 'turkey', 'turkey mince': 'turkey',
  'basmati rice': 'rice', 'long grain rice': 'rice', 'white rice': 'rice',
  'spaghetti': 'pasta', 'penne': 'pasta', 'macaroni': 'pasta', 'tagliatelle': 'pasta',
  'fusilli': 'pasta', 'noodles': 'pasta', 'lasagne sheets': 'pasta',
  'natural yogurt': 'yogurt', 'greek yogurt': 'yogurt', 'plain yogurt': 'yogurt',
  'double cream': 'cream', 'single cream': 'cream', 'whipping cream': 'cream',
  'olive oil': 'oil', 'vegetable oil': 'oil', 'sunflower oil': 'oil',
};

/* SUBSTITUTIONS: recipe-ingredient -> list of canonical items that can STAND IN.
   These are SUGGESTIONS ("you could use..."), NOT guarantees. Ranked below an
   exact "have". If you own ANY listed substitute, the ingredient is "coverable". */
const SUBSTITUTIONS = {
  'cream':        ['milk', 'butter', 'yogurt'],
  'double cream': ['milk', 'butter'],
  'buttermilk':   ['milk', 'yogurt'],
  'sour cream':   ['yogurt', 'cream'],
  'creme fraiche':['yogurt', 'cream', 'sour cream'],
  'butter':       ['oil', 'margarine'],
  'oil':          ['butter'],
  'shallots':     ['onions'],
  'shallot':      ['onions'],
  'spring onions':['onions'],
  'leek':         ['onions'],
  'lime':         ['lemons'],
  'lemon':        ['lemons'],
  'caster sugar': ['sugar'],
  'brown sugar':  ['sugar'],
  'honey':        ['sugar'],
  'yogurt':       ['cream', 'sour cream'],
  'milk':         ['cream'],
  'cheddar':      ['cheese'],
  'parmesan':     ['cheese'],
  'creme':        ['milk', 'butter'],
  'passata':      ['tomatoes', 'ketchup'],
  'tomato puree': ['tomatoes', 'ketchup'],
  'basmati rice': ['rice'],
  'coriander':    ['parsley'],
  'cilantro':     ['parsley'],
  'green onion':  ['onions'],
};

/* STAPLES: assumed always on hand — never counted as "missing" so they don't
   tank every recipe's score. Kept conservative. */
const STAPLES = new Set([
  'salt', 'pepper', 'black pepper', 'water', 'oil', 'olive oil', 'vegetable oil',
  'sunflower oil', 'sugar', 'flour', 'plain flour',
]);

/* QUERY_TERMS: canonical pantry name -> the term to send to TheMealDB's
   single-ingredient filter (its vocabulary is broad: Chicken, Pork, Potatoes...).
   Falls back to the canonical name itself when not listed. */
const QUERY_TERMS = {
  'pork chop': 'pork', 'pork belly': 'pork', 'minced meat': 'beef',
  'green onion': 'spring onions', 'grilling cheese': 'cheese', 'camembert': 'cheese',
  'soup noodles': 'pasta', 'breakfast cereal': 'oats', 'seasoning': 'onion',
  'shallots': 'shallots', 'chives': 'chives', 'turkey': 'turkey',
  'cola': 'coca-cola', 'soft drink': 'lemonade',
};
