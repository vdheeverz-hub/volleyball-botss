const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function emptyQueues() {
  return {
    tournament: { '1v1': [], '2v2': [], '3v3': [] },
    ranked: { '1v1': [], '2v2': [], '3v3': [] }
  };
}

function loadData() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      teams: {},             // key: "type:mode:sortedPlayerIds" -> { rating, wins, losses, streak, players, mode, type }
      queues: emptyQueues(),
      matches: {},            // key: matchId -> match record
      rounds: {
        tournament: { '1v1': [], '2v2': [], '3v3': [] },
        ranked: { '1v1': [], '2v2': [], '3v3': [] }
      },
      warnings: {},
      modLogChannelId: null,
      liveLeaderboards: {},   // key: "type:mode" -> { channelId, messageId }
      archiveCategoryId: null
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!data.teams) data.teams = {};
  if (!data.queues) data.queues = emptyQueues();
  if (!data.queues.tournament) data.queues.tournament = { '1v1': [], '2v2': [], '3v3': [] };
  if (!data.queues.ranked) data.queues.ranked = { '1v1': [], '2v2': [], '3v3': [] };
  if (!data.matches) data.matches = {};
  if (!data.rounds) data.rounds = { tournament: { '1v1': [], '2v2': [], '3v3': [] }, ranked: { '1v1': [], '2v2': [], '3v3': [] } };
  if (!data.warnings) data.warnings = {};
  if (data.modLogChannelId === undefined) data.modLogChannelId = null;
  if (!data.liveLeaderboards) data.liveLeaderboards = {};
  if (data.archiveCategoryId === undefined) data.archiveCategoryId = null;
  return data;
}

function saveData(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Simple async lock so overlapping commands/buttons never read-modify-write
// the data file at the same time (which was causing lost/missing matches
// whenever two queues or matches were active simultaneously).
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(() => fn());
  lockChain = run.then(() => {}, () => {});
  return run;
}

module.exports = { loadData, saveData, withLock };
