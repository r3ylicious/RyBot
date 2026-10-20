require('dotenv').config();
const fs=require('node:fs'), path=require('node:path');
const {Client,GatewayIntentBits,Partials,PermissionsBitField,ChannelType,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,AttachmentBuilder}=require('discord.js');
const {joinVoiceChannel,createAudioPlayer,createAudioResource,AudioPlayerStatus,VoiceConnectionStatus,entersState}=require('@discordjs/voice');
try{const p=require('ffmpeg-static');if(p)process.env.FFMPEG_PATH=p;}catch{}
const TOKEN=process.env.DISCORD_TOKEN, PREFIX=process.env.PREFIX||'ry!', CFG=path.join(__dirname,'..','config.json'), AUDIO=path.join(__dirname,'..','welcome.mp3');
if(!TOKEN){console.error('Set DISCORD_TOKEN in Render > Environment.');process.exit(1);}
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel]});
const read=()=>{try{return JSON.parse(fs.readFileSync(CFG,'utf8'));}catch{return {};}};
const get=id=>read()[id]||{};
function save(id,patch){const c=read();c[id]={...(c[id]||{}),...patch};fs.writeFileSync(CFG,JSON.stringify(c,null,2));}
const emb=(title,description,color=0x5865F2)=>new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
const staff=(m,c)=>m.permissions.has(PermissionsBitField.Flags.Administrator)||(c.staffRoleId&&m.roles.cache.has(c.staffRoleId));
const slug=s=>s.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').slice(0,65)||'member';
async function cat(g,n){return g.channels.cache.find(x=>x.type===ChannelType.GuildCategory&&x.name===n)||g.channels.create({name:n,type:ChannelType.GuildCategory});}
async function txt(g,n,p){let c=g.channels.cache.find(x=>x.type===ChannelType.GuildText&&x.name===n);if(!c)c=await g.channels.create({name:n,type:ChannelType.GuildText,parent:p?.id});else if(p&&c.parentId!==p.id)await c.setParent(p.id).catch(()=>{});return c;}
async function vc(g,n,p){let c=g.channels.cache.find(x=>x.type===ChannelType.GuildVoice&&x.name===n);if(!c)c=await g.channels.create({name:n,type:ChannelType.GuildVoice,parent:p?.id});return c;}
async function role(g,n,permissions=[]){return g.roles.cache.find(x=>x.name===n)||g.roles.create({name:n,permissions,reason:'RY setup'});}
async function setup(g){
 const verified=await role(g,'Verified'), st=await role(g,'Staff',[PermissionsBitField.Flags.ManageMessages]);
 const info=await cat(g,'INFORMATION'), community=await cat(g,'COMMUNITY'), support=await cat(g,'SUPPORT'), voice=await cat(g,'VOICE');
 const rules=await txt(g,'rules',info), server=await txt(g,'server-info',info);await txt(g,'announcements',info);
 await txt(g,'general',community);await txt(g,'gaming',community);await txt(g,'media',community);
 const panel=await txt(g,'create-ticket',support);await txt(g,'ai-support',support);
 const welcome=await vc(g,'welcome',voice);await vc(g,'general-voice',voice);await vc(g,'gaming-voice',voice);const vouches=await txt(g,'vouches',support);
 await rules.send({embeds:[emb('Server Rules','1. Respect everyone.\\n2. No spam or harassment.\\n3. Follow Discord Terms of Service.\\n4. Follow staff instructions.')]});
 await server.send({embeds:[emb('Server Information',`Welcome to **${g.name}**! Baca #rules sebelum mulai ngobrol.`)]});
 await panel.send({embeds:[emb('Butuh bantuan?','Tekan tombol di bawah untuk membuat ticket pribadi.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ry_ticket_create').setLabel('Buat Ticket').setStyle(ButtonStyle.Primary).setEmoji('ð«'))]});
 save(g.id,{verifiedRoleId:verified.id,staffRoleId:st.id,welcomeVoiceChannelId:welcome.id,ticketCategoryId:support.id,ticketLogChannelId:server.id,vouchesChannelId:vouches.id});
 return `Setup selesai!\\nVerified Role ID: \`${verified.id}\`\\nStaff Role ID: \`${st.id}\`\\nWelcome: <#${welcome.id}>\\nTicket: <#${panel.id}>\\nVouches: <#${vouches.id}>`;
}
async function welcome(member,c){
 if(!member.voice.channel||!c.verifiedRoleId)return;
 const r=member.guild.roles.cache.get(c.verifiedRoleId);if(!r){console.error('verifiedRoleId tidak valid');return;}
 let conn;
 try{
  if(!fs.existsSync(AUDIO)){console.warn('welcome.mp3 tidak ada; lanjut memberikan role.');return;}
  conn=joinVoiceChannel({channelId:member.voice.channel.id,guildId:member.guild.id,adapterCreator:member.guild.voiceAdapterCreator,selfDeaf:true});
  await entersState(conn,VoiceConnectionStatus.Ready,20000);
  const player=createAudioPlayer();conn.subscribe(player);const resource=createAudioResource(AUDIO);
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Audio timeout')),45000);player.once(AudioPlayerStatus.Idle,()=>{clearTimeout(t);resolve();});player.once('error',e=>{clearTimeout(t);reject(e);});player.play(resource);});
 }catch(e){console.error('Welcome MP3 error:',e);}finally{
  if(conn)conn.destroy();
  try{const fresh=await member.guild.members.fetch(member.id);if(!fresh.roles.cache.has(r.id))await fresh.roles.add(r,'RY welcome flow');}catch(e){console.error('Role add error:',e);}
 }
}
client.once('ready',()=>{console.log(`RY online: ${client.user.tag}`);client.user.setActivity(`${PREFIX}help`);});
client.on('guildMemberAdd',m=>{const c=m.guild.channels.cache.find(x=>x.type===ChannelType.GuildText&&x.name==='server-info');if(c)c.send(`Halo ${m}, selamat datang di **${m.guild.name}**! Masuk voice **welcome** untuk audio dan role Verified.`).catch(()=>{});});
client.on('voiceStateUpdate',async(o,n)=>{if(!n.member||n.member.user.bot)return;const c=get(n.guild.id);if(n.channelId===c.welcomeVoiceChannelId&&o.channelId!==n.channelId)await welcome(n.member,c);});
async function closeTicket(ch,g,c,reply){
 const msgs=await ch.messages.fetch({limit:100}).catch(()=>null);
 if(msgs){const lines=[...msgs.values()].reverse().map(m=>`[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.cleanContent}`).join('\\n');const file=new AttachmentBuilder(Buffer.from(lines||'Transcript kosong.'),{name:`${ch.name}-transcript.txt`});const log=c.ticketLogChannelId&&g.channels.cache.get(c.ticketLogChannelId);if(log)await log.send({content:`Transcript ${ch.name}`,files:[file]}).catch(()=>{});}
 await reply();setTimeout(()=>ch.delete('Ticket ditutup').catch(()=>{}),3000);
}
client.on('messageCreate',async m=>{
 if(!m.guild||m.author.bot||!m.content.startsWith(PREFIX))return;
 const a=m.content.slice(PREFIX.length).trim().split(/\\s+/),cmd=(a.shift()||'').toLowerCase(),c=get(m.guild.id);
 try{
  if(cmd==='help')return m.reply({embeds:[emb('RY Bot Commands',`\`${PREFIX}setup all\` â setup server\\n\`${PREFIX}setup welcome\` â setup welcome\\n\`${PREFIX}setup ticket\` â panel ticket\\n\`${PREFIX}setup vouches\` â channel vouches\\n\`${PREFIX}welcome test\` â tes audio+role\\n\`${PREFIX}vouches @member pesan\` â vouch\\n\`${PREFIX}ticket close\` â tutup ticket`)]});
  if(cmd==='setup'){
   if(!m.member.permissions.has(PermissionsBitField.Flags.Administrator))return m.reply('Khusus Administrator.');
   const s=(a[0]||'').toLowerCase();
   if(s==='all')return m.reply(await setup(m.guild));
   if(s==='welcome'){const v=await vc(m.guild,'welcome',await cat(m.guild,'VOICE'));save(m.guild.id,{welcomeVoiceChannelId:v.id});return m.reply(`Welcome: <#${v.id}>`);}
   if(s==='ticket'){const p=await txt(m.guild,'create-ticket',await cat(m.guild,'SUPPORT'));await p.send({embeds:[emb('Butuh bantuan?','Tekan tombol untuk membuat ticket.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ry_ticket_create').setLabel('Buat Ticket').setStyle(ButtonStyle.Primary))]});return m.reply(`Panel: <#${p.id}>`);}
   if(s==='vouches'){const v=await txt(m.guild,'vouches',await cat(m.guild,'SUPPORT'));save(m.guild.id,{vouchesChannelId:v.id});return m.reply(`Vouches: <#${v.id}>`);}
   return m.reply('Gunakan `ry!setup all|welcome|ticket|vouches`.');
  }
  if(cmd==='welcome'&&a[0]==='test'){if(!m.member.permissions.has(PermissionsBitField.Flags.Administrator))return m.reply('Khusus Administrator.');if(!m.member.voice.channel)return m.reply('Masuk voice dulu.');await m.reply('Tes welcome dimulai.');return welcome(m.member,c);}
  if(cmd==='vouches'){const t=m.mentions.members.first();if(!t)return m.reply('Format: `ry!vouches @member pesan`');const body=a.filter(x=>!/^<@/.test(x)).join(' ')||'Transaksi berjalan dengan baik.';const ch=(c.vouchesChannelId&&m.guild.channels.cache.get(c.vouchesChannelId))||m.guild.channels.cache.find(x=>x.name==='vouches');if(!ch)return m.reply('Jalankan `ry!setup vouches` dulu.');await ch.send({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('Vouch Baru').setDescription(body).addFields({name:'Dari',value:`${m.author}`,inline:true},{name:'Untuk',value:`${t}`,inline:true}).setTimestamp()]});return m.reply('Vouch terkirim.');}
  if(cmd==='ticket'&&a[0]==='close'){if(!m.channel.name.startsWith('ticket-'))return m.reply('Hanya di ticket.');const owner=m.channel.topic?.match(/owner:(\\d+)/)?.[1];if(!staff(m.member,c)&&owner!==m.author.id)return m.reply('Khusus pemilik ticket atau staff.');return closeTicket(m.channel,m.guild,c,()=>m.reply('Ticket ditutup dalam 3 detik.'));}
 }catch(e){console.error('Command error:',e);m.reply('Ada error. Cek log Render.').catch(()=>{});}
});
client.on('interactionCreate',async i=>{
 if(!i.isButton()||!i.guild)return;const c=get(i.guild.id);
 try{
  if(i.customId==='ry_ticket_create'){
   const exists=i.guild.channels.cache.find(x=>x.type===ChannelType.GuildText&&x.topic?.includes(`owner:${i.user.id}`));if(exists)return i.reply({content:`Ticket lu sudah ada: ${exists}`,ephemeral:true});
   const catg=(c.ticketCategoryId&&i.guild.channels.cache.get(c.ticketCategoryId))||await cat(i.guild,'SUPPORT'),sr=c.staffRoleId&&i.guild.roles.cache.get(c.staffRoleId);
   const ow=[{id:i.guild.roles.everyone.id,deny:[PermissionsBitField.Flags.ViewChannel]},{id:i.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.AttachFiles]}];if(sr)ow.push({id:sr.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory]});
   const ch=await i.guild.channels.create({name:`ticket-${slug(i.user.username)}`,type:ChannelType.GuildText,parent:catg.id,topic:`owner:${i.user.id}`,permissionOverwrites:ow});
   await ch.send({content:`${i.user} ${sr?`<@&${sr.id}>`:''}`,embeds:[emb('Ticket Dibuka','Jelaskan kebutuhan lu, staff akan bantu.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ry_ticket_claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('ry_ticket_close').setLabel('Tutup Ticket').setStyle(ButtonStyle.Danger))]});
   return i.reply({content:`Ticket dibuat: ${ch}`,ephemeral:true});
  }
  if(i.customId==='ry_ticket_claim'){if(!staff(i.member,c))return i.reply({content:'Khusus staff.',ephemeral:true});return i.reply({embeds:[emb('Ticket di-claim',`Ditangani oleh ${i.user}.`,0x57F287)]});}
  if(i.customId==='ry_ticket_close'){const owner=i.channel.topic?.match(/owner:(\\d+)/)?.[1];if(!staff(i.member,c)&&owner!==i.user.id)return i.reply({content:'Khusus pemilik ticket atau staff.',ephemeral:true});return closeTicket(i.channel,i.guild,c,()=>i.reply('Ticket ditutup dalam 3 detik.'));}
 }catch(e){console.error('Button error:',e);if(!i.replied)i.reply({content:'Error. Cek log Render.',ephemeral:true}).catch(()=>{});}
});
client.login(TOKEN);
