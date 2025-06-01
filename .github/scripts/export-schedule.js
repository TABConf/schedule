const fs = require('fs');
const fetch = require('node-fetch');

const query = `
{
  node(id: "PVT_kwDOAfWa-84Ae2cL") {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          content {
            ... on Issue {
              title
              body
              url
              assignees(first: 5) {
                nodes { login }
              }
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.GH_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'GitHubAction'
  },
  body: JSON.stringify({ query })
})
  .then(res => res.json())
  .then(data => {
    const items = data.data.node.items.nodes.map(item => {
      const c = item.content;
      const fields = {};
      item.fieldValues.nodes.forEach(f => {
        if (f.__typename === 'ProjectV2ItemFieldSingleSelectValue' && f.field?.name && f.name) {
          fields[f.field.name] = f.name;
        }
      });

      return {
        title: c?.title || '',
        day: fields['Day'] || '',
        time: fields['Time Slot'] || '',
        village: fields['Village'] || '',
        assignees: c?.assignees?.nodes.map(a => a.login).join(', ') || '',
        summary: (c?.body || '').slice(0, 160),
        url: c?.url
      };
    });

    fs.writeFileSync('data/schedule.json', JSON.stringify(items, null, 2));
  })
  .catch(err => {
    console.error('GraphQL query failed:', err);
    process.exit(1);
  });
