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
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 dakikada bir kontrol

if (!TOKEN) {
  console.error('TOKEN ortam değişkeni eksik.');
  process.exit(1);
}

process.on('unhandledRejection', (err) => {
  console.error('Yakalanmamış Promise Hatası:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Yakalanmamış İstisna:', err);
});

const RANKS = [
  { name: 'Member Of Baratheon', threshold: 0 },
  { name: 'Muhafız', threshold: 1 },
  { name: 'Man-at-Arms', threshold: 3 },
  { name: 'Squire', threshold: 5 },
  { name: 'Ser', threshold: 7 },
  { name: 'Lord', threshold: 10 },
  { name: 'Heir', threshold: 12 },
  { name: 'Guardian', threshold: 15 },
  { name: 'KingsGuard', threshold: 18 },
  { name: 'Dük', threshold: 20 },
  { name: 'Baron', threshold: 22 },
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
  console.error(`Veri dosyası okunamadı, boş veri ile devam ediliyor: ${err.message}`);
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
if (!db._notifications.tiktokVideoIds || typeof db._notifications.tiktokVideoIds !== 'object') {
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
    db[key] = { ticks: 0, rank: RANKS[0].name, history: [], manualRank: false };
  }
  return db[key];
}

function eligibleRank(ticks) {
  const matched = RANKS.filter(r => r.threshold !== null && ticks >= r.threshold);
  return matched.length ? matched.at(-1).name : RANKS[0].name;
}

function isStaff(member) {
  return Boolean(
    member &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(role => STAFF_ROLE_IDS.includes(role.id)))
  );
}

function record(data, action, reason, actor) {
  data.history.unshift({
    action,
    reason,
    actor: `<@${actor}>`,
    date: new Date().toISOString().slice(0, 10)
  });
  if (data.history.length > 100) data.history.length = 100;
}

async function syncRank(member, rankName) {
  const guild = member.guild;
  const role = guild.roles.cache.find(r => r.name === rankName);
  if (!role) return `Sunucuda **${rankName}** rolü bulunamadı.`;
  try {
    const toRemove = member.roles.cache.filter(r => RANK_NAMES.includes(r.name) && r.id !== role.id);
    if (toRemove.size) await member.roles.remove([...toRemove.values()], 'Baratheon rütbe güncellemesi');
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Baratheon rütbe güncellemesi');
    return null;
  } catch (err) {
    console.error('Rol güncelleme hatası:', err);
    return 'Botun Rolleri Yönet izni veya yeterli rol sırası yok.';
  }
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
    await channel.send({ embeds: [embed] });
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
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
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

async function resolveYouTubeChannelId(handle) {
  if (db._notifications.youtubeChannelId) return db._notifications.youtubeChannelId;
  const html = await fetchTextWithTimeout(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
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
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
    const titleRaw = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || 'Yeni YouTube Videosu';
    const authorRaw = block.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() || `@${YOUTUBE_HANDLE}`;
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1]?.trim() || '';
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
  const channel = await client.channels.fetch(NOTIFICATION_CHANNEL_ID).catch(() => null);
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
      console.warn(`Bildirim kanalı bulunamadı veya metin kanalı değil: ${NOTIFICATION_CHANNEL_ID}`);
      return;
    }

    const firstRun = !db._notifications.initialized;
    let stateChanged = false;

    // 1. YouTube kontrolü
    let ytVideos = [];
    try {
      const channelId = await resolveYouTubeChannelId(YOUTUBE_HANDLE);
      const xml = await fetchTextWithTimeout(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`
      );
      ytVideos = parseYouTubeFeed(xml);
    } catch (err) {
      console.error(`YouTube (@${YOUTUBE_HANDLE}) kontrol hatası:`, err.message);
    }

    const knownYtIds = new Set(db._notifications.youtubeVideoIds);
    const newYtVideos = ytVideos.filter(v => !knownYtIds.has(v.id));

    if (ytVideos.length) {
      for (const v of ytVideos) {
        knownYtIds.add(v.id);
      }
      db._notifications.youtubeVideoIds = [...knownYtIds].slice(-100);
      stateChanged = true;
    }

    if (!firstRun && newYtVideos.length) {
      for (const video of newYtVideos.reverse()) {
        const embed = new EmbedBuilder()
          .setTitle(video.title)
          .setURL(video.url)
          .setAuthor({ name: `${video.author} (@${YOUTUBE_HANDLE}) yeni video paylaştı!` })
          .setColor(0xFF0000)
          .setImage(video.thumbnail)
          .setTimestamp();
        await sendVideoNotification(channel, embed);
      }
    }

    // 2. TikTok kontrolü
    for (const handle of TIKTOK_HANDLES) {
      let ttVideos = [];
      try {
        const html = await fetchTextWithTimeout(`https://www.tiktok.com/@${handle}`);
        ttVideos = parseTikTokVideos(html, handle);
      } catch (err) {
        console.error(`TikTok (@${handle}) kontrol hatası:`, err.message);
        continue;
      }

      if (!Array.isArray(db._notifications.tiktokVideoIds[handle])) {
        db._notifications.tiktokVideoIds[handle] = [];
      }

      const knownTtIds = new Set(db._notifications.tiktokVideoIds[handle]);
      const newTtVideos = ttVideos.filter(v => !knownTtIds.has(v.id));

      if (ttVideos.length) {
        for (const v of ttVideos) {
          knownTtIds.add(v.id);
        }
        db._notifications.tiktokVideoIds[handle] = [...knownTtIds].slice(-50);
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
      console.log('YouTube ve TikTok bildirim başlangıç durumları kaydedildi.');
    }

    if (stateChanged) {
      saveDB();
    }
  } finally {
    isCheckingFeeds = false;
  }
}

