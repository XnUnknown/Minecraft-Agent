import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Skill, SkillContext } from '../types';
import { clampInt, withTimeout } from '../util';
import { walkToward, searchOutward } from '../../util/navigate';
import { placeNear } from '../../util/building';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Common furnace fuels, best first — used when the caller doesn't name a fuel. */
const FUELS = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'stick', 'lava_bucket'];

/** Matches a loaded entity by mob name, player username, or display name (case-insensitive). */
function entityMatches(e: Entity, target: string): boolean {
  const t = target.toLowerCase();
  const name = (e.name ?? '').toLowerCase();
  const uname = ((e as unknown as { username?: string }).username ?? '').toLowerCase();
  const disp = (e.displayName ?? '').toLowerCase();
  return name === t || uname === t || name.includes(t) || uname.includes(t) || disp.includes(t);
}

function nearestNamedEntity(bot: Bot, target: string): Entity | null {
  return bot.nearestEntity((e) => entityMatches(e, target)) ?? null;
}

export const goToEntity: Skill = {
  def: {
    name: 'goToEntity',
    description:
      'Walk up to the nearest entity of a given kind — a mob (e.g. cow, villager, zombie), a ' +
      'player, or any named entity. Use to approach something before interacting with or ' +
      'attacking it. For a specific player by name, goToPlayer is more direct.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity kind/name to approach, e.g. cow, villager, zombie.' },
        range: { type: 'integer', description: 'How close to get, in blocks (default 2).' },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const target = String(args.entity ?? '').toLowerCase();
    const range = clampInt(args.range, 1, 16, 2);
    if (!target) return { ok: false, message: 'No entity given.' };

    let entity = nearestNamedEntity(bot, target);
    if (!entity) {
      await searchOutward(bot, () => !!nearestNamedEntity(bot, target), ctx.reflex, ctx.shouldStop);
      entity = nearestNamedEntity(bot, target);
    }
    if (!entity) return { ok: false, message: `No ${target} in sight.` };

    const id = entity.id;
    const arrived = await walkToward(bot, () => bot.entities[id]?.position ?? null, range, ctx.reflex, ctx.shouldStop);
    return arrived
      ? { ok: true, message: `Reached the ${entity.name ?? target}.` }
      : { ok: false, message: `Couldn't get to the ${target} (it moved or the path was blocked).` };
  },
};

export const goToBlock: Skill = {
  def: {
    name: 'goToBlock',
    description:
      'Walk up to (but do NOT mine) the nearest block of a type — e.g. to stand at a chest, ' +
      'furnace, crafting_table, or enchanting_table before using it. Use the exact block name.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'Block name to walk to, e.g. furnace, chest, crafting_table.' },
        range: { type: 'integer', description: 'How close to get, in blocks (default 2).' },
      },
      required: ['block'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const name = String(args.block ?? '').toLowerCase();
    const range = clampInt(args.range, 1, 16, 2);
    const id = bot.registry.blocksByName[name]?.id;
    if (id === undefined) return { ok: false, message: `I don't know a block called "${name}".` };

    const find = (): { x: number; y: number; z: number } | null => bot.findBlock({ matching: id, maxDistance: 48 })?.position ?? null;
    if (!find()) {
      await searchOutward(bot, () => !!find(), ctx.reflex, ctx.shouldStop);
    }
    const pos = find();
    if (!pos) return { ok: false, message: `No ${name} within range.` };
    const arrived = await walkToward(bot, () => pos, range, ctx.reflex, ctx.shouldStop);
    return arrived
      ? { ok: true, message: `Standing by the ${name}.` }
      : { ok: false, message: `Couldn't reach the ${name} (path blocked).` };
  },
};

