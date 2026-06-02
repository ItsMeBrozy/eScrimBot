const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, StringSelectMenuBuilder } = require('discord.js');
const { QueueConfig, ActiveQueuePlayer, GuildSettings, Match, PointHistory, BlacklistedUser } = require('./models');
const { safeChannelSend, safeMessageEdit, safeInteractionDeferReply, safeInteractionReply, safeInteractionEditReply, safeInteractionFollowUp } = require('./safe-utils');

const queueIntervals = new Map();
const methodTimeouts = new Map();
const votingTimeouts = new Map();
const pickingTimeouts = new Map();
const queueLocks = new Set();

async function retryPromise(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`>>> [RETRY] Critical network operation failed (attempt ${i + 1}/${retries}): ${err.message}. Retrying in ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

async function sendQueueMessage(client, guildId, channelId, forceNew = false, shouldPing = false, _retryCount = 0) {
    try {
        const config = await QueueConfig.findOne({ guildId, channelId });
        if (!config) return;

        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = guild.channels.cache.get(config.channelId) || await guild.channels.fetch(config.channelId).catch(() => null);
        if (!channel) return;

        const players = await ActiveQueuePlayer.find({ guildId, channelId });
        let settings = await GuildSettings.findOne({ guildId });
        if (!settings) {
            settings = await GuildSettings.findOneAndUpdate(
                { guildId },
                {},
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }
        
        const reqPlayers = config.requiredPlayers || settings.requiredPlayers || 14;

        const embed = new EmbedBuilder()
            .setTitle(`Match Lounge Queue ${settings.queueCount + 1}:`)
            .setColor('#5865F2')
            .setDescription(`**Players Who Joined**\n———————————————\n${players.length > 0 ? players.map((p, i) => `${i + 1} - <@${p.userId}>`).join('\n') : 'No one yet...'}\n\n[MAX IS ${reqPlayers}]`)
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('join_queue').setLabel('Join Queue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('leave_queue').setLabel('Leave Queue').setStyle(ButtonStyle.Danger)
        );

        if (forceNew && config.lastMessageId) {
            const oldMsg = await channel.messages.fetch(config.lastMessageId).catch(() => null);
            if (oldMsg) await oldMsg.delete().catch(() => {});
        }

        let lastMsg = null;
        if (config.lastMessageId && !forceNew) lastMsg = await channel.messages.fetch(config.lastMessageId).catch(() => null);

        if (lastMsg) {
            const editOptions = { embeds: [embed], components: [row] };
            if (shouldPing) editOptions.content = '@everyone';
            await safeMessageEdit(lastMsg, editOptions);
        } else {
            const sendOptions = { embeds: [embed], components: [row] };
            if (shouldPing) sendOptions.content = '@everyone';
            const newMsg = await safeChannelSend(channel, sendOptions);
            if (newMsg && newMsg.id) {
                await QueueConfig.updateOne({ guildId, channelId }, { lastMessageId: newMsg.id });
            }
        }
    } catch (error) {
        if (_retryCount < 3) {
            console.warn(`>>> [RETRY] Queue message failed (${error.message}), retrying...`);
            await new Promise(r => setTimeout(r, 3000));
            return sendQueueMessage(client, guildId, channelId, forceNew, shouldPing, _retryCount + 1);
        }
        console.error('>>> [ERROR] Queue message failed after 3 retries:', error.message);
    }
}


async function createMatch(guild, playerDocs, settings, forcedMatchId = null) {
    try {
        const matchId = forcedMatchId !== null ? forcedMatchId : (settings.queueCount + 1);
        const playerIds = playerDocs.map(p => p.userId);

        console.log(`>>> [MATCH] Creating Match #${matchId} in ${guild.name} for ${playerIds.length} players...`);

        // Decrement friendly blacklists for this guild
        try {
            const friendlyBlacklists = await BlacklistedUser.find({ guildId: guild.id, isFriendlyBlacklist: true });
            for (const record of friendlyBlacklists) {
                const newCount = record.scrimsRemaining - 1;
                if (newCount <= 0) {
                    await BlacklistedUser.deleteOne({ _id: record._id });
                    // Remove blacklist role from user
                    const member = await guild.members.fetch(record.userId).catch(() => null);
                    if (member) {
                        await member.roles.remove('1503814587877949632').catch(() => {});
                    }
                    console.log(`>>> [BLACKLIST] Friendly blacklist expired for user ${record.userId}`);
                } else {
                    record.scrimsRemaining = newCount;
                    await record.save();
                    console.log(`>>> [BLACKLIST] Friendly blacklist decremented to ${newCount} for user ${record.userId}`);
                }
            }
        } catch (err) {
            console.error('>>> [ERROR] Failed to decrement friendly blacklists in createMatch:', err.message);
        }

        // 1. Create Role for the Queue
        const matchRole = await retryPromise(() => guild.roles.create({
            name: `Queue ${matchId}`,
            color: '#FF5733',
            mentionable: true,
            reason: `Role for Queue ${matchId}`
        }));

        // Assign role to all players
        for (const playerId of playerIds) {
            const member = guild.members.cache.get(playerId) || await guild.members.fetch(playerId).catch(() => null);
            if (member) {
                await member.roles.add(matchRole).catch(err => console.error(`>>> [ROLE] Failed to add role to ${playerId}:`, err.message));
            }
        }

        const categoryId = '1503751701684027474';
        const category = await guild.channels.fetch(categoryId).catch(() => null);
        if (category) {
            await category.permissionOverwrites.create(matchRole.id, {
                ViewChannel: true,
            }).catch(err => console.error(`>>> [PERMISSION] Failed to set category overwrite for role:`, err.message));
        }

        // 2. Create Initial Channels inside the static category
        const lounge = await retryPromise(() => guild.channels.create({
            name: `💬・queue${matchId}`,
            type: ChannelType.GuildText,
            parent: categoryId,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: matchRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages],
                }
            ],
        }));

        const playersVc = await retryPromise(() => guild.channels.create({
            name: `🔊・queue${matchId}`,
            type: ChannelType.GuildVoice,
            parent: categoryId,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: matchRole.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                },
                {
                    id: '1503814587877949632',
                    deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                }
            ],
        }));

        // Team VCs will be created AFTER picking phase

        // 3. Save Match to DB in 'pre_vc' status
        const matchDoc = await Match.create({
            matchId,
            guildId: guild.id,
            categoryId: categoryId,
            loungeChannelId: lounge.id,
            playersVcId: playersVc.id,
            remainingPlayers: playerIds.join(','),
            roleId: matchRole.id,
            status: 'pre_vc'
        });

        // 4. Send Announcement
        const statusList = playerIds.map(id => `❌ <@${id}>`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle(`🎮 MATCH #${matchId} IS READY!`)
            .setColor('#FEE75C')
            .setDescription(`**A new match has been initialized.**\n\n🚫 **Chat is currently locked** for queue role members until teams are assigned and moved into their Team VCs.\n\n⚠️ **IMPORTANT:** All players must join the voice channel below to start captain selection.\n\n**Join here:** ${playersVc}\n\n**Player Status:**\n${statusList}\n\n**Total in VC:** 0/${playerIds.length}`)
            .setTimestamp()
            .setFooter({ text: 'Waiting for players to join VC...' });

        const announcement = await retryPromise(() => lounge.send({ 
            content: `<@&${matchRole.id}>`, 
            embeds: [embed] 
        }));

        await retryPromise(() => lounge.send(`🚫 Chat is locked for this match until teams are assigned and moved to their Team VCs. Stay in the VC and wait for the next update.`)).catch(() => {});

        await Match.updateOne({ _id: matchDoc._id }, { preMatchMsgId: announcement.id });

        console.log(`>>> [MATCH] Match #${matchId} waiting for players in VC.`);
        return matchId;
    } catch (err) {
        console.error('>>> [ERROR] Failed to create match:', err);
        throw err;
    }
}


