require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior
} = require('@discordjs/voice');

const googleTTS = require('google-tts-api');

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || 'ry!';
const VERIFIED_ROLE_NAME =
  process.env.VERIFIED_ROLE_NAME || 'Verified';
const STAFF_ROLE_NAME =
  process.env.STAFF_ROLE_NAME || 'Staff';
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || 'id';

if (!TOKEN) {
  console.error('Isi DISCORD_TOKEN di file .env!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message
  ]
});

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let config = { guilds: {} };

if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(
      fs.readFileSync(CONFIG_PATH, 'utf8')
    );
  } catch (error) {
    console.error('Gagal membaca config.json:', error);
  }
}

const welcomeQueue = new Map();
const welcomeBusy = new Set();
const ticketCreateLocks = new Set();

function saveConfig() {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(config, null, 2)
  );
}

function guildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {};
  }

  return config.guilds[guildId];
}

function isStaff(member) {
  if (!member) return false;

  return (
    member.permissions.has(
      PermissionFlagsBits.Administrator
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ManageGuild
    ) ||
    member.roles.cache.some(
      role => role.name === STAFF_ROLE_NAME
    )
  );
}

function moneyIDR(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value);
}

function safeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function findOrCreateRole(guild, name, options = {}) {
  let role = guild.roles.cache.find(
    item => item.name === name
  );

  if (!role) {
    role = await guild.roles.create({
      name,
      ...options,
      reason: 'Setup bot RY'
    });
  }

  return role;
}

async function findOrCreateCategory(guild, name) {
  let category = guild.channels.cache.find(
    channel =>
      channel.type === ChannelType.GuildCategory &&
      channel.name === name
  );

  if (!category) {
    category = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      reason: 'Setup bot RY'
    });
  }

  return category;
}

async function findOrCreateChannel(
  guild,
  name,
  type,
  options = {}
) {
  let channel = guild.channels.cache.find(
    item => item.name === name && item.type === type
  );

  if (!channel) {
    channel = await guild.channels.create({
      name,
      type,
      ...options,
      reason: 'Setup bot RY'
    });
  }

  return channel;
}

// ===============================
// SETUP WELCOME
// ===============================

async function setupWelcome(guild) {
  const cfg = guildConfig(guild.id);

  const verifiedRole = await findOrCreateRole(
    guild,
    VERIFIED_ROLE_NAME,
    { color: 0x57f287 }
  );

  const category = await findOrCreateCategory(
    guild,
    'RY・WELCOME'
  );

  const voice = await findOrCreateChannel(
    guild,
    '🔊・welcome',
    ChannelType.GuildVoice,
    { parent: category.id }
  );

  cfg.verifiedRoleId = verifiedRole.id;
  cfg.welcomeCategoryId = category.id;
  cfg.welcomeVoiceChannelId = voice.id;

  saveConfig();

  return { verifiedRole, category, voice };
}

// ===============================
// SETUP TICKET
// ===============================

async function setupTicket(guild) {
  const cfg = guildConfig(guild.id);

  const staffRole = await findOrCreateRole(
    guild,
    STAFF_ROLE_NAME,
    { color: 0x5865f2 }
  );

  const category = await findOrCreateCategory(
    guild,
    'RY・TICKETS'
  );

  const panel = await findOrCreateChannel(
    guild,
    '🎫・open-ticket',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Panel untuk membuka ticket.'
    }
  );

  const logs = await findOrCreateChannel(
    guild,
    '📑・ticket-logs',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Log transcript ticket.'
    }
  );

  cfg.staffRoleId = staffRole.id;
  cfg.ticketCategoryId = category.id;
  cfg.ticketPanelChannelId = panel.id;
  cfg.ticketLogsChannelId = logs.id;

  saveConfig();

  const recent = await panel.messages.fetch({
    limit: 20
  }).catch(() => null);

  const exists = recent?.some(message =>
    message.author.id === client.user.id &&
    message.components.some(row =>
      row.components.some(
        component =>
          component.customId === 'ry_ticket_category'
      )
    )
  );

  if (!exists) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎫 Ticket Support')
      .setDescription(
        'Pilih kategori untuk membuka ticket privat.'
      )
      .setFooter({ text: 'RY Support System' });

    const select = new StringSelectMenuBuilder()
      .setCustomId('ry_ticket_category')
      .setPlaceholder('Pilih kategori ticket...')
      .addOptions(
        {
          label: 'Pembelian / Order',
          value: 'order',
          emoji: '🛒'
        },
        {
          label: 'Bantuan',
          value: 'support',
          emoji: '🛟'
        },
        {
          label: 'Lainnya',
          value: 'other',
          emoji: '💬'
        }
      );

    await panel.send({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(select)
      ]
    });
  }

  return { staffRole, category, panel, logs };
}

