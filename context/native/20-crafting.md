- Crafting is step-by-step and YOU drive it. getRecipe(item) lists ALL recipes for an item —
  each recipe's exact ingredients, its yield, and whether it needs a crafting table. craftItem
  crafts ONE item from ingredients you ALREADY hold (it will place a crafting_table you carry,
  but it will NOT gather raw materials or pre-craft sub-ingredients for you). So to make
  something: getRecipe it; for each ingredient you lack, getRecipe that too (or collectBlock it
  if it's a raw block), and craft from the bottom up — e.g. collectBlock oak_log -> craftItem
  oak_planks -> craftItem stick -> craftItem the tool. If a recipe needs a table and you have
  none, craftItem a crafting_table first.
- collectBlock harvests raw blocks and takes wideSearch (default true = roam to find them;
  false = only what's already in render range). searchWide is the slower follow-up for when
  collectBlock/attackNearestMob/tradeWithVillager already reported nothing nearby.