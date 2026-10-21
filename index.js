require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomInt } = require('node:crypto');

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
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
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

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || 'ry!';
const VERIFIED_ROLE_NAME =
  process.env.VERIFIED_ROLE_NAME || 'Verified';
const STAFF_ROLE_NAME =
  process.env.STAFF_ROLE_NAME || 'Staff';

// Lokasi file mp3 welcome (opsional, bisa relatif ke folder ROOT atau absolut).
// Kalau kosong, bot otomatis nyari welcome.mp3 di beberapa lokasi umum.
const WELCOME_AUDIO_PATH = process.env.WELCOME_AUDIO_PATH || '';

// Batas maksimal nunggu audio selesai (detik), buat jaga-jaga kalau macet.
const WELCOME_MAX_SECONDS =
  Number(process.env.WELCOME_MAX_SECONDS) || 300;

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

// ===============================
// DATA GIVEAWAY
// ===============================

const GIVEAWAYS_PATH = path.join(ROOT, 'giveaways.json');
const GIVEAWAY_KEEP_DAYS = 30;

let giveaways = {};

if (fs.existsSync(GIVEAWAYS_PATH)) {
  try {
    giveaways = JSON.parse(
      fs.readFileSync(GIVEAWAYS_PATH, 'utf8')
    );

    // Bersihin giveaway lama yang udah berakhir
    const limit = Date.now() - GIVEAWAY_KEEP_DAYS * 86400000;

    for (const [id, gw] of Object.entries(giveaways)) {
      if (gw.ended && gw.endsAt < limit) delete giveaways[id];
    }
  } catch (error) {
    console.error('Gagal membaca giveaways.json:', error);
  }
}

const giveawayRefreshTimers = new Map();
const giveawayEnding = new Set();

function saveGiveaways() {
  fs.writeFileSync(
    GIVEAWAYS_PATH,
    JSON.stringify(giveaways, null, 2)
  );
}

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

  const cfg = guildConfig(member.guild.id);

  return (
    member.permissions.has(
      PermissionFlagsBits.Administrator
    ) ||
    member.permissions.has(
      PermissionFlagsBits.ManageGuild
    ) ||
    // Cek lewat ID role (aman walau role di-rename)
    Boolean(
      cfg.staffRoleId &&
      member.roles.cache.has(cfg.staffRoleId)
    ) ||
    // Cadangan: cek lewat nama role dari .env
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
    '・ー ✧ Introduction ✧ ー・'
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
    '・ー ✧ Ticket ✧ ー・'
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

// ===============================
// SETUP GIVEAWAY
// ===============================

async function setupGiveaway(guild) {
  const cfg = guildConfig(guild.id);

  // Pakai role Staff yang udah ada (lewat ID), jangan bikin dobel
  const staffRole =
    (cfg.staffRoleId && guild.roles.cache.get(cfg.staffRoleId)) ||
    await findOrCreateRole(guild, STAFF_ROLE_NAME, {
      color: 0x5865f2
    });

  cfg.staffRoleId = staffRole.id;

  const category = await findOrCreateCategory(
    guild,
    '・ー ✧ Give Away ✧ ー・'
  );

  const botPermissions = {
    id: client.user.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory
    ]
  };

  // Rundown & history: semua bisa lihat, tapi cuma bot yang bisa kirim pesan
  const readOnly = [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AddReactions
      ]
    },
    botPermissions
  ];

  const rundown = await findOrCreateChannel(
    guild,
    '╭⋅🎁┊giveaway',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Giveaway yang sedang berlangsung. Klik tombol untuk ikut!',
      permissionOverwrites: readOnly
    }
  );

  const history = await findOrCreateChannel(
    guild,
    '┣⋅📜┊giveaway-history',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Riwayat giveaway yang sudah selesai.',
      permissionOverwrites: readOnly
    }
  );

  // Setting: khusus admin & Staff
  const setting = await findOrCreateChannel(
    guild,
    '╰⋅⚙️┊giveaway-setting',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Panel khusus Staff untuk mengelola giveaway.',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: staffRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory
          ],
          deny: [PermissionFlagsBits.SendMessages]
        },
        botPermissions
      ]
    }
  );

  cfg.giveawayCategoryId = category.id;
  cfg.giveawayRundownChannelId = rundown.id;
  cfg.giveawayHistoryChannelId = history.id;
  cfg.giveawaySettingChannelId = setting.id;

  saveConfig();

  const recent = await setting.messages.fetch({
    limit: 20
  }).catch(() => null);

  const exists = recent?.some(message =>
    message.author.id === client.user.id &&
    message.components.some(row =>
      row.components.some(
        component =>
          component.customId === 'ry_gw_panel_create'
      )
    )
  );

  if (!exists) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎁 Giveaway Control Panel')
      .setDescription(
        'Kelola giveaway server dari sini.\n\n' +
        '🎉 **Buat Giveaway** — isi form, giveaway langsung tayang di rundown\n' +
        '⏹️ **Akhiri** — hentikan giveaway lebih awal\n' +
        '🔄 **Reroll** — pilih pemenang baru\n' +
        '📋 **Daftar** — lihat giveaway yang sedang berjalan'
      )
      .setFooter({ text: 'RY Giveaway System' });

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ry_gw_panel_create')
        .setLabel('Buat Giveaway')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId('ry_gw_panel_end')
        .setLabel('Akhiri')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId('ry_gw_panel_reroll')
        .setLabel('Reroll')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('ry_gw_panel_list')
        .setLabel('Daftar')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary)
    );

    await setting.send({
      embeds: [embed],
      components: [buttons]
    });
  }

  return { staffRole, category, rundown, history, setting };
}

