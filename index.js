
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1573486120866685111';

const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const TIKTOK_HANDLES = ['baratheonmc_', 'shahemsettin', 'arzolkk'];
const YOUTUBE_HANDLE = 'ArzoLX';
const POLL_INTERVAL_MS = 3 * 60 * 1000;

if (!TOKEN) {
  console.error('TOKEN ortam değişkeni eksik.');
  process.exit(1);
}

process.on('unhandledRejection', err => {
  console.error('Yakalanmamış Promise Hatası:', err);
});

process.on('uncaughtException', err => {
  console.error('Yakalanmamış İstisna:', err);
});

// RÜTBE VE TİK SİSTEMİ
const RANKS = [
  { name: 'Member Of Baratheon', threshold: 0 },
  { name: 'Co-Muhafız', threshold: 5 },
  { name: 'Muhafız', threshold: 10 },
  { name: 'Man-at-Arms', threshold: 15 },
  { name: 'Squire', threshold: 20 },
  { name: 'Ser', threshold: 25 },
  { name: 'Lord', threshold: 30 },
  { name: 'Heir', threshold: 35 },
  { name: 'Guardian', threshold: 40 },
  { name: 'KingsGuard', threshold: 45 },
  { name: 'Dük', threshold: 50 },
  { name: 'Baron', threshold: 55 },
  { name: 'Mayor', threshold: null },
  { name: 'Councial', threshold: null }
];

const RANK_NAMES = RANKS.map(r => r.name);
const DB_PATH = path.join(__dirname, 'data.json');

let db = {};

try {
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, 'utf8').trim();
    db = raw ? JSON.parse(raw) : {};
  }
} catch (err) {
  console.error('Veri dosyası okunamadı:', err.message);
  db = {};
}

if (!db._notifications || typeof db._notifications !== 'object') {
  db._notifications = {
    initialized: false,
    youtubeChannelId: '',
    youtubeVideoIds: [],
    tiktokVideoIds: {}
  };
}

if (!Array.isArray(db._notifications.youtubeVideoIds)) {
  db._notifications.youtubeVideoIds = [];
}

if (!db._notifications.tiktokVideoIds ||
    typeof db._notifications.tiktokVideoIds !== 'object') {
  db._notifications.tiktokVideoIds = {};
}

