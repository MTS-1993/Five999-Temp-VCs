import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';

const requiredEnv = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'CREATE_VC_ID',
  'TEMP_CATEGORY_ID',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[CONFIG] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  createVcId: process.env.CREATE_VC_ID,
  tempCategoryId: process.env.TEMP_CATEGORY_ID,
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  defaultUserLimit: Math.max(0, Math.min(99, Number.parseInt(process.env.DEFAULT_USER_LIMIT || '0', 10) || 0)),
  prefix: (process.env.TEMP_VC_PREFIX || '🔊').trim(),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Runtime state. Ownership is also recoverable after restarts from the owner's
// channel-specific ManageChannels permission overwrite.
const rooms = new Map(); // voiceChannelId -> { ownerId, panelMessageId }
const creationLocks = new Set();

const ownerPermissions = {
  ViewChannel: true,
  Connect: true,
  Speak: true,
  Stream: true,
  MoveMembers: true,
  MuteMembers: true,
  DeafenMembers: true,
  ManageChannels: true,
};

function cleanChannelName(name) {
  const cleaned = String(name || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 100) || 'Temporary VC';
}

function roomNameFor(member) {
  const display = cleanChannelName(member.displayName || member.user.username);
  return cleanChannelName(`${config.prefix} ${display}'s VC`);
}

function customId(action, channelId) {
  return `tempvc:${action}:${channelId}`;
}

function parseCustomId(value) {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'tempvc') return null;
  return { action: parts[1], channelId: parts[2] };
}

function controlComponents(channelId, isLocked = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('rename', channelId))
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId(isLocked ? 'unlock' : 'lock', channelId))
      .setLabel(isLocked ? 'Unlock' : 'Lock')
      .setEmoji(isLocked ? '🔓' : '🔒')
      .setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId('limit', channelId))
      .setLabel('User Limit')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId('delete', channelId))
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('permit', channelId))
      .setLabel('Permit User')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId('reject', channelId))
      .setLabel('Remove User')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId('transfer', channelId))
      .setLabel('Transfer Owner')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Primary),
  );

  return [row1, row2];
}

function panelEmbed(channel, ownerId) {
  return new EmbedBuilder()
    .setTitle('Five999 Temporary VC Control')
    .setDescription([
      `Voice channel: <#${channel.id}>`,
      `Owner: <@${ownerId}>`,
      '',
      'Use the buttons below to manage this temporary voice channel.',
      'Only the current VC owner can use these controls.',
      '',
      '**Controls**',
      '✏️ Rename • 🔒 Lock/Unlock • 👥 User Limit',
      '✅ Permit User • 🚫 Remove User • 👑 Transfer Owner • 🗑️ Delete',
    ].join('\n'))
    .setFooter({ text: `Five999 Temp VC • ${channel.id}` })
    .setTimestamp();
}

async function getGuild() {
  return client.guilds.fetch(config.guildId);
}

async function logEvent(guild, text) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => null);
}

function findOwnerFromOverwrites(channel) {
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== 1) continue; // member overwrite
    if (overwrite.allow.has(PermissionFlagsBits.ManageChannels)) return overwrite.id;
  }
  return null;
}

function isLocked(channel) {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  return Boolean(everyone?.deny.has(PermissionFlagsBits.Connect));
}

async function refreshPanel(channelId) {
  const state = rooms.get(channelId);
  if (!state?.panelMessageId) return;
  const guild = await getGuild();
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(state.panelMessageId).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [panelEmbed(channel, state.ownerId)],
    components: controlComponents(channel.id, isLocked(channel)),
  }).catch(() => null);
}

async function createPanel(channel, ownerId) {
  const message = await channel.send({
    embeds: [panelEmbed(channel, ownerId)],
    components: controlComponents(channel.id, isLocked(channel)),
    allowedMentions: { parse: [] },
  });
  rooms.set(channel.id, { ownerId, panelMessageId: message.id });
  return message;
}

