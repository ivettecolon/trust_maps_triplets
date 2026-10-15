// ---------------------------------------------------------------------
// jsPsych setup
// ---------------------------------------------------------------------
const jsPsych = initJsPsych({
  show_progress_bar: true,
  auto_update_progress_bar: true,
  on_finish: () => saveData()
});

// Prolific passes these as URL variables:
//   https://.../trust_experiment.html?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
const prolificPid = jsPsych.data.getURLVariable('PROLIFIC_PID');
const studyId = jsPsych.data.getURLVariable('STUDY_ID');
const sessionId = jsPsych.data.getURLVariable('SESSION_ID');
const pid = prolificPid || jsPsych.data.getURLVariable('pid') ||
  ('anon_' + Math.random().toString(36).slice(2, 10));
jsPsych.data.addProperties({
  participant_id: pid, prolific_pid: prolificPid || null, study_id: studyId || null,
  session_id: sessionId || null, start_time: new Date().toISOString()
});

// Testing version: 20 triplet trials in total (14 main + 3 repeats + 3 catch) so the questionnaires
// are reached quickly, and breaks / warnings fire early so they can be seen too.
const TEST_PID = 'exp_test_ivette';
const IS_TEST = pid === TEST_PID;
if (IS_TEST) {
  Object.assign(CONFIG, {
    N_TRIALS: 10, N_REPEATS: 1, N_CATCH: 2, N_CATCH_TOPIC: 0,
    BREAK_EVERY: 5, NONE_CHECK_EVERY: 5, NONE_MIN_TRIALS: 5, FILENAME_PREFIX: 'TEST_' + CONFIG.FILENAME_PREFIX
  });
}

// Clean export: one row per triplet trial, tripletTools-style columns first
// (head, winner, loser, worker_id, rt, Center, Left, Right, Answer, sampleAlg, sampleSet),
// then design metadata. Missing values are written as NA.
const EXPORT_COLS = [
  'head', 'winner', 'loser', 'worker_id', 'prolific_pid', 'study_id', 'session_id', 'row_type', 'rt',
  'Center', 'Left', 'Right', 'Answer', 'sampleAlg', 'sampleSet',
  'trial_order', 'trial_kind', 'question', 'none_chosen', 'is_repeat', 'triplet_id', 'shown_order',
  'none_rate', 'flag_high_none', 'n_none_warnings',
  'rt_too_fast', 'fast_rate', 'flag_fast', 'n_fast_warnings',
  'is_catch', 'catch_correct', 'catch_pass_rate', 'flag_failed_catch'
];

const tripletData = () => jsPsych.data.get().filterCustom(d => d.triplet_id !== undefined);

// Share of triplet trials so far answered "Neither / can't say"
function noneRate() {
  const rows = tripletData().values();
  return rows.length ? rows.filter(d => d.none_chosen).length / rows.length : 0;
}

let nNoneWarnings = 0;
let nFastWarnings = 0, lastFastWarnAt = -Infinity;

// Share of triplet trials answered faster than CONFIG.FAST_RT_MS
function fastRate() {
  const rows = tripletData().values();
  return rows.length ? rows.filter(d => d.rt_too_fast).length / rows.length : 0;
}

