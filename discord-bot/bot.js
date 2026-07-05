// SIGNAL console — Discord search bot.
//
// This is the only ToS-compliant way to get Discord data: a real bot, added to servers you
// (or your 2-3 users) are already members of, reading message history through the official
// Bot API. Discord's Developer Policy explicitly prohibits mining/scraping data outside the
// API, so this deliberately does NOT try to index every server or build a persistent
// cross-server search database — it searches live, on-demand, only in servers the bot has
// actually been invited to.
//
// Setup (see README.md for the full walkthrough):
//   1. Create an application at https://discord.com/developers/applications
//   2. Add a Bot user, enable the "Message Content Intent" under Bot settings
//   3. Copy the bot token into .env as DISCORD_BOT_TOKEN
//   4. Invite the bot to servers you want searchable (OAuth2 URL Generator: scope=bot,
//      permissions = Read Messages/View Channels + Read Message History)
//   5. Run: node discord-bot/bot.js
//
// Usage in Discord: /signal-search query:(paid study OR focus group) AND remote

require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const path = require('path');
const { parseQuery, matchesQuery } = require('../server/queryParser');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID in .env — see discord-bot/bot.js header for setup steps.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // requires "Message Content Intent" enabled in dev portal
  ],
});

const command = new SlashCommandBuilder()
  .setName('signal-search')
  .setDescription('Search recent messages in this server with boolean query syntax')
  .addStringOption(opt => opt.setName('query').setDescription('e.g. (paid study OR focus group) AND remote +compensation -scam').setRequired(true))
  .addIntegerOption(opt => opt.setName('lookback_hours').setDescription('How far back to search (default 168 = 1 week)').setRequired(false));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
  console.log('Slash command /signal-search registered.');
}

client.once('ready', () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  console.log(`Servers joined: ${client.guilds.cache.map(g => g.name).join(', ') || '(none yet — invite the bot to a server)'}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'signal-search') return;

  const query = interaction.options.getString('query');
  const lookbackHours = interaction.options.getInteger('lookback_hours') || 168;
  const parsed = parseQuery(query);

  await interaction.deferReply();

  try {
    const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
    const matches = [];

    // Search text channels in the current server the bot can see
    const channels = interaction.guild.channels.cache.filter(c => c.isTextBased && c.isTextBased());
    for (const [, channel] of channels) {
      try {
        const perms = channel.permissionsFor(client.user);
        if (!perms || !perms.has('ViewChannel') || !perms.has('ReadMessageHistory')) continue;

        let lastId;
        let keepGoing = true;
        while (keepGoing) {
          const batch = await channel.messages.fetch({ limit: 100, before: lastId });
          if (batch.size === 0) break;
          for (const [, msg] of batch) {
            if (msg.createdTimestamp < cutoff) { keepGoing = false; break; }
            if (msg.content && matchesQuery(parsed, msg.content)) {
              matches.push({
                channel: channel.name,
                author: msg.author.tag,
                content: msg.content.slice(0, 300),
                url: msg.url,
                minsAgo: Math.round((Date.now() - msg.createdTimestamp) / 60000),
              });
            }
          }
          lastId = batch.last()?.id;
          if (matches.length >= 25) { keepGoing = false; }
        }
      } catch (e) {
        // skip channels the bot can't read; don't fail the whole search
        continue;
      }
      if (matches.length >= 25) break;
    }

    if (matches.length === 0) {
      await interaction.editReply(`No matches for \`${query}\` in the last ${lookbackHours}h across channels I can read here.`);
      return;
    }

    const lines = matches.slice(0, 10).map(m =>
      `**#${m.channel}** — ${m.author} (${m.minsAgo} min ago)\n${m.content}\n${m.url}`
    );
    await interaction.editReply(lines.join('\n\n'));
  } catch (e) {
    await interaction.editReply(`Search failed: ${e.message}`);
  }
});

registerCommands().then(() => client.login(TOKEN));
