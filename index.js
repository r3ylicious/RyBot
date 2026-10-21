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
  TextInputStyle,
  SlashCommandBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder
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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message,
    Partials.Reaction,
    Partials.User
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

// ===============================
// SETUP HOOK & REACTION ROLE
// ===============================

async function getStaffRole(guild) {
  const cfg = guildConfig(guild.id);

  // Pakai role Staff yang udah ada (lewat ID), jangan bikin dobel
  const role =
    (cfg.staffRoleId && guild.roles.cache.get(cfg.staffRoleId)) ||
    await findOrCreateRole(guild, STAFF_ROLE_NAME, {
      color: 0x5865f2
    });

  cfg.staffRoleId = role.id;

  return role;
}

// Channel panel khusus Staff: member biasa nggak bisa lihat
function staffOnlyOverwrites(guild, staffRole) {
  return [
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
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];
}

async function panelAlreadyPosted(channel, customId) {
  const recent = await channel.messages.fetch({
    limit: 20
  }).catch(() => null);

  return Boolean(
    recent?.some(message =>
      message.author.id === client.user.id &&
      message.components.some(row =>
        row.components.some(
          component => component.customId === customId
        )
      )
    )
  );
}

function hookPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ry_hook_author')
        .setLabel('Author')
        .setEmoji('👤')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ry_hook_body')
        .setLabel('Body')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ry_hook_addfield')
        .setLabel('Tambah Field')
        .setEmoji('🧩')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ry_hook_images')
        .setLabel('Images')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ry_hook_footer')
        .setLabel('Footer')
        .setEmoji('📎')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ry_hook_delfield')
        .setLabel('Hapus Field')
        .setEmoji('➖')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('ry_hook_preview')
        .setLabel('Preview')
        .setEmoji('👁️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ry_hook_send')
        .setLabel('Kirim')
        .setEmoji('🚀')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ry_hook_reset')
        .setLabel('Reset')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

function rrPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ry_rr_panel_new')
        .setLabel('Buat Panel')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ry_rr_panel_add')
        .setLabel('Tambah Role')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ry_rr_panel_delrole')
        .setLabel('Hapus Role')
        .setEmoji('➖')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('ry_rr_panel_list')
        .setLabel('Daftar')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ry_rr_panel_delpanel')
        .setLabel('Hapus Panel')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

async function setupHook(guild) {
  const cfg = guildConfig(guild.id);

  const staffRole = await getStaffRole(guild);

  const category = await findOrCreateCategory(
    guild,
    '・ー ✧ Tools ✧ ー・'
  );

  const panel = await findOrCreateChannel(
    guild,
    '🪝・hook-setting',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Panel khusus Staff untuk membuat dan mengirim pesan embed.',
      permissionOverwrites: staffOnlyOverwrites(guild, staffRole)
    }
  );

  cfg.toolsCategoryId = category.id;
  cfg.hookPanelChannelId = panel.id;

  saveConfig();

  if (!(await panelAlreadyPosted(panel, 'ry_hook_author'))) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🪝 Hook — Pembuat Embed')
      .setDescription(
        'Bikin pesan embed ala Discohook langsung dari Discord.\n\n' +
        '**1.** Isi bagian yang kamu mau: **Author**, **Body**, **Field**, **Images**, **Footer**.\n' +
        '**2.** Preview muncul otomatis tiap selesai edit (atau klik **Preview**).\n' +
        '**3.** Klik **Kirim**, lalu pilih channel tujuan.\n\n' +
        'Draft disimpan per orang, jadi tiap Staff punya draft sendiri.'
      )
      .setFooter({ text: 'RY Hook' });

    await panel.send({
      embeds: [embed],
      components: hookPanelComponents()
    });
  }

  return { staffRole, category, panel };
}

async function setupReactionRole(guild) {
  const cfg = guildConfig(guild.id);

  const staffRole = await getStaffRole(guild);

  const category = await findOrCreateCategory(
    guild,
    '・ー ✧ Tools ✧ ー・'
  );

  const panel = await findOrCreateChannel(
    guild,
    '🎭・reactionrole-setting',
    ChannelType.GuildText,
    {
      parent: category.id,
      topic: 'Panel khusus Staff untuk mengatur reaction role.',
      permissionOverwrites: staffOnlyOverwrites(guild, staffRole)
    }
  );

  cfg.toolsCategoryId = category.id;
  cfg.reactionRolePanelChannelId = panel.id;

  saveConfig();

  if (!(await panelAlreadyPosted(panel, 'ry_rr_panel_new'))) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎭 Reaction Role — Panel Kontrol')
      .setDescription(
        'Atur role yang bisa diambil member sendiri.\n\n' +
        '➕ **Buat Panel** — pilih channel dan tipe (Tombol / Dropdown / Reaksi emoji)\n' +
        '🎭 **Tambah Role** — masukkan role ke panel\n' +
        '➖ **Hapus Role** — keluarkan role dari panel\n' +
        '📋 **Daftar** — lihat semua panel\n' +
        '🗑️ **Hapus Panel** — hapus panel'
      )
      .setFooter({ text: 'RY Reaction Role' });

    await panel.send({
      embeds: [embed],
      components: rrPanelComponents()
    });
  }

  return { staffRole, category, panel };
}