async function setupAll(guild) {
  const welcome = await setupWelcome(guild);
  const ticket = await setupTicket(guild);
  const vouches = await setupVouches(guild);
  const giveaway = await setupGiveaway(guild);

  return { welcome, ticket, vouches, giveaway };
}

// ===============================
// AUDIO WELCOME (MP3)
// ===============================

// Cari file welcome.mp3. Urutan pengecekan:
// 1. WELCOME_AUDIO_PATH dari .env (kalau diisi)
// 2. ROOT/welcome.mp3, ROOT/assets/welcome.mp3, ROOT/audio/welcome.mp3
// 3. folder yang sama dengan index.js (+ subfolder assets)
function resolveWelcomeAudio() {
  const candidates = [
    WELCOME_AUDIO_PATH
      ? path.resolve(ROOT, WELCOME_AUDIO_PATH)
      : null,
    path.join(ROOT, 'welcome.mp3'),
    path.join(ROOT, 'assets', 'welcome.mp3'),
    path.join(ROOT, 'audio', 'welcome.mp3'),
    path.join(__dirname, 'welcome.mp3'),
    path.join(__dirname, 'assets', 'welcome.mp3')
  ].filter(Boolean);

  return candidates.find(file => fs.existsSync(file)) || null;
}

// Join voice, muter welcome.mp3 sampai habis, lalu keluar.
// Promise baru resolve SETELAH audio selesai diputar.
// Kalau gagal (file ga ada, ffmpeg error, timeout) akan throw error.
async function playWelcomeAudio(channel) {
  const audioPath = resolveWelcomeAudio();

  if (!audioPath) {
    throw new Error(
      'welcome.mp3 tidak ditemukan. Taruh di folder project atau isi WELCOME_AUDIO_PATH di .env.'
    );
  }

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

  let timeoutId;

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      20000
    );

    connection.subscribe(player);

    const finished = new Promise((resolve, reject) => {
      let started = false;

      player.on('error', reject);

      player.on('stateChange', (oldState, newState) => {
        if (newState.status === AudioPlayerStatus.Playing) {
          started = true;
        }

        // Audio selesai = pindah dari Playing ke Idle
        if (
          started &&
          newState.status === AudioPlayerStatus.Idle
        ) {
          resolve();
        }
      });

      // Kalau koneksi voice putus di tengah jalan
      connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Destroyed) {
          reject(new Error('Koneksi voice terputus sebelum audio selesai.'));
        }
      });
    });

    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Audio welcome timeout.')),
        WELCOME_MAX_SECONDS * 1000
      );
    });

    player.play(createAudioResource(audioPath));

    await Promise.race([finished, timeout]);
  } finally {
    clearTimeout(timeoutId);
    player.removeAllListeners();
    player.stop(true);

    try {
      connection.destroy();
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
        // 1. Putar welcome.mp3 sampai selesai
        await playWelcomeAudio(channel);

        // 2. Setelah selesai, cek lagi member masih di voice
        const refreshed = await guild.members.fetch(
          member.id
        ).catch(() => null);

        if (
          refreshed &&
          refreshed.voice.channelId === item.channelId
        ) {
          // 3. Baru kasih role
          if (!refreshed.roles.cache.has(verifiedRole.id)) {
            await refreshed.roles.add(
              verifiedRole,
              'Selesai audio welcome RY'
            );

            await refreshed.send(
              `Selamat datang di ${guild.name}! Role ${verifiedRole.name} sudah diberikan.`
            ).catch(() => {});
          }

          // 4. Setelah dapet role, member langsung di-disconnect dari voice
          //    (bot butuh izin Move Members)
          await refreshed.voice
            .disconnect('Selesai audio welcome RY')
            .catch(error =>
              console.error(
                'Gagal disconnect member dari voice:',
                error.message
              )
            );
        }
      } catch (error) {
        console.error('Welcome audio gagal:', error);
      }
    }
  } finally {
    welcomeBusy.delete(guildId);
  }
}

