/**
 * export-schedule.js: TABConf 8 schedule export.
 *
 * Rewritten from scratch 2026-09-12. The previous version was built for a
 * multi-room event keyed on "Day 1" to "Day 4" strings and Village columns.
 * TABConf 8 is ONE STAGE with real calendar dates, so that model is gone.
 *
 * Reads org project #11 and writes data/schedule.json.
 *
 * DESIGN NOTE: all parsing, normalising and sorting happens HERE, not in the
 * page. The site renders what it is given and makes no decisions. The old site
 * carried its own AM/PM parser, a day-range expander and a colour hashing
 * function, and each was a place for the schedule to disagree with itself.
 *
 * Fields are read defensively BY NAME across every value type, because these
 * have moved between project custom fields and org issue fields more than
 * once. Whatever Date, Start Time and End Time happen to be today, this reads
 * them.
 */
const fs = require('fs');
const fetch = require('node-fetch');

// TABConf 8 Schedule, org project #11. Verified against the API 2026-09-12.
// Get it again with:
//   gh api graphql -f query='{organization(login:"TABConf"){projectsV2(first:20){nodes{number title id}}}}'
const PROJECT_ID = 'PVT_kwDOAfWa-84Bffju';

// Sessions that occupy floor space rather than the stage. No start time, and
// they must never be laid out on the timeline.
const FLOOR_LABELS = ['floor space', 'builders day project', 'village'];

const QUERY = `
query($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            ... on Issue {
              number
              title
              state
              body
              url
              assignees(first: 10) { nodes { login } }
              labels(first: 20) { nodes { name color } }
              issueFieldValues(first: 20) {
                nodes {
                  __typename
                  ... on IssueFieldDateValue         { value field { ... on IssueFieldCommon { name } } }
                  ... on IssueFieldTextValue         { value field { ... on IssueFieldCommon { name } } }
                  ... on IssueFieldMultiSelectValue  { value field { ... on IssueFieldCommon { name } } }
                  ... on IssueFieldSingleSelectValue { name  field { ... on IssueFieldCommon { name } } }
                }
              }
            }
          }
          fieldValues(first: 40) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldTextValue         { text   field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue         { date   field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue       { number field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name   field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldMultiSelectValue  { options { name } field { ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
    }
  }
}`;

async function fetchAllItems() {
  const out = [];
  let after = null;
  for (;;) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'tabconf-schedule-export'
      },
      body: JSON.stringify({ query: QUERY, variables: { projectId: PROJECT_ID, after } })
    });
    const json = await res.json();
    if (json.errors) console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    if (!json || !json.data || !json.data.node || !json.data.node.items) {
      console.error('Response missing items. Can GH_TOKEN read org projects?');
      process.exit(1);
    }
    const { nodes, pageInfo } = json.data.node.items;
    out.push(...nodes);
    if (!pageInfo.hasNextPage) return out;
    after = pageInfo.endCursor;
  }
}

/**
 * Flatten field values into { fieldName: string }.
 *
 * Reads BOTH sources and THE PROJECT BOARD WINS:
 *   - the project item's own fieldValues (project custom fields)
 *   - the issue's issueFieldValues (org level Issue Fields), as a fallback only
 *
 * PRECEDENCE FLIPPED 2026-09-24, AND IT HAD TEETH. Issue Fields used to win,
 * which was right when they were the only place times lived. Once the whole
 * schedule was written onto project #11 the two sources disagreed, and stale
 * Issue Field values from an earlier attempt silently overrode every one of
 * them: sessions came out at the wrong times, in rooms that do not run on
 * those days, and the clash detector reported five overlaps that did not exist.
 *
 * THE BOARD IS WHERE A HUMAN SCHEDULES, so the board is the source of truth.
 * Issue Fields remain a fallback for anything the board has not set, which
 * keeps older items rendering rather than vanishing.
 */
function readFields(item) {
  const f = {};
  const nodes = (item.fieldValues && item.fieldValues.nodes) || [];
  for (const v of nodes) {
    const key = v.field && v.field.name;
    if (!key) continue;
    switch (v.__typename) {
      case 'ProjectV2ItemFieldTextValue':         if (!f[key]) f[key] = v.text || ''; break;
      case 'ProjectV2ItemFieldDateValue':         if (!f[key]) f[key] = v.date || ''; break;
      case 'ProjectV2ItemFieldSingleSelectValue': if (!f[key]) f[key] = v.name || ''; break;
      case 'ProjectV2ItemFieldNumberValue':
        f[key] = (v.number === null || v.number === undefined) ? '' : String(v.number);
        break;
      case 'ProjectV2ItemFieldMultiSelectValue':
        // First option only. A session has one start and one end; joining them
        // would render a slot as "10:00, 14:00" and break the timeline.
        if (!f[key]) f[key] = (v.options && v.options[0] && v.options[0].name) || '';
        break;
    }
  }
  const c = item.content || {};
  for (const v of (c.issueFieldValues && c.issueFieldValues.nodes) || []) {
    const key = v.field && v.field.name;
    if (!key || f[key]) continue;   // the board already answered
    const val = v.name !== undefined && v.name !== null ? v.name : v.value;
    if (val !== undefined && val !== null && val !== '') f[key] = String(val);
  }
  return f;
}

/** "9:30 AM" | "09:30" | "1:05 PM" -> minutes from midnight, or null. */
function toMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/\./g, '');
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === 'PM') h += 12;
    return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

