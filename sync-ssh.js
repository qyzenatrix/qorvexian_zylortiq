import fs from 'fs/promises';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

const MAX_FILES_PER_REPO = 20000;

let tempPrivateKeyPath = null;
function getPrivateKeyPath() {
  if (process.env.SSH_PRIVATE_KEY) {
    if (!tempPrivateKeyPath) {
      tempPrivateKeyPath = path.join(os.tmpdir(), `ssh_key_${crypto.randomBytes(4).toString('hex')}`);
      let keyContent = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\r/g, '');
      if (!keyContent.endsWith('\n')) keyContent += '\n';
      writeFileSync(tempPrivateKeyPath, keyContent, { mode: 0o600 });
      console.log(`  [SSH Sync] Using SSH_PRIVATE_KEY from environment`);
    }
    return tempPrivateKeyPath;
  }
  if (process.env.SSH_KEY_PATH) return process.env.SSH_KEY_PATH;
  return '';
}

function getDefaultConfig() {
  return {
    ssh: {
      user: process.env.SSH_USER,
      host: process.env.SSH_HOST,
      port: parseInt(process.env.SSH_PORT),
      privateKeyPath: getPrivateKeyPath(),
      maildir: process.env.SSH_MAILDIR
    },
    outputDir: process.env.OUTPUT_DIR || 'public',
    maxAttachmentSize: parseInt(process.env.MAX_ATTACHMENT_SIZE) || 500 * 1024,
    syncDays: parseInt(process.env.SYNC_DAYS) || 10950,
    maxEmails: parseInt(process.env.MAX_EMAILS) || 30000
  };
}

function generateEmailId(messageId, date) {
  const hash = crypto.createHash('md5')
    .update(messageId + String(date))
    .digest('hex')
    .substring(0, 12);
  return `email-${hash}`;
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-z0-9.-]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 100);
}

async function saveAttachment(attachment, emailId, config) {
  const attachDir = path.join(config.outputDir, 'attachments');
  await fs.mkdir(attachDir, { recursive: true });
  const safeFilename = sanitizeFilename(attachment.filename || 'attachment');
  const filename = `${emailId}-${safeFilename}`;
  const filepath = path.join(attachDir, filename);
  await fs.writeFile(filepath, attachment.content);
  return {
    filename: attachment.filename,
    size: attachment.size,
    type: attachment.contentType,
    url: `/attachments/${filename}`
  };
}

async function convertEmail(buffer, folder, config) {
  const parsed = await simpleParser(buffer);
  const emailDate = parsed.date || new Date();
  const emailId = generateEmailId(parsed.messageId || String(Date.now()), emailDate);

  const attachments = [];
  if (parsed.attachments) {
    for (const att of parsed.attachments) {
      if (att.size <= config.maxAttachmentSize) {
        const saved = await saveAttachment(att, emailId, config);
        attachments.push(saved);
      } else {
        attachments.push({
          filename: att.filename, size: att.size, type: att.contentType, url: null, tooLarge: true
        });
      }
    }
  }

  let preview = '';
  if (parsed.text) {
    preview = parsed.text.replace(/\s+/g, ' ').trim().substring(0, 200);
  }

  return {
    id: emailId,
    messageId: parsed.messageId,
    from: {
      name: parsed.from?.value[0]?.name || '',
      email: parsed.from?.value[0]?.address || ''
    },
    to: (parsed.to?.value || []).map(t => ({
      name: (t.name || '').trim(),
      email: (t.address || '').trim()
    })).filter(t => t.email),
    subject: (parsed.subject || '(No Subject)').trim(),
    date: emailDate.toISOString(),
    preview,
    body: parsed.text || '',
    bodyHtml: parsed.html || parsed.textAsHtml || '',
    attachments,
    folder: folder.toLowerCase(),
    labels: [folder.toLowerCase()],
    read: true,
    starred: false,
    hasAttachments: attachments.length > 0,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
  };
}