function getMethodVotingEmbed(match, playerIds) {
    const votes = match.methodVotes || new Map();
    const randomVoters = [];
    const votingVoters = [];
    const waitingFor = [];

    playerIds.forEach(id => {
        const vote = votes.get(id);
        if (vote === 'random') randomVoters.push(`<@${id}>`);
        else if (vote === 'voting') votingVoters.push(`<@${id}>`);
        else waitingFor.push(`<@${id}>`);
    });

    const desc = [
        'All players have joined the VC! How should captains be selected?',
        '',
        `🎲 **Random (${randomVoters.length}):** ${randomVoters.length > 0 ? randomVoters.join(', ') : 'None'}`,
        `🗳️ **Voting (${votingVoters.length}):** ${votingVoters.length > 0 ? votingVoters.join(', ') : 'None'}`,
        '',
        `⏳ **Waiting For (${waitingFor.length}):** ${waitingFor.length > 0 ? waitingFor.join(', ') : 'Everyone has voted!'}`,
        '',
        '*Voting ends in 30 seconds.*'
    ].join('\n');

    return new EmbedBuilder()
        .setTitle('⚔️ Captain Selection Style')
        .setDescription(desc)
        .setColor('#5865F2');
}

async function resolveMethodVoting(client, matchDocId) {
    try {
        const match = await Match.findById(matchDocId);
        if (!match || match.status !== 'choosing_method') return;

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        const votes = match.methodVotes || new Map();

        let randomCount = 0;
        let votingCount = 0;
        for (const [voter, val] of votes.entries()) {
            if (val === 'random') randomCount++;
            else if (val === 'voting') votingCount++;
        }

        console.log(`>>> [MATCH] Resolving Method Voting for Match #${match.matchId}. Random: ${randomCount}, Voting: ${votingCount}`);

        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        const lounge = guild ? await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null) : null;

        // Update selection message to remove buttons and show winner
        if (lounge && match.preMatchMsgId) {
            const msg = await retryPromise(() => lounge.messages.fetch(match.preMatchMsgId)).catch(() => null);
            if (msg) {
                const winnerText = votingCount > randomCount ? '🗳️ **Voting**' : '🎲 **Random**';
                const finishedEmbed = new EmbedBuilder()
                    .setTitle('⚔️ Captain Selection Style')
                    .setDescription(`Voting has completed!\n\nWinner: ${winnerText}\n\n🎲 Random: ${randomCount} votes\n🗳️ Voting: ${votingCount} votes`)
                    .setColor('#5865F2');
                await retryPromise(() => msg.edit({ embeds: [finishedEmbed], components: [] })).catch(() => {});
            }
        }

        if (votingCount > randomCount) {
            await startVoting(client, match);
        } else {
            // Pick 2 random captains
            const shuffled = [...playerIds].sort(() => 0.5 - Math.random());
            await startPicking(client, match, shuffled[0], shuffled[1]);
        }
    } catch (err) {
        console.error('>>> [ERROR] resolveMethodVoting failed:', err);
    }
}

async function startCaptainSelection(client, match) {
    try {
        console.log(`>>> [MATCH] startCaptainSelection called for Match #${match.matchId}`);
        
        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        if (!guild) return console.error(`>>> [ERROR] Guild not found for Match #${match.matchId}`);

        const lounge = await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null);
        if (!lounge) return console.error(`>>> [ERROR] Lounge not found for Match #${match.matchId}`);

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];

        // Reset methodVotes map
        await Match.updateOne({ _id: match._id }, { status: 'choosing_method', methodVotes: {} });
        
        const updatedMatch = await Match.findById(match._id);

        const embed = getMethodVotingEmbed(updatedMatch, playerIds);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`method_random_${match.matchId}`).setLabel('Random').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`method_voting_${match.matchId}`).setLabel('Voting').setStyle(ButtonStyle.Secondary)
        );

        console.log(`>>> [MATCH] Attempting to send selection message for #${match.matchId}...`);
        const preMatchMsg = await retryPromise(() => lounge.send({ embeds: [embed], components: [row] }));
        console.log(`>>> [MATCH] Selection message sent for Match #${match.matchId}`);

        await Match.updateOne({ _id: match._id }, { preMatchMsgId: preMatchMsg.id });

        // Start 30-second timer to resolve method selection
        if (methodTimeouts.has(match._id.toString())) clearTimeout(methodTimeouts.get(match._id.toString()));
        
        const timer = setTimeout(async () => {
            methodTimeouts.delete(match._id.toString());
            await resolveMethodVoting(client, match._id);
        }, 30000);
        methodTimeouts.set(match._id.toString(), timer);

    } catch (err) {
        console.error(`>>> [ERROR] startCaptainSelection failed for Match #${match.matchId}:`, err);
    }
}

function getCaptainVotingEmbed(match, playerIds) {
    const votes = match.votes || new Map();
    
    // Count votes for each candidate
    const voteCounts = {};
    playerIds.forEach(id => { voteCounts[id] = 0; });
    
    for (const [voter, target] of votes.entries()) {
        voteCounts[target] = (voteCounts[target] || 0) + 1;
    }

    // Filter and sort candidates who have 1 or more votes
    const candidatesWithVotes = Object.entries(voteCounts)
        .filter(([_, count]) => count >= 1)
        .sort((a, b) => b[1] - a[1]);

    const voteListStr = candidatesWithVotes.length > 0
        ? candidatesWithVotes.map(([id, count]) => `<@${id}>: **${count} vote${count > 1 ? 's' : ''}**`).join('\n')
        : '*No votes received yet.*';

    const waitingFor = [];
    playerIds.forEach(id => {
        if (!votes.has(id)) waitingFor.push(`<@${id}>`);
    });

    const desc = [
        'Select the player you want to be a captain.',
        'The person with the most votes wins Captain 1, and the second wins Captain 2!',
        '',
        '📊 **Current Votes:**',
        voteListStr,
        '',
        `⏳ **Waiting For (${waitingFor.length}):** ${waitingFor.length > 0 ? waitingFor.join(', ') : 'Everyone has voted!'}`,
        '',
        '*Voting ends in 30 seconds.*'
    ].join('\n');

    return new EmbedBuilder()
        .setTitle('🗳️ Vote for Captains')
        .setDescription(desc)
        .setColor('#FEE75C');
}

