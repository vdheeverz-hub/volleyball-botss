require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType
} = require('discord.js');
const { loadData, saveData, withLock } = require('./storage');
const { BASE_RATING, newRatings, getRankForRating, roleName, RANKS } = require('./elo');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

const teamSize = { '1v1': 1, '2v2': 2, '3v3': 3 };

function teamKey(mode, userIds) {
  return `${mode}:${[...userIds].sort().join('-')}`;
}

function getOrCreateTeam(data, mode, userIds) {
  const key = teamKey(mode, userIds);
  if (!data.teams[key]) {
    data.teams[key] = { rating: BASE_RATING, wins: 0, losses: 0, players: userIds, mode };
  }
  return { key, team: data.teams[key] };
}

function teamLabel(team) {
  return team.players.map(id => `<@${id}>`).join(' & ');
}

async function ensureRankRoles(guild) {
  const roles = {};
  for (const r of RANKS) {
    const name = roleName(r);
    let role = guild.roles.cache.find(x => x.name === name);
    if (!role) {
      role = await guild.roles.create({ name, mentionable: false, reason: 'Auto ELO rank role' });
    }
    roles[r.name] = role;
  }
  return roles;
}

async function updatePlayerRank(guild, userId, data) {
  // Find the highest rating this player has across all modes/teams they belong to
  let highest = BASE_RATING;
  for (const key in data.teams) {
    const team = data.teams[key];
    if (team.players.includes(userId) && team.rating > highest) {
      highest = team.rating;
    }
  }
  const rank = getRankForRating(highest);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const allRankNames = RANKS.map(r => roleName(r));
  const rolesToRemove = member.roles.cache.filter(role => allRankNames.includes(role.name) && role.name !== roleName(rank));
  for (const role of rolesToRemove.values()) {
    await member.roles.remove(role).catch(() => {});
  }
  const targetRoleName = roleName(rank);
  if (!member.roles.cache.some(r => r.name === targetRoleName)) {
    let role = guild.roles.cache.find(r => r.name === targetRoleName);
    if (!role) {
      const roles = await ensureRankRoles(guild);
      role = roles[rank.name];
    }
    await member.roles.add(role).catch(() => {});
  }
}

async function finalizeMatch(guild, matchId, winner) {
  const data = loadData();
  const match = data.matches[matchId];
  if (!match || match.resolved) return;

  const teamA = data.teams[match.teamAKey];
  const teamB = data.teams[match.teamBKey];
  const result = newRatings(teamA.rating, teamB.rating, winner);

  teamA.rating = result.ratingA;
  teamB.rating = result.ratingB;
  if (winner === 'A') { teamA.wins++; teamB.losses++; } else { teamB.wins++; teamA.losses++; }

  match.resolved = true;
  match.winner = winner;
  saveData(data);

  for (const id of [...teamA.players, ...teamB.players]) {
    await updatePlayerRank(guild, id, data);
  }

  const channel = await guild.channels.fetch(match.channelId).catch(() => null);
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('Match result confirmed')
      .setDescription(
        `**${teamLabel(teamA)}**: ${teamA.rating} (${result.deltaA >= 0 ? '+' : ''}${result.deltaA})\n` +
        `**${teamLabel(teamB)}**: ${teamB.rating} (${result.deltaB >= 0 ? '+' : ''}${result.deltaB})\n\n` +
        `Winner: **${winner === 'A' ? teamLabel(teamA) : teamLabel(teamB)}**\n\n` +
        `Run /closechannel here when you're done to remove this channel.`
      )
      .setColor(0x1D9E75);
    await channel.send({ embeds: [embed] });
  }
}

async function postModLog(guild, embed) {
  const data = loadData();
  if (!data.modLogChannelId) return;
  const channel = await guild.channels.fetch(data.modLogChannelId).catch(() => null);
  if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await withLock(() => handleCommand(interaction));
    } else if (interaction.isButton()) {
      await withLock(() => handleButton(interaction));
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong running that command.', ephemeral: true }).catch(() => {});
    }
  }
});

