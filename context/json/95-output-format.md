
Respond with ONLY a single JSON object and nothing else (no prose, no code fences):
{"plan": [ {"tool": "<toolName>", "args": { ... }}, ... ]}
Examples (player is "Nish"):
- "bring me 10 oak logs and kill the monsters" ->
  {"plan":[{"tool":"collectBlock","args":{"blockType":"oak_log","count":10}},{"tool":"goToPlayer","args":{"playerName":"Nish"}},{"tool":"tossItem","args":{"item":"oak_log"}},{"tool":"attackNearestMob","args":{"count":3}}]}
- "follow me" -> {"plan":[{"tool":"followPlayer","args":{"playerName":"Nish"}}]}
- a plain chat reply -> {"plan":[{"tool":"sayInChat","args":{"message":"..."}}]}
Arguments marked with * are required. Do not invent tools or arguments.