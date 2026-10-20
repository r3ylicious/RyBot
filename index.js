
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

const fs = require("node:fs");
const path = require("node:path");

try {
  process.env.FFMPEG_PATH = require("ffmpeg-static");
} catch {}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PREFIX = process.env.PREFIX || "ry!";
const AUDIO = path.join(__dirname, "welcome.mp3");
const CONFIG_PATH = path.join(__dirname, "config.json");

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Isi DISCORD_TOKEN, CLIENT_ID, dan GUILD_ID di Render.");
  process.exit(1);
}

let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup server RY")
    .addSubcommand(s => s.setName("all").setDescription("Setup semua sistem"))
    .addSubcommand(s => s.setName("welcome").setDescription("Setup welcome"))
    .addSubcommand(s => s.setName("ticket").setDescription("Setup ticket"))
    .addSubcommand(s => s.setName("vouches").setDescription("Setup vouches")),

  new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Fitur welcome")
    .addSubcommand(s => s.setName("test").setDescription("Tes suara welcome di voice channel")),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Kelola tiket")
    .addSubcommand(s => s.setName("close").setDescription("Tutup tiket ini")),

  new SlashCommandBuilder()
    .setName("vouches")
    .setDescription("Kirim vouch atau testimoni")
    .addStringOption(o =>
      o.setName("feedback").setDescription("Isi testimoni").setRequired(true))
    .addAttachmentOption(o =>
      o.setName("bukti").setDescription("Upload gambar bukti (opsional)").setRequired(false))
    .addUserOption(o =>
      o.setName("untuk").setDescription("Anggota yang diberi vouch").setRequired(false)),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Lihat daftar command RY")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands berhasil didaftarkan.");
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function ensureCategory(guild, name) {
  let ch = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (!ch) ch = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory
  });
  return ch;
}

async function ensureChannel(guild, name, type, parent) {
  let ch = guild.channels.cache.find(
    c => c.name === name && c.type === type
  );
  if (!ch) ch = await guild.channels.create({
    name,
    type,
    parent: parent?.id
  });
  return ch;
}

async function setupWelcome(guild) {
  const category = await ensureCategory(guild, "INFORMATION");
  const welcome = await ensureChannel(
    guild, "welcome", ChannelType.GuildVoice, category
  );
  const chat = await ensureChannel(
    guild, "welcome-chat", ChannelType.GuildText, category
  );
  config.welcomeVoiceId = welcome.id;
  config.welcomeTextId = chat.id;

  const verified = guild.roles.cache.find(r => r.name === "Verified");
  if (verified) config.verifiedRoleId = verified.id;
  saveConfig();
  return "Welcome voice dan channel welcome sudah disiapkan.";
}

async function setupTicket(guild) {
  const category = await ensureCategory(guild, "SUPPORT");
  const panel = await ensureChannel(
    guild, "create-ticket", ChannelType.GuildText, category
  );
  config.ticketCategoryId = category.id;
  config.ticketPanelId = panel.id;
  saveConfig();

  const embed = new EmbedBuilder()
    .setTitle("RY Support Ticket")
    .setDescription("Tekan tombol di bawah untuk membuat tiket bantuan.")
    .setColor(0x5865F2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ry_ticket_create")
      .setLabel("Buat Ticket")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🎫")
  );

  await panel.send({ embeds: [embed], components: [row] });
  return "Ticket panel berhasil disiapkan.";
}

async function setupVouches(guild) {
  const category = await ensureCategory(guild, "COMMUNITY");
  const channel = await ensureChannel(
    guild, "vouches", ChannelType.GuildText, category
  );
  config.vouchesChannelId = channel.id;
  saveConfig();
  return "Channel vouches sudah disiapkan.";
}

