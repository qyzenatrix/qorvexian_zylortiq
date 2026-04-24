import { config, parse } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logStream = fs.createWriteStream(path.join(process.cwd(), 'debug.log'), { flags: 'a' });
function log(msg) {
    console.log(msg);
    logStream.write(msg + '\n');
}

const CLOUDFLARE_API_TOKEN = (process.env.CF_API_TOKEN || process.env.GLOUDFLARE_API || '').trim();
const ACCOUNT_ID = (process.env.CF_ID || 'd4336e2049af94b65acdacd750014877').trim();
const PROJECT_NAME = (process.env.PROJECT_NAME || 'email-cosmosim-service-ca').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GIT_TOKEN || '').trim();
const GITHUB_OWNER = (process.env.GITHUB_OWNER || 'qyzenatrix').trim();

async function updateCloudflareEnv() {
    log(`🚀 Updating environment variables for ${PROJECT_NAME} on Cloudflare...`);
    log(`   Time: ${new Date().toISOString()}`);

    if (!GITHUB_TOKEN) {
        log('❌ GITHUB_TOKEN or GIT_TOKEN not found in .env');
        return;
    }

    try {
        log(`Fetching project details for ${PROJECT_NAME}...`);
        const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}`;
        log(`URL: ${url}`);

        const getResponse = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        log(`GET Status: ${getResponse.status}`);
        const projectData = await getResponse.json();

        if (!getResponse.ok) {
            log(`❌ GET Failed: ${JSON.stringify(projectData.errors)}`);
            return;
        }
        const existingConfigs = projectData.result.deployment_configs;

        // Prepare updated variables
        // Merging existing vars with new ones
        const devVarsPath = path.join(process.cwd(), '.dev.vars');
        let devVars = {};
        if (fs.existsSync(devVarsPath)) {
            log('Reading .dev.vars...');
            const rawVars = parse(fs.readFileSync(devVarsPath));
            // Transform rawVars to { value: "..." } format
            Object.keys(rawVars).forEach(key => {
                devVars[key] = { value: rawVars[key] };
            });
        }

        const newVars = {
            ...(existingConfigs.production.env_vars || {}),
            ...devVars,
            GITHUB_TOKEN: { value: GITHUB_TOKEN },
            PROJECT_NAME: { value: PROJECT_NAME },
            GITHUB_REPO: { value: `${process.env.GITHUB_OWNER || 'qyzenatrix'}/${PROJECT_NAME}` },
            GITHUB_BRANCH: { value: 'master' }
        };

        // Do NOT upload local dev variables to Cloudflare Pages production env text vars
        delete newVars['EMAIL_KV']; // Keep it as a true KV Namespace binding
        delete newVars['REPLY_SERVER_URL'];
        delete newVars['DEBUG'];

        // Remove any undefined values and fix any non-object values
        Object.keys(newVars).forEach(key => {
            if (newVars[key] === undefined || newVars[key] === null) {
                delete newVars[key];
            } else if (typeof newVars[key] === 'string') {
                newVars[key] = { value: newVars[key] };
            }
        });

        log(`Sending PATCH with ${Object.keys(newVars).length} variables...`);

        const patchResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT_NAME}`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    deployment_configs: {
                        production: {
                            env_vars: newVars
                        },
                        preview: {
                            env_vars: newVars
                        }
                    }
                })
            }
        );

        const data = await patchResponse.json();

        if (!patchResponse.ok) {
            log(`❌ PATCH Failed: ${JSON.stringify(data.errors, null, 2)}`);
            log(`   Full Response: ${JSON.stringify(data, null, 2)}`);
            return;
        }

        log('✅ Environment variables updated successfully!');
        log('   Variables set: GITHUB_TOKEN, PROJECT_NAME, GITHUB_REPO, GITHUB_BRANCH');
        log('   Note: You may need to trigger a new deployment for these to take effect.\n');

    } catch (error) {
        log('❌ Error updating Cloudflare variables:');
        log(error.message);
    }
}

updateCloudflareEnv();
