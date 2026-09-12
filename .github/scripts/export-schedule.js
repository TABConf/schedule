const fs = require('fs');
const fetch = require('node-fetch');

// TABConf 8 Schedule, org project #11. Verified against the API on 2026-09-12,
// not copied from a note: the org has #11 TABConf8 Schedule, #9 TABConf 7,
// #4 TABConf 6 and #1 TABConf 2023.
//
// This pointed at #9 from 2026-08-05 until 2026-09-12, because when the site was
// switched to TABConf 8 no TABConf 8 project existed yet. Running the workflow in
// that window would have published last year's schedule over data/schedule.json.
//
// IF THE PROJECT EVER CHANGES, GET THE ID FROM THE API RATHER THAN GUESSING:
//   gh api graphql -f query='{organization(login:"TABConf"){projectsV2(first:20){nodes{number title id}}}}'
const PROJECT_ID = 'PVT_kwDOAfWa-84Bffju'; // TABConf 8 Schedule, org project #11

const QUERY = `
query($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            ... on Issue {
              title
              state
              body
              url
              assignees(first: 5) { nodes { login } }
              labels(first: 20) { nodes { name color } }
            }
          }
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldMultiSelectValue {
                options { name }
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
`;

async function fetchAllItems() {
  const out = [];
  let after = null;
  while (true) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GitHubAction'
      },
      body: JSON.stringify({ query: QUERY, variables: { projectId: PROJECT_ID, after } })
    });
    const json = await res.json();
    if (!json?.data?.node?.items) {
      console.error('GraphQL response missing expected data:', JSON.stringify(json, null, 2));
      process.exit(1);
    }

    const { nodes, pageInfo } = json.data.node.items;
    out.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return out;
}

function sanitizeSummary(md) {
  return (md || '').replace(/<img[^>]*>/gi, '').slice(0, 160);
}

(async () => {
  try {
    const nodes = await fetchAllItems();

    const items = nodes.map(item => {
      const c = item.content;

      // exclude closed issues
      if ((c?.state || '').toUpperCase() === 'CLOSED') return null;

      const labels = c?.labels?.nodes || [];
      const hasAccepted = labels.some(l => (l.name || '').toLowerCase() === 'accepted');
      if (!hasAccepted) return null; // keep your Accepted-only rule

      // Gather EVERY field value type, not just single select.
      //
      // This read single select only until 2026-09-12, and project #11 does not
      // use single select for the parts that matter: Date is a DATE field and
      // Start Time and End Time are MULTI_SELECT. The result was a schedule.json
      // where every session had an empty day and time, which looks like a data
      // entry problem rather than a parser one and is miserable to debug.
      const fields = {};
      for (const f of item.fieldValues?.nodes || []) {
        const key = f.field?.name;
        if (!key) continue;
        switch (f.__typename) {
          case 'ProjectV2ItemFieldSingleSelectValue': fields[key] = f.name || ''; break;
          case 'ProjectV2ItemFieldDateValue':         fields[key] = f.date || ''; break;
          case 'ProjectV2ItemFieldTextValue':         fields[key] = f.text || ''; break;
          case 'ProjectV2ItemFieldNumberValue':
            fields[key] = (f.number === null || f.number === undefined) ? '' : String(f.number);
            break;
          case 'ProjectV2ItemFieldMultiSelectValue':
            // Take the FIRST option only. Start Time and End Time are multi
            // select purely because of how the project was set up; a session
            // has one start and one end, so joining them would render a slot
            // as something like "10:00, 14:00" and break the timeline.
            fields[key] = (f.options && f.options[0] && f.options[0].name) || '';
            break;
        }
      }

      // Field names as they exist in project #11 today, with the older names kept
      // as fallbacks so renaming a column in the project does not silently blank
      // the site.
      return {
        title: c?.title || '',
        day: fields['Date'] || fields['Day'] || '',
        time: fields['Time Slot'] || '',
        startTime: fields['Start Time'] || '',
        endTime: fields['End Time'] || '',
        village: fields['Village'] || '',
        status: fields['Status'] || '',
        assignees: (c?.assignees?.nodes || []).map(a => a.login).join(', ') || '',
        labels: labels.map(l => ({ name: l.name, color: `#${l.color}` })),
        summary: sanitizeSummary(c?.body),
        url: c?.url
      };
    }).filter(Boolean);

    // Optional: quick debug counts
    console.log(`Collected items: ${nodes.length}, kept after Accepted filter: ${items.length}`);

    fs.writeFileSync('data/schedule.json', JSON.stringify(items, null, 2));
  } catch (err) {
    console.error('GraphQL query failed:', err);
    process.exit(1);
  }
})();