// ===============================
// SETUP VOUCHES
// ===============================

async function setupVouches(guild) {
  const cfg = guildConfig(guild.id);

  const channel = await findOrCreateChannel(
    guild,
    '💸・vouches',
    ChannelType.GuildText,
    {
      topic: 'Bukti transaksi dan testimoni pembeli.'
    }
  );

  cfg.vouchesChannelId = channel.id;
  saveConfig();

  return channel;
}

async function setupAll(guild) {
  const welcome = await setupWelcome(guild);
  const ticket = await setupTicket(guild);
  const vouches = await setupVouches(guild);

  return { welcome, ticket, vouches };
}

// ===============================
// AUDIO TTS
// ===============================

async function speakWelcome(channel, text) {
  const audioUrl = googleTTS.getAudioUrl(
    text.slice(0, 190),
    {
      lang: TTS_LANGUAGE,
      slow: false,
      host: 'https://translate.google.com'
    }
  );

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error('Gagal mengambil audio TTS.');
  }

  const bytes = Buffer.from(
    await response.arrayBuffer()
  );

  const tempFile = path.join(
    os.tmpdir(),
    `ry-tts-${Date.now()}.mp3`
  );

  fs.writeFileSync(tempFile, bytes);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play
    }
  });

  connection.subscribe(player);

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      20000
    );

    player.play(createAudioResource(tempFile));

    await entersState(
      player,
      AudioPlayerStatus.Playing,
      20000
    );

    await entersState(
      player,
      AudioPlayerStatus.Idle,
      120000
    );
  } finally {
    player.stop(true);
    connection.destroy();

    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
}

function enqueueWelcome(member, channel) {
  const guildId = member.guild.id;

  if (!welcomeQueue.has(guildId)) {
    welcomeQueue.set(guildId, []);
  }

  welcomeQueue.get(guildId).push({
    memberId: member.id,
    channelId: channel.id
  });

  processWelcomeQueue(member.guild).catch(console.error);
}

async function processWelcomeQueue(guild) {
  const guildId = guild.id;

  if (welcomeBusy.has(guildId)) return;

  welcomeBusy.add(guildId);

  try {
    const queue = welcomeQueue.get(guildId) || [];

    while (queue.length) {
      const item = queue.shift();

      const member = await guild.members.fetch(
        item.memberId
      ).catch(() => null);

      const channel = guild.channels.cache.get(
        item.channelId
      );

      const cfg = guildConfig(guildId);

      if (
        !member ||
        !channel ||
        member.user.bot ||
        member.voice.channelId !== item.channelId
      ) {
        continue;
      }

      const verifiedRole = guild.roles.cache.get(
        cfg.verifiedRoleId
      );

      if (!verifiedRole) continue;

      try {
        await speakWelcome(
          channel,
          `Halo ${member.displayName}, selamat datang di server kami. Setelah pesan ini selesai, akses server kamu akan dibuka. Terima kasih sudah bergabung.`
        );

        const refreshed = await guild.members.fetch(
          member.id
        ).catch(() => null);

        if (
          refreshed &&
          refreshed.voice.channelId === item.channelId &&
          !refreshed.roles.cache.has(verifiedRole.id)
        ) {
          await refreshed.roles.add(
            verifiedRole,
            'Selesai audio welcome RY'
          );

          await refreshed.send(
            `Selamat datang di ${guild.name}! Role ${verifiedRole.name} sudah diberikan.`
          ).catch(() => {});
        }
      } catch (error) {
        console.error('Welcome TTS gagal:', error);
      }
    }
  } finally {
    welcomeBusy.delete(guildId);
  }
}