async function setupAll(guild) {
  const welcome = await setupWelcome(guild);
  const ticket = await setupTicket(guild);
  const vouches = await setupVouches(guild);
  const giveaway = await setupGiveaway(guild);
  const hook = await setupHook(guild);
  const reactionRole = await setupReactionRole(guild);

  return { welcome, ticket, vouches, giveaway, hook, reactionRole };
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
      content: 'Channel rundown tidak ditemukan. Jalankan `/setup giveaway` dulu.',
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
      content: 'Jalankan /setup ticket terlebih dahulu.',
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
// SLASH COMMANDS
// ===============================

function buildSlashCommands() {
  const setup = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup sistem bot (khusus admin / Staff)');

  const targets = [
    ['all', 'Setup semua sistem sekaligus'],
    ['welcome', 'Voice welcome + role Verified'],
    ['ticket', 'Panel ticket support'],
    ['vouches', 'Channel vouches'],
    ['giveaway', 'Kategori giveaway (rundown, history, setting)'],
    ['hook', 'Panel pembuat embed ala Discohook'],
    ['reactionrole', 'Panel reaction role']
  ];

  for (const [name, description] of targets) {
    setup.addSubcommand(sub =>
      sub.setName(name).setDescription(description)
    );
  }

  return [
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Daftar command RY Bot'),

    setup,

    new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Pengaturan welcome')
      .addSubcommand(sub =>
        sub
          .setName('test')
          .setDescription('Tes audio welcome.mp3 di voice channel kamu')
      ),

    new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Pengaturan ticket')
      .addSubcommand(sub =>
        sub
          .setName('close')
          .setDescription('Tutup ticket di channel ini')
      ),

    new SlashCommandBuilder()
      .setName('vouches')
      .setDescription('Catat vouches transaksi (khusus admin / Staff)')
      .addUserOption(option =>
        option
          .setName('buyer')
          .setDescription('Pembeli')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('produk')
          .setDescription('Nama produk')
          .setRequired(true)
          .setMaxLength(200)
      )
      .addIntegerOption(option =>
        option
          .setName('harga')
          .setDescription('Total harga (angka saja)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(1000000000000)
      )
      .addStringOption(option =>
        option
          .setName('status')
          .setDescription('Status transaksi')
          .setRequired(true)
          .addChoices(
            { name: 'Done', value: 'done' },
            { name: 'Pending', value: 'pending' }
          )
      )
      .addAttachmentOption(option =>
        option
          .setName('gambar')
          .setDescription('Bukti transaksi (upload gambar)')
      )
      .addStringOption(option =>
        option
          .setName('link')
          .setDescription('Atau link gambar bukti transaksi')
      )
  ].map(command => command.toJSON());
}

async function registerSlashCommands(guild) {
  try {
    await guild.commands.set(buildSlashCommands());
  } catch (error) {
    console.error(
      `Gagal mendaftarkan slash command di server "${guild.name}": ${error.message}\n` +
      'Pastikan bot diundang dengan scope "applications.commands" (OAuth2 → URL Generator → centang bot + applications.commands).'
    );
  }
}

async function handleSlashCommand(interaction) {
  if (!interaction.guild) {
    return interaction.reply({
      content: 'Command ini hanya bisa dipakai di dalam server.',
      ephemeral: true
    });
  }

  const name = interaction.commandName;

  // HELP
  if (name === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('RY Bot Commands')
      .setDescription([
        '`/setup all` — setup semua sistem',
        '`/setup welcome` — voice welcome + role Verified',
        '`/setup ticket` — panel ticket',
        '`/setup vouches` — channel vouches',
        '`/setup giveaway` — rundown, history, dan panel giveaway',
        '`/setup hook` — panel pembuat embed (ala Discohook)',
        '`/setup reactionrole` — panel reaction role',
        '`/welcome test` — tes audio welcome.mp3',
        '`/vouches` — catat vouches transaksi',
        '`/ticket close` — tutup ticket'
      ].join('\n'));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // SETUP
  if (name === 'setup') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: 'Command setup hanya untuk admin atau Staff.',
        ephemeral: true
      });
    }

    const target = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;

      if (target === 'welcome') {
        const result = await setupWelcome(guild);

        return interaction.editReply(
          `Welcome siap! Voice channel: ${result.voice}. Role: ${result.verifiedRole.name}.`
        );
      }

      if (target === 'ticket') {
        const result = await setupTicket(guild);

        return interaction.editReply(
          `Ticket siap! Panel: ${result.panel}. Log: ${result.logs}. Tambahkan staff ke role ${result.staffRole.name}.`
        );
      }

      if (target === 'vouches') {
        const channel = await setupVouches(guild);

        return interaction.editReply(
          `Channel vouches siap: ${channel}`
        );
      }

      if (target === 'giveaway') {
        const result = await setupGiveaway(guild);

        return interaction.editReply(
          `Giveaway siap! Rundown: ${result.rundown}. History: ${result.history}. Panel kontrol (khusus Staff): ${result.setting}.`
        );
      }

      if (target === 'hook') {
        const result = await setupHook(guild);

        return interaction.editReply(
          `Hook siap! Buka panel (khusus Staff): ${result.panel}`
        );
      }

      if (target === 'reactionrole') {
        const result = await setupReactionRole(guild);

        return interaction.editReply(
          `Reaction role siap! Buka panel (khusus Staff): ${result.panel}`
        );
      }

      if (target === 'all') {
        const result = await setupAll(guild);

        return interaction.editReply(
          `Setup RY selesai!\n` +
          `Welcome: ${result.welcome.voice}\n` +
          `Ticket: ${result.ticket.panel}\n` +
          `Logs: ${result.ticket.logs}\n` +
          `Vouches: ${result.vouches}\n` +
          `Giveaway: ${result.giveaway.setting}\n` +
          `Hook: ${result.hook.panel}\n` +
          `Reaction Role: ${result.reactionRole.panel}\n\n` +
          `Atur permission channel member agar role Verified mendapat akses.`
        );
      }
    } catch (error) {
      console.error(error);

      return interaction.editReply(
        'Setup gagal. Periksa izin bot dan console VPS.'
      );
    }

    return;
  }

  // TES AUDIO WELCOME (MP3)
  if (name === 'welcome') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: 'Khusus admin atau Staff.',
        ephemeral: true
      });
    }

    const voiceChannel = interaction.member.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: 'Masuk voice channel dulu, lalu jalankan /welcome test.',
        ephemeral: true
      });
    }

    await interaction.reply({
      content: 'Memutar welcome.mp3...',
      ephemeral: true
    });

    try {
      await playWelcomeAudio(voiceChannel);

      await interaction.editReply('Tes audio selesai.');
    } catch (error) {
      console.error(error);

      await interaction.editReply(
        `Audio gagal: ${error.message}\n` +
        'Cek juga FFmpeg, izin Connect serta Speak, dan lokasi welcome.mp3.'
      );
    }

    return;
  }

  // TUTUP TICKET
  if (name === 'ticket') {
    const ownerMatch = interaction.channel?.topic?.match(
      /ticket-owner:(\d+)/
    );

    if (!ownerMatch) {
      return interaction.reply({
        content: 'Command ini hanya bisa dipakai di channel ticket.',
        ephemeral: true
      });
    }

    const isOwner = ownerMatch[1] === interaction.user.id;

    if (!isOwner && !isStaff(interaction.member)) {
      return interaction.reply({
        content: 'Hanya pembuat ticket atau staff yang bisa menutupnya.',
        ephemeral: true
      });
    }

    await interaction.reply(
      'Ticket ditutup. Transcript sedang dibuat...'
    );

    await closeTicket(interaction.channel, interaction.user);

    return;
  }

  // VOUCHES
  if (name === 'vouches') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: 'Command vouches hanya untuk admin atau Staff.',
        ephemeral: true
      });
    }

    const cfg = guildConfig(interaction.guild.id);

    const targetChannel = cfg.vouchesChannelId
      ? interaction.guild.channels.cache.get(cfg.vouchesChannelId)
      : null;

    if (!targetChannel?.isTextBased()) {
      return interaction.reply({
        content: 'Jalankan /setup vouches terlebih dahulu.',
        ephemeral: true
      });
    }

    const attachment = interaction.options.getAttachment('gambar');
    const linkOption = interaction.options.getString('link');

    if (attachment && !attachment.contentType?.startsWith('image/')) {
      return interaction.reply({
        content: 'File yang diupload harus berupa gambar.',
        ephemeral: true
      });
    }

    const imageUrl = attachment?.url || linkOption;

    if (!imageUrl || !isValidHttpUrl(imageUrl)) {
      return interaction.reply({
        content: 'Sertakan bukti transaksi: upload gambar di opsi **gambar**, atau isi opsi **link** dengan URL gambar (diawali https://).',
        ephemeral: true
      });
    }

    const buyerUser = interaction.options.getUser('buyer', true);

    const buyer = await interaction.guild.members.fetch(
      buyerUser.id
    ).catch(() => null);

    if (!buyer) {
      return interaction.reply({
        content: 'Buyer tidak ditemukan di server.',
        ephemeral: true
      });
    }

    const product = interaction.options.getString('produk', true).trim();
    const price = interaction.options.getInteger('harga', true);
    const done = interaction.options.getString('status', true) === 'done';

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
          value: product.slice(0, 1024),
          inline: true
        },
        {
          name: 'Total Harga',
          value: moneyIDR(price),
          inline: true
        },
        {
          name: 'Status',
          value: done ? '✅ DONE' : '🕒 PENDING',
          inline: true
        },
        {
          name: 'Dicatat oleh',
          value: `${interaction.user}`,
          inline: true
        }
      )
      .setImage(imageUrl)
      .setFooter({ text: 'RY Vouches' })
      .setTimestamp();

    await targetChannel.send({
      embeds: [embed],
      allowedMentions: { users: [] }
    });

    return interaction.reply({
      content: `Vouches berhasil dikirim ke ${targetChannel}.`,
      ephemeral: true
    });
  }
}