// ===============================
// GIVEAWAY
// ===============================

// Parser durasi: 30s, 10m, 2h, 1d, atau gabungan seperti 1d12h
function parseDuration(text) {
  if (!text) return null;

  const units = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000
  };

  const regex = /(\d+)([smhd])/gi;
  let total = 0;
  let matched = '';
  let part;

  while ((part = regex.exec(text)) !== null) {
    total += Number(part[1]) * units[part[2].toLowerCase()];
    matched += part[0];
  }

  if (!total || matched.length !== text.length) return null;

  return total;
}

function buildGiveawayEmbed(gw) {
  const endUnix = Math.floor(gw.endsAt / 1000);

  const embed = new EmbedBuilder()
    .setTitle(gw.ended ? '🏆 GIVEAWAY BERAKHIR' : '🎉 GIVEAWAY')
    .setFooter({
      text: gw.messageId
        ? `RY Giveaway • ID: ${gw.messageId}`
        : 'RY Giveaway'
    })
    .setTimestamp(gw.endsAt);

  if (!gw.ended) {
    return embed
      .setColor(0x5865f2)
      .setDescription(
        `### ${gw.prize}\n` +
        (gw.note ? `${gw.note}\n\n` : '') +
        'Klik tombol **Ikut Giveaway** di bawah untuk berpartisipasi.'
      )
      .addFields(
        {
          name: '⏳ Berakhir',
          value: `<t:${endUnix}:R>\n<t:${endUnix}:f>`,
          inline: true
        },
        {
          name: '🏅 Pemenang',
          value: String(gw.winners),
          inline: true
        },
        {
          name: '👥 Peserta',
          value: String(gw.entries.length),
          inline: true
        },
        {
          name: '👑 Host',
          value: `<@${gw.hostId}>`,
          inline: true
        }
      );
  }

  const winnersText = gw.winnerIds.length
    ? gw.winnerIds.map(id => `<@${id}>`).join('\n')
    : 'Tidak ada peserta valid';

  return embed
    .setColor(gw.winnerIds.length ? 0x57f287 : 0xed4245)
    .setDescription(`### ${gw.prize}`)
    .addFields(
      {
        name: '🏆 Pemenang',
        value: winnersText.slice(0, 1024)
      },
      {
        name: '👥 Peserta',
        value: String(gw.entries.length),
        inline: true
      },
      {
        name: '👑 Host',
        value: `<@${gw.hostId}>`,
        inline: true
      },
      {
        name: '⏱️ Berakhir',
        value: `<t:${endUnix}:f>`,
        inline: true
      }
    );
}