// ===============================
// TRANSCRIPT TICKET
// ===============================

async function sendTicketTranscript(channel, closedBy) {
  const messages = [];
  let before;

  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    }).catch(() => null);

    if (!batch || batch.size === 0) break;

    messages.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) break;
  }

  messages.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const body = messages.map(message => {
    const time = new Date(
      message.createdTimestamp
    ).toISOString();

    const content = safeText(
      message.cleanContent || '[tanpa teks]'
    );

    const attachments = [
      ...message.attachments.values()
    ].map(file =>
      `<p><a href="${safeText(file.url)}">${safeText(file.name || 'attachment')}</a></p>`
    ).join('');

    return `
      <article>
        <small>${safeText(message.author.tag)} — ${time}</small>
        <p>${content.replaceAll('\n', '<br>')}</p>
        ${attachments}
      </article>
    `;
  }).join('\n');

  const html = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>RY Ticket Transcript</title>
      <style>
        body { font: 15px Arial; margin: 24px; }
        article { border-bottom: 1px solid #ddd; padding: 12px; }
        small { color: #666; }
      </style>
    </head>
    <body>
      <h1>Transcript ${safeText(channel.name)}</h1>
      <p>Ditutup oleh ${safeText(closedBy.tag)}</p>
      ${body}
    </body>
    </html>
  `;

  const filePath = path.join(
    os.tmpdir(),
    `ry-transcript-${channel.id}.html`
  );

  fs.writeFileSync(filePath, html, 'utf8');

  return {
    filePath,
    attachment: new AttachmentBuilder(filePath, {
      name: `${channel.name}-transcript.html`
    }),
    messageCount: messages.length
  };
}

async function closeTicket(channel, closedBy) {
  const cfg = guildConfig(channel.guild.id);

  const logs = cfg.ticketLogsChannelId
    ? channel.guild.channels.cache.get(
        cfg.ticketLogsChannelId
      )
    : null;

  const transcript = await sendTicketTranscript(
    channel,
    closedBy
  );

  if (logs?.isTextBased()) {
    await logs.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('Ticket ditutup')
          .addFields(
            {
              name: 'Channel',
              value: `#${channel.name}`,
              inline: true
            },
            {
              name: 'Ditutup oleh',
              value: `${closedBy}`,
              inline: true
            },
            {
              name: 'Jumlah pesan',
              value: String(transcript.messageCount),
              inline: true
            }
          )
          .setTimestamp()
      ],
      files: [transcript.attachment]
    }).catch(console.error);
  }

  try {
    fs.unlinkSync(transcript.filePath);
  } catch {}

  await channel.send(
    'Ticket ditutup. Transcript dikirim ke log.'
  ).catch(() => {});

  setTimeout(() => {
    channel.delete('Ticket ditutup').catch(() => {});
  }, 5000);
}

// ===============================
// MEMBUAT TICKET PRIVAT
// ===============================

