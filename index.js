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
const typeLabel = { tournament: 'Tournament', ranked: 'Ranked' };

function teamKey(type, mode, userIds) {
  return `${type}:${mode}:${[...userIds].sort().join('-')}`;
}

function getOrCreateTeam(data, type, mode, userIds) {
  const key = teamKey(type, mode, userIds);
  if (!data.teams[key]) {
    data.teams[key] = { rating: BASE_RATING, wins: 0, losses: 0, streak: 0, players: userIds, mode, type };
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
  let highest = BASE_RATING;
  for (const key in data.teams) {
    const team = data.teams[key];
    if (team.players.includes(userId) && team.rating > highest) highest = team.rating;
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

function buildLeaderboardEmbed(data, type, mode) {
  const teams = Object.values(data.teams).filter(t => t.mode === mode && t.type === type);
  teams.sort((a, b) => b.rating - a.rating);
  const lines = teams.length === 0
    ? ['No matches recorded yet.']
    : teams.slice(0, 15).map((t, i) => `**${i + 1}.** ${teamLabel(t)} — ${t.rating} (${t.wins}W-${t.losses}L)`);
  return new EmbedBuilder()
    .setTitle(`🏐 ${typeLabel[type]} ${mode} leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0xff5c39)
    .setFooter({ text: 'Updates automatically after every match' })
    .setTimestamp();
}

async function refreshLiveLeaderboards(guild, type, mode) {
  const data = loadData();
  const entry = data.liveLeaderboards[`${type}:${mode}`];
  if (!entry) return;
  const channel = await guild.channels.fetch(entry.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(entry.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [buildLeaderboardEmbed(data, type, mode)] }).catch(() => {});
}

async function postModLog(guild, embed) {
  const data = loadData();
  if (!data.modLogChannelId) return;
  const channel = await guild.channels.fetch(data.modLogChannelId).catch(() => null);
  if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
}

async function finalizeMatch(guild, matchId, winner) {
  const data = loadData();
  const match = data.matches[matchId];
  if (!match || match.resolved) return;

  const teamA = data.teams[match.teamAKey];
  const teamB = data.teams[match.teamBKey];

  match.snapshot = {
    teamA: { rating: teamA.rating, wins: teamA.wins, losses: teamA.losses, streak: teamA.streak || 0 },
    teamB: { rating: teamB.rating, wins: teamB.wins, losses: teamB.losses, streak: teamB.streak || 0 }
  };

  const result = newRatings(teamA.rating, teamB.rating, winner);
  teamA.rating = result.ratingA;
  teamB.rating = result.ratingB;
  if (winner === 'A') {
    teamA.wins++; teamB.losses++;
    teamA.streak = (teamA.streak || 0) > 0 ? teamA.streak + 1 : 1;
    teamB.streak = (teamB.streak || 0) < 0 ? teamB.streak - 1 : -1;
  } else {
    teamB.wins++; teamA.losses++;
    teamB.streak = (teamB.streak || 0) > 0 ? teamB.streak + 1 : 1;
    teamA.streak = (teamA.streak || 0) < 0 ? teamA.streak - 1 : -1;
  }

  match.resolved = true;
  match.winner = winner;
  match.deltaA = result.deltaA;
  match.deltaB = result.deltaB;
  match.deltaWinner = winner === 'A' ? result.deltaA : result.deltaB;

  // Tournament matches: winner stays queued for the next round, loser is eliminated.
  // Scrim matches: both teams already left the queue when matched, nobody re-enters.
  if (match.type === 'tournament') {
    const winningKey = winner === 'A' ? match.teamAKey : match.teamBKey;
    if (!data.queues.tournament[match.mode].includes(winningKey)) {
      data.queues.tournament[match.mode].push(winningKey);
    }
  }
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
        `Run /closechannel here when you're done.`
      )
      .setColor(0x1D9E75);
    await channel.send({ embeds: [embed] });
  }

  await refreshLiveLeaderboards(guild, match.type, match.mode);
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

async function runRound(interaction, data, type, mode) {
  const waiting = [...data.queues[type][mode]];
  if (waiting.length < 2) {
    await interaction.reply({ content: `Not enough teams waiting in the ${typeLabel[type]} ${mode} queue.`, ephemeral: true });
    return;
  }

  for (let i = waiting.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [waiting[i], waiting[j]] = [waiting[j], waiting[i]];
  }

  let byeKey = null;
  if (waiting.length % 2 === 1) byeKey = waiting.pop();

  const recentPairs = Object.entries(data.matches)
    .filter(([, m]) => m.mode === mode && m.type === type)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, waiting.length)
    .map(([, m]) => [m.teamAKey, m.teamBKey].sort().join('|'));

  const pairs = [];
  for (let i = 0; i < waiting.length; i += 2) pairs.push([waiting[i], waiting[i + 1]]);
  for (let i = 0; i < pairs.length - 1; i++) {
    const key = [pairs[i][0], pairs[i][1]].sort().join('|');
    if (recentPairs.includes(key)) {
      [pairs[i][1], pairs[i + 1][1]] = [pairs[i + 1][1], pairs[i][1]];
    }
  }

  data.queues[type][mode] = byeKey ? [byeKey] : [];
  saveData(data);

  const guild = interaction.guild;
  const createdChannels = [];
  const roundId = `${Date.now()}`;
  const roundPairs = [];
  for (const [teamAKey, teamBKey] of pairs) {
    const teamA = data.teams[teamAKey];
    const teamB = data.teams[teamBKey];
    const matchId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

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

    data.matches[matchId] = { type, mode, teamAKey, teamBKey, channelId: channel.id, votes: {}, resolved: false, roundId };
    roundPairs.push({ matchId, teamAKey, teamBKey });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote_${matchId}_A`).setLabel('Team A won').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vote_${matchId}_B`).setLabel('Team B won').setStyle(ButtonStyle.Danger)
    );
    const note = type === 'tournament'
      ? 'Loser is eliminated from the queue. Winner stays queued for the next round.'
      : 'This is a ranked match — both teams leave the queue once voting is done.';
    const embed = new EmbedBuilder()
      .setTitle(`${typeLabel[type]} ${mode} match`)
      .setDescription(`**Team A:** ${teamLabel(teamA)} (${teamA.rating})\n**Team B:** ${teamLabel(teamB)} (${teamB.rating})\n\n${note}\n\nAll players vote for the winner below.`)
      .setColor(0x378ADD)
      .setFooter({ text: `Match ID: ${matchId}` });
    await channel.send({ content: [...teamA.players, ...teamB.players].map(id => `<@${id}>`).join(' '), embeds: [embed], components: [row] });
    createdChannels.push(channel);

    for (const playerId of [...teamA.players, ...teamB.players]) {
      const member = await guild.members.fetch(playerId).catch(() => null);
      if (member) await member.send(`Your ${typeLabel[type]} ${mode} match is ready: ${channel} in **${guild.name}**.`).catch(() => {});
    }
  }
  data.rounds[type][mode].push({ roundId, pairs: roundPairs, byeKey });
  saveData(data);

  let summary = `**${typeLabel[type]} round started (${mode}):** ${pairs.length} match(es) created.\n` + createdChannels.map(c => `${c}`).join(' ');
  if (byeKey) summary += `\n\n${teamLabel(data.teams[byeKey])} received a bye and stays in the queue for the next round.`;
  await interaction.reply(summary);
}

