#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

/**
 * Automatically create Cloudflare Pages project and connect to GitHub
 */

const CLOUDFLARE_API_TOKEN = process.env.CF_API_TOKEN || process.env.GLOUDFLARE_API;
const ACCOUNT_ID = process.env.CF_ID || 'd4336e2049af94b65acdacd750014877';
const PROJECT_NAME = process.env.PROJECT_NAME || 'email-cosmosim-service-ca';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'qyzenatrix';
const GITHUB_REPO = process.env.GITHUB_REPO || 'email-cosmosim-service-ca';

async function createPagesProject() {
    console.log('ðŸš€ Creating Cloudflare Pages project...\n');

    try {
        const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: PROJECT_NAME,
                    production_branch: 'master',
                    source: {
                        type: 'github',
                        config: {
                            owner: GITHUB_OWNER,
                            repo_name: GITHUB_REPO,
                            production_branch: 'master',
                            pr_comments_enabled: false,
                            deployments_enabled: true,
                            production_deployments_enabled: true,
                            preview_deployments_enabled: false
                        }
                    },
                    build_config: {
                        build_command: '',
                        destination_dir: 'public',
                        root_dir: '',
                        web_analytics_tag: null,
                        web_analytics_token: null
                    },
                    deployment_configs: {
                        production: {
                            environment_variables: {
                                NODE_VERSION: '20'
                            },
                            compatibility_date: '2024-01-01',
                            compatibility_flags: []
                        }
                    }
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            // Check if project already exists
            if (data.errors?.[0]?.message?.includes('already exists') ||
                data.errors?.[0]?.code === 8000007) {
                console.log('â„¹ï¸  Pages project already exists!');
                console.log(`   URL: https://${PROJECT_NAME}.pages.dev\n`);
                return true;
            }

            throw new Error(`Cloudflare API Error: ${JSON.stringify(data, null, 2)}`);
        }

        console.log('âœ… Pages project created successfully!\n');
        console.log(`ðŸ“¦ Project Details:`);
        console.log(`   Name: ${data.result.name}`);
        console.log(`   URL: https://${data.result.subdomain}.pages.dev`);
        console.log(`   Production Branch: ${data.result.production_branch}`);
        console.log(`   Build Output: public/\n`);

        return true;

    } catch (error) {
        console.error('âŒ Error creating Pages project:');
        console.error(error.message);
        return false;
    }
}

// Run
createPagesProject();

