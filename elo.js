const BASE_RATING = 1000;
const K_FACTOR = 32;

const RANKS = [
  { name: 'Coal', min: 1000, emoji: '⚫' },
  { name: 'Quartz', min: 1150, emoji: '⬜' },
  { name: 'Iron', min: 1300, emoji: '🔩' },
  { name: 'Gold', min: 1450, emoji: '🟡' },
  { name: 'Emerald', min: 1600, emoji: '🟢' },
  { name: 'Subspace', min: 1750, emoji: '🌌' }
];

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function newRatings(ratingA, ratingB, winner) {
  const expA = expectedScore(ratingA, ratingB);
  const expB = 1 - expA;
  const scoreA = winner === 'A' ? 1 : 0;
  const scoreB = winner === 'B' ? 1 : 0;
  const deltaA = Math.round(K_FACTOR * (scoreA - expA));
  const deltaB = Math.round(K_FACTOR * (scoreB - expB));
  return {
    ratingA: ratingA + deltaA,
    ratingB: ratingB + deltaB,
    deltaA,
    deltaB
  };
}

function getRankForRating(rating) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (rating >= r.min) rank = r;
  }
  return rank;
}

function roleName(rank) {
  return `${rank.emoji} ${rank.name}`;
}

module.exports = { BASE_RATING, K_FACTOR, RANKS, expectedScore, newRatings, getRankForRating, roleName };