async function createTicket(interaction, categoryKey) {
  const guild = interaction.guild;
  const member = interaction.member;
  const cfg = guildConfig(guild.id);

  const category = guild.channels.cache.get(
    cfg.ticketCategoryId
  );

  const staffRole = guild.roles.cache.get(
    cfg.staffRoleId
  );

  if (!category || !staffRole) {
    return interaction.reply({
      content: 'Jalankan ry!setup ticket terlebih dahulu.',
      ephemeral: true
    });
  }

  const lockKey = `${guild.id}:${member.id}`;

  if (ticketCreateLocks.has(lockKey)) {
    return interaction.reply({
      content: 'Ticket sedang diproses.',
      ephemeral: true
    });
  }

  ticketCreateLocks.add(lockKey);

  try {
    const existing = guild.channels.cache.find(
      channel =>
        channel.parentId === category.id &&
        channel.topic?.includes(`ticket-owner:${member.id}`)
    );

    if (existing) {
      return interaction.reply({
        content: `Kamu masih punya ticket terbuka: ${existing}`,
        ephemeral: true
      });
    }

    const labels = {
      order: 'order',
      support: 'bantuan',
      other: 'lainnya'
    };

    const label = labels[categoryKey] || 'bantuan';

    const ticketChannel = await guild.channels.create({
      name: `ticket-${label}-${member.user.username}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 90),

      type: ChannelType.GuildText,
      parent: category.id,
      topic: `ticket-owner:${member.id}; kategori:${label}`,

      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles
          ]
        },
        {
          id: staffRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageMessages
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ]
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Ticket dibuat')
      .setDescription(
        `Halo ${member}, staff akan membantu kamu. Jelaskan kebutuhanmu di sini.`
      )
      .addFields({
        name: 'Kategori',
        value: label
      })
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ry_ticket_claim')
        .setLabel('Claim Ticket')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('ry_ticket_close')
        .setLabel('Tutup Ticket')
        .setStyle(ButtonStyle.Danger)
    );

    await ticketChannel.send({
      content: `${member} <@&${staffRole.id}>`,
      embeds: [embed],
      components: [buttons],
      allowedMentions: {
        users: [member.id],
        roles: [staffRole.id]
      }
    });

    await interaction.reply({
      content: `Ticket berhasil dibuat: ${ticketChannel}`,
      ephemeral: true
    });
  } finally {
    ticketCreateLocks.delete(lockKey);
  }
}

// ===============================
// PARSER VOUCHES
// ===============================

function parseVouchArgs(content, attachmentUrl) {
  const raw = content
    .slice(`${PREFIX}vouches`.length)
    .trim();

  const urlMatch = raw.match(/https?:\/\/\S+/i);
  const mentionMatch = raw.match(/<@!?(\d+)>/);
  const statusMatch = raw.match(/(?:^|\s)(done|pending)\s*$/i);

  const imageUrl = urlMatch?.[0] || attachmentUrl;

  if (!imageUrl || !mentionMatch || !statusMatch) {
    return null;
  }

  let rest = raw;

  if (urlMatch) {
    rest = rest.replace(urlMatch[0], ' ');
  }

  rest = rest.replace(mentionMatch[0], ' ');
  rest = rest.replace(/(?:^|\s)(done|pending)\s*$/i, ' ').trim();

  const priceMatch = rest.match(/(?:^|\s)([\d][\d.,]*)\s*$/);

  if (!priceMatch) return null;

  const price = Number(priceMatch[1].replace(/\D/g, ''));

  const product = rest.slice(0, priceMatch.index).trim();

  if (
    !product ||
    !Number.isSafeInteger(price) ||
    price < 0
  ) {
    return null;
  }

  return {
    imageUrl,
    buyerId: mentionMatch[1],
    product,
    price,
    status: statusMatch[1].toLowerCase()
  };
}

// ===============================
// BOT READY
// ===============================

client.once('ready', () => {
  console.log(`RY aktif sebagai ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'ry!help | RY Support' }],
    status: 'online'
  });
});

// ===============================
// MEMBER BARU
// ===============================

client.on('guildMemberAdd', async member => {
  const cfg = guildConfig(member.guild.id);

  if (cfg.welcomeVoiceChannelId) {
    await member.send(
      `Selamat datang di ${member.guild.name}! Masuk ke channel voice welcome untuk mendengarkan panduan.`
    ).catch(() => {});
  }
});

// ===============================
// MEMBER MASUK VOICE
// ===============================

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!newState.guild || newState.member?.user.bot) return;

  const cfg = guildConfig(newState.guild.id);

  if (!cfg.welcomeVoiceChannelId) return;

  if (
    newState.channelId === cfg.welcomeVoiceChannelId &&
    oldState.channelId !== newState.channelId
  ) {
    enqueueWelcome(newState.member, newState.channel);
  }
});

// ===============================
// PREFIX COMMANDS
// ===============================