async function deletePanel(channelId) {
  const state = rooms.get(channelId);
  if (!state?.panelMessageId) return;
  const guild = await getGuild().catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  const message = await channel.messages.fetch(state.panelMessageId).catch(() => null);
  if (message) await message.delete().catch(() => null);
}

async function createTemporaryRoom(member) {
  if (creationLocks.has(member.id)) return;
  creationLocks.add(member.id);

  try {
    const guild = member.guild;

    // If they already own a temp room, move them back to it instead of creating duplicates.
    for (const [channelId, state] of rooms) {
      if (state.ownerId !== member.id) continue;
      const existing = await guild.channels.fetch(channelId).catch(() => null);
      if (existing?.type === ChannelType.GuildVoice) {
        await member.voice.setChannel(existing).catch(() => null);
        return;
      }
    }

    const channel = await guild.channels.create({
      name: roomNameFor(member),
      type: ChannelType.GuildVoice,
      parent: config.tempCategoryId,
      userLimit: config.defaultUserLimit,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
        },
        {
          id: member.id,
          allow: Object.entries(ownerPermissions)
            .filter(([, enabled]) => enabled)
            .map(([name]) => PermissionFlagsBits[name]),
        },
      ],
      reason: `Five999 temporary VC created for ${member.user.tag}`,
    });

    await createPanel(channel, member.id);
    await member.voice.setChannel(channel, 'Move member into their Five999 temporary VC').catch(async () => {
      await deletePanel(channel.id);
      rooms.delete(channel.id);
      await channel.delete('Unable to move creator into temporary VC').catch(() => null);
      throw new Error('The bot could not move the member into the temporary voice channel.');
    });

    await logEvent(guild, `[Temp VC] Created ${channel.name} (${channel.id}) for ${member.user.tag} (${member.id}).`);
  } finally {
    creationLocks.delete(member.id);
  }
}

async function transferOwnership(channel, oldOwnerId, newOwnerId, reason = 'Ownership transferred') {
  if (oldOwnerId === newOwnerId) return;

  await channel.permissionOverwrites.edit(oldOwnerId, {
    ManageChannels: null,
    MoveMembers: null,
    MuteMembers: null,
    DeafenMembers: null,
  }, { reason });

  await channel.permissionOverwrites.edit(newOwnerId, ownerPermissions, { reason });

  const state = rooms.get(channel.id) || {};
  rooms.set(channel.id, { ...state, ownerId: newOwnerId });
  await refreshPanel(channel.id);
}

async function cleanUpRoom(channel) {
  if (!rooms.has(channel.id)) return;
  if (channel.members.size > 0) return;

  await deletePanel(channel.id);
  rooms.delete(channel.id);
  await logEvent(channel.guild, `[Temp VC] Deleted empty room ${channel.name} (${channel.id}).`);
  await channel.delete('Five999 temporary VC became empty').catch(() => null);
}

async function recoverRooms() {
  const guild = await getGuild();
  const channels = await guild.channels.fetch();

  for (const [, channel] of channels) {
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== config.tempCategoryId) continue;
    if (channel.id === config.createVcId) continue;

    const ownerId = findOwnerFromOverwrites(channel);
    if (!ownerId) continue;

    let panelMessageId = null;
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (messages) {
      const panel = messages.find((msg) =>
        msg.author.id === client.user.id &&
        msg.embeds?.[0]?.footer?.text?.endsWith(channel.id)
      );
      panelMessageId = panel?.id || null;
    }

    rooms.set(channel.id, { ownerId, panelMessageId });

    if (!panelMessageId) {
      await createPanel(channel, ownerId).catch((error) => console.error('[RECOVERY] Panel creation failed:', error));
    } else {
      await refreshPanel(channel.id);
    }

    if (channel.members.size === 0) {
      await cleanUpRoom(channel);
    }
  }

  console.log(`[RECOVERY] Tracking ${rooms.size} temporary voice channel(s).`);
}

