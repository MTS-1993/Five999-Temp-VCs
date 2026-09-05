import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
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

function customId(action, channelId, ownerId = null) {
  const resolvedOwnerId = ownerId || rooms.get(channelId)?.ownerId || 'unknown';
  return `tempvc:${action}:${channelId}:${resolvedOwnerId}`;
}

function parseCustomId(value) {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'tempvc') return null;
  return { action: parts[1], channelId: parts[2], ownerId: parts[3] };
}

async function respondPrivate(interaction, content) {
  const payload = { content, components: [], flags: MessageFlags.Ephemeral };
  if (interaction.deferred) return interaction.editReply({ content, components: [] }).catch(() => null);
  if (interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
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
    if (overwrite.id === client.user?.id) continue; // never mistake the bot's own overwrite for the VC owner
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
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(state.panelMessageId).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [panelEmbed(channel, state.ownerId)],
    components: controlComponents(channel.id, isLocked(channel)),
  });
}

async function createPanel(channel, ownerId) {
  if (!channel.isTextBased()) throw new Error(`Temporary VC ${channel.id} does not support channel chat.`);
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
  if (!channel || !channel.isTextBased()) return;
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
          id: guild.members.me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
          ],
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
    if (channel.isTextBased()) {
      const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const panel = messages?.find((msg) =>
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

async function ensureOwner(interaction, channelId, ownerIdFromControl) {
  const guild = await getGuild();
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== config.tempCategoryId) {
    await respondPrivate(interaction, 'This temporary VC no longer exists.');
    return null;
  }

  let state = rooms.get(channelId);
  const recoveredOwnerId = findOwnerFromOverwrites(channel);
  const controlOwnerId = ownerIdFromControl && ownerIdFromControl !== 'unknown' ? ownerIdFromControl : null;
  const authoritativeOwnerId = recoveredOwnerId || state?.ownerId || controlOwnerId;

  if (authoritativeOwnerId) {
    state = { ownerId: authoritativeOwnerId, panelMessageId: state?.panelMessageId || interaction.message?.id || null };
    rooms.set(channelId, state);
  }

  if (!state || state.ownerId !== interaction.user.id) {
    await respondPrivate(interaction, 'Only the owner of this temporary VC can use these controls.');
    return null;
  }

  return { guild, channel, state };
}

function getFastOwnerAccess(interaction, channelId, ownerIdFromControl) {
  const channel = interaction.guild?.channels?.cache?.get(channelId) || null;
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== config.tempCategoryId) {
    return { error: 'This temporary VC no longer exists.' };
  }

  const state = rooms.get(channelId);
  const controlOwnerId = ownerIdFromControl && ownerIdFromControl !== 'unknown' ? ownerIdFromControl : null;
  const ownerId = state?.ownerId || controlOwnerId;

  if (!ownerId || ownerId !== interaction.user.id) {
    return { error: 'Only the owner of this temporary VC can use these controls.' };
  }

  return { channel, state: state || { ownerId, panelMessageId: interaction.message?.id || null } };
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

    const me = guild.members.me || await guild.members.fetchMe();
    const requiredGuildPerms = [
      ['ManageChannels', PermissionFlagsBits.ManageChannels],
      ['ManageRoles', PermissionFlagsBits.ManageRoles],
      ['MoveMembers', PermissionFlagsBits.MoveMembers],
      ['MuteMembers', PermissionFlagsBits.MuteMembers],
      ['DeafenMembers', PermissionFlagsBits.DeafenMembers],
    ];
    const missingGuildPerms = requiredGuildPerms
      .filter(([, bit]) => !me.permissions.has(bit))
      .map(([name]) => name);
    if (missingGuildPerms.length) {
      console.error(`[PERMISSIONS] Bot role is missing server permissions: ${missingGuildPerms.join(', ')}`);
      console.error('[PERMISSIONS] ManageRoles is required for Lock/Unlock, Permit User, Remove User and ownership permission changes.');
    } else {
      console.log('[PERMISSIONS] Required server permissions are present.');
      console.log('[PERMISSIONS] ManageRoles is held at server-role level and is intentionally not included in temporary VC overwrites.');
    }

    const category = await guild.channels.fetch(config.tempCategoryId).catch(() => null);
    if (category) {
      const effective = category.permissionsFor(me);
      const requiredCategoryPerms = [
        ['ViewChannel', PermissionFlagsBits.ViewChannel],
        ['ManageChannels', PermissionFlagsBits.ManageChannels],
        ['Connect', PermissionFlagsBits.Connect],
        ['SendMessages', PermissionFlagsBits.SendMessages],
        ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
        ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
      ];
      const missingCategoryPerms = requiredCategoryPerms
        .filter(([, bit]) => !effective?.has(bit))
        .map(([name]) => name);
      if (missingCategoryPerms.length) {
        console.error(`[PERMISSIONS] Temp VC category is missing effective bot permissions: ${missingCategoryPerms.join(', ')}`);
      } else {
        console.log('[PERMISSIONS] Temp VC category permissions look good.');
      }
    }

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

    // Modal-opening buttons must be answered with showModal() as the ORIGINAL
    // interaction response. Do not perform REST fetches before this point or
    // Discord may expire the interaction (10062 Unknown interaction).
    if (interaction.isButton() && (parsed.action === 'rename' || parsed.action === 'limit')) {
      const fast = getFastOwnerAccess(interaction, parsed.channelId, parsed.ownerId);
      if (fast.error) {
        return interaction.reply({ content: fast.error, flags: MessageFlags.Ephemeral });
      }
      const { channel } = fast;

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
        await interaction.showModal(modal);
        return;
      }

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
      await interaction.showModal(modal);
      return;
    }

    // User selects and modal submissions can involve multiple API requests.
    // Acknowledge once up front, then only edit that response.
    if (interaction.isUserSelectMenu()) {
      await interaction.deferUpdate();
    } else if (interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // For buttons that display a select menu, use the in-memory owner state so
    // the initial reply is immediate and cannot time out.
    if (interaction.isButton() && ['permit', 'reject', 'transfer'].includes(parsed.action)) {
      const fast = getFastOwnerAccess(interaction, parsed.channelId, parsed.ownerId);
      if (fast.error) {
        return interaction.reply({ content: fast.error, flags: MessageFlags.Ephemeral });
      }
      const { channel } = fast;

      if (parsed.action === 'permit') {
        return interaction.reply({
          content: 'Choose a user to permit into this VC:',
          components: [buildUserSelect('permitSelect', channel.id, 'Select a user to permit')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (parsed.action === 'reject') {
        return interaction.reply({
          content: 'Choose a user to remove/deny from this VC:',
          components: [buildUserSelect('rejectSelect', channel.id, 'Select a user to remove')],
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: 'Choose the new owner. They must currently be connected to your temporary VC.',
        components: [buildUserSelect('transferSelect', channel.id, 'Select the new VC owner')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Slower direct-action buttons are deferred before REST work.
    if (interaction.isButton()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const access = await ensureOwner(interaction, parsed.channelId, parsed.ownerId);
    if (!access) return;
    const { channel, state } = access;

    if (interaction.isButton()) {
      if (parsed.action === 'lock') {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { Connect: false }, { reason: `Locked by ${interaction.user.tag}` });
        await interaction.editReply({ content: `🔒 <#${channel.id}> is now locked.`, components: [] });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'unlock') {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, { Connect: null }, { reason: `Unlocked by ${interaction.user.tag}` });
        await interaction.editReply({ content: `🔓 <#${channel.id}> is now unlocked.`, components: [] });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'delete') {
        await interaction.editReply({ content: `🗑️ Deleting <#${channel.id}>.`, components: [] });
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
        await interaction.editReply({ content: `✏️ VC renamed to **${name}**.`, components: [] });
        await refreshPanel(channel.id);
        return;
      }

      if (parsed.action === 'limitSubmit') {
        const raw = interaction.fields.getTextInputValue('limit').trim();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 99) {
          return interaction.editReply({ content: 'Enter a whole number from **0 to 99**. `0` means unlimited.', components: [] });
        }
        await channel.setUserLimit(value, `User limit changed by ${interaction.user.tag}`);
        return interaction.editReply({ content: `👥 User limit set to **${value === 0 ? 'Unlimited' : value}**.`, components: [] });
      }
    }

    if (interaction.isUserSelectMenu()) {
      const selectedId = interaction.values[0];
      const member = await channel.guild.members.fetch(selectedId).catch(() => null);
      if (!member) return interaction.editReply({ content: 'That user could not be found in Five999.', components: [] });
      if (member.user.bot) return interaction.editReply({ content: 'Bots cannot be selected for this action.', components: [] });

      if (parsed.action === 'permitSelect') {
        await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true }, { reason: `Permitted by ${interaction.user.tag}` });
        return interaction.editReply({ content: `✅ ${member} can now join <#${channel.id}>.`, components: [] });
      }

      if (parsed.action === 'rejectSelect') {
        if (member.id === state.ownerId) {
          return interaction.editReply({ content: 'You cannot remove yourself as the VC owner. Transfer ownership first.', components: [] });
        }
        await channel.permissionOverwrites.edit(member.id, { Connect: false }, { reason: `Removed by ${interaction.user.tag}` });
        if (member.voice.channelId === channel.id) {
          await member.voice.disconnect(`Removed from temporary VC by ${interaction.user.tag}`).catch(() => null);
        }
        return interaction.editReply({ content: `🚫 ${member} has been removed and denied access to <#${channel.id}>.`, components: [] });
      }

      if (parsed.action === 'transferSelect') {
        if (member.id === state.ownerId) {
          return interaction.editReply({ content: 'That user is already the owner.', components: [] });
        }
        if (member.voice.channelId !== channel.id) {
          return interaction.editReply({ content: 'The new owner must currently be connected to this temporary VC.', components: [] });
        }
        await transferOwnership(channel, state.ownerId, member.id, `Ownership transferred by ${interaction.user.tag}`);
        await logEvent(channel.guild, `[Temp VC] ${interaction.user.tag} (${interaction.user.id}) transferred ${channel.name} (${channel.id}) to ${member.user.tag} (${member.id}).`);
        return interaction.editReply({ content: `👑 Ownership transferred to ${member}.`, components: [] });
      }
    }
  } catch (error) {
    console.error(`[INTERACTION] ${interaction.customId || 'unknown'} failed:`, error);
    const content = 'Something went wrong while managing that temporary VC. Please try again.';
    if (interaction.deferred) {
      await interaction.editReply({ content, components: [] }).catch(() => null);
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
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