async function handleCommand(interaction) {
  const { commandName } = interaction;
  const data = loadData();

  if (commandName === 'queue') {
    const mode = interaction.options.getString('mode');
    const size = teamSize[mode];
    const players = [interaction.user.id];
    const p1 = interaction.options.getUser('partner1');
    const p2 = interaction.options.getUser('partner2');
    if (p1) players.push(p1.id);
    if (p2) players.push(p2.id);

    if (players.length !== size) {
      await interaction.reply({ content: `${mode} needs exactly ${size} player(s) total (including you). You provided ${players.length}.`, ephemeral: true });
      return;
    }
    if (new Set(players).size !== players.length) {
      await interaction.reply({ content: 'You listed the same player twice.', ephemeral: true });
      return;
    }

    const { key } = getOrCreateTeam(data, mode, players);
    if (data.queues[mode].includes(key)) {
      await interaction.reply({ content: 'Your team is already in this queue.', ephemeral: true });
      return;
    }
    data.queues[mode].push(key);
    saveData(data);
    await interaction.reply(`Team ${players.map(id => `<@${id}>`).join(' & ')} joined the **${mode}** queue.`);
  }

  else if (commandName === 'leavequeue') {
    const mode = interaction.options.getString('mode');
    const before = data.queues[mode].length;
    data.queues[mode] = data.queues[mode].filter(key => {
      const team = data.teams[key];
      return !team.players.includes(interaction.user.id);
    });
    saveData(data);
    if (data.queues[mode].length < before) {
      await interaction.reply('Your team left the queue.');
    } else {
      await interaction.reply({ content: 'Your team was not in that queue.', ephemeral: true });
    }
  }

  else if (commandName === 'startqueue') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Only admins can start matches from the queue.', ephemeral: true });
      return;
    }
    const mode = interaction.options.getString('mode');
    if (data.queues[mode].length < 2) {
      await interaction.reply({ content: `Not enough teams waiting in the ${mode} queue.`, ephemeral: true });
      return;
    }
    const idxA = Math.floor(Math.random() * data.queues[mode].length);
    const teamAKey = data.queues[mode].splice(idxA, 1)[0];
    const idxB = Math.floor(Math.random() * data.queues[mode].length);
    const teamBKey = data.queues[mode].splice(idxB, 1)[0];
    saveData(data);

    const teamA = data.teams[teamAKey];
    const teamB = data.teams[teamBKey];
    const matchId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const guild = interaction.guild;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...[...teamA.players, ...teamB.players].map(id => ({
        id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      }))
    ];
    const channel = await guild.channels.create({
      name: `match-${matchId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites
    });

    data.matches[matchId] = {
      mode, teamAKey, teamBKey, channelId: channel.id, votes: {}, resolved: false
    };
    saveData(data);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote_${matchId}_A`).setLabel(`Team A won`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vote_${matchId}_B`).setLabel(`Team B won`).setStyle(ButtonStyle.Danger)
    );
    const embed = new EmbedBuilder()
      .setTitle(`${mode} match`)
      .setDescription(`**Team A:** ${teamLabel(teamA)} (${teamA.rating})\n**Team B:** ${teamLabel(teamB)} (${teamB.rating})\n\nAll players vote for the winner below.`)
      .setColor(0x378ADD)
      .setFooter({ text: `Match ID: ${matchId}` });
    await channel.send({ content: [...teamA.players, ...teamB.players].map(id => `<@${id}>`).join(' '), embeds: [embed], components: [row] });

    await interaction.reply(`Match started: ${channel} between **${teamLabel(teamA)}** and **${teamLabel(teamB)}**.`);
  }

  else if (commandName === 'resolve') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Only admins can resolve disputes.', ephemeral: true });
      return;
    }
    const matchId = interaction.options.getString('matchid');
    const winner = interaction.options.getString('winner');
    const match = data.matches[matchId];
    if (!match) {
      await interaction.reply({ content: 'No match found with that ID.', ephemeral: true });
      return;
    }
    if (match.resolved) {
      await interaction.reply({ content: 'That match is already resolved.', ephemeral: true });
      return;
    }
    await interaction.reply(`Resolving match ${matchId} as a win for Team ${winner}...`);
    await finalizeMatch(interaction.guild, matchId, winner);
  }

  else if (commandName === 'closechannel') {
    const data2 = loadData();
    const match = Object.values(data2.matches).find(m => m.channelId === interaction.channel.id);
    if (!match) {
      await interaction.reply({ content: 'This is not a match channel.', ephemeral: true });
      return;
    }
    await interaction.reply('Closing this channel in 5 seconds...');
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  }

  else if (commandName === 'leaderboard') {
    const mode = interaction.options.getString('mode');
    const teams = Object.values(data.teams).filter(t => t.mode === mode);
    teams.sort((a, b) => b.rating - a.rating);
    if (teams.length === 0) {
      await interaction.reply(`No matches recorded yet for ${mode}.`);
      return;
    }
    const lines = teams.slice(0, 15).map((t, i) => `**${i + 1}.** ${teamLabel(t)} — ${t.rating} (${t.wins}W-${t.losses}L)`);
    const embed = new EmbedBuilder()
      .setTitle(`${mode} leaderboard`)
      .setDescription(lines.join('\n'))
      .setColor(0xff5c39);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'stats') {
    const mode = interaction.options.getString('mode');
    const players = [interaction.options.getUser('player1').id];
    const p2 = interaction.options.getUser('player2');
    const p3 = interaction.options.getUser('player3');
    if (p2) players.push(p2.id);
    if (p3) players.push(p3.id);

    const key = teamKey(mode, players);
    const team = data.teams[key];
    if (!team) {
      await interaction.reply({ content: 'No record found for that team in this mode.', ephemeral: true });
      return;
    }
    const rank = getRankForRating(team.rating);
    const embed = new EmbedBuilder()
      .setTitle(`${teamLabel(team)} — ${mode}`)
      .setDescription(`Rating: **${team.rating}**\nRank: ${roleName(rank)}\nRecord: ${team.wins}W - ${team.losses}L`)
      .setColor(0x1D9E75);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'kickqueue') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const mode = interaction.options.getString('mode');
    const player = interaction.options.getUser('player');
    const before = data.queues[mode].length;
    let removedTeam = null;
    data.queues[mode] = data.queues[mode].filter(key => {
      const team = data.teams[key];
      if (team.players.includes(player.id)) {
        removedTeam = team;
        return false;
      }
      return true;
    });
    if (data.queues[mode].length === before) {
      await interaction.reply({ content: `${player} is not on a team in the ${mode} queue.`, ephemeral: true });
      return;
    }
    saveData(data);
    await interaction.reply(`Removed team ${teamLabel(removedTeam)} from the ${mode} queue.`);
  }

  else if (commandName === 'editteam') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const mode = interaction.options.getString('mode');
    const oldPlayer = interaction.options.getUser('oldplayer');
    const newPlayer = interaction.options.getUser('newplayer');

    const oldKey = data.queues[mode].find(key => data.teams[key].players.includes(oldPlayer.id));
    if (!oldKey) {
      await interaction.reply({ content: `${oldPlayer} is not on a team currently in the ${mode} queue.`, ephemeral: true });
      return;
    }
    const oldTeam = data.teams[oldKey];
    if (oldTeam.players.includes(newPlayer.id)) {
      await interaction.reply({ content: `${newPlayer} is already on that team.`, ephemeral: true });
      return;
    }
    const newPlayers = oldTeam.players.map(id => (id === oldPlayer.id ? newPlayer.id : id));
    const { key: newKey } = getOrCreateTeam(data, mode, newPlayers);

    data.queues[mode] = data.queues[mode].map(key => (key === oldKey ? newKey : key));
    saveData(data);
    await interaction.reply(`Updated team in the ${mode} queue: ${teamLabel(data.teams[newKey])} (swapped ${oldPlayer} for ${newPlayer}).`);
  }

  else if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🏐 Volleyball ELO Bot — Commands')
      .setColor(0x378ADD)
      .addFields(
        { name: 'Queueing', value: '`/queue` `/leavequeue`' },
        { name: 'Matches (Admin)', value: '`/startqueue` `/resolve` `/kickqueue` `/editteam`' },
        { name: 'Matches (Everyone)', value: '`/closechannel`' },
        { name: 'Stats', value: '`/leaderboard` `/stats` `/profile` `/matchhistory`' },
        { name: 'Moderation (Admin)', value: '`/clear` `/mute` `/unmute` `/kick` `/ban` `/unban` `/warn` `/warnings` `/setmodlog`' }
      );
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'profile') {
    const user = interaction.options.getUser('user') || interaction.user;
    const modes = ['1v1', '2v2', '3v3'];
    const lines = [];
    for (const mode of modes) {
      const teams = Object.values(data.teams).filter(t => t.mode === mode && t.players.includes(user.id));
      if (teams.length === 0) continue;
      teams.sort((a, b) => b.rating - a.rating);
      for (const t of teams) {
        lines.push(`**${mode}** — ${teamLabel(t)}: ${t.rating} (${t.wins}W-${t.losses}L)`);
      }
    }
    if (lines.length === 0) {
      await interaction.reply(`${user.username} has no recorded matches yet.`);
      return;
    }
    let highest = BASE_RATING;
    for (const key in data.teams) {
      const t = data.teams[key];
      if (t.players.includes(user.id) && t.rating > highest) highest = t.rating;
    }
    const rank = getRankForRating(highest);
    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s profile`)
      .setDescription(`Rank: ${roleName(rank)}\n\n${lines.join('\n')}`)
      .setColor(0x1D9E75);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'matchhistory') {
    const mode = interaction.options.getString('mode');
    const players = [interaction.options.getUser('player1').id];
    const p2 = interaction.options.getUser('player2');
    const p3 = interaction.options.getUser('player3');
    if (p2) players.push(p2.id);
    if (p3) players.push(p3.id);
    const key = teamKey(mode, players);

    const relevant = Object.entries(data.matches)
      .filter(([, m]) => m.resolved && (m.teamAKey === key || m.teamBKey === key))
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 10);

    if (relevant.length === 0) {
      await interaction.reply({ content: 'No match history found for that team.', ephemeral: true });
      return;
    }
    const lines = relevant.map(([id, m]) => {
      const isA = m.teamAKey === key;
      const opponentKey = isA ? m.teamBKey : m.teamAKey;
      const opponent = data.teams[opponentKey];
      const won = (isA && m.winner === 'A') || (!isA && m.winner === 'B');
      return `${won ? '✅ Won' : '❌ Lost'} vs ${opponent ? teamLabel(opponent) : 'unknown team'}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`Match history — ${teamLabel(data.teams[key] || { players })}`)
      .setDescription(lines.join('\n'))
      .setColor(0x9b59b6);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'setmodlog') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    data.modLogChannelId = interaction.channel.id;
    saveData(data);
    await interaction.reply(`Mod-log channel set to ${interaction.channel}.`);
  }

  else if (commandName === 'clear') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: 'You need Manage Messages permission for this.', ephemeral: true });
      return;
    }
    const amount = interaction.options.getInteger('amount');
    if (amount < 1 || amount > 100) {
      await interaction.reply({ content: 'Amount must be between 1 and 100.', ephemeral: true });
      return;
    }
    const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
    await interaction.reply({ content: deleted ? `Deleted ${deleted.size} messages.` : 'Could not delete messages (they may be older than 14 days).', ephemeral: true });
  }

  else if (commandName === 'mute') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
      await interaction.reply({ content: 'You need Timeout Members permission for this.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: 'Could not find that member.', ephemeral: true });
      return;
    }
    await member.timeout(minutes * 60 * 1000, reason).catch(async () => {
      await interaction.reply({ content: 'Failed to mute (check role hierarchy/permissions).', ephemeral: true });
    });
    await interaction.reply(`${user} has been muted for ${minutes} minute(s). Reason: ${reason}`);
    const embed = new EmbedBuilder().setTitle('Member muted').setColor(0xf5a623)
      .setDescription(`**User:** ${user}\n**Duration:** ${minutes} min\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'unmute') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
      await interaction.reply({ content: 'You need Timeout Members permission for this.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: 'Could not find that member.', ephemeral: true });
      return;
    }
    await member.timeout(null).catch(() => {});
    await interaction.reply(`${user} has been unmuted.`);
    const embed = new EmbedBuilder().setTitle('Member unmuted').setColor(0x4ade80)
      .setDescription(`**User:** ${user}\n**Moderator:** ${interaction.user}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'kick') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
      await interaction.reply({ content: 'You need Kick Members permission for this.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: 'Could not find that member.', ephemeral: true });
      return;
    }
    await member.kick(reason).catch(async () => {
      await interaction.reply({ content: 'Failed to kick (check role hierarchy/permissions).', ephemeral: true });
    });
    await interaction.reply(`${user} has been kicked. Reason: ${reason}`);
    const embed = new EmbedBuilder().setTitle('Member kicked').setColor(0xf87171)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'ban') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.reply({ content: 'You need Ban Members permission for this.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    await interaction.guild.members.ban(user.id, { reason }).catch(async () => {
      await interaction.reply({ content: 'Failed to ban (check role hierarchy/permissions).', ephemeral: true });
    });
    await interaction.reply(`${user} has been banned. Reason: ${reason}`);
    const embed = new EmbedBuilder().setTitle('Member banned').setColor(0xdc2626)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'unban') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.reply({ content: 'You need Ban Members permission for this.', ephemeral: true });
      return;
    }
    const userId = interaction.options.getString('userid');
    await interaction.guild.members.unban(userId).catch(async () => {
      await interaction.reply({ content: 'Failed to unban (check the user ID).', ephemeral: true });
    });
    await interaction.reply(`User ID ${userId} has been unbanned.`);
    const embed = new EmbedBuilder().setTitle('Member unbanned').setColor(0x4ade80)
      .setDescription(`**User ID:** ${userId}\n**Moderator:** ${interaction.user}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'warn') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
      await interaction.reply({ content: 'You need Timeout Members permission for this.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    if (!data.warnings[user.id]) data.warnings[user.id] = [];
    data.warnings[user.id].push({ reason, moderatorId: interaction.user.id, date: new Date().toISOString() });
    saveData(data);
    await interaction.reply(`${user} has been warned. Reason: ${reason}`);
    const embed = new EmbedBuilder().setTitle('Member warned').setColor(0xf5a623)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}\n**Total warnings:** ${data.warnings[user.id].length}`);
    await postModLog(interaction.guild, embed);
  }

  else if (commandName === 'warnings') {
    const user = interaction.options.getUser('user');
    const list = data.warnings[user.id] || [];
    if (list.length === 0) {
      await interaction.reply(`${user} has no warnings.`);
      return;
    }
    const lines = list.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.moderatorId}> (${new Date(w.date).toLocaleDateString()})`);
    const embed = new EmbedBuilder().setTitle(`Warnings for ${user.username}`).setDescription(lines.join('\n')).setColor(0xf5a623);
    await interaction.reply({ embeds: [embed] });
  }
}