async function resolveCaptainVoting(client, matchDocId) {
    try {
        const match = await Match.findById(matchDocId);
        if (!match || match.status !== 'voting') return;

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        const votes = match.votes || new Map();

        // Count votes
        const voteCounts = {};
        for (const [voter, target] of votes.entries()) {
            voteCounts[target] = (voteCounts[target] || 0) + 1;
        }

        // Sort candidates by votes
        const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
        
        let c1, c2;

        if (sorted.length >= 2) {
            // Case A: 2 or more players got votes.
            c1 = sorted[0][0];
            c2 = sorted[1][0];
        } else if (sorted.length === 1) {
            // Case B: Exactly 1 player got a vote.
            c1 = sorted[0][0];
            const remaining = playerIds.filter(id => id !== c1);
            c2 = remaining[Math.floor(Math.random() * remaining.length)];
        } else {
            // Case C: No one voted.
            const shuffled = [...playerIds].sort(() => 0.5 - Math.random());
            c1 = shuffled[0];
            c2 = shuffled[1];
        }

        console.log(`>>> [MATCH] Captain Selection Resolved. Captain 1: ${c1}, Captain 2: ${c2}`);

        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        const lounge = guild ? await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null) : null;

        // Edit the voting message to remove components and show final results
        if (lounge && match.pickerMsgId) {
            const msg = await retryPromise(() => lounge.messages.fetch(match.pickerMsgId)).catch(() => null);
            if (msg) {
                const finishedEmbed = new EmbedBuilder()
                    .setTitle('🗳️ Voting Completed!')
                    .setDescription(`Voting has completed!\n\n👑 **Captain 1:** <@${c1}>\n👑 **Captain 2:** <@${c2}`)
                    .setColor('#FEE75C');
                await retryPromise(() => msg.edit({ embeds: [finishedEmbed], components: [] })).catch(() => {});
            }
        }

        await startPicking(client, match, c1, c2);
    } catch (err) {
        console.error('>>> [ERROR] resolveCaptainVoting failed:', err);
    }
}

async function startVoting(client, match) {
    try {
        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        if (!guild) return;
        const lounge = await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null);
        if (!lounge) return;

        await Match.updateOne({ _id: match._id }, { status: 'voting', votes: {} });
        
        const updatedMatch = await Match.findById(match._id);

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        
        // Build initial voting embed
        const embed = getCaptainVotingEmbed(updatedMatch, playerIds);

        const rows = [];
        for (let i = 0; i < playerIds.length; i += 5) {
            const row = new ActionRowBuilder();
            playerIds.slice(i, i + 5).forEach(id => {
                const memberName = guild.members.cache.get(id)?.user.username || 'Player';
                row.addComponents(new ButtonBuilder().setCustomId(`vote_cap_${id}_${match.matchId}`).setLabel(memberName).setStyle(ButtonStyle.Secondary));
            });
            rows.push(row);
        }

        const msg = await retryPromise(() => lounge.send({ embeds: [embed], components: rows }));
        
        // Save voting message ID
        await Match.updateOne({ _id: match._id }, { pickerMsgId: msg.id });

        // Start 30-second timeout to resolve captain selection voting
        if (votingTimeouts.has(match._id.toString())) clearTimeout(votingTimeouts.get(match._id.toString()));
        
        const timer = setTimeout(async () => {
            votingTimeouts.delete(match._id.toString());
            await resolveCaptainVoting(client, match._id);
        }, 30000);
        votingTimeouts.set(match._id.toString(), timer);
    } catch (err) {
        console.error('>>> [ERROR] startVoting failed:', err);
    }
}

async function startPicking(client, match, c1, c2) {
    try {
        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        if (!guild) return;
        const lounge = await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null);
        if (!lounge) return;

        // Filter captains out of the remaining pool — captains pick, they don't get picked
        const remaining = match.remainingPlayers
            ? match.remainingPlayers.split(',').filter(id => id !== c1 && id !== c2)
            : [];

        await Match.updateOne({ _id: match._id }, {
            status: 'picking',
            captain1Id: c1,
            captain2Id: c2,
            teamA: c1,
            teamB: c2,
            remainingPlayers: remaining.join(','),
            turnId: c1
        });

        // If no remaining players (e.g. only 2 players who are both captains), skip picking
        if (remaining.length === 0) {
            console.log(`>>> [MATCH] Only 2 players in Match #${match.matchId}. Skipping pick phase, finalizing teams...`);
            const updatedMatch = await Match.findById(match._id);
            return finalizeTeams(client, updatedMatch);
        }

        return updatePickingMessage(client, match._id);
    } catch (err) {
        console.error('>>> [ERROR] startPicking failed:', err);
    }
}

async function updatePickingMessage(client, matchId) {
    try {
        const match = await Match.findById(matchId);
        if (!match) return;
        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        if (!guild) return;
        const lounge = await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null);
        if (!lounge) return;

        if (!match.remainingPlayers || match.remainingPlayers.length === 0) return finalizeTeams(client, match);

        const remaining = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        const embed = new EmbedBuilder()
            .setTitle('🎯 Player Picking Phase')
            .setDescription(`<@${match.turnId}>, it is your turn to pick a player!\n\n**Team 1:** ${match.teamA.split(',').map(id => `<@${id}>`).join(', ')}\n**Team 2:** ${match.teamB.split(',').map(id => `<@${id}>`).join(', ')}\n\n**Remaining:**\n${remaining.map(id => `<@${id}>`).join(' ')}`)
            .setColor('#5865F2');

        const rows = [];
        for (let i = 0; i < remaining.length; i += 5) {
            const row = new ActionRowBuilder();
            remaining.slice(i, i + 5).forEach(id => {
                row.addComponents(new ButtonBuilder().setCustomId(`pick_${id}_${match._id}`).setLabel(guild.members.cache.get(id)?.user.username || 'Player').setStyle(ButtonStyle.Primary));
            });
            rows.push(row);
        }

        if (match.pickerMsgId) {
            const oldMsg = await retryPromise(() => lounge.messages.fetch(match.pickerMsgId)).catch(() => null);
            if (oldMsg) await retryPromise(() => oldMsg.delete()).catch(() => {});
        }

        const msg = await retryPromise(() => lounge.send({ content: `<@${match.turnId}>`, embeds: [embed], components: rows }));
        await Match.updateOne({ _id: match._id }, { pickerMsgId: msg.id });

        // Start 40-second timeout for auto-pick
        if (pickingTimeouts.has(match._id.toString())) clearTimeout(pickingTimeouts.get(match._id.toString()));
        const timer = setTimeout(async () => {
            pickingTimeouts.delete(match._id.toString());
            await autoPick(client, match._id);
        }, 40000);
        pickingTimeouts.set(match._id.toString(), timer);
    } catch (err) {
        console.error('>>> [ERROR] updatePickingMessage failed:', err);
    }
}

