process.on('unhandledRejection', (reason, promise) => { console.error('>>> [CRITICAL] Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('>>> [CRITICAL] Uncaught Exception:', err); });

// Server starts IMMEDIATELY on require() — port 7860 opens before anything else
const { setClient } = require('./server');
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, REST, Routes, StringSelectMenuBuilder } = require('discord.js');
const { ProxyAgent } = require('undici');
const mongoose = require('mongoose');
const { Hub, TempChannel, LfmMessage, GuildSettings, UserPoints, QueueConfig, ActiveQueuePlayer, Match, PointHistory, Permission, VerifiedUser, BlacklistedUser, Application } = require('./models');
const { getStatsEmbed, getSearchEmbed } = require('./stats');
const { safeFetch, createDiscordRestAdapter, safeInteractionReply, safeInteractionEditReply, safeInteractionDeferReply, safeInteractionFollowUp, safeMessageReply, safeChannelSend, safeUserSend } = require('./safe-utils');
const fs = require('fs');
require('dotenv').config();

function canAcknowledgeInteraction(interaction) {
    return interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged());
}

async function safeDeferReply(interaction, options = {}) {
    if (canAcknowledgeInteraction(interaction)) return false;
    try {
        await safeInteractionDeferReply(interaction, options);
        return true;
    } catch (err) {
        console.error('>>> [ERROR] Defer failed:', err.message);
        return false;
    }
}

async function safeReply(interaction, response) {
    if (!interaction?.isRepliable?.()) return null;
    try {
        if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) {
            return await safeInteractionFollowUp(interaction, response);
        }
        return await safeInteractionReply(interaction, response);
    } catch (err) {
        console.error('>>> [ERROR] Safe reply failed:', err.message);
        return null;
    }
}

async function safeEditReply(interaction, response) {
    if (!interaction?.isRepliable?.()) return null;
    try {
        if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) {
            return await safeInteractionEditReply(interaction, response);
        }
        return await safeInteractionReply(interaction, response);
    } catch (err) {
        console.error('>>> [ERROR] Safe edit failed:', err.message);
        if (interaction.replied || interaction.deferred || (typeof interaction.isAcknowledged === 'function' && interaction.isAcknowledged())) {
            try {
                return await safeInteractionFollowUp(interaction, response);
            } catch (err2) {
                console.error('>>> [ERROR] Follow-up after failed editReply also failed:', err2.message);
            }
        }
        return null;
    }
}

const APP_DATA = {
    'Staff': {
        roleId: '1504188023154409595',
        questions: [
            'How would you handle a member breaking rules in chat?',
            'What’s your approach to resolving conflicts between members?',
            'How do you ensure fairness and avoid bias when moderating?',
            'Give an example of a time you had to enforce rules in another community.'
        ]
    },
    'Referee': {
        roleId: '1503846121229910076',
        questions: [
            'Do you understand the scrim rules and point system? (Explain briefly)',
            'How would you handle disputes about match results or penalties?',
            'Are you comfortable recording highlights and reporting violations?',
            'What steps would you take if a player leaves queue without reason?'
        ]
    },
    'Hoster': {
        roleId: '1503763751029964970',
        questions: [
            'How would you organize and manage a scrim queue?',
            'What’s your process for ensuring matches start smoothly?',
            'How would you deal with players who don’t join voice chat (JVC)?',
            'Do you have experience managing private server links or substitutes?'
        ]
    }
};

const APP_CHANNEL_ID = '1510288244581859459';
const ALLOWED_APP_COMMAND_ROLES = ['1503745954627584172', '1503746115470757958'];
const activeApplications = new Map(); // userId -> { appType, currentQuestionIndex, answers: [] }

const defaultPermissions = {
    setup: ["1503745954627584172"],
    'queue-enable': ["1503745954627584172"],
    'queue-disable': ["1503745954627584172"],
    go: ["1503745954627584172"],
    help: ["1503746241484427296"],
    stats: ["1503746241484427296"],
    queueend: ["1503745954627584172"],
    cancel: ["1503746241484427296"],
    ping: ["1503746241484427296"],
    gamevote: ["1503746241484427296"],
    givepoints: ["1503745954627584172"],
    removepoints: ["1503745954627584172"],
    ppq: ["1503745954627584172"],
    'set-leaderboard': ["1503745954627584172"],
    'set-permissions': ["1503745954627584172"],
    'permissions-info': ["1503745954627584172"],
    refresh: ["1503745954627584172"],
    search: ["1503746241484427296"],
    verify: [],
    startqueue: ["1503745954627584172"],
    renew_queue_players: ["1503745954627584172"],
    blacklist: ["1503745954627584172"],
    substitute: ["1503746241484427296"],
    substitutes: ["1503745954627584172"],
    swap: ["1503745954627584172"],
    every_cmd: ["1503745954627584172"]
};

function loadPermissions() {
    if (!fs.existsSync('./permissions.txt')) {
        if (fs.existsSync('./permissions.json')) {
            try {
                const jsonPerms = JSON.parse(fs.readFileSync('./permissions.json', 'utf8'));
                savePermissions(jsonPerms);
                return jsonPerms;
            } catch (e) {
                console.error('Error migrating permissions.json:', e.message);
            }
        }
        savePermissions(defaultPermissions);
        return defaultPermissions;
    }

    try {
        const content = fs.readFileSync('./permissions.txt', 'utf8');
        const lines = content.split('\n');
        const perms = {};
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split('=');
            if (parts.length >= 2) {
                let cmd = parts[0].trim().toLowerCase();
                if (cmd.startsWith('/')) cmd = cmd.slice(1);
                
                const roles = parts[1]
                    .split(',')
                    .map(r => r.trim().replace(/[<@&>]/g, ''))
                    .filter(r => r.length > 0);
                perms[cmd] = roles;
            }
        }
        
        for (const cmd of Object.keys(defaultPermissions)) {
            if (!perms[cmd]) {
                perms[cmd] = defaultPermissions[cmd];
            }
        }
        return perms;
    } catch (e) {
        console.error('Error reading permissions.txt:', e.message);
        return defaultPermissions;
    }
}

async function savePermissions(perms) {
    try {
        const lines = [];
        for (const [cmd, roles] of Object.entries(perms)) {
            lines.push(`/${cmd} = ${roles.join(', ')}`);
        }
        fs.writeFileSync('./permissions.txt', lines.join('\n'), 'utf8');

        if (mongoose.connection.readyState === 1) {
            for (const [cmd, roles] of Object.entries(perms)) {
                await Permission.findOneAndUpdate(
                    { commandName: cmd },
                    { roles },
                    { upsert: true }
                ).catch(err => console.error(`>>> [DB-PERMS] Failed to save permission for ${cmd}:`, err.message));
            }
        }
    } catch (e) {
        console.error('Error writing permissions.txt:', e.message);
    }
}

let permissions = loadPermissions();

console.log(">>> [BOOT] Environment Keys:", Object.keys(process.env).filter(k => !k.toLowerCase().includes('token') && !k.toLowerCase().includes('secret') && !k.toLowerCase().includes('key') && !k.toLowerCase().includes('pass') && !k.toLowerCase().includes('auth') && !k.toLowerCase().includes('uri') && !k.toLowerCase().includes('url')));

let discordReady = false;

const ALLOWED_GUILDS = ['1503745265285464084', '1504397530765721630'];
const matchMvpVotes = new Map();
const matchLocks = new Set();
const lastVcPlayers = new Map();
const suppressMidGameLeaveNotify = new Set();
// --- Slash Commands Metadata ---
const slashCommands = [
    { name: 'send-apps', description: 'Send an application request to a user', options: [
        { name: 'user', description: 'The user to send the application to', type: 6, required: true },
        { name: 'app_type', description: 'The type of application', type: 3, required: true, choices: [
            { name: 'Staff', value: 'Staff' },
            { name: 'Referee', value: 'Referee' },
            { name: 'Hoster', value: 'Hoster' }
        ]}
    ] },
    { name: 'dm', description: 'Send a DM to a user as the bot', options: [{ name: 'user', description: 'The user to DM', type: 6, required: true }, { name: 'message', description: 'The message to send', type: 3, required: true }] },
    { name: 'apply', description: 'Apply for a Staff, Referee, or Hoster position', options: [{ name: 'position', description: 'The position to apply for', type: 3, required: true, choices: [{ name: 'Staff', value: 'Staff' }, { name: 'Referee', value: 'Referee' }, { name: 'Hoster', value: 'Hoster' }] }] },
    { name: 'setup', description: 'Shows bot setup instructions' },
    { name: 'verify', description: 'Links your Discord account to your Roblox account using Bloxlink' },
    { name: 'queue-enable', description: 'Starts queue loop in the current channel', options: [{ name: 'interval', description: 'Minutes between queues', type: 4, required: true }] },
    { name: 'queue-disable', description: 'Stops the queue loop and clears the queue in the current channel' },
    { name: 'go', description: 'Sends immediate queue message in the current channel' },
    { name: 'help', description: 'Shows all commands' },
    { name: 'stats', description: 'Shows player stats', options: [{ name: 'user', description: 'The user to check stats for', type: 6, required: false }] },
    { name: 'queueend', description: 'Ends a specific queue/match and deletes its category', options: [{ name: 'number', description: 'The match ID to end', type: 4, required: true }] },
    { name: 'cancel', description: 'Starts a vote to end/cancel the current match' },
    { name: 'ping', description: 'Checks latency' },
    { name: 'gamevote', description: 'Starts a vote for which team won (Team 1 or Team 2)' },
    { name: 'givepoints', description: 'Give points to a player', options: [{ name: 'user', description: 'The user to give points to', type: 6, required: true }, { name: 'amount', description: 'Amount of points to give', type: 4, required: true }] },
    { name: 'removepoints', description: 'Remove points from a player', options: [{ name: 'user', description: 'The user to remove points from', type: 6, required: true }, { name: 'amount', description: 'Amount of points to remove', type: 4, required: true }] },
    { name: 'ppq', description: 'Set required players per queue for this channel', options: [{ name: 'players', description: 'Number of required players', type: 4, required: true }] },
    { name: 'set-leaderboard', description: 'Sets the leaderboard channel for this guild' },
    { name: 'set-permissions', description: 'Update permissions for a specific role', options: [{ name: 'role', description: 'The role mention or ID to update permissions for', type: 3, required: true }, { name: 'commands', description: 'Comma-separated list of commands to grant to this role (e.g. queue-enable, go, ppq)', type: 3, required: true }] },
    { name: 'permissions-info', description: 'Shows which roles have which permissions' },
    { name: 'search', description: 'Search for a verified Discord player and view their Roblox & Scrim profile', options: [{ name: 'user', description: 'The Discord user to search', type: 6, required: true }] },
    { name: 'refresh', description: 'Owner-only hard reset of all stats, queues, and history' },
    { name: 'startqueue', description: 'Force starts the active queue even if there are not enough players', options: [{ name: 'queuenumber', description: 'The custom match ID/number to assign', type: 4, required: true }] },
    { name: 'renew_queue_players', description: 'Updates active queue/match players to only those inside the pre-match voice channel', options: [{ name: 'queuenumber', description: 'The queue/match number to renew', type: 4, required: true }] },
    { name: 'blacklist', description: 'Blacklists a player from joining queues and queue VCs for a specific duration', options: [
        { name: 'user', description: 'The user to blacklist', type: 6, required: true },
        { name: 'duration', description: 'Duration (e.g. 1d, 12h, 30m)', type: 3, required: true }
    ] },
    { name: 'substitute', description: 'Request a loan replacement for yourself in the current queue' },
    { name: 'substitutes', description: 'Manually check and request replacements for players missing from the pre-match VC' },
    { name: 'swap', description: 'Swap a missing player in the active match with another player', options: [
        { name: 'player1', description: 'The player that did not join and is being swapped out', type: 6, required: true },
        { name: 'player2', description: 'The player taking player1\'s spot', type: 6, required: true }
    ] }
];

const { sendQueueMessage, handleQueueInteraction, queueIntervals, startCaptainSelection, createMatch, checkAndSendSubstitutionAlert, handleSubRequestInteraction, sendMidMatchLeaveSubAlert, autoBlacklistPlayer } = require('./queue');

async function updateUserPoints(userId, guildId, pointsInc, winsInc = 0, lossesInc = 0, gamesInc = 0) {
    let data = await UserPoints.findOne({ userId, guildId });
    if (!data) {
        data = new UserPoints({
            userId,
            guildId,
            points: 1000,
            wins: 0,
            losses: 0,
            totalGames: 0
        });
    }
    data.points += pointsInc;
    data.wins += winsInc;
    data.losses += lossesInc;
    data.totalGames += gamesInc;
    return await data.save();
}