function giveawayComponents(gw) {
  const button = new ButtonBuilder()
    .setCustomId('ry_gw_join')
    .setEmoji('🎉');

  if (gw.ended) {
    button
      .setLabel('Giveaway Berakhir')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
  } else {
    button
      .setLabel(`Ikut Giveaway (${gw.entries.length})`)
      .setStyle(ButtonStyle.Primary);
  }

  return [new ActionRowBuilder().addComponents(button)];
}

async function fetchGiveawayMessage(gw) {
  const guild = client.guilds.cache.get(gw.guildId);
  const channel = guild?.channels.cache.get(gw.channelId);

  if (!channel?.isTextBased()) return null;

  return channel.messages.fetch(gw.messageId).catch(() => null);
}

async function refreshGiveawayMessage(gw) {
  const msg = await fetchGiveawayMessage(gw);

  if (!msg) return null;

  await msg.edit({
    embeds: [buildGiveawayEmbed(gw)],
    components: giveawayComponents(gw)
  }).catch(console.error);

  return msg;
}

// Update tampilan (jumlah peserta) maksimal tiap 3 detik
// biar nggak kena rate limit kalau banyak yang klik bareng.
function scheduleGiveawayRefresh(gw) {
  if (giveawayRefreshTimers.has(gw.messageId)) return;

  giveawayRefreshTimers.set(
    gw.messageId,
    setTimeout(() => {
      giveawayRefreshTimers.delete(gw.messageId);

      if (!gw.ended) refreshGiveawayMessage(gw);
    }, 3000)
  );
}

async function pickWinners(guild, pool, count) {
  const shuffled = [...pool];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const winners = [];

  for (const id of shuffled) {
    if (winners.length >= count) break;

    const member = await guild.members.fetch(id).catch(() => null);

    if (member && !member.user.bot) winners.push(id);
  }

  return winners;
}

async function announceGiveaway(msg, channel, gw, winnerIds, isReroll) {
  const mentions = winnerIds.map(id => `<@${id}>`).join(', ');

  const content = winnerIds.length
    ? `${isReroll ? '🔄 Reroll! ' : ''}🎉 Selamat ${mentions}! Kamu memenangkan **${gw.prize}**!`
    : `😢 Giveaway **${gw.prize}** berakhir tanpa pemenang karena tidak ada peserta valid.`;

  const options = {
    content,
    allowedMentions: { users: winnerIds }
  };

  if (msg) {
    await msg.reply(options).catch(() =>
      channel.send(options).catch(() => {})
    );
  } else {
    await channel.send(options).catch(() => {});
  }
}

function notifyGiveawayWinners(guild, gw, winnerIds) {
  for (const id of winnerIds) {
    client.users.fetch(id)
      .then(user =>
        user.send(
          `🎉 Selamat! Kamu memenangkan **${gw.prize}** di ${guild.name}.`
        )
      )
      .catch(() => {});
  }
}