// ===============================
// HELPER UMUM (URL, INPUT MODAL)
// ===============================

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseHexColor(text) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(text).trim());

  return match ? parseInt(match[1], 16) : null;
}

function parseYes(text) {
  return /^(ya|iya|y|yes|true|1)$/i.test(String(text).trim());
}

// Bikin baris input untuk modal
function textInput({
  id,
  label,
  style = TextInputStyle.Short,
  value,
  placeholder,
  max,
  required = false
}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required);

  if (placeholder) input.setPlaceholder(placeholder);
  if (max) input.setMaxLength(max);
  if (value) input.setValue(String(value).slice(0, max || 4000));

  return new ActionRowBuilder().addComponents(input);
}

function buildModal(customId, title, rows) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(...rows);
}

// ===============================
// HOOK (PEMBUAT EMBED ALA DISCOHOOK)
// ===============================

const hookDrafts = new Map();
const HOOK_DRAFT_TTL = 2 * 60 * 60 * 1000;

function newHookDraft() {
  return {
    content: '',
    author: {},
    title: '',
    url: '',
    description: '',
    color: null,
    fields: [],
    thumbnail: '',
    image: '',
    footer: {},
    timestamp: false,
    updatedAt: Date.now()
  };
}

function hookDraftKey(interaction) {
  return `${interaction.guild.id}:${interaction.user.id}`;
}

function getHookDraft(interaction) {
  const now = Date.now();

  // Buang draft yang udah lama nggak disentuh
  for (const [key, draft] of hookDrafts) {
    if (now - draft.updatedAt > HOOK_DRAFT_TTL) {
      hookDrafts.delete(key);
    }
  }

  const key = hookDraftKey(interaction);

  let draft = hookDrafts.get(key);

  if (!draft) {
    draft = newHookDraft();
    hookDrafts.set(key, draft);
  }

  draft.updatedAt = now;

  return draft;
}

function hookHasEmbed(draft) {
  return Boolean(
    draft.author.name ||
    draft.title ||
    draft.description ||
    draft.fields.length ||
    draft.thumbnail ||
    draft.image ||
    draft.footer.text
  );
}

// Batas Discord: total teks satu embed maksimal 6000 karakter
function hookEmbedLength(draft) {
  return (
    (draft.author.name || '').length +
    draft.title.length +
    draft.description.length +
    (draft.footer.text || '').length +
    draft.fields.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0
    )
  );
}

function buildHookEmbed(draft) {
  const embed = new EmbedBuilder().setColor(
    draft.color ?? 0x5865f2
  );

  if (draft.author.name) {
    embed.setAuthor({
      name: draft.author.name,
      ...(draft.author.iconURL ? { iconURL: draft.author.iconURL } : {}),
      ...(draft.author.url ? { url: draft.author.url } : {})
    });
  }

  if (draft.title) embed.setTitle(draft.title);
  if (draft.title && draft.url) embed.setURL(draft.url);
  if (draft.description) embed.setDescription(draft.description);
  if (draft.fields.length) embed.addFields(draft.fields);
  if (draft.thumbnail) embed.setThumbnail(draft.thumbnail);
  if (draft.image) embed.setImage(draft.image);

  if (draft.footer.text) {
    embed.setFooter({
      text: draft.footer.text,
      ...(draft.footer.iconURL ? { iconURL: draft.footer.iconURL } : {})
    });
  }

  if (draft.timestamp) embed.setTimestamp();

  return embed;
}

function buildHookPayload(draft) {
  const payload = {};

  if (draft.content) payload.content = draft.content;
  if (hookHasEmbed(draft)) payload.embeds = [buildHookEmbed(draft)];

  return payload;
}

function hookProblem(draft) {
  const payload = buildHookPayload(draft);

  if (!payload.content && !payload.embeds) {
    return 'Draft masih kosong. Isi Body, Author, Field, Images, atau Footer dulu.';
  }

  if (hookEmbedLength(draft) > 6000) {
    return 'Total teks embed melebihi 6000 karakter (batas Discord). Kurangi isi embed.';
  }

  return null;
}

function hookPreviewReply(draft, notice) {
  const payload = buildHookPayload(draft);
  const problem = hookProblem(draft);
  const lines = [notice];

  if (problem && hookHasEmbed(draft)) lines.push(`⚠️ ${problem}`);
  if (draft.content) lines.push('', draft.content);

  return {
    content: lines.join('\n').slice(0, 2000),
    embeds: payload.embeds || [],
    allowedMentions: { parse: [] }
  };
}

function hookFail(interaction, message) {
  return interaction.reply({
    content: `❌ ${message}`,
    ephemeral: true
  });
}