export const interactEntity: Skill = {
  def: {
    name: 'interactEntity',
    description:
      'Walk to the nearest entity of a kind and right-click (use/activate) it — what that does ' +
      'depends on the entity: open a villager\'s trades, mount a horse/boat/minecart, etc. For ' +
      'attacking a hostile mob use attackNearestMob instead; for trading use tradeWithVillager.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity kind/name to interact with, e.g. villager, horse, boat.' },
        mount: { type: 'boolean', description: 'If true, mount/ride it instead of a plain right-click (horse, boat, minecart).' },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const target = String(args.entity ?? '').toLowerCase();
    const mount = args.mount === true;
    if (!target) return { ok: false, message: 'No entity given.' };

    let entity = nearestNamedEntity(bot, target);
    if (!entity) {
      await searchOutward(bot, () => !!nearestNamedEntity(bot, target), ctx.reflex, ctx.shouldStop);
      entity = nearestNamedEntity(bot, target);
    }
    if (!entity) return { ok: false, message: `No ${target} in sight.` };

    const id = entity.id;
    const arrived = await walkToward(bot, () => bot.entities[id]?.position ?? null, 2, ctx.reflex, ctx.shouldStop);
    if (!arrived) return { ok: false, message: `Couldn't get close enough to the ${target}.` };
    const live = bot.entities[id];
    if (!live) return { ok: false, message: `Lost track of the ${target}.` };

    try {
      if (mount) {
        bot.mount(live);
        return { ok: true, message: `Mounted the ${entity.name ?? target}.` };
      }
      await bot.activateEntity(live);
      return { ok: true, message: `Interacted with the ${entity.name ?? target}.` };
    } catch (err) {
      return { ok: false, message: `Couldn't interact with the ${target}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const useFurnace: Skill = {
  def: {
    name: 'useFurnace',
    description:
      'Smelt/cook items in a nearby furnace: loads the input and fuel, waits for it to smelt, ' +
      'and takes the result. Needs a furnace within range (or one in your inventory to place). ' +
      'Example: smelt raw_iron into iron_ingot, or cook beef into cooked_beef.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Item to smelt/cook, e.g. raw_iron, sand, beef.' },
        count: { type: 'integer', description: 'How many to smelt (default 1).' },
        fuel: { type: 'string', description: 'Optional fuel item (e.g. coal). Auto-picks coal/charcoal/planks if omitted.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const inputName = String(args.input ?? '').toLowerCase();
    const count = clampInt(args.count, 1, 64, 1);
    const inputItem = bot.registry.itemsByName[inputName];
    if (!inputItem) return { ok: false, message: `I don't know an item called "${inputName}".` };
    if (bot.inventory.count(inputItem.id, null) < count) {
      return { ok: false, message: `I only have ${bot.inventory.count(inputItem.id, null)}x ${inputName} (need ${count}).` };
    }

    const furnaceBlock = await reachStation(bot, ['furnace'], ctx);
    if (!furnaceBlock) return { ok: false, message: 'No furnace nearby, and none in my inventory to place.' };

    // Pick a fuel: named one if given and present, else the first common fuel we have.
    const fuelName = args.fuel ? String(args.fuel).toLowerCase() : FUELS.find((f) => hasItem(bot, f));
    const fuelItem = fuelName ? bot.registry.itemsByName[fuelName] : undefined;
    if (!fuelItem || !hasItem(bot, fuelName!)) {
      return { ok: false, message: `No usable fuel (tried ${fuelName ?? 'coal/charcoal/planks'}). Bring coal or another fuel.` };
    }

    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      // Roughly one fuel item per ~8 smelts; load a safe amount of what we have.
      const fuelToLoad = Math.min(bot.inventory.count(fuelItem.id, null), Math.max(1, Math.ceil(count / 8)));
      await furnace.putFuel(fuelItem.id, null, fuelToLoad);
      await furnace.putInput(inputItem.id, null, count);

      const deadline = Date.now() + count * 11000 + 8000;
      while (Date.now() < deadline && !ctx.shouldStop?.()) {
        await sleep(1000);
        const out = furnace.outputItem();
        if (out && out.count >= count) break;
        if (!furnace.inputItem() && furnace.outputItem()) break; // input consumed, nothing more coming
      }
      let taken = 0;
      if (furnace.outputItem()) {
        const t = await furnace.takeOutput();
        taken = t?.count ?? 0;
      }
      return taken > 0
        ? { ok: true, message: `Smelted ${taken}x from ${count}x ${inputName}.` }
        : { ok: false, message: `Nothing smelted (wrong fuel, un-smeltable input, or it didn't finish in time).` };
    } finally {
      try {
        furnace.close();
      } catch {
        /* ignore */
      }
    }
  },
};

