// =====================================================================
// DESIGN LOGIC START  (pure functions; no jsPsych dependency)
// =====================================================================
const TOPICS = [
  { id: 'health',        label: 'Health advice',       gloss: 'e.g., symptoms, medication, diet, whether to see a doctor' },
  { id: 'relationships', label: 'Relationship advice', gloss: 'e.g., dating, friendships, family conflict, whether to end a relationship' },
  { id: 'voting',        label: 'Voting advice',       gloss: 'e.g., which candidate, party or ballot measure to support' },
  { id: 'purchasing',    label: 'Purchasing advice',   gloss: 'e.g., what to buy, which product or brand, whether it is worth the price' }
];

// 16 sources. Add or remove entries here and every count below updates automatically.
const SOURCES = [
  { id: 'doctor',                 label: 'A doctor' },
  { id: 'lawyer',                 label: 'A lawyer' },
  { id: 'therapist',              label: 'A therapist' },
  { id: 'professor_teacher',      label: 'A professor or teacher' },
  { id: 'parent',                 label: 'A parent' },
  { id: 'friend',                 label: 'A friend' },
  { id: 'spouse',                 label: 'A spouse or partner' },
  { id: 'celebrity',              label: 'A favorite celebrity (e.g., an actor, musician, athlete)' },
  { id: 'podcaster',              label: 'A podcaster' },
  { id: 'politician',             label: 'A politician' },
  { id: 'journalist',             label: 'A journalist' },
  { id: 'influencer', label: 'An influencer' },
  { id: 'reddit_forum',           label: 'An online forum (e.g., Reddit)' },
  { id: 'social_media',           label: 'Social media posts (e.g., TikTok / Instagram post)' },
  { id: 'llm',                    label: 'An AI chatbot (e.g., ChatGPT, Claude, Gemini)' },
  { id: 'search_engine',          label: 'A search engine' }
];

const CONFIG = {
  // Design for an INDIVIDUAL-LEVEL map of all 20 items (4 topics + 16 sources).
  // Simulations (known 2-D map, ~80% choice agreement with it) gave a distance
  // correlation with the true map of ~0.7 at 120 trials, ~0.8 at 200, ~0.88 at 300
  // and ~0.92 at 400. Trial count matters far more than the mix. Pilot for timing.
  N_TRIALS: 400,        // scored trials per participant (repeats are added on top)
  MIX: { T1: 0.35,      // topic reference + 2 sources  (480 exist)
         T2: 0.15,      // source reference + 2 topics  (96 exist)
         T3A: 0.03,     // topic reference + 2 topics   (only 12 exist: all are used once)
         T3B: 0.47 },   // source reference + 2 sources (1,680 exist)
  BREAK_EVERY: 50,      // short break screen after every this-many trials
  HALFWAY_BREAK: true,  // extra "halfway there" break at the midpoint of the session
  NONE_WARN_RATE: 0.10, // flag / warn if "Neither / can't say" is chosen on more than this share of trials
  NONE_CHECK_EVERY: 25, // check the running rate after every this-many trials...
  NONE_MIN_TRIALS: 20,  // ...but only once at least this many trials are done
  NONE_MAX_WARNINGS: 3, // never show the warning more than this many times
  FAST_RT_MS: 1000,     // a response faster than this (ms) is flagged as too fast to have read the question
  FAST_MAX_WARNINGS: 6, // show the "too fast" feedback at most this many times per participant...
  FAST_MIN_GAP: 4,      // ...and not again within this many trials of the previous one
  FAST_FLAG_RATE: 0.15, // flag a participant in the export if more than this share of trials is too fast
  // Clauses appended to the similarity questions so "similar" has a clear meaning:
  SIM_QUALIFIER_SOURCE: ' as a source of advice',                              // source-reference (T3b)
  SIM_QUALIFIER_TOPIC: ', in terms of who you would trust to give that advice', // topic-reference (T3a)
  N_REPEATS: 20,        // repeated items, spread through the session, to estimate each person's consistency (and drift)
  // Attention checks ("catch" trials): the reference itself is one of the two options, so the
  // right answer is unambiguous. Same wording and layout as real similarity trials. They are
  // added on top of N_TRIALS and are never used to fit the map (sampleAlg = 'check').
  N_CATCH: 12,          // total catch trials per participant
  N_CATCH_TOPIC: 0,     // how many use a topic as the reference (0: catches are source-reference only, which reads naturally)
  CATCH_MAX_WRONG: 0.2, // flag a participant if more than this share of catch trials is wrong (tripletTools default)
  // tripletTools stops fitting when loss on held-out trials stops improving, so the export must
  // contain train AND test rows. This share of usable trials is labelled 'test' when the data are saved
  // (you can re-split later with tripletTools' assign_sample_sets()).
  TEST_PROP: 0.1,
  SAVE_URL: null,       // e.g. 'https://example.org/save'; null = download CSV at the end
  FILENAME_PREFIX: 'trust_triplets'
};

const TOPIC = Object.fromEntries(TOPICS.map(d => [d.id, d]));
const SRC = Object.fromEntries(SOURCES.map(s => [s.id, s]));

// One joint item set for embedding (topics first, then sources).
// ITEM_INDEX gives the 0-based numeric ids used in head/winner/loser
// (matches items.csv).
const ITEM_IDS = [...TOPICS.map(d => d.id), ...SOURCES.map(s => s.id)];
const ITEM_INDEX = Object.fromEntries(ITEM_IDS.map((id, i) => [id, i]));

