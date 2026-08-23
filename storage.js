const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      teams: {},       // key: "mode:sortedPlayerIds" -> { rating, wins, losses, players: [] }
      queues: {        // key: mode -> array of team keys waiting
        '1v1': [],
        '2v2': [],
        '3v3': []
      },
      matches: {},      // key: matchId -> { mode, teamAKey, teamBKey, channelId, votes: {}, resolved: bool }
      warnings: {},     // key: userId -> array of { reason, moderatorId, date }
      modLogChannelId: null
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!data.warnings) data.warnings = {};
  if (data.modLogChannelId === undefined) data.modLogChannelId = null;
  if (!data.queues) data.queues = { '1v1': [], '2v2': [], '3v3': [] };
  if (!data.matches) data.matches = {};
  if (!data.teams) data.teams = {};
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
  lockChain = run.then(() => {}, () => {}); // keep the chain alive even if fn() throws
  return run;
}

module.exports = { loadData, saveData, withLock };
