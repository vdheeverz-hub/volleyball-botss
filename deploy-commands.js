const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const modeChoices = opt => opt.addChoices(
  { name: '1v1', value: '1v1' },
  { name: '2v2', value: '2v2' },
  { name: '3v3', value: '3v3' }
);
const typeChoices = opt => opt.addChoices(
  { name: 'Tournament', value: 'tournament' },
  { name: 'Ranked', value: 'ranked' }
);

const commands = [
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Queue your team for a match')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('partner1').setDescription('Teammate 1 (required for 2v2/3v3)'))
    .addUserOption(opt => opt.setName('partner2').setDescription('Teammate 2 (required for 3v3)')),

  new SlashCommandBuilder()
    .setName('leavequeue')
    .setDescription('Leave the queue for a mode')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true))),

  new SlashCommandBuilder()
    .setName('queuelist')
    .setDescription('See which teams are currently waiting in a queue')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true))),

  new SlashCommandBuilder()
    .setName('startqueue')
    .setDescription('(Admin) Start a round: pairs up every waiting team, handles byes')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('(Admin) Resolve a disputed match')
    .addStringOption(opt => opt.setName('matchid').setDescription('Match ID').setRequired(true))
    .addStringOption(opt =>
      opt.setName('winner').setDescription('Which team won').setRequired(true)
        .addChoices({ name: 'Team A', value: 'A' }, { name: 'Team B', value: 'B' }))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('kickqueue')
    .setDescription('(Admin) Remove a team from a queue')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('player').setDescription('Any player on the team to remove').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('editteam')
    .setDescription('(Admin) Swap a player on a queued team for someone else')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('oldplayer').setDescription('Player currently on the team').setRequired(true))
    .addUserOption(opt => opt.setName('newplayer').setDescription('Player to replace them with').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('forcequeue')
    .setDescription('(Admin) Manually add a team to a queue')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('player1').setDescription('First player').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Second player (if 2v2/3v3)'))
    .addUserOption(opt => opt.setName('player3').setDescription('Third player (if 3v3)'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('cancelmatch')
    .setDescription('(Admin) Cancel a match without affecting ELO')
    .addStringOption(opt => opt.setName('matchid').setDescription('Match ID').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('seasonreset')
    .setDescription('(Admin) Reset all ratings back to 1000, keeping history')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('(Admin) Lock the current channel so only admins can send messages')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('(Admin) Unlock the current channel')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('closechannel')
    .setDescription('Archive the current match channel'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the leaderboard for a mode')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true))),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View a team\'s rating and record')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('player1').setDescription('First player').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Second player (if 2v2/3v3)'))
    .addUserOption(opt => opt.setName('player3').setDescription('Third player (if 3v3)')),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a player\'s teams, ranks, and records across all modes and types')
    .addUserOption(opt => opt.setName('user').setDescription('Player to check (defaults to you)')),

  new SlashCommandBuilder()
    .setName('matchhistory')
    .setDescription('View a team\'s past match results')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('player1').setDescription('First player').setRequired(true))
    .addUserOption(opt => opt.setName('player2').setDescription('Second player (if 2v2/3v3)'))
    .addUserOption(opt => opt.setName('player3').setDescription('Third player (if 3v3)')),

  new SlashCommandBuilder()
    .setName('topplayers')
    .setDescription('View individual player rankings by their highest rating')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true))),

  new SlashCommandBuilder()
    .setName('currentround')
    .setDescription('View all matches still in progress for a mode')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true))),

  new SlashCommandBuilder()
    .setName('bracket')
    .setDescription('View the round-by-round history for a mode')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true))),

  new SlashCommandBuilder()
    .setName('headtohead')
    .setDescription('View the historical record between two specific teams')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .addUserOption(opt => opt.setName('a1').setDescription('Team A - player 1').setRequired(true))
    .addUserOption(opt => opt.setName('b1').setDescription('Team B - player 1').setRequired(true))
    .addUserOption(opt => opt.setName('a2').setDescription('Team A - player 2 (if 2v2/3v3)'))
    .addUserOption(opt => opt.setName('a3').setDescription('Team A - player 3 (if 3v3)'))
    .addUserOption(opt => opt.setName('b2').setDescription('Team B - player 2 (if 2v2/3v3)'))
    .addUserOption(opt => opt.setName('b3').setDescription('Team B - player 3 (if 3v3)')),

  new SlashCommandBuilder()
    .setName('mvp')
    .setDescription('View the biggest single-match rating gains of all time'),

  new SlashCommandBuilder()
    .setName('undo')
    .setDescription('(Admin) Undo the most recently resolved match')
    .addStringOption(opt => opt.setName('matchid').setDescription('Specific match ID to undo (defaults to most recent)'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('(Admin) Post a formatted announcement')
    .addStringOption(opt => opt.setName('message').setDescription('Announcement text').setRequired(true))
    .addBooleanOption(opt => opt.setName('everyone').setDescription('Ping @everyone?'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin'),

  new SlashCommandBuilder()
    .setName('setleaderboard')
    .setDescription('(Admin) Post a live leaderboard in this channel that auto-updates')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('removeleaderboard')
    .setDescription('(Admin) Stop auto-updating the live leaderboard for a mode')
    .addStringOption(opt => typeChoices(opt.setName('type').setDescription('Tournament or ranked').setRequired(true)))
    .addStringOption(opt => modeChoices(opt.setName('mode').setDescription('Match mode').setRequired(true)))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('See your current rank and how far you are from the next one')
    .addUserOption(opt => opt.setName('user').setDescription('Player to check (defaults to you)')),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('List all bot commands'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('(Admin) Delete a number of recent messages')
    .addIntegerOption(opt => opt.setName('amount').setDescription('How many messages (1-100)').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('(Admin) Timeout a member')
    .addUserOption(opt => opt.setName('user').setDescription('User to mute').setRequired(true))
    .addIntegerOption(opt => opt.setName('minutes').setDescription('Duration in minutes').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('(Admin) Remove a member\'s timeout')
    .addUserOption(opt => opt.setName('user').setDescription('User to unmute').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('(Admin) Kick a member')
    .addUserOption(opt => opt.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('(Admin) Ban a member')
    .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('(Admin) Unban a user by ID')
    .addStringOption(opt => opt.setName('userid').setDescription('User ID to unban').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('(Admin) Warn a member')
    .addUserOption(opt => opt.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason').setRequired(true))
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View a member\'s warning history')
    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setmodlog')
    .setDescription('(Admin) Set this channel as the mod-log channel')
    .setDefaultMemberPermissions(0)
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Commands registered successfully.');
  } catch (err) {
    console.error(err);
  }
})();