async function handleHookButton(interaction) {
  const draft = getHookDraft(interaction);

  switch (interaction.customId) {
    case 'ry_hook_author':
      return interaction.showModal(
        buildModal('ry_hook_modal_author', 'Author', [
          textInput({
            id: 'name',
            label: 'Nama Author',
            value: draft.author.name,
            max: 256
          }),
          textInput({
            id: 'icon',
            label: 'URL Icon Author',
            value: draft.author.iconURL,
            placeholder: 'https://...',
            max: 500
          }),
          textInput({
            id: 'url',
            label: 'Link Author (opsional)',
            value: draft.author.url,
            placeholder: 'https://...',
            max: 500
          })
        ])
      );

    case 'ry_hook_body':
      return interaction.showModal(
        buildModal('ry_hook_modal_body', 'Body', [
          textInput({
            id: 'title',
            label: 'Judul',
            value: draft.title,
            max: 256
          }),
          textInput({
            id: 'titleurl',
            label: 'Link Judul (opsional)',
            value: draft.url,
            placeholder: 'https://...',
            max: 500
          }),
          textInput({
            id: 'description',
            label: 'Isi Pesan (Body)',
            style: TextInputStyle.Paragraph,
            value: draft.description,
            max: 4000
          }),
          textInput({
            id: 'color',
            label: 'Warna (hex, contoh #5865F2)',
            value: draft.color === null
              ? ''
              : `#${draft.color.toString(16).padStart(6, '0')}`,
            max: 7
          }),
          textInput({
            id: 'content',
            label: 'Teks di luar embed (opsional)',
            style: TextInputStyle.Paragraph,
            value: draft.content,
            max: 1800
          })
        ])
      );

    case 'ry_hook_addfield':
      if (draft.fields.length >= 25) {
        return hookFail(
          interaction,
          'Maksimal 25 field per embed. Hapus salah satu dulu.'
        );
      }

      return interaction.showModal(
        buildModal('ry_hook_modal_field', 'Tambah Field', [
          textInput({
            id: 'name',
            label: 'Nama Field',
            max: 256,
            required: true
          }),
          textInput({
            id: 'value',
            label: 'Isi Field',
            style: TextInputStyle.Paragraph,
            max: 1024,
            required: true
          }),
          textInput({
            id: 'inline',
            label: 'Sejajar (inline)? ya / tidak',
            value: 'tidak',
            max: 5
          })
        ])
      );

    case 'ry_hook_images':
      return interaction.showModal(
        buildModal('ry_hook_modal_images', 'Images', [
          textInput({
            id: 'thumbnail',
            label: 'URL Thumbnail (gambar kecil)',
            value: draft.thumbnail,
            placeholder: 'https://...',
            max: 500
          }),
          textInput({
            id: 'image',
            label: 'URL Image (gambar besar)',
            value: draft.image,
            placeholder: 'https://...',
            max: 500
          })
        ])
      );

    case 'ry_hook_footer':
      return interaction.showModal(
        buildModal('ry_hook_modal_footer', 'Footer', [
          textInput({
            id: 'text',
            label: 'Teks Footer',
            value: draft.footer.text,
            max: 2048
          }),
          textInput({
            id: 'icon',
            label: 'URL Icon Footer (opsional)',
            value: draft.footer.iconURL,
            placeholder: 'https://...',
            max: 500
          }),
          textInput({
            id: 'timestamp',
            label: 'Tampilkan waktu? ya / tidak',
            value: draft.timestamp ? 'ya' : 'tidak',
            max: 5
          })
        ])
      );

    case 'ry_hook_delfield': {
      if (!draft.fields.length) {
        return hookFail(interaction, 'Belum ada field di draft kamu.');
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('ry_hook_delfield_select')
        .setPlaceholder('Pilih field yang mau dihapus...')
        .addOptions(
          draft.fields.map((field, index) => ({
            label: `${index + 1}. ${field.name}`.slice(0, 100),
            value: String(index)
          }))
        );

      return interaction.reply({
        content: 'Pilih field yang mau dihapus:',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    case 'ry_hook_preview':
      return interaction.reply({
        ...hookPreviewReply(draft, '👁️ Draft kamu saat ini:'),
        ephemeral: true
      });

    case 'ry_hook_send': {
      const problem = hookProblem(draft);

      if (problem) return hookFail(interaction, problem);

      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('ry_hook_send_channel')
        .setPlaceholder('Pilih channel tujuan...')
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        );

      return interaction.reply({
        content: 'Kirim pesan ke channel mana?',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    case 'ry_hook_reset':
      hookDrafts.delete(hookDraftKey(interaction));

      return interaction.reply({
        content: '🗑️ Draft direset. Kamu bisa mulai dari awal.',
        ephemeral: true
      });
  }
}

async function handleHookModal(interaction) {
  const draft = getHookDraft(interaction);
  const get = id => interaction.fields.getTextInputValue(id).trim();

  switch (interaction.customId) {
    case 'ry_hook_modal_author': {
      const name = get('name');
      const iconURL = get('icon');
      const url = get('url');

      if (iconURL && !isValidHttpUrl(iconURL)) {
        return hookFail(interaction, 'URL icon author tidak valid (harus diawali https://).');
      }

      if (url && !isValidHttpUrl(url)) {
        return hookFail(interaction, 'Link author tidak valid (harus diawali https://).');
      }

      draft.author = name ? { name, iconURL, url } : {};

      return interaction.reply({
        ...hookPreviewReply(
          draft,
          name ? '✅ Author disimpan.' : '✅ Author dikosongkan.'
        ),
        ephemeral: true
      });
    }

    case 'ry_hook_modal_body': {
      const url = get('titleurl');
      const colorText = get('color');

      if (url && !isValidHttpUrl(url)) {
        return hookFail(interaction, 'Link judul tidak valid (harus diawali https://).');
      }

      let color = null;

      if (colorText) {
        color = parseHexColor(colorText);

        if (color === null) {
          return hookFail(interaction, 'Warna harus format hex 6 digit, contoh `#5865F2`.');
        }
      }

      draft.title = get('title');
      draft.url = url;
      draft.description = get('description');
      draft.color = color;
      draft.content = get('content');

      return interaction.reply({
        ...hookPreviewReply(draft, '✅ Body disimpan.'),
        ephemeral: true
      });
    }

    case 'ry_hook_modal_field': {
      if (draft.fields.length >= 25) {
        return hookFail(interaction, 'Maksimal 25 field per embed.');
      }

      draft.fields.push({
        name: get('name').slice(0, 256),
        value: get('value').slice(0, 1024),
        inline: parseYes(get('inline'))
      });

      return interaction.reply({
        ...hookPreviewReply(
          draft,
          `✅ Field ditambahkan (total ${draft.fields.length}).`
        ),
        ephemeral: true
      });
    }

    case 'ry_hook_modal_images': {
      const thumbnail = get('thumbnail');
      const image = get('image');

      if (thumbnail && !isValidHttpUrl(thumbnail)) {
        return hookFail(interaction, 'URL thumbnail tidak valid (harus diawali https://).');
      }

      if (image && !isValidHttpUrl(image)) {
        return hookFail(interaction, 'URL image tidak valid (harus diawali https://).');
      }

      draft.thumbnail = thumbnail;
      draft.image = image;

      return interaction.reply({
        ...hookPreviewReply(draft, '✅ Images disimpan.'),
        ephemeral: true
      });
    }

    case 'ry_hook_modal_footer': {
      const text = get('text');
      const iconURL = get('icon');

      if (iconURL && !isValidHttpUrl(iconURL)) {
        return hookFail(interaction, 'URL icon footer tidak valid (harus diawali https://).');
      }

      draft.footer = text ? { text, iconURL } : {};
      draft.timestamp = parseYes(get('timestamp'));

      return interaction.reply({
        ...hookPreviewReply(draft, '✅ Footer disimpan.'),
        ephemeral: true
      });
    }
  }
}

async function routeHook(interaction) {
  const id = interaction.customId;

  if (typeof id !== 'string' || !id.startsWith('ry_hook_')) {
    return false;
  }

  if (!isStaff(interaction.member)) {
    await interaction.reply({
      content: 'Fitur ini hanya untuk admin atau Staff.',
      ephemeral: true
    });

    return true;
  }

  if (interaction.isButton()) {
    await handleHookButton(interaction);
    return true;
  }

  if (interaction.isModalSubmit()) {
    await handleHookModal(interaction);
    return true;
  }

  // Menu hapus field
  if (
    interaction.isStringSelectMenu() &&
    id === 'ry_hook_delfield_select'
  ) {
    const draft = getHookDraft(interaction);
    const index = Number(interaction.values[0]);

    if (Number.isInteger(index) && draft.fields[index]) {
      draft.fields.splice(index, 1);
    }

    await interaction.update({
      ...hookPreviewReply(draft, '✅ Field dihapus.'),
      components: []
    });

    return true;
  }

  // Menu pilih channel tujuan kirim
  if (
    interaction.isChannelSelectMenu() &&
    id === 'ry_hook_send_channel'
  ) {
    const draft = getHookDraft(interaction);
    const problem = hookProblem(draft);

    if (problem) {
      await interaction.update({
        content: `❌ ${problem}`,
        components: []
      });

      return true;
    }

    const channel = interaction.guild.channels.cache.get(
      interaction.values[0]
    );

    const permissions = channel?.permissionsFor(
      interaction.guild.members.me
    );

    if (
      !channel?.isTextBased() ||
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
      ])
    ) {
      await interaction.update({
        content: '❌ Bot tidak punya izin View Channel, Send Messages, dan Embed Links di channel itu.',
        components: []
      });

      return true;
    }

    await interaction.deferUpdate();

    try {
      const sent = await channel.send(buildHookPayload(draft));

      await interaction.editReply({
        content: `✅ Pesan terkirim ke ${channel}: ${sent.url}`,
        components: []
      });
    } catch (error) {
      console.error('Hook gagal kirim:', error);

      await interaction.editReply({
        content: `❌ Gagal mengirim pesan: ${error.message}`,
        components: []
      });
    }

    return true;
  }

  return true;
}

// ===============================
// REACTION ROLE
// ===============================

const RR_PATH = path.join(ROOT, 'reactionroles.json');

let reactionRoles = {};

if (fs.existsSync(RR_PATH)) {
  try {
    reactionRoles = JSON.parse(fs.readFileSync(RR_PATH, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca reactionroles.json:', error);
  }
}

function saveReactionRoles() {
  fs.writeFileSync(
    RR_PATH,
    JSON.stringify(reactionRoles, null, 2)
  );
}

const RR_MODE_LABEL = {
  button: 'Tombol',
  dropdown: 'Dropdown',
  reaction: 'Reaksi Emoji'
};

const RR_LIMITS = {
  button: 25,
  dropdown: 25,
  reaction: 20
};

// Role dengan izin ini nggak boleh jadi role yang bisa diambil sendiri
const RR_BLOCKED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers
];

const UNICODE_EMOJI_REGEX =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

function parseEmoji(text) {
  const raw = String(text || '').trim();

  if (!raw) return null;

  const custom = raw.match(/^<(a?):(\w{2,32}):(\d{17,20})>$/);

  if (custom) {
    return {
      animated: custom[1] === 'a',
      name: custom[2],
      id: custom[3]
    };
  }

  return { animated: false, name: raw, id: null };
}

const emojiKey = emoji => emoji.id || emoji.name;

const emojiReactRef = emoji =>
  emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;

const emojiDisplay = emoji =>
  emoji.id
    ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
    : emoji.name;

const emojiForComponent = emoji =>
  emoji.id
    ? { id: emoji.id, name: emoji.name, animated: emoji.animated }
    : emoji.name;

function guildRRPanels(guildId) {
  return Object.values(reactionRoles)
    .filter(panel => panel.guildId === guildId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function rrPanelLink(panel) {
  return `https://discord.com/channels/${panel.guildId}/${panel.channelId}/${panel.messageId}`;
}

// Balikin teks error kalau role nggak aman / nggak bisa dibagikan bot
function checkRoleAssignable(guild, role) {
  const me = guild.members.me;

  if (!me) return 'Bot belum siap, coba lagi sebentar.';

  if (role.id === guild.id) {
    return 'Role @everyone tidak bisa dipakai.';
  }

  if (role.managed) {
    return 'Role itu dikelola bot/integrasi lain, jadi tidak bisa dibagikan.';
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Bot butuh izin **Manage Roles**.';
  }

  if (role.position >= me.roles.highest.position) {
    return 'Role itu posisinya sejajar atau di atas role bot. Naikkan role bot di atas role tersebut (Server Settings → Roles).';
  }

  if (RR_BLOCKED_PERMISSIONS.some(permission => role.permissions.has(permission))) {
    return 'Role itu punya izin berbahaya (Administrator, Manage Server/Roles/Channels, Ban, Kick, atau Timeout), jadi tidak boleh dijadikan role yang bisa diambil sendiri.';
  }

  return null;
}

function buildRRPayload(panel, guild) {
  const lines = panel.items.map(item => {
    const emoji = item.emoji ? `${emojiDisplay(item.emoji)} ` : '';
    const label = item.label ? ` — ${item.label}` : '';

    return `${emoji}<@&${item.roleId}>${label}`;
  });

  const footers = {
    button: 'Klik tombol untuk ambil atau lepas role',
    dropdown: 'Pilih role kamu dari menu di bawah',
    reaction: 'Beri reaksi untuk ambil role • hapus reaksi untuk melepas'
  };

  const description = [
    panel.description,
    lines.length ? lines.join('\n') : '_Belum ada role di panel ini._'
  ].filter(Boolean).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(panel.title)
    .setDescription(description.slice(0, 4096))
    .setFooter({ text: footers[panel.mode] });

  const roleName = item =>
    guild.roles.cache.get(item.roleId)?.name || 'Role';

  let components = [];

  if (panel.mode === 'button' && panel.items.length) {
    for (let i = 0; i < panel.items.length; i += 5) {
      components.push(
        new ActionRowBuilder().addComponents(
          panel.items.slice(i, i + 5).map(item => {
            const button = new ButtonBuilder()
              .setCustomId(`ry_rr_btn:${item.roleId}`)
              .setLabel((item.label || roleName(item)).slice(0, 80))
              .setStyle(ButtonStyle.Secondary);

            if (item.emoji) button.setEmoji(emojiForComponent(item.emoji));

            return button;
          })
        )
      );
    }
  }

  if (panel.mode === 'dropdown' && panel.items.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ry_rr_menu')
      .setPlaceholder('Pilih role kamu...')
      .setMinValues(0)
      .setMaxValues(panel.items.length)
      .addOptions(
        panel.items.map(item => ({
          label: (item.label || roleName(item)).slice(0, 100),
          value: item.roleId,
          ...(item.description
            ? { description: item.description.slice(0, 100) }
            : {}),
          ...(item.emoji
            ? { emoji: emojiForComponent(item.emoji) }
            : {})
        }))
      );

    components = [new ActionRowBuilder().addComponents(menu)];
  }

  return { embeds: [embed], components };
}

async function fetchRRMessage(panel) {
  const guild = client.guilds.cache.get(panel.guildId);
  const channel = guild?.channels.cache.get(panel.channelId);

  if (!channel?.isTextBased()) return null;

  return channel.messages.fetch(panel.messageId).catch(() => null);
}

// ---------- Penggunaan oleh member ----------

async function handleRRMemberButton(interaction) {
  const panel = reactionRoles[interaction.message.id];
  const roleId = interaction.customId.split(':')[1];

  if (
    !panel ||
    !panel.items.some(item => item.roleId === roleId)
  ) {
    return interaction.reply({
      content: 'Panel ini sudah tidak aktif.',
      ephemeral: true
    });
  }

  const role = interaction.guild.roles.cache.get(roleId);

  if (!role || checkRoleAssignable(interaction.guild, role)) {
    return interaction.reply({
      content: 'Role ini sedang tidak bisa diberikan bot. Hubungi admin.',
      ephemeral: true
    });
  }

  if (interaction.member.roles.cache.has(roleId)) {
    await interaction.member.roles.remove(role, 'Reaction role RY');

    return interaction.reply({
      content: `❎ Role **${role.name}** dilepas.`,
      ephemeral: true
    });
  }

  await interaction.member.roles.add(role, 'Reaction role RY');

  return interaction.reply({
    content: `✅ Role **${role.name}** ditambahkan.`,
    ephemeral: true
  });
}

async function handleRRMemberMenu(interaction) {
  const panel = reactionRoles[interaction.message.id];

  if (!panel) {
    return interaction.reply({
      content: 'Panel ini sudah tidak aktif.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const toAdd = [];
  const toRemove = [];

  for (const item of panel.items) {
    const role = interaction.guild.roles.cache.get(item.roleId);

    if (!role || checkRoleAssignable(interaction.guild, role)) continue;

    const wanted = interaction.values.includes(item.roleId);
    const has = interaction.member.roles.cache.has(item.roleId);

    if (wanted && !has) toAdd.push(role);
    if (!wanted && has) toRemove.push(role);
  }

  if (toAdd.length) {
    await interaction.member.roles.add(toAdd, 'Reaction role RY');
  }

  if (toRemove.length) {
    await interaction.member.roles.remove(toRemove, 'Reaction role RY');
  }

  const lines = [];

  if (toAdd.length) {
    lines.push(`✅ Ditambahkan: ${toAdd.map(role => `**${role.name}**`).join(', ')}`);
  }

  if (toRemove.length) {
    lines.push(`❎ Dilepas: ${toRemove.map(role => `**${role.name}**`).join(', ')}`);
  }

  return interaction.editReply(
    lines.length ? lines.join('\n') : 'Tidak ada perubahan role.'
  );
}

async function handleRRReaction(reaction, user, adding) {
  if (user.bot) return;

  const panel = reactionRoles[reaction.message.id];

  if (!panel || panel.mode !== 'reaction') return;

  const key = reaction.emoji.id || reaction.emoji.name;

  const item = panel.items.find(
    entry => entry.emoji && emojiKey(entry.emoji) === key
  );

  if (!item) return;

  const guild = client.guilds.cache.get(panel.guildId);
  const role = guild?.roles.cache.get(item.roleId);

  if (!guild || !role || checkRoleAssignable(guild, role)) return;

  const member = await guild.members.fetch(user.id).catch(() => null);

  if (!member) return;

  if (adding) {
    await member.roles.add(role, 'Reaction role RY');
  } else {
    await member.roles.remove(role, 'Reaction role RY');
  }
}

// ---------- Panel setting (khusus Staff) ----------

async function replyRRPicker(interaction, action, placeholder, intro) {
  const panels = guildRRPanels(interaction.guild.id).slice(0, 25);

  if (!panels.length) {
    return interaction.reply({
      content: 'Belum ada panel reaction role. Klik **Buat Panel** dulu.',
      ephemeral: true
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ry_rr_pick:${action}`)
    .setPlaceholder(placeholder)
    .addOptions(
      panels.map(panel => {
        const channelName =
          interaction.guild.channels.cache.get(panel.channelId)?.name ||
          'channel';

        return {
          label: panel.title.slice(0, 100),
          description:
            `${RR_MODE_LABEL[panel.mode]} • ${panel.items.length} role • #${channelName}`.slice(0, 100),
          value: panel.messageId
        };
      })
    );

  return interaction.reply({
    content: intro,
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true
  });
}

async function handleRRPanelButton(interaction) {
  switch (interaction.customId) {
    case 'ry_rr_panel_new': {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId('ry_rr_new_channel')
        .setPlaceholder('Pilih channel tempat panel dikirim...')
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        );

      return interaction.reply({
        content: '**Langkah 1/3** — pilih channel tujuan panel:',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
    }

    case 'ry_rr_panel_add':
      return replyRRPicker(
        interaction,
        'add',
        'Pilih panel...',
        'Tambah role ke panel mana?'
      );

    case 'ry_rr_panel_delrole':
      return replyRRPicker(
        interaction,
        'delrole',
        'Pilih panel...',
        'Hapus role dari panel mana?'
      );

    case 'ry_rr_panel_delpanel':
      return replyRRPicker(
        interaction,
        'delpanel',
        'Pilih panel...',
        'Panel mana yang mau dihapus?'
      );

    case 'ry_rr_panel_list': {
      const panels = guildRRPanels(interaction.guild.id);

      if (!panels.length) {
        return interaction.reply({
          content: 'Belum ada panel reaction role.',
          ephemeral: true
        });
      }

      const lines = panels.map(panel =>
        `• **${panel.title}** (${RR_MODE_LABEL[panel.mode]}) — <#${panel.channelId}> — ${panel.items.length} role — [lihat](${rrPanelLink(panel)})`
      );

      return interaction.reply({
        content: lines.join('\n').slice(0, 1900),
        ephemeral: true
      });
    }
  }
}

// Langkah 1 selesai: channel dipilih -> pilih tipe panel
async function handleRRNewChannel(interaction) {
  const channelId = interaction.values[0];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ry_rr_new_mode:button:${channelId}`)
      .setLabel('Tombol')
      .setEmoji('🔘')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ry_rr_new_mode:dropdown:${channelId}`)
      .setLabel('Dropdown')
      .setEmoji('📂')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ry_rr_new_mode:reaction:${channelId}`)
      .setLabel('Reaksi Emoji')
      .setEmoji('😀')
      .setStyle(ButtonStyle.Primary)
  );

  return interaction.update({
    content:
      `**Langkah 2/3** — channel: <#${channelId}>\nPilih tipe panel:\n` +
      '• **Tombol** — klik tombol untuk ambil / lepas role\n' +
      '• **Dropdown** — pilih role dari satu menu\n' +
      '• **Reaksi Emoji** — member bereaksi emoji pada pesan',
    components: [row]
  });
}

// Langkah 2 selesai: tipe dipilih -> isi judul & deskripsi
async function handleRRNewMode(interaction) {
  const [, mode, channelId] = interaction.customId.split(':');

  return interaction.showModal(
    buildModal(
      `ry_rr_modal_new:${mode}:${channelId}`,
      `Panel ${RR_MODE_LABEL[mode] || ''}`.trim(),
      [
        textInput({
          id: 'title',
          label: 'Judul Panel',
          placeholder: 'Contoh: Pilih Role Kamu',
          max: 100,
          required: true
        }),
        textInput({
          id: 'description',
          label: 'Deskripsi (opsional)',
          style: TextInputStyle.Paragraph,
          max: 1000
        })
      ]
    )
  );
}

// Langkah 3: form judul disubmit -> kirim panel
async function handleRRNewModal(interaction) {
  const [, mode, channelId] = interaction.customId.split(':');

  if (!RR_MODE_LABEL[mode]) {
    return interaction.reply({
      content: 'Tipe panel tidak valid.',
      ephemeral: true
    });
  }

  const guild = interaction.guild;
  const channel = guild.channels.cache.get(channelId);

  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory
  ];

  if (mode === 'reaction') {
    required.push(PermissionFlagsBits.AddReactions);
  }

  if (
    !channel?.isTextBased() ||
    !channel.permissionsFor(guild.members.me)?.has(required)
  ) {
    return interaction.reply({
      content: '❌ Bot tidak punya izin yang cukup di channel itu (View Channel, Send Messages, Embed Links, Read Message History' +
        (mode === 'reaction' ? ', Add Reactions' : '') + ').',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const panel = {
    guildId: guild.id,
    channelId: channel.id,
    messageId: null,
    mode,
    title: interaction.fields.getTextInputValue('title').trim().slice(0, 100),
    description: interaction.fields.getTextInputValue('description').trim().slice(0, 1000),
    items: [],
    createdBy: interaction.user.id,
    createdAt: Date.now()
  };

  const sent = await channel.send(buildRRPayload(panel, guild));

  panel.messageId = sent.id;
  reactionRoles[sent.id] = panel;
  saveReactionRoles();

  return interaction.editReply(
    `✅ Panel **${panel.title}** (${RR_MODE_LABEL[mode]}) dibuat di ${channel}: ${sent.url}\n` +
    '**Langkah 3/3** — klik **Tambah Role** di panel untuk mengisinya.'
  );
}

async function handleRRPick(interaction) {
  const action = interaction.customId.split(':')[1];
  const panel = reactionRoles[interaction.values[0]];

  if (!panel || panel.guildId !== interaction.guild.id) {
    return interaction.update({
      content: 'Panel tidak ditemukan.',
      components: []
    });
  }

  if (action === 'add') {
    if (panel.items.length >= RR_LIMITS[panel.mode]) {
      return interaction.update({
        content: `Panel ini sudah penuh (maksimal ${RR_LIMITS[panel.mode]} role untuk tipe ${RR_MODE_LABEL[panel.mode]}).`,
        components: []
      });
    }

    const menu = new RoleSelectMenuBuilder()
      .setCustomId(`ry_rr_addrole:${panel.messageId}`)
      .setPlaceholder('Pilih role yang mau ditambahkan...')
      .setMinValues(1)
      .setMaxValues(1);

    return interaction.update({
      content: `Pilih role untuk panel **${panel.title}**:`,
      components: [new ActionRowBuilder().addComponents(menu)]
    });
  }

  if (action === 'delrole') {
    if (!panel.items.length) {
      return interaction.update({
        content: 'Panel ini belum punya role.',
        components: []
      });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ry_rr_delitem:${panel.messageId}`)
      .setPlaceholder('Pilih role yang mau dihapus...')
      .addOptions(
        panel.items.map(item => {
          const roleName =
            interaction.guild.roles.cache.get(item.roleId)?.name ||
            'Role (sudah dihapus)';

          return {
            label: roleName.slice(0, 100),
            value: item.roleId,
            ...(item.emoji
              ? { emoji: emojiForComponent(item.emoji) }
              : {})
          };
        })
      );

    return interaction.update({
      content: `Hapus role dari panel **${panel.title}**:`,
      components: [new ActionRowBuilder().addComponents(menu)]
    });
  }

  if (action === 'delpanel') {
    await interaction.deferUpdate();

    const message = await fetchRRMessage(panel);

    await message?.delete().catch(() => {});

    delete reactionRoles[panel.messageId];
    saveReactionRoles();

    return interaction.editReply({
      content: `🗑️ Panel **${panel.title}** dihapus.`,
      components: []
    });
  }
}

// Role dipilih -> buka form emoji & label
async function handleRRAddRole(interaction) {
  const panelId = interaction.customId.split(':')[1];
  const panel = reactionRoles[panelId];
  const role = interaction.roles.first();

  if (!panel || panel.guildId !== interaction.guild.id || !role) {
    return interaction.update({
      content: 'Panel atau role tidak ditemukan.',
      components: []
    });
  }

  const problem = checkRoleAssignable(interaction.guild, role);

  if (problem) {
    return interaction.update({
      content: `❌ ${problem}`,
      components: []
    });
  }

  if (panel.items.some(item => item.roleId === role.id)) {
    return interaction.update({
      content: 'Role itu sudah ada di panel ini.',
      components: []
    });
  }

  const rows = [
    textInput({
      id: 'emoji',
      label: panel.mode === 'reaction' ? 'Emoji (wajib)' : 'Emoji (opsional)',
      placeholder: 'Contoh: 🎮 atau <:nama:123456789012345678>',
      max: 60,
      required: panel.mode === 'reaction'
    }),
    textInput({
      id: 'label',
      label: 'Label (kosongkan = nama role)',
      max: 80
    })
  ];

  if (panel.mode === 'dropdown') {
    rows.push(
      textInput({
        id: 'description',
        label: 'Deskripsi (opsional)',
        max: 100
      })
    );
  }

  return interaction.showModal(
    buildModal(
      `ry_rr_modal_item:${panelId}:${role.id}`,
      'Detail Role',
      rows
    )
  );
}

// Form emoji & label disubmit -> tambahkan ke panel
async function handleRRItemModal(interaction) {
  const [, panelId, roleId] = interaction.customId.split(':');
  const guild = interaction.guild;
  const panel = reactionRoles[panelId];
  const role = guild.roles.cache.get(roleId);

  if (!panel || panel.guildId !== guild.id || !role) {
    return interaction.reply({
      content: 'Panel atau role tidak ditemukan.',
      ephemeral: true
    });
  }

  const problem = checkRoleAssignable(guild, role);

  if (problem) {
    return interaction.reply({ content: `❌ ${problem}`, ephemeral: true });
  }

  if (
    panel.items.some(item => item.roleId === roleId) ||
    panel.items.length >= RR_LIMITS[panel.mode]
  ) {
    return interaction.reply({
      content: 'Role sudah ada di panel, atau panel sudah penuh.',
      ephemeral: true
    });
  }

  const emoji = parseEmoji(interaction.fields.getTextInputValue('emoji'));
  const label = interaction.fields.getTextInputValue('label').trim().slice(0, 80);

  const description = panel.mode === 'dropdown'
    ? interaction.fields.getTextInputValue('description').trim().slice(0, 100)
    : '';

  if (panel.mode === 'reaction' && !emoji) {
    return interaction.reply({
      content: '❌ Panel tipe Reaksi Emoji wajib memakai emoji.',
      ephemeral: true
    });
  }

  if (emoji && !emoji.id && !UNICODE_EMOJI_REGEX.test(emoji.name)) {
    return interaction.reply({
      content: '❌ Emoji tidak valid. Pakai emoji biasa (🎮) atau emoji custom server (<:nama:id>).',
      ephemeral: true
    });
  }

  if (
    panel.mode === 'reaction' &&
    panel.items.some(
      item => item.emoji && emojiKey(item.emoji) === emojiKey(emoji)
    )
  ) {
    return interaction.reply({
      content: '❌ Emoji itu sudah dipakai role lain di panel ini.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const message = await fetchRRMessage(panel);

  if (!message) {
    return interaction.editReply(
      '❌ Pesan panel tidak ditemukan (mungkin terhapus). Buat panel baru.'
    );
  }

  if (panel.mode === 'reaction') {
    try {
      await message.react(emojiReactRef(emoji));
    } catch {
      return interaction.editReply(
        '❌ Bot tidak bisa memakai emoji itu. Kalau emoji custom, pastikan emoji berasal dari server yang bot ikuti.'
      );
    }
  }

  panel.items.push({
    roleId,
    emoji: emoji || null,
    label,
    description
  });

  try {
    await message.edit(buildRRPayload(panel, guild));
  } catch (error) {
    panel.items.pop();

    return interaction.editReply(
      `❌ Gagal memperbarui panel: ${error.message}`
    );
  }

  saveReactionRoles();

  return interaction.editReply(
    `✅ Role **${role.name}** ditambahkan ke panel **${panel.title}**.`
  );
}

async function handleRRDelItem(interaction) {
  const panelId = interaction.customId.split(':')[1];
  const panel = reactionRoles[panelId];
  const roleId = interaction.values[0];

  await interaction.deferUpdate();

  const index = panel
    ? panel.items.findIndex(item => item.roleId === roleId)
    : -1;

  if (!panel || panel.guildId !== interaction.guild.id || index < 0) {
    return interaction.editReply({
      content: 'Role tidak ditemukan di panel.',
      components: []
    });
  }

  const [removed] = panel.items.splice(index, 1);

  saveReactionRoles();

  const message = await fetchRRMessage(panel);

  if (message) {
    await message
      .edit(buildRRPayload(panel, interaction.guild))
      .catch(console.error);

    if (panel.mode === 'reaction' && removed.emoji) {
      const key = emojiKey(removed.emoji);

      await message.reactions.cache
        .find(reaction => (reaction.emoji.id || reaction.emoji.name) === key)
        ?.remove()
        .catch(() => {});
    }
  }

  return interaction.editReply({
    content: '✅ Role dihapus dari panel.',
    components: []
  });
}

async function routeReactionRole(interaction) {
  const id = interaction.customId;

  if (typeof id !== 'string' || !id.startsWith('ry_rr_')) {
    return false;
  }

  // Dipakai member biasa (tanpa cek Staff)
  if (interaction.isButton() && id.startsWith('ry_rr_btn:')) {
    await handleRRMemberButton(interaction);
    return true;
  }

  if (interaction.isStringSelectMenu() && id === 'ry_rr_menu') {
    await handleRRMemberMenu(interaction);
    return true;
  }

  // Selebihnya khusus admin / Staff
  if (!isStaff(interaction.member)) {
    await interaction.reply({
      content: 'Fitur ini hanya untuk admin atau Staff.',
      ephemeral: true
    });

    return true;
  }

  if (interaction.isButton()) {
    if (id.startsWith('ry_rr_new_mode:')) {
      await handleRRNewMode(interaction);
    } else {
      await handleRRPanelButton(interaction);
    }

    return true;
  }

  if (interaction.isChannelSelectMenu() && id === 'ry_rr_new_channel') {
    await handleRRNewChannel(interaction);
    return true;
  }

  if (interaction.isRoleSelectMenu() && id.startsWith('ry_rr_addrole:')) {
    await handleRRAddRole(interaction);
    return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (id.startsWith('ry_rr_pick:')) {
      await handleRRPick(interaction);
    } else if (id.startsWith('ry_rr_delitem:')) {
      await handleRRDelItem(interaction);
    }

    return true;
  }

  if (interaction.isModalSubmit()) {
    if (id.startsWith('ry_rr_modal_new:')) {
      await handleRRNewModal(interaction);
    } else if (id.startsWith('ry_rr_modal_item:')) {
      await handleRRItemModal(interaction);
    }

    return true;
  }

  return true;
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

  // Daftarkan slash command di semua server (langsung aktif)
  for (const guild of client.guilds.cache.values()) {
    registerSlashCommands(guild);
  }

  // Cek giveaway yang udah waktunya berakhir (tahan restart bot)
  checkGiveaways();
  setInterval(checkGiveaways, 10000);

  client.user.setPresence({
    activities: [{ name: '/help | RY Support' }],
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
// TOMBOL DAN MENU INTERAKSI
// ===============================

client.on('interactionCreate', async interaction => {
  try {
    // Slash command
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    // Hook (embed builder) dan Reaction Role
    if (await routeHook(interaction)) return;
    if (await routeReactionRole(interaction)) return;

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

    if (interaction.isRepliable()) {
      const errorMessage = {
        content: 'Terjadi error. Hubungi admin.',
        ephemeral: true
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
});

// Server baru: daftarkan slash command
client.on('guildCreate', guild => {
  registerSlashCommands(guild);
});

// Reaction role (tipe reaksi emoji)
client.on('messageReactionAdd', (reaction, user) => {
  handleRRReaction(reaction, user, true).catch(console.error);
});

client.on('messageReactionRemove', (reaction, user) => {
  handleRRReaction(reaction, user, false).catch(console.error);
});

// Panel reaction role dihapus manual -> bersihin datanya
client.on('messageDelete', message => {
  if (reactionRoles[message.id]) {
    delete reactionRoles[message.id];
    saveReactionRoles();
  }
});

client.on('error', console.error);

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

client.login(TOKEN);