async function autoPick(client, matchId) {
    try {
        const match = await Match.findById(matchId);
        if (!match || match.status !== 'picking') return;

        const remaining = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        if (remaining.length === 0) return;

        const pickedId = remaining[Math.floor(Math.random() * remaining.length)];
        const isC1 = match.turnId === match.captain1Id;
        const teamKey = isC1 ? 'teamA' : 'teamB';
        
        const newTeam = match[teamKey] + ',' + pickedId;
        const newRemaining = remaining.filter(id => id !== pickedId).join(',');
        const nextTurn = isC1 ? match.captain2Id : match.captain1Id;

        await Match.updateOne({ _id: match._id }, {
            [teamKey]: newTeam,
            remainingPlayers: newRemaining,
            turnId: newRemaining.length > 0 ? nextTurn : match.turnId
        });

        console.log(`>>> [MATCH] Auto-picked <@${pickedId}> for Match #${match.matchId} (turn: <@${match.turnId}>)`);
        
        await updatePickingMessage(client, matchId);
    } catch (err) {
        console.error('>>> [ERROR] autoPick failed:', err);
    }
}

async function finalizeTeams(client, match) {
    try {
        const guild = await retryPromise(() => client.guilds.fetch(match.guildId)).catch(() => null);
        if (!guild) return;
        const lounge = await retryPromise(() => guild.channels.fetch(match.loungeChannelId)).catch(() => null);
        const categoryId = match.categoryId;

        const team1Vc = await retryPromise(() => guild.channels.create({
            name: '🔴 Team 1',
            type: ChannelType.GuildVoice,
            parent: categoryId,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: match.roleId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                },
                {
                    id: '1503814587877949632',
                    deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                }
            ],
        }));
        const team2Vc = await retryPromise(() => guild.channels.create({
            name: '🔵 Team 2',
            type: ChannelType.GuildVoice,
            parent: categoryId,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: match.roleId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                },
                {
                    id: '1503814587877949632',
                    deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                }
            ],
        }));

        await Match.updateOne({ _id: match._id }, { status: 'finished', teamAVcId: team1Vc.id, teamBVcId: team2Vc.id });

        const embed = new EmbedBuilder()
            .setTitle('✅ Lineups Finalized!')
            .setDescription(`**Team 1:**\n${match.teamA.split(',').map(id => `<@${id}>`).join('\n')}\n\n**Team 2:**\n${match.teamB.split(',').map(id => `<@${id}>`).join('\n')}\n\n*Players are being moved to their VCs...*`)
            .setColor('#57F287');

        if (lounge) await retryPromise(() => lounge.send({ embeds: [embed] })).catch(() => {});

        const team1Ids = match.teamA ? match.teamA.split(',') : [];
        const team2Ids = match.teamB ? match.teamB.split(',') : [];

        for (const id of team1Ids) {
            const member = await retryPromise(() => guild.members.fetch(id)).catch(() => null);
            if (member?.voice.channel) await retryPromise(() => member.voice.setChannel(team1Vc)).catch(() => {});
        }
        for (const id of team2Ids) {
            const member = await retryPromise(() => guild.members.fetch(id)).catch(() => null);
            if (member?.voice.channel) await retryPromise(() => member.voice.setChannel(team2Vc)).catch(() => {});
        }
        
        if (lounge && match.pickerMsgId) {
            const oldMsg = await retryPromise(() => lounge.messages.fetch(match.pickerMsgId)).catch(() => null);
            if (oldMsg) await retryPromise(() => oldMsg.delete()).catch(() => {});
        }

        // Unlock chat now that teams are set and players are in their VCs
        if (lounge && match.roleId) {
            // Allow everyone to view the lounge
            await lounge.permissionOverwrites.edit(match.guildId, {
                ViewChannel: true
            }).catch(err => console.error('>>> [PERMISSION] Failed to unlock lounge view for everyone:', err.message));
            
            // Allow the queue role to send messages
            await lounge.permissionOverwrites.edit(match.roleId, {
                SendMessages: true
            }).catch(err => console.error('>>> [PERMISSION] Failed to unlock lounge chat:', err.message));
            await lounge.send('Chat is now unlocked! Good luck both teams!').catch(() => {});
        }
    } catch (err) {
        console.error('>>> [ERROR] finalizeTeams failed:', err);
    }
}