export const useEnchantmentTable: Skill = {
  def: {
    name: 'useEnchantmentTable',
    description:
      'Enchant an item you are holding/own at a nearby enchanting table. Needs lapis_lazuli and ' +
      'enough XP levels. Picks one of the three offered enchantments (choice 0=top/cheapest).',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item to enchant, e.g. diamond_sword, iron_pickaxe.' },
        choice: { type: 'integer', description: 'Which of the 3 offers to take: 0, 1, or 2 (default 0).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  async run(bot, args, ctx) {
    const itemName = String(args.item ?? '').toLowerCase();
    const choice = clampInt(args.choice, 0, 2, 0);
    const toEnchant = bot.inventory.items().find((i) => i.name === itemName);
    if (!toEnchant) return { ok: false, message: `I'm not carrying a ${itemName} to enchant.` };
    const lapis = bot.inventory.items().find((i) => i.name === 'lapis_lazuli');
    if (!lapis) return { ok: false, message: 'No lapis_lazuli — enchanting needs it.' };

    const tableBlock = await reachStation(bot, ['enchanting_table'], ctx);
    if (!tableBlock) return { ok: false, message: 'No enchanting table nearby.' };

    const table = await bot.openEnchantmentTable(tableBlock);
    try {
      await table.putTargetItem(toEnchant);
      await table.putLapis(lapis);
      // Wait for the three offers to populate.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !(table.enchantments ?? []).some((e) => e && e.level > 0)) {
        await sleep(300);
      }
      const offers = table.enchantments ?? [];
      if (!offers.some((e) => e && e.level > 0)) {
        await table.takeTargetItem();
        return { ok: false, message: 'No enchantments available (not enough XP levels or bookshelves).' };
      }
      await withTimeout(table.enchant(choice), 10000);
      await table.takeTargetItem();
      return { ok: true, message: `Enchanted the ${itemName} (offer #${choice}).` };
    } catch (err) {
      try {
        await table.takeTargetItem();
      } catch {
        /* ignore */
      }
      return { ok: false, message: `Couldn't enchant the ${itemName}: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      try {
        table.close();
      } catch {
        /* ignore */
      }
    }
  },
};

function hasItem(bot: Bot, name?: string): boolean {
  if (!name) return false;
  const id = bot.registry.itemsByName[name]?.id;
  return id !== undefined && bot.inventory.count(id, null) > 0;
}

/** Finds a station block of one of `names` within range and walks to it; if none is loaded but
 *  the bot carries one, places it. Returns the block to open, or null. */
async function reachStation(bot: Bot, names: string[], ctx: SkillContext): Promise<import('prismarine-block').Block | null> {
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
  const find = (): import('prismarine-block').Block | null => (ids.length ? bot.findBlock({ matching: ids, maxDistance: 48 }) : null);

  let block = find();
  if (!block) {
    // Try placing one we carry (e.g. a furnace in inventory), else give the area a quick scan.
    for (const n of names) {
      if (hasItem(bot, n)) {
        await placeNear(bot, n);
        break;
      }
    }
    block = find();
  }
  if (!block) {
    await searchOutward(bot, () => !!find(), ctx.reflex, ctx.shouldStop);
    block = find();
  }
  if (!block) return null;
  await walkToward(bot, () => block!.position, 3, ctx.reflex, ctx.shouldStop);
  return bot.blockAt(block.position) ?? block;
}