async function runSSHCommand(config, command) {
  const { user, host, port, privateKeyPath } = config.ssh;
  let keyArgs = privateKeyPath
    ? `-i "${privateKeyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes`
    : `-o StrictHostKeyChecking=no -o BatchMode=yes`;
  const sshCmd = `ssh ${keyArgs} -p ${port} ${user}@${host} "${command.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
  const { stdout } = await execAsync(sshCmd, { maxBuffer: 1024 * 1024 * 500 });
  return stdout;
}

/**
 * Try common Webuzo/cPanel/Plesk/generic maildir locations and return the
 * first that exists on the remote server.
 *
 * @param {object} config  - full sync config (needs config.ssh)
 * @param {string} userHint - SSH_MAILDIR value: either an email address like
 *                            "junozhou@xotours.net" or an absolute path that
 *                            failed the existence check.
 * @returns {string} resolved absolute maildir path
 */
async function resolveMaildir(config, userHint) {
  // Parse hint into parts whether it's "user@domain" or "/some/path/user"
  const isEmail = userHint.includes('@') && !userHint.startsWith('/');
  let localPart, domain, sysUser;

  if (isEmail) {
    [localPart, domain] = userHint.split('@');
    sysUser = localPart;
  } else {
    // Absolute path that didn't exist — derive hints from the path segments
    const segments = userHint.replace(/\/$/, '').split('/');
    localPart = segments[segments.length - 1];
    // Try to guess domain from second-to-last segment if it looks like one
    const maybeD = segments[segments.length - 2] || '';
    domain = maybeD.includes('.') ? maybeD : '';
    sysUser = localPart;
  }

  const candidates = [
    // ── Primary cPanel/Webuzo account — mail lives directly under ~/mail ──
    `/home/${sysUser}/mail`,
    `/home/xotours/mail`,

    // ── Webuzo / Dovecot vmail ────────────────────────────────────────────
    domain && `/var/vmail/${domain}/${localPart}`,
    domain && `/home/vmail/${domain}/${localPart}`,
    `/var/vmail/${localPart}`,

    // ── cPanel sub-account style ──────────────────────────────────────────
    domain && `/home/${sysUser}/mail/${domain}/${localPart}`,
    `/home/${sysUser}/Maildir`,

    // ── Plesk ─────────────────────────────────────────────────────────────
    domain && `/var/qmail/mailnames/${domain}/${localPart}/Maildir`,

    // ── Webuzo sub-account under hosting home ─────────────────────────────
    domain && `/home/xotours/mail/${domain}/${localPart}`,
    `/home/xotours/mail/${localPart}`,

    // ── Generic fallbacks ─────────────────────────────────────────────────
    `/home/${localPart}/Maildir`,
    `/var/mail/${localPart}`,
    domain && `/mail/${domain}/${localPart}`,
  ].filter(Boolean);

  console.log(`  [SSH Sync] Auto-detecting maildir for "${userHint}"...`);
  console.log(`  [SSH Sync] Will try ${candidates.length} candidate paths:`);

  for (const candidate of candidates) {
    try {
      // A valid Maildir has at least a cur/ or new/ subdirectory
      const checkCmd = `if [ -d "${candidate}/cur" ] || [ -d "${candidate}/new" ]; then echo "EXISTS"; else echo "MISSING"; fi`;
      const result = await runSSHCommand(config, checkCmd);
      if (result.trim() === 'EXISTS') {
        console.log(`  [SSH Sync] ✓ Found maildir: ${candidate}`);
        return candidate;
      } else {
        console.log(`  [SSH Sync]   ✗ ${candidate}`);
      }
    } catch (e) {
      console.log(`  [SSH Sync]   ✗ ${candidate} (${e.message.split('\n')[0].trim()})`);
    }
  }

  // ── Last resort: server-side find ─────────────────────────────────────
  console.log(`  [SSH Sync] Running server-side find as last resort...`);
  try {
    const searchRoots = '/var/vmail /home/vmail /home /var/mail /mail';
    const findCmd = `find ${searchRoots} -maxdepth 6 -type d -name 'cur' 2>/dev/null | grep -i '${localPart}' | head -10`;
    const found = await runSSHCommand(config, findCmd);
    const lines = found.split('\n').map(l => l.trim()).filter(Boolean);

    if (lines.length > 0) {
      // Prefer the match that also contains the domain name
      const preferred = domain
        ? lines.find(l => l.includes(domain)) || lines[0]
        : lines[0];
      const resolved = preferred.replace(/\/cur$/, '');
      console.log(`  [SSH Sync] ✓ Server find resolved: ${resolved}`);
      if (lines.length > 1) {
        console.log(`  [SSH Sync]   Other candidates found:`);
        lines.filter(l => l !== preferred).forEach(l => console.log(`  [SSH Sync]     ${l}`));
      }
      return resolved;
    }
  } catch (e) {
    console.log(`  [SSH Sync]   Server-side find failed: ${e.message.split('\n')[0].trim()}`);
  }

  throw new Error(
    `Could not find a valid Maildir for "${userHint}" on the remote server.\n` +
    `Tried paths:\n  ${candidates.join('\n  ')}\n` +
    `Fix: set SSH_MAILDIR to the correct absolute path (e.g. /var/vmail/xotours.net/junozhou).`
  );
}

/**
 * Group emails by calendar year.
 * Returns: Map<number, Email[]>  e.g.  { 2022: [...], 2023: [...], 2024: [...] }
 */
function groupEmailsByYear(emails) {
  const byYear = new Map();
  for (const email of emails) {
    const year = new Date(email.date).getFullYear();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(email);
  }
  return byYear;
}

/**
 * Build repo chunks so no single repo exceeds MAX_FILES_PER_REPO.
 */
function buildRepoChunks(byYear) {
  const sortedYears = [...byYear.keys()].sort((a, b) => a - b);
  const chunks = [];
  let current = null;

  for (const year of sortedYears) {
    const yearEmails = byYear.get(year);

    if (!current) {
      current = { years: [year], emails: [...yearEmails] };
    } else if (current.emails.length + yearEmails.length <= MAX_FILES_PER_REPO) {
      current.years.push(year);
      current.emails.push(...yearEmails);
    } else {
      chunks.push(current);
      current = { years: [year], emails: [...yearEmails] };
    }
  }

  if (current) chunks.push(current);

  return chunks.map((chunk, idx) => ({
    name: idx === 0 ? 'main' : `emails-archive-${chunk.years[0]}`,
    years: chunk.years,
    emails: chunk.emails,
    yearStart: Math.min(...chunk.years),
    yearEnd: Math.max(...chunk.years),
  }));
}

/**
 * Write all repo output files plus a manifest.
 */
async function writeRepoOutputs(chunks, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalEmails: chunks.reduce((s, c) => s + c.emails.length, 0),
    repos: []
  };

  for (const chunk of chunks) {
    const filename = chunk.name === 'main' ? 'emails.json' : `${chunk.name}.json`;
    const filepath = path.join(outputDir, filename);

    const sorted = [...chunk.emails].sort((a, b) => new Date(b.date) - new Date(a.date));

    await fs.writeFile(filepath, JSON.stringify(sorted, null, 2));
    console.log(`  [Repo Split] Wrote ${sorted.length} emails → ${filename}`);

    manifest.repos.push({
      name: chunk.name,
      file: filename,
      emailCount: sorted.length,
      yearStart: chunk.yearStart,
      yearEnd: chunk.yearEnd,
    });
  }

  manifest.repos.sort((a, b) => b.yearEnd - a.yearEnd);

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  [Repo Split] Wrote manifest.json (${chunks.length} repo(s))`);

  return manifest;
}

