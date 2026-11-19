const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, MessageFlags } = require('discord.js');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
if (!TOKEN) throw new Error('TOKEN ortam değişkeni eksik.');

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
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch (err) {
  throw new Error(`Veri dosyası okunamadı: ${err.message}`);
}
function saveDB() {
  const temp = `${DB_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(temp, DB_PATH);
}
function getData(guildId, userId) {
  const key = `${guildId}_${userId}`;
  if (!db[key]) db[key] = { ticks: 0, rank: RANKS[0].name, history: [], manualRank: false };
  return db[key];
}
function eligibleRank(ticks) {
  return RANKS.filter(r => r.threshold !== null && ticks >= r.threshold).at(-1).name;
}
function isStaff(member) {
  return Boolean(member && (member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(role => STAFF_ROLE_IDS.includes(role.id))));
}
function record(data, action, reason, actor) {
  data.history.unshift({ action, reason, actor: `<@${actor}>`, date: new Date().toISOString().slice(0, 10) });
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
    const embed = new EmbedBuilder().setTitle(title).setColor(0xF1C40F)
      .addFields(fields.map(f => ({ name: f.name, value: String(f.value), inline: Boolean(f.inline) })))
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) { console.error('Log gönderilemedi:', err.message); }
}
const userOpt = (opt, description) => opt.setName('uye').setDescription(description).setRequired(true);
const amountOpt = opt => opt.setName('miktar').setDescription('Tik miktarı').setMinValue(1).setMaxValue(50).setRequired(true);
const reasonOpt = opt => opt.setName('sebep').setDescription('İşlem sebebi').setRequired(true);
const commands = [
  new SlashCommandBuilder().setName('tik-ver').setDescription('Üyeye tik ekler.').addUserOption(o => userOpt(o, 'Tik verilecek üye')).addIntegerOption(amountOpt).addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('tik-sil').setDescription('Üyeden tik siler.').addUserOption(o => userOpt(o, 'Tik silinecek üye')).addIntegerOption(amountOpt).addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('tiklerim').setDescription('Tik ve rütbe durumunu gösterir.'),
  new SlashCommandBuilder().setName('tik-bilgi').setDescription('Üyenin tik durumunu gösterir.').addUserOption(o => userOpt(o, 'Bilgisi görüntülenecek üye')),
  new SlashCommandBuilder().setName('liderlik').setDescription('En yüksek tikli üyeleri listeler.'),
  new SlashCommandBuilder().setName('terfi').setDescription('Yönetim kararıyla rütbe atar.').addUserOption(o => userOpt(o, 'Rütbe verilecek üye'))
    .addStringOption(o => o.setName('rutbe').setDescription('Atanacak rütbe').setRequired(true).addChoices(...RANK_NAMES.map(name => ({ name, value: name }))))
    .addStringOption(reasonOpt),
  new SlashCommandBuilder().setName('tik-gecmisi').setDescription('Üyenin tik işlem geçmişini gösterir.').addUserOption(o => userOpt(o, 'Geçmişi görüntülenecek üye'))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.once('ready', async () => {
  console.log(`${client.user.tag} aktif!`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash komutları yüklendi.');
  } catch (err) { console.error('Slash komut hatası:', err); }
});
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot || message.content.trim().toLowerCase() !== '!brth') return;
  try {
    const members = await message.guild.members.fetch();
    const count = members.filter(m => !m.user.bot && m.user.primaryGuild?.identityEnabled === true && m.user.primaryGuild?.tag?.toUpperCase() === 'BRTH').size;
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
      await sendLog(interaction.guild, command === 'terfi' ? '👑 BARATHEON RÜTBE DEĞİŞİKLİĞİ' : '👑 BARATHEON TİK KAYDI', [
        { name: 'Üye', value: `<@${user.id}>`, inline: true },
        { name: 'İşlem', value: action, inline: true },
        { name: 'Toplam Tik', value: data.ticks, inline: true },
        { name: 'Rütbe', value: data.rank, inline: true },
        { name: 'Sebep', value: reason },
        { name: 'İşlemi Yapan', value: `<@${interaction.user.id}>` }
      ]);
      return await interaction.editReply(`✅ <@${user.id}> — ${action}. Toplam: **${data.ticks} tik** | Rütbe: **${data.rank}**${roleError ? `\n⚠️ ${roleError}` : ''}`);
    }
    if (command === 'tiklerim' || command === 'tik-bilgi') {
      const user = command === 'tiklerim' ? interaction.user : interaction.options.getUser('uye');
      const data = getData(interaction.guild.id, user.id);
      const next = data.manualRank ? null : RANKS.find(r => r.threshold !== null && r.threshold > data.ticks);
      const embed = new EmbedBuilder().setTitle(`👑 ${user.username} — Tik Bilgisi`).setColor(0xF1C40F).addFields(
        { name: 'Üye', value: `<@${user.id}>`, inline: true },
        { name: 'Toplam Tik', value: String(data.ticks), inline: true },
        { name: 'Rütbe', value: data.rank, inline: true },
        { name: 'Sonraki Rütbe', value: next ? `${next.name} — ${next.threshold - data.ticks} tik kaldı` : 'Yönetim değerlendirmesi' }
      );
      if (command === 'tik-bilgi') embed.addFields({ name: 'Son İşlemler', value: data.history.slice(0, 5).map(h => `${h.date} — ${h.action}`).join('\n') || 'Kayıt yok.' });
      return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    if (command === 'liderlik') {
      const prefix = `${interaction.guild.id}_`;
      const entries = Object.entries(db).filter(([key, data]) => key.startsWith(prefix) && data.ticks > 0)
        .map(([key, data]) => ({ userId: key.slice(prefix.length), ...data }))
        .sort((a, b) => b.ticks - a.ticks).slice(0, 10);
      if (!entries.length) return await interaction.reply('Henüz tik kaydı yok.');
      const lines = entries.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.ticks} tik** · ${r.rank}`);
      return await interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 Baratheon Tik Sıralaması').setDescription(lines.join('\n')).setColor(0xF1C40F)] });
    }
    if (command === 'tik-gecmisi') {
      const user = interaction.options.getUser('uye');
      const data = getData(interaction.guild.id, user.id);
      if (!data.history.length) return await interaction.reply({ content: 'Bu üyenin işlem geçmişi bulunmuyor.', flags: MessageFlags.Ephemeral });
      const lines = data.history.slice(0, 15).map(h => `**${h.date}** ${h.action} — ${h.reason} · ${h.actor}`);
      const description = lines.join('\n').slice(0, 4000);
      return await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`📜 ${user.username} — Tik Geçmişi`).setDescription(description).setColor(0x5865F2)], flags: MessageFlags.Ephemeral });
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
app.listen(process.env.PORT || 3000, () => console.log('Web sunucusu aktif.'));
client.login(TOKEN);