async function handleCommand(interaction) {
  const { commandName } = interaction;
  const data = loadData();

  if (commandName === 'queue') {
    const type = interaction.options.getString('type');
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

    const { key } = getOrCreateTeam(data, type, mode, players);
    if (data.queues[type][mode].includes(key)) {
      await interaction.reply({ content: 'Your team is already in this queue.', ephemeral: true });
      return;
    }
    data.queues[type][mode].push(key);
    saveData(data);
    await interaction.reply(`Team ${players.map(id => `<@${id}>`).join(' & ')} joined the **${typeLabel[type]} ${mode}** queue.`);
  }

  else if (commandName === 'leavequeue') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const before = data.queues[type][mode].length;
    data.queues[type][mode] = data.queues[type][mode].filter(key => !data.teams[key].players.includes(interaction.user.id));
    saveData(data);
    if (data.queues[type][mode].length < before) {
      await interaction.reply('Your team left the queue.');
    } else {
      await interaction.reply({ content: 'Your team was not in that queue.', ephemeral: true });
    }
  }

  else if (commandName === 'queuelist') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const keys = data.queues[type][mode];
    if (!keys || keys.length === 0) {
      await interaction.reply(`No teams currently waiting in the ${typeLabel[type]} ${mode} queue.`);
      return;
    }
    const lines = keys.map((key, i) => `**${i + 1}.** ${teamLabel(data.teams[key])} (${data.teams[key].rating})`);
    const embed = new EmbedBuilder().setTitle(`${typeLabel[type]} ${mode} queue — ${keys.length} team(s) waiting`).setDescription(lines.join('\n')).setColor(0x378ADD);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'startqueue') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Only admins can start a round.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    await runRound(interaction, data, type, mode);
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

  else if (commandName === 'kickqueue') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const player = interaction.options.getUser('player');
    const before = data.queues[type][mode].length;
    let removedTeam = null;
    data.queues[type][mode] = data.queues[type][mode].filter(key => {
      const team = data.teams[key];
      if (team.players.includes(player.id)) { removedTeam = team; return false; }
      return true;
    });
    if (data.queues[type][mode].length === before) {
      await interaction.reply({ content: `${player} is not on a team in the ${typeLabel[type]} ${mode} queue.`, ephemeral: true });
      return;
    }
    saveData(data);
    await interaction.reply(`Removed team ${teamLabel(removedTeam)} from the ${typeLabel[type]} ${mode} queue.`);
  }

  else if (commandName === 'editteam') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const oldPlayer = interaction.options.getUser('oldplayer');
    const newPlayer = interaction.options.getUser('newplayer');

    const oldKey = data.queues[type][mode].find(key => data.teams[key].players.includes(oldPlayer.id));
    if (!oldKey) {
      await interaction.reply({ content: `${oldPlayer} is not on a team currently in the ${typeLabel[type]} ${mode} queue.`, ephemeral: true });
      return;
    }
    const oldTeam = data.teams[oldKey];
    if (oldTeam.players.includes(newPlayer.id)) {
      await interaction.reply({ content: `${newPlayer} is already on that team.`, ephemeral: true });
      return;
    }
    const newPlayers = oldTeam.players.map(id => (id === oldPlayer.id ? newPlayer.id : id));
    const { key: newKey } = getOrCreateTeam(data, type, mode, newPlayers);
    data.queues[type][mode] = data.queues[type][mode].map(key => (key === oldKey ? newKey : key));
    saveData(data);
    await interaction.reply(`Updated team in the ${typeLabel[type]} ${mode} queue: ${teamLabel(data.teams[newKey])} (swapped ${oldPlayer} for ${newPlayer}).`);
  }

  else if (commandName === 'forcequeue') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const size = teamSize[mode];
    const players = [interaction.options.getUser('player1').id];
    const p2 = interaction.options.getUser('player2');
    const p3 = interaction.options.getUser('player3');
    if (p2) players.push(p2.id);
    if (p3) players.push(p3.id);

    if (players.length !== size) {
      await interaction.reply({ content: `${mode} needs exactly ${size} player(s). You provided ${players.length}.`, ephemeral: true });
      return;
    }
    const { key } = getOrCreateTeam(data, type, mode, players);
    if (data.queues[type][mode].includes(key)) {
      await interaction.reply({ content: 'That team is already in this queue.', ephemeral: true });
      return;
    }
    data.queues[type][mode].push(key);
    saveData(data);
    await interaction.reply(`Added team ${players.map(id => `<@${id}>`).join(' & ')} to the ${typeLabel[type]} ${mode} queue.`);
  }

  else if (commandName === 'cancelmatch') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const matchId = interaction.options.getString('matchid');
    const match = data.matches[matchId];
    if (!match) {
      await interaction.reply({ content: 'No match found with that ID.', ephemeral: true });
      return;
    }
    if (match.resolved) {
      await interaction.reply({ content: 'That match is already resolved, cannot cancel.', ephemeral: true });
      return;
    }
    delete data.matches[matchId];
    if (!data.queues[match.type][match.mode].includes(match.teamAKey)) data.queues[match.type][match.mode].push(match.teamAKey);
    if (!data.queues[match.type][match.mode].includes(match.teamBKey)) data.queues[match.type][match.mode].push(match.teamBKey);
    saveData(data);
    await interaction.reply(`Match ${matchId} cancelled. No ratings were changed, both teams are back in the ${typeLabel[match.type]} ${match.mode} queue.`);
    const channel = await interaction.guild.channels.fetch(match.channelId).catch(() => null);
    if (channel) await channel.send('This match has been cancelled by an admin. Run `/closechannel` to archive this channel.').catch(() => {});
  }

  else if (commandName === 'seasonreset') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    for (const key in data.teams) {
      data.teams[key].rating = BASE_RATING;
      data.teams[key].wins = 0;
      data.teams[key].losses = 0;
      data.teams[key].streak = 0;
    }
    saveData(data);
    for (const type of ['tournament', 'ranked']) {
      for (const mode of ['1v1', '2v2', '3v3']) {
        await refreshLiveLeaderboards(interaction.guild, type, mode);
      }
    }
    await interaction.reply('Season reset. All ratings are back to 1000, win/loss/streak cleared. Match history is preserved.');
  }

  else if (commandName === 'lock') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }).catch(() => {});
    await interaction.reply('🔒 Channel locked. Only admins can send messages now.');
  }

  else if (commandName === 'unlock') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null }).catch(() => {});
    await interaction.reply('🔓 Channel unlocked.');
  }

  else if (commandName === 'closechannel') {
    const match = Object.values(data.matches).find(m => m.channelId === interaction.channel.id);
    if (!match) {
      await interaction.reply({ content: 'This is not a match channel.', ephemeral: true });
      return;
    }
    const guild = interaction.guild;
    let category = data.archiveCategoryId ? await guild.channels.fetch(data.archiveCategoryId).catch(() => null) : null;
    if (!category) {
      category = await guild.channels.create({ name: '📁 Archived Matches', type: ChannelType.GuildCategory }).catch(() => null);
      if (category) data.archiveCategoryId = category.id;
    }
    if (category) await interaction.channel.setParent(category.id, { lockPermissions: false }).catch(() => {});
    for (const overwrite of interaction.channel.permissionOverwrites.cache.values()) {
      if (overwrite.id !== guild.roles.everyone.id) {
        await interaction.channel.permissionOverwrites.edit(overwrite.id, { SendMessages: false }).catch(() => {});
      }
    }
    saveData(data);
    await interaction.reply('This match channel has been archived (read-only, moved out of the way). Admins can delete it manually if needed.');
  }

  else if (commandName === 'leaderboard') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    await interaction.reply({ embeds: [buildLeaderboardEmbed(data, type, mode)] });
  }

  else if (commandName === 'stats') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const players = [interaction.options.getUser('player1').id];
    const p2 = interaction.options.getUser('player2');
    const p3 = interaction.options.getUser('player3');
    if (p2) players.push(p2.id);
    if (p3) players.push(p3.id);

    const key = teamKey(type, mode, players);
    const team = data.teams[key];
    if (!team) {
      await interaction.reply({ content: 'No record found for that team.', ephemeral: true });
      return;
    }
    const rank = getRankForRating(team.rating);
    const streakText = team.streak > 0 ? `${team.streak}-game win streak` : team.streak < 0 ? `${Math.abs(team.streak)}-game losing streak` : 'No active streak';
    const embed = new EmbedBuilder()
      .setTitle(`${teamLabel(team)} — ${typeLabel[type]} ${mode}`)
      .setDescription(`Rating: **${team.rating}**\nRank: ${roleName(rank)}\nRecord: ${team.wins}W - ${team.losses}L\n${streakText}`)
      .setColor(0x1D9E75);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'profile') {
    const user = interaction.options.getUser('user') || interaction.user;
    const lines = [];
    for (const type of ['tournament', 'ranked']) {
      for (const mode of ['1v1', '2v2', '3v3']) {
        const teams = Object.values(data.teams).filter(t => t.mode === mode && t.type === type && t.players.includes(user.id));
        teams.sort((a, b) => b.rating - a.rating);
        for (const t of teams) {
          lines.push(`**${typeLabel[type]} ${mode}** — ${teamLabel(t)}: ${t.rating} (${t.wins}W-${t.losses}L)`);
        }
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
    const embed = new EmbedBuilder().setTitle(`${user.username}'s profile`).setDescription(`Rank: ${roleName(rank)}\n\n${lines.join('\n')}`).setColor(0x1D9E75);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'matchhistory') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const players = [interaction.options.getUser('player1').id];
    const p2 = interaction.options.getUser('player2');
    const p3 = interaction.options.getUser('player3');
    if (p2) players.push(p2.id);
    if (p3) players.push(p3.id);
    const key = teamKey(type, mode, players);

    const relevant = Object.entries(data.matches)
      .filter(([, m]) => m.resolved && (m.teamAKey === key || m.teamBKey === key))
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 10);

    if (relevant.length === 0) {
      await interaction.reply({ content: 'No match history found for that team.', ephemeral: true });
      return;
    }
    const lines = relevant.map(([, m]) => {
      const isA = m.teamAKey === key;
      const opponentKey = isA ? m.teamBKey : m.teamAKey;
      const opponent = data.teams[opponentKey];
      const won = (isA && m.winner === 'A') || (!isA && m.winner === 'B');
      const delta = isA ? m.deltaA : m.deltaB;
      return `${won ? '✅ Won' : '❌ Lost'} vs ${opponent ? teamLabel(opponent) : 'unknown team'} (${delta >= 0 ? '+' : ''}${delta ?? 0})`;
    });
    const embed = new EmbedBuilder().setTitle(`Match history — ${teamLabel(data.teams[key] || { players })}`).setDescription(lines.join('\n')).setColor(0x9b59b6);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'topplayers') {
    const type = interaction.options.getString('type');
    const highestByPlayer = {};
    for (const key in data.teams) {
      const t = data.teams[key];
      if (t.type !== type) continue;
      for (const playerId of t.players) {
        if (!highestByPlayer[playerId] || t.rating > highestByPlayer[playerId]) highestByPlayer[playerId] = t.rating;
      }
    }
    const entries = Object.entries(highestByPlayer).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (entries.length === 0) {
      await interaction.reply(`No ${typeLabel[type]} matches recorded yet.`);
      return;
    }
    const lines = entries.map(([id, rating], i) => `**${i + 1}.** <@${id}> — ${rating} (${roleName(getRankForRating(rating))})`);
    const embed = new EmbedBuilder().setTitle(`Top ${typeLabel[type]} players (by highest rating)`).setDescription(lines.join('\n')).setColor(0xff5c39);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'currentround') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const active = Object.entries(data.matches).filter(([, m]) => m.type === type && m.mode === mode && !m.resolved);
    if (active.length === 0) {
      await interaction.reply(`No matches currently in progress for ${typeLabel[type]} ${mode}.`);
      return;
    }
    const lines = active.map(([id, m]) => {
      const teamA = data.teams[m.teamAKey];
      const teamB = data.teams[m.teamBKey];
      const votesCast = Object.keys(m.votes).length;
      const totalPlayers = teamA.players.length + teamB.players.length;
      return `${teamLabel(teamA)} vs ${teamLabel(teamB)} — <#${m.channelId}> (${votesCast}/${totalPlayers} votes)`;
    });
    const embed = new EmbedBuilder().setTitle(`${typeLabel[type]} ${mode} — matches in progress`).setDescription(lines.join('\n')).setColor(0x378ADD);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'bracket') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const rounds = data.rounds[type][mode];
    if (!rounds || rounds.length === 0) {
      await interaction.reply(`No rounds have been started yet for ${typeLabel[type]} ${mode}.`);
      return;
    }
    const lines = [];
    rounds.slice(-6).forEach((round, i) => {
      lines.push(`**Round ${rounds.length - Math.min(6, rounds.length) + i + 1}**`);
      for (const pair of round.pairs) {
        const m = data.matches[pair.matchId];
        const teamA = data.teams[pair.teamAKey];
        const teamB = data.teams[pair.teamBKey];
        if (!m || !m.resolved) {
          lines.push(`⏳ ${teamLabel(teamA)} vs ${teamLabel(teamB)} — in progress`);
        } else {
          const winnerLabel = m.winner === 'A' ? teamLabel(teamA) : teamLabel(teamB);
          lines.push(`✅ ${teamLabel(teamA)} vs ${teamLabel(teamB)} — won by ${winnerLabel}`);
        }
      }
      if (round.byeKey && data.teams[round.byeKey]) {
        lines.push(`🎟️ Bye: ${teamLabel(data.teams[round.byeKey])}`);
      }
    });
    const embed = new EmbedBuilder().setTitle(`${typeLabel[type]} ${mode} — bracket history`).setDescription(lines.join('\n').slice(0, 4000)).setColor(0x9b59b6);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'headtohead') {
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const teamAPlayers = [interaction.options.getUser('a1').id];
    const a2 = interaction.options.getUser('a2');
    const a3 = interaction.options.getUser('a3');
    if (a2) teamAPlayers.push(a2.id);
    if (a3) teamAPlayers.push(a3.id);
    const teamBPlayers = [interaction.options.getUser('b1').id];
    const b2 = interaction.options.getUser('b2');
    const b3 = interaction.options.getUser('b3');
    if (b2) teamBPlayers.push(b2.id);
    if (b3) teamBPlayers.push(b3.id);

    const keyA = teamKey(type, mode, teamAPlayers);
    const keyB = teamKey(type, mode, teamBPlayers);

    const matches = Object.values(data.matches).filter(m =>
      m.resolved && m.type === type && m.mode === mode &&
      ((m.teamAKey === keyA && m.teamBKey === keyB) || (m.teamAKey === keyB && m.teamBKey === keyA))
    );
    if (matches.length === 0) {
      await interaction.reply('These two teams have not played each other yet.');
      return;
    }
    let winsA = 0, winsB = 0;
    for (const m of matches) {
      const aWon = (m.teamAKey === keyA && m.winner === 'A') || (m.teamBKey === keyA && m.winner === 'B');
      if (aWon) winsA++; else winsB++;
    }
    const embed = new EmbedBuilder()
      .setTitle(`Head to head — ${typeLabel[type]} ${mode}`)
      .setDescription(`${teamAPlayers.map(id => `<@${id}>`).join(' & ')}: **${winsA}** wins\n${teamBPlayers.map(id => `<@${id}>`).join(' & ')}: **${winsB}** wins\n\nTotal matches: ${matches.length}`)
      .setColor(0x9b59b6);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'mvp') {
    const allMatches = Object.entries(data.matches).filter(([, m]) => m.resolved && typeof m.deltaWinner === 'number');
    allMatches.sort((a, b) => b[1].deltaWinner - a[1].deltaWinner);
    const top = allMatches.slice(0, 10);
    if (top.length === 0) {
      await interaction.reply('No resolved matches yet.');
      return;
    }
    const lines = top.map(([, m]) => {
      const winnerKey = m.winner === 'A' ? m.teamAKey : m.teamBKey;
      const team = data.teams[winnerKey];
      return `+${m.deltaWinner} — ${team ? teamLabel(team) : 'unknown team'} (${typeLabel[m.type]} ${m.mode})`;
    });
    const embed = new EmbedBuilder().setTitle('🏆 Biggest single-match rating gains').setDescription(lines.join('\n')).setColor(0xffd700);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'undo') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    let matchId = interaction.options.getString('matchid');
    if (!matchId) {
      const resolved = Object.entries(data.matches).filter(([, m]) => m.resolved).sort((a, b) => b[0].localeCompare(a[0]));
      if (resolved.length === 0) {
        await interaction.reply({ content: 'No resolved matches to undo.', ephemeral: true });
        return;
      }
      matchId = resolved[0][0];
    }
    const match = data.matches[matchId];
    if (!match || !match.resolved || !match.snapshot) {
      await interaction.reply({ content: 'That match cannot be undone (not found, not resolved, or too old).', ephemeral: true });
      return;
    }
    const teamA = data.teams[match.teamAKey];
    const teamB = data.teams[match.teamBKey];
    Object.assign(teamA, match.snapshot.teamA);
    Object.assign(teamB, match.snapshot.teamB);

    if (match.type === 'tournament') {
      const winningKey = match.winner === 'A' ? match.teamAKey : match.teamBKey;
      data.queues.tournament[match.mode] = data.queues.tournament[match.mode].filter(k => k !== winningKey);
    }
    match.resolved = false;
    delete match.winner;
    delete match.snapshot;
    delete match.deltaA;
    delete match.deltaB;
    delete match.deltaWinner;
    saveData(data);
    await refreshLiveLeaderboards(interaction.guild, match.type, match.mode);
    await interaction.reply(`Match ${matchId} undone. Ratings, wins/losses, and streaks reverted for both teams.`);
  }

  else if (commandName === 'announce') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const message = interaction.options.getString('message');
    const everyone = interaction.options.getBoolean('everyone');
    const embed = new EmbedBuilder().setTitle('📢 Announcement').setDescription(message).setColor(0x378ADD).setTimestamp();
    await interaction.reply({ content: everyone ? '@everyone' : undefined, embeds: [embed] });
  }

  else if (commandName === 'coinflip') {
    const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
    await interaction.reply(`🪙 ${result}!`);
  }

  else if (commandName === 'setleaderboard') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const embed = buildLeaderboardEmbed(data, type, mode);
    await interaction.reply({ embeds: [embed] });
    const sentMessage = await interaction.fetchReply();
    data.liveLeaderboards[`${type}:${mode}`] = { channelId: interaction.channel.id, messageId: sentMessage.id };
    saveData(data);
    await interaction.followUp({ content: `This message will now auto-update whenever ${typeLabel[type]} ${mode} ratings change.`, ephemeral: true });
  }

  else if (commandName === 'removeleaderboard') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Admins only.', ephemeral: true });
      return;
    }
    const type = interaction.options.getString('type');
    const mode = interaction.options.getString('mode');
    const dataKey = `${type}:${mode}`;
    if (!data.liveLeaderboards[dataKey]) {
      await interaction.reply({ content: `No live leaderboard is set for ${typeLabel[type]} ${mode}.`, ephemeral: true });
      return;
    }
    delete data.liveLeaderboards[dataKey];
    saveData(data);
    await interaction.reply(`Live leaderboard for ${typeLabel[type]} ${mode} disabled. The old message will stay but stop updating.`);
  }

  else if (commandName === 'rank') {
    const user = interaction.options.getUser('user') || interaction.user;
    let highest = BASE_RATING;
    let hasPlayed = false;
    for (const key in data.teams) {
      const t = data.teams[key];
      if (t.players.includes(user.id)) {
        hasPlayed = true;
        if (t.rating > highest) highest = t.rating;
      }
    }
    if (!hasPlayed) {
      await interaction.reply(`${user.username} has no recorded matches yet.`);
      return;
    }
    const currentRank = getRankForRating(highest);
    const currentIndex = RANKS.findIndex(r => r.name === currentRank.name);
    const nextRank = RANKS[currentIndex + 1];

    let description = `Highest rating: **${highest}**\nCurrent rank: ${roleName(currentRank)}`;
    if (nextRank) {
      const pointsNeeded = nextRank.min - highest;
      description += `\nNext rank: ${roleName(nextRank)} at ${nextRank.min}\n**${pointsNeeded} points to go**`;
    } else {
      description += `\n🏆 Highest possible rank reached.`;
    }
    const embed = new EmbedBuilder().setTitle(`${user.username}'s rank`).setDescription(description).setColor(0x1D9E75);
    await interaction.reply({ embeds: [embed] });
  }

  else if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🏐 Volleyball ELO Bot — Commands')
      .setColor(0x378ADD)
      .addFields(
        { name: 'Queueing', value: '`/queue` `/leavequeue` `/queuelist`' },
        { name: 'Matches (Admin)', value: '`/startqueue` `/resolve` `/kickqueue` `/editteam` `/forcequeue` `/cancelmatch` `/seasonreset` `/undo`' },
        { name: 'Matches (Everyone)', value: '`/closechannel`' },
        { name: 'Stats', value: '`/leaderboard` `/stats` `/profile` `/matchhistory` `/topplayers` `/headtohead` `/mvp` `/currentround` `/bracket` `/rank`' },
        { name: 'Live Leaderboards (Admin)', value: '`/setleaderboard` `/removeleaderboard`' },
        { name: 'Fun', value: '`/coinflip`' },
        { name: 'Moderation (Admin)', value: '`/clear` `/mute` `/unmute` `/kick` `/ban` `/unban` `/warn` `/warnings` `/lock` `/unlock` `/announce` `/setmodlog`' }
      );
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member muted').setColor(0xf5a623)
      .setDescription(`**User:** ${user}\n**Duration:** ${minutes} min\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`));
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member unmuted').setColor(0x4ade80)
      .setDescription(`**User:** ${user}\n**Moderator:** ${interaction.user}`));
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member kicked').setColor(0xf87171)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`));
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member banned').setColor(0xdc2626)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}`));
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member unbanned').setColor(0x4ade80)
      .setDescription(`**User ID:** ${userId}\n**Moderator:** ${interaction.user}`));
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
    await postModLog(interaction.guild, new EmbedBuilder().setTitle('Member warned').setColor(0xf5a623)
      .setDescription(`**User:** ${user}\n**Reason:** ${reason}\n**Moderator:** ${interaction.user}\n**Total warnings:** ${data.warnings[user.id].length}`));
  }

  else if (commandName === 'warnings') {
    const user = interaction.options.getUser('user');
    const list = data.warnings[user.id] || [];
    if (list.length === 0) {
      await interaction.reply(`${user} has no warnings.`);
      return;
    }
    const lines = list.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.moderatorId}> (${new Date(w.date).toLocaleDateString()})`);
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Warnings for ${user.username}`).setDescription(lines.join('\n')).setColor(0xf5a623)] });
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
    await interaction.reply(`Votes are split. ${pings} please resolve with \`/resolve matchid:${matchId} winner:A\` or \`winner:B\`.`);
  }
}

client.login(process.env.DISCORD_TOKEN);
