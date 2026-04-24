import dotenv from 'dotenv';
dotenv.config();

const CLOUDFLARE_API_TOKEN = process.env.CF_API_TOKEN || process.env.GLOUDFLARE_API;
const ACCOUNT_ID = process.env.CF_ID || 'd4336e2049af94b65acdacd750014877';
const PROJECT_NAME = process.env.PROJECT_NAME || 'email-cosmosim-service-ca';
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID || '778c95fd92e4450f8e3c19a564971733';

async function addKvBinding() {
    console.log(`ðŸš€ Adding EMAIL_KV binding to Pages project: ${PROJECT_NAME}...`);
    console.log(`   Namespace ID: ${KV_NAMESPACE_ID}`);

    if (!CLOUDFLARE_API_TOKEN) {
        console.error('âŒ CF_API_TOKEN not found in .env');
        return;
    }

    try {
        // 1. Get current project config
        const getRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}`,
            {
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!getRes.ok) {
            throw new Error(`Failed to fetch project: ${await getRes.text()}`);
        }

        const project = await getRes.json();
        const configs = project.result.deployment_configs;

        // 2. Prepare the update
        const updateBody = {
            deployment_configs: {
                production: {
                    ...configs.production,
                    kv_namespaces: {
                        ...configs.production.kv_namespaces,
                        EMAIL_KV: {
                            namespace_id: KV_NAMESPACE_ID
                        }
                    }
                },
                preview: {
                    ...configs.preview,
                    kv_namespaces: {
                        ...configs.preview.kv_namespaces,
                        EMAIL_KV: {
                            namespace_id: KV_NAMESPACE_ID
                        }
                    }
                }
            }
        };

        // 3. Apply the patch
        const patchRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updateBody)
            }
        );

        const result = await patchRes.json();
        if (!patchRes.ok) {
            throw new Error(`Cloudflare API Error: ${JSON.stringify(result, null, 2)}`);
        }

        console.log('âœ… EMAIL_KV binding added successfully!');
        console.log('   Note: You must REDEPLOY the project for the changes to take effect.');
        console.log('   You can trigger a redeploy from the Cloudflare Dashboard or by pushing to GitHub.');

    } catch (err) {
        console.error('âŒ Error adding KV binding:', err.message);
    }
}

addKvBinding();

