const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

// 7/24 açık kalması için web sunucusu
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

client.on('ready', () => {
  console.log(`${client.user.tag} aktif edildi!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.content.toLowerCase() !== '!brth') return;

  try {
    const uyeler = await message.guild.members.fetch();
    const etiketKullananlar = uyeler.filter(uye => 
      !uye.user.bot &&
      uye.user.primaryGuild?.identityEnabled === true &&
      uye.user.primaryGuild?.tag === 'BRTH'
    );

    message.reply(`Şu anda sunucuda **BRTH** sunucu etiketini aktif olarak takan **${etiketKullananlar.size}** kişi var.`);
  } catch (err) {
    console.error(err);
    message.reply('Üyeler taranırken bir hata oluştu.');
  }
});

client.login(process.env.MTU3Mjk4MzA4OTE1MDU1ODM1OA.GWOPFi.tb3hbkF4b7O_uaAK5NnzmO9yqw-Kz32Hvcmvqk);