async function endGiveaway(gw) {
  if (gw.ended || giveawayEnding.has(gw.messageId)) return false;

  giveawayEnding.add(gw.messageId);

  try {
    clearTimeout(giveawayRefreshTimers.get(gw.messageId));
    giveawayRefreshTimers.delete(gw.messageId);

    const guild = client.guilds.cache.get(gw.guildId);

    if (!guild) {
      gw.ended = true;
      saveGiveaways();
      return true;
    }

    gw.winnerIds = await pickWinners(
      guild,
      gw.entries,
      gw.winners
    );

    gw.ended = true;
    saveGiveaways();

    const msg = await refreshGiveawayMessage(gw);
    const channel = guild.channels.cache.get(gw.channelId);

    if (channel?.isTextBased()) {
      await announceGiveaway(msg, channel, gw, gw.winnerIds, false);
    }

    await logGiveawayHistory(guild, gw, gw.winnerIds, false);

    notifyGiveawayWinners(guild, gw, gw.winnerIds);

    return true;
  } finally {
    giveawayEnding.delete(gw.messageId);
  }
}

async function rerollGiveaway(gw, count) {
  const guild = client.guilds.cache.get(gw.guildId);

  if (!guild) return null;

  const pool = gw.entries.filter(
    id => !gw.winnerIds.includes(id)
  );

  const picked = await pickWinners(guild, pool, count);

  if (!picked.length) return null;

  gw.winnerIds.push(...picked);
  saveGiveaways();

  const msg = await refreshGiveawayMessage(gw);
  const channel = guild.channels.cache.get(gw.channelId);

  if (channel?.isTextBased()) {
    await announceGiveaway(msg, channel, gw, picked, true);
  }

  await logGiveawayHistory(guild, gw, picked, true);

  notifyGiveawayWinners(guild, gw, picked);

  return picked;
}

// Daftar giveaway server ini (maks 25, buat menu pilihan), terbaru dulu
function guildGiveaways(guildId, ended) {
  return Object.values(giveaways)
    .filter(gw => gw.guildId === guildId && gw.ended === ended)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 25);
}

function giveawayLink(gw) {
  return `https://discord.com/channels/${gw.guildId}/${gw.channelId}/${gw.messageId}`;
}

// Catat hasil giveaway (atau reroll) ke channel history
async function logGiveawayHistory(guild, gw, winnerIds, isReroll) {
  const cfg = guildConfig(guild.id);

  const channel = cfg.giveawayHistoryChannelId
    ? guild.channels.cache.get(cfg.giveawayHistoryChannelId)
    : null;

  if (!channel?.isTextBased()) return;

  const winnersText = winnerIds.length
    ? winnerIds.map(id => `<@${id}>`).join('\n')
    : 'Tidak ada peserta valid';

  const embed = new EmbedBuilder()
    .setColor(
      isReroll ? 0xfee75c : (winnerIds.length ? 0x57f287 : 0xed4245)
    )
    .setTitle(isReroll ? '🔄 Reroll Giveaway' : '📜 Giveaway Selesai')
    .setDescription(`### ${gw.prize}`)
    .addFields(
      {
        name: isReroll ? '🏆 Pemenang Baru' : '🏆 Pemenang',
        value: winnersText.slice(0, 1024)
      },
      {
        name: '👥 Peserta',
        value: String(gw.entries.length),
        inline: true
      },
      {
        name: '👑 Host',
        value: `<@${gw.hostId}>`,
        inline: true
      },
      {
        name: '🔗 Pesan',
        value: `[Lihat giveaway](${giveawayLink(gw)})`,
        inline: true
      }
    )
    .setFooter({ text: `RY Giveaway • ID: ${gw.messageId}` })
    .setTimestamp();

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  }).catch(console.error);
}

