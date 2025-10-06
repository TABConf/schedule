const fs = require('fs');
const fetch = require('node-fetch');

const PROJECT_ID = 'PVT_kwDOAfWa-84Awu-M'; // TABConf project v2 id

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
                field { ... on ProjectV2SingleSelectField { name } }
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

      const labels = c?.labels?.nodes || [];
      const hasAccepted = labels.some(l => (l.name || '').toLowerCase() === 'accepted');
      if (!hasAccepted) return null; // keep your Accepted-only rule

      // gather select fields
      const fields = {};
      for (const f of item.fieldValues?.nodes || []) {
        if (f.__typename === 'ProjectV2ItemFieldSingleSelectValue' && f.field?.name && f.name) {
          fields[f.field.name] = f.name;
        }
      }

      return {
        title: c?.title || '',
        day: fields['Day'] || '',
        time: fields['Time Slot'] || '',
        startTime: fields['Start Time'] || '',
        endTime: fields['End Time'] || '',
        village: fields['Village'] || '',
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
