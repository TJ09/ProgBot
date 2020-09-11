import discord from 'discord.js';
import { Config } from '../../../clients/configuration';
import { getLogger } from '../../../logger';

const logger = getLogger('discord');

const singletonClient = new discord.Client();

export type MsgHandler = (msg: discord.Message, param?: string) => Promise<string>;
// param input in the handler is the parsed message content after trimming the prepended command.
// Return the string content for replying to the message, or an empty string if a general reply is not desired.
export interface DiscordCommand {
  cmd: string;
  shortDescription: string;
  usageInfo: string;
  handler: MsgHandler;
}

export class DiscordClient {
  public static client = singletonClient;
  public static cmdPrefix = Config.getConfig().discord_bot_cmd_prefix || '!';
  private static commands: {
    [cmd: string]: {
      desc: string;
      usage: string;
      handler: MsgHandler;
    };
  } = {};

  public static async connect() {
    DiscordClient.registerCommand(DiscordClient.helpCommand);
    await DiscordClient.client.login(Config.getConfig().discord_token);
    await DiscordClient.client.user?.setPresence({ activity: { type: 'PLAYING', name: `on the net - ${DiscordClient.cmdPrefix}help` } });
  }

  public static nowReady() {
    logger.info(`Discord client ready. Invite: https://discordapp.com/oauth2/authorize?client_id=${DiscordClient.client.user?.id}&scope=bot&permissions=8`);
  }

  public static async handleMessage(message: discord.Message) {
    if (message.content.startsWith(DiscordClient.cmdPrefix)) {
      const sep = message.content.indexOf(' ');
      const cmd = message.content.substring(DiscordClient.cmdPrefix.length, sep === -1 ? undefined : sep);
      const param = sep === -1 ? undefined : message.content.substring(sep + 1).trim() || undefined;
      logger.trace(`cmd: '${cmd}' params: '${param}' user: ${message.member?.user.username}#${message.member?.user.discriminator}`);
      if (DiscordClient.commands[cmd]) {
        // Start typing if reply takes time to generate (over 100ms)
        let typing = false;
        const timeout = setTimeout(() => {
          message.channel.startTyping().catch();
          typing = true;
        }, 100);
        try {
          const reply = await DiscordClient.commands[cmd].handler(message, param);
          clearTimeout(timeout);
          if (reply) await message.channel.send(reply);
          else if (typing) message.channel.stopTyping(true);
        } catch (e) {
          logger.error(e);
          await message.channel.send('Internal Error');
        }
      }
    }
  }

  public static registerCommand(command: DiscordCommand) {
    if (DiscordClient.commands[command.cmd]) throw new Error(`Command handler for cmd ${command.cmd} already registered!`);
    DiscordClient.commands[command.cmd] = {
      desc: command.shortDescription,
      usage: command.usageInfo,
      handler: command.handler,
    };
  }

  private static helpCommand: DiscordCommand = {
    cmd: 'help',
    shortDescription: 'Get list of commands or help for a specific command (help [cmd])',
    usageInfo: `usage: help [cmd]
  help - list all commands with their descriptions
  help [cmd] - get the description and usage information for [cmd]`,
    handler: async (_msg, param) => {
      if (param) {
        // if help for a specific command
        if (DiscordClient.commands[param]) {
          return `\`\`\`${param} - ${DiscordClient.commands[param].desc}\n\n${DiscordClient.commands[param].usage}\`\`\``;
        } else {
          return `Unknown command '${param}'`;
        }
      } else {
        // no specific command specified, list all commands
        let replyText = `\`\`\`Commands:\n\n`;
        Object.entries(DiscordClient.commands).forEach(([cmd, data]) => {
          replyText += `${DiscordClient.cmdPrefix}${cmd} - ${data.desc}\n`;
        });
        return replyText.trimEnd() + '```';
      }
    },
  };

  public static async shutdown() {
    DiscordClient.client.destroy();
  }
}

singletonClient.on('ready', DiscordClient.nowReady);
singletonClient.on('message', DiscordClient.handleMessage);
singletonClient.on('rateLimit', (r) => logger.warn(`Rate limit: ${r}`));
singletonClient.on('error', logger.error);