function saveDB() {
  try {
    const temp = `${DB_PATH}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(temp, DB_PATH);
  } catch (err) {
    console.error('Veri dosyası kaydedilemedi:', err.message);
  }
}

function getData(guildId, userId) {
  const key = `${guildId}_${userId}`;

  if (!db[key]) {
    db[key] = {
      ticks: 0,
      rank: RANKS[0].name,
      history: [],
      manualRank: false
    };
  }

  return db[key];
}

function eligibleRank(ticks) {
  const matched = RANKS.filter(
    r => r.threshold !== null && ticks >= r.threshold
  );

  return matched.length ? matched.at(-1).name : RANKS[0].name;
}

function isStaff(member) {
  return Boolean(
    member &&
    (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(role => STAFF_ROLE_IDS.includes(role.id))
    )
  );
}

function record(data, action, reason, actor) {
  data.history.unshift({
    action,
    reason,
    actor: `<@${actor}>`,
    date: new Date().toISOString().slice(0, 10)
  });

  if (data.history.length > 100) {
    data.history.length = 100;
  }
}

// OTOMATİK ROL SİSTEMİ
async function syncRank(member, rankName) {
  const guild = member.guild;

  const role = guild.roles.cache.find(r => r.name === rankName);

  if (!role) {
    return `Sunucuda **${rankName}** rolü bulunamadı.`;
  }

  try {
    const toRemove = member.roles.cache.filter(
      r => RANK_NAMES.includes(r.name) && r.id !== role.id
    );

    if (toRemove.size) {
      await member.roles.remove(
        [...toRemove.values()],
        'Baratheon rütbe güncellemesi'
      );
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Baratheon rütbe güncellemesi');
    }

    return null;
  } catch (err) {
    console.error('Rol güncelleme hatası:', err);

    return 'Botun Rolleri Yönet izni veya yeterli rol sırası yok.';
  }
}

// BOT AÇILDIĞINDA TÜM KAYITLI ÜYELERİN RÜTBELERİNİ DÜZELT
async function syncSavedMemberRanks(guild) {
  const prefix = `${guild.id}_`;

  const savedEntries = Object.entries(db).filter(
    ([key, value]) =>
      key.startsWith(prefix) &&
      value &&
      typeof value.ticks === 'number'
  );

  if (!savedEntries.length) return;

  await guild.members.fetch().catch(err => {
    console.error('Üyeler alınamadı:', err.message);
  });

  for (const [key, data] of savedEntries) {
    const userId = key.slice(prefix.length);
    const member = guild.members.cache.get(userId);

    if (!member) continue;

    if (!data.manualRank) {
      data.rank = eligibleRank(data.ticks);
    }

    const roleError = await syncRank(member, data.rank);

    if (roleError) {
      console.warn(
        `[Rütbe senkronizasyonu] ${member.user.tag}: ${roleError}`
      );
    }
  }

  saveDB();
}

async function sendLog(guild, title, fields) {
  if (!LOG_CHANNEL_ID) return;

  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xF1C40F)
      .addFields(
        fields.map(f => ({
          name: f.name,
          value: String(f.value),
          inline: Boolean(f.inline)
        }))
      )
      .setTimestamp();

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (err) {
    console.error('Log gönderilemedi:', err.message);
  }
}

async function fetchTextWithTimeout(url, headers = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        ...headers
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractYouTubeVideoId(urlStr = '') {
  try {
    const u = new URL(urlStr);

    if (u.hostname.includes('youtu.be')) {
      return u.pathname.replace(/^\/+/, '').split('/')[0] || '';
    }

    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) {
        return u.searchParams.get('v');
      }

      const shortsMatch = u.pathname.match(
        /^\/shorts\/([a-zA-Z0-9_-]+)/
      );

      if (shortsMatch?.[1]) return shortsMatch[1];
    }
  } catch {}

  return '';
}

function isValidHttpUrl(urlStr = '') {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

async function resolveYouTubeChannelId(handle) {
  if (db._notifications.youtubeChannelId) {
    return db._notifications.youtubeChannelId;
  }

  const html = await fetchTextWithTimeout(
    `https://www.youtube.com/@${encodeURIComponent(handle)}`
  );

  const match =
    html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{20,})"/) ||
    html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,})/) ||
    html.match(/channel_id=(UC[a-zA-Z0-9_-]{20,})/);

  if (!match?.[1]) {
    throw new Error(`@${handle} kanal ID'si bulunamadı.`);
  }

  db._notifications.youtubeChannelId = match[1];
  saveDB();

  return match[1];
}

function parseYouTubeFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];

    const videoId = block.match(
      /<yt:videoId>([^<]+)<\/yt:videoId>/
    )?.[1]?.trim();

    const titleRaw = block.match(
      /<title>([\s\S]*?)<\/title>/
    )?.[1]?.trim() || 'Yeni YouTube Videosu';

    const authorRaw = block.match(
      /<name>([\s\S]*?)<\/name>/
    )?.[1]?.trim() || `@${YOUTUBE_HANDLE}`;

    const published = block.match(
      /<published>([^<]+)<\/published>/
    )?.[1]?.trim() || '';

    if (videoId) {
      entries.push({
        id: videoId,
        title: decodeXmlEntities(titleRaw),
        author: decodeXmlEntities(authorRaw),
        published,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      });
    }
  }

  return entries;
}

function parseTikTokVideos(html, handle) {
  const foundIds = [];
  const seen = new Set();

  const patterns = [
    new RegExp(`https?://www\\.tiktok\\.com/@${handle}/video/(\\d+)`, 'gi'),
    new RegExp(`/@${handle}/video/(\\d+)`, 'gi'),
    /"aweme_id"\s*:\s*"(\d{10,})"/g,
    /"itemList"\s*:\s*\["(\d{10,})"/g
  ];

  for (const regex of patterns) {
    let m;

    while ((m = regex.exec(html)) !== null) {
      const id = m[1];

      if (id && !seen.has(id)) {
        seen.add(id);
        foundIds.push(id);
      }
    }
  }

  return foundIds.slice(0, 5).map(id => ({
    id,
    handle,
    url: `https://www.tiktok.com/@${handle}/video/${id}`
  }));
}

async function getNotificationChannel() {
  if (!NOTIFICATION_CHANNEL_ID) return null;

  const channel = await client.channels.fetch(
    NOTIFICATION_CHANNEL_ID
  ).catch(() => null);

  return channel?.isTextBased() ? channel : null;
}

async function sendVideoNotification(channel, embed) {
  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] }
  });
}

let isCheckingFeeds = false;