async function handleQueueInteraction(interaction, client) {
    if (!interaction.isButton()) return;
    console.log(`>>> [INTERACTION] Button ${interaction.customId} used by ${interaction.user.tag}`);
    const [action, ...args] = interaction.customId.split('_');

    // --- SUBSTITUTE BUTTON HANDLERS ---
    if (action === 'sub' && args[0] === 'accept') {
        // customId format: sub_accept_<queueChannelId>_<originalUserId>
        const queueChannelId = args[1];
        const originalUserId = args[2];

        await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
        if (!interaction.deferred && !interaction.replied) return;

        // Check if the substitute is the same person who requested it
        if (interaction.user.id === originalUserId) {
            return safeInteractionEditReply(interaction, { content: '❌ You cannot substitute yourself!' });
        }

        // Check if player is blacklisted
        if (await checkAndHandleFriendlyBlacklist(interaction, interaction.user.id)) return;
        const isBlacklisted = await BlacklistedUser.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const hasBlacklistRole = interaction.member.roles.cache.has('1503814587877949632');
        if (hasBlacklistRole || (isBlacklisted && isBlacklisted.expiresAt > new Date())) {
            return safeInteractionEditReply(interaction, { content: '❌ You are blacklisted from joining queues!' });
        }

        // Check if they're already in a queue
        const alreadyInQueue = await ActiveQueuePlayer.findOne({ guildId: interaction.guild.id, userId: interaction.user.id });
        if (alreadyInQueue) {
            return safeInteractionEditReply(interaction, { content: '❌ You are already in a queue!' });
        }

        // Add the substitute to the queue
        try {
            await ActiveQueuePlayer.create({ guildId: interaction.guild.id, channelId: queueChannelId, userId: interaction.user.id });
        } catch (err) {
            return safeInteractionEditReply(interaction, { content: '❌ Failed to join the queue. You may already be in it.' });
        }

        // Update the queue message
        await sendQueueMessage(client, interaction.guild.id, queueChannelId);

        // Update the substitution embed to show it's been claimed
        const claimedEmbed = new EmbedBuilder()
            .setTitle('🔄 SUBSTITUTION — FILLED')
            .setDescription(`<@${interaction.user.id}> has substituted in for <@${originalUserId}> !`)
            .setColor('#57F287')
            .setTimestamp();

        await interaction.message.edit({ content: null, embeds: [claimedEmbed], components: [] }).catch(() => {});
        await safeInteractionEditReply(interaction, { content: '✅ You have been added to the queue as a substitute!' });

        // Check if queue is now full and should start
        const config = await QueueConfig.findOne({ guildId: interaction.guild.id, channelId: queueChannelId });
        const settings = await GuildSettings.findOneAndUpdate({ guildId: interaction.guild.id }, {}, { upsert: true, new: true });
        const reqPlayers = config?.requiredPlayers || settings.requiredPlayers || 14;
        const newPlayers = await ActiveQueuePlayer.find({ guildId: interaction.guild.id, channelId: queueChannelId });

        if (newPlayers.length >= reqPlayers) {
            console.log(`>>> [QUEUE] Queue full after substitute in ${interaction.guild.name}! Starting match...`);
            try {
                await createMatch(interaction.guild, newPlayers, settings);
                await GuildSettings.updateOne({ guildId: interaction.guild.id }, { $inc: { queueCount: 1 } });
                await ActiveQueuePlayer.deleteMany({ guildId: interaction.guild.id, channelId: queueChannelId });

                if (config && config.lastMessageId) {
                    const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
                    if (channel) {
                        const msg = await channel.messages.fetch(config.lastMessageId).catch(() => null);
                        if (msg) await msg.delete().catch(() => {});
                    }
                    await QueueConfig.updateOne({ guildId: interaction.guild.id, channelId: queueChannelId }, { lastMessageId: null });
                }
                // Queue will refresh on the next interval cycle, no immediate new queue message
            } catch (err) {
                console.error('>>> [ERROR] Match startup after substitute failed:', err);
            }
        }
        return;
    }

    if (action === 'sub' && args[0] === 'ignore') {
        // Acknowledge the interaction, then remove the substitution message
        await interaction.deferUpdate().catch(() => {});
        await interaction.message.delete().catch(() => {});
        return;
    }
    // --- END SUBSTITUTE BUTTON HANDLERS ---

    if (action === 'refresh' && args[0] === 'stats') {
        const targetId = args[1];
        const target = await client.users.fetch(targetId).catch(() => null);
        if (!target) return safeInteractionReply(interaction, { content: '❌ User not found.', ephemeral: true });

        const { getStatsEmbed } = require('./stats');
        const stats = await getStatsEmbed(target, interaction.guild.id, client);
        return interaction.update(stats);
    }

    if (action === 'method') {
        const [type, matchId] = args;
        const match = await Match.findOne({ matchId: parseInt(matchId), guildId: interaction.guild.id });
        if (!match || match.status !== 'choosing_method') return;

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        if (!playerIds.includes(interaction.user.id)) return safeInteractionReply(interaction, { content: '❌ You are not in this match!', ephemeral: true });

        if (!match.methodVotes) match.methodVotes = new Map();
        match.methodVotes.set(interaction.user.id, type);
        await match.save();

        const totalVoted = match.methodVotes.size;
        const newEmbed = getMethodVotingEmbed(match, playerIds);

        if (totalVoted >= playerIds.length) {
            await interaction.deferUpdate();
            if (methodTimeouts.has(match._id.toString())) {
                clearTimeout(methodTimeouts.get(match._id.toString()));
                methodTimeouts.delete(match._id.toString());
            }
            await resolveMethodVoting(client, match._id);
        } else {
            await interaction.update({ embeds: [newEmbed] });
        }
        return;
    }

    if (action === 'vote' && args[0] === 'cap') {
        const [_, targetId, matchId] = args;
        const match = await Match.findOne({ matchId: parseInt(matchId), guildId: interaction.guild.id });
        if (!match || match.status !== 'voting') return;

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        if (!playerIds.includes(interaction.user.id)) return safeInteractionReply(interaction, { content: '❌ You are not in this match!', ephemeral: true });

        if (!match.votes) match.votes = new Map();
        match.votes.set(interaction.user.id, targetId);
        await match.save();

        const totalVoted = match.votes.size;
        const newEmbed = getCaptainVotingEmbed(match, playerIds);

        if (totalVoted >= playerIds.length) {
            await interaction.deferUpdate();
            if (votingTimeouts.has(match._id.toString())) {
                clearTimeout(votingTimeouts.get(match._id.toString()));
                votingTimeouts.delete(match._id.toString());
            }
            await resolveCaptainVoting(client, match._id);
        } else {
            await interaction.update({ embeds: [newEmbed] });
        }
        return;
    }

    if (action === 'pick') {
        const [targetId, matchId] = args;
        const match = await Match.findById(matchId);
        if (!match || match.status !== 'picking') return;

        if (interaction.user.id !== match.turnId) return safeInteractionReply(interaction, { content: '❌ It is not your turn!', ephemeral: true });

        const isC1 = interaction.user.id === match.captain1Id;
        const teamKey = isC1 ? 'teamA' : 'teamB';
        const nextTurn = isC1 ? match.captain2Id : match.captain1Id;

        const newTeam = match[teamKey] + ',' + targetId;
        const newRemaining = match.remainingPlayers.split(',').filter(id => id !== targetId).join(',');

        await Match.updateOne({ _id: match._id }, {
            [teamKey]: newTeam,
            remainingPlayers: newRemaining,
            turnId: newRemaining.length > 0 ? nextTurn : match.turnId
        });

        await interaction.deferUpdate();
        return updatePickingMessage(client, match._id);
    }

    if (interaction.customId === 'join_queue') {
        await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
        if (!interaction.deferred && !interaction.replied) return;

        if (queueLocks.has(interaction.guild.id)) {
            return safeInteractionEditReply(interaction, { content: '⏳ Please wait, another player is joining...' });
        }
        queueLocks.add(interaction.guild.id);

        try {
            console.log(`>>> [QUEUE] ${interaction.user.tag} attempting to join queue in ${interaction.guild.name}`);

            const config = await QueueConfig.findOne({ guildId: interaction.guild.id, channelId: interaction.channel.id });
            const settings = await GuildSettings.findOneAndUpdate({ guildId: interaction.guild.id }, {}, { upsert: true, new: true });
            const reqPlayers = config?.requiredPlayers || settings.requiredPlayers || 14;

            // Check if player is blacklisted
            if (await checkAndHandleFriendlyBlacklist(interaction, interaction.user.id)) return;
            const isBlacklistedInDb = await BlacklistedUser.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const hasBlacklistRole = interaction.member.roles.cache.has('1503814587877949632');
            
            if (hasBlacklistRole || (isBlacklistedInDb && isBlacklistedInDb.expiresAt > new Date())) {
                if (!hasBlacklistRole) {
                    await interaction.member.roles.add('1503814587877949632').catch(() => {});
                }
                queueLocks.delete(interaction.guild.id);
                return safeInteractionEditReply(interaction, { content: '❌ You are blacklisted from joining queues!' });
            }

            // Lazy cleanup of expired blacklist
            if (isBlacklistedInDb && isBlacklistedInDb.expiresAt <= new Date()) {
                await BlacklistedUser.deleteOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                if (hasBlacklistRole) {
                    await interaction.member.roles.remove('1503814587877949632').catch(() => {});
                }
            }

            const players = await ActiveQueuePlayer.find({ guildId: interaction.guild.id, channelId: interaction.channel.id });
            
            if (players.some(p => p.userId === interaction.user.id)) {
                queueLocks.delete(interaction.guild.id);
                return safeInteractionEditReply(interaction, { content: '❌ Already in queue!' });
            }
            
            await ActiveQueuePlayer.create({ guildId: interaction.guild.id, channelId: interaction.channel.id, userId: interaction.user.id });
            const newPlayers = await ActiveQueuePlayer.find({ guildId: interaction.guild.id, channelId: interaction.channel.id });

            await safeInteractionEditReply(interaction, { content: `✅ Joined! (${newPlayers.length}/${reqPlayers})` });
            await sendQueueMessage(client, interaction.guild.id, interaction.channel.id);

            if (newPlayers.length >= reqPlayers) {
                console.log(`>>> [QUEUE] Queue full in ${interaction.guild.name}! Starting match...`);
                
                try {
                    const checkPlayers = await ActiveQueuePlayer.find({ guildId: interaction.guild.id, channelId: interaction.channel.id });
                    if (checkPlayers.length < reqPlayers) {
                        console.log(`>>> [QUEUE] Concurrency lock saved the day! Match already created.`);
                        queueLocks.delete(interaction.guild.id);
                        return;
                    }

                    await createMatch(interaction.guild, newPlayers, settings);
                    
                    await GuildSettings.updateOne({ guildId: interaction.guild.id }, { $inc: { queueCount: 1 } });
                    await ActiveQueuePlayer.deleteMany({ guildId: interaction.guild.id, channelId: interaction.channel.id });
                    
                    if (config && config.lastMessageId) {
                        const channel = await interaction.guild.channels.fetch(config.channelId).catch(() => null);
                        if (channel) {
                            const msg = await channel.messages.fetch(config.lastMessageId).catch(() => null);
                            if (msg) await msg.delete().catch(() => {});
                        }
                        await QueueConfig.updateOne({ guildId: interaction.guild.id, channelId: interaction.channel.id }, { lastMessageId: null });
                    }
                    // Queue will refresh on the next interval cycle, no immediate new queue message
                } catch (err) {
                    console.error('>>> [ERROR] Match startup failed:', err);
                    await interaction.channel.send('❌ Failed to create match channels. Please check bot permissions!').catch(() => {});
                }
            }
        } finally {
            queueLocks.delete(interaction.guild.id);
        }
    }

    if (interaction.customId === 'leave_queue') {
        await safeInteractionDeferReply(interaction, { ephemeral: true }).catch(err => console.error('>>> [ERROR] Defer failed:', err.message));
        if (!interaction.deferred && !interaction.replied) return;
        console.log(`>>> [QUEUE] ${interaction.user.tag} attempting to leave queue in ${interaction.guild.name}`);
        
        await ActiveQueuePlayer.deleteOne({ guildId: interaction.guild.id, channelId: interaction.channel.id, userId: interaction.user.id });
        await safeInteractionEditReply(interaction, { content: '✅ Left queue.' });
        await sendQueueMessage(client, interaction.guild.id, interaction.channel.id);
    }
}