async function tryBloxlinkVerify(member, guild, client) {
    const apiKey = process.env.BLOXLINK_API_KEY;
    if (!apiKey) return null;

    try {
        const res = await safeFetch(`https://api.blox.link/v4/public/guilds/${guild.id}/discord-to-roblox/${member.id}`, {
            headers: { 'Authorization': apiKey },
            timeout: 18000
        }).catch(() => null);

        if (!res || !res.ok) return null;

        const data = await res.json();
        const robloxIdStr = data.robloxID || (data.resolved && data.resolved.roblox && data.resolved.roblox.id);
        if (!robloxIdStr) return null;

        const robloxId = parseInt(robloxIdStr, 10);
        if (isNaN(robloxId)) return null;

        // Fetch Roblox username from Roblox Users API
        const userRes = await safeFetch(`https://users.roblox.com/v1/users/${robloxId}`, { timeout: 18000 }).catch(() => null);
        if (!userRes || !userRes.ok) return null;

        const userData = await userRes.json();
        const finalUsername = userData.name;

        // Save to Database
        await VerifiedUser.findOneAndUpdate(
            { discordId: member.id },
            { robloxId, robloxUsername: finalUsername },
            { upsert: true, new: true }
        );

        // Update Nickname: Discord Name [Roblox Name]
        const discordName = member.user.globalName || member.user.username;
        let newNickname = `${discordName} [${finalUsername}]`;
        
        // Discord nicknames must be <= 32 characters
        if (newNickname.length > 32) {
            const maxLength = 32 - ` [${finalUsername}]`.length;
            if (maxLength > 0) {
                newNickname = `${discordName.substring(0, maxLength)} [${finalUsername}]`;
            } else {
                newNickname = finalUsername.substring(0, 32);
            }
        }

        let nicknameResult = "";
        try {
            await member.setNickname(newNickname);
            nicknameResult = `\n👤 Your server nickname has been updated to: \`${newNickname}\`.`;
        } catch (nickErr) {
            console.warn(`>>> [VERIFY] Could not update nickname for user ${member.id}:`, nickErr.message);
            nicknameResult = `\n⚠️ *Could not update your nickname automatically (I don't have permission to change your nickname, e.g. if you are an Administrator or Owner).*`;
        }

        // Assign the player role 1503746241484427296
        const playerRoleId = '1503746241484427296';
        try {
            if (!member.roles.cache.has(playerRoleId)) {
                await member.roles.add(playerRoleId);
                nicknameResult += `\n🎖️ You have been granted the **Player** role!`;
            }
        } catch (roleErr) {
            console.warn(`>>> [VERIFY] Could not add player role to user ${member.id}:`, roleErr.message);
            nicknameResult += `\n⚠️ *Could not assign the Player role automatically. Please contact an admin.*`;
        }

        return {
            success: true,
            robloxUsername: finalUsername,
            nicknameResult
        };
    } catch (err) {
        console.error(">>> [ERROR] Bloxlink verification check failed:", err.message);
        return null;
    }
}



