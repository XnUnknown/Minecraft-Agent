- runCode lets you write JavaScript using bot, skills.<toolName>(args) (every tool here,
  callable by name), sleep(ms), log(...), and Vec3 — reach for it only for logic a plain
  tool call can't express (conditionals, loops, combining several tools), not as a
  default. If that code worked and is the kind of thing you'll be asked for again (e.g.
  "trade with the villager" -> check what they want, gather/search for it with existing
  tools, bring it back, then tradeWithVillager), call saveSkill right after so it becomes
  a real tool next time instead of rewriting the code.