const SUB_CHANNEL_ID = '1503753481071104010';

async function checkAndSendSubstitutionAlert(client, match, force = false) {
    try {
        if (match.hasSentSubRequests && !force) return;

        const guild = client.guilds.cache.get(match.guildId) || await client.guilds.fetch(match.guildId).catch(() => null);
        if (!guild) return;

        const vc = guild.channels.cache.get(match.playersVcId) || await guild.channels.fetch(match.playersVcId).catch(() => null);
        if (!vc) return;

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        const missingPlayers = playerIds.filter(id => !vc.members.has(id));

        if (missingPlayers.length === 0) {
            if (force) {
                console.log(`>>> [SUB] Force requested subs for Match #${match.matchId} but all players are in VC.`);
            }
            return;
        }

        const subChannel = client.channels.cache.get(SUB_CHANNEL_ID) || await client.channels.fetch(SUB_CHANNEL_ID).catch(() => null);
        if (!subChannel) {
            console.error(`>>> [SUB] Substitutes channel ${SUB_CHANNEL_ID} not found!`);
            return;
        }

        const pings = missingPlayers.map(id => `<@${id}>`).join(', ');
        const embed = new EmbedBuilder()
            .setTitle(`🔄 REPLACEMENTS NEEDED — Match #${match.matchId}`)
            .setDescription(`${pings} didn't participate in the scrim, looking for replacements!\n\nClick the **Join as Substitute** button below to replace one of them.`)
            .setColor('#ED4245')
            .setTimestamp()
            .setFooter({ text: `Match #${match.matchId} • Substitutes` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sub_request_join_${match._id.toString()}`)
                .setLabel('Join as Substitute')
                .setStyle(ButtonStyle.Success)
        );

        const sentMsg = await subChannel.send({
            content: `${pings} Please join the voice channel!`,
            embeds: [embed],
            components: [row]
        });

        await Match.updateOne({ _id: match._id }, {
            hasSentSubRequests: true,
            subMessageId: sentMsg.id
        });
        
        console.log(`>>> [SUB] Posted replacement alert for Match #${match.matchId} in ${subChannel.name}`);
    } catch (err) {
        console.error(`>>> [SUB-ERROR] checkAndSendSubstitutionAlert failed for Match #${match?.matchId}:`, err.message);
    }
}

async function sendMidMatchLeaveSubAlert(client, match, leaverId) {
    try {
        const guild = client.guilds.cache.get(match.guildId) || await client.guilds.fetch(match.guildId).catch(() => null);
        if (!guild) return;

        const subChannel = client.channels.cache.get(SUB_CHANNEL_ID) || await client.channels.fetch(SUB_CHANNEL_ID).catch(() => null);
        if (!subChannel) {
            console.error(`>>> [SUB-LEAVE] Substitutes channel ${SUB_CHANNEL_ID} not found!`);
            return;
        }

        // Collect ALL currently missing players (not just the leaver)
        const vc = guild.channels.cache.get(match.playersVcId) || await guild.channels.fetch(match.playersVcId).catch(() => null);
        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        const missingPlayers = vc
            ? playerIds.filter(id => !vc.members.has(id))
            : [leaverId];
        // Ensure the leaver is included
        if (!missingPlayers.includes(leaverId)) missingPlayers.push(leaverId);

        const pings = missingPlayers.map(id => `<@${id}>`).join(', ');
        const embed = new EmbedBuilder()
            .setTitle(`🚨 PLAYER LEFT — Match #${match.matchId}`)
            .setDescription(`${pings} left the scrim, looking for replacements!\n\nClick the **Join as Substitute** button below to replace one of them.`)
            .setColor('#ED4245')
            .setTimestamp()
            .setFooter({ text: `Match #${match.matchId} • Substitutes` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sub_request_join_${match._id.toString()}`)
                .setLabel('Join as Substitute')
                .setStyle(ButtonStyle.Success)
        );

        // If there's already a sub message, delete it to ensure a fresh ping
        if (match.subMessageId) {
            const existingMsg = await subChannel.messages.fetch(match.subMessageId).catch(() => null);
            if (existingMsg) {
                await existingMsg.delete().catch(() => {});
            }
        }

        // Send a new message
        const sentMsg = await subChannel.send({
            content: `@everyone ${pings} left the scrim and needs to be replaced!`,
            embeds: [embed],
            components: [row]
        });

        await Match.updateOne({ _id: match._id }, {
            hasSentSubRequests: true,
            subMessageId: sentMsg.id
        });

        console.log(`>>> [SUB-LEAVE] Posted new replacement alert for Match #${match.matchId} (player <@${leaverId}> left)`);
    } catch (err) {
        console.error(`>>> [SUB-LEAVE-ERROR] sendMidMatchLeaveSubAlert failed for Match #${match?.matchId}:`, err.message);
    }
}

async function handleSubRequestInteraction(interaction, client) {
    try {
        // Validate that safe functions are available
        if (typeof safeInteractionReply !== 'function') {
            console.error('>>> [SUB-INTERACTION-ERROR] safeInteractionReply not available as function:', typeof safeInteractionReply);
            if (interaction.isRepliable()) {
                await interaction.reply({ content: '❌ Internal error: sub system not ready.', ephemeral: true }).catch(() => {});
            }
            return true;
        }

        const parts = interaction.customId.split('_');
        if (parts[0] !== 'sub' || parts[1] !== 'request') return false;

        const subAction = parts[2];
        const matchId = parts[3];

        const match = await Match.findById(matchId);
        if (!match) {
            if (interaction.isRepliable()) {
                await safeInteractionReply(interaction, { content: '❌ Match not found.', ephemeral: true }).catch(() => {});
            }
            return true;
        }

        const guild = interaction.guild;

        if (await checkAndHandleFriendlyBlacklist(interaction, interaction.user.id)) return true;
        const isBlacklisted = await BlacklistedUser.findOne({ userId: interaction.user.id, guildId: guild.id });
        const hasBlacklistRole = interaction.member.roles.cache.has('1503814587877949632');
        if (hasBlacklistRole || (isBlacklisted && isBlacklisted.expiresAt > new Date())) {
            await safeInteractionReply(interaction, { content: '❌ You are blacklisted from joining queues/matches!', ephemeral: true }).catch(() => {});
            return true;
        }

        const playerIds = match.remainingPlayers ? match.remainingPlayers.split(',') : [];
        if (playerIds.includes(interaction.user.id)) {
            await safeInteractionReply(interaction, { content: '❌ You are already a player in this match!', ephemeral: true }).catch(() => {});
            return true;
        }

        const activeMatch = await Match.findOne({
            guildId: guild.id,
            status: { $in: ['pre_vc', 'choosing_method', 'voting', 'picking', 'finished'] },
            $or: [
                { remainingPlayers: new RegExp(interaction.user.id) },
                { pickedPlayers: new RegExp(interaction.user.id) },
                { teamA: new RegExp(interaction.user.id) },
                { teamB: new RegExp(interaction.user.id) }
            ]
        });
        if (activeMatch && activeMatch._id.toString() !== match._id.toString()) {
            await safeInteractionReply(interaction, { content: '❌ You are already playing or queued in another active match!', ephemeral: true }).catch(() => {});
            return true;
        }

        const vc = guild.channels.cache.get(match.playersVcId) || await guild.channels.fetch(match.playersVcId).catch(() => null);
        if (!vc) {
            await safeInteractionReply(interaction, { content: '❌ Pre-match voice channel not found.', ephemeral: true }).catch(() => {});
            return true;
        }

        if (subAction === 'join') {
            const missingPlayers = playerIds.filter(id => !vc.members.has(id));

            if (missingPlayers.length === 0) {
                await safeInteractionReply(interaction, { content: '❌ Everyone is currently in the voice channel! No substitutes are needed.', ephemeral: true }).catch(() => {});
                return true;
            }

            const options = [];
            for (const id of missingPlayers) {
                const member = await guild.members.fetch(id).catch(() => null);
                const displayName = member?.user.username || `User ${id}`;
                options.push({
                    label: displayName,
                    value: id,
                    description: `Replace ${displayName}`
                });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`sub_request_select_${match._id.toString()}`)
                .setPlaceholder('Select a player to replace')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await safeInteractionReply(interaction, { content: 'Select which missing player you want to substitute for:', components: [row], ephemeral: true }).catch(() => {});
            return true;
        }

        if (subAction === 'select') {
            const oldPlayerId = interaction.values[0];

            const currentMatch = await Match.findById(match._id);
            if (!currentMatch) return true;

            const currentPlayerIds = currentMatch.remainingPlayers ? currentMatch.remainingPlayers.split(',') : [];
            
            if (!currentPlayerIds.includes(oldPlayerId)) {
                await safeInteractionReply(interaction, { content: '❌ That player has already been replaced.', ephemeral: true }).catch(() => {});
                return true;
            }

            if (vc.members.has(oldPlayerId)) {
                await safeInteractionReply(interaction, { content: '❌ That player is now in the voice channel and cannot be replaced.', ephemeral: true }).catch(() => {});
                return true;
            }

            const newPlayerIds = currentPlayerIds.map(id => id === oldPlayerId ? interaction.user.id : id);
            await Match.updateOne({ _id: currentMatch._id }, { remainingPlayers: newPlayerIds.join(',') });

            const oldMember = await guild.members.fetch(oldPlayerId).catch(() => null);
            if (oldMember && currentMatch.roleId) {
                await oldMember.roles.remove(currentMatch.roleId).catch(() => {});
            }

            // Auto-blacklist the player who didn't join
            await autoBlacklistPlayer(guild, oldPlayerId);
            await interaction.member.roles.add(currentMatch.roleId).catch(() => {});

            const lounge = guild.channels.cache.get(currentMatch.loungeChannelId) || await guild.channels.fetch(currentMatch.loungeChannelId).catch(() => null);
            if (lounge) {
                await lounge.send({ content: `🔄 **Substitution:** <@${interaction.user.id}> has replaced <@${oldPlayerId}> in the match!` }).catch(() => {});
            }

            await safeInteractionReply(interaction, { content: `✅ You have successfully replaced <@${oldPlayerId}>!`, ephemeral: true }).catch(() => {});

            const subChannel = client.channels.cache.get(SUB_CHANNEL_ID) || await client.channels.fetch(SUB_CHANNEL_ID).catch(() => null);
            if (subChannel && currentMatch.subMessageId) {
                const subMsg = await subChannel.messages.fetch(currentMatch.subMessageId).catch(() => null);
                if (subMsg) {
                    const currentMissing = newPlayerIds.filter(id => id !== interaction.user.id && !vc.members.has(id));
                    
                    if (currentMissing.length > 0) {
                        const newPings = currentMissing.map(id => `<@${id}>`).join(', ');
                        const updatedEmbed = new EmbedBuilder()
                            .setTitle(`🔄 REPLACEMENTS NEEDED — Match #${currentMatch.matchId}`)
                            .setDescription(`${newPings} didn't participate in the scrim, looking for replacements!\n\nClick the **Join as Substitute** button below to replace one of them.`)
                            .setColor('#ED4245')
                            .setTimestamp()
                            .setFooter({ text: `Match #${currentMatch.matchId} • Substitutes` });
                        
                        await subMsg.edit({
                            content: `@everyone ${newPings} Please join the voice channel!`,
                            embeds: [updatedEmbed]
                        }).catch(() => {});
                    } else {
                        const filledEmbed = new EmbedBuilder()
                            .setTitle(`✅ REPLACEMENTS FILLED — Match #${currentMatch.matchId}`)
                            .setDescription(`All missing players have been replaced! The match is proceeding.`)
                            .setColor('#57F287')
                            .setTimestamp()
                            .setFooter({ text: `Match #${currentMatch.matchId} • Substitutes` });

                        await subMsg.edit({
                            content: `@everyone They got subs!`,
                            embeds: [filledEmbed],
                            components: []
                        }).catch(() => {});
                    }
                }
            }
            return true;
        }

    } catch (err) {
        console.error('>>> [SUB-INTERACTION-ERROR] Failed to handle sub request:', err.message);
        console.error('>>> [SUB-INTERACTION-ERROR] Stack:', err.stack?.split('\n').slice(0, 3).join('\n'));
        // Attempt fallback response
        if (interaction.isRepliable()) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: '❌ Error processing substitution request.' }).catch(() => {});
                } else {
                    await interaction.reply({ content: '❌ Error processing substitution request.', ephemeral: true }).catch(() => {});
                }
            } catch (replyErr) {
                console.error('>>> [SUB-INTERACTION-ERROR] Fallback response failed:', replyErr.message);
            }
        }
    }
    return false;
}

