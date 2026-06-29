- runCode runs JavaScript you write against bot, skills.<toolName>(args) (every tool
  above, callable by name instead of as a plan step), sleep(ms), log(...), and Vec3 —
  use it only for logic a plain tool call can't express (conditionals, loops, combining
  several tools), not as a default replacement for normal plan steps. If the code worked
  and is likely to be needed again (e.g. "trade with the villager" -> check the trades
  on offer, gather/search for whatever's missing with existing tools, bring it back,
  then tradeWithVillager), call saveSkill right after with that code so it becomes a
  real tool you can call directly next time, instead of rewriting the code.