// Tombol di panel giveaway-setting
async function handleGiveawayPanel(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: 'Panel ini hanya untuk admin atau Staff.',
      ephemeral: true
    });
  }

  const guildId = interaction.guild.id;

  // Buka form buat giveaway
  if (interaction.customId === 'ry_gw_panel_create') {
    const modal = new ModalBuilder()
      .setCustomId('ry_gw_modal_create')
      .setTitle('Buat Giveaway Baru')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('prize')
            .setLabel('Hadiah')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Contoh: Nitro Classic 1 Bulan')
            .setMaxLength(100)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Durasi')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('30m, 2h, 1d, atau 1d12h')
            .setMaxLength(12)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('winners')
            .setLabel('Jumlah Pemenang')
            .setStyle(TextInputStyle.Short)
            .setValue('1')
            .setMaxLength(2)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Keterangan / Syarat (opsional)')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(300)
            .setRequired(false)
        )
      );

    return interaction.showModal(modal);
  }

  // Menu pilih giveaway yang mau diakhiri
  if (interaction.customId === 'ry_gw_panel_end') {
    const active = guildGiveaways(guildId, false);

    if (!active.length) {
      return interaction.reply({
        content: 'Tidak ada giveaway yang sedang berjalan.',
        ephemeral: true
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ry_gw_end_select')
      .setPlaceholder('Pilih giveaway yang mau diakhiri...')
      .addOptions(
        active.map(gw => ({
          label: gw.prize.slice(0, 100),
          description:
            `${gw.entries.length} peserta • ID ${gw.messageId}`.slice(0, 100),
          value: gw.messageId
        }))
      );

    return interaction.reply({
      content: 'Pilih giveaway yang mau diakhiri sekarang:',
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true
    });
  }

  // Menu pilih giveaway yang mau di-reroll
  if (interaction.customId === 'ry_gw_panel_reroll') {
    const finished = guildGiveaways(guildId, true).filter(
      gw => gw.entries.length > 0
    );

    if (!finished.length) {
      return interaction.reply({
        content: 'Belum ada giveaway selesai yang bisa di-reroll.',
        ephemeral: true
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ry_gw_reroll_select')
      .setPlaceholder('Pilih giveaway yang mau di-reroll...')
      .addOptions(
        finished.map(gw => ({
          label: gw.prize.slice(0, 100),
          description:
            `${gw.entries.length} peserta • ID ${gw.messageId}`.slice(0, 100),
          value: gw.messageId
        }))
      );

    return interaction.reply({
      content: 'Pilih giveaway yang mau dipilih ulang pemenangnya (1 pemenang baru):',
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true
    });
  }

  // Daftar giveaway aktif
  if (interaction.customId === 'ry_gw_panel_list') {
    const active = guildGiveaways(guildId, false);

    if (!active.length) {
      return interaction.reply({
        content: 'Tidak ada giveaway yang sedang berjalan.',
        ephemeral: true
      });
    }

    const lines = active.map(gw =>
      `• **${gw.prize}** — ${gw.entries.length} peserta — berakhir <t:${Math.floor(gw.endsAt / 1000)}:R> — [lihat](${giveawayLink(gw)})`
    );

    return interaction.reply({
      content: lines.join('\n').slice(0, 1900),
      ephemeral: true
    });
  }
}

// Form "Buat Giveaway" disubmit
async function handleGiveawayModal(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: 'Hanya admin atau Staff yang bisa membuat giveaway.',
      ephemeral: true
    });
  }

  const guild = interaction.guild;
  const cfg = guildConfig(guild.id);

  const rundown = cfg.giveawayRundownChannelId
    ? guild.channels.cache.get(cfg.giveawayRundownChannelId)
    : null;

  if (!rundown?.isTextBased()) {
    return interaction.reply({
      content: 'Channel rundown tidak ditemukan. Jalankan `ry!setup giveaway` dulu.',
      ephemeral: true
    });
  }

  const prize = interaction.fields
    .getTextInputValue('prize')
    .trim()
    .slice(0, 100);

  const duration = parseDuration(
    interaction.fields
      .getTextInputValue('duration')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
  );

  const winnerCount = Number(
    interaction.fields.getTextInputValue('winners').trim()
  );

  const note = interaction.fields
    .getTextInputValue('note')
    .trim()
    .slice(0, 300);

  if (!prize) {
    return interaction.reply({
      content: 'Hadiah tidak boleh kosong.',
      ephemeral: true
    });
  }

  if (
    !duration ||
    duration < 10000 ||
    duration > 30 * 86400000
  ) {
    return interaction.reply({
      content:
        'Durasi tidak valid. Contoh: `30m`, `2h`, `1d`, atau `1d12h` (minimal 10 detik, maksimal 30 hari).',
      ephemeral: true
    });
  }

  if (
    !Number.isInteger(winnerCount) ||
    winnerCount < 1 ||
    winnerCount > 20
  ) {
    return interaction.reply({
      content: 'Jumlah pemenang harus angka 1 sampai 20.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const gw = {
    guildId: guild.id,
    channelId: rundown.id,
    messageId: null,
    hostId: interaction.user.id,
    prize,
    note,
    winners: winnerCount,
    endsAt: Date.now() + duration,
    createdAt: Date.now(),
    entries: [],
    winnerIds: [],
    ended: false
  };

  const sent = await rundown.send({
    embeds: [buildGiveawayEmbed(gw)],
    components: giveawayComponents(gw)
  });

  gw.messageId = sent.id;
  giveaways[sent.id] = gw;
  saveGiveaways();

  // Update sekali lagi biar ID pesan muncul di footer
  await sent.edit({
    embeds: [buildGiveawayEmbed(gw)]
  }).catch(() => {});

  return interaction.editReply({
    content: `✅ Giveaway **${prize}** sudah tayang di ${rundown}: ${sent.url}`
  });
}

// Menu "Akhiri giveaway"
async function handleGiveawayEndSelect(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: 'Hanya admin atau Staff.',
      ephemeral: true
    });
  }

  const gw = giveaways[interaction.values[0]];

  await interaction.deferUpdate();

  if (!gw || gw.guildId !== interaction.guild.id || gw.ended) {
    return interaction.editReply({
      content: 'Giveaway itu sudah berakhir atau tidak ditemukan.',
      components: []
    });
  }

  gw.endsAt = Date.now();
  await endGiveaway(gw);

  return interaction.editReply({
    content: `⏹️ Giveaway **${gw.prize}** sudah diakhiri.`,
    components: []
  });
}

// Menu "Reroll giveaway"
async function handleGiveawayRerollSelect(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: 'Hanya admin atau Staff.',
      ephemeral: true
    });
  }

  const gw = giveaways[interaction.values[0]];

  await interaction.deferUpdate();

  if (
    !gw ||
    gw.guildId !== interaction.guild.id ||
    !gw.ended
  ) {
    return interaction.editReply({
      content: 'Giveaway itu tidak ditemukan.',
      components: []
    });
  }

  const picked = await rerollGiveaway(gw, 1);

  return interaction.editReply({
    content: picked
      ? `🔄 Pemenang baru untuk **${gw.prize}**: <@${picked[0]}>`
      : 'Tidak ada peserta lain yang bisa dipilih untuk reroll.',
    components: []
  });
}

