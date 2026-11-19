const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('BRTH Bot Aktif!'));
app.listen(process.env.PORT || 3000);

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
  // Bot açılırken sunucu üyelerini arka planda önbelleğe al
  for (const guild of client.guilds.cache.values()) {
    guild.members.fetch().catch(err => console.error('Önbellek hatası:', err.message));
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== '!brth') return;

  try {
    // Önbellekte hiç üye yoksa çekmeyi dene, varsa doğrudan hafızadan anında say
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
    console.error(err);
    await message.reply(`Hata detayı: \`${err.message}\``);
  }
});

client.login(process.env.TOKEN);
