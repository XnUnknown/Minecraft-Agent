import type { Skill } from '../types';

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
    const message = String(args.message ?? '').slice(0, 256);
    if (!message) return 'No message to say.';
    bot.chat(message);
    return `Said: "${message}"`;
  },
};