const userOpt = (opt, description) => opt.setName('uye').setDescription(description).setRequired(true);
const amountOpt = opt => opt.setName('miktar').setDescription('Tik miktarı').setMinValue(1).setMaxValue(50).setRequired(true);
const reasonOpt = opt => opt.setName('sebep').setDescription('İşlem sebebi').setRequired(true);

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
    .setName('liderlik')
    .setDescription('En yüksek tikli üyeleri listeler.'),
  new SlashCommandBuilder()
    .setName('terfi')
    .setDescription('Yönetim kararıyla rütbe atar.')
    .addUserOption(o => userOpt(o, 'Rütbe verilecek üye'))
    .addStringOption(o =>
      o
        .setName('rutbe')
        .setDescription('Atanacak rütbe')
        .setRequired(true)
        .addChoices(...RANK_NAMES.map(name => ({ name, value: name })))
    )
    .addStringOption(reasonOpt),
  new SlashCommandBuilder()
    .setName('tik-gecmisi')
    .setDescription('Üyenin tik işlem geçmişini gösterir.')
    .addUserOption(o => userOpt(o, 'Geçmişi görüntülenecek üye'))
].map(c => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let notifierStarted = false;

async function onBotReady(readyClient) {
  console.log(`${readyClient.user.tag} aktif!`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    }
    console.log('Slash komutları yüklendi.');
  } catch (err) {
    console.error('Slash komut hatası:', err);
  }

  if (!notifierStarted) {
    notifierStarted = true;
    await checkSocialNotifications();
    setInterval(checkSocialNotifications, POLL_INTERVAL_MS);
    console.log(`Sosyal medya bildirim döngüsü başlatıldı (${POLL_INTERVAL_MS / 1000} sn).`);
  }
}

