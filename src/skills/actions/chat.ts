import type { Skill } from '../types';
import { sendChat } from '../../util/chat';

export const sayInChat: Skill = {
  def: {
    name: 'sayInChat',
    description: 'Say a short message in public chat. Use to reply to or acknowledge a player.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to say.' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  async run(bot, args) {
    const message = String(args.message ?? '').trim();
    if (!message) return { ok: false, message: 'No message to say.' };
    sendChat(bot, message);
    return { ok: true, message: `Said: "${message}"` };
  },
};
