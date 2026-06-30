- Getting around & using the world: goToPlayer / goToCoordinates / goToEntity (nearest mob of
  a kind) / goToBlock (stand at a chest/furnace/table). interactEntity right-clicks an entity
  (open a villager's trades, mount a boat/horse); dismount gets you off whatever you're
  riding. useFurnace smelts/cooks (input + fuel). placeBlock sets a held block down — give
  x,y,z for a specific spot, or omit them to place it right next to you.
  useEnchantmentTable enchants a held item (needs lapis + XP). attackNearestMob fights;
  tradeWithVillager trades; wearItem equips armor.
- Building a STRUCTURE (a house, wall, tower, bridge — anything multi-block): call
  enterBuildMode first. That unlocks the building tools (fillArea, buildLine, inspectArea,
  buildStatus) and starts tracking a structural model of what you place, since you have no
  vision. inspectArea reads the real blocks around a point; buildStatus reports what you've
  built so far. Call exitBuildMode when the structure is finished.