client.once('clientReady', onBotReady);
client.once('ready', onBotReady);

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot || message.content.trim().toLowerCase() !== '!brth') return;
  try {
    const members = await message.guild.members.fetch();
    const count = members.filter(
      m =>
        !m.user.bot &&
        m.user.primaryGuild?.identityEnabled === true &&
        m.user.primaryGuild?.tag?.toUpperCase() === 'BRTH'
    ).size;
    await message.reply(`Şu anda **BRTH** sunucu etiketini aktif kullanan **${count}** üye var.`);
  } catch (err) {
    console.error('BRTH sayım hatası:', err);
    await message.reply('Üyeler veya sunucu etiketleri okunamadı. Guild Members Intent ve discord.js sürümünü kontrol et.');
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  try {
    const command = interaction.commandName;
    if (['tik-ver', 'tik-sil', 'terfi', 'tik-gecmisi'].includes(command) && !isStaff(interaction.member)) {
      return await interaction.reply({ content: 'Bu komut yalnızca yönetim içindir.', flags: MessageFlags.Ephemeral });
    }

    if (command === 'tik-ver' || command === 'tik-sil' || command === 'terfi') {
      await interaction.deferReply();
      const user = interaction.options.getUser('uye');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return await interaction.editReply('Üye sunucuda bulunamadı.');

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
        data.ticks = command === 'tik-ver' ? before + amount : Math.max(0, before - amount);
        const actual = Math.abs(data.ticks - before);
        action = command === 'tik-ver' ? `Tik eklendi (+${actual})` : `Tik silindi (-${actual})`;
        if (!data.manualRank) data.rank = eligibleRank(data.ticks);
      }

      record(data, action, reason, interaction.user.id);
      saveDB();
      const roleError = await syncRank(member, data.rank);

      await sendLog(
        interaction.guild,
        command === 'terfi' ? '👑 BARATHEON RÜTBE DEĞİŞİKLİĞİ' : '👑 BARATHEON TİK KAYDI',
        [
          { name: 'Üye', value: `<@${user.id}>`, inline: true },
          { name: 'İşlem', value: action, inline: true },
          { name: 'Toplam Tik', value: data.ticks, inline: true },
          { name: 'Rütbe', value: data.rank, inline: true },
          { name: 'Sebep', value: reason },
          { name: 'İşlemi Yapan', value: `<@${interaction.user.id}>` }
        ]
      );

      return await interaction.editReply(
        `✅ <@${user.id}> — ${action}. Toplam: **${data.ticks} tik** | Rütbe: **${data.rank}**${roleError ? `\n⚠️ ${roleError}` : ''}`
      );
    }

    if (command === 'tiklerim' || command === 'tik-bilgi') {
      const user = command === 'tiklerim' ? interaction.user : interaction.options.getUser('uye');
      const data = getData(interaction.guild.id, user.id);
      const next = data.manualRank ? null : RANKS.find(r => r.threshold !== null && r.threshold > data.ticks);
      const embed = new EmbedBuilder()
        .setTitle(`👑 ${user.username} — Tik Bilgisi`)
        .setColor(0xF1C40F)
        .addFields(
          { name: 'Üye', value: `<@${user.id}>`, inline: true },
          { name: 'Toplam Tik', value: String(data.ticks), inline: true },
          { name: 'Rütbe', value: data.rank, inline: true },
          {
            name: 'Sonraki Rütbe',
            value: next ? `${next.name} — ${next.threshold - data.ticks} tik kaldı` : 'Yönetim değerlendirmesi'
          }
        );

      if (command === 'tik-bilgi') {
        embed.addFields({
          name: 'Son İşlemler',
          value: data.history.slice(0, 5).map(h => `${h.date} — ${h.action}`).join('\n') || 'Kayıt yok.'
        });
      }

      return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (command === 'liderlik') {
      const prefix = `${interaction.guild.id}_`;
      const entries = Object.entries(db)
        .filter(([key, data]) => !key.startsWith('_') && key.startsWith(prefix) && data.ticks > 0)
        .map(([key, data]) => ({ userId: key.slice(prefix.length), ...data }))
        .sort((a, b) => b.ticks - a.ticks)
        .slice(0, 10);

      if (!entries.length) return await interaction.reply('Henüz tik kaydı yok.');
      const lines = entries.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.ticks} tik** · ${r.rank}`);
      return await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🏆 Baratheon Tik Sıralaması').setDescription(lines.join('\n')).setColor(0xF1C40F)]
      });
    }

    if (command === 'tik-gecmisi') {
      const user = interaction.options.getUser('uye');
      const data = getData(interaction.guild.id, user.id);
      if (!data.history.length) {
        return await interaction.reply({ content: 'Bu üyenin işlem geçmişi bulunmuyor.', flags: MessageFlags.Ephemeral });
      }
      const lines = data.history.slice(0, 15).map(h => `**${h.date}** ${h.action} — ${h.reason} · ${h.actor}`);
      const description = lines.join('\n').slice(0, 4000);
      return await interaction.reply({
        embeds: [new EmbedBuilder().setTitle(`📜 ${user.username} — Tik Geçmişi`).setDescription(description).setColor(0x5865F2)],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (err) {
    console.error('Komut hatası:', err);
    const payload = { content: 'İşlem sırasında hata oluştu. Konsolu kontrol et.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred) await interaction.editReply({ content: payload.content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

const app = express();
app.get('/', (_req, res) => res.send('Baratheon Bot & Tik Sistemi Aktif!'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, bot: client.user?.tag || 'starting' }));
app.listen(process.env.PORT || 3000, () => console.log('Web sunucusu aktif.'));

client.login(TOKEN).catch((err) => {
  console.error('Discord giriş hatası:', err);
  process.exit(1);
});