function exportRows() {
  // Participant-level summaries repeated on every row: overall none rate, a flag if it exceeds
  // CONFIG.NONE_WARN_RATE, how many warnings were shown, and the catch-trial pass rate with a
  // flag if more than CONFIG.CATCH_MAX_WRONG of the catch trials were answered wrongly
  // (choosing "Neither" on a catch trial counts as wrong).
  const rate = noneRate();
  const rows = tripletData().values();
  const catches = rows.filter(d => d.is_catch);
  const passRate = catches.length ? catches.filter(d => d.catch_correct).length / catches.length : null;
  const out = rows.map((d, i) => ({
    ...d, trial_order: i + 1,
    none_rate: rate.toFixed(3), flag_high_none: rate > CONFIG.NONE_WARN_RATE, n_none_warnings: nNoneWarnings,
    fast_rate: fastRate().toFixed(3), flag_fast: fastRate() > CONFIG.FAST_FLAG_RATE, n_fast_warnings: nFastWarnings,
    catch_pass_rate: passRate === null ? null : passRate.toFixed(3),
    flag_failed_catch: passRate === null ? null : (1 - passRate) > CONFIG.CATCH_MAX_WRONG
  }));
  // Train/test labels for tripletTools. Repeats, catch trials and "Neither" answers are not usable
  // for fitting (sampleSet = NA); everything else is randomly split by CONFIG.TEST_PROP.
  const usable = out.filter(r => !r.is_repeat && !r.is_catch && !r.none_chosen);
  const testSet = new Set(shuffle(usable).slice(0, Math.round(CONFIG.TEST_PROP * usable.length)));
  const usableSet = new Set(usable);
  out.forEach(r => { r.sampleSet = usableSet.has(r) ? (testSet.has(r) ? 'test' : 'train') : null; });
  return out;
}