async function checkSocialNotifications() {
  if (isCheckingFeeds) return;

  isCheckingFeeds = true;

  try {
    const channel = await getNotificationChannel();

    if (!channel) {
      console.warn('Bildirim kanalı bulunamadı.');
      return;
    }

    const firstRun = !db._notifications.initialized;
    let stateChanged = false;

    let ytVideos = [];

    try {
      const channelId = await resolveYouTubeChannelId(YOUTUBE_HANDLE);

      const xml = await fetchTextWithTimeout(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`
      );

      ytVideos = parseYouTubeFeed(xml);
    } catch (err) {
      console.error('YouTube kontrol hatası:', err.message);
    }

    const knownYtIds = new Set(db._notifications.youtubeVideoIds);

    const newYtVideos = ytVideos.filter(
      v => !knownYtIds.has(v.id)
    );

    if (ytVideos.length) {
      for (const v of ytVideos) {
        knownYtIds.add(v.id);
      }

      db._notifications.youtubeVideoIds =
        [...knownYtIds].slice(-100);

      stateChanged = true;
    }

    if (!firstRun && newYtVideos.length) {
      for (const video of newYtVideos.reverse()) {
        const embed = new EmbedBuilder()
          .setTitle(video.title)
          .setURL(video.url)
          .setAuthor({
            name: `${video.author} (@${YOUTUBE_HANDLE}) yeni video paylaştı!`
          })
          .setColor(0xFF0000)
          .setImage(video.thumbnail)
          .setTimestamp();

        await sendVideoNotification(channel, embed);
      }
    }

    for (const handle of TIKTOK_HANDLES) {
      let ttVideos = [];

      try {
        const html = await fetchTextWithTimeout(
          `https://www.tiktok.com/@${handle}`
        );

        ttVideos = parseTikTokVideos(html, handle);
      } catch (err) {
        console.error(`TikTok @${handle} kontrol hatası:`, err.message);
        continue;
      }

      if (!Array.isArray(db._notifications.tiktokVideoIds[handle])) {
        db._notifications.tiktokVideoIds[handle] = [];
      }

      const knownTtIds = new Set(
        db._notifications.tiktokVideoIds[handle]
      );

      const newTtVideos = ttVideos.filter(
        v => !knownTtIds.has(v.id)
      );

      if (ttVideos.length) {
        for (const v of ttVideos) {
          knownTtIds.add(v.id);
        }

        db._notifications.tiktokVideoIds[handle] =
          [...knownTtIds].slice(-50);

        stateChanged = true;
      }

      if (!firstRun && newTtVideos.length) {
        for (const video of newTtVideos.reverse()) {
          const embed = new EmbedBuilder()
            .setTitle(`@${handle} yeni TikTok videosu paylaştı!`)
            .setURL(video.url)
            .setDescription(`[Videoyu İzle](${video.url})`)
            .setColor(0x111111)
            .setTimestamp();

          await sendVideoNotification(channel, embed);
        }
      }
    }

    if (firstRun) {
      db._notifications.initialized = true;
      stateChanged = true;
    }

    if (stateChanged) saveDB();

  } finally {
    isCheckingFeeds = false;
  }
}

// KOMUT SEÇENEKLERİ
const userOpt = (opt, description) =>
  opt.setName('uye').setDescription(description).setRequired(true);

const amountOpt = opt =>
  opt.setName('miktar')
    .setDescription('Tik miktarı')
    .setMinValue(1)
    .setMaxValue(50)
    .setRequired(true);

const reasonOpt = opt =>
  opt.setName('sebep')
    .setDescription('İşlem sebebi')
    .setRequired(true);

