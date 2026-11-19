const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits
} = require('discord.js');
const express = require('express');

// --- 7/24 UYKU ENGELLEYİCİ WEB SUNUCUSU ---
const app = express();
app.get('/', (req, res) => res.send('Baratheon Bot & Tik Sistemi Aktif!'));
app.listen(process.env.PORT || 3000);

// --- AYARLAR (Render Environment Variables'dan okunur) ---
const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// --- RÜTBE EŞİKLERİ ---
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

// Hafıza Veritabanı (Log kanalından otomatik senkronize edilir)
const db = new Map(); // key: `${guildId}_${userId}` -> { ticks, rank, history: [] }

function getMemberData(guildId, userId) {
  const key = `${guildId}_${userId}`;
  if (!db.has(key)) {
    db.set(key, { ticks: 0, rank: RANK_NAMES[0], history: [] });
  }
  return db.get(key);
}

function nextEligibleRank(ticks) {
  const eligible = RANKS.filter(r => r.threshold !== null && ticks >= r.threshold);
  return eligible.length > 0 ? eligible[eligible.length - 1].name : RANK_NAMES[0];
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(role => STAFF_ROLE_IDS.includes(role.id));
}

async function syncDiscordRank(member, rankName) {
  const guild = member.guild;
  const target = guild.roles.cache.find(r => r.name === rankName);
  if (!target) {
    return { ok: false, err: `Sunucuda **${rankName}** adlı rol bulunamadı. Rolü oluşturup tekrar dene.` };
  }

  const managedRoles = guild.roles.cache.filter(r => RANK_NAMES.includes(r.name) && r.id !== target.id);
  try {
    const toRemove = member.roles.cache.filter(r => managedRoles.has(r.id));
    if (toRemove.size > 0) {
      await member.roles.remove(toRemove, 'Baratheon rütbe güncellemesi');
    }
    if (!member.roles.cache.has(target.id)) {
      await member.roles.add(target, 'Baratheon rütbe güncellemesi');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: 'Botun rol yönetme yetkisi yok veya bot rolü atanacak rütbenin altında.' };
  }
}

// Log kanalındaki geçmiş mesajlardan verileri geri yükler (Render yeniden başlasa bile veri kaybolmaz)
async function restoreFromLogs(client) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    let lastId;
    const allMessages = [];
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;
      allMessages.push(...messages.values());
      lastId = messages.last().id;
      if (allMessages.length >= 1000) break;
    }

    // Eskiden yeniye sırala ve hafızayı inşa et
    allMessages.reverse();
    for (const msg of allMessages) {
      if (msg.author.id !== client.user.id || msg.embeds.length === 0) continue;
      const emb = msg.embeds[0];
      if (!emb.title || !emb.title.includes('BARATHEON')) continue;

      const uyeField = emb.fields.find(f => f.name === 'Üye');
      if (!uyeField) continue;
      const userIdMatch = uyeField.value.match(/\d+/);
      if (!userIdMatch) continue;
      const userId = userIdMatch[0];

      const data = getMemberData(channel.guild.id, userId);
      const toplamField = emb.fields.find(f => f.name === 'Toplam Tik');
      const rutbeField = emb.fields.find(f => f.name === 'Rütbe' || f.name === 'Yeni Rütbe');
      const islemField = emb.fields.find(f => f.name === 'İşlem');
      const sebepField = emb.fields.find(f => f.name === 'Sebep');
      const yapanField = emb.fields.find(f => f.name === 'İşlemi Yapan' || f.name === 'Onaylayan');

      if (toplamField) data.ticks = parseInt(toplamField.value, 10) || 0;
      if (rutbeField) data.rank = rutbeField.value;

      data.history.unshift({
        action: islemField ? islemField.value : 'Rütbe değişti',
        reason: sebepField ? sebepField.value : '-',
        actor: yapanField ? yapanField.value : '-',
        date: msg.createdAt.toISOString().slice(0, 10)
      });
    }
    console.log(`Log kanalından ${db.size} üyenin tik verisi geri yüklendi.`);
  } catch (err) {
    console.error('Log geri yükleme hatası:', err.message);
  }
}

