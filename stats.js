const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { UserPoints, PointHistory, VerifiedUser } = require('./models');

async function getStatsEmbed(target, guildId, client) {
    const sharedGuildId = 'shared_scrims';
    let data = await UserPoints.findOne({ userId: target.id, guildId: sharedGuildId });
    if (!data) data = { points: 1000, wins: 0, losses: 0, totalGames: 0 };

    const higherPlayers = await UserPoints.countDocuments({ guildId: sharedGuildId, points: { $gt: data.points } });
    const totalPlayers = await UserPoints.countDocuments({ guildId: sharedGuildId }) || 1;
    const rank = higherPlayers + 1;
    const percentile = ((rank / totalPlayers) * 100).toFixed(1);

    let division = "BRONZE DIVISION";
    let divisionEmoji = "🥉";
    if (data.points >= 2000) { division = "PLATINUM DIVISION"; divisionEmoji = "💎"; }
    else if (data.points >= 1700) { division = "GOLD DIVISION"; divisionEmoji = "🥇"; }
    else if (data.points >= 1400) { division = "SILVER DIVISION"; divisionEmoji = "🥈"; }

    const history = await PointHistory.find({ userId: target.id, guildId: sharedGuildId }).sort({ timestamp: -1 }).limit(3);
    const historyText = history.length > 0 
        ? history.map((h, i) => `\`${i + 1}\` **${h.type.toUpperCase()}** \`${h.points > 0 ? '+' : ''}${h.points.toFixed(1)}\` | <t:${Math.floor(h.timestamp.getTime() / 1000)}:R>`).join('\n')
        : "No recent history found.";

    const winrate = data.wins + data.losses > 0 ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(0) : 0;
    const totalGames = data.totalGames || (data.wins + data.losses);
    
    // Generate Chart URL
    const chartConfig = {
        type: 'line',
        data: {
            labels: ['G1', 'G2', 'G3', 'G4', 'G5'],
            datasets: [{
                label: 'MMR Trend',
                borderColor: 'orange',
                backgroundColor: 'rgba(255, 165, 0, 0.1)',
                data: history.map(h => h.points).reverse().reduce((acc, val, i) => [...acc, (acc[i-1] || data.points) + val], []),
                fill: true
            }]
        },
        options: {
            title: { display: true, text: `${target.username.toUpperCase()} - ${division}`, fontColor: 'orange' },
            legend: { labels: { fontColor: 'white' } },
            scales: {
                yAxes: [{ gridLines: { color: 'rgba(255,255,255,0.1)' }, ticks: { fontColor: 'white' } }],
                xAxes: [{ gridLines: { color: 'rgba(255,255,255,0.1)' }, ticks: { fontColor: 'white' } }]
            }
        }
    };
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&bkg=transparent&w=500&h=300`;

    const embed = new EmbedBuilder()
        .setAuthor({ name: `SCRIM PROFILE: ${target.username}`, iconURL: target.displayAvatarURL() })
        .setTitle(`${divisionEmoji} ${division}`)
        .setColor('#5865F2')
        .addFields(
            { name: '──── 🎮 MATCH HISTORY ────', value: '\u200B', inline: false },
            { name: '🏅 TOTAL GAMES', value: `\`${totalGames}\``, inline: true },
            { name: '✅ WINS', value: `\`${data.wins}\``, inline: true },
            { name: '❌ LOSSES', value: `\`${data.losses}\``, inline: true },
            { name: '📈 WINRATE', value: `\`${winrate}%\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '──── 💰 POINTS & RANKING ────', value: '\u200B', inline: false },
            { name: '📊 POINTS (MMR)', value: `\`${data.points.toFixed(1)}\``, inline: true },
            { name: '🏆 RANKING', value: `\`#${rank}\` (TOP ${percentile}%)`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '🕒 RECENT HISTORY', value: historyText }
        )
        .setImage(chartUrl)
        .setFooter({ text: 'eScrims Premium Analytics', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`refresh_stats_${target.id}`).setLabel('Refresh Data').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

function getProgressBar(points) {
    let prevMilestone = 1000;
    let nextMilestone = 1400;
    let nextDiv = "SILVER";
    
    if (points >= 2000) {
        return "⚡ **PLATINUM (MAX DIVISION)**";
    } else if (points >= 1700) {
        prevMilestone = 1700;
        nextMilestone = 2000;
        nextDiv = "PLATINUM";
    } else if (points >= 1400) {
        prevMilestone = 1400;
        nextMilestone = 1700;
        nextDiv = "GOLD";
    } else if (points < 1000) {
        prevMilestone = 0;
        nextMilestone = 1000;
        nextDiv = "BRONZE";
    }
    
    const totalNeeded = nextMilestone - prevMilestone;
    const currentProgress = points - prevMilestone;
    const percentage = Math.max(0, Math.min(100, (currentProgress / totalNeeded) * 100));
    
    const filledBlocks = Math.round(percentage / 10);
    const emptyBlocks = 10 - filledBlocks;
    const bar = "▰".repeat(filledBlocks) + "▱".repeat(emptyBlocks);
    
    return `\`${bar}\` **${percentage.toFixed(0)}%** to **${nextDiv}**`;
}

async function getSearchEmbed(targetUser, guildId, client) {
    const verifiedRecord = await VerifiedUser.findOne({ discordId: targetUser.id });
    if (!verifiedRecord) {
        return {
            embeds: [
                new EmbedBuilder()
                    .setTitle('❌ User Not Verified')
                    .setDescription(`<@${targetUser.id}> is not verified with the eScrims bot yet!\n\nThey need to verify their Roblox account using the \`/verify\` command first.`)
                    .setColor('#FF4B4B')
                    .setTimestamp()
            ]
        };
    }

    const robloxId = verifiedRecord.robloxId;
    const robloxUsername = verifiedRecord.robloxUsername;

    // 1. Fetch Roblox user profile details (About & Created date)
    let robloxDescription = "No description available.";
    let robloxCreated = "Unknown";
    let robloxDisplayName = robloxUsername;
    const profileRes = await fetch(`https://users.roblox.com/v1/users/${robloxId}`).catch(() => null);
    if (profileRes && profileRes.ok) {
        const profileData = await profileRes.json();
        robloxDescription = profileData.description || "No description.";
        robloxDisplayName = profileData.displayName || robloxUsername;
        if (profileData.created) {
            robloxCreated = new Date(profileData.created).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }
    }

    // 2. Fetch Roblox Avatar Images (Headshot and Full Body)
    let headshotUrl = "https://www.roblox.com/images/ThumbnailHolder.png";
    const headshotRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=352x352&format=Png&isCircular=false`).catch(() => null);
    if (headshotRes && headshotRes.ok) {
        const headshotData = await headshotRes.json();
        if (headshotData.data && headshotData.data.length > 0) {
            headshotUrl = headshotData.data[0].imageUrl || headshotUrl;
        }
    }

    let fullBodyUrl = "";
    const fullBodyRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=420x420&format=Png&isCircular=false`).catch(() => null);
    if (fullBodyRes && fullBodyRes.ok) {
        const fullBodyData = await fullBodyRes.json();
        if (fullBodyData.data && fullBodyData.data.length > 0) {
            fullBodyUrl = fullBodyData.data[0].imageUrl || "";
        }
    }

    // 3. Fetch Group Membership for RFL (33613424) & RFL Group Icon
    let isRFL = false;
    let rflRoleName = '';
    let rflRank = 0;
    const groupsRes = await fetch(`https://groups.roblox.com/v2/users/${robloxId}/groups/roles`).catch(() => null);
    if (groupsRes && groupsRes.ok) {
        const groupsData = await groupsRes.json();
        const groupRecord = (groupsData.data || []).find(g => g.group && g.group.id === 33613424);
        if (groupRecord) {
            isRFL = true;
            rflRoleName = groupRecord.role ? groupRecord.role.name : 'Member';
            rflRank = groupRecord.role ? groupRecord.role.rank : 0;
        }
    }

    let rflGroupIconUrl = "";
    const groupIconRes = await fetch(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=33613424&size=150x150&format=Png`).catch(() => null);
    if (groupIconRes && groupIconRes.ok) {
        const iconData = await groupIconRes.json();
        if (iconData.data && iconData.data.length > 0) {
            rflGroupIconUrl = iconData.data[0].imageUrl || "";
        }
    }

    // 4. Calculate Avatar Cost
    let avatarCost = 0;
    let itemsCount = 0;
    const avatarDetailRes = await fetch(`https://avatar.roblox.com/v1/users/${robloxId}/avatar`).catch(() => null);
    if (avatarDetailRes && avatarDetailRes.ok) {
        const avatarDetailData = await avatarDetailRes.json();
        const assets = avatarDetailData.assets || [];
        itemsCount = assets.length;
        if (assets.length > 0) {
            const payloadItems = assets.map(a => ({ itemType: 'Asset', id: a.id }));
            const catalogRes = await fetch('https://catalog.roblox.com/v1/catalog/items/details', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: payloadItems })
            }).catch(() => null);

            if (catalogRes && catalogRes.ok) {
                const catalogData = await catalogRes.json();
                const items = catalogData.data || [];
                for (const item of items) {
                    const price = item.price || item.lowestPrice || 0;
                    avatarCost += price;
                }
            }
        }
    }

    // 5. Fetch Friends Count
    let friendsCount = '?';
    const friendsRes = await fetch(`https://friends.roblox.com/v1/users/${robloxId}/friends/count`).catch(() => null);
    if (friendsRes && friendsRes.ok) {
        const friendsData = await friendsRes.json();
        friendsCount = friendsData.count ?? '?';
    }

    // 6. Fetch Followers Count
    let followersCount = '?';
    const followersRes = await fetch(`https://friends.roblox.com/v1/users/${robloxId}/followers/count`).catch(() => null);
    if (followersRes && followersRes.ok) {
        const followersData = await followersRes.json();
        followersCount = followersData.count ?? '?';
    }

    // 7. Query eScrims Stats
    const sharedGuildId = 'shared_scrims';
    let data = await UserPoints.findOne({ userId: targetUser.id, guildId: sharedGuildId });
    if (!data) data = { points: 1000, wins: 0, losses: 0, totalGames: 0 };

    const higherPlayers = await UserPoints.countDocuments({ guildId: sharedGuildId, points: { $gt: data.points } });
    const totalPlayers = await UserPoints.countDocuments({ guildId: sharedGuildId }) || 1;
    const rank = higherPlayers + 1;
    const percentile = ((rank / totalPlayers) * 100).toFixed(1);

    let division = "BRONZE DIVISION";
    let divisionEmoji = "🥉";
    if (data.points >= 2000) { division = "PLATINUM DIVISION"; divisionEmoji = "💎"; }
    else if (data.points >= 1700) { division = "GOLD DIVISION"; divisionEmoji = "🥇"; }
    else if (data.points >= 1400) { division = "SILVER DIVISION"; divisionEmoji = "🥈"; }

    const winrate = data.wins + data.losses > 0 ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(0) : 0;
    const totalGames = data.totalGames || (data.wins + data.losses);

    // 8. Account Age
    let accountAge = '';
    if (robloxCreated !== 'Unknown') {
        const createdDate = new Date(robloxCreated);
        const now = new Date();
        const diffYears = Math.floor((now - createdDate) / (365.25 * 24 * 60 * 60 * 1000));
        const diffDays = Math.floor((now - createdDate) / (24 * 60 * 60 * 1000));
        if (diffYears >= 1) {
            accountAge = ` (${diffYears} year${diffYears > 1 ? 's' : ''} old)`;
        } else {
            accountAge = ` (${diffDays} day${diffDays !== 1 ? 's' : ''} old)`;
        }
    }

    // Build RFL status display
    const rflStatus = isRFL
        ? `✅ **YES, USER IS RFL**\n🏆 Rank: **${rflRoleName}** *(Rank ${rflRank})*`
        : `❌ **NO, NOT IN RFL**\n⚠️ User does not belong to the RFL group.`;

    const scrimProgress = getProgressBar(data.points);
    const thumbnailToShow = (isRFL && rflGroupIconUrl) ? rflGroupIconUrl : headshotUrl;

    const embed = new EmbedBuilder()
        .setAuthor({ name: `🔍 PLAYER SEARCH: ${targetUser.username.toUpperCase()}`, iconURL: targetUser.displayAvatarURL() })
        .setTitle(`🌐 ${robloxDisplayName} (@${robloxUsername})`)
        .setURL(`https://www.roblox.com/users/${robloxId}/profile`)
        .setColor(isRFL ? '#00FF7F' : '#FF4B4B')
        .addFields(
            { name: '🛡️ GROUP MEMBERSHIP STATUS', value: rflStatus, inline: false },
            { name: '────────────────────────────────────────', value: '\u200b', inline: false },
            { name: '👤 DISCORD USER', value: `<@${targetUser.id}>\n\`${targetUser.username}\`\nID: \`${targetUser.id}\``, inline: true },
            { name: '🤖 ROBLOX USER', value: `\`${robloxUsername}\`\nID: \`${robloxId}\`\nCreated: \`${robloxCreated}\`${accountAge}`, inline: true },
            { name: '────────────────────────────────────────', value: '\u200b', inline: false },
            { name: '📝 ABOUT BIO', value: `>>> ${robloxDescription.substring(0, 450)}${robloxDescription.length > 450 ? '...' : ''}`, inline: false },
            { name: '────────────────────────────────────────', value: '\u200b', inline: false },
            { name: '💰 AVATAR VALUE', value: `💵 **${avatarCost.toLocaleString()}** Robux\n👕 \`${itemsCount}\` items equipped`, inline: true },
            { name: '👥 SOCIAL STATS', value: `👥 **${friendsCount.toLocaleString()}** Friends\n📈 **${followersCount.toLocaleString()}** Followers`, inline: true },
            { name: '────────────────────────────────────────', value: '\u200b', inline: false },
            { name: `${divisionEmoji} ${division} PERFORMANCE`, value: `⭐ **${data.points.toFixed(1)}** MMR • Rank **#${rank}** (Top ${percentile}%)\n🏆 **${data.wins}** Wins / ❌ **${data.losses}** Losses • 📈 \`${winrate}%\` Win Rate\n🎮 Total Scrims: \`${totalGames}\` matches\n📊 Next Tier: ${scrimProgress}`, inline: false }
        )
        .setFooter({ text: 'eScrims Premium Player Search', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

    if (thumbnailToShow) {
        embed.setThumbnail(thumbnailToShow);
    }
    if (fullBodyUrl) {
        embed.setImage(fullBodyUrl);
    }

    return { embeds: [embed] };
}

module.exports = { getStatsEmbed, getSearchEmbed };