// SLASH KOMUTLARI
const commands = [
  new SlashCommandBuilder()
    .setName('tik-ver')
    .setDescription('Üyeye tik ekler.')
    .addUserOption(o => userOpt(o, 'Tik verilecek üye'))
    .addIntegerOption(amountOpt)
    .addStringOption(reasonOpt),

  new SlashCommandBuilder()
    .setName('tik-sil')
    .setDescription('Üyeden tik siler.')
    .addUserOption(o => userOpt(o, 'Tik silinecek üye'))
    .addIntegerOption(amountOpt)
    .addStringOption(reasonOpt),

  new SlashCommandBuilder()
    .setName('tiklerim')
    .setDescription('Tik ve rütbe durumunu gösterir.'),

  new SlashCommandBuilder()
    .setName('tik-bilgi')
    .setDescription('Üyenin tik durumunu gösterir.')
    .addUserOption(o => userOpt(o, 'Bilgisi görüntülenecek üye')),

  new SlashCommandBuilder()
    .setName('tikler')
    .setDescription('Tik leaderboard sıralamasını gösterir.'),

  new SlashCommandBuilder()
    .setName('liderlik')
    .setDescription('Tik leaderboard sıralamasını gösterir.'),

  new SlashCommandBuilder()
    .setName('terfi')
    .setDescription('Yönetim kararıyla rütbe atar.')
    .addUserOption(o => userOpt(o, 'Rütbe verilecek üye'))
    .addStringOption(o =>
      o.setName('rutbe')
        .setDescription('Atanacak rütbe')
        .setRequired(true)
        .addChoices(
          ...RANK_NAMES.map(name => ({
            name,
            value: name
          }))
        )
    )
    .addStringOption(reasonOpt),

  new SlashCommandBuilder()
    .setName('tik-gecmisi')
    .setDescription('Üyenin tik işlem geçmişini gösterir.')
    .addUserOption(o => userOpt(o, 'Geçmişi görüntülenecek üye')),

  new SlashCommandBuilder()
    .setName('bildirim-gonder')
    .setDescription('Manuel YouTube veya TikTok bildirimi gönderir.')
    .addStringOption(o =>
      o.setName('platform')
        .setDescription('Platform')
        .setRequired(true)
        .addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'TikTok', value: 'tiktok' }
        )
    )
    .addStringOption(o =>
      o.setName('baglanti')
        .setDescription('Video baglantisi')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('baslik')
        .setDescription('Baslik')
        .setRequired(false)
    )
    .addStringOption(o =>
      o.setName('kanal')
        .setDescription('Kanal veya profil adi')
        .setRequired(false)
    )
].map(c => c.toJSON());

// DISCORD CLIENT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let notifierStarted = false;

// BOT HAZIR OLDUĞUNDA
async function onBotReady(readyClient) {
  console.log(`${readyClient.user.tag} aktif!`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(
          readyClient.user.id,
          GUILD_ID
        ),
        { body: commands }
      );
    } else {
      await rest.put(
        Routes.applicationCommands(readyClient.user.id),
        { body: commands }
      );
    }

    console.log(`Slash komutları yüklendi (${commands.length} adet).`);

  } catch (err) {
    console.error('Slash komut hatası:', err);
  }

  // KAYITLI ÜYELERİN RÜTBELERİNİ SENKRONİZE ET
  if (GUILD_ID) {
    const guild = readyClient.guilds.cache.get(GUILD_ID);

    if (guild) {
      await syncSavedMemberRanks(guild);
    }
  } else {
    for (const guild of readyClient.guilds.cache.values()) {
      await syncSavedMemberRanks(guild);
    }
  }

  if (!notifierStarted) {
    notifierStarted = true;

    await checkSocialNotifications();

    setInterval(
      checkSocialNotifications,
      POLL_INTERVAL_MS
    );

    console.log('Sosyal medya bildirim sistemi başlatıldı.');
  }
}

client.once('ready', onBotReady);

// BRTH KOMUTU
client.on('messageCreate', async message => {
  if (
    !message.guild ||
    message.author.bot ||
    message.content.trim().toLowerCase() !== '!brth'
  ) return;

  try {
    const members = await message.guild.members.fetch();

    const count = members.filter(
      m =>
        !m.user.bot &&
        m.user.primaryGuild?.identityEnabled === true &&
        m.user.primaryGuild?.tag?.toUpperCase() === 'BRTH'
    ).size;

    await message.reply(
      `Şu anda **BRTH** sunucu etiketini aktif kullanan **${count}** üye var.`
    );

  } catch (err) {
    console.error('BRTH sayım hatası:', err);

    await message.reply(
      'Üyeler veya sunucu etiketleri okunamadı.'
    );
  }
});

// YENİ KATILAN ÜYENİN ESKİ TİKLERİNİ VE RÜTBESİNİ KONTROL ET
client.on('guildMemberAdd', async member => {
  const key = `${member.guild.id}_${member.id}`;
  const data = db[key];

  if (!data || typeof data.ticks !== 'number') return;

  if (!data.manualRank) {
    data.rank = eligibleRank(data.ticks);
  }

  const roleError = await syncRank(member, data.rank);

  if (roleError) {
    console.warn(
      `[Yeni üye rütbe senkronizasyonu] ${member.user.tag}: ${roleError}`
    );
  } else {
    saveDB();
  }
});