// --- SLASH KOMUT TANIMLARI ---
const commands = [
  new SlashCommandBuilder()
    .setName('tik-ver')
    .setDescription('Bir üyeye tik ekler.')
    .addUserOption(opt => opt.setName('uye').setDescription('Tik verilecek üye').setRequired(true))
    .addIntegerOption(opt => opt.setName('miktar').setDescription('Verilecek tik miktarı').setMinValue(1).setMaxValue(50).setRequired(true))
    .addStringOption(opt => opt.setName('sebep').setDescription('Tik verme sebebi').setRequired(true)),

  new SlashCommandBuilder()
    .setName('tik-sil')
    .setDescription('Bir üyeden tik siler.')
    .addUserOption(opt => opt.setName('uye').setDescription('Tik silinecek üye').setRequired(true))
    .addIntegerOption(opt => opt.setName('miktar').setDescription('Silinecek tik miktarı').setMinValue(1).setMaxValue(50).setRequired(true))
    .addStringOption(opt => opt.setName('sebep').setDescription('Tik silme sebebi').setRequired(true)),

  new SlashCommandBuilder()
    .setName('tiklerim')
    .setDescription('Kendi tik ve rütbe durumunu gösterir.'),

  new SlashCommandBuilder()
    .setName('tik-bilgi')
    .setDescription('Bir üyenin tik ve rütbe durumunu gösterir.')
    .addUserOption(opt => opt.setName('uye').setDescription('Bilgisi görüntülenecek üye').setRequired(true)),

  new SlashCommandBuilder()
    .setName('liderlik')
    .setDescription('En çok tik alan üyeleri listeler.'),

  new SlashCommandBuilder()
    .setName('terfi')
    .setDescription('Bir üyeye yönetim kararıyla rütbe verir.')
    .addUserOption(opt => opt.setName('uye').setDescription('Terfi edecek üye').setRequired(true))
    .addStringOption(opt =>
      opt.setName('rutbe')
        .setDescription('Verilecek rütbe')
        .setRequired(true)
        .addChoices(...RANK_NAMES.map(n => ({ name: n, value: n })))
    )
    .addStringOption(opt => opt.setName('sebep').setDescription('Terfi sebebi').setRequired(true)),

  new SlashCommandBuilder()
    .setName('tik-gecmisi')
    .setDescription('Bir üyenin tüm tik işlem geçmişini gösterir (yönetim).')
    .addUserOption(opt => opt.setName('uye').setDescription('Geçmişi görüntülenecek üye').setRequired(true))
].map(cmd => cmd.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  console.log(`${client.user.tag} aktif edildi!`);

  // Üyeleri önbelleğe al
  for (const guild of client.guilds.cache.values()) {
    guild.members.fetch().catch(() => {});
  }

  // Log kanalından verileri yükle
  await restoreFromLogs(client);

  // Slash komutlarını kaydet
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
      console.log(`Slash komutları ${GUILD_ID} sunucusuna yüklendi.`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('Global slash komutları yüklendi.');
    }
  } catch (err) {
    console.error('Komut yükleme hatası:', err);
  }
});

// --- !brth SUNUCU ETİKETİ SAYACI ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== '!brth') return;
  try {
    if (message.guild.members.cache.size <= 1) {
      await message.guild.members.fetch({ time: 30000 });
    }
    const etiketKullananlar = message.guild.members.cache.filter(uye =>
      !uye.user.bot &&
      uye.user.primaryGuild?.identityEnabled === true &&
      uye.user.primaryGuild?.tag === 'BRTH'
    );
    await message.reply(`Şu anda sunucuda **BRTH** sunucu etiketini aktif olarak takan **${etiketKullananlar.size}** kişi var.`);
  } catch (err) {
    await message.reply(`Hata detayı: \`${err.message}\``);
  }
});

// --- SLASH KOMUT İŞLEYİCİ ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const { commandName } = interaction;

  // Yönetim yetkisi gerektiren komutlar
  if (['tik-ver', 'tik-sil', 'terfi', 'tik-gecmisi'].includes(commandName)) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: 'Bu komutu kullanmak için yönetim yetkisine sahip olmalısın.', ephemeral: true });
    }
  }

  if (commandName === 'tik-ver') {
    const uye = interaction.options.getMember('uye');
    const miktar = interaction.options.getInteger('miktar');
    const sebep = interaction.options.getString('sebep');

    const data = getMemberData(interaction.guild.id, uye.id);
    data.ticks += miktar;
    const eligible = nextEligibleRank(data.ticks);

    if (RANK_NAMES.indexOf(eligible) > RANK_NAMES.indexOf(data.rank) && RANK_NAMES.indexOf(eligible) <= RANK_NAMES.indexOf('Baron')) {
