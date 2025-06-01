const fs = require('fs');
const fetch = require('node-fetch');

const query = `
{
  node(id: "PVT_kwDOAfWa-84Ae2cL") {
    ... on ProjectV2 {
      title
      items(first: 50) {
        nodes {
          content {
            ... on Issue {
              title
              number
              state
              body
              url
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
        const items = data.data.node.items.nodes.map(n => {
            const i = n.content;
            return {
                title: i?.title || '',
                number: i?.number,
                state: i?.state,
                summary: (i?.body || '').slice(0, 160),
                url: i?.url
            };
        });
        fs.writeFileSync('data/schedule.json', JSON.stringify(items, null, 2));
    })
    .catch(err => {
        console.error('GraphQL query failed:', err);
        process.exit(1);
    });