client.on('messageCreate', async message => {
  if (
    !message.guild ||
    message.author.bot ||
    !message.content.startsWith(PREFIX)
  ) {
    return;
  }

  const [rawCommand, ...args] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);

  const command = (rawCommand || '').toLowerCase();

  // HELP
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('RY Bot Commands')
      .setDescription([
        '`ry!setup all` — setup semua sistem',
        '`ry!setup welcome` — setup welcome',
        '`ry!setup ticket` — setup ticket',
        '`ry!setup vouches` — setup vouches',
        '`ry!welcome test` — tes audio TTS',
        '`ry!vouches <gambar> @buyer <produk> <harga> <done/pending>`',
        '`ry!ticket close` — tutup ticket'
      ].join('\n'));

    return message.reply({ embeds: [embed] });
  }

  // SETUP
  if (command === 'setup') {
    if (!isStaff(message.member)) {
      return message.reply(
        'Command setup hanya untuk admin atau Staff.'
      );
    }

    const target = (args[0] || '').toLowerCase();

    try {
      if (target === 'welcome') {
        const result = await setupWelcome(message.guild);

        return message.reply(
          `Welcome siap! Voice channel: ${result.voice}. Role: ${result.verifiedRole.name}.`
        );
      }

      if (target === 'ticket') {
        const result = await setupTicket(message.guild);

        return message.reply(
          `Ticket siap! Panel: ${result.panel}. Log: ${result.logs}. Tambahkan staff ke role ${result.staffRole.name}.`
        );
      }

      if (target === 'vouches') {
        const channel = await setupVouches(message.guild);

        return message.reply(
          `Channel vouches siap: ${channel}`
        );
      }

      if (target === 'all') {
        const result = await setupAll(message.guild);

        return message.reply(
          `Setup RY selesai!\n` +
          `Welcome: ${result.welcome.voice}\n` +
          `Ticket: ${result.ticket.panel}\n` +
          `Logs: ${result.ticket.logs}\n` +
          `Vouches: ${result.vouches}\n\n` +
          `Atur permission channel member agar role Verified mendapat akses.`
        );
      }

      return message.reply(
        'Gunakan ry!setup all, welcome, ticket, atau vouches.'
      );
    } catch (error) {
      console.error(error);

      return message.reply(
        'Setup gagal. Periksa izin bot dan console VPS.'
      );
    }
  }

  // TES TTS
  if (
    command === 'welcome' &&
    (args[0] || '').toLowerCase() === 'test'
  ) {
    if (!isStaff(message.member)) {
      return message.reply('Khusus admin atau Staff.');
    }

    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
      return message.reply(
        'Masuk voice channel dulu, lalu jalankan ry!welcome test.'
      );
    }

    try {
      await message.reply('Menjalankan tes TTS...');

      await speakWelcome(
        voiceChannel,
        'Halo, ini adalah tes audio welcome dari bot RY.'
      );
    } catch (error) {
      console.error(error);

      await message.reply(
        'TTS gagal. Periksa FFmpeg dan izin Connect serta Speak.'
      );
    }

    return;
  }

  // VOUCHES
  if (command === 'vouches') {
    if (!isStaff(message.member)) {
      return message.reply(
        'Command vouches hanya untuk admin atau Staff.'
      );
    }

    const cfg = guildConfig(message.guild.id);

    const targetChannel = cfg.vouchesChannelId
      ? message.guild.channels.cache.get(cfg.vouchesChannelId)
      : null;

    if (!targetChannel?.isTextBased()) {
      return message.reply(
        'Jalankan ry!setup vouches terlebih dahulu.'
      );
    }

    const attachment = message.attachments.find(
      item => item.contentType?.startsWith('image/')
    );

    const parsed = parseVouchArgs(
      message.content,
      attachment?.url
    );

    if (!parsed) {
      return message.reply(
        'Format:\n' +
        '`ry!vouches https://link-gambar.png @buyer Nama Produk 150000 done`\n' +
        'Status terakhir harus done atau pending.'
      );
    }

    const buyer = await message.guild.members.fetch(
      parsed.buyerId
    ).catch(() => null);

    if (!buyer) {
      return message.reply(
        'Buyer tidak ditemukan di server.'
      );
    }

    const done = parsed.status === 'done';

    const embed = new EmbedBuilder()
      .setColor(done ? 0x57f287 : 0xfee75c)
      .setTitle('🧾 Vouches Transaksi')
      .addFields(
        {
          name: 'Buyer',
          value: `${buyer}`,
          inline: true
        },
        {
          name: 'Produk',
          value: parsed.product.slice(0, 1024),
          inline: true
        },
        {
          name: 'Total Harga',
          value: moneyIDR(parsed.price),
          inline: true
        },
        {
          name: 'Status',
          value: done ? '✅ DONE' : '🕒 PENDING',
          inline: true
        },
        {
          name: 'Dicatat oleh',
          value: `${message.author}`,
          inline: true
        }
      )
      .setImage(parsed.imageUrl)
      .setFooter({ text: 'RY Vouches' })
      .setTimestamp();

    await targetChannel.send({
      embeds: [embed],
      allowedMentions: { users: [] }
    });

    return message.reply(
      `Vouches berhasil dikirim ke ${targetChannel}.`
    );
  }

  // TUTUP TICKET VIA COMMAND
  if (
    command === 'ticket' &&
    (args[0] || '').toLowerCase() === 'close'
  ) {
    const ownerMatch = message.channel.topic?.match(
      /ticket-owner:(\d+)/
    );

    const isOwner = ownerMatch?.[1] === message.author.id;

    if (!ownerMatch) {
      return message.reply(
        'Command ini hanya bisa dipakai di channel ticket.'
      );
    }

    if (!isOwner && !isStaff(message.member)) {
      return message.reply(
        'Hanya pembuat ticket atau staff yang bisa menutupnya.'
      );
    }

    await message.reply(
      'Ticket ditutup. Transcript sedang dibuat...'
    );

    await closeTicket(message.channel, message.author);
  }
});