async function start() {
    console.log(">>> [BOOT] index.js loaded. Triggering start()...");
    let updateLeaderboard;

    // === STEP 1: Create Discord Client ===
    const proxyUri = process.env.PROXY_URL;
    
    if (!proxyUri) {
        console.error(">>> [WARN] PROXY_URL environment variable is missing!");
    }

    const proxyAgent = proxyUri ? new ProxyAgent({ uri: proxyUri }) : null;
    
    const clientOptions = {
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
        rest: {
            timeout: 30000,
            makeRequestFetchAdapter: createDiscordRestAdapter(proxyAgent)
        }
    };
    
    let client = new Client(clientOptions);
    setClient(client);

    client.rest.on('rateLimited', (info) => {
        const route = info.route || info.path || info.method || 'unknown';
        console.warn(`>>> [REST] Rate limited on route: ${route}. Limit: ${info.limit}, Timeout: ${info.timeToReset}ms`);
    });

    // === STEP 4: Setup Event Handlers ===
    client.once('ready', async () => {
        console.log(`>>> [BOOT] Logged in as ${client.user.tag}!`);
        try {
            // Clean up global commands so there's no caching delay or duplicate issues
            await client.rest.put(Routes.applicationCommands(client.user.id), { body: [] });
            console.log('✅ Cleaned up global slash commands.');

            // Fetch and log all guilds the bot is in, and deploy commands to them
            const oauthGuilds = await client.guilds.fetch().catch(() => new Map());
            console.log(`>>> [BOOT] Bot is currently in ${oauthGuilds.size} guilds:`);
            for (const [guildId, oauthGuild] of oauthGuilds) {
                console.log(`  - ${oauthGuild.name} (${guildId})`);
                await client.rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: slashCommands })
                    .then(() => console.log(`✅ Guild slash commands registered instantly for: ${oauthGuild.name} (${guildId})`))
                    .catch(err => console.error(`❌ Failed to register commands for ${oauthGuild.name} (${guildId}):`, err.message));
            }

            // Pre-configure leaderboard channel for allowed guilds if not set
            for (const guildId of ALLOWED_GUILDS) {
                const settings = await GuildSettings.findOne({ guildId });
                if (!settings || !settings.leaderboardChannelId) {
                    await GuildSettings.findOneAndUpdate(
                        { guildId },
                        { leaderboardChannelId: '1503752079943139358' },
                        { upsert: true }
                    );
                    console.log(`>>> [BOOT] Pre-configured default leaderboard channel 1503752079943139358 for guild ${guildId}`);
                }
            }

            // Resume intervals
            const configs = await QueueConfig.find();
            for (const config of configs) {
                if (config.intervalMinutes > 0) {
                    const key = `${config.guildId}_${config.channelId}`;
                    if (queueIntervals.has(key)) clearInterval(queueIntervals.get(key));
                    const timer = setInterval(async () => {
                        try {
                            await ActiveQueuePlayer.deleteMany({ guildId: config.guildId, channelId: config.channelId });
                            await sendQueueMessage(client, config.guildId, config.channelId, true, true);
                        } catch (err) {
                            console.error(`>>> [BOOT-INTERVAL-ERR] Failed running resumed queue interval for guild ${config.guildId}:`, err.message);
                        }
                    }, config.intervalMinutes * 60000);
                    queueIntervals.set(key, timer);
                    console.log(`>>> [BOOT] Resumed queue interval for guild: ${config.guildId}, channel: ${config.channelId} (${config.intervalMinutes}m)`);
                }
            }

            // Start the 3000ms pre-match VC checker (optimized to use cache and avoid rate-limiting)
            setInterval(async () => {
                try {
                    const activePreVcMatches = await Match.find({ status: 'pre_vc' });
                    for (const match of activePreVcMatches) {
                        const guild = client.guilds.cache.get(match.guildId) || await client.guilds.fetch(match.guildId).catch(() => null);
                        if (!guild) continue;
                        const vc = guild.channels.cache.get(match.playersVcId) || await guild.channels.fetch(match.playersVcId).catch(() => null);
                        if (!vc) continue;

                        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
                        const membersInVc = vc.members.filter(m => playerIds.includes(m.id));

                        // Check if 1 minute has elapsed to auto-request substitutes
                        const elapsedMs = Date.now() - match._id.getTimestamp().getTime();
                        if (elapsedMs >= 60000 && !match.hasSentSubRequests) {
                            await checkAndSendSubstitutionAlert(client, match).catch(err => {
                                console.error(`>>> [SUB-AUTO] Failed to send sub alert:`, err.message);
                            });
                        }

                        // Track the current present player IDs
                        const presentIds = membersInVc.map(m => m.id).sort().join(',');
                        const lastKey = `${match._id.toString()}_present`;
                        const prevPresent = lastVcPlayers.get(lastKey);

                        // If players present in VC changed, update the status embed message
                        if (prevPresent !== presentIds) {
                            lastVcPlayers.set(lastKey, presentIds);

                            const lounge = guild.channels.cache.get(match.loungeChannelId) || await guild.channels.fetch(match.loungeChannelId).catch(() => null);
                            if (lounge && match.preMatchMsgId) {
                                const msg = lounge.messages.cache.get(match.preMatchMsgId) || await lounge.messages.fetch(match.preMatchMsgId).catch(() => null);
                                if (msg && msg.embeds[0]) {
                                    const oldEmbed = msg.embeds[0];
                                    const statusList = playerIds.map(id => {
                                        const isPresent = membersInVc.has(id);
                                        return `${isPresent ? '✅' : '❌'} <@${id}>`;
                                    }).join('\n');

                                    const newEmbed = EmbedBuilder.from(oldEmbed)
                                        .setDescription(`**A new match has been initialized.**\n\n⚠️ **IMPORTANT:** All players must join the voice channel below to start captain selection.\n\n**Join here:** ${vc}\n\n**Player Status:**\n${statusList}\n\n**Total in VC:** ${membersInVc.size}/${playerIds.length}`);

                                    await msg.edit({ embeds: [newEmbed] }).catch(() => { });
                                }
                            }
                        }

                        // If all players are in VC and the state changed from before, start captain selection once
                        if (membersInVc.size >= playerIds.length) {
                            if (prevPresent === presentIds) continue;
                            if (matchLocks.has(match._id.toString())) continue;
                            matchLocks.add(match._id.toString());

                            console.log(`>>> [CHECKER] Match #${match.matchId} has all players in VC. Starting selection...`);
                            await startCaptainSelection(client, match);

                            setTimeout(() => matchLocks.delete(match._id.toString()), 5000);
                        }
                    }
                } catch (e) {
                    // Fail silently to avoid spamming logs
                }
            }, 3000);

            let leaderboardUpdateRunning = false;

            // Start the 2-minute leaderboard updater
            updateLeaderboard = async () => {
                if (leaderboardUpdateRunning) return;
                leaderboardUpdateRunning = true;
                try {
                    // Wait for MongoDB to be connected
                    if (mongoose.connection.readyState !== 1) return;
 
                    // We need to update leaderboards for all guilds that have one configured
                    const allSettings = await GuildSettings.find({ leaderboardChannelId: { $exists: true, $ne: null } });
                    
                    for (const settings of allSettings) {
                        const lbChannel = client.channels.cache.get(settings.leaderboardChannelId) || await client.channels.fetch(settings.leaderboardChannelId).catch(() => null);
                        if (!lbChannel) {
                            console.log(`>>> [LEADERBOARD] Could not fetch channel ${settings.leaderboardChannelId} for guild ${settings.guildId}`);
                            continue;
                        }
 
                        const guildId = lbChannel.guildId;
                        const topPlayers = await UserPoints.find({ guildId: 'shared_scrims' }).sort({ points: -1 }).limit(50);
 
                        let embedDescription = '';
                        if (!topPlayers.length) {
                            embedDescription = '*No scrim matches have been played yet. Play games to show up on the leaderboard!*';
                        } else {
                            const lines = [];
                            for (let i = 0; i < topPlayers.length; i++) {
                                const p = topPlayers[i];
                                const draws = Math.max(0, p.totalGames - p.wins - p.losses);
                                const rank = i + 1;
                                let medal = '';
                                if (rank === 1) medal = '🥇';
                                else if (rank === 2) medal = '🥈';
                                else if (rank === 3) medal = '🥉';
                                else medal = `\`#${rank}\``;
                                lines.push(`${medal} <@${p.userId}> — **${p.points}** pts | W: **${p.wins}** | L: **${p.losses}** | D: **${draws}**`);
                            }
                            embedDescription = lines.join('\n');
                        }
 
                        const embed = new EmbedBuilder()
                            .setTitle('🏆 Leaderboard — Top 50 Players')
                            .setColor('#FFD700')
                            .setDescription(embedDescription)
                            .setFooter({ text: `Updated every 2 minutes` })
                            .setTimestamp();
 
                        // Use a guild-specific message ID if possible, or just send/edit
                        // Since we have multiple guilds now, we need a way to track message IDs per guild
                        // Let's use a simple cache or just search for the last embed with this title
                        let targetMsg = null;
                        const messages = await lbChannel.messages.fetch({ limit: 10 });
                        targetMsg = messages.find(m => m.embeds[0] && m.embeds[0].title === '🏆 Leaderboard — Top 50 Players');
 
                        if (targetMsg) {
                            await targetMsg.edit({ embeds: [embed] }).catch(() => {});
                        } else {
                            await safeChannelSend(lbChannel, { embeds: [embed] });
                        }
                    }
                } catch (e) {
                    console.error('>>> [LEADERBOARD] Error:', e.message);
                } finally {
                    leaderboardUpdateRunning = false;
                }
            };


            // Run every 2 minutes (first run will wait for MongoDB)
            setInterval(updateLeaderboard, 120000);

            // Blacklist cleanup checker
            await checkExpiredBlacklists(client).catch(() => {});
            setInterval(() => checkExpiredBlacklists(client), 30000);
        } catch (e) { console.error('❌ Slash/Interval/Match error:', e); }
        discordReady = true;
    });

    client.on('guildCreate', async (guild) => {
        console.log(`>>> [GUILD-JOIN] Joined guild: ${guild.name} (${guild.id})`);
        try {
            await client.rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashCommands });
            console.log(`✅ Guild slash commands registered instantly for newly joined guild: ${guild.name} (${guild.id})`);
        } catch (err) {
            console.error(`❌ Failed to register commands for newly joined guild ${guild.name} (${guild.id}):`, err.message);
        }
    });

    client.on('messageCreate', async (message) => {
        // Only log prefix command usage to reduce overhead in busy servers
        if (message.guildId && !message.author.bot && message.content.startsWith('s!')) {
            console.log(`>>> [MSG-CMD] ${message.author.tag} used ${message.content}`);
        }

        // Auto-delete cdn.discordapp.com and tenor.com links in queue channels
        if (!message.author.bot && message.guildId) {
            const msgContent = message.content || '';
            const hasBlockedLink = /https?:\/\/(cdn\.discordapp\.com|tenor\.com)/i.test(msgContent)
                || message.embeds.some(e => /https?:\/\/(cdn\.discordapp\.com|tenor\.com)/i.test(e.url || ''))
                || message.attachments.some(a => /https?:\/\/(cdn\.discordapp\.com|tenor\.com)/i.test(a.url || ''));
            if (hasBlockedLink) {
                const isQueueChannel = await QueueConfig.findOne({ guildId: message.guildId, channelId: message.channel.id });
                if (isQueueChannel) {
                    try {
                        await message.delete();
                        console.log(`>>> [AUTO-DEL] Deleted blocked link from ${message.author.tag} in queue channel ${message.channel.id}`);
                    } catch (err) {
                        console.error(`>>> [AUTO-DEL] Failed to delete message:`, err.message);
                    }
                    return;
                }
            }
        }

        if (message.guildId) {
            if (message.author.bot || !message.content.startsWith('s!')) return;
            if (!ALLOWED_GUILDS.includes(message.guildId)) return;

            const content = message.content.slice(2).trim();
            if (!content) return;
            const args = content.split(/ +/);
            const commandName = args[0].toLowerCase();

            console.log(`>>> [MSG-CMD] ${message.author.tag} used s!${commandName}`);

            // Centralized permission check for prefix commands
            const isOwnerOrSpecialRole = message.author.id === '1479214179146535096' || message.member?.roles.cache.has('1503745954627584172');

            if (commandName === 'set-permissions' || commandName === 'permissions-info') {
                if (!isOwnerOrSpecialRole) {
                    console.log(`>>> [MSG-PERM] Permission denied for ${message.author.tag}`);
                    return safeMessageReply(message, '❌ Only the bot owner or a specific admin role can use this command!');
                }
            } else if (commandName === 'verify') {
                // Public command - anyone can verify themselves
            } else {
                const requiredRoles = permissions[commandName] || [];
                const everyCmdRoles = permissions["every_cmd"] || [];
                
                const hasRole = message.member?.roles.cache.some(role => requiredRoles.includes(role.id) || everyCmdRoles.includes(role.id));
                const hasPermission = isOwnerOrSpecialRole || hasRole;
                
                if (!hasPermission) {
                    console.log(`>>> [MSG-PERM] Permission denied for ${message.author.tag}`);
                    return safeMessageReply(message, '❌ You do not have permission to use this command!');
                }
            }

            if (commandName === 'verify') {
                // 1. Try Bloxlink verification
                if (message.member) {
                    const bloxlinkResult = await tryBloxlinkVerify(message.member, message.guild, client);
                    if (bloxlinkResult && bloxlinkResult.success) {
                        return safeMessageReply(message, `✅ **Verification successful!** Linked to Roblox account **${bloxlinkResult.robloxUsername}** via Bloxlink.${bloxlinkResult.nicknameResult}`);
                    }
                }

                // 2. Failed to verify via Bloxlink
                return safeMessageReply(message, `❌ **You are not verified with Bloxlink yet!**\n\n` +
                                     `Please visit **https://blox.link/** to link your Roblox account to your Discord account first, then run this command again.`);
            }
            if (commandName === 'stats') {
                const target = message.mentions.users.first() || message.author;
                const result = await getStatsEmbed(target, message.guild.id, client);
                return safeMessageReply(message, result);
            }
            if (commandName === 'search') {
                const target = message.mentions.users.first() || message.author;
                const lookupMsg = await safeMessageReply(message, `🔍 Searching profile for <@${target.id}>...`);
                const result = await getSearchEmbed(target, message.guild.id, client);
                if (lookupMsg && typeof lookupMsg.edit === 'function') {
                    return lookupMsg.edit(result).catch(() => {});
                }
                return null;
            }
            if (commandName === 'set-permissions') {
                const roleInput = args[1];
                if (!roleInput) {
                    return safeMessageReply(message, '❌ Please specify a role. Usage: `s!set-permissions [role] [commands]`');
                }
                const commandsStr = args.slice(2).join(' ');
                if (!commandsStr) {
                    return safeMessageReply(message, '❌ Please specify commands. Usage: `s!set-permissions [role] [commands]`');
                }

                const processRole = (str) => {
                    const match = str.match(/\d+/);
                    return match ? match[0] : str;
                };
                const roleId = processRole(roleInput.trim());
                const role = await message.guild.roles.fetch(roleId).catch(() => null);
                if (!role) {
                    return safeMessageReply(message, `❌ Role \`${roleId}\` not found in this server.`);
                }

                const commandsArray = commandsStr.split(',')
                    .map(c => c.trim().toLowerCase().replace(/^\//, ''))
                    .filter(c => c.length > 0);

                const invalidCmds = commandsArray.filter(c => permissions[c] === undefined);
                if (invalidCmds.length > 0) {
                    return safeMessageReply(message, `❌ The following commands do not exist: \`${invalidCmds.join(', ')}\``);
                }

                for (const cmd of Object.keys(permissions)) {
                    const hasRole = permissions[cmd].includes(roleId);
                    const shouldHaveRole = commandsArray.includes(cmd);
                    
                    if (shouldHaveRole && !hasRole) {
                        permissions[cmd].push(roleId);
                    } else if (!shouldHaveRole && hasRole) {
                        permissions[cmd] = permissions[cmd].filter(id => id !== roleId);
                    }
                }
                await savePermissions(permissions);

                return safeMessageReply(message, `✅ Permissions updated! <@&${roleId}> now has access to: \`${commandsArray.join(', ') || 'None'}\``);
            }
            if (commandName === 'permissions-info') {

                const lines = [];
                for (const [cmd, roles] of Object.entries(permissions)) {
                    const rolesList = roles.length > 0 
                        ? roles.map(id => `<@&${id}>`).join(', ') 
                        : '*Everyone / Anyone*';
                    lines.push(`**/${cmd}** — ${rolesList}`);
                }

                const embed = new EmbedBuilder()
                    .setTitle('🔐 Command Permissions')
                    .setDescription(lines.join('\n'))
                    .setColor('#5865F2')
                    .setTimestamp();

                return safeMessageReply(message, { embeds: [embed] });
            }
        } else {
            // DM message — handle application answers (works for plain messages AND replies)
            if (message.author.bot) return;

            // Check in-memory first (fast), then fall back to MongoDB (survives restarts)
            let activeApp = activeApplications.get(message.author.id);
            if (!activeApp) {
                const dbApp = await Application.findOne({ userId: message.author.id, status: 'in_progress' }).catch(() => null);
                if (dbApp) {
                    activeApp = { appType: dbApp.appType, currentQuestionIndex: dbApp.currentQuestionIndex, answers: dbApp.answers || [], guildId: dbApp.guildId };
                    activeApplications.set(message.author.id, activeApp);
                }
            }

            if (activeApp) {
                const { appType, currentQuestionIndex, guildId } = activeApp;
                const answers = [...(activeApp.answers || [])];
                const questions = APP_DATA[appType] ? APP_DATA[appType].questions : null;
                if (!questions) return;

                if (currentQuestionIndex < questions.length) {
                    // Accept the answer — strip any reply reference prefix Discord adds
                    const answerText = message.content.trim();
                    answers.push(answerText);
                    const nextIndex = currentQuestionIndex + 1;

                    if (nextIndex < questions.length) {
                        // More questions — advance state in both memory and DB
                        const updated = { appType, currentQuestionIndex: nextIndex, answers, guildId };
                        activeApplications.set(message.author.id, updated);
                        await Application.findOneAndUpdate(
                            { userId: message.author.id, status: 'in_progress' },
                            { currentQuestionIndex: nextIndex, answers }
                        ).catch(() => {});
                        await safeChannelSend(message.channel, `**Question ${nextIndex + 1} of ${questions.length}:**
${questions[nextIndex]}`);
                    } else {
                        // All questions answered — finalize
                        activeApplications.delete(message.author.id);
                        await Application.findOneAndUpdate(
                            { userId: message.author.id, status: 'in_progress' },
                            { answers, status: 'pending', currentQuestionIndex: nextIndex }
                        ).catch(() => {});

                        // Send to application channel
                        const appChannel = client.channels.cache.get(APP_CHANNEL_ID) || await client.channels.fetch(APP_CHANNEL_ID).catch(() => null);
                        if (appChannel) {
                            const embed = new EmbedBuilder()
                                .setTitle(`🆕 New ${appType} Application`)
                                .setColor('#FFFFFF')
                                .setThumbnail(message.author.displayAvatarURL())
                                .addFields(
                                    { name: '👤 Applicant', value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
                                    { name: '📝 Type', value: appType, inline: true },
                                    ...questions.map((q, i) => ({
                                        name: `Q${i + 1}: ${q}`,
                                        value: answers[i] || 'No answer'
                                    }))
                                )
                                .setTimestamp();

                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`app_review_accept_${message.author.id}_${appType}`).setLabel('Accept').setStyle(ButtonStyle.Success),
                                new ButtonBuilder().setCustomId(`app_review_decline_${message.author.id}_${appType}`).setLabel('Decline').setStyle(ButtonStyle.Danger)
                            );

                            await safeChannelSend(appChannel, { content: '<@1474461121531347165> — New application submitted!', embeds: [embed], components: [row] });
                        }

                        await safeChannelSend(message.channel, '✅ Thank you! Your application has been submitted and is awaiting review.');
                    }
                }
            }
        }
    });



    client.on('voiceStateUpdate', async (oldState, newState) => {
        try {
            const channelId = newState.channelId || oldState.channelId;
            if (!channelId) return;

            // --- PLAYER JOINS A MATCH VC: Grant lounge visibility and restore role ---
            if (newState.channelId) {
                const joinMatch = await Match.findOne({
                    guildId: newState.guild.id,
                    $or: [
                        { playersVcId: newState.channelId },
                        { teamAVcId: newState.channelId },
                        { teamBVcId: newState.channelId }
                    ]
                });
                if (joinMatch) {
                    if (joinMatch.loungeChannelId) {
                        const lounge = await newState.guild.channels.fetch(joinMatch.loungeChannelId).catch(() => null);
                        if (lounge) {
                            const perms = {
                                ViewChannel: true,
                                ReadMessageHistory: true
                            };
                            if (newState.channelId === joinMatch.teamAVcId || newState.channelId === joinMatch.teamBVcId) {
                                perms.SendMessages = true;
                            }
                            await lounge.permissionOverwrites.edit(newState.member, perms).catch(() => {});
                        }
                    }

                    if (joinMatch.playersVcId) {
                        const preVc = await newState.guild.channels.fetch(joinMatch.playersVcId).catch(() => null);
                        if (preVc) {
                            await preVc.permissionOverwrites.edit(newState.member, {
                                ViewChannel: true, Connect: true, Speak: true
                            }).catch(() => {});
                        }
                    }

                    if (joinMatch.roleId) {
                        const role = await newState.guild.roles.fetch(joinMatch.roleId).catch(() => null);
                        if (role) {
                            await newState.member.roles.add(role).catch(() => {});
                        }
                    }

                    // Handle deafening in queue vs team VCs
                    if (newState.channelId === joinMatch.playersVcId) {
                        await newState.member.voice.setDeaf(true).catch(() => {});
                    } else if (newState.channelId === joinMatch.teamAVcId || newState.channelId === joinMatch.teamBVcId) {
                        await newState.member.voice.setDeaf(false).catch(() => {});
                    }
                }
            }

            // --- PLAYER LEAVES A MATCH VC: Hide lounge, remove role, log leaver ---
            if (oldState.channelId && oldState.channelId !== newState.channelId) {
                const activeMatch = await Match.findOne({
                    guildId: oldState.guild.id,
                    $or: [
                        { playersVcId: oldState.channelId },
                        { teamAVcId: oldState.channelId },
                        { teamBVcId: oldState.channelId }
                    ]
                });

                if (activeMatch) {
                    // Check if they moved to another VC in the same match
                    const stayedInMatch = newState.channelId && (
                        newState.channelId === activeMatch.playersVcId ||
                        newState.channelId === activeMatch.teamAVcId ||
                        newState.channelId === activeMatch.teamBVcId
                    );

                    if (!stayedInMatch) {
                        if (activeMatch.status === 'finished') {
                            // Hide lounge channel from the player after the match is over
                            if (activeMatch.loungeChannelId) {
                                const lounge = await oldState.guild.channels.fetch(activeMatch.loungeChannelId).catch(() => null);
                                if (lounge) {
                                    await lounge.permissionOverwrites.edit(oldState.member, {
                                        ViewChannel: false
                                    }).catch(() => {});
                                }
                            }

                            // Hide Pre-Match VC from the player after the match is over
                            if (activeMatch.playersVcId) {
                                const preVc = await oldState.guild.channels.fetch(activeMatch.playersVcId).catch(() => null);
                                if (preVc) {
                                    await preVc.permissionOverwrites.edit(oldState.member, {
                                        ViewChannel: false
                                    }).catch(() => {});
                                }
                            }

                            // Remove queue role from the player after the match is over
                            if (activeMatch.roleId) {
                                const role = await oldState.guild.roles.fetch(activeMatch.roleId).catch(() => null);
                                if (role) {
                                    await oldState.member.roles.remove(role).catch(() => {});
                                }
                            }
                        } else {
                            if (activeMatch.loungeChannelId) {
                                const lounge = await oldState.guild.channels.fetch(activeMatch.loungeChannelId).catch(() => null);
                                if (lounge) {
                                    await lounge.permissionOverwrites.edit(oldState.member, {
                                        ViewChannel: null,
                                        SendMessages: null,
                                        ReadMessageHistory: null
                                    }).catch(() => {});
                                }
                            }

                            if (activeMatch.playersVcId) {
                                const preVc = await oldState.guild.channels.fetch(activeMatch.playersVcId).catch(() => null);
                                if (preVc) {
                                    await preVc.permissionOverwrites.edit(oldState.member, {
                                        ViewChannel: null,
                                        Connect: null,
                                        Speak: null
                                    }).catch(() => {});
                                }
                            }

                            console.log(`>>> [VOICE] Player ${oldState.member.id} left active match VC; preserving queue access for rejoin.`);
                        }

                        // Check if category still exists (match not ended by admin)
                        const categoryStillExists = activeMatch.categoryId
                            ? await oldState.guild.channels.fetch(activeMatch.categoryId).catch(() => null)
                            : null;

                        if (categoryStillExists && activeMatch.status === 'finished') {
                            if (suppressMidGameLeaveNotify.has(oldState.channelId)) {
                                console.log(`>>> [VOICE] Suppressing mid-game leave alert for channel ${oldState.channelId} due to admin match end.`);
                                return;
                            }
                            const allPlayers = [
                                ...(activeMatch.remainingPlayers ? activeMatch.remainingPlayers.split(',') : []),
                                ...(activeMatch.pickedPlayers ? activeMatch.pickedPlayers.split(',') : []),
                                ...(activeMatch.teamA ? activeMatch.teamA.split(',') : []),
                                ...(activeMatch.teamB ? activeMatch.teamB.split(',') : [])
                            ];
                            if (allPlayers.includes(oldState.member.id)) {
                                const transcriptChannel = await client.channels.fetch('1506354475558895716').catch(() => null);
                                if (transcriptChannel) {
                                    const member = oldState.member;
                                    const leaveEmbed = new EmbedBuilder()
                                        .setTitle('🚨 Mid-Game Leave Detected!')
                                        .setColor('#ED4245')
                                        .addFields(
                                            { name: '👤 Player', value: `<@${member.id}> (${member.user.tag})`, inline: true },
                                            { name: '🆔 User ID', value: `\`${member.id}\``, inline: true },
                                            { name: '🎮 Match', value: `#${activeMatch.matchId}`, inline: true },
                                            { name: '📍 Server', value: `**${oldState.guild.name}**\n(\`${oldState.guild.id}\`)`, inline: true },
                                            { name: '📍 Left From', value: `<#${oldState.channelId}> (\`${oldState.channelId}\`)`, inline: true },
                                            { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                                        )
                                        .setThumbnail(member.user.displayAvatarURL())
                                        .setFooter({ text: 'Player left voice while game was still running' })
                                        .setTimestamp();
                                    await transcriptChannel.send({ embeds: [leaveEmbed] });
                                }

                                // Send or update substitution alert in the subs channel
                                const freshMatch = await Match.findById(activeMatch._id);
                                if (freshMatch) {
                                    await sendMidMatchLeaveSubAlert(client, freshMatch, oldState.member.id);
                                }
                            }
                        }
                    }
                }
            }
            // --- END LEAVER LOGIC ---
        } catch (err) {
            console.error('>>> [ERROR] Voice state error:', err.message);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            const isDmAppButton = !interaction.guildId && interaction.isButton && interaction.isButton() && interaction.customId && (interaction.customId.startsWith('app_start_') || interaction.customId.startsWith('app_decline_'));
            if (!isDmAppButton && (!interaction.guildId || !ALLOWED_GUILDS.includes(interaction.guildId))) {
                if (interaction.isRepliable()) {
                    await safeInteractionReply(interaction, { content: '❌ This bot is not authorized to run on this server.', ephemeral: true }).catch(() => {});
                }
                return;
            }

            // Handle replacement (substitution) request button/dropdown clicks
            if (interaction.customId && interaction.customId.startsWith('sub_request_')) {
                const handled = await handleSubRequestInteraction(interaction, client);
                if (handled) return;
            }

            // --- APPLICATION HANDLERS ---
            if (interaction.customId && interaction.customId.startsWith('app_start_')) {
                // customId: app_start_<appType>_<userId>_<guildId>
                const parts = interaction.customId.split('_');
                const appType = parts[2];
                const targetUserId = parts[3];
                const guildId = parts[4] || null;
                const targetUser = await client.users.fetch(targetUserId).catch(() => null);

                if (!targetUser) return safeInteractionReply(interaction, { content: '❌ User not found.', ephemeral: true });
                if (interaction.user.id !== targetUserId) return safeInteractionReply(interaction, { content: '❌ You can only accept your own application.', ephemeral: true });

                try {
                    const questions = APP_DATA[appType].questions;

                    // Persist to MongoDB so state survives restarts
                    await Application.findOneAndDelete({ userId: targetUserId, status: 'in_progress' }).catch(() => {});
                    await Application.create({ userId: targetUserId, guildId, appType, answers: [], currentQuestionIndex: 0, status: 'in_progress' });

                    // Also keep in-memory for fast lookups
                    activeApplications.set(targetUserId, { appType, currentQuestionIndex: 0, answers: [], guildId });

                    await safeUserSend(targetUser, `### 📝 ${appType} Application
**Question 1 of ${questions.length}:**
${questions[0]}`);
                    await interaction.update({ content: '✅ Application started in your DMs!', components: [] }).catch(() => {});
                } catch (err) {
                    console.error('>>> [ERROR] Failed to start application in DM:', err.message);
                    activeApplications.delete(targetUserId);
                    return safeInteractionReply(interaction, { content: '❌ Failed to start application in DM.', ephemeral: true });
                }
                return;
            }

            if (interaction.customId && interaction.customId.startsWith('app_decline_')) {
                const targetUserId = interaction.customId.split('_')[2];
                const targetUser = await client.users.fetch(targetUserId).catch(() => null);

                if (targetUser) {
                    await safeUserSend(targetUser, '❌ Your application request has been declined.').catch(() => {});
                }
                return interaction.update({ content: '✅ Application declined.', components: [] }).catch(() => {});
            }

            if (interaction.customId && interaction.customId.startsWith('app_review_')) {
                // customId: app_review_<action>_<userId>_<appType>
                const [, , action, userId, appType] = interaction.customId.split('_');
                const guild = interaction.guild;
                const reviewer = interaction.member;
                if (interaction.user.id !== '1474461121531347165') {
                    return safeInteractionReply(interaction, { content: '❌ You do not have permission to review applications.', ephemeral: true });
                }
                const member = await guild.members.fetch(userId).catch(() => null);

                if (action === 'accept') {
                    const app = await Application.findOne({ userId, guildId: guild.id, status: 'pending' });
                    if (!app) return safeInteractionReply(interaction, { content: '❌ No pending application found.', ephemeral: true });

                    // Assign role
                    const roleId = APP_DATA[appType].roleId;
                    await member.roles.add(roleId).catch(err => console.error('>>> [ERROR] Failed to assign role:', err.message));

                    // Update status
                    app.status = 'accepted';
                    await app.save();

                    const acceptEmbed = EmbedBuilder.from(interaction.message.embeds[0]).setColor('#00FF00');
                    await interaction.update({ content: `✅ Application for <@${userId}> (${appType}) has been **ACCEPTED**. Reviewed by <@${interaction.user.id}>.`, embeds: [acceptEmbed], components: [] }).catch(() => {});
                    if (member) await safeUserSend(member.user, `🎉 Congratulations! Your **${appType}** application has been **ACCEPTED**!`).catch(() => {});
                } else {
                    const app = await Application.findOne({ userId, guildId: guild.id, status: 'pending' });
                    if (!app) return safeInteractionReply(interaction, { content: '❌ No pending application found.', ephemeral: true });

                    app.status = 'declined';
                    await app.save();

                    const declineEmbed = EmbedBuilder.from(interaction.message.embeds[0]).setColor('#FF0000');
                    await interaction.update({ content: `❌ Application for <@${userId}> (${appType}) has been **DECLINED**. Reviewed by <@${interaction.user.id}>.`, embeds: [declineEmbed], components: [] }).catch(() => {});
                    if (member) await safeUserSend(member.user, `❌ Your **${appType}** application has been **DECLINED**.`).catch(() => {});
                }
                return;
            }

            // Handle Appeal Blacklist Button
            if (interaction.customId && interaction.customId.startsWith('appeal_blacklist_')) {
                const targetUserId = interaction.customId.replace('appeal_blacklist_', '');
                if (interaction.user.id !== targetUserId) {
                    return safeInteractionReply(interaction, { content: '❌ You cannot appeal this blacklist, it is not yours!', ephemeral: true }).catch(() => {});
                }

                // Find tickets channel
                let ticketsChannel = interaction.guild.channels.cache.find(c => c.name.toLowerCase() === 'tickets' || c.name.toLowerCase() === 'open-a-ticket' || c.name.toLowerCase() === 'ticket');
                if (!ticketsChannel) {
                    const channels = await interaction.guild.channels.fetch().catch(() => new Map());
                    ticketsChannel = channels.find(c => c.name.toLowerCase() === 'tickets' || c.name.toLowerCase() === 'open-a-ticket' || c.name.toLowerCase().includes('ticket'));
                }

                if (!ticketsChannel) {
                    return safeInteractionReply(interaction, { content: '❌ Tickets channel not found. Please contact an admin!', ephemeral: true }).catch(() => {});
                }

                // Send the @ping message in tickets channel
                const pingMsg = await ticketsChannel.send({ content: `<@${targetUserId}> Appeal here` }).catch(() => null);
                if (pingMsg) {
                    setTimeout(() => {
                        pingMsg.delete().catch(() => {});
                    }, 5000);
                }

                await safeInteractionReply(interaction, { content: `✅ Go to <#${ticketsChannel.id}> to open a ticket to appeal.`, ephemeral: true }).catch(() => {});
                return;
            }

            // --- MVP BUTTON AND DROPDOWN HANDLERS ---
            if (interaction.isButton() && interaction.customId.startsWith('vote_mvp_start_')) {
                const matchId = interaction.customId.replace('vote_mvp_start_', '');
                const match = await Match.findById(matchId);
                if (!match) return safeInteractionReply(interaction, { content: '❌ Match not found.', ephemeral: true });

                const teamA = match.teamA ? match.teamA.split(',') : [];
                const teamB = match.teamB ? match.teamB.split(',') : [];
                const playerIds = [...teamA, ...teamB];

                if (!playerIds.includes(interaction.user.id)) {
                    return safeInteractionReply(interaction, { content: '❌ You are not a player in this match!', ephemeral: true });
                }

                const selectOptions = [];
                for (const id of playerIds) {
                    const member = await interaction.guild.members.fetch(id).catch(() => null);
                    selectOptions.push({
                        label: member?.user.username || `User ${id}`,
                        value: id,
                        description: teamA.includes(id) ? 'Team 1' : 'Team 2'
                    });
                }

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`vote_mvp_submit_${match._id}`)
                    .setPlaceholder('Select the MVP of this match')
                    .addOptions(selectOptions);

                const row = new ActionRowBuilder().addComponents(selectMenu);
                return safeInteractionReply(interaction, { content: '🌟 Who was the MVP of this scrim match?', components: [row], ephemeral: true });
            }

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('vote_mvp_submit_')) {
                const matchId = interaction.customId.replace('vote_mvp_submit_', '');
                const votedPlayerId = interaction.values[0];

                if (!matchMvpVotes.has(matchId)) {
                    matchMvpVotes.set(matchId, new Map());
                }
                const votes = matchMvpVotes.get(matchId);
                votes.set(interaction.user.id, votedPlayerId);

                return interaction.update({ content: `✅ You voted for <@${votedPlayerId}> as MVP!`, components: [] });
            }
            // --- END MVP HANDLERS ---


            if (interaction.isChatInputCommand()) {
                const { commandName, options, guild, user, member, channel } = interaction;
                const isOwnerOrSpecialRole = user.id === '1479214179146535096' || member?.roles.cache.has('1503745954627584172');
                console.log(`>>> [CMD] ${user.tag} (ID: ${user.id}) used /${commandName} in ${guild?.name || 'DM'} (#${channel?.name || 'unknown'})`);

                // Permission check based on permissions.txt and special owner/role bypasses
                if (commandName === 'set-permissions' || commandName === 'permissions-info') {
                    const isAllowedUser = user.id === '1479214179146535096';
                    const isAllowedRole = member?.roles.cache.has('1503745954627584172');
                    if (!isAllowedUser && !isAllowedRole) {
                        return safeInteractionReply(interaction, { content: '❌ Only the bot owner or a specific admin role can use this command!', ephemeral: true });
                    }
                } else if (commandName === 'verify') {
                    // Public command - anyone can verify themselves
                } else if (commandName === 'send-apps') {
                    if (!isOwnerOrSpecialRole && !ALLOWED_APP_COMMAND_ROLES.some(roleId => member?.roles.cache.has(roleId))) {
                        return safeInteractionReply(interaction, { content: '❌ You do not have permission to use this command!', ephemeral: true });
                    }

                    const user = options.getUser('user');
                    const appType = options.getString('app_type');

                    try {
                        const embed = new EmbedBuilder()
                            .setTitle('📝 Application Request')
                            .setDescription(`Hey <@${user.id}>, would you like to apply for the **${appType}** position?`)
                            .setColor('#5865F2')
                            .setTimestamp();

                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`app_start_${appType}_${user.id}_${guild.id}`).setLabel('Yes, I do!').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`app_decline_${user.id}`).setLabel('No, thanks.').setStyle(ButtonStyle.Danger)
                        );

                        await safeUserSend(user, { embeds: [embed], components: [row] });
                        return safeInteractionReply(interaction, { content: `✅ Application request sent to <@${user.id}> in DMs.`, ephemeral: true });
                    } catch (err) {
                        console.error('>>> [ERROR] Failed to send DM for app request:', err.message);
                        return safeInteractionReply(interaction, { content: `❌ Could not send DM to <@${user.id}>. Their DMs might be closed.`, ephemeral: true });
                    }
                } else if (commandName === 'dm') {
                    if (!isOwnerOrSpecialRole) return safeInteractionReply(interaction, { content: '❌ You do not have permission to use this command.', ephemeral: true });
                    const target = options.getUser('user');
                    const msg = options.getString('message');
                    try {
                        await safeUserSend(target, msg);
                        return safeInteractionReply(interaction, { content: `✅ DM sent to <@${target.id}>.`, ephemeral: true });
                    } catch (err) {
                        return safeInteractionReply(interaction, { content: `❌ Could not DM <@${target.id}>. Their DMs may be closed.`, ephemeral: true });
                    }
                } else if (commandName === 'apply') {
                    // Public self-apply command
                    const appType = options.getString('position');
                    if (!APP_DATA[appType]) return safeInteractionReply(interaction, { content: '❌ Invalid position.', ephemeral: true });

                    // Check if already has an in-progress application
                    const existing = await Application.findOne({ userId: user.id, status: 'in_progress' }).catch(() => null);
                    if (existing) return safeInteractionReply(interaction, { content: '❌ You already have an application in progress. Please check your DMs.', ephemeral: true });

                    try {
                        const questions = APP_DATA[appType].questions;
                        // Persist to MongoDB
                        await Application.create({ userId: user.id, guildId: guild.id, appType, answers: [], currentQuestionIndex: 0, status: 'in_progress' });
                        // Keep in-memory too
                        activeApplications.set(user.id, { appType, currentQuestionIndex: 0, answers: [], guildId: guild.id });
                        // Send first question directly
                        await safeUserSend(interaction.user, `### 📝 ${appType} Application
**Question 1 of ${questions.length}:**
${questions[0]}`);
                        return safeInteractionReply(interaction, { content: '✅ Application started! Check your DMs for the first question.', ephemeral: true });
                    } catch (err) {
                        console.error('>>> [ERROR] Failed to start self-application:', err.message);
                        await Application.findOneAndDelete({ userId: user.id, status: 'in_progress' }).catch(() => {});
                        activeApplications.delete(user.id);
                        return safeInteractionReply(interaction, { content: '❌ Could not send you a DM. Please open your DMs and try again.', ephemeral: true });
                    }
                } else {
                    const requiredRoles = permissions[commandName] || [];
                    const everyCmdRoles = permissions["every_cmd"] || [];
                    
                    const hasRole = member?.roles.cache.some(role => requiredRoles.includes(role.id) || everyCmdRoles.includes(role.id));
                    const isAdmin = member?.permissions?.has(PermissionFlagsBits.Administrator);
                    
                    const hasPermission = hasRole || isOwnerOrSpecialRole || isAdmin;
                    
                    if (!hasPermission) {
                        return safeInteractionReply(interaction, { content: '❌ You do not have permission to use this command!', ephemeral: true });
                    }
                }

                if (commandName === 'set-leaderboard') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true });

                    const oldSettings = await GuildSettings.findOne({ guildId: guild.id });
                    const oldChannelId = oldSettings?.leaderboardChannelId;
                    if (oldChannelId && oldChannelId !== channel.id) {
                        const oldChannel = await guild.channels.fetch(oldChannelId).catch(() => null);
                        if (oldChannel) {
                            const messages = await oldChannel.messages.fetch({ limit: 20 }).catch(() => null);
                            if (messages) {
                                const oldMsg = messages.find(m => m.embeds[0] && m.embeds[0].title === '🏆 Leaderboard — Top 50 Players');
                                if (oldMsg) {
                                    await oldMsg.delete().catch(() => {});
                                    console.log(`>>> [LEADERBOARD] Deleted old leaderboard message in channel ${oldChannelId}`);
                                }
                            }
                        }
                    }

                    await GuildSettings.findOneAndUpdate(
                        { guildId: guild.id },
                        { leaderboardChannelId: channel.id },
                        { upsert: true }
                    );

                    if (updateLeaderboard) {
                        setTimeout(() => {
                            updateLeaderboard().catch(err => console.error('>>> [LEADERBOARD] Immediate update failed:', err.message));
                        }, 1000);
                    }

                    return safeInteractionEditReply(interaction, { content: `✅ Leaderboard has been set to ${channel}!` });
                }
                if (commandName === 'set-permissions') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true });

                    const roleInput = options.getString('role');
                    const processRole = (str) => {
                        const match = str.match(/\d+/);
                        return match ? match[0] : str;
                    };
                    const roleId = processRole(roleInput.trim());

                    const role = await guild.roles.fetch(roleId).catch(() => null);
                    if (!role) {
                        return safeInteractionEditReply(interaction, { content: `❌ Role \`${roleId}\` not found in this server.` });
                    }

                    const commandsInput = options.getString('commands');
                    const commandsArray = commandsInput.split(',')
                        .map(c => c.trim().toLowerCase().replace(/^\//, ''))
                        .filter(c => c.length > 0);

                    const invalidCmds = commandsArray.filter(c => permissions[c] === undefined);
                    if (invalidCmds.length > 0) {
                        return safeInteractionEditReply(interaction, { content: `❌ The following commands do not exist: \`${invalidCmds.join(', ')}\`` });
                    }

                    for (const cmd of Object.keys(permissions)) {
                        const hasRole = permissions[cmd].includes(roleId);
                        const shouldHaveRole = commandsArray.includes(cmd);
                        
                        if (shouldHaveRole && !hasRole) {
                            permissions[cmd].push(roleId);
                        } else if (!shouldHaveRole && hasRole) {
                            permissions[cmd] = permissions[cmd].filter(id => id !== roleId);
                        }
                    }
                    await savePermissions(permissions);

                    return safeInteractionEditReply(interaction, { content: `✅ Permissions updated! <@&${roleId}> now has access to: \`${commandsArray.join(', ') || 'None'}\`` });
                }
                if (commandName === 'permissions-info') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true });

                    const lines = [];
                    for (const [cmd, roles] of Object.entries(permissions)) {
                        const rolesList = roles.length > 0 
                            ? roles.map(id => `<@&${id}>`).join(', ') 
                            : '*Everyone / Anyone*';
                        lines.push(`**/${cmd}** — ${rolesList}`);
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('🔐 Command Permissions')
                        .setDescription(lines.join('\n'))
                        .setColor('#5865F2')
                        .setTimestamp();

                    return safeInteractionEditReply(interaction, { embeds: [embed] });
                }
                if (commandName === 'setup') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true });

                    const embed = new EmbedBuilder()
                        .setTitle('🚀 eScrims Bot Setup')
                        .setDescription('Follow these steps to get started:\n\n' +
                            '1. **Create a Queue Channel:** Make a channel where the bot will post queue messages.\n' +
                            '2. **Run `/queue-enable`:** Use `/queue-enable interval:10` to start the automatic queue.\n' +
                            '3. **Customize:** Use `/help` to see other management commands.\n\n' +
                            '**Note:** Ensure the bot has `Administrator` or proper permissions in the target category.')
                        .setColor('#5865F2')
                        .setTimestamp();
                    return safeInteractionEditReply(interaction, { embeds: [embed] });
                }
                if (commandName === 'verify') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true });

                    // 1. Try Bloxlink verification
                    const bloxlinkResult = await tryBloxlinkVerify(member, guild, client);
                    if (bloxlinkResult && bloxlinkResult.success) {
                        return safeInteractionEditReply(interaction, {
                            content: `✅ **Verification successful!** Linked to Roblox account **${bloxlinkResult.robloxUsername}** via Bloxlink.${bloxlinkResult.nicknameResult}`
                        });
                    }

                    // 2. Failed to verify via Bloxlink
                    return safeInteractionEditReply(interaction, {
                        content: `❌ **You are not verified with Bloxlink yet!**\n\n` +
                                 `Please visit **https://blox.link/** to link your Roblox account to your Discord account first, then run this command again.`
                    }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'queue-enable') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const interval = options.getInteger('interval');

                    await QueueConfig.findOneAndUpdate(
                        { guildId: guild.id, channelId: channel.id },
                        { intervalMinutes: interval },
                        { upsert: true }
                    );

                    const key = `${guild.id}_${channel.id}`;
                    if (queueIntervals.has(key)) clearInterval(queueIntervals.get(key));

                    // Immediately clear player queue and send a fresh message
                    await ActiveQueuePlayer.deleteMany({ guildId: guild.id, channelId: channel.id });
                    await sendQueueMessage(client, guild.id, channel.id, true, true);

                    // Start loop: clear players and post a brand new clean queue form every interval cycle
                    const timer = setInterval(async () => {
                        try {
                            await ActiveQueuePlayer.deleteMany({ guildId: guild.id, channelId: channel.id });
                            await sendQueueMessage(client, guild.id, channel.id, true, true);
                        } catch (err) {
                            console.error(`>>> [INTERVAL-ERR] Failed running queue interval for guild ${guild.id}:`, err.message);
                        }
                    }, interval * 60000);
                    queueIntervals.set(key, timer);

                    return safeInteractionEditReply(interaction, { content: `✅ Queue system configured! Messages will be sent in ${channel} every ${interval} minutes.` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'queue-disable') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const key = `${guild.id}_${channel.id}`;
                    if (queueIntervals.has(key)) {
                        clearInterval(queueIntervals.get(key));
                        queueIntervals.delete(key);
                    }

                    // Clear any queued players
                    await ActiveQueuePlayer.deleteMany({ guildId: guild.id, channelId: channel.id });

                    // Delete the last queue message if it exists
                    const config = await QueueConfig.findOne({ guildId: guild.id, channelId: channel.id });
                    if (config && config.lastMessageId) {
                        const msg = await channel.messages.fetch(config.lastMessageId).catch(() => null);
                        if (msg) await msg.delete().catch(() => {});
                    }

                    // Remove the queue config for this channel
                    await QueueConfig.deleteOne({ guildId: guild.id, channelId: channel.id });

                    return safeInteractionEditReply(interaction, { content: `✅ Queue has been disabled in ${channel}. No more queue messages will be sent.` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'help') {
                    await safeInteractionDeferReply(interaction);
                    if (!interaction.deferred && !interaction.replied) return;

                    const hasAccess = (cmd) => {
                        if (cmd === 'verify') return true;
                        const isOwnerOrSpecialRole = user.id === '1479214179146535096' || member?.roles.cache.has('1503745954627584172');
                        if (isOwnerOrSpecialRole) return true;
                        
                        const requiredRoles = permissions[cmd] || [];
                        const everyCmdRoles = permissions["every_cmd"] || [];
                        
                        return member?.roles.cache.some(role => requiredRoles.includes(role.id) || everyCmdRoles.includes(role.id));
                    };

                    const playerCmdsList = [
                        { cmd: 'verify', text: '`/verify` - Links Roblox to Discord and gets Player role' },
                        { cmd: 'search', text: '`/search` - Search for a verified player and view their profile' },
                        { cmd: 'stats', text: '`/stats` - Check your points and rank' },
                        { cmd: 'cancel', text: '`/cancel` - Vote to cancel current match' },
                        { cmd: 'gamevote', text: '`/gamevote` - Vote on which team won' },
                        { cmd: 'ping', text: '`/ping` - Check bot latency' },
                        { cmd: 'substitute', text: '`/substitute` - Request a loan sub replacement in queue' }
                    ];

                    const adminCmdsList = [
                        { cmd: 'queue-enable', text: '`/queue-enable` - Setup queue channel and interval' },
                        { cmd: 'queue-disable', text: '`/queue-disable` - Stop the queue loop in the current channel' },
                        { cmd: 'go', text: '`/go` - Force a new queue message' },
                        { cmd: 'setup', text: '`/setup` - View setup guide' },
                        { cmd: 'queueend', text: '`/queueend` - Force end a match by ID' },
                        { cmd: 'givepoints', text: '`/givepoints` - Give points to a player' },
                        { cmd: 'removepoints', text: '`/removepoints` - Remove points from a player' },
                        { cmd: 'ppq', text: '`/ppq` - Set required players for queue in the current channel' },
                        { cmd: 'set-leaderboard', text: '`/set-leaderboard` - Sets the leaderboard channel for this guild' },
                        { cmd: 'set-permissions', text: '`/set-permissions` - Update command permissions' },
                        { cmd: 'permissions-info', text: '`/permissions-info` - View command permissions mapping' },
                        { cmd: 'refresh', text: '`/refresh` - Hard reset stats and database' }
                    ];

                    const visiblePlayerCmds = playerCmdsList.filter(item => hasAccess(item.cmd)).map(item => item.text);
                    const visibleAdminCmds = adminCmdsList.filter(item => hasAccess(item.cmd)).map(item => item.text);

                    const fields = [];
                    if (visiblePlayerCmds.length > 0) {
                        fields.push({ name: '👤 Player Commands', value: visiblePlayerCmds.join('\n') });
                    }
                    if (visibleAdminCmds.length > 0) {
                        fields.push({ name: '👑 Admin Commands', value: visibleAdminCmds.join('\n') });
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('🛠️ eScrims Command List')
                        .setColor('#5865F2')
                        .setFooter({ text: 'eScrims Management' });

                    if (fields.length > 0) {
                        embed.addFields(fields);
                    } else {
                        embed.setDescription('*You do not have permission to view or use any commands.*');
                    }

                    return safeInteractionEditReply(interaction, { embeds: [embed] }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'stats') {
                    await safeInteractionDeferReply(interaction);
                    if (!interaction.deferred && !interaction.replied) return; // Stop if defer failed

                    const target = options.getUser('user') || user;
                    const result = await getStatsEmbed(target, guild.id, client);
                    return safeInteractionEditReply(interaction, result).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'search') {
                    await safeInteractionDeferReply(interaction);
                    if (!interaction.deferred && !interaction.replied) return;

                    const targetUser = options.getUser('user');
                    const result = await getSearchEmbed(targetUser, guild.id, client);
                    return safeInteractionEditReply(interaction, result).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'go') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    await QueueConfig.findOneAndUpdate(
                        { guildId: guild.id, channelId: channel.id },
                        {},
                        { upsert: true }
                    );

                    // Clear any existing queue players in this channel to make it 100% fresh
                    await ActiveQueuePlayer.deleteMany({ guildId: guild.id, channelId: channel.id });

                    await sendQueueMessage(client, guild.id, channel.id, true, true);
                    return safeInteractionEditReply(interaction, { content: '🚀 Queue refreshed in this channel!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'queueend') {
                    const matchId = options.getInteger('number');
                    const match = await Match.findOne({ guildId: guild.id, matchId });
                    if (!match) return safeInteractionReply(interaction, { content: `❌ Match \`#${matchId}\` not found!`, ephemeral: true });

                    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

                    const channelsToDelete = [match.teamAVcId, match.teamBVcId, match.loungeChannelId, match.captainPickChannelId, match.playersVcId].filter(id => id);
                    channelsToDelete.forEach(id => suppressMidGameLeaveNotify.add(id));
                    setTimeout(() => channelsToDelete.forEach(id => suppressMidGameLeaveNotify.delete(id)), 30000);
                    for (const id of channelsToDelete) {
                        const ch = await guild.channels.fetch(id).catch(() => null);
                        if (ch) await ch.delete().catch(() => { });
                    }

                    if (match.categoryId && match.categoryId !== '1503751701684027474') {
                        const category = await guild.channels.fetch(match.categoryId).catch(() => null);
                        if (category) {
                            const children = guild.channels.cache.filter(c => c.parentId === category.id);
                            for (const [id, child] of children) await child.delete().catch(() => { });
                            await category.delete().catch(() => { });
                        }
                    }

                    if (match.roleId) {
                        const role = await guild.roles.fetch(match.roleId).catch(() => null);
                        if (role) await role.delete().catch(() => {});
                    }

                    await Match.deleteOne({ _id: match._id });
                    const isStaticCategory = match.categoryId === '1503751701684027474';
                    return safeEditReply(interaction, { content: `✅ Match \`#${matchId}\` ${isStaticCategory ? 'channels' : 'and its category'} have been deleted.` });
                }
                if (commandName === 'cancel') {
                    const match = await Match.findOne({
                        guildId: guild.id,
                        $or: [
                            { teamAVcId: channel.id },
                            { teamBVcId: channel.id },
                            { loungeChannelId: channel.id },
                            { captainPickChannelId: channel.id },
                            { playersVcId: channel.id }
                        ]
                    });

                    if (!match) return safeInteractionReply(interaction, { content: '❌ This command can only be used inside a match channel!', ephemeral: true });

                    const teamA = match.teamA ? match.teamA.split(',') : [];
                    const teamB = match.teamB ? match.teamB.split(',') : [];
                    const playerIds = [...teamA, ...teamB].filter(id => id.length > 5);
                    if (!playerIds.includes(user.id) && !isAdmin) {
                        return safeInteractionReply(interaction, { content: '❌ Only players in this match can start a vote!', ephemeral: true });
                    }

                    const votes = new Map();
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('vote_yes').setLabel('End Match (Yes)').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId('vote_no').setLabel('Keep Playing (No)').setStyle(ButtonStyle.Secondary)
                    );

                    const generateStatus = () => {
                        const yesCount = [...votes.values()].filter(v => v === 'yes').length;
                        const noCount = [...votes.values()].filter(v => v === 'no').length;
                        const waitingFor = playerIds.filter(id => !votes.has(id));

                        let desc = `**A vote has been started to end Match #${match.matchId}**\n\n`;
                        desc += `✅ **Yes:** ${yesCount}\n❌ **No:** ${noCount}\n\n`;
                        desc += `⏳ **Waiting for:** ${waitingFor.length > 0 ? waitingFor.map(id => `<@${id}>`).join(', ') : 'Everyone has voted!'}`;

                        return new EmbedBuilder().setTitle('⚠️ End Match Vote').setDescription(desc).setColor(yesCount > noCount ? '#ED4245' : '#5865F2').setTimestamp();
                    };

                    const msg = await safeInteractionReply(interaction, { embeds: [generateStatus()], components: [row], fetchReply: true });
                    const collector = msg.createMessageComponentCollector({ time: 30000 });

                    collector.on('collect', async (i) => {
                        if (!playerIds.includes(i.user.id)) return i.reply({ content: '❌ You are not part of this match!', ephemeral: true });
                        const vote = i.customId === 'vote_yes' ? 'yes' : 'no';
                        votes.set(i.user.id, vote);
                        await i.update({ embeds: [generateStatus()] });
                        if (votes.size >= playerIds.length) collector.stop('all_voted');
                    });

                    collector.on('end', async (_, reason) => {
                        const yesCount = [...votes.values()].filter(v => v === 'yes').length;
                        const noCount = [...votes.values()].filter(v => v === 'no').length;

                        if (yesCount > noCount) {
                            await channel.send(`🚨 **Vote Passed!** Match #${match.matchId} is being deleted...`);
                            const channelsToDelete = [match.teamAVcId, match.teamBVcId, match.loungeChannelId, match.captainPickChannelId, match.playersVcId].filter(id => id);
                            channelsToDelete.forEach(id => suppressMidGameLeaveNotify.add(id));
                            setTimeout(() => channelsToDelete.forEach(id => suppressMidGameLeaveNotify.delete(id)), 30000);
                            for (const id of channelsToDelete) {
                                const ch = await guild.channels.fetch(id).catch(() => null);
                                if (ch) await ch.delete().catch(() => { });
                            }
                            if (match.categoryId && match.categoryId !== '1503751701684027474') {
                                const category = await guild.channels.fetch(match.categoryId).catch(() => null);
                                if (category) {
                                    const children = guild.channels.cache.filter(c => c.parentId === category.id);
                                    for (const [id, child] of children) await child.delete().catch(() => { });
                                    await category.delete().catch(() => { });
                                }
                            }
                            if (match.roleId) {
                                const role = await guild.roles.fetch(match.roleId).catch(() => null);
                                if (role) await role.delete().catch(() => {});
                            }
                            await Match.deleteOne({ _id: match._id });
                        } else {
                            await channel.send('✅ **Vote Failed.** Match will continue.');
                            await msg.edit({ components: [] }).catch(() => { });
                        }
                    });
                    return;
                }
                if (commandName === 'gamevote') {
                    const match = await Match.findOne({
                        guildId: guild.id,
                        $or: [
                            { loungeChannelId: channel.id },
                            { playersVcId: channel.id }
                        ]
                    });

                    if (!match) return safeInteractionReply(interaction, { content: '❌ This command can only be used inside a match channel!', ephemeral: true });

                    if (!await safeDeferReply(interaction, { ephemeral: true })) return;
                    const embed = new EmbedBuilder()
                        .setTitle(`🏆 Game Result: Match #${match.matchId}`)
                        .setDescription('Which team won the match?\n\n1️⃣ **Team 1**\n*No votes yet*\n\n2️⃣ **Team 2**\n*No votes yet*\n\n*Voting ends in 30 seconds.*')
                        .setColor('#5865F2')
                        .setTimestamp();

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('win_team1').setLabel('Team 1 Won').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('win_team2').setLabel('Team 2 Won').setStyle(ButtonStyle.Danger)
                    );

                    const msg = await safeEditReply(interaction, { embeds: [embed], components: [row] });
                    if (!msg) return;
                    const votes = new Map();
                    const collector = msg.createMessageComponentCollector({ time: 30000 });

                    collector.on('collect', async (i) => {
                        const teamA = match.teamA ? match.teamA.split(',') : [];
                        const teamB = match.teamB ? match.teamB.split(',') : [];
                        const playerIds = [...teamA, ...teamB];
                        if (!playerIds.includes(i.user.id)) return i.reply({ content: '❌ Only players in this match can vote!', ephemeral: true });

                        votes.set(i.user.id, i.customId);
                        await i.reply({ content: `✅ Vote recorded for ${i.customId === 'win_team1' ? 'Team 1' : 'Team 2'}.`, ephemeral: true });

                        const team1Voters = [...votes.entries()].filter(([_, v]) => v === 'win_team1').map(([id]) => `<@${id}>`);
                        const team2Voters = [...votes.entries()].filter(([_, v]) => v === 'win_team2').map(([id]) => `<@${id}>`);

                        const updatedEmbed = EmbedBuilder.from(embed)
                            .setDescription(`Which team won the match?\n\n1️⃣ **Team 1**\n${team1Voters.length > 0 ? team1Voters.join(', ') : '*No votes yet*'}\n\n2️⃣ **Team 2**\n${team2Voters.length > 0 ? team2Voters.join(', ') : '*No votes yet*'}\n\n*Voting ends in 30 seconds.*`);

                        await msg.edit({ embeds: [updatedEmbed] }).catch(() => {});
                    });

                    collector.on('end', async () => {
                        const team1Votes = [...votes.values()].filter(v => v === 'win_team1').length;
                        const team2Votes = [...votes.values()].filter(v => v === 'win_team2').length;

                        let resultText = "No votes were cast.";
                        if (team1Votes > team2Votes) resultText = "🏆 **Team 1** is the winner!";
                        else if (team2Votes > team1Votes) resultText = "🏆 **Team 2** is the winner!";
                        else if (votes.size > 0) resultText = "⚖️ **Draw!** Both teams have equal votes.";

                        const team1Voters = [...votes.entries()].filter(([_, v]) => v === 'win_team1').map(([id]) => `<@${id}>`);
                        const team2Voters = [...votes.entries()].filter(([_, v]) => v === 'win_team2').map(([id]) => `<@${id}>`);

                        const resultEmbed = new EmbedBuilder()
                            .setTitle(`📊 Voting Results: Match #${match.matchId}`)
                            .setDescription(`${resultText}\n\n**Team 1 Votes (${team1Voters.length}):** ${team1Voters.join(', ') || 'None'}\n**Team 2 Votes (${team2Voters.length}):** ${team2Voters.join(', ') || 'None'}`)
                            .setColor('#FEE75C');

                        const mvpRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`vote_mvp_start_${match._id}`).setLabel('🏆 Vote MVP').setStyle(ButtonStyle.Success)
                        );

                        await channel.send({ embeds: [resultEmbed], components: [mvpRow] });
                        await msg.edit({ components: [] }).catch(() => { });

                        if (match.roleId) {
                            const role = await guild.roles.fetch(match.roleId).catch(() => null);
                            if (role) await role.delete().catch(() => {});
                        }

                        // --- AWARD POINTS & INCREMENT WINS/LOSSES ---
                        const teamAIds = match.teamA ? match.teamA.split(',') : [];
                        const teamBIds = match.teamB ? match.teamB.split(',') : [];

                        if (team1Votes > team2Votes) {
                            for (const id of teamAIds) {
                                await updateUserPoints(id, 'shared_scrims', 25, 1, 0, 1);
                                await PointHistory.create({ userId: id, guildId: 'shared_scrims', points: 25, type: 'game_win' });
                            }
                            for (const id of teamBIds) {
                                await updateUserPoints(id, 'shared_scrims', -25, 0, 1, 1);
                                await PointHistory.create({ userId: id, guildId: 'shared_scrims', points: -25, type: 'game_loss' });
                            }
                        } else if (team2Votes > team1Votes) {
                            for (const id of teamBIds) {
                                await updateUserPoints(id, 'shared_scrims', 25, 1, 0, 1);
                                await PointHistory.create({ userId: id, guildId: 'shared_scrims', points: 25, type: 'game_win' });
                            }
                            for (const id of teamAIds) {
                                await updateUserPoints(id, 'shared_scrims', -25, 0, 1, 1);
                                await PointHistory.create({ userId: id, guildId: 'shared_scrims', points: -25, type: 'game_loss' });
                            }
                        } else if (votes.size > 0) {
                            for (const id of [...teamAIds, ...teamBIds]) {
                                await updateUserPoints(id, 'shared_scrims', 0, 0, 0, 1);
                                await PointHistory.create({ userId: id, guildId: 'shared_scrims', points: 0, type: 'game_draw' });
                            }
                        }

                        // --- ANNOUNCE MVP AT 30 SECONDS ---
                        setTimeout(async () => {
                            try {
                                const votesMap = matchMvpVotes.get(match._id.toString());
                                if (votesMap && votesMap.size > 0) {
                                    const counts = {};
                                    for (const votedId of votesMap.values()) {
                                        counts[votedId] = (counts[votedId] || 0) + 1;
                                    }
                                    let mvpId = null;
                                    let maxVotes = 0;
                                    for (const [id, count] of Object.entries(counts)) {
                                        if (count > maxVotes) {
                                            maxVotes = count;
                                            mvpId = id;
                                        }
                                    }

                                    if (mvpId) {
                                        const mvpUser = await client.users.fetch(mvpId).catch(() => null);
                                        const mvpEmbed = new EmbedBuilder()
                                            .setTitle('🌟 SCRIM MVP ANNOUNCED!')
                                            .setDescription('🏆 <@' + mvpId + '> has been voted as the **MVP** of Match #' + match.matchId + ' with **' + maxVotes + '** votes!\n\nThey have been awarded **+10** bonus points!')
                                            .setColor('#FEE75C')
                                            .setThumbnail(mvpUser ? mvpUser.displayAvatarURL() : null);

                                        await channel.send({ embeds: [mvpEmbed] });

                                        await updateUserPoints(mvpId, 'shared_scrims', 10);
                                        await PointHistory.create({ userId: mvpId, guildId: 'shared_scrims', points: 10, type: 'game_mvp' });
                                    }
                                }
                                matchMvpVotes.delete(match._id.toString());
                            } catch (err) {
                                console.error('>>> [MVP] Failed to process MVP:', err.message);
                            }
                        }, 30000);

                        // --- DELETE CATEGORY AND CHANNELS AT 35 SECONDS ---
                        setTimeout(async () => {
                            try {
                                const channelsToDelete = [match.teamAVcId, match.teamBVcId, match.loungeChannelId, match.captainPickChannelId, match.playersVcId].filter(id => id);
                                for (const id of channelsToDelete) {
                                    const ch = await guild.channels.fetch(id).catch(() => null);
                                    if (ch) await ch.delete().catch(() => { });
                                }

                                if (match.categoryId && match.categoryId !== '1503751701684027474') {
                                    const category = await guild.channels.fetch(match.categoryId).catch(() => null);
                                    if (category) {
                                        const children = guild.channels.cache.filter(c => c.parentId === category.id);
                                        for (const [id, child] of children) await child.delete().catch(() => { });
                                        await category.delete().catch(() => { });
                                    }
                                }
                                await Match.deleteOne({ _id: match._id });
                            } catch (err) {
                                console.error('>>> [CLEANUP] Failed to cleanup match after gamevote:', err.message);
                            }
                        }, 35000);
                    });
                    return;
                }
                if (commandName === 'ping') {
                    const start = Date.now();
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const latency = Date.now() - start;
                    return safeInteractionEditReply(interaction, { content: `🏓 **Pong!**\nGateway: \`${client.ws.ping}ms\`\nREST: \`${latency}ms\`` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'givepoints') {
                    await safeInteractionDeferReply(interaction);
                    if (!interaction.deferred && !interaction.replied) return;

                    const target = options.getUser('user');
                    const amount = options.getInteger('amount');
                    if (amount <= 0) return safeInteractionEditReply(interaction, { content: '❌ Amount must be a positive number!' });

                    let data = await updateUserPoints(target.id, 'shared_scrims', amount);

                    await PointHistory.create({ userId: target.id, guildId: 'shared_scrims', points: amount, type: 'admin_give' });

                    return safeInteractionEditReply(interaction, { content: `✅ Gave **${amount}** points to <@${target.id}>. They now have **${data.points.toFixed(1)}** points.` });
                }
                if (commandName === 'removepoints') {
                    await safeInteractionDeferReply(interaction);
                    if (!interaction.deferred && !interaction.replied) return;

                    const target = options.getUser('user');
                    const amount = options.getInteger('amount');
                    if (amount <= 0) return safeInteractionEditReply(interaction, { content: '❌ Amount must be a positive number!' });

                    let data = await updateUserPoints(target.id, 'shared_scrims', -amount);

                    await PointHistory.create({ userId: target.id, guildId: 'shared_scrims', points: -amount, type: 'admin_remove' });

                    return safeInteractionEditReply(interaction, { content: `✅ Removed **${amount}** points from <@${target.id}>. They now have **${data.points.toFixed(1)}** points.` });
                }
                if (commandName === 'ppq') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const playersCount = options.getInteger('players');
                    if (playersCount <= 0) return safeInteractionEditReply(interaction, { content: '❌ Number of players must be a positive number!' });

                    await QueueConfig.findOneAndUpdate(
                        { guildId: guild.id, channelId: channel.id },
                        { requiredPlayers: playersCount },
                        { upsert: true }
                    );

                    await sendQueueMessage(client, guild.id, channel.id, false);

                    return safeInteractionEditReply(interaction, { content: `✅ Required players for queue in this channel set to **${playersCount}**.` });
                }
                if (commandName === 'startqueue') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const forcedMatchId = options.getInteger('queuenumber');

                    // Find players in the current queue
                    const players = await ActiveQueuePlayer.find({ guildId: guild.id, channelId: channel.id });
                    if (players.length === 0) {
                        return safeInteractionEditReply(interaction, { content: '❌ There are no players currently in the queue to start a match!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    // Get or create guild settings
                    let settings = await GuildSettings.findOne({ guildId: guild.id });
                    if (!settings) {
                        settings = await GuildSettings.findOneAndUpdate(
                            { guildId: guild.id },
                            {},
                            { upsert: true, new: true, setDefaultsOnInsert: true }
                        );
                    }

                    try {
                        // Start the match even if there are not enough players
                        await createMatch(guild, players, settings, forcedMatchId);

                        // Update the settings queue count to be at least this forcedMatchId to keep future numbering logical
                        await GuildSettings.updateOne({ guildId: guild.id }, { queueCount: Math.max(settings.queueCount, forcedMatchId) });

                        // Clear players in queue
                        await ActiveQueuePlayer.deleteMany({ guildId: guild.id, channelId: channel.id });

                        // Clear old queue message
                        const config = await QueueConfig.findOne({ guildId: guild.id, channelId: channel.id });
                        if (config && config.lastMessageId) {
                            const qChannel = await guild.channels.fetch(config.channelId).catch(() => null);
                            if (qChannel) {
                                const msg = await qChannel.messages.fetch(config.lastMessageId).catch(() => null);
                                if (msg) await msg.delete().catch(() => {});
                            }
                            await QueueConfig.updateOne({ guildId: guild.id, channelId: channel.id }, { lastMessageId: null });
                        }

                        return safeInteractionEditReply(interaction, { content: `✅ Match **#${forcedMatchId}** successfully force-started with **${players.length}** players!` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    } catch (err) {
                        console.error('>>> [ERROR] Force Match startup failed:', err);
                        return safeInteractionEditReply(interaction, { content: '❌ Failed to create match channels. Please check bot permissions!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }
                }
                if (commandName === 'renew_queue_players') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const matchId = options.getInteger('queuenumber');
                    const match = await Match.findOne({ guildId: guild.id, matchId });
                    if (!match) {
                        return safeInteractionEditReply(interaction, { content: `❌ Match **#${matchId}** not found!` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    if (match.status !== 'pre_vc') {
                        return safeInteractionEditReply(interaction, { content: `❌ Match **#${matchId}** has already started or finished (Status: \`${match.status}\`).` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    const vc = await guild.channels.fetch(match.playersVcId).catch(() => null);
                    if (!vc) {
                        return safeInteractionEditReply(interaction, { content: '❌ Pre-match Voice Channel not found!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    // Get all member IDs in the VC
                    const memberIdsInVc = vc.members.map(m => m.id);
                    if (memberIdsInVc.length === 0) {
                        return safeInteractionEditReply(interaction, { content: '❌ No players are currently inside the pre-match Voice Channel!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    try {
                        const previousPlayers = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
                        const missingPlayers = previousPlayers.filter(id => !memberIdsInVc.includes(id));

                        // Update remaining players in DB
                        match.remainingPlayers = memberIdsInVc.join(',');
                        await match.save();

                        // Auto-blacklist the players who didn't join
                        for (const id of missingPlayers) {
                            await autoBlacklistPlayer(guild, id);
                        }

                        // Synchronize match role
                        const matchRole = await guild.roles.fetch(match.roleId).catch(() => null);
                        if (matchRole) {
                            const currentRoleMembers = matchRole.members;
                            for (const [id, member] of currentRoleMembers) {
                                if (!memberIdsInVc.includes(id)) {
                                    await member.roles.remove(matchRole).catch(() => {});
                                }
                            }
                            for (const id of memberIdsInVc) {
                                const member = vc.members.get(id);
                                if (member && !member.roles.cache.has(matchRole.id)) {
                                    await member.roles.add(matchRole).catch(() => {});
                                }
                            }
                        }

                        // Clear presence cache key to force immediate update in checker
                        const lastKey = `${match._id.toString()}_present`;
                        lastVcPlayers.delete(lastKey);

                        // Trigger immediate check so VC checker runs and launches match pick phase instantly
                        return safeInteractionEditReply(interaction, { content: `✅ Match **#${matchId}** players updated to match the Voice Channel! Updated count: **${memberIdsInVc.length}** players. The match will now transition automatically.` }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    } catch (err) {
                        console.error('>>> [ERROR] renew_queue_players failed:', err);
                        return safeInteractionEditReply(interaction, { content: '❌ Failed to renew players. Please check bot role permissions.' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }
                }
                if (commandName === 'blacklist') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const targetUser = options.getUser('user');
                    const durationStr = options.getString('duration').trim();
                    const match = durationStr.match(/^(\d+)([smhdw])$/i);

                    if (!match) {
                        return safeInteractionEditReply(interaction, { content: '❌ Invalid duration format! Use e.g. `30m`, `12h`, `1d`, `2w`.' }).catch(() => {});
                    }

                    const amount = parseInt(match[1], 10);
                    const unit = match[2].toLowerCase();

                    let durationMs = 0;
                    if (unit === 's') durationMs = amount * 1000;
                    else if (unit === 'm') durationMs = amount * 60000;
                    else if (unit === 'h') durationMs = amount * 3600000;
                    else if (unit === 'd') durationMs = amount * 86400000;
                    else if (unit === 'w') durationMs = amount * 604800000;

                    const expiresAt = new Date(Date.now() + durationMs);

                    try {
                        const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
                        if (!targetMember) {
                            return safeInteractionEditReply(interaction, { content: '❌ User not found in this guild!' }).catch(() => {});
                        }

                        // Give the blacklist role
                        const roleId = '1503814587877949632';
                        const blacklistRole = await guild.roles.fetch(roleId).catch(() => null);
                        if (!blacklistRole) {
                            return safeInteractionEditReply(interaction, { content: `❌ Blacklist role with ID \`${roleId}\` not found in this guild! Please create/configure it.` }).catch(() => {});
                        }

                        await targetMember.roles.add(blacklistRole).catch(err => {
                            console.error('>>> [ERROR] Failed to add blacklist role:', err.message);
                        });

                        // Save or update blacklist record in DB
                        await BlacklistedUser.findOneAndUpdate(
                            { userId: targetUser.id, guildId: guild.id },
                            { expiresAt },
                            { upsert: true, new: true }
                        );

                        // Remove from active queue players
                        const removeResult = await ActiveQueuePlayer.deleteMany({ guildId: guild.id, userId: targetUser.id });
                        if (removeResult.deletedCount > 0) {
                            console.log(`>>> [BLACKLIST] Removed user ${targetUser.id} from active queue players.`);
                            // Refresh all queues in this guild
                            const configs = await QueueConfig.find({ guildId: guild.id });
                            for (const config of configs) {
                                await sendQueueMessage(client, guild.id, config.channelId).catch(() => {});
                            }
                        }

                        // Kick from voice channel if in a queue VC
                        if (targetMember.voice && targetMember.voice.channel) {
                            const vcName = targetMember.voice.channel.name.toLowerCase();
                            if (vcName.includes('queue') || vcName.includes('team 1') || vcName.includes('team 2')) {
                                await targetMember.voice.disconnect('User blacklisted.').catch(() => {});
                            }
                        }

                        return safeInteractionEditReply(interaction, { content: `✅ Successfully blacklisted **${targetUser.tag}** for **${durationStr}** (expires at <t:${Math.floor(expiresAt.getTime() / 1000)}:F>).` }).catch(() => {});
                    } catch (err) {
                        console.error('>>> [ERROR] Blacklist command failed:', err);
                        return safeInteractionEditReply(interaction, { content: '❌ An error occurred while blacklisting the user.' }).catch(() => {});
                    }
                }
                if (commandName === 'substitute') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    // Check for active matches in pre_vc, choosing_method, voting, or picking status
                    const activeMatch = await Match.findOne({
                        guildId: guild.id,
                        status: { $in: ['pre_vc', 'choosing_method', 'voting', 'picking'] }
                    });

                    if (activeMatch) {
                        // Check all three VCs for missing players
                        const playerIds = activeMatch.remainingPlayers ? activeMatch.remainingPlayers.split(',') : [];
                        const teamAIds = activeMatch.teamA ? activeMatch.teamA.split(',') : [];
                        const teamBIds = activeMatch.teamB ? activeMatch.teamB.split(',') : [];

                        const alerts = [];

                        // Check pre-match VC
                        if (activeMatch.playersVcId) {
                            const preVc = guild.channels.cache.get(activeMatch.playersVcId) || await guild.channels.fetch(activeMatch.playersVcId).catch(() => null);
                            if (preVc) {
                                const missingInPre = playerIds.filter(id => !preVc.members.has(id));
                                if (missingInPre.length > 0) {
                                    alerts.push(`**Pre-Match VC**: ${missingInPre.length} player(s) missing - ${missingInPre.map(id => `<@${id}>`).join(', ')}`);
                                }
                            }
                        }

                        // Check Team A VC
                        if (activeMatch.teamAVcId && teamAIds.length > 0) {
                            const teamAVc = guild.channels.cache.get(activeMatch.teamAVcId) || await guild.channels.fetch(activeMatch.teamAVcId).catch(() => null);
                            if (teamAVc) {
                                const missingInTeamA = teamAIds.filter(id => !teamAVc.members.has(id));
                                if (missingInTeamA.length > 0) {
                                    alerts.push(`**Team A VC**: ${missingInTeamA.length} player(s) missing - ${missingInTeamA.map(id => `<@${id}>`).join(', ')}`);
                                }
                            }
                        }

                        // Check Team B VC
                        if (activeMatch.teamBVcId && teamBIds.length > 0) {
                            const teamBVc = guild.channels.cache.get(activeMatch.teamBVcId) || await guild.channels.fetch(activeMatch.teamBVcId).catch(() => null);
                            if (teamBVc) {
                                const missingInTeamB = teamBIds.filter(id => !teamBVc.members.has(id));
                                if (missingInTeamB.length > 0) {
                                    alerts.push(`**Team B VC**: ${missingInTeamB.length} player(s) missing - ${missingInTeamB.map(id => `<@${id}>`).join(', ')}`);
                                }
                            }
                        }

                        if (alerts.length > 0) {
                            const checkEmbed = new EmbedBuilder()
                                .setTitle(`🔍 Substitution Check — Match #${activeMatch.matchId}`)
                                .setDescription(alerts.join('\n\n'))
                                .setColor('#FEE75C')
                                .setTimestamp();
                            return safeInteractionEditReply(interaction, { embeds: [checkEmbed] });
                        } else {
                            return safeInteractionEditReply(interaction, { content: '✅ All players are in their respective voice channels!' });
                        }
                    }

                    // If no active match, check queue status
                    const playerEntry = await ActiveQueuePlayer.findOne({ guildId: guild.id, userId: user.id });
                    if (!playerEntry) {
                        return safeInteractionEditReply(interaction, { content: '❌ No active match found, and you are not in any queue!' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                    }

                    const queueChannelId = playerEntry.channelId;
                    const config = await QueueConfig.findOne({ guildId: guild.id, channelId: queueChannelId });
                    const settings = await GuildSettings.findOneAndUpdate({ guildId: guild.id }, {}, { upsert: true, new: true });
                    const reqPlayers = config?.requiredPlayers || settings.requiredPlayers || 14;
                    const queueNumber = settings.queueCount + 1;

                    // Remove the player from the queue
                    await ActiveQueuePlayer.deleteOne({ guildId: guild.id, channelId: queueChannelId, userId: user.id });

                    // Update the queue message
                    await sendQueueMessage(client, guild.id, queueChannelId);

                    // Build the substitution embed
                    const subEmbed = new EmbedBuilder()
                        .setTitle('🔄 SUBSTITUTION')
                        .setDescription(`**Queue ${queueNumber}** NEEDS A LOAN REPLACEMENT FOR <@${user.id}> !`)
                        .setColor('#FEE75C')
                        .setTimestamp();

                    const subRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`sub_accept_${queueChannelId}_${user.id}`).setLabel('Substitute').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`sub_ignore_${queueChannelId}_${user.id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary)
                    );

                    // Send the sub request to the same channel the command was used in
                    await channel.send({ content: '@here', embeds: [subEmbed], components: [subRow] }).catch(err => console.error('>>> [ERROR] Failed to send sub message:', err.message));

                    return safeInteractionEditReply(interaction, { content: '✅ You have been removed from the queue and a substitution request has been posted.' }).catch(err => console.error('>>> [ERROR] Edit failed:', err.message));
                }
                if (commandName === 'substitutes') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const activeMatch = await Match.findOne({ guildId: guild.id, status: 'pre_vc' });
                    if (!activeMatch) {
                        return safeInteractionEditReply(interaction, { content: '❌ No active pre-vc matches found in this guild.' }).catch(() => {});
                    }

                    await checkAndSendSubstitutionAlert(client, activeMatch, true).catch(err => {
                        console.error(`>>> [SUB-CMD-ERR] checkAndSendSubstitutionAlert failed:`, err.message);
                    });

                    return safeInteractionEditReply(interaction, { content: `✅ Manual substitution check triggered for Match #${activeMatch.matchId}. Alerts have been sent to the replacements channel if players are missing.` }).catch(() => {});
                }
                if (commandName === 'swap') {
                    await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
                    if (!interaction.deferred && !interaction.replied) return;

                    const player1 = options.getUser('player1');
                    const player2 = options.getUser('player2');

                    // Find active match where player1 is present
                    const match = await Match.findOne({
                        guildId: guild.id,
                        status: { $in: ['pre_vc', 'choosing_method', 'voting', 'picking', 'finished'] },
                        $or: [
                            { remainingPlayers: new RegExp(player1.id) },
                            { teamA: new RegExp(player1.id) },
                            { teamB: new RegExp(player1.id) }
                        ]
                    });

                    if (!match) {
                        return safeInteractionEditReply(interaction, { content: `❌ Player <@${player1.id}> is not in any active match!` }).catch(() => {});
                    }

                    // Check if player2 is already in this match
                    const isPlayer2InMatch = (match.remainingPlayers && match.remainingPlayers.includes(player2.id)) ||
                        (match.teamA && match.teamA.includes(player2.id)) ||
                        (match.teamB && match.teamB.includes(player2.id));
                    if (isPlayer2InMatch) {
                        return safeInteractionEditReply(interaction, { content: `❌ Player <@${player2.id}> is already in this match!` }).catch(() => {});
                    }

                    // Check if player2 is blacklisted
                    const isBlacklisted = await BlacklistedUser.findOne({ userId: player2.id, guildId: guild.id });
                    const player2Member = await guild.members.fetch(player2.id).catch(() => null);
                    const hasBlacklistRole = player2Member?.roles.cache.has('1503814587877949632');
                    if (hasBlacklistRole || (isBlacklisted && isBlacklisted.expiresAt > new Date())) {
                        return safeInteractionEditReply(interaction, { content: `❌ Player <@${player2.id}> is blacklisted and cannot join!` }).catch(() => {});
                    }

                    try {
                        // Remove queue role for player1
                        const matchRole = await guild.roles.fetch(match.roleId).catch(() => null);
                        const player1Member = await guild.members.fetch(player1.id).catch(() => null);
                        if (player1Member && matchRole) {
                            await player1Member.roles.remove(matchRole).catch(() => {});
                        }

                        // Add queue role to player2
                        if (player2Member && matchRole) {
                            await player2Member.roles.add(matchRole).catch(() => {});
                        }

                        // Update match player lists in DB
                        if (match.remainingPlayers && match.remainingPlayers.includes(player1.id)) {
                            match.remainingPlayers = match.remainingPlayers.split(',').map(id => id === player1.id ? player2.id : id).join(',');
                        }
                        if (match.teamA && match.teamA.includes(player1.id)) {
                            match.teamA = match.teamA.split(',').map(id => id === player1.id ? player2.id : id).join(',');
                        }
                        if (match.teamB && match.teamB.includes(player1.id)) {
                            match.teamB = match.teamB.split(',').map(id => id === player1.id ? player2.id : id).join(',');
                        }
                        await match.save();

                        // Auto-blacklist the player who didn't join and got swapped (player1)
                        await autoBlacklistPlayer(guild, player1.id);

                        // Clear presence cache key to force immediate update in checker
                        const lastKey = `${match._id.toString()}_present`;
                        lastVcPlayers.delete(lastKey);

                        // Ping player2 in lounge and tell them to join the pre-match voice channel
                        const loungeChannel = guild.channels.cache.get(match.loungeChannelId) || await guild.channels.fetch(match.loungeChannelId).catch(() => null);
                        const playersVc = guild.channels.cache.get(match.playersVcId) || await guild.channels.fetch(match.playersVcId).catch(() => null);
                        
                        const messageContent = `<@${player2.id}> Please join the pre-match Voice Channel: ${playersVc || 'VC'}`;
                        if (loungeChannel) {
                            await loungeChannel.send({ content: messageContent }).catch(() => {});
                        }

                        return safeInteractionEditReply(interaction, { content: `✅ Successfully swapped <@${player1.id}> with <@${player2.id}>. ${messageContent}` }).catch(() => {});
                    } catch (err) {
                        console.error('>>> [ERROR] /swap failed:', err);
                        return safeInteractionEditReply(interaction, { content: '❌ An error occurred while swapping players.' }).catch(() => {});
                    }
                }
                if (commandName === 'refresh') {
                    if (user.id !== '1479214179146535096') {
                        return safeInteractionReply(interaction, { content: '❌ You do not have permission to use this owner-only command.', ephemeral: true });
                    }

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('refresh_confirm').setLabel('Yes, Reset Everything').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('refresh_cancel').setLabel('No, Cancel').setStyle(ButtonStyle.Danger)
                    );

                    const response = await safeInteractionReply(interaction, {
                        content: '⚠️ **Are you sure you want to perform a hard reset?** This will fully wipe all player stats (MMR back to 1000), point history logs, active queue players, queue counters, and running matches!',
                        components: [row],
                        ephemeral: true
                    });

                    const collectorFilter = i => i.user.id === interaction.user.id;
                    try {
                        const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 30000 });

                        if (confirmation.customId === 'refresh_confirm') {
                            await confirmation.deferUpdate();
                            
                            // 1. Clear active queue players
                            await ActiveQueuePlayer.deleteMany({});
                            
                            // 2. Clear user points / MMR profiles
                            await UserPoints.deleteMany({});

                            // 3. Clear point history records
                            await PointHistory.create({ userId: 'system', guildId: 'shared_scrims', points: 0, type: 'admin_remove' }); // safe placeholder or just clean wipe
                            await PointHistory.deleteMany({});

                            // 4. Reset guild queue count settings to 572
                            await GuildSettings.updateMany({}, { queueCount: 572 });

                            // 5. Clean up any active matches that are running
                            await Match.deleteMany({});

                            await safeInteractionEditReply(interaction, {
                                content: '✅ **Bot Refresh Complete!** All queue players, player stats (MMR back to 1000), point history logs, queue counters, and active matches have been fully reset.',
                                components: []
                            });
                        } else if (confirmation.customId === 'refresh_cancel') {
                            await confirmation.update({
                                content: '❌ **Refresh Cancelled.** No data was wiped.',
                                components: []
                            });
                        }
                    } catch (e) {
                        await safeInteractionEditReply(interaction, { content: '⏳ **Confirmation Timeout.** No changes were made.', components: [] }).catch(() => {});
                    }
                }
            }

            await handleQueueInteraction(interaction, client);
        } catch (err) {
            console.error(`>>> [ERROR] Interaction failed for /${interaction.commandName || 'unknown'}:`, err);
            console.error(`>>> [DEBUG] Interaction ID: ${interaction.id}, User: ${interaction.user?.tag}, Guild: ${interaction.guild?.id}`);

            if (err.name === 'ConnectTimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
                console.error('>>> [NETWORK] Detected connection timeout. This usually means the proxy or HF network is failing.');
            }

            try {
                if (!interaction.replied && !interaction.deferred) {
                    await safeInteractionReply(interaction, { content: '❌ An internal error occurred while processing this command.', ephemeral: true }).catch(() => { });
                } else if (interaction.deferred) {
                    await safeInteractionEditReply(interaction, { content: '❌ An error occurred while executing this command.' }).catch(() => { });
                } else {
                    await safeInteractionFollowUp(interaction, { content: '❌ An error occurred while executing this command.', ephemeral: true }).catch(() => { });
                }
            } catch (secondaryErr) {
                console.error('>>> [CRITICAL] Failed to send error message to user:', secondaryErr.message);
            }
        }
    });

    // === STEP 5: Login to Discord ===
    console.log(">>> [BOOT] Starting Discord connection...");

    // Connection Watchdog - 5 minutes total
    let connectionTimeout = setTimeout(() => {
        if (!client.readyAt) {
            console.error(">>> [CRITICAL] Connection timeout! Killing process for restart...");
            process.exit(1);
        }
    }, 300000);

    const TOKEN = process.env.DISCORD_TOKEN?.trim().replace(/['"]+/g, '');
    if (!TOKEN) {
        console.error(">>> [CRITICAL] DISCORD_TOKEN is not set! Check your environment variables.");
        process.exit(1);
    }

    let loginAttempts = 0;
    while (true) {
        try {
            console.log(`>>> [BOOT] Login attempt ${loginAttempts + 1}...`);
            await client.login(TOKEN);
            clearTimeout(connectionTimeout);
            console.log(">>> [BOOT] ✅ Discord login successful!");
            
            // === KEEP-ALIVE: Prevent HuggingFace Spaces suspension on free tier ===
            const http = require('http');
            setInterval(() => {
                http.get('http://localhost:7860/health', (res) => {
                    console.log(`>>> [PING] Health check: ${res.statusCode}`);
                }).on('error', (e) => console.error('>>> [PING ERROR]', e.message));
            }, 300000); // Ping every 5 minutes
            console.log(">>> [BOOT] ✅ Keep-alive ping enabled (5 min interval)");
            
            break;
        } catch (err) {
            loginAttempts++;
            console.error(`>>> [BOOT] Discord Login Failed (Attempt ${loginAttempts}):`, err.message);

            if (loginAttempts > 10) {
                console.error(">>> [CRITICAL] Too many login failures. Exiting for restart...");
                process.exit(1);
            }

            const delay = Math.min(3000 * loginAttempts, 15000);
            console.log(`>>> [BOOT] Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // === STEP 6: Connect MongoDB ===
    console.log(">>> [BOOT] Connecting to MongoDB in background...");
    mongoose.connect(process.env.MONGODB_URI).then(async () => {
        console.log(">>> [BOOT] ✅ MongoDB Connected!");

        // Sync permissions from MongoDB
        try {
            const dbPerms = await Permission.find();
            if (dbPerms && dbPerms.length > 0) {
                console.log(`>>> [BOOT] Syncing ${dbPerms.length} permissions from MongoDB...`);
                
                const renameMap = {
                    'add': 'queue-enable',
                    'cmds': 'help',
                    'leaderstat_set': 'set-leaderboard',
                    'setperms': 'set-permissions',
                    'setperms_info': 'permissions-info'
                };
                let migrated = false;

                for (const p of dbPerms) {
                    if (renameMap[p.commandName]) {
                        const newName = renameMap[p.commandName];
                        permissions[newName] = p.roles;
                        await Permission.findOneAndUpdate(
                            { commandName: newName },
                            { roles: p.roles },
                            { upsert: true }
                        ).catch(() => {});
                        await Permission.deleteOne({ commandName: p.commandName }).catch(() => {});
                        migrated = true;
                    } else {
                        permissions[p.commandName] = p.roles;
                    }
                }
                
                // Migrate empty public/player commands to the player role, and seed any missing default commands
                for (const [cmd, defaultRoles] of Object.entries(defaultPermissions)) {
                    if (!permissions[cmd]) {
                        permissions[cmd] = defaultRoles;
                        migrated = true;
                    }
                }
                for (const cmd of ["stats", "cancel", "gamevote", "help", "ping"]) {
                    if (!permissions[cmd] || permissions[cmd].length === 0) {
                        permissions[cmd] = ["1503746241484427296"];
                        migrated = true;
                    }
                }
                if (migrated) {
                    await savePermissions(permissions);
                    console.log(">>> [BOOT] Synced new/missing permissions to matches defaults");
                } else {
                    // Save locally to permissions.txt so the text file matches the DB
                    await savePermissions(permissions);
                }
            } else {
                console.log(">>> [BOOT] No permissions found in MongoDB. Seeding initial permissions...");
                for (const [cmd, roles] of Object.entries(permissions)) {
                    await Permission.findOneAndUpdate(
                        { commandName: cmd },
                        { roles },
                        { upsert: true, new: true }
                    );
                }
            }
        } catch (err) {
            console.error(">>> [BOOT] Failed to sync/migrate permissions from MongoDB:", err.message);
        }

        try {
            await mongoose.connection.db.collection('queueconfigs').dropIndex('guildId_1').catch(() => {});
            await mongoose.connection.db.collection('activequeueplayers').dropIndex('guildId_1_userId_1').catch(() => {});
            console.log(">>> [BOOT] Legacy indexes cleaned up.");
        } catch (e) {
            console.log(">>> [BOOT] Non-critical index cleanup message:", e.message);
        }
    }).catch(err => {
        console.error(">>> [BOOT] MongoDB Background Error:", err.message);
    });
}

async function checkExpiredBlacklists(client) {
    try {
        const expired = await BlacklistedUser.find({ expiresAt: { $lte: new Date() } });
        for (const record of expired) {
            const guild = await client.guilds.fetch(record.guildId).catch(() => null);
            if (guild) {
                const member = await guild.members.fetch(record.userId).catch(() => null);
                if (member) {
                    await member.roles.remove('1503814587877949632').catch(err => {
                        console.error(`>>> [BLACKLIST-CLEANUP] Failed to remove blacklist role from user ${record.userId} in guild ${record.guildId}:`, err.message);
                    });
                }
            }
            await BlacklistedUser.deleteOne({ _id: record._id });
            console.log(`>>> [BLACKLIST-CLEANUP] Removed expired blacklist for user ID ${record.userId}`);
        }
    } catch (err) {
        console.error('>>> [BLACKLIST-CLEANUP] Error checking expired blacklists:', err.message);
    }
}

start();