/**
 * Main SSH sync entry point.
 */
async function syncEmailsSSH(customConfig = {}) {
  const config = { ...getDefaultConfig(), ...customConfig };
  if (customConfig.ssh) {
    config.ssh = { ...getDefaultConfig().ssh, ...customConfig.ssh };
  }

  // ── Resolve maildir path ───────────────────────────────────────────────
  let maildir = config.ssh.maildir;
  if (!maildir) {
    throw new Error(
      'SSH_MAILDIR must be set. Use an email address (e.g. junozhou@xotours.net) ' +
      'or an absolute path (e.g. /var/vmail/xotours.net/junozhou).'
    );
  }

  if (!maildir.startsWith('/')) {
    // Looks like an email address — auto-detect the path
    maildir = await resolveMaildir(config, maildir);
  } else {
    // Absolute path provided — verify it actually exists on the server
    try {
      const checkCmd = `if [ -d "${maildir}/cur" ] || [ -d "${maildir}/new" ]; then echo "EXISTS"; else echo "MISSING"; fi`;
      const result = await runSSHCommand(config, checkCmd);
      if (result.trim() !== 'EXISTS') {
        console.log(`  [SSH Sync] ⚠️  SSH_MAILDIR "${maildir}" not found — attempting auto-detect...`);
        maildir = await resolveMaildir(config, maildir);
      } else {
        console.log(`  [SSH Sync] ✓ SSH_MAILDIR verified: ${maildir}`);
      }
    } catch (e) {
      console.log(`  [SSH Sync] ⚠️  Could not verify SSH_MAILDIR — attempting auto-detect...`);
      maildir = await resolveMaildir(config, maildir);
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  console.log(`\n  [SSH Sync] Connecting to ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`);
  console.log(`  [SSH Sync] Maildir Path: ${maildir}`);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - (config.syncDays || 30));
  const mtimeDays = config.syncDays || 30;

  const foldersToSync = [
    { name: 'inbox', path: `${maildir}/new/` },
    { name: 'inbox', path: `${maildir}/cur/` },
    { name: 'sent',  path: `${maildir}/.Sent/cur/` },
    { name: 'sent',  path: `${maildir}/.Sent/new/` }
  ];

  const SSH_INDEX_PATH = path.join(config.outputDir || 'public', 'ssh-index.json');
  let knownFiles = new Set();
  try {
    if (await fs.stat(SSH_INDEX_PATH).catch(() => false)) {
      const indexData = await fs.readFile(SSH_INDEX_PATH, 'utf8');
      knownFiles = new Set(JSON.parse(indexData));
      console.log(`  [SSH Sync] Loaded ${knownFiles.size} known files from ssh-index.json`);
    }
  } catch (e) {
    console.log(`  [SSH Sync] No existing ssh-index.json found or invalid. Starting fresh.`);
  }

  const allEmails = [];
  const newKnownFiles = new Set(knownFiles);

  for (const folder of foldersToSync) {
    console.log(`  [SSH Sync] Scanning ${folder.path} (last ${mtimeDays} days)...`);

    try {
      const findCmd = `find ${folder.path} -type f -mtime -${mtimeDays} ! -size +50M`;
      const fileListRaw = await runSSHCommand(config, findCmd);
      const files = fileListRaw.split(/\r?\n/).map(f => f.trim()).filter(f => f.length > 0);

      if (files.length === 0) {
        console.log(`  [SSH Sync] No files found in ${folder.path}.`);
        continue;
      }

      const allUnseen = [];
      for (const filePath of files) {
        const baseName = path.basename(filePath).split(':')[0];
        if (!knownFiles.has(baseName)) {
          allUnseen.push({ filePath, baseName });
        }
      }

      const fetchFiles = allUnseen.slice(0, config.maxEmails || 30000);
      console.log(`  [SSH Sync] Found ${files.length} total, ${allUnseen.length} unseen. Fetching ${fetchFiles.length}...`);
      if (fetchFiles.length === 0) continue;

      const chunkSize = 10;
      for (let i = 0; i < fetchFiles.length; i += chunkSize) {
        const chunk = fetchFiles.slice(i, i + chunkSize);
        console.log(`  [SSH Sync] Fetching batch ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(fetchFiles.length / chunkSize)}...`);

        try {
          const chunkFilesEscaped = chunk.map(f => `"${f.filePath.replace(/"/g, '\\"')}"`).join(' ');
          const catCmd = `for f in ${chunkFilesEscaped}; do echo "===EMAIL_DELIM_START==="; echo "$f"; echo "===FILENAME_END==="; base64 "$f" 2>/dev/null; echo "===EMAIL_DELIM_END==="; done`;
          const rawOutput = await runSSHCommand(config, catCmd);
          const parts = rawOutput.split("===EMAIL_DELIM_START===");

          for (const part of parts) {
            if (!part.trim()) continue;

            const filenameEndIdx = part.indexOf("===FILENAME_END===");
            const endIdx = part.indexOf("===EMAIL_DELIM_END===");

            if (filenameEndIdx === -1 || endIdx === -1) {
              console.error(`  [SSH Sync] Malformed chunk, missing delimiters.`);
              continue;
            }

            const filePath = part.substring(0, filenameEndIdx).trim();
            let rawEmailBase64 = part.substring(filenameEndIdx + "===FILENAME_END===".length, endIdx);
            rawEmailBase64 = rawEmailBase64.replace(/\s+/g, '');

            if (rawEmailBase64.length === 0) {
              console.error(`  [SSH Sync] Empty base64 payload for ${filePath}.`);
              continue;
            }

            try {
              const buffer = Buffer.from(rawEmailBase64, 'base64');
              const parsedData = await convertEmail(buffer, folder.name, config);

              const baseItem = chunk.find(c => c.filePath === filePath);
              if (baseItem) newKnownFiles.add(baseItem.baseName);

              if (new Date(parsedData.date) >= cutoffDate) {
                allEmails.push(parsedData);
              }
            } catch (err) {
              console.error(`  [SSH Sync] Failed to parse email ${filePath}: ${err.message}`);
            }
          }
        } catch (e) {
          console.error(`  [SSH Sync] Error fetching batch ${Math.floor(i / chunkSize) + 1}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  [SSH Sync] Error scanning folder ${folder.path}: ${e.message}`);
    }
  }

  // Persist ssh-index
  try {
    await fs.writeFile(SSH_INDEX_PATH, JSON.stringify(Array.from(newKnownFiles)));
    console.log(`  [SSH Sync] Saved ${newKnownFiles.size} base names to ssh-index.json`);
  } catch (e) {
    console.error(`  [SSH Sync] Failed to save ssh-index.json: ${e.message}`);
  }

  console.log(`  [SSH Sync] Fetched ${allEmails.length} new emails from server.`);

  // ── Load Existing Emails ───────────────────────────────────────────────
  let existingEmails = [];
  const manifestPath = path.join(config.outputDir || 'public', 'manifest.json');
  try {
    if (await fs.stat(manifestPath).catch(() => false)) {
      const manifestStr = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestStr);
      for (const repo of manifest.repos || []) {
        const repoPath = path.join(config.outputDir || 'public', repo.file);
        if (await fs.stat(repoPath).catch(() => false)) {
          const repoDataStr = await fs.readFile(repoPath, 'utf8');
          const repoData = JSON.parse(repoDataStr);
          existingEmails.push(...repoData);
        }
      }
      console.log(`  [SSH Sync] Loaded ${existingEmails.length} existing emails from repos.`);
    } else {
      const emailsPath = path.join(config.outputDir || 'public', 'emails.json');
      if (await fs.stat(emailsPath).catch(() => false)) {
        const emailsStr = await fs.readFile(emailsPath, 'utf8');
        existingEmails = JSON.parse(emailsStr);
        console.log(`  [SSH Sync] Loaded ${existingEmails.length} existing emails from emails.json.`);
      }
    }
  } catch (e) {
    console.log(`  [SSH Sync] Failed to load existing emails: ${e.message}`);
  }

  const allMergedEmailsMap = new Map();
  for (const email of existingEmails) {
    allMergedEmailsMap.set(email.id, email);
  }
  for (const email of allEmails) {
    allMergedEmailsMap.set(email.id, email);
  }
  const finalAllEmails = Array.from(allMergedEmailsMap.values());

  // ── Repo-splitting logic ───────────────────────────────────────────────
  const totalFiles = finalAllEmails.length;
  console.log(`\n  [Repo Split] Total emails to store: ${totalFiles}`);
  console.log(`  [Repo Split] Limit per repo: ${MAX_FILES_PER_REPO}`);

  if (totalFiles <= MAX_FILES_PER_REPO) {
    console.log(`  [Repo Split] Under limit — writing single emails.json`);
    const sorted = [...finalAllEmails].sort((a, b) => new Date(b.date) - new Date(a.date));
    const outPath = path.join(config.outputDir, 'emails.json');
    await fs.mkdir(config.outputDir, { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(sorted, null, 2));

    const manifest = {
      generatedAt: new Date().toISOString(),
      totalEmails: sorted.length,
      repos: [{
        name: 'main',
        file: 'emails.json',
        emailCount: sorted.length,
        yearStart: sorted.length ? new Date(sorted[sorted.length - 1].date).getFullYear() : null,
        yearEnd:   sorted.length ? new Date(sorted[0].date).getFullYear() : null,
      }]
    };
    await fs.writeFile(path.join(config.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`  [Repo Split] Done. Single repo, ${sorted.length} emails.`);
  } else {
    console.log(`  [Repo Split] Over limit — splitting by year into archive repos...`);
    const byYear = groupEmailsByYear(finalAllEmails);
    console.log(`  [Repo Split] Years found: ${[...byYear.keys()].sort().join(', ')}`);
    const chunks = buildRepoChunks(byYear);
    console.log(`  [Repo Split] Will create ${chunks.length} repo(s):`);
    for (const c of chunks) {
      console.log(`    → ${c.name}  years: ${c.yearStart}–${c.yearEnd}  emails: ${c.emails.length}`);
    }
    await writeRepoOutputs(chunks, config.outputDir);
  }
  // ──────────────────────────────────────────────────────────────────────

  return finalAllEmails;
}

export { syncEmailsSSH };

// Allow testing directly from CLI: `node sync-ssh.js`
import url from 'url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  import('dotenv').then(dotenv => {
    dotenv.config({ override: true });
    console.log("🚀 Running Test SSH Sync directly...");
    syncEmailsSSH()
      .then(emails => {
        console.log(`\n✅ TEST SUCCESS: Extracted ${emails.length} emails!`);
        if (emails.length > 0) console.log("First email subject:", emails[0].subject);
        process.exit(0);
      })
      .catch(err => {
        console.error("\n❌ TEST FAILED:");
        console.error(err);
        process.exit(1);
      });
  });
}