// TÜM SLASH KOMUTLAR
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  try {
    const command = interaction.commandName;

    if (
      [
        'tik-ver',
        'tik-sil',
        'terfi',
        'tik-gecmisi',
        'bildirim-gonder'
      ].includes(command) &&
      !isStaff(interaction.member)
    ) {
      return await interaction.reply({
        content: 'Bu komut yalnızca yönetim içindir.',
        flags: MessageFlags.Ephemeral
      });
    }

    // MANUEL BİLDİRİM
    if (command === 'bildirim-gonder') {
      const platform = interaction.options.getString('platform');
      const url = interaction.options.getString('baglanti').trim();
      const customTitle = interaction.options.getString('baslik')?.trim() || '';
      const customChannel = interaction.options.getString('kanal')?.trim() || '';

      if (!isValidHttpUrl(url)) {
        return await interaction.reply({
          content: 'Geçerli bir bağlantı girin.',
          flags: MessageFlags.Ephemeral
        });
      }

      const channel = await getNotificationChannel();

      if (!channel) {
        return await interaction.reply({
          content: 'Bildirim kanalı bulunamadı.',
          flags: MessageFlags.Ephemeral
        });
      }

      let embed;

      if (platform === 'youtube') {
        const channelLabel = customChannel || `@${YOUTUBE_HANDLE}`;
        const videoId = extractYouTubeVideoId(url);

        embed = new EmbedBuilder()
          .setTitle(customTitle || 'Yeni YouTube Videosu')
          .setURL(url)
          .setAuthor({
            name: `${channelLabel} yeni video paylaştı!`
          })
          .setColor(0xFF0000)
          .setTimestamp();

        if (videoId) {
          embed.setImage(
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          );
        }

      } else {
        const handleClean = (customChannel || 'TikTok').replace(/^@+/, '');

        embed = new EmbedBuilder()
          .setTitle(
            customTitle || `@${handleClean} yeni TikTok videosu paylaştı!`
          )
          .setURL(url)
          .setDescription(`[Videoyu İzle](${url})`)
          .setColor(0x111111)
          .setTimestamp();
      }

      await sendVideoNotification(channel, embed);

      return await interaction.reply({
        content: `✅ Bildirim <#${channel.id}> kanalına gönderildi.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // TİK VER / TİK SİL / TERFİ
    if (
      command === 'tik-ver' ||
      command === 'tik-sil' ||
      command === 'terfi'
    ) {
      await interaction.deferReply();

      const user = interaction.options.getUser('uye');

      const member = await interaction.guild.members.fetch(user.id)
        .catch(() => null);

      if (!member) {
        return await interaction.editReply(
          'Üye sunucuda bulunamadı.'
        );
      }

      const data = getData(interaction.guild.id, user.id);
      const reason = interaction.options.getString('sebep');
      const oldRank = data.rank;

      let action;

      if (command === 'terfi') {
        data.rank = interaction.options.getString('rutbe');
        data.manualRank = true;

        action = `Rütbe değişti: ${oldRank} → ${data.rank}`;

      } else {
        const amount = interaction.options.getInteger('miktar');
        const before = data.ticks;

        data.ticks = command === 'tik-ver'
          ? before + amount
          : Math.max(0, before - amount);

        const actual = Math.abs(data.ticks - before);

        action = command === 'tik-ver'
          ? `Tik eklendi (+${actual})`
          : `Tik silindi (-${actual})`;

        if (!data.manualRank) {
          data.rank = eligibleRank(data.ticks);
        }
      }

      record(data, action, reason, interaction.user.id);
      saveDB();

      const roleError = await syncRank(member, data.rank);

      await sendLog(
        interaction.guild,
        command === 'terfi'
          ? '👑 BARATHEON RÜTBE DEĞİŞİKLİĞİ'
          : '👑 BARATHEON TİK KAYDI',
        [
          {
            name: 'Üye',
            value: `<@${user.id}>`,
            inline: true
          },
          {
            name: 'İşlem',
            value: action,
            inline: true
          },
          {
            name: 'Toplam Tik',
            value: data.ticks,
            inline: true
          },
          {
            name: 'Rütbe',
            value: data.rank,
            inline: true
          },
          {
            name: 'Sebep',
            value: reason
          },
          {
            name: 'İşlemi Yapan',
            value: `<@${interaction.user.id}>`
          }
        ]
      );

      return await interaction.editReply(
        `✅ <@${user.id}> — ${action}. Toplam: **${data.ticks} tik** | Rütbe: **${data.rank}**${roleError ? `\n⚠️ ${roleError}` : ''}`
      );
    }

    // TİK BİLGİSİ
    if (
      command === 'tiklerim' ||
      command === 'tik-bilgi'
    ) {
      const user = command === 'tiklerim'
        ? interaction.user
        : interaction.options.getUser('uye');

      const data = getData(interaction.guild.id, user.id);

      const next = data.manualRank
        ? null
        : RANKS.find(
            r => r.threshold !== null && r.threshold > data.ticks
          );

      const embed = new EmbedBuilder()
        .setTitle(`👑 ${user.username} — Tik Bilgisi`)
        .setColor(0xF1C40F)
        .addFields(
          {
            name: 'Üye',
            value: `<@${user.id}>`,
            inline: true
          },
          {
            name: 'Toplam Tik',
            value: String(data.ticks),
            inline: true
          },
          {
            name: 'Rütbe',
            value: data.rank,
            inline: true
          },
          {
            name: 'Sonraki Rütbe',
            value: next
              ? `${next.name} — ${next.threshold - data.ticks} tik kaldı`
              : 'Yönetim değerlendirmesi'
          }
        );

      if (command === 'tik-bilgi') {
        embed.addFields({
          name: 'Son İşlemler',
          value: data.history
            .slice(0, 5)
            .map(h => `${h.date} — ${h.action}`)
            .join('\n') || 'Kayıt yok.'
        });
      }

      return await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    // TİKLER LEADERBOARD
    if (
      command === 'liderlik' ||
      command === 'tikler'
    ) {
      const prefix = `${interaction.guild.id}_`;

      const entries = Object.entries(db)
        .filter(
          ([key, data]) =>
            !key.startsWith('_') &&
            key.startsWith(prefix) &&
            typeof data.ticks === 'number' &&
            data.ticks > 0
        )
        .map(([key, data]) => ({
          userId: key.slice(prefix.length),
          ...data
        }))
        .sort((a, b) => b.ticks - a.ticks)
        .slice(0, 10);

      if (!entries.length) {
        return await interaction.reply(
          'Henüz tik kaydı yok.'
        );
      }

      const lines = entries.map(
        (r, i) =>
          `**${i + 1}.** <@${r.userId}> — **${r.ticks} tik** · ${r.rank}`
      );

      const embed = new EmbedBuilder()
        .setTitle('🏆 Baratheon Tik Sıralaması')
        .setDescription(lines.join('\n'))
        .setColor(0xF1C40F)
        .setFooter({
          text: 'Baratheon Tik Leaderboard'
        })
        .setTimestamp();

      return await interaction.reply({
        embeds: [embed]
      });
    }

    // TİK GEÇMİŞİ
    if (command === 'tik-gecmisi') {
      const user = interaction.options.getUser('uye');
      const data = getData(interaction.guild.id, user.id);

      if (!data.history.length) {
        return await interaction.reply({
          content: 'Bu üyenin işlem geçmişi bulunmuyor.',
          flags: MessageFlags.Ephemeral
        });
      }

      const lines = data.history
        .slice(0, 15)
        .map(
          h => `**${h.date}** ${h.action} — ${h.reason} · ${h.actor}`
        );

      const description = lines.join('\n').slice(0, 4000);

      return await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📜 ${user.username} — Tik Geçmişi`)
            .setDescription(description)
            .setColor(0x5865F2)
        ],
        flags: MessageFlags.Ephemeral
      });
    }

  } catch (err) {
    console.error('Komut hatası:', err);

    const payload = {
      content: 'İşlem sırasında hata oluştu. Konsolu kontrol et.',
      flags: MessageFlags.Ephemeral
    };

    if (interaction.deferred) {
      await interaction.editReply({
        content: payload.content
      }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// EXPRESS WEB SUNUCUSU
const app = express();

app.get('/', (_req, res) => {
  res.send('Baratheon Bot & Tik Sistemi Aktif!');
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    bot: client.user?.tag || 'starting'
  });
});

app.listen(
  process.env.PORT || 3000,
  () => console.log('Web sunucusu aktif.')
);

// BOTU BAŞLAT
client.login(TOKEN).catch(err => {
  console.error('Discord giriş hatası:', err);
  process.exit(1);
});