function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [h, ...t] = arr;
  return [...combos(t, k - 1).map(c => [h, ...c]), ...combos(t, k)];
}

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

// Full triplet universe (same order and content as triplets.csv)
function buildAllTriplets() {
  const topicIds = TOPICS.map(d => d.id), srcIds = SOURCES.map(s => s.id);
  const T1 = [], T2 = [];
  topicIds.forEach(d => combos(srcIds, 2).forEach(([a, b]) =>
    T1.push({ type: 'T1', anchor: d, items: [a, b], members: [d, a, b], id: `T1|${d}|${a}|${b}` })));
  srcIds.forEach(s => combos(topicIds, 2).forEach(([a, b]) =>
    T2.push({ type: 'T2', anchor: s, items: [a, b], members: [s, a, b], id: `T2|${s}|${a}|${b}` })));
  // Similarity triplets: every 3-set yields 3 triplets (each member takes a turn as reference)
  const refTriplets = (type, ids) => combos(ids, 3).flatMap(c => c.map(r => {
    const opts = c.filter(x => x !== r);
    return { type, anchor: r, items: opts, members: c, id: `${type}|${r}|${opts[0]}|${opts[1]}` };
  }));
  const T3A = refTriplets('T3A', topicIds), T3B = refTriplets('T3B', srcIds);
  return { T1, T2, T3A, T3B };
}

// Greedy coverage-balanced sampling: prefer triplets whose items have been used least.
function greedyPick(cands, n, use) {
  const chosen = [], pool = cands.slice();
  while (chosen.length < n && pool.length) {
    let bi = -1, bs = Infinity;
    pool.forEach((c, i) => {
      const s = (c.members || c.items).reduce((acc, x) => acc + (use[x] || 0), 0) + Math.random() * 0.9;
      if (s < bs) { bs = s; bi = i; }
    });
    const pick = pool.splice(bi, 1)[0];
    chosen.push(pick);
    (pick.members || pick.items).forEach(x => { use[x] = (use[x] || 0) + 1; });
  }
  return chosen;
}

// Split a trial total across kinds by the mix (largest remainder), respecting pool sizes.
function allocate(total, mix, caps) {
  const keys = Object.keys(mix);
  const raw = keys.map(k => total * mix[k]);
  const out = Object.fromEntries(keys.map((k, i) => [k, Math.min(Math.floor(raw[i]), caps[k])]));
  let left = total - keys.reduce((acc, k) => acc + out[k], 0);
  const order = keys.map((k, i) => ({ k, frac: raw[i] - Math.floor(raw[i]) })).sort((x, y) => y.frac - x.frac);
  for (let i = 0; left > 0 && i < 1000; i++) {
    const k = order[i % order.length].k;
    if (out[k] < caps[k]) { out[k]++; left--; }
  }
  return out;
}

// Attention checks: the reference appears as one of its own two options. A correct answer is the
// identical option. tripletTools scores such rows as head == winner (correct) or head == loser (wrong).
// They use the similarity format, so the reference and options must be the same kind of item.
function makeCatchTrials(cfg) {
  const topicIds = TOPICS.map(d => d.id), srcIds = SOURCES.map(s => s.id);
  const nT = Math.min(cfg.N_CATCH_TOPIC, topicIds.length, cfg.N_CATCH);
  const nS = Math.min(cfg.N_CATCH - nT, srcIds.length);
  const make = (type, ids, k) => shuffle(ids).slice(0, k).map(a => {
    const distractor = shuffle(ids.filter(x => x !== a))[0];
    return { type, anchor: a, items: [a, distractor], members: [a, distractor],
             id: `CATCH|${a}|${a}|${distractor}`, is_repeat: false, is_catch: true };
  });
  return shuffle([...make('T3A', topicIds, nT), ...make('T3B', srcIds, nS)]);
}

// Spread catch trials evenly through the session (with a little jitter); the first lands early.
function insertCatch(seq, catches) {
  const L = seq.length, n = catches.length;
  catches.map((c, k) => ({ c, slot: Math.max(5, Math.round(((k + 0.5) / n) * L) + Math.floor(Math.random() * 7) - 3) }))
    .reverse()
    .forEach(({ c, slot }) => seq.splice(Math.min(slot, seq.length), 0, c));
  return seq;
}

function sampleDesign(all, cfg) {
  const caps = Object.fromEntries(Object.keys(cfg.MIX).map(k => [k, all[k].length]));
  const counts = allocate(cfg.N_TRIALS, cfg.MIX, caps);
  const use = {};   // shared item-usage counter: every item appears about equally often overall
  let main = [];
  ['T1', 'T2', 'T3A', 'T3B'].forEach(k => main.push(...greedyPick(all[k], counts[k], use)));
  main = shuffle(main).map(t => ({ ...t, is_repeat: false }));

  // Repeats: re-present some items at least ~15 trials after the original
  const seq = main.slice();
  shuffle(main).slice(0, cfg.N_REPEATS).forEach(orig => {
    const cur = seq.indexOf(orig);
    const lo = Math.min(cur + 15, seq.length);
    const pos = lo + Math.floor(Math.random() * (seq.length - lo + 1));
    seq.splice(pos, 0, { ...orig, is_repeat: true });
  });
  return insertCatch(seq, makeCatchTrials(cfg));
}
// =====================================================================
// DESIGN LOGIC END
// =====================================================================