function checkGiveaways() {
  const now = Date.now();

  for (const gw of Object.values(giveaways)) {
    if (!gw.ended && gw.endsAt <= now) {
      endGiveaway(gw).catch(console.error);
    }
  }
}

async function handleGiveawayJoin(interaction) {
  const gw = giveaways[interaction.message.id];

  if (!gw || gw.ended || Date.now() >= gw.endsAt) {
    return interaction.reply({
      content: '⏰ Giveaway ini sudah berakhir.',
      ephemeral: true
    });
  }

  if (gw.entries.includes(interaction.user.id)) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ry_gw_leave:${gw.messageId}`)
        .setLabel('Keluar dari Giveaway')
        .setStyle(ButtonStyle.Danger)
    );

    return interaction.reply({
      content: '✅ Kamu sudah terdaftar di giveaway ini.',
      components: [row],
      ephemeral: true
    });
  }

  gw.entries.push(interaction.user.id);
  saveGiveaways();
  scheduleGiveawayRefresh(gw);

  return interaction.reply({
    content:
      `🎉 Kamu berhasil ikut giveaway **${gw.prize}**!\n` +
      `Total peserta: **${gw.entries.length}**. Semoga beruntung!`,
    ephemeral: true
  });
}

async function handleGiveawayLeave(interaction) {
  const id = interaction.customId.split(':')[1];
  const gw = giveaways[id];

  if (!gw || gw.ended) {
    return interaction.update({
      content: '⏰ Giveaway ini sudah berakhir.',
      components: []
    });
  }

  gw.entries = gw.entries.filter(
    userId => userId !== interaction.user.id
  );

  saveGiveaways();
  scheduleGiveawayRefresh(gw);

  return interaction.update({
    content: '👋 Kamu sudah keluar dari giveaway.',
    components: []
  });
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

  const audioPath = resolveWelcomeAudio();

  if (audioPath) {
    console.log(`Welcome audio: ${audioPath}`);
  } else {
    console.warn(
      'PERINGATAN: welcome.mp3 tidak ditemukan! Taruh di folder project atau isi WELCOME_AUDIO_PATH di .env.'
    );
  }

  // Cek giveaway yang udah waktunya berakhir (tahan restart bot)
  checkGiveaways();
  setInterval(checkGiveaways, 10000);

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
        '`ry!setup giveaway` — setup giveaway (rundown, history, setting)',
        '`ry!welcome test` — tes audio welcome.mp3',
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

      if (target === 'giveaway') {
        const result = await setupGiveaway(message.guild);

        return message.reply(
          `Giveaway siap! Rundown: ${result.rundown}. History: ${result.history}. Panel kontrol (khusus Staff): ${result.setting}.`
        );
      }

      if (target === 'all') {
        const result = await setupAll(message.guild);

        return message.reply(
          `Setup RY selesai!\n` +
          `Welcome: ${result.welcome.voice}\n` +
          `Ticket: ${result.ticket.panel}\n` +
          `Logs: ${result.ticket.logs}\n` +
          `Vouches: ${result.vouches}\n` +
          `Giveaway: ${result.giveaway.setting}\n\n` +
          `Atur permission channel member agar role Verified mendapat akses.`
        );
      }

      return message.reply(
        'Gunakan ry!setup all, welcome, ticket, vouches, atau giveaway.'
      );
    } catch (error) {
      console.error(error);

      return message.reply(
        'Setup gagal. Periksa izin bot dan console VPS.'
      );
    }
  }

  // TES AUDIO WELCOME (MP3)
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
      await message.reply('Memutar welcome.mp3...');

      await playWelcomeAudio(voiceChannel);

      await message.channel.send('Tes audio selesai.');
    } catch (error) {
      console.error(error);

      await message.reply(
        `Audio gagal: ${error.message}\n` +
        'Cek juga FFmpeg, izin Connect serta Speak, dan lokasi welcome.mp3.'
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

    if (
      interaction.isModalSubmit() &&
      interaction.customId === 'ry_gw_modal_create'
    ) {
      await handleGiveawayModal(interaction);
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'ry_gw_end_select'
    ) {
      await handleGiveawayEndSelect(interaction);
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'ry_gw_reroll_select'
    ) {
      await handleGiveawayRerollSelect(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    // GIVEAWAY: PANEL SETTING (STAFF)
    if (interaction.customId.startsWith('ry_gw_panel_')) {
      return handleGiveawayPanel(interaction);
    }

    // GIVEAWAY: IKUT / KELUAR
    if (interaction.customId === 'ry_gw_join') {
      return handleGiveawayJoin(interaction);
    }

    if (interaction.customId.startsWith('ry_gw_leave:')) {
      return handleGiveawayLeave(interaction);
    }

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