async function setupAll(guild) {
  let verified = guild.roles.cache.find(r => r.name === "Verified");
  if (!verified) {
    verified = await guild.roles.create({
      name: "Verified",
      reason: "Setup RY bot"
    });
  }

  let staff = guild.roles.cache.find(r => r.name === "Staff");
  if (!staff) {
    staff = await guild.roles.create({
      name: "Staff",
      reason: "Setup RY bot"
    });
  }

  config.verifiedRoleId = verified.id;
  config.staffRoleId = staff.id;

  const info = await ensureCategory(guild, "INFORMATION");
  const community = await ensureCategory(guild, "COMMUNITY");
  const support = await ensureCategory(guild, "SUPPORT");
  const voice = await ensureCategory(guild, "VOICE");

  await ensureChannel(guild, "rules", ChannelType.GuildText, info);
  await ensureChannel(guild, "announcements", ChannelType.GuildText, info);
  await ensureChannel(guild, "server-info", ChannelType.GuildText, info);
  await ensureChannel(guild, "general", ChannelType.GuildText, community);
  await ensureChannel(guild, "gaming", ChannelType.GuildText, community);
  await ensureChannel(guild, "media", ChannelType.GuildText, community);
  await ensureChannel(guild, "general-voice", ChannelType.GuildVoice, voice);
  await ensureChannel(guild, "gaming-voice", ChannelType.GuildVoice, voice);

  saveConfig();
  const a = await setupWelcome(guild);
  const b = await setupTicket(guild);
  const c = await setupVouches(guild);
  return `Setup selesai!\n${a}\n${b}\n${c}\nRole Verified dan Staff sudah dibuat.`;
}

async function playAudio(channel, memberToVerify = null) {
  try {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error("Voice channel tidak ditemukan.");
    }
    if (!fs.existsSync(AUDIO)) {
      throw new Error("File welcome.mp3 belum ada di repository.");
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    const player = createAudioPlayer();
    const resource = createAudioResource(AUDIO);
    connection.subscribe(player);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Audio timeout setelah 90 detik.")),
        90_000
      );
      player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(timeout);
        resolve();
      });
      player.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
      player.play(resource);
    });

    connection.destroy();
  } finally {
    if (memberToVerify) {
      const role = memberToVerify.guild.roles.cache.get(config.verifiedRoleId);
      if (role) {
        try {
          await memberToVerify.roles.add(role, "Welcome voice selesai");
        } catch (err) {
          console.error("Gagal memberikan Verified role:", err.message);
        }
      } else {
        console.warn("Role Verified belum diset. Jalankan /setup all.");
      }
    }
  }
}

async function closeTicket(channel, user) {
  if (!channel.name.startsWith("ticket-")) {
    throw new Error("Command ini hanya bisa dipakai di channel ticket.");
  }
  await channel.permissionOverwrites.edit(user.id, {
    SendMessages: false
  }).catch(() => {});
  await channel.setName(`closed-${channel.name}`.slice(0, 100));
  await channel.send(`🔒 Ticket ditutup oleh ${user}.`);
}

