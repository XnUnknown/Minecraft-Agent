import type { Skill } from '../types';
import { sendChat } from '../../util/chat';

export const messageAgent: Skill = {
  def: {
    name: 'messageAgent',
    description:
      'Ask another named agent (a peer bot, not a player) for help — e.g. to bring a ' +
      'material it has and you do not. Sent as a normal chat message naming them, so they ' +
      'receive it exactly like a player request: they will either do it and deliver the ' +
      'result, or reply that they are busy right now. Only useful when other agents are ' +
      'configured alongside you.',
    parameters: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'Exact username of the agent to ask, e.g. Steve_AI2.' },
        message: { type: 'string', description: 'What to ask them, e.g. "bring 4 oak_log to Steve_AI".' },
      },
      required: ['agentName', 'message'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const agentName = String(args.agentName ?? '').trim();
    const message = String(args.message ?? '').trim();
    if (!agentName || !message) return { ok: false, message: 'Need both an agent name and a message.' };

    sendChat(bot, `${agentName} ${message}`);
    return { ok: true, message: `Asked ${agentName}: "${message}"` };
  },
};