// ===============================
// TOMBOL DAN MENU INTERAKSI
// ===============================

client.on('interactionCreate', async interaction => {
  try {
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'ry_ticket_category'
    ) {
      await createTicket(
        interaction,
        interaction.values[0]
      );

      return;
    }

    if (!interaction.isButton()) return;

    // CLAIM TICKET
    if (interaction.customId === 'ry_ticket_claim') {
      if (!isStaff(interaction.member)) {
        return interaction.reply({
          content: 'Hanya staff yang bisa claim ticket.',
          ephemeral: true
        });
      }

      const original = interaction.message;

      const embed = EmbedBuilder.from(
        original.embeds[0] ||
        new EmbedBuilder().setTitle('Ticket')
      );

      embed.addFields({
        name: 'Claim oleh',
        value: `${interaction.user}`
      });

      const rows = original.components.map(
        row => ActionRowBuilder.from(row)
      );

      const claimButton = rows
        .flatMap(row => row.components)
        .find(component =>
          component.customId === 'ry_ticket_claim'
        );

      if (claimButton) {
        claimButton
          .setDisabled(true)
          .setLabel(`Claimed: ${interaction.user.username}`);
      }

      await original.edit({
        embeds: [embed],
        components: rows
      });

      return interaction.reply({
        content: `Ticket di-claim oleh ${interaction.user}.`,
        allowedMentions: { users: [] }
      });
    }

    // TUTUP TICKET VIA TOMBOL
    if (interaction.customId === 'ry_ticket_close') {
      const ownerMatch = interaction.channel?.topic?.match(
        /ticket-owner:(\d+)/
      );

      const isOwner = ownerMatch?.[1] === interaction.user.id;

      if (
        !ownerMatch ||
        (!isOwner && !isStaff(interaction.member))
      ) {
        return interaction.reply({
          content: 'Kamu tidak punya izin menutup ticket ini.',
          ephemeral: true
        });
      }

      await interaction.reply({
        content: 'Ticket ditutup. Transcript sedang dibuat...'
      });

      await closeTicket(
        interaction.channel,
        interaction.user
      );
    }
  } catch (error) {
    console.error('Interaction error:', error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: 'Terjadi error. Hubungi admin.',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.on('error', console.error);

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

client.login(TOKEN);