client.once("ready", async () => {
  console.log(`RY online sebagai ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error("Gagal mendaftarkan command:", err);
  }
});

client.on("guildMemberAdd", async member => {
  const channel = member.guild.channels.cache.get(config.welcomeTextId);
  if (channel) {
    channel.send(`Selamat datang ${member}! Baca rules dan nikmati server RY.`);
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!newState.channel || oldState.channelId === newState.channelId) return;
  if (newState.member?.user.bot) return;

  const welcomeId = config.welcomeVoiceId;
  if (welcomeId && newState.channelId === welcomeId) {
    try {
      await playAudio(newState.channel, newState.member);
    } catch (err) {
      console.error("Welcome voice error:", err);
      if (newState.member) {
        const role = newState.guild.roles.cache.get(config.verifiedRoleId);
        if (role) {
          await newState.member.roles.add(role).catch(() => {});
        }
      }
    }
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "help") {
        return interaction.reply({
          ephemeral: true,
          content:
            "**RY Commands**\n" +
            "`/setup all` — setup semua sistem\n" +
            "`/setup welcome` — setup welcome\n" +
            "`/setup ticket` — setup ticket\n" +
            "`/setup vouches` — setup vouches\n" +
            "`/welcome test` — tes suara di voice channel\n" +
            "`/ticket close` — tutup ticket\n" +
            "`/vouches` — kirim testimoni"
        });
      }

      if (commandName === "setup") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({
            content: "Command setup hanya untuk admin.",
            ephemeral: true
          });
        }
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();
        let result;
        if (sub === "all") result = await setupAll(interaction.guild);
        if (sub === "welcome") result = await setupWelcome(interaction.guild);
        if (sub === "ticket") result = await setupTicket(interaction.guild);
        if (sub === "vouches") result = await setupVouches(interaction.guild);
        return interaction.editReply(result || "Setup selesai.");
      }

      if (commandName === "welcome") {
        if (interaction.options.getSubcommand() === "test") {
          const voice = interaction.member.voice?.channel;
          if (!voice) {
            return interaction.reply({
              content: "Masuk ke voice channel dulu, bre.",
              ephemeral: true
            });
          }
          await interaction.reply({
            content: "Mencoba memutar welcome.mp3...",
            ephemeral: true
          });
          await playAudio(voice);
          return interaction.followUp({
            content: "Tes audio selesai.",
            ephemeral: true
          });
        }
      }

      if (commandName === "ticket") {
        if (interaction.options.getSubcommand() === "close") {
          await closeTicket(interaction.channel, interaction.user);
          return interaction.reply({
            content: "Ticket ditutup.",
            ephemeral: true
          });
        }
      }

      if (commandName === "vouches") {
        const channel = interaction.guild.channels.cache.get(config.vouchesChannelId);
        if (!channel) {
          return interaction.reply({
            content: "Channel vouches belum disiapkan. Jalankan /setup vouches.",
            ephemeral: true
          });
        }
        const feedback = interaction.options.getString("feedback");
        const proof = interaction.options.getAttachment("bukti");
        const target = interaction.options.getUser("untuk");
        const embed = new EmbedBuilder()
          .setTitle("New Vouch")
          .setDescription(feedback)
          .addFields(
            { name: "Dari", value: `${interaction.user}`, inline: true },
            { name: "Untuk", value: target ? `${target}` : "Tidak disebutkan", inline: true }
          )
          .setColor(0x57F287)
          .setTimestamp();

        if (proof?.contentType?.startsWith("image/")) {
          embed.setImage(proof.url);
        } else if (proof) {
          embed.addFields({ name: "Bukti", value: proof.url });
        }

        await channel.send({ embeds: [embed] });
        return interaction.reply({
          content: "Vouch berhasil dikirim!",
          ephemeral: true
        });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "ry_ticket_create") {
        const guild = interaction.guild;
        const existing = guild.channels.cache.find(
          c => c.name === `ticket-${interaction.user.id}`
        );
        if (existing) {
          return interaction.reply({
            content: `Lu sudah punya ticket: ${existing}`,
            ephemeral: true
          });
        }

        const category = guild.channels.cache.get(config.ticketCategoryId);
        const staffRole = guild.roles.cache.get(config.staffRoleId);
        const overwrites = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }
        ];
        if (staffRole) {
          overwrites.push({
            id: staffRole.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          });
        }

        const ticket = await guild.channels.create({
          name: `ticket-${interaction.user.id}`,
          type: ChannelType.GuildText,
          parent: category?.id,
          permissionOverwrites: overwrites
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ry_ticket_claim")
            .setLabel("Claim")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("ry_ticket_close")
            .setLabel("Close")
            .setStyle(ButtonStyle.Danger)
        );
        await ticket.send({
          content: `${interaction.user} selamat datang! Jelaskan masalah lu di sini.`,
          components: [row]
        });
        return interaction.reply({
          content: `Ticket berhasil dibuat: ${ticket}`,
          ephemeral: true
        });
      }

      if (interaction.customId === "ry_ticket_claim") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({
            content: "Hanya staff yang punya izin Manage Channels bisa claim.",
            ephemeral: true
          });
        }
        return interaction.reply(`Ticket di-claim oleh ${interaction.user}.`);
      }

      if (interaction.customId === "ry_ticket_close") {
        await interaction.deferReply();
        await closeTicket(interaction.channel, interaction.user);
        return interaction.editReply("Ticket ditutup.");
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const message = "Terjadi error. Cek log bot di Render.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      }
    }
  }
});

client.login(TOKEN);