async function checkAndHandleFriendlyBlacklist(interaction, userId) {
    try {
        const isBlacklisted = await BlacklistedUser.findOne({ userId, guildId: interaction.guild.id });
        if (isBlacklisted && isBlacklisted.isFriendlyBlacklist) {
            if (interaction.deferred || interaction.replied) {
                await safeInteractionEditReply(interaction, { content: '❌ You are blacklisted from playing 1 friendly.' }).catch(() => {});
            } else {
                await safeInteractionReply(interaction, { content: '❌ You are blacklisted from playing 1 friendly.', ephemeral: true }).catch(() => {});
            }
            const scrimsMsg = await interaction.channel.send(`<@${userId}> Your blacklisted from playing 1 friendly`).catch(() => null);
            if (scrimsMsg) {
                setTimeout(() => {
                    scrimsMsg.delete().catch(() => {});
                }, 5000);
            }
            return true;
        }
    } catch (err) {
        console.error('>>> [ERROR] checkAndHandleFriendlyBlacklist failed:', err.message);
    }
    return false;
}

async function autoBlacklistPlayer(guild, userId) {
    try {
        const client = guild.client;
        
        // 1. Give the blacklist role
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
            await member.roles.add('1503814587877949632').catch(err => {
                console.error('>>> [ERROR] Failed to add blacklist role on auto-blacklist:', err.message);
            });
        }

        // 2. Save blacklist record in DB
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 100);

        await BlacklistedUser.findOneAndUpdate(
            { userId, guildId: guild.id },
            { 
                expiresAt,
                isFriendlyBlacklist: true,
                scrimsRemaining: 1
            },
            { upsert: true, new: true }
        );

        // 3. Find actions channel
        let actionsChannel = guild.channels.cache.find(c => c.name.toLowerCase() === 'actions' || c.name.toLowerCase() === 'bot-actions');
        if (!actionsChannel) {
            const channels = await guild.channels.fetch().catch(() => new Map());
            actionsChannel = channels.find(c => c.name.toLowerCase() === 'actions' || c.name.toLowerCase() === 'bot-actions' || c.name.toLowerCase().includes('action'));
        }

        if (actionsChannel) {
            const embed = new EmbedBuilder()
                .setTitle('🚫 Player Blacklisted')
                .setDescription(`<@${userId}> has been automatically blacklisted for **1 scrim** because they failed to join the pre-match voice channel.`)
                .setColor('#ED4245')
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`appeal_blacklist_${userId}`)
                    .setLabel('Appeal')
                    .setStyle(ButtonStyle.Primary)
            );

            await actionsChannel.send({ embeds: [embed], components: [row] }).catch(err => {
                console.error('>>> [ERROR] Failed to send blacklist embed to actions channel:', err.message);
            });
        }
        
        console.log(`>>> [BLACKLIST] Auto-blacklisted user ${userId} for 1 scrim in guild ${guild.id}`);
    } catch (err) {
        console.error('>>> [ERROR] autoBlacklistPlayer failed:', err);
    }
}

module.exports = { 
    sendQueueMessage, 
    handleQueueInteraction, 
    queueIntervals, 
    startCaptainSelection, 
    createMatch,
    checkAndSendSubstitutionAlert,
    handleSubRequestInteraction,
    sendMidMatchLeaveSubAlert,
    autoBlacklistPlayer,
    checkAndHandleFriendlyBlacklist
};