async function handleButton(interaction) {
  const [, matchId, choice] = interaction.customId.split('_');
  const data = loadData();
  const match = data.matches[matchId];
  if (!match) {
    await interaction.reply({ content: 'This match no longer exists.', ephemeral: true });
    return;
  }
  if (match.resolved) {
    await interaction.reply({ content: 'This match is already resolved.', ephemeral: true });
    return;
  }

  const teamA = data.teams[match.teamAKey];
  const teamB = data.teams[match.teamBKey];
  const allPlayers = [...teamA.players, ...teamB.players];
  if (!allPlayers.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Only players in this match can vote.', ephemeral: true });
    return;
  }

  match.votes[interaction.user.id] = choice;
  saveData(data);

  const votesCast = Object.keys(match.votes).length;
  if (votesCast < allPlayers.length) {
    await interaction.reply({ content: `Vote recorded (${votesCast}/${allPlayers.length}).`, ephemeral: true });
    return;
  }

  const uniqueChoices = new Set(Object.values(match.votes));
  if (uniqueChoices.size === 1) {
    const winner = [...uniqueChoices][0];
    await interaction.reply('All votes are in and agree. Updating ratings...');
    await finalizeMatch(interaction.guild, matchId, winner);
  } else {
    const admins = interaction.guild.members.cache.filter(m => m.permissions.has(PermissionFlagsBits.Administrator));
    const pings = admins.map(m => `<@${m.id}>`).join(' ') || '@here';
    await interaction.reply(
      `Votes are split. ${pings} please resolve with \`/resolve matchid:${matchId} winner:A\` or \`winner:B\`.`
    );
  }
}

client.login(process.env.DISCORD_TOKEN);