function toCSV(rows, cols = EXPORT_COLS) {
  const esc = v => {
    if (v === null || v === undefined) return 'NA';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function downloadCSV(text, fname) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Questionnaire answers, flattened to one value per column named <questionnaire>_<field>
// (e.g. demographics_age, professions_doctor_self).
function questionnaireColumns() {
  const out = {};
  jsPsych.data.get().filterCustom(d => d.questionnaire !== undefined).values()
    .forEach(d => Object.entries(d.answers).forEach(([field, value]) => { out[`${d.questionnaire}_${field}`] = value; }));
  return out;
}

// One file: the triplet rows (row_type = "trial"), then a single extra row at the bottom
// (row_type = "questionnaire") that holds all questionnaire answers. Cells that do not apply
// are left empty, so nothing is repeated.
function combinedRows() {
  const q = questionnaireColumns(), qcols = Object.keys(q);
  const cols = [...EXPORT_COLS, ...qcols];
  const blank = Object.fromEntries(cols.map(c => [c, '']));
  const trials = exportRows().map(r => ({ ...blank, ...r, row_type: 'trial' }));
  const qrow = { ...blank, ...q, row_type: 'questionnaire', worker_id: pid,
                 prolific_pid: prolificPid, study_id: studyId, session_id: sessionId };
  return { rows: [...trials, qrow], cols };
}

// Non-test: POST the single combined CSV to the server (CONFIG.SAVE_URL, a PHP script) and nothing is
// downloaded by the participant, unless the server cannot be reached after several tries (so data are
// never lost). Test (IS_TEST): the CSV is also downloaded so the output can be checked, plus POSTed
// if SAVE_URL is set.
async function postWithRetry(payload, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(CONFIG.SAVE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (res.ok) return true;
    } catch (e) { /* network error: retry */ }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return false;
}

async function saveData() {
  const { rows, cols } = combinedRows();
  const csv = toCSV(rows, cols);
  const fname = `${CONFIG.FILENAME_PREFIX}_${pid}.csv`;
  if (IS_TEST || !CONFIG.SAVE_URL) downloadCSV(csv, fname);
  if (CONFIG.SAVE_URL) {
    const ok = await postWithRetry({ participant_id: pid, is_test: IS_TEST, filename: fname, csv, rows });
    if (!ok && !IS_TEST) downloadCSV(csv, fname);   // last resort so no data are lost
  }
}

const NONE_HTML = `<span class="opt none-btn">Neither / can't say</span>`;
const srcHtml = id => `<span class="opt">${SRC[id].label}</span>`;
const topicHtml = id => `<span class="opt"><b>${TOPIC[id].label}</b><br><small>${TOPIC[id].gloss}</small></span>`;
// Put a label mid-sentence: lowercase only its first letter ("A doctor" -> "a doctor"),
// leaving names and acronyms (AI, ChatGPT, Reddit, Instagram...) untouched.
// Labels that start with an acronym ("AI ...") are left as-is.
const midSentence = s => /^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
const choiceButton = nOpts => (choice, i) =>
  `<button class="jspsych-btn${i >= nOpts ? ' none-choice' : ''}">${choice}</button>`;

function buildTrial(t) {
  const order = shuffle(t.items);   // randomize on-screen position
  let stimulus, optHtml, question;

  if (t.type === 'T1') {
    question = 'rely_for_topic';
    stimulus = `<div class="wrap">
      <p class="q">Imagine you need <b>${midSentence(TOPIC[t.anchor].label)}</b>.</p>
      <p class="gloss">${TOPIC[t.anchor].gloss}</p>
      <p class="q">Who would you rather rely on?</p></div>`;
    optHtml = srcHtml;
  } else if (t.type === 'T2') {
    question = 'trust_for_topic';
    stimulus = `<div class="wrap">
      <p class="q">Think about <b>${midSentence(SRC[t.anchor].label)}</b>.</p>
      <p class="q">Which kind of advice would you <b>trust them more</b> to give you?</p></div>`;
    optHtml = topicHtml;
  } else if (t.type === 'T3A') {
    question = 'similar_to_reference';
    stimulus = `<div class="wrap"><p class="q">Reference: <b>${TOPIC[t.anchor].label}</b></p>
      <p class="gloss">${TOPIC[t.anchor].gloss}</p>
      <p class="q">Which of these is <b>more similar</b> to the reference${CONFIG.SIM_QUALIFIER_TOPIC}?</p></div>`;
    optHtml = topicHtml;
  } else {
    question = 'similar_to_reference';
    stimulus = `<div class="wrap"><p class="q">Reference: <b>${SRC[t.anchor].label}</b></p>
      <p class="q">Which of these is <b>more similar</b> to the reference${CONFIG.SIM_QUALIFIER_SOURCE}?</p></div>`;
    optHtml = srcHtml;
  }

  return {
    type: jsPsychHtmlButtonResponse,
    stimulus,
    choices: [...order.map(optHtml), NONE_HTML],
    button_html: choiceButton(order.length),
    button_layout: 'grid', grid_rows: null, grid_columns: order.length,   // options side by side, "none" on a row below
    enable_button_after: 400,
    data: {
      triplet_id: t.id,
      trial_kind: t.is_catch ? `CATCH_${t.type}` : t.type,
      is_catch: !!t.is_catch,
      question,
      anchor: t.anchor,
      shown_order: order.join('|'),
      is_repeat: t.is_repeat
    },
    on_finish: d => {
      // All trial types share the referent format: Center = reference,
      // Left/Right = the two options, Answer = the option picked.
      const i = d.response, none = i >= order.length;
      const answer = none ? null : order[i];
      const loser = none ? null : order[1 - i];
      const idx = x => (x === null ? null : ITEM_INDEX[x]);
      Object.assign(d, {
        worker_id: pid,
        head: idx(t.anchor), winner: idx(answer), loser: idx(loser),
        Center: t.anchor, Left: order[0], Right: order[1], Answer: answer,
        sampleAlg: (t.is_repeat || t.is_catch) ? 'check' : 'random',
        sampleSet: null,   // assigned when the data are saved (see exportRows)
        none_chosen: none,
        // catch trials: correct = picked the option identical to the reference
        catch_correct: t.is_catch ? answer === t.anchor : null
      });
    }
  };
}

// ---------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------
const topicDefs = TOPICS.map(d => `<dt>${d.label}</dt><dd>${d.gloss}</dd>`).join('');

const intro = {
  type: jsPsychInstructions,
  show_clickable_nav: true,
  pages: [
    `<div class="wrap"><h2>Who do you trust, and for what?</h2>
     <p>In this study you will answer short questions about which people and sources you would trust for different kinds of advice.
     There are no right or wrong answers; we are interested in your own impressions.</p>
     <p>It takes about 30 minutes, with short breaks. Please answer quickly and go with your gut.</p></div>`,
    `<div class="wrap"><h3>Four kinds of advice</h3>
     <p>Questions will refer to these kinds of advice:</p>
     <dl>${topicDefs}</dl></div>`,
    `<div class="wrap"><h3>Three kinds of questions</h3>
     <p><b>1.</b> You will be given a kind of advice and asked <i>who</i> you would rather rely on.</p>
     <p><b>2.</b> You will be given a source and asked <i>which kind of advice</i> you would trust them more to give.</p>
     <p><b>3.</b> You will see a reference item and two others, and pick which of the two is <i>more similar</i> to the reference. For people and sources, think of them as <i>sources of advice</i>; for kinds of advice, think about <i>who you would trust to give it</i>.</p>
     <p>These are mixed together. If neither option fits, choose “Neither / can't say”.</p></div>`
  ],
  button_label_next: 'Next',
  button_label_previous: 'Back',
  allow_backward: true
};

const makeBreak = (done, total) => ({
  type: jsPsychHtmlButtonResponse,
  stimulus: `<div class="wrap"><h3>Short break</h3>
    <p>You have finished ${done} of ${total} questions. Take a moment if you need one.</p></div>`,
  choices: ['Continue']
});

const halfwayBreak = (done, total) => ({
  type: jsPsychHtmlButtonResponse,
  stimulus: `<div class="wrap"><h3>Halfway there!</h3>
    <p>You have finished ${done} of ${total} questions. Great work.</p>
    <p>This is a good moment for a longer break: stand up, stretch, get some water.
    Click “Continue” whenever you are ready for the second half.</p></div>`,
  choices: ['Continue'],
  data: { break_type: 'halfway' }
});

// Feedback after an incorrect attention-check ("catch") trial. One option was identical to the reference.
const lastTrial = () => tripletData().last(1).values()[0];
const lastWasMissedCatch = () => { const l = lastTrial(); return !!l && l.is_catch && !l.catch_correct; };
const catchWarning = {
  timeline: [{
    type: jsPsychHtmlButtonResponse,
    stimulus: `<div class="wrap"><h3>Please pay attention</h3>
      <div class="warn"><p>That last question was an attention check, and your answer did not match.</p></div>
      <p>On that question one of the two options was <i>exactly the same</i> as the reference, so it was the
      clear answer. Please read every question and its options carefully before answering. Your answers
      are only useful to us if they reflect your own careful impressions.</p></div>`,
    choices: ['OK, I will pay attention'],
    enable_button_after: 2000,
    data: () => ({ catch_warning: true })
  }],
  conditional_function: lastWasMissedCatch
};

// Feedback shown right after a response faster than CONFIG.FAST_RT_MS (rate-limited).
// The button is disabled for 2 s so the message is actually read.
const fastWarning = {
  timeline: [{
    type: jsPsychHtmlButtonResponse,
    stimulus: `<div class="wrap"><h3>That was very fast</h3>
      <div class="warn"><p>Your last answer took less than ${CONFIG.FAST_RT_MS / 1000} second.</p></div>
      <p>That is hardly enough time to read the question and the options. Please take a moment
      to read each question carefully before answering. Your answers are only useful if they
      reflect your own considered impressions.</p></div>`,
    choices: ['OK, I will slow down'],
    enable_button_after: 2000,
    data: () => ({ fast_warning: true, fast_rate_at_warning: fastRate() }),
    on_finish: () => { nFastWarnings++; lastFastWarnAt = tripletData().count(); }
  }],
  conditional_function: () => {
    const last = lastTrial();
    return !!last && last.rt_too_fast && !lastWasMissedCatch() &&
      nFastWarnings < CONFIG.FAST_MAX_WARNINGS &&
      tripletData().count() - lastFastWarnAt >= CONFIG.FAST_MIN_GAP;
  }
};

// Shown only if the running "Neither / can't say" rate is above CONFIG.NONE_WARN_RATE.
const noneWarning = {
  timeline: [{
    type: jsPsychHtmlButtonResponse,
    stimulus: () => `<div class="wrap"><h3>A quick note</h3>
      <div class="warn"><p>You have chosen “Neither / can't say” on
      <b>${Math.round(noneRate() * 100)}%</b> of questions so far.</p></div>
      <p>That option is there for the rare cases where you truly cannot decide.
      Even when neither option feels perfect, please pick the one that fits <i>a little better</i>.
      Your first instinct is fine.</p></div>`,
    choices: ['OK, got it'],
    data: () => ({ none_warning: true, none_rate_at_warning: noneRate() }),
    on_finish: () => { nNoneWarnings++; }
  }],
  conditional_function: () =>
    tripletData().count() >= CONFIG.NONE_MIN_TRIALS &&
    nNoneWarnings < CONFIG.NONE_MAX_WARNINGS &&
    noneRate() > CONFIG.NONE_WARN_RATE
};


// ---------------------------------------------------------------------
// Questionnaires (after the main task)
// ---------------------------------------------------------------------
// Professions asked about in the familiarity questionnaire (ids from SOURCES).
const PROFESSION_IDS = ['doctor', 'lawyer', 'therapist', 'professor_teacher',
                        'journalist', 'politician', 'influencer', 'podcaster'];
const KNOWN_PEOPLE = [['self', 'Myself'], ['parent', 'A parent'], ['friend', 'A friend'], ['spouse', 'A spouse or partner']];
const professionLabel = id => SRC[id].label.replace(/^An? /, '');

// An option is [value, label] or [value, label, textFieldName]; a third entry puts a text box right
// next to that option (typing in it ticks the option).
const textNext = (selector, t) => t
  ? ` <input type="text" class="inline" name="${t}" data-opt='${selector}' aria-label="Describe">` : '';
const checks = (name, opts) => opts.map(([v, l, t]) =>
  `<label><input type="checkbox" name="${name}_${v}" value="1"> ${l}${textNext(`input[name="${name}_${v}"]`, t)}</label>`).join('');
const radios = (name, opts) => opts.map(([v, l, t]) =>
  `<label><input type="radio" name="${name}" value="${v}"> ${l}${textNext(`input[name="${name}"][value="${v}"]`, t)}</label>`).join('');

// Shared form behaviour. `rules` = [[test(form) -> bool, message]]; submission is blocked (and the
// messages shown) while any rule fails. `exclusive` = [[exclusiveSelector, otherSelector]]: ticking
// the first clears the others and vice versa (e.g. "None", "Prefer not to answer").
const formEl = () => document.querySelector('#jspsych-survey-html-form');
const picked = (f, name) => !!f.querySelector(`input[name="${name}"]:checked`);
const filled = (f, name) => !!(f.elements[name] && f.elements[name].value.trim());
function setupForm(rules, exclusive = []) {
  const form = formEl(), err = document.getElementById('form-err');
  form.addEventListener('submit', e => {
    const msgs = rules.filter(([ok]) => !ok(form)).map(([, m]) => m);
    if (msgs.length) {
      e.preventDefault(); e.stopImmediatePropagation();
      err.innerHTML = 'Please complete the required questions:<br>• ' + msgs.join('<br>• ');
      err.scrollIntoView({ block: 'center' });
    }
  }, true);
  form.querySelectorAll('input[data-opt]').forEach(t =>
    t.addEventListener('input', () => {
      const opt = form.querySelector(t.dataset.opt);
      if (t.value && !opt.checked) opt.click();
    }));
  exclusive.forEach(([ex, others]) => {
    form.querySelectorAll(ex).forEach(x => x.addEventListener('change', () => {
      if (x.checked) form.querySelectorAll(others).forEach(o => {
        if (o === x) return;
        if (o.type === 'checkbox' || o.type === 'radio') o.checked = false; else o.value = '';
      });
    }));
    form.querySelectorAll(others).forEach(o => o.addEventListener('input', () => {
      if (o.checked || (o.type === 'number' && o.value)) form.querySelectorAll(ex).forEach(x => { x.checked = false; });
    }));
  });
}
const REQ = '<span class="req" title="required">*</span>';

// Profession grid: every row needs an answer; "None" is exclusive within its row.
function requireProfessionRows() {
  setupForm(
    [[f => PROFESSION_IDS.every(id => f.querySelector(`tr[data-prof="${id}"] input:checked`)),
      'Answer every row of the grid (tick “None” if nobody applies).']],
    PROFESSION_IDS.map(id => [`tr[data-prof="${id}"] input[name$="_none"]`,
                              `tr[data-prof="${id}"] input:not([name$="_none"])`]));
}

const professionQuestionnaire = {
  type: jsPsychSurveyHtmlForm,
  preamble: `<div class="wrap"><h3>A few questions about the people you know</h3>
    <p>For each profession below, tick everyone who works in that profession (or did in the past).
    Tick “None” if nobody applies. You can tick more than one box per row.</p></div>`,
  html: `<div class="wrap survey"><table>
    <tr><th></th>${KNOWN_PEOPLE.map(([, l]) => `<th>${l}</th>`).join('')}<th>None</th></tr>
    ${PROFESSION_IDS.map(id => `<tr data-prof="${id}"><td>${professionLabel(id)}</td>
      ${KNOWN_PEOPLE.map(([v]) => `<td><input type="checkbox" name="${id}_${v}" value="1" aria-label="${v}"></td>`).join('')}
      <td><input type="checkbox" name="${id}_none" value="1" aria-label="none"></td></tr>`).join('')}
    </table><p class="err" id="form-err"></p>
    <fieldset style="border:0;padding:0;margin-top:1.5rem"><legend style="font-weight:600">
      When you saw “${SRC.celebrity.label}” earlier, which celebrity or what kind of celebrity did you picture?</legend>
      <input type="text" name="celebrity_pictured" style="width:90%" aria-label="Celebrity pictured"
        placeholder="e.g., a specific person, or a type such as “a pop singer”"></fieldset></div>`,
  button_label: 'Next',
  on_load: requireProfessionRows,
  data: { questionnaire: 'professions' },
  on_finish: d => {
    const r = d.response, out = {};
    PROFESSION_IDS.forEach(id => {
      [...KNOWN_PEOPLE.map(k => k[0]), 'none'].forEach(v => { out[`${id}_${v}`] = r[`${id}_${v}`] ? 1 : 0; });
    });
    out.celebrity_pictured = r.celebrity_pictured ?? '';
    d.answers = out;
  }
};


// Media use: social media, AI chatbots, podcasts (own page, before demographics)
const USE = [['never', 'No, never'], ['rarely', 'Rarely (less than monthly)'], ['monthly', 'Monthly'],
             ['weekly', 'Weekly'], ['daily', 'Daily']];
const SOCIAL = [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook'], ['youtube', 'YouTube'],
                ['x', 'X (Twitter)'], ['reddit', 'Reddit'], ['snapchat', 'Snapchat'], ['linkedin', 'LinkedIn'],
                ['whatsapp', 'WhatsApp / Messenger'], ['bluesky', 'Bluesky / Threads / Mastodon'],
                ['other', 'Other:', 'social_text']];
const LLMS = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['copilot', 'Microsoft Copilot'],
              ['meta_ai', 'Meta AI'], ['grok', 'Grok'], ['perplexity', 'Perplexity'], ['deepseek', 'DeepSeek'],
              ['other', 'Other:', 'llm_text']];
const PODCAST_KINDS = [['comedy', 'Comedy'], ['health', 'Health / wellness'], ['politics', 'Politics / news'],
                       ['true_crime', 'True crime'], ['science', 'Science / education'], ['business', 'Business / finance'],
                       ['culture', 'Pop culture / entertainment'], ['sports', 'Sports'], ['relationships', 'Relationships / advice'],
                       ['other', 'Other:', 'podcast_text']];

const mediaQuestionnaire = {
  type: jsPsychSurveyHtmlForm,
  preamble: `<div class="wrap"><h3>Your media use</h3>
    <p>A few questions about the kinds of sources you use. Questions marked ${REQ} are required.</p></div>`,
  html: `<div class="wrap survey">
    <fieldset><legend>How often do you use social media? ${REQ}</legend>${radios('social_freq', USE)}</fieldset>
    <fieldset><legend>Which social media do you use? (select all that apply)</legend>${checks('social', SOCIAL)}</fieldset>
    <fieldset><legend>How often do you use AI chatbots (large language models)? ${REQ}</legend>${radios('llm_freq', USE)}</fieldset>
    <fieldset><legend>Which ones do you use? (select all that apply)</legend>${checks('llm', LLMS)}</fieldset>
    <fieldset><legend>How often do you listen to podcasts? ${REQ}</legend>${radios('podcast_freq', USE)}</fieldset>
    <fieldset><legend>What kinds of podcasts do you listen to? (select all that apply)</legend>${checks('podcast', PODCAST_KINDS)}</fieldset>
    <fieldset><legend>Which podcasts do you listen to most? (optional)</legend>
      <input type="text" name="podcast_names" style="width:90%" placeholder="e.g., names of shows" aria-label="Podcast names"></fieldset>
    <p class="err" id="form-err"></p></div>`,
  button_label: 'Next',
  on_load: () => setupForm([
    [f => picked(f, 'social_freq'), 'How often you use social media'],
    [f => picked(f, 'llm_freq'), 'How often you use AI chatbots'],
    [f => picked(f, 'podcast_freq'), 'How often you listen to podcasts']]),
  data: { questionnaire: 'media_use' },
  on_finish: d => {
    const r = d.response, out = {};
    ['social_freq', 'social_text', 'llm_freq', 'llm_text', 'podcast_freq', 'podcast_text', 'podcast_names']
      .forEach(k => { out[k] = r[k] ?? ''; });
    [['social', SOCIAL], ['llm', LLMS], ['podcast', PODCAST_KINDS]].forEach(([n, opts]) =>
      opts.forEach(([v]) => { out[`${n}_${v}`] = r[`${n}_${v}`] ? 1 : 0; }));
    d.answers = out;
  }
};

const GENDER = [['woman', 'Woman'], ['man', 'Man'], ['nonbinary', 'Non-binary'],
                ['self_describe', 'Prefer to self-describe:', 'gender_text'], ['no_answer', 'Prefer not to answer']];
const RACE = [['black', 'Black or African American'], ['east_asian', 'East Asian'], ['south_asian', 'South Asian'],
              ['southeast_asian', 'Southeast Asian'], ['indigenous', 'Indigenous (e.g., First Nations, Inuit, Métis, American Indian, Alaska Native)'],
              ['middle_eastern', 'Middle Eastern or North African'], ['pacific_islander', 'Native Hawaiian or Pacific Islander'],
              ['white', 'White'], ['other', 'Another race:', 'race_text'], ['no_answer', 'Prefer not to answer']];
const ETHNICITY = [['hispanic', 'Hispanic or Latino/a/x'], ['not_hispanic', 'Not Hispanic or Latino/a/x'],
                   ['no_answer', 'Prefer not to answer']];
const EDUCATION = [['less_than_hs', 'Less than high school'], ['high_school', 'High school diploma or equivalent'],
                   ['some_college', 'Some college / CEGEP / vocational training, no degree'],
                   ['associate', 'Associate degree or technical diploma'], ['bachelors', "Bachelor's degree"],
                   ['masters', "Master's degree"], ['professional', 'Professional degree (e.g., MD, JD)'],
                   ['doctorate', 'Doctorate (PhD)'], ['no_answer', 'Prefer not to answer']];
const KIDS = [['yes', 'Yes. How many?', 'kids_n'], ['no', 'No'], ['no_answer', 'Prefer not to answer']];

const demographicsQuestionnaire = {
  type: jsPsychSurveyHtmlForm,
  preamble: `<div class="wrap"><h3>About you</h3>
    <p>Last step. These questions are used only to describe our sample. Questions marked ${REQ} are required;
    most have a “prefer not to answer” option.</p></div>`,
  html: `<div class="wrap survey">
    <fieldset><legend>What is your age? ${REQ}</legend>
      <label><input type="number" name="age" min="0" max="120" style="width:5rem"> years</label>
      <label><input type="checkbox" name="age_no_answer" value="1"> Prefer not to answer</label></fieldset>
    <fieldset><legend>What is your gender identity? ${REQ}</legend>${radios('gender', GENDER)}</fieldset>
    <fieldset><legend>What is your race? (select all that apply) ${REQ}</legend>${checks('race', RACE)}</fieldset>
    <fieldset><legend>What is your ethnicity? ${REQ}</legend>${radios('ethnicity', ETHNICITY)}
      <label style="margin-top:.5rem">Specific ethnic background(s), if you wish (optional):
        <input type="text" name="ethnicity_text" style="width:90%"></label></fieldset>
    <fieldset><legend>What is the highest level of education you have completed? ${REQ}</legend>${radios('education', EDUCATION)}</fieldset>
    <fieldset><legend>Do you have children? ${REQ}</legend>${radios('kids', KIDS)}</fieldset>
    <fieldset><legend>Which languages do you speak? ${REQ}</legend>
      <input type="text" name="languages" style="width:90%" placeholder="e.g., English, French, Spanish" aria-label="Languages spoken">
      <label style="margin-top:.5rem">Language(s) you speak at home or most often (optional):
        <input type="text" name="languages_main" style="width:90%"></label></fieldset>
    <p class="err" id="form-err"></p></div>`,
  button_label: 'Next',
  on_load: () => setupForm([
    [f => filled(f, 'age') || picked(f, 'age_no_answer'), 'Age (or tick “Prefer not to answer”)'],
    [f => picked(f, 'gender'), 'Gender identity'],
    [f => !picked(f, 'gender') || f.querySelector('input[name="gender"]:checked').value !== 'self_describe' || filled(f, 'gender_text'),
      'Please describe your gender identity'],
    [f => RACE.some(([v]) => picked(f, `race_${v}`)), 'Race'],
    [f => !picked(f, 'race_other') || filled(f, 'race_text'), 'Please describe your race'],
    [f => picked(f, 'ethnicity'), 'Ethnicity'],
    [f => picked(f, 'education'), 'Highest level of education'],
    [f => picked(f, 'kids'), 'Whether you have children'],
    [f => !picked(f, 'kids') || f.querySelector('input[name="kids"]:checked').value !== 'yes' || filled(f, 'kids_n'),
      'How many children you have'],
    [f => filled(f, 'languages'), 'Languages spoken']],
    [['input[name="age_no_answer"]', 'input[name="age"]'],
     ['input[name="race_no_answer"]', 'input[name^="race_"]:not([name="race_no_answer"])']]),
  data: { questionnaire: 'demographics' },
  on_finish: d => {
    const r = d.response, out = {};
    ['age', 'gender', 'gender_text', 'education', 'ethnicity', 'ethnicity_text', 'kids', 'kids_n', 'race_text',
     'languages', 'languages_main'].forEach(k => { out[k] = r[k] ?? ''; });
    out.age_no_answer = r.age_no_answer ? 1 : 0;
    RACE.forEach(([v]) => { out[`race_${v}`] = r[`race_${v}`] ? 1 : 0; });
    d.answers = out;
  }
};

const endScreen = {
  type: jsPsychHtmlButtonResponse,
  stimulus: `<div class="wrap"><h3>All done, thank you!</h3>
    <p>Click below to finish. Your responses will be saved.</p></div>`,
  choices: ['Finish']
};

// ---------------------------------------------------------------------
// Assemble and run
// ---------------------------------------------------------------------
const all = buildAllTriplets();
const sequence = sampleDesign(all, CONFIG);
const trials = sequence.map(buildTrial);
const timeline = [intro];
const halfway = Math.floor(trials.length / 2);
trials.forEach((tr, i) => {
  const done = i + 1;
  timeline.push(tr, catchWarning, fastWarning);
  if (done % CONFIG.NONE_CHECK_EVERY === 0 && done < trials.length) timeline.push(noneWarning);
  if (CONFIG.HALFWAY_BREAK && done === halfway) timeline.push(halfwayBreak(done, trials.length));
  // regular short break, skipped if it would land within a few trials of the halfway break
  else if (done % CONFIG.BREAK_EVERY === 0 && done < trials.length &&
           !(CONFIG.HALFWAY_BREAK && Math.abs(done - halfway) < 10)) timeline.push(makeBreak(done, trials.length));
});
timeline.push(professionQuestionnaire, mediaQuestionnaire, demographicsQuestionnaire, endScreen);

jsPsych.run(timeline);
