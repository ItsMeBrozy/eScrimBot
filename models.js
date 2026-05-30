const mongoose = require('mongoose');

const HubSchema = new mongoose.Schema({ guildId: String, hubId: String, userLimit: Number, announceId: String });
const TempChannelSchema = new mongoose.Schema({ channelId: String, parentHubId: String, userLimit: Number });
const LfmMessageSchema = new mongoose.Schema({ messageId: String, targetChannelId: String });
const GuildSettingsSchema = new mongoose.Schema({ 
    guildId: { type: String, unique: true }, 
    winPoints: { type: Number, default: 30 }, 
    losePoints: { type: Number, default: 30 }, 
    queueCount: { type: Number, default: 572 }, 
    requiredPlayers: { type: Number, default: 14 },
    leaderboardChannelId: String
});
const UserPointsSchema = new mongoose.Schema({ 
    userId: String, 
    guildId: String, 
    points: { type: Number, default: 1000.0 }, 
    wins: { type: Number, default: 0 }, 
    losses: { type: Number, default: 0 }, 
    totalGames: { type: Number, default: 0 } 
});
UserPointsSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const QueueConfigSchema = new mongoose.Schema({ 
    guildId: String, 
    channelId: String, 
    intervalMinutes: Number, 
    lastMessageId: String,
    requiredPlayers: Number
});
QueueConfigSchema.index({ guildId: 1, channelId: 1 }, { unique: true });
const ActiveQueuePlayerSchema = new mongoose.Schema({ guildId: String, channelId: String, userId: String });
ActiveQueuePlayerSchema.index({ guildId: 1, channelId: 1, userId: 1 }, { unique: true });
const MatchSchema = new mongoose.Schema({ 
    matchId: Number, 
    guildId: String, 
    categoryId: String, 
    teamAVcId: String, 
    teamBVcId: String, 
    captainPickChannelId: String, 
    loungeChannelId: String, 
    playersVcId: String, 
    captain1Id: String, 
    captain2Id: String, 
    teamA: String, 
    teamB: String, 
    pickedPlayers: { type: String, default: "" },
    remainingPlayers: { type: String, default: "" },
    votes: { type: Map, of: String, default: {} }, // voterId -> targetId
    methodVotes: { type: Map, of: String, default: {} }, // voterId -> 'random'/'voting'
    status: { type: String, default: "pre_vc" }, 
    turnId: String, 
    pickerMsgId: String,
    preMatchMsgId: String,
    roleId: String,
    hasSentSubRequests: { type: Boolean, default: false },
    subMessageId: String
});
MatchSchema.index({ matchId: 1, guildId: 1 }, { unique: true });
const PointHistorySchema = new mongoose.Schema({ 
    userId: String, 
    guildId: String, 
    points: Number, 
    type: String, 
    timestamp: { type: Date, default: Date.now } 
});

const PermissionSchema = new mongoose.Schema({
    commandName: { type: String, unique: true },
    roles: [String]
});

const VerifiedUserSchema = new mongoose.Schema({
    discordId: { type: String, unique: true, required: true },
    robloxId: { type: String, required: true },
    robloxUsername: { type: String, required: true }
});

const BlacklistedUserSchema = new mongoose.Schema({ 
    userId: { type: String, unique: true, required: true },
    guildId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    isFriendlyBlacklist: { type: Boolean, default: false },
    scrimsRemaining: { type: Number, default: 0 }
});

const ApplicationSchema = new mongoose.Schema({ 
    userId: String, 
    guildId: String, 
    appType: String, 
    answers: [String], 
    status: { type: String, default: "pending" } 
});

module.exports = {
    Hub: mongoose.model('Hub', HubSchema),
    TempChannel: mongoose.model('TempChannel', TempChannelSchema),
    LfmMessage: mongoose.model('LfmMessage', LfmMessageSchema),
    GuildSettings: mongoose.model('GuildSettings', GuildSettingsSchema),
    UserPoints: mongoose.model('UserPoints', UserPointsSchema),
    QueueConfig: mongoose.model('QueueConfig', QueueConfigSchema),
    ActiveQueuePlayer: mongoose.model('ActiveQueuePlayer', ActiveQueuePlayerSchema),
    Match: mongoose.model('Match', MatchSchema),
    PointHistory: mongoose.model('PointHistory', PointHistorySchema),
    Permission: mongoose.model('Permission', PermissionSchema),
    VerifiedUser: mongoose.model('VerifiedUser', VerifiedUserSchema),
    BlacklistedUser: mongoose.model('BlacklistedUser', BlacklistedUserSchema),
    Application: mongoose.model('Application', ApplicationSchema)
};