function fmtTime(mins) {
  if (mins === null) return '';
  const h = Math.floor(mins / 60);
  const mm = String(mins % 60).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  return `${(h % 12) || 12}:${mm} ${ap}`;
}

/**
 * Accepts "2026-10-14", "Mon Oct 12", and a bare "Day 3" from the older model.
 *
 * THE MONTH-NAME FORM IS WHAT THE BOARD ACTUALLY HOLDS as of 2026-09-24, because
 * a human reads that board and "Wed Oct 14" is legible where "Day 3" is not.
 * Before this was added every one of the 32 scheduled sessions parsed to an
 * empty date and sank to the bottom as undated, which would have published an
 * empty schedule while looking like a successful export.
 */
const DAY_ONE = '2026-10-12';
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
                 jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function toISODate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const mo = String(MONTHS[m[1].toLowerCase()]).padStart(2, '0');
    const da = String(parseInt(m[2], 10)).padStart(2, '0');
    return `${DAY_ONE.slice(0, 4)}-${mo}-${da}`;
  }
  m = s.match(/day\s*([1-4])/i);
  if (m) {
    const d = new Date(DAY_ONE + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (parseInt(m[1], 10) - 1));
    return d.toISOString().slice(0, 10);
  }
  return '';
}

function summarise(md) {
  return String(md || '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_>`]/g, '')
    .replace(/\r/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean).join(' ')
    .slice(0, 240);
}

(async () => {
  const nodes = await fetchAllItems();
  const sessions = [];

  for (const item of nodes) {
    const c = item.content;
    if (!c || !c.number) continue;
    if (String(c.state).toUpperCase() === 'CLOSED') continue;

    const labels = (c.labels && c.labels.nodes) || [];
    const names = labels.map(l => (l.name || '').toLowerCase());
    if (names.indexOf('accepted') === -1) continue;

    const f = readFields(item);
    const date = toISODate(f['Date'] || f['Day']);
    const startMin = toMinutes(f['Start Time']);
    const endMin = toMinutes(f['End Time']);
    const isFloor = names.some(n => FLOOR_LABELS.indexOf(n) !== -1);

    sessions.push({
      number: c.number,
      title: c.title || '',
      url: c.url,
      date,
      start: fmtTime(startMin),
      end: fmtTime(endMin),
      startMin,
      endMin,
      durationMin: (startMin !== null && endMin !== null) ? endMin - startMin : null,
      track: isFloor ? 'floor' : 'stage',
      // TWO ROOMS ON OCT 12-13, one on Oct 14-15. Until 2026-09-24 the front end
      // derived the location as the string "Main stage" because there was only
      // ever one, which is no longer true and would have mislabelled every
      // hacker room session.
      room: isFloor ? 'Expo floor' : (f['Room'] || 'Main stage'),
      speakers: ((c.assignees && c.assignees.nodes) || []).map(a => a.login),
      labels: labels.map(l => ({ name: l.name, color: '#' + l.color })),
      summary: summarise(c.body)
    });
  }

  // Sort once, here. Undated sessions sink to the bottom rather than vanishing:
  // an accepted talk with no slot is information, not an error.
  sessions.sort((a, b) =>
    (a.date || '9999').localeCompare(b.date || '9999') ||
    ((a.startMin === null ? 1e9 : a.startMin) - (b.startMin === null ? 1e9 : b.startMin)) ||
    a.number - b.number);

  // OVERLAP IS ONLY A BUG WITHIN A SINGLE ROOM. Oct 12 and 13 run two rooms,
  // so two sessions at 11am are the schedule working rather than failing. Keying
  // this on date alone, as it did until 2026-09-24, would flag every legitimate
  // parallel session and train everyone to ignore the warning.
  const clashes = [];
  const byDate = {};
  for (const s of sessions) {
    if (s.track !== 'stage' || !s.date || s.startMin === null) continue;
    const key = s.date + ' | ' + (s.room || 'Main stage');
    byDate[key] = byDate[key] || [];
    byDate[key].push(s);
  }
  Object.keys(byDate).forEach(date => {
    const list = byDate[date].sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].endMin > list[i].startMin) {
        clashes.push(date + ': #' + list[i - 1].number + ' overlaps #' + list[i].number);
      }
    }
  });

  const scheduled = sessions.filter(s => s.date && s.startMin !== null).length;
  const floor = sessions.filter(s => s.track === 'floor').length;
  const stageMinutes = sessions.reduce((n, s) => n + (s.track === 'stage' ? (s.durationMin || 0) : 0), 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    event: {
      name: 'TABConf 8',
      start: '2026-10-12',
      end: '2026-10-15',
      venue: 'Georgia Tech Exhibition Hall, Atlanta'
    },
    counts: {
      total: sessions.length,
      scheduled: scheduled,
      unscheduled: sessions.length - scheduled - floor,
      floor: floor,
      stageMinutes: stageMinutes
    },
    clashes: clashes,
    sessions: sessions
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/schedule.json', JSON.stringify(payload, null, 2));

  console.log('items fetched      ' + nodes.length);
  console.log('accepted and open  ' + sessions.length);
  console.log('scheduled          ' + scheduled);
  console.log('floor / village    ' + floor);
  console.log('stage minutes      ' + stageMinutes);
  if (clashes.length) {
    console.log('\n*** OVERLAPS ON A SINGLE STAGE ***');
    clashes.forEach(c => console.log('  ' + c));
  }
})().catch(err => { console.error('export failed:', err); process.exit(1); });