async function ensureOwner(interaction, channelId) {
  const guild = await getGuild();
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== config.tempCategoryId) {
    await interaction.reply({ content: 'This temporary VC no longer exists.', ephemeral: true }).catch(() => null);
    return null;
  }

  let state = rooms.get(channelId);
  if (!state) {
    const ownerId = findOwnerFromOverwrites(channel);
    if (ownerId) {
      state = { ownerId, panelMessageId: interaction.message?.id || null };
      rooms.set(channelId, state);
    }
  }

  if (!state || state.ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Only the owner of this temporary VC can use these controls.', ephemeral: true }).catch(() => null);
    return null;
  }

  return { guild, channel, state };
}

function buildUserSelect(action, channelId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId(action, channelId))
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

client.once('clientReady', async () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  try {
    const guild = await getGuild();
    console.log(`[READY] Connected to ${guild.name} (${guild.id})`);
    await recoverRooms();
  } catch (error) {
    console.error('[READY] Configuration validation failed:', error);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (newState.channelId === config.createVcId && oldState.channelId !== config.createVcId && newState.member) {
      await createTemporaryRoom(newState.member);
    }

    if (oldState.channelId && rooms.has(oldState.channelId)) {
      const channel = oldState.guild.channels.cache.get(oldState.channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) return;

      const state = rooms.get(channel.id);
      if (state && oldState.member?.id === state.ownerId && newState.channelId !== channel.id && channel.members.size > 0) {
        const nextOwner = channel.members.find((member) => !member.user.bot);
        if (nextOwner) {
          await transferOwnership(channel, state.ownerId, nextOwner.id, 'Automatic owner transfer after owner left');
          await logEvent(channel.guild, `[Temp VC] Ownership of ${channel.name} (${channel.id}) transferred to ${nextOwner.user.tag} (${nextOwner.id}) because the previous owner left.`);
        }
      }

      await cleanUpRoom(channel);
    }
  } catch (error) {
    console.error('[VOICE] Error:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction.isButton() || interaction.isUserSelectMenu() || interaction.isModalSubmit())) return;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    const access = await ensureOwner(interaction, parsed.channelId);
    if (!access) return;
    const { channel, state } = access;

    if (interaction.isButton()) {
      if (parsed.action === 'rename') {
        const modal = new ModalBuilder()
          .setCustomId(customId('renameSubmit', channel.id))
          .setTitle('Rename Temporary VC');
        const input = new TextInputBuilder()
          .setCustomId('name')
          .setLabel('New voice channel name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(100)
          .setValue(channel.name.slice(0, 100));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (parsed.action === 'limit') {
        const modal = new ModalBuilder()
          .setCustomId(customId('limitSubmit', channel.id))
          .setTitle('Set User Limit');
        const input = new TextInputBuilder()
          .setCustomId('limit')
          .setLabel('User limit (0 = unlimited, 1-99 otherwise)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(channel.userLimit || 0));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (parsed.action === 'lock') {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { Connect: false }, { reason: `Locked by ${interaction.user.tag}` });
        await interaction.reply({ content: `🔒 <#${channel.id}> is now locked.`, ephemeral: true });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'unlock') {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { Connect: null }, { reason: `Unlocked by ${interaction.user.tag}` });
        await interaction.reply({ content: `🔓 <#${channel.id}> is now unlocked.`, ephemeral: true });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'permit') {
        return interaction.reply({
          content: 'Choose a user to permit into this VC:',
          components: [buildUserSelect('permitSelect', channel.id, 'Select a user to permit')],
          ephemeral: true,
        });
      }

      if (parsed.action === 'reject') {
        return interaction.reply({
          content: 'Choose a user to remove/deny from this VC:',
          components: [buildUserSelect('rejectSelect', channel.id, 'Select a user to remove')],
          ephemeral: true,
        });
      }

      if (parsed.action === 'transfer') {
        return interaction.reply({
          content: 'Choose the new owner. They must currently be connected to your temporary VC.',
          components: [buildUserSelect('transferSelect', channel.id, 'Select the new VC owner')],
          ephemeral: true,
        });
      }

      if (parsed.action === 'delete') {
        await interaction.reply({ content: `🗑️ Deleting <#${channel.id}>.`, ephemeral: true });
        await deletePanel(channel.id);
        rooms.delete(channel.id);
        await logEvent(channel.guild, `[Temp VC] ${interaction.user.tag} (${interaction.user.id}) deleted ${channel.name} (${channel.id}).`);
        await channel.delete(`Deleted by temporary VC owner ${interaction.user.tag}`).catch(() => null);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (parsed.action === 'renameSubmit') {
        const name = cleanChannelName(interaction.fields.getTextInputValue('name'));
        await channel.setName(name, `Renamed by temporary VC owner ${interaction.user.tag}`);
        await interaction.reply({ content: `✏️ VC renamed to **${name}**.`, ephemeral: true });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'limitSubmit') {
        const raw = interaction.fields.getTextInputValue('limit').trim();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 99) {
          return interaction.reply({ content: 'Enter a whole number from **0 to 99**. `0` means unlimited.', ephemeral: true });
        }
        await channel.setUserLimit(value, `User limit changed by ${interaction.user.tag}`);
        return interaction.reply({ content: `👥 User limit set to **${value === 0 ? 'Unlimited' : value}**.`, ephemeral: true });
      }
    }

    if (interaction.isUserSelectMenu()) {
      const selectedId = interaction.values[0];
      const member = await channel.guild.members.fetch(selectedId).catch(() => null);
      if (!member) return interaction.update({ content: 'That user could not be found in Five999.', components: [] });
      if (member.user.bot) return interaction.update({ content: 'Bots cannot be selected for this action.', components: [] });

      if (parsed.action === 'permitSelect') {
        await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true }, { reason: `Permitted by ${interaction.user.tag}` });
        return interaction.update({ content: `✅ ${member} can now join <#${channel.id}>.`, components: [] });
      }

      if (parsed.action === 'rejectSelect') {
        if (member.id === state.ownerId) {
          return interaction.update({ content: 'You cannot remove yourself as the VC owner. Transfer ownership first.', components: [] });
        }
        await channel.permissionOverwrites.edit(member.id, { Connect: false }, { reason: `Removed by ${interaction.user.tag}` });
        if (member.voice.channelId === channel.id) {
          await member.voice.disconnect(`Removed from temporary VC by ${interaction.user.tag}`).catch(() => null);
        }
        return interaction.update({ content: `🚫 ${member} has been removed and denied access to <#${channel.id}>.`, components: [] });
      }

      if (parsed.action === 'transferSelect') {
        if (member.id === state.ownerId) {
          return interaction.update({ content: 'That user is already the owner.', components: [] });
        }
        if (member.voice.channelId !== channel.id) {
          return interaction.update({ content: 'The new owner must currently be connected to this temporary VC.', components: [] });
        }
        await transferOwnership(channel, state.ownerId, member.id, `Ownership transferred by ${interaction.user.tag}`);
        await logEvent(channel.guild, `[Temp VC] ${interaction.user.tag} (${interaction.user.id}) transferred ${channel.name} (${channel.id}) to ${member.user.tag} (${member.id}).`);
        return interaction.update({ content: `👑 Ownership transferred to ${member}.`, components: [] });
      }
    }
  } catch (error) {
    console.error('[INTERACTION] Error:', error);
    const payload = { content: 'Something went wrong while managing that temporary VC. Please try again.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

client.on('channelDelete', async (channel) => {
  if (!rooms.has(channel.id)) return;
  await deletePanel(channel.id).catch(() => null);
  rooms.delete(channel.id);
});

process.on('unhandledRejection', (error) => console.error('[UNHANDLED REJECTION]', error));
process.on('uncaughtException', (error) => console.error('[UNCAUGHT EXCEPTION]', error));

client.login(config